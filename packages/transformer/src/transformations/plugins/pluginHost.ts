import path from "path";
import ts from "typescript";
import type {
	MacroContext,
	MacroTypeHandler,
	PluginApi,
	PluginCallback,
} from "@flamework-experimental/transformer-plugin";
import { Diagnostics } from "../../classes/diagnostics";
import type { TransformState } from "../../classes/transformState";
import { f } from "../../util/factory";
import { createNodeFactory, createNodeHandle, unwrapNode } from "./nodeFactory";
import { createTypeFactory } from "./typeFacade";
import { PLUGIN_PACKAGE } from "../../util/packages";

export interface PluginHost {
	/**
	 * Runs the macro type registered under `name`, or returns undefined if no plugin registered it.
	 */
	executeMacroType(name: string, type: ts.Type, node: ts.Node): ts.Expression | undefined;

	/**
	 * The macro type IDs every loaded plugin registered, used for diagnostics.
	 */
	getRegisteredMacroTypes(): string[];
}

interface CacheEntry {
	fileName: string;
	expression: ts.Expression;
}

/**
 * The callbacks each plugin module registered when it was first loaded, keyed by its resolved path.
 *
 * Node caches modules, so requiring a plugin a second time does not run its top level again and
 * registers nothing. A transformer state is created for every compilation -- every rebuild in watch
 * mode -- so the callbacks have to outlive the state that first loaded them.
 */
const LOADED_PLUGINS = new Map<string, PluginCallback[]>();

/**
 * Loads and drives Flamework transformer plugins.
 *
 * Plugins are ordinary CommonJS modules loaded into the compiler process -- they are build-time
 * code the project already trusts, exactly like the transformer itself. The `Type` and `Node`
 * facades exist to give plugins an API that survives TypeScript upgrades, not to sandbox them.
 */
export function createPluginHost(state: TransformState): PluginHost | undefined {
	const pluginConfigs = state.config.plugins;
	if (!pluginConfigs || pluginConfigs.length === 0) {
		return;
	}

	// Loaded lazily so that projects without plugins never pay for resolving the plugin module.
	const registry = requirePluginRegistry(state);

	const types = createTypeFactory(state);
	const factory = createNodeFactory();
	const macroTypes = new Map<string, { handler: MacroTypeHandler; pluginName: string }>();
	const cache = new Map<string, CacheEntry>();

	for (const pluginConfig of pluginConfigs) {
		const normalized = typeof pluginConfig === "string" ? { path: pluginConfig } : pluginConfig;
		loadPlugin(normalized.path, normalized.options ?? {});
	}

	return { executeMacroType, getRegisteredMacroTypes: () => [...macroTypes.keys()] };

	function loadPlugin(pluginPath: string, options: Record<string, unknown>) {
		const resolved = resolvePluginPath(state, pluginPath);

		let callbacks = LOADED_PLUGINS.get(resolved);
		if (!callbacks) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				require(resolved);
			} catch (e) {
				throw new Error(
					`Failed to load Flamework plugin '${pluginPath}': ${e instanceof Error ? e.message : e}`,
				);
			}

			callbacks = registry.drainRegisteredPlugins();
			if (callbacks.length === 0) {
				throw new Error(
					`Flamework plugin '${pluginPath}' did not call registerPlugin(). ` +
						`Plugins must be CommonJS modules that call registerPlugin at the top level.`,
				);
			}

			LOADED_PLUGINS.set(resolved, callbacks);
		}

		const api: PluginApi = {
			factory,
			options,
			registerMacroType(id, handler) {
				const existing = macroTypes.get(id);
				if (existing) {
					throw new Error(
						`Flamework plugin '${pluginPath}' registered the macro type '${id}', ` +
							`which was already registered by '${existing.pluginName}'.`,
					);
				}

				macroTypes.set(id, { handler, pluginName: pluginPath });
			},
		};

		for (const plugin of callbacks) {
			plugin(api);
		}
	}

	function executeMacroType(name: string, type: ts.Type, node: ts.Node) {
		const registered = macroTypes.get(name);
		if (!registered) {
			return;
		}

		const file = state.getSourceFile(node);
		const cacheKey = `${name}\0${state.typeChecker.typeToString(type)}\0${getTypeKey(type)}`;

		// Results are cached per file. Re-emitting a whole object literal at every call site is the
		// main cost of a macro type, so the second use in a file hoists it into a shared constant.
		const cached = cache.get(cacheKey);
		if (cached && cached.fileName === file.fileName) {
			return cached.expression;
		}

		const { context, hoistRaw } = createMacroContext(file, node);
		const result = unwrapNode(registered.handler(types.wrap(type), context));

		if (!ts.isExpression(result)) {
			Diagnostics.error(node, `Flamework plugin macro type '${name}' returned a non-expression.`);
		}

		const expression = isTriviallyDuplicable(result) ? result : hoistRaw(result, name);
		cache.set(cacheKey, { fileName: file.fileName, expression });

		return expression;
	}

	function createMacroContext(file: ts.SourceFile, node: ts.Node) {
		function hoistRaw(expression: ts.Expression, name = "plugin"): ts.Identifier {
			const identifier = f.identifier(name, true);
			state.nextRootStatements.push(f.variableStatement(identifier, expression));

			return identifier;
		}

		const context: MacroContext = {
			hoist(expression, name) {
				const unwrapped = unwrapNode(expression);
				if (!ts.isExpression(unwrapped)) {
					Diagnostics.error(node, "hoist was called with a node that is not an expression.");
				}

				return createNodeHandle(hoistRaw(unwrapped, name));
			},
			hoistStatement(statement) {
				const unwrapped = unwrapNode(statement);
				if (!ts.isStatement(unwrapped)) {
					Diagnostics.error(node, "hoistStatement was called with a node that is not a statement.");
				}

				state.nextRootStatements.push(unwrapped);
			},
			error(message) {
				return Diagnostics.error(node, message);
			},
			warning(message) {
				Diagnostics.warning(node, message);
			},
			fileName: file.fileName,
		};

		return { context, hoistRaw };
	}
}

/**
 * Literals and identifiers are cheap enough to duplicate at each call site, and duplicating them
 * avoids emitting a constant for something like `"foo"`.
 */
function isTriviallyDuplicable(node: ts.Expression): boolean {
	return (
		ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node) ||
		ts.isIdentifier(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword
	);
}

/**
 * `ts.Type` has a stable numeric id, but it is internal. Falling back to the printed type keeps the
 * cache correct (never merging distinct types) if the id is unavailable.
 */
function getTypeKey(type: ts.Type): string | number {
	return (type as ts.Type & { id?: number }).id ?? -1;
}

function resolvePluginPath(state: TransformState, pluginPath: string) {
	if (pluginPath.startsWith(".")) {
		return path.resolve(state.rootDirectory, pluginPath);
	}

	try {
		return require.resolve(pluginPath, { paths: [state.rootDirectory] });
	} catch {
		throw new Error(
			`Could not resolve Flamework plugin '${pluginPath}' from '${state.rootDirectory}'. ` +
				`Use a relative path for local plugins, or install the plugin as a dependency.`,
		);
	}
}

function requirePluginRegistry(state: TransformState) {
	let resolved;
	try {
		resolved = require.resolve(PLUGIN_PACKAGE, { paths: [state.rootDirectory] });
	} catch {
		throw new Error(
			`Flamework plugins are configured, but '${PLUGIN_PACKAGE}' is not installed. ` +
				"Add it as a dev dependency of your project.",
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(resolved) as { drainRegisteredPlugins(): PluginCallback[] };
}
