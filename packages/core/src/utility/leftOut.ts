import { describeConditions, type ScopeCondition } from "../module/scopes";
import { Reflect } from "../reflect";
import { getGlobPaths } from "./globs";
import { findModuleClass } from "./moduleClasses";
import { getPathRoot } from "./pathRoot";

/**
 * A path or glob registration that its own scope condition left out. Its folder was never looked up,
 * so nothing under it was loaded, and nothing from it was registered or recorded as inactive: this
 * is what a miss can still say about the classes there.
 */
export interface LeftOutRegistration {
	/** The call as written, for messages: `registerProviders("src/server/debug")`. */
	readonly call: string;

	/** The registration's own condition, which did not hold. */
	readonly condition: ScopeCondition;

	/** The folder's tree path, for a path registration. */
	readonly path?: readonly string[];

	/** The glob as the runtime keys it, for a glob registration. */
	readonly glob?: string;

	/** What `path` was relative to when the registration was made. */
	readonly root: Instance;
}

/**
 * Records a registration left out by its own condition. Reads nothing but the path root, which is
 * found from Flamework's own metadata, never from the folder.
 */
export function leftOutRegistration(
	call: string,
	condition: ScopeCondition,
	folder: { path?: readonly string[]; glob?: string },
): LeftOutRegistration {
	return {
		call,
		condition: { activeIn: condition.activeIn, inactiveIn: condition.inactiveIn },
		path: folder.path,
		glob: folder.glob,
		root: getPathRoot(),
	};
}

/**
 * The tree path of a loaded module below `root`, in the form a compile-time path has: a client's
 * `PlayerScripts` is written as `StarterPlayer/StarterPlayerScripts`, where its content comes from.
 * Nothing when the module is not below `root`.
 */
function treePathOf(moduleScript: unknown, root: Instance): string[] | undefined {
	const names = new Array<string>();
	let current = moduleScript as Instance | undefined;
	while (current !== undefined && current !== root) {
		names.unshift(current.Name);
		current = current.Parent;
	}

	if (current === undefined) return undefined;

	if (root === game && names[0] === "Players" && names[2] === "PlayerScripts") {
		const rest = names.filter((_, index) => index >= 3);
		return ["StarterPlayer", "StarterPlayerScripts", ...rest];
	}

	return names;
}

function startsWith(path: readonly string[], prefix: readonly string[]) {
	if (path.size() < prefix.size()) return false;

	for (let i = 0; i < prefix.size(); i++) {
		if (path[i] !== prefix[i]) return false;
	}

	return true;
}

/** Whether a loaded module is under the folder, or one of the folders, a left-out registration named. */
function isUnder(moduleScript: unknown, registration: LeftOutRegistration) {
	const modulePath = treePathOf(moduleScript, registration.root);
	if (modulePath === undefined) return false;

	if (registration.path !== undefined) {
		return startsWith(modulePath, registration.path);
	}

	if (registration.glob !== undefined) {
		// `globs.json`, not the folders: what the glob matched when the build was compiled.
		const [ok, paths] = pcall(getGlobPaths, registration.glob);
		if (!ok) return false;

		return (paths as string[][]).some((path) => startsWith(modulePath, path));
	}

	return false;
}

/**
 * What a miss on `id` can say about the registrations its module or plugin left out by their own
 * condition, without looking at their folders:
 *
 * - the class has loaded some other way, and its module is under one of them: that one, and why;
 * - the class has not loaded: every one of them, since the class may be under any;
 * - nothing when there are none, or when the loaded class is under none of them.
 */
export function explainLeftOut(id: string, leftOut: ReadonlyArray<LeftOutRegistration>): string | undefined {
	if (leftOut.isEmpty()) return undefined;

	const advice = "the build's scopes so that the condition holds, or do not depend on it in this build";

	const found = findModuleClass((value) => Reflect.getOwnMetadata<string>(value, "identifier") === id);
	if (found !== undefined) {
		const [value, moduleScript] = found;
		const under = leftOut.find((registration) => isUnder(moduleScript, registration));
		if (under === undefined) return undefined;

		const where = typeIs(moduleScript, "Instance") ? moduleScript.GetFullName() : tostring(moduleScript);
		return (
			`'${value}' (${where}) is under ${under.call}, which is left out by its scope ` +
			`(${describeConditions([under.condition])}): nothing under it is registered. Change ${advice}`
		);
	}

	const listed = leftOut.map((v) => `${v.call} (${describeConditions([v.condition])})`).join(", ");
	return (
		`nothing registers it. Left out by their scope, without loading their folders: ${listed}. ` +
		`If it is defined under one of them, change ${advice}`
	);
}
