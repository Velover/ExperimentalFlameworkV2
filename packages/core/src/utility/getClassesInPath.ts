import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";
import { resolveRbxPath } from "./pathRoot";
import { getModuleClasses } from "./moduleClasses";

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
 * Requires every ModuleScript at and under a Rojo path, in tree order, handing each to `visit` with
 * what it exported.
 */
function loadModulesInPath(rbxPath: readonly string[], visit: (moduleScript: ModuleScript, value?: defined) => void) {
	assert(rbxPath);

	const preloadPath = resolveRbxPath(rbxPath);
	if (preloadPath.IsA("ModuleScript")) {
		visit(preloadPath, importModule(preloadPath));
	}

	for (const instance of preloadPath.GetDescendants()) {
		if (instance.IsA("ModuleScript")) {
			visit(instance, importModule(instance));
		}
	}
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
	const loaded = new Array<defined>();
	loadModulesInPath(rbxPath, (_, value) => {
		if (value !== undefined) {
			loaded.push(value);
		}
	});

	return loaded;
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
 */
export function getClassesInPath(rbxPath: readonly string[]): Array<object> {
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

	loadModulesInPath(rbxPath, (moduleScript, value) => {
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
	});

	return foundClasses;
}
