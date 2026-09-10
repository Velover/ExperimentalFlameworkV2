import type { Modding } from "./modding";
import type { Module } from "./module/module";
import { getDefaultModule } from "./module/defaultModule";

/**
 * Resolves a dependency from a module.
 *
 * Given a module, it resolves there. Otherwise it resolves from the default module: the first root
 * module ignited in this realm, or the one ignited with `{ default: true }`.
 *
 * This is for code that has no constructor to inject through -- a UI component, a script, a callback
 * handed to something outside Flamework. Inside a provider, take a constructor parameter instead:
 * it declares the dependency where it can be read, and it orders construction.
 *
 * Raises if no module was given and none has been ignited yet, or if the default has since been
 * extinguished.
 *
 * @metadata macro
 */
export function Dependency<T>(module?: Module, info?: string | Modding.Target.DependencyConcise<T>): T {
	if (module === undefined) {
		module = getDefaultModule();
		if (module === undefined) {
			error("Dependency<T>() was called before any module was ignited", 2);
		}
	}

	return module.resolveDependency<T>(info);
}
