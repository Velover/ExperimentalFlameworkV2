import type { PluginApi } from "./types";

export type PluginCallback = (api: PluginApi) => void;

/**
 * Plugins and the transformer can end up with separate instances of this module -- different
 * `node_modules` trees, or a plugin bundling its own copy. The registry therefore lives on a
 * well-known global symbol rather than in module scope, so registration always reaches the
 * transformer that is about to drain it.
 */
const REGISTRY_KEY = Symbol.for("rbxts-transformer-flamework.pluginRegistry");

interface Registry {
	pending: PluginCallback[];
}

function getRegistry(): Registry {
	const global = globalThis as Record<symbol, unknown>;
	const existing = global[REGISTRY_KEY] as Registry | undefined;
	if (existing) {
		return existing;
	}

	const registry: Registry = { pending: [] };
	global[REGISTRY_KEY] = registry;

	return registry;
}

/**
 * Registers a Flamework transformer plugin.
 *
 * Call this at the top level of your plugin module. The transformer invokes the callback once,
 * immediately after loading the module, with the API used to register macro types.
 *
 * ```ts
 * registerPlugin((api) => {
 *     api.registerMacroType("fieldInfo", (ty) => api.factory.expr.string(ty.toString()));
 * });
 * ```
 */
export function registerPlugin(plugin: PluginCallback) {
	getRegistry().pending.push(plugin);
}

/**
 * Removes and returns every plugin registered since the last drain.
 *
 * @internal
 */
export function drainRegisteredPlugins() {
	const registry = getRegistry();
	return registry.pending.splice(0, registry.pending.length);
}
