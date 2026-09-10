import { getRuntimeConfig } from "../utility/runtimeConfig";

/**
 * When something is registered, in terms of the build's active scopes.
 *
 * A condition holds when `activeIn` is empty or names an active scope, and `inactiveIn` names
 * none. Conditions combine by AND: a class is registered only when the module's condition, its
 * registration's and its own all hold, so a class can narrow the module's condition and never
 * widen it.
 */
export interface ScopeCondition {
	/**
	 * Registered only while at least one of these scopes is active. Empty or absent means no
	 * requirement.
	 */
	activeIn?: readonly string[];

	/** Never registered while any of these scopes is active. */
	inactiveIn?: readonly string[];
}

let configured: readonly string[] | undefined;
let override: readonly string[] | undefined;

function getConfiguredScopes(): readonly string[] {
	if (override !== undefined) {
		return override;
	}

	configured ??= getRuntimeConfig().scopes?.active ?? [];
	return configured;
}

/**
 * The scopes this build is compiled with, as written in `flamework.config.json` (usually from
 * the environment). `"*"` in the list stands for every scope.
 */
export function getActiveScopes(): readonly string[] {
	return getConfiguredScopes();
}

/** Whether a scope is active in this build. */
export function isScopeActive(scope: string): boolean {
	const active = getConfiguredScopes();
	return active.includes("*") || active.includes(scope);
}

/**
 * The condition of something that was not given one. Lists of conditions hold this rather than
 * `undefined`: an array with a hole in it is not an array Luau can measure or walk.
 */
export const NO_CONDITION: ScopeCondition = {};

/** Whether a condition holds against the active scopes. No condition always holds. */
export function holdsCondition(condition: ScopeCondition | undefined): boolean {
	if (condition === undefined) {
		return true;
	}

	if (condition.inactiveIn !== undefined && condition.inactiveIn.some(isScopeActive)) {
		return false;
	}

	if (condition.activeIn !== undefined && condition.activeIn.size() > 0 && !condition.activeIn.some(isScopeActive)) {
		return false;
	}

	return true;
}

/** Whether every condition holds. */
export function holdsEveryCondition(conditions: ReadonlyArray<ScopeCondition>): boolean {
	for (const condition of conditions) {
		if (!holdsCondition(condition)) {
			return false;
		}
	}

	return true;
}

/** Whether a condition asks for anything at all, so that a message can leave the empty ones out. */
export function hasCondition(condition: ScopeCondition | undefined): condition is ScopeCondition {
	return (
		condition !== undefined &&
		((condition.activeIn !== undefined && condition.activeIn.size() > 0) ||
			(condition.inactiveIn !== undefined && condition.inactiveIn.size() > 0))
	);
}

/**
 * Describes the conditions that applied to something, and the active set they were judged
 * against, for an error message: `activeIn [a, b]; inactiveIn [c]; active scopes [a]`.
 */
export function describeConditions(conditions: ReadonlyArray<ScopeCondition>): string {
	const parts = new Array<string>();

	for (const condition of conditions) {
		if (!hasCondition(condition)) {
			continue;
		}

		if (condition.activeIn !== undefined && condition.activeIn.size() > 0) {
			parts.push(`activeIn [${condition.activeIn.join(", ")}]`);
		}

		if (condition.inactiveIn !== undefined && condition.inactiveIn.size() > 0) {
			parts.push(`inactiveIn [${condition.inactiveIn.join(", ")}]`);
		}
	}

	parts.push(`active scopes [${getConfiguredScopes().join(", ")}]`);
	return parts.join("; ");
}

/**
 * Replaces the active scopes for the rest of the run, or restores the configured ones with
 * `undefined`. For the test harness, which has no `config.json`; a game's scopes are what it was
 * compiled with.
 *
 * @internal
 */
export function __setActiveScopes(scopes: readonly string[] | undefined) {
	override = scopes;
}
