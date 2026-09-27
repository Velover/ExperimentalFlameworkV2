import { Reflect } from "../reflect";
import { findModuleClass } from "./moduleClasses";

function describeModule(moduleScript: unknown) {
	return typeIs(moduleScript, "Instance") ? moduleScript.GetFullName() : tostring(moduleScript);
}

/**
 * Why a dependency no module resolved cannot be resolved, when its id names a Flamework class that
 * has been loaded -- one a module defined at its top level, which the module record knows -- with
 * what to do about it. Nothing for any other id: an interface, a type registered nowhere, a class
 * defined inside a function or never required, whose failure keeps the plain message.
 *
 * `origin` is the class whose constructor asked, when one did.
 */
export function explainUnresolvedClass(id: string, origin?: object): string | undefined {
	const found = findModuleClass((value) => Reflect.getOwnMetadata<string>(value, "identifier") === id);
	if (found === undefined) return undefined;

	const [value, moduleScript] = found;
	const where = describeModule(moduleScript);

	if (Reflect.hasOwnMetadata(value, "flamework:provider")) {
		return (
			`'${value}' (${where}) is a @Provider() that nothing in this module registers or provides: ` +
			"add its folder to registerProviders, register it with registerClassProvider, include the plugin that provides it, " +
			"or import a module that has it"
		);
	}

	if (Reflect.hasOwnMetadata(value, "flamework:component")) {
		if (origin !== undefined && Reflect.hasOwnMetadata(origin, "flamework:component")) {
			return (
				`'${value}' (${where}) is a component that no ComponentPlugin of this module registers, ` +
				`so the component '${origin}' cannot take it: register it in one`
			);
		}

		return (
			`'${value}' (${where}) is a component (@Component), not a provider: a module never constructs a component, ` +
			"so Dependency<T>() and constructor injection cannot reach one. Make it a @Provider(), or get it from " +
			"Components on the instance it is attached to (components.getComponent<T>(instance))"
		);
	}

	return (
		`'${value}' (${where}) is not a provider: it carries no @Provider() decorator. ` +
		"Decorate it with @Provider(), or build it with module.createClassInstance"
	);
}
