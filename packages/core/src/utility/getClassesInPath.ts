import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";
import { resolveRbxPath } from "./pathRoot";

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

	const preloadPath = resolveRbxPath(rbxPath);
	const loaded = new Array<defined>();

	if (preloadPath.IsA("ModuleScript")) {
		const value = importModule(preloadPath);
		if (value !== undefined) {
			loaded.push(value);
		}
	}

	for (const instance of preloadPath.GetDescendants()) {
		if (instance.IsA("ModuleScript")) {
			const value = importModule(instance);
			if (value !== undefined) {
				loaded.push(value);
			}
		}
	}

	return loaded;
}

/**
 * Requires every ModuleScript at and under the specified Rojo path and returns every exported value
 * that carries its own Flamework identifier.
 *
 * A module that fails to load raises, as it did in v1: a class that silently fails to register
 * would otherwise only show up later as an unresolvable dependency, far from the cause.
 */
export function getClassesInPath(rbxPath: readonly string[]): Array<object> {
	const foundClasses = new Array<object>();

	for (const value of requireModulesInPath(rbxPath)) {
		if (!typeIs(value, "table")) {
			continue;
		}

		// This is an `export =` on a Flamework class.
		if (Reflect.hasOwnMetadata(value, "identifier")) {
			foundClasses.push(value);
			continue;
		}

		for (const [, member] of pairs(value)) {
			// This is an `export` on a Flamework class.
			//
			// Own metadata only: an undecorated subclass inherits its parent's identifier, and
			// must not be mistaken for a registered class of its own.
			if (typeIs(member, "table") && Reflect.hasOwnMetadata(member, "identifier")) {
				foundClasses.push(member);
			}
		}
	}

	return foundClasses;
}
