import { RunService } from "@rbxts/services";
import type { Modding } from "../modding";
import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";
import { findRbxPath, getPathRoot, resolveRbxPath } from "./pathRoot";
import { getModuleClasses } from "./moduleClasses";

/** How long {@link requireModules} waits for a folder that is not in the place, in seconds. */
const MISSING_FOLDER_TIMEOUT = 5;

/**
 * Why this realm cannot require a folder under `game` that belongs to the other realm, or nothing
 * when it can: a client sees nothing of the server's containers, and the server has no
 * `PlayerScripts` to take a client folder from.
 */
function otherRealmReason(rbxPath: readonly string[]): string | undefined {
	if (getPathRoot() !== game) return undefined;

	const service = rbxPath[0];
	if (RunService.IsClient() && (service === "ServerScriptService" || service === "ServerStorage")) {
		return `the folder is in ${service}, which does not replicate to clients. Call requireModules for it on the server`;
	}

	if (!RunService.IsClient() && service === "StarterPlayer") {
		return "the folder is in StarterPlayer/StarterPlayerScripts, which only a client requires from, through its PlayerScripts. Call requireModules for it on the client";
	}
}

/**
 * Requires one ModuleScript through the roblox-ts runtime, as an `import` would, and returns what
 * it exported. A module that fails to load raises with its full name and how long it took.
 */
export function importModule(moduleScript: ModuleScript): defined | undefined {
	const start = os.clock();
	const [success, value] = pcall(() => tsImport(moduleScript));
	const endTime = math.floor((os.clock() - start) * 1000);
	if (!success) {
		error(`${moduleScript.GetFullName()} failed to load (${endTime}ms): ${value}`, 0);
	}

	return value as defined | undefined;
}

/**
 * Requires every ModuleScript at and under an instance, in tree order, handing each to `visit` with
 * what it exported.
 */
function loadModulesIn(root: Instance, visit: (moduleScript: ModuleScript, value?: defined) => void) {
	if (root.IsA("ModuleScript")) {
		visit(root, importModule(root));
	}

	for (const instance of root.GetDescendants()) {
		if (instance.IsA("ModuleScript")) {
			visit(instance, importModule(instance));
		}
	}
}

/**
 * Requires every ModuleScript at and under a Rojo path, in tree order, handing each to `visit` with
 * what it exported. `caller` names the call that gave the path, for the warning a slow wait gets.
 */
function loadModulesInPath(
	rbxPath: readonly string[],
	visit: (moduleScript: ModuleScript, value?: defined) => void,
	caller?: string,
) {
	assert(rbxPath);
	loadModulesIn(resolveRbxPath(rbxPath, caller), visit);
}

/** What every ModuleScript at and under an instance exported, leaving out the ones that exported nothing. */
function requireModulesIn(root: Instance): Array<defined> {
	const loaded = new Array<defined>();
	loadModulesIn(root, (_, value) => {
		if (value !== undefined) {
			loaded.push(value);
		}
	});

	return loaded;
}

/**
 * Requires every ModuleScript at and under the specified Rojo path, in tree order, and returns
 * what each exported, leaving out the ones that exported nothing. This is the loading half of
 * {@link getClassesInPath}; a plugin whose modules register themselves as a side effect of loading
 * -- test files, say -- only needs this half.
 *
 * The path is relative to the tree's root (`game` in a place, the model's root in a plugin), which
 * `resolveRbxPath` finds.
 */
export function requireModulesInPath(rbxPath: readonly string[]): Array<defined> {
	assert(rbxPath);
	return requireModulesIn(resolveRbxPath(rbxPath));
}

/**
 * Requires every ModuleScript at and under a source folder, in tree order, for what the modules do
 * as they load, and returns what each exported, leaving out the ones that exported nothing. This is
 * v1's `Flamework.addPaths` for a folder that holds no providers: modules that register themselves
 * with a library, such as commands.
 *
 * The path is a source path, as a string literal: `requireModules("src/server/commands")`. The build
 * turns it into the Rojo path the folder ends up at, as it does for `registerProviders`, so the
 * folder has to be in your Rojo project.
 *
 * Each module is required through the roblox-ts module cache, so it runs once, however many times
 * it is required. A folder inside a folder that `registerProviders` registers needs no call:
 * registration already requires every ModuleScript under it.
 *
 * Raises when a module fails to load, and when the folder is not in the place. A missing folder is
 * waited for five seconds, once the place has loaded, and the error names the part that is missing.
 * A folder of the other realm's -- a server folder on a client, a client folder on the server --
 * raises at once, saying so.
 *
 * @metadata macro
 */
export function requireModules<T extends string>(
	path: T,
	rbxPath?: Modding.Intrinsic<"path", [T], string[]>,
): Array<defined> {
	if (rbxPath === undefined) {
		error(
			`requireModules("${path}") was called without the folder's Rojo path, which the build fills in. ` +
				"Call it directly, with a string literal, in code that the Flamework transformer compiles.",
			2,
		);
	}

	const otherRealm = otherRealmReason(rbxPath);
	if (otherRealm !== undefined) {
		error(`requireModules("${path}"): ${otherRealm}.`, 2);
	}

	const { found, missing } = findRbxPath(rbxPath, MISSING_FOLDER_TIMEOUT);
	if (missing !== undefined) {
		error(
			`requireModules("${path}"): the folder is not in the place. The build put it at ${rbxPath.join("/")}, ` +
				`and ${found.GetFullName()} has no child named '${missing}' after ${MISSING_FOLDER_TIMEOUT} seconds. ` +
				"The path is misspelled or differs in case from the folder, or the folder is empty and missing from this " +
				"clone, since git keeps no empty folder (the build warns about these where the path is used); or it was " +
				"moved or renamed after the build; or the Rojo project the place was built from leaves it out.",
			2,
		);
	}

	return requireModulesIn(found);
}

/**
 * Requires every ModuleScript at and under the specified Rojo path and returns every Flamework
 * class they hold, each once: every class carrying its own identifier that a module defined at its
 * top level -- exported or not, as v1 registered every decorated class it required -- then every
 * exported value carrying its own identifier that the module did not define there, such as a
 * re-export of a class from elsewhere.
 *
 * A class declared inside a function is not found unless its module exports it: it is created by
 * every call, so the transformer does not record it against its module. Neither is a class
 * compiled by a transformer older than the one that records classes, other than through its
 * module's exports.
 *
 * A module that fails to load raises, as it did in v1: a class that silently fails to register
 * would otherwise only show up later as an unresolvable dependency, far from the cause.
 *
 * The folder is waited for as {@link resolveRbxPath} waits: `caller`, the registration that gave the
 * path (`registerProviders("src/server/services")`), is named in the warning a slow wait gets.
 */
export function getClassesInPath(rbxPath: readonly string[], caller?: string): Array<object> {
	const foundClasses = new Array<object>();
	const found = new Set<object>();

	// Own metadata only: an undecorated subclass inherits its parent's identifier, and must not be
	// mistaken for a registered class of its own.
	const add = (value: unknown) => {
		if (typeIs(value, "table") && !found.has(value) && Reflect.hasOwnMetadata(value, "identifier")) {
			found.add(value);
			foundClasses.push(value);
		}
	};

	loadModulesInPath(
		rbxPath,
		(moduleScript, value) => {
			const defined = getModuleClasses(moduleScript);
			if (defined !== undefined) {
				for (const value of defined) {
					add(value);
				}
			}

			if (!typeIs(value, "table")) {
				return;
			}

			// This is an `export =` on a Flamework class.
			if (Reflect.hasOwnMetadata(value, "identifier")) {
				add(value);
				return;
			}

			// This is an `export` on a Flamework class.
			for (const [, member] of pairs(value)) {
				add(member);
			}
		},
		caller,
	);

	return foundClasses;
}
