import { Modding } from "../modding";
import { PluginDefinition, type InterfaceConfiguration, type PluginState } from "./pluginDefinition";
import type { ModuleDefinition, ModuleState } from "../module/moduleDefinition";
import type { HookConfig } from "../module/moduleHooks";
import type { WritableState } from "../utility/writable";

type GenericId<T> = string | Modding.Target.Id<T>;

export class PluginBuilder {
	private plugin: WritableState<PluginState>;

	constructor(module: ModuleDefinition) {
		this.plugin = {
			module: module.getModuleState(),
			include: [],
			hooks: [],
			interfaces: new Map(),
		};
	}

	/**
	 * Registers this module as part of the plugin.
	 */
	public registerModule(module: ModuleDefinition) {
		this.plugin.include.push(module.getModuleState());

		return this;
	}

	/**
	 * Register an interface as part of the plugin.
	 *
	 * @metadata macro
	 */
	public registerInterface<T>(config: InterfaceConfiguration<T>, id?: GenericId<T>) {
		assert(id !== undefined);
		assert(this.plugin.interfaces.has(id) === false, "this interface is already registered");

		this.plugin.interfaces.set(id, config as InterfaceConfiguration<unknown>);

		return this;
	}

	/**
	 * Register a hook as part of the plugin.
	 */
	public registerHook(hookConfig: HookConfig) {
		this.plugin.hooks.push(hookConfig);

		return this;
	}

	/**
	 * An easy way to apply a function to the builder without breaking chaining.
	 */
	public apply(callback: (builder: PluginBuilder) => PluginBuilder) {
		return callback(this);
	}

	/**
	 * Finalizes this plugin.
	 */
	public build() {
		return new PluginDefinition(this.plugin);
	}
}
