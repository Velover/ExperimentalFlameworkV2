import type { Modding } from "../modding";
import type { Module } from "../module/module";
import type { ModuleState } from "../module/moduleDefinition";
import type { HookConfig, HookContext } from "../module/moduleHooks";

/** The configuration of the plugin. */
export interface PluginState {
	/** The internal module for this plugin. */
	readonly module: ModuleState;

	/** Contains all the registered hooks. */
	readonly hooks: readonly HookConfig[];

	/** Contains all the included modules. */
	readonly include: readonly ModuleState[];

	/** Contains all the registered interfaces. */
	readonly interfaces: ReadonlyMap<string, InterfaceConfiguration<unknown>>;
}

export class PluginDefinition {
	constructor(private pluginState: PluginState) {}

	/** @internal */
	public getPluginState() {
		return this.pluginState;
	}
}

export interface InterfaceConfiguration<T> {
	/**
	 * This callback gets invoked whenever a newly created object implements this interface.
	 */
	onAdded?: (context: InterfaceContext, value: T) => void;

	/**
	 * This callback gets invoked whenever an object that implements this interface gets removed.
	 */
	onRemoved?: (context: InterfaceContext, value: T) => void;
}

export interface InterfaceContext {
	/**
	 * This is the module instance that the hook originates from.
	 */
	sourceModule: Module;

	/**
	 * This is the module instance that the hook is being applied to.
	 */
	targetModule: Module;

	/**
	 * The ID of this interface.
	 */
	interfaceId: string;
}
