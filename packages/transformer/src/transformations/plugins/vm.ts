/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-require-imports */
import path from "path";
import type { TransformState } from "../../classes/transformState";
import type IsolatedVM from "isolated-vm";
import { readFileSync } from "fs";
import { assert } from "../../util/functions/assert";
import { isPathDescendantOf } from "../../util/functions/isPathDescendantOf";
import ts from "typescript";
import { isArrayType, isTupleType } from "../../util/functions/isTupleType";
import { type Context } from "isolated-vm";

function resolve(moduleName: string, path: string): string | undefined {
	try {
		return require.resolve(moduleName, { paths: [path] });
	} catch (e) {}
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PluginVm extends NonNullable<ReturnType<typeof createVm>> {}

export function createVm(state: TransformState) {
	const pluginModuleEntry = resolve("rbxts-transformer-flamework-plugin", state.rootDirectory);
	if (!pluginModuleEntry) {
		return;
	}

	const pluginModuleDirectory = path.dirname(pluginModuleEntry);
	const ivmPath = resolve("isolated-vm", pluginModuleDirectory);
	if (!ivmPath) {
		throw new Error("isolated-vm wasn't found, but plugin module was");
	}

	const types = new Array<ts.Type>();
	const nodes = new Array<ts.Node>();

	const macroTypes = new Map<string, number>();
	const moduleCache = new Map<string, IsolatedVM.Module>();
	const ivm = require(ivmPath) as typeof IsolatedVM;
	const isolate = new ivm.Isolate({ memoryLimit: 64 });
	const pluginContext = createPluginInstantiationContext();
	const pluginModule = createPluginModule("index");
	const invokePlugin = pluginModule.namespace.getSync("$invokePlugin", { reference: true });

	createUserPlugin(path.resolve(pluginModuleDirectory, "testPlugin.js"));

	return { executeMacroType };

	function executeMacroType(name: string, type: ts.Type) {
		const handler = macroTypes.get(name);
		if (handler === undefined) {
			return;
		}

		const result = invokePlugin.applySync(invokePlugin, [handler, getType(type)], { result: { copy: true } });
		if (typeof result !== "number") {
			throw new Error("invalid plugin result");
		}

		return nodes[result];
	}

	function createPluginModule(filePath: string) {
		const finalPath = path.normalize(path.resolve(pluginModuleDirectory, filePath));
		assert(isPathDescendantOf(finalPath, pluginModuleDirectory));

		const cached = moduleCache.get(finalPath);
		if (cached) {
			return cached;
		}

		const code = readFileSync(finalPath + ".js", { encoding: "utf8" });
		const module = isolate.compileModuleSync(code, { filename: finalPath + ".js" });
		moduleCache.set(finalPath, module);

		module.instantiateSync(pluginContext, (specifier) => {
			return createPluginModule(path.join(path.dirname(finalPath), specifier));
		});

		module.evaluateSync();

		return module;
	}

	function createUserPlugin(filename: string) {
		const code = readFileSync(filename, { encoding: "ascii" });
		const module = isolate.compileModuleSync(code, { filename });
		const pluginContext = isolate.createContextSync();

		pluginContext.global.setSync("__LOG", (value: string) => console.log(value));
		pluginContext.global.setSync(
			"log",
			pluginContext.evalSync(`(function log(...a) { __LOG(a.join("\t")) })`, { reference: true }).derefInto(),
		);

		module.instantiateSync(pluginContext, (specifier) => {
			// TODO: properly support embedded demo plugin
			if (specifier === "rbxts-transformer-flamework-plugin" || true) {
				return pluginModule;
			}

			throw new Error("invalid module");
		});

		module.evaluateSync();

		return module;
	}

	function createPluginInstantiationContext() {
		const context = isolate.createContextSync();
		const checker = state.typeChecker;

		register("isSubtypeOf", (id, other) => {
			return checker.isTypeAssignableTo(types[id], types[other]);
		});

		register("isSupertypeOf", (id, other) => {
			return checker.isTypeAssignableTo(types[other], types[id]);
		});

		register("isEquivalentTo", (id, other) => {
			return (
				checker.isTypeAssignableTo(types[id], types[other]) &&
				checker.isTypeAssignableTo(types[other], types[id])
			);
		});

		register("isIntersection", (id) => {
			return types[id].isIntersection();
		});

		register("isUnion", (id) => {
			return types[id].isUnion();
		});

		register("isObjectLikeType", (id) => {
			return types[id].flags & ts.TypeFlags.Object;
		});

		register("isArrayType", (id) => {
			return isArrayType(state, types[id]);
		});

		register("isTupleType", (id) => {
			return isTupleType(state, types[id]);
		});

		register("isLiteralType", (id) => {
			return types[id].isLiteral() || (types[id].flags & ts.TypeFlags.BooleanLiteral) !== 0;
		});

		register("isPrimitiveType", (id, kind) => {
			return (
				types[id].flags & ts.TypeFlags.Intrinsic &&
				(kind === undefined || (types[id] as ts.IntrinsicType).intrinsicName === kind)
			);
		});

		register("getConstituents", (id) => {
			assert(types[id].isUnionOrIntersection());

			// @ts-ignore
			return types[id].types.map(getType);
		});

		register("getFields", (id) => {
			assert(types[id].flags & ts.TypeFlags.Object);

			const objectType = types[id] as ts.ObjectType;
			const fields = [];
			for (const field of checker.getPropertiesOfType(objectType)) {
				const type = checker.getTypeOfPropertyOfType(objectType, field.name);
				if (!type) {
					continue;
				}

				fields.push({
					name: field.name,
					readonly: field.valueDeclaration && ts.isDeclarationReadonly(field.valueDeclaration),
					type: getType(type),
				});
			}

			return fields;
		});

		register("getIndexSignatures", (id) => {
			assert(types[id].flags & ts.TypeFlags.Object);

			const objectType = types[id] as ts.ObjectType;
			const signatures = [];
			for (const info of checker.getIndexInfosOfType(objectType)) {
				signatures.push({
					key: getType(info.keyType),
					value: getType(info.type),
					readonly: info.isReadonly,
				});
			}

			return signatures;
		});

		register("getSignatures", (id, kind) => {
			assert(types[id].flags & ts.TypeFlags.Object);

			const signatureKind = kind === "call" ? ts.SignatureKind.Call : ts.SignatureKind.Construct;
			const signatures = [];
			for (const signature of checker.getSignaturesOfType(types[id], signatureKind)) {
				signatures.push({
					inputs: signature.getParameters().map((v) => getType(checker.getTypeOfSymbol(v))),
					output: getType(signature.getReturnType()),
				});
			}

			return signatures;
		});

		register("getElements", (id) => {
			const ty = types[id];
			assert(isTupleType(state, ty));

			return checker.getTypeArguments(ty).map((v, i) => {
				const nameDeclaration = ty.target.labeledElementDeclarations?.[i]?.name;
				return {
					name: nameDeclaration && ts.isIdentifier(nameDeclaration) ? nameDeclaration.text : undefined,
					type: getType(v),
					spread: (ty.target.elementFlags[i] & ts.ElementFlags.Rest) !== 0,
					optional: (ty.target.elementFlags[i] & ts.ElementFlags.Optional) !== 0,
				};
			});
		});

		register("getElementType", (id) => {
			assert(isArrayType(state, types[id]));

			return getType(checker.getElementTypeOfArrayType(types[id])!);
		});

		register("isReadonly", (id) => {
			assert(isArrayType(state, types[id]));

			const readonlyArraySymbol = checker.resolveName("ReadonlyArray", undefined, ts.SymbolFlags.Type, false);
			assert(readonlyArraySymbol);

			// @ts-ignore
			return types[id].target === checker.getDeclaredTypeOfSymbol(readonlyArraySymbol);
		});

		register("getLiteralValue", (id) => {
			if (types[id].isLiteral()) {
				// @ts-ignore
				return types[id].value;
			}

			if (types[id] === checker.getTrueType()) {
				return true;
			}

			if (types[id] === checker.getFalseType()) {
				return false;
			}

			assert(false);
		});

		register("registerMacroType", (id, handler) => {
			macroTypes.set(id, handler);
		});

		register("typeToString", (id) => {
			return checker.typeToString(types[id]);
		});

		context.global.setSync("$factory", createFactoryReference(context).derefInto());

		return context;

		function register(name: string, callback: (...values: any[]) => any) {
			context.global.setSync(`$${name}`, callback);
		}
	}

	function createFactoryReference(context: Context) {
		const reference = context.evalSync("({})", { reference: true });

		factory("string", (value: string) => ts.factory.createStringLiteral(value));
		factory("bool", (value: boolean) => (value ? ts.factory.createTrue() : ts.factory.createFalse()));
		factory("number", (value: number) =>
			value < 0
				? ts.factory.createPrefixMinus(ts.factory.createNumericLiteral(value))
				: ts.factory.createNumericLiteral(value),
		);
		factory("array", (value: number[]) =>
			ts.factory.createArrayLiteralExpression(value.map((v) => nodes[v] as ts.Expression)),
		);
		factory("identifier", (name: string, unique: boolean) =>
			unique
				? ts.factory.createUniqueName(name, ts.GeneratedIdentifierFlags.Optimistic)
				: ts.factory.createIdentifier(name),
		);
		factory("object", (values: { name: string; value: number }[]) =>
			ts.factory.createObjectLiteralExpression(
				values.map((v) => ts.factory.createPropertyAssignment(v.name, nodes[v.value] as ts.Expression)),
			),
		);

		return reference;

		function factory<T extends ts.Node, A extends unknown[]>(
			name: string,
			create: (...values: A) => T,
			update?: (previous: T, ...values: A) => T,
		) {
			reference.setSync(name, (previous: any, ...args: A) => {
				if (previous !== undefined && update) {
					return getNode(update(nodes[previous] as T, ...args));
				} else {
					return getNode(create(...args));
				}
			});
		}
	}

	function getType(type: ts.Type) {
		const existingIndex = types.findIndex((v) => v.id === type.id);
		if (existingIndex !== -1) {
			return existingIndex;
		}

		return types.push(type) - 1;
	}

	function getNode(node: ts.Node) {
		const existingIndex = nodes.findIndex((v) => v === node);
		if (existingIndex !== -1) {
			return existingIndex;
		}

		return nodes.push(node) - 1;
	}
}
