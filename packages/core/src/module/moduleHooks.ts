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

export type HookConfig = { [k in HookType]: { type: k; callback: HookCallbacks[k] } }[HookType];

/**
 * These hooks can be used to tap into certain parts of Flamework's lifecycle.
 *
 * Each hook runs in the context of a module (unless stated otherwise) which means the hooks can be called multiple times.
 */
export enum HookType {
	/**
	 * This runs prior to any providers being created.
	 *
	 * This hook is not very useful at the moment and may be removed.
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

// TODO: implement?
export enum HookPriority {
	// runs before all included module hooks
	BeforeIncluded,
	// runs after all included module hooks
	Normal,
}

export interface HookCallbacks {
	[HookType.PreIgnite]: (module: HookContext) => void;
	[HookType.PostIgnite]: (module: HookContext) => void;
	[HookType.Extinguished]: (module: HookContext) => void;
}
