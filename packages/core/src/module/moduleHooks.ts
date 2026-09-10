import type { Module } from "./module";

/**
 * Conventional priorities for {@link HookOptions.priority}.
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

export interface HookOptions {
	/**
	 * Orders this hook against the other hooks of the same phase on the same module.
	 *
	 * Lower values run first, and hooks with an equal priority run in registration order.
	 * Defaults to {@link HookPriority.Normal}.
	 */
	priority?: number;
}

/** @internal */
export type HookPhase = "preIgnite" | "postIgnite" | "extinguished";

/** @internal */
export interface RegisteredHook {
	phase: HookPhase;
	callback: (module: Module) => void;
	priority: number;
}
