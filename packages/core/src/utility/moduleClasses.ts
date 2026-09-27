/**
 * The Flamework classes each module defined as it loaded, by the module's `script`, in the order
 * they were defined: what path registration finds in a module besides what it exports.
 *
 * The transformer records a class with `Reflect.defineMetadata(class, "flamework:module", script)`,
 * and only a class the module creates once per load -- declared at the top level of the file, or
 * of a namespace in it. A class declared inside a function is created by every call and is never
 * recorded, so nothing here grows with calls, and a later path registration never finds a class
 * that belongs to a test case or a factory. Keyed by the ModuleScript rather than read off the
 * class's identifier, which says nothing about where the class came from once ids are short, tiny
 * or obfuscated.
 *
 * Held for good, as the module's own exports are held by the require cache: a module loads once.
 */
const classesByModule = new Map<unknown, Array<object>>();

/** Records a class against the module that defined it. Called by `Reflect.defineMetadata`. */
export function recordModuleClass(moduleScript: unknown, value: object) {
	if (moduleScript === undefined) return;

	let classes = classesByModule.get(moduleScript);
	if (classes === undefined) {
		classes = [];
		classesByModule.set(moduleScript, classes);
	}

	if (!classes.includes(value)) {
		classes.push(value);
	}
}

/** The classes a module defined as it loaded, in definition order, or none. */
export function getModuleClasses(moduleScript: unknown): ReadonlyArray<object> | undefined {
	return classesByModule.get(moduleScript);
}

/**
 * Every recorded class, with the module that defined it, until the callback answers `true`. For
 * explaining a failed resolution, which is rare: nothing here is indexed for it.
 */
export function findModuleClass(predicate: (value: object) => boolean): [object, unknown] | undefined {
	for (const [moduleScript, classes] of classesByModule) {
		for (const value of classes) {
			if (predicate(value)) {
				return [value, moduleScript];
			}
		}
	}
}
