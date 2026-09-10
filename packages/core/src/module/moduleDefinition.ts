import type { Modding } from "../modding";
import type { PluginDefinition } from "../plugin/pluginDefinition";
import { clearDefaultModule, getDefaultModule, setDefaultModule } from "./defaultModule";
import { createModuleInstantiation, type Module } from "./module";
import type { ScopeCondition } from "./scopes";

/**
 * Options for one ignition of a module.
 *
 * `activeIn` and `inactiveIn` are the module's own scope condition. It applies to every provider
 * and component the module registers, on top of the registration's and the class's own conditions.
 * A module whose condition does not hold still ignites, holding nothing.
 */
export interface IgniteOptions extends ScopeCondition {
	/**
	 * Makes this module the one `Dependency<T>()` resolves against, replacing the current default.
	 *
	 * The first root module ignited in a realm becomes the default on its own, so a game never needs
	 * this. Pass it where a realm ignites more than one root -- tests, tools -- and a later one is the
	 * one `Dependency<T>()` should answer from.
	 */
	default?: boolean;
}

/** How a plugin was included: the plugin, and the condition its inclusion was given. */
export interface PluginInclusion {
	readonly plugin: PluginDefinition;

	/** The plugin is set up only while this holds; without one it always is. */
	readonly scope?: ScopeCondition;
}

/** The configuration of the module. */
export interface ModuleState {
	/** The debug name of this module. */
	readonly debugName: string;

	/** Contains all the included providers, as well as their configuration. */
	readonly providers: readonly ModuleProvider[];

	/** The plugins to set up on ignition, in inclusion order. */
	readonly plugins: readonly PluginInclusion[];
}

export class ModuleDefinition {
	constructor(private moduleState: ModuleState) {}

	public ignite(options?: IgniteOptions) {
		const module = createModuleInstantiation(this.moduleState, options);

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

/**
 * What a registration can say about itself, whichever form it takes: an option on the class and
 * path registrations, or written on the config of `registerProvider`.
 */
export type ProviderRegistrationOptions = ScopeCondition;

export type ProviderConfig = ProviderRegistrationOptions &
	(
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
		| { type: "function"; callback: (context: InjectionContext) => unknown }
	);

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
	 * The module resolving the dependency, which is the one the provider is registered in.
	 */
	module: Module;

	/**
	 * This is the class requesting the dependency.
	 *
	 * This can be used to retrieve information about the original class, such as the class name for a logging dependency.
	 */
	origin?: object;
};
