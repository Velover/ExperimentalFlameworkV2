import type { Modding } from "../modding";
import type { PluginState } from "../plugin/pluginDefinition";
import { createModuleInstantiation, type Module } from "./module";

/** The configuration of the module. */
export interface ModuleState {
	/** The debug name of this module. */
	readonly debugName: string;

	/** Contains all the included providers, as well as their configuration. */
	readonly providers: readonly ModuleProvider[];

	/** Contains all the included modules. */
	readonly include: readonly ModuleState[];

	/** Contains all the included plugins. */
	readonly plugins: readonly PluginState[];

	/** Contains all the exported providers */
	readonly exportedProviders: ReadonlySet<string>;
}

export class ModuleDefinition {
	constructor(private moduleState: ModuleState) {}

	/** @internal */
	public getModuleState() {
		return this.moduleState;
	}

	public ignite() {
		return createModuleInstantiation(this.moduleState, { modules: new Map() }).ignite();
	}
}

export type ModuleProvider = { config: ProviderConfig; injectionId: string };

export type ProviderConfig =
	| { type: "class"; value: object }
	| { type: "alias"; injectionId: string }
	| { type: "function"; callback: (context: InjectionContext) => unknown };

export type InjectionContext = {
	/**
	 * This is the ID of the dependency being requested.
	 */
	injectionId: string;

	/**
	 * This is the dependency info for the requested dependency.
	 */
	dependencyInfo: Modding.DependencyInfo;

	/**
	 * This is the module that this provider is registered in.
	 */
	sourceModule: Module;

	/**
	 * This is the module resolving the dependency.
	 *
	 * This isn't necessarily the same module the provider is registered in, if this provider is exported.
	 */
	targetModule: Module;

	/**
	 * This is the class requesting the dependency.
	 *
	 * This can be used to retrieve information about the original class, such as the class name for a logging dependency.
	 */
	origin?: object;
};
