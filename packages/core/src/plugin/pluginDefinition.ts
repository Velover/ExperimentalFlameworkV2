import type { Modding } from "../modding";
import type { Module } from "../module/module";
import type { ProviderConfig } from "../module/moduleDefinition";
import type { HookOptions } from "../module/moduleHooks";
import type { Constructor } from "../utility/constructors";

/**
 * A plugin: a name, and a setup function run once per ignition of every module that includes it.
 *
 * The setup is handed the module being ignited, before any of its providers exist, and registers
 * whatever the plugin adds to it -- providers, hooks, observers, other plugins. State the setup
 * creates belongs to that one ignition: a plugin included by two modules, or by one definition
 * ignited twice, is set up separately for each and shares nothing between them unless it closes
 * over module-level state on purpose.
 */
export class PluginDefinition {
	constructor(
		/** Names the plugin in error messages. */
		public readonly name: string,
		/** @internal */
		public readonly setup: (target: PluginTarget) => void,
	) {}
}

/**
 * What a plugin's setup is handed: the module the plugin is being included in, and the ways a
 * plugin can act on it. Everything here registers into that module.
 */
export interface PluginTarget {
	/**
	 * The module being set up. It has not ignited, so nothing can be resolved from it yet; hold it
	 * for the hooks, which run once it can.
	 */
	readonly module: Module;

	/**
	 * Registers a class provider in the module, constructed with dependency injection during
	 * ignition like any provider the module registered itself.
	 */
	registerClassProvider(provider: Constructor): void;

	/**
	 * Registers a class, function or alias provider in the module.
	 *
	 * @metadata macro
	 */
	registerProvider<T>(config: ProviderConfig, id?: string | Modding.Target.Id<T>): void;

	/**
	 * Provides a ready-made object under its type's id, so that the module's providers can inject it
	 * and `resolveDependency` finds it. This is how a plugin hands the module the thing it built.
	 *
	 * The object joins the interfaces it implements once every plugin has been set up, and leaves
	 * them when the module extinguishes, like a provider the module constructed.
	 *
	 * @metadata macro
	 */
	provideInstance<T extends object>(instance: T, id?: string | Modding.Target.Id<T>): void;

	/**
	 * Includes another plugin in the module, set up now, before this one continues. A plugin reached
	 * more than once in one ignition -- included by the module and by a plugin, or by two plugins --
	 * is set up once.
	 */
	includePlugin(plugin: PluginDefinition): void;

	/**
	 * Runs before the module's providers are constructed. Nothing can be resolved yet; this is where
	 * a plugin registers state that providers will look at while being constructed.
	 */
	onPreIgnite(callback: (module: Module) => void, options?: HookOptions): void;

	/** Runs after every provider has been constructed. */
	onPostIgnite(callback: (module: Module) => void, options?: HookOptions): void;

	/** Runs when the module extinguishes, before its providers are released. */
	onExtinguished(callback: (module: Module) => void, options?: HookOptions): void;

	/**
	 * Observes every object in the module that implements `T`: providers as they are constructed,
	 * and anything attached through `createClassInstance` or `listen`. Matching is structural, from
	 * the `implements` clause the transformer recorded, so the class needs a Flamework decorator.
	 *
	 * @metadata macro
	 */
	observe<T>(config: InterfaceConfiguration<T>, id?: string | Modding.Target.Id<T>): void;
}

export interface InterfaceConfiguration<T> {
	/** Invoked when an object implementing the interface is constructed or attached. */
	onAdded?: (value: T, context: InterfaceContext) => void;

	/** Invoked when an object implementing the interface is released, or its module extinguishes. */
	onRemoved?: (value: T, context: InterfaceContext) => void;
}

/**
 * What kind of object an observer is being told about.
 *
 * - `provider`: a provider the module constructed, during ignition or lazily, or one a plugin
 *   provided.
 * - `instance`: an object attached through `createClassInstance` or `listen`, which is owned by
 *   whoever created it (for example, a component owned by `Components`).
 */
export type InterfaceTargetKind = "provider" | "instance";

export interface InterfaceContext {
	/** The id of the interface being observed. */
	interfaceId: string;

	/** Whether the object is a provider of the module, or an instance attached to it. */
	kind: InterfaceTargetKind;
}
