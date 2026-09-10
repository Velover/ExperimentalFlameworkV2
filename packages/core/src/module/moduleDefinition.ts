import type { Modding } from "../modding";
import type { PluginState } from "../plugin/pluginDefinition";
import { clearDefaultModule, getDefaultModule, setDefaultModule } from "./defaultModule";
import { createModuleInstantiation, type Module } from "./module";

export interface IgniteOptions {
	/**
	 * Makes this module the one `Dependency<T>()` resolves against, replacing the current default.
	 *
	 * The first root module ignited in a realm becomes the default on its own, so a game never needs
	 * this. Pass it where a realm ignites more than one root -- tests, tools -- and a later one is the
	 * one `Dependency<T>()` should answer from.
	 */
	default?: boolean;
}

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

	public ignite(options?: IgniteOptions) {
		const module = createModuleInstantiation(this.moduleState, { modules: new Map() });

		// Claimed before ignition rather than after it, so that `Dependency<T>()` answers inside a
		// provider constructor, as it did in v1.
		const claimsDefault = options?.default === true || getDefaultModule() === undefined;
		if (claimsDefault) {
			setDefaultModule(module);
		}

		try {
			return module.ignite();
		} catch (err) {
			// A module that failed to ignite must not stay the default: the next root ignited would
			// never claim it, and `Dependency<T>()` would keep answering from the wreck.
			if (claimsDefault) {
				clearDefaultModule(module);
			}

			error(err, 0);
		}
	}
}

export type ModuleProvider = { config: ProviderConfig; injectionId: string };

export type ProviderConfig =
	| {
			type: "class";
			value: object;

			/**
			 * A lazy class provider is not constructed during ignition. It is constructed the first
			 * time something resolves it, and is otherwise never created.
			 *
			 * Defaults to the `lazy` option of the class's `@Provider()` decorator, or `false`.
			 */
			lazy?: boolean;
	  }
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
