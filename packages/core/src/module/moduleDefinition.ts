import type { Modding } from "../modding";
import { createModuleInstantiation, type Module } from "./module";
import type { HookConfig } from "./moduleHooks";

/** The configuration of the module. */
export interface ModuleState {
	/** Contains all the included providers, as well as their configuration. */
	providers: ModuleProvider[];

	/** Contains all the registered hooks. */
	hooks: HookConfig[];

	/** Contains all the included modules. */
	include: ModuleState[];

	/** Contains all the registered interfaces. */
	interfaces: Set<string>;

	/** Contains all the exported providers */
	exportedProviders: Set<string>;

	/** Contains all the exported interfaces */
	exportedInterfaces: Set<string>;

	/** Determines whether the defined hooks are exported. */
	exportedHooks: boolean;

	/** Determines whether this module is transient. */
	transient: boolean;
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
