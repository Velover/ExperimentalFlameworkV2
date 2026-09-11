import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";
import { resolveRbxPath } from "./pathRoot";

/**
 * Requires every ModuleScript at and under the specified Rojo path and returns every exported value
 * that carries its own Flamework identifier.
 *
 * The path is relative to the tree's root (`game` in a place, the model's root in a plugin), which
 * `resolveRbxPath` finds. A module that fails to load raises, as it did in v1: a class that silently
 * fails to register would otherwise only show up later as an unresolvable dependency, far from the
 * cause.
 */
export function getClassesInPath(rbxPath: readonly string[]): Array<object> {
	assert(rbxPath);

	const preloadPath = resolveRbxPath(rbxPath);

	const foundClasses = new Array<object>();
	const search = (moduleScript: ModuleScript) => {
		const start = os.clock();
		const [success, value] = pcall(() => tsImport(moduleScript));
		const endTime = math.floor((os.clock() - start) * 1000);
		if (!success) {
			error(`${moduleScript.GetFullName()} failed to load (${endTime}ms): ${value}`, 0);
		}

		if (typeIs(value, "table")) {
			// This is an `export =` on a Flamework class.
			if (Reflect.hasOwnMetadata(value, "identifier")) {
				return foundClasses.push(value);
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
	};

	if (preloadPath.IsA("ModuleScript")) {
		search(preloadPath);
	}

	for (const instance of preloadPath.GetDescendants()) {
		if (instance.IsA("ModuleScript")) {
			search(instance);
		}
	}

	return foundClasses;
}
