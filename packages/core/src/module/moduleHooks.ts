import type { Module } from "./module";

export type HookContext = {
	/**
	 * This is the module instance that the hook originates from.
	 */
	sourceModule: Module;

	/**
	 * This is the module instance that the hook is being applied to.
	 */
	targetModule: Module;
};

export type HookConfig = {
	[k in HookType]: {
		type: k;
		callback: HookCallbacks[k];

		/**
		 * Orders this hook against the other hooks of the same type on the same module.
		 *
		 * Lower values run first, and hooks with an equal priority run in registration order.
		 * Defaults to {@link HookPriority.Normal}.
		 */
		priority?: number;
	};
}[HookType];

/**
 * These hooks can be used to tap into certain parts of Flamework's lifecycle.
 *
 * Each hook runs in the context of a module (unless stated otherwise) which means the hooks can be called multiple times.
 */
export enum HookType {
	/**
	 * Runs after every included module and plugin has ignited, but before any of this module's own
	 * providers are constructed.
	 *
	 * This is where a plugin registers state that providers will resolve during construction.
	 */
	PreIgnite,

	/**
	 * This runs after all providers have been created and their constructors have run.
	 */
	PostIgnite,

	/**
	 * Runs when `extinguish` is called on this module.
	 */
	Extinguished,
}

/**
 * Conventional priorities for {@link HookConfig.priority}.
 *
 * Any number is accepted; these exist so that plugins can order themselves against each other
 * without agreeing on magic numbers.
 */
export const HookPriority = {
	/** Runs before hooks that did not specify a priority. */
	First: -1000,

	/** The default. */
	Normal: 0,

	/** Runs after hooks that did not specify a priority. */
	Last: 1000,
} as const;

export interface HookCallbacks {
	[HookType.PreIgnite]: (module: HookContext) => void;
	[HookType.PostIgnite]: (module: HookContext) => void;
	[HookType.Extinguished]: (module: HookContext) => void;
}
