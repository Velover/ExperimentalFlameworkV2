import type { Module } from "./module";

/**
 * The module `Dependency<T>()` resolves against.
 *
 * The first root module ignited in a realm claims it, and igniting with `{ default: true }` replaces
 * it. Extinguishing the default releases it, so the next root ignited becomes the default again --
 * which is what lets a test ignite and extinguish a module per case without leaking one into the next.
 */
let defaultModule: Module | undefined;

export function getDefaultModule() {
	return defaultModule;
}

export function setDefaultModule(module: Module) {
	defaultModule = module;
}

/** Releases the default if `module` is it; a module that never was the default changes nothing. */
export function clearDefaultModule(module: Module) {
	if (defaultModule === module) {
		defaultModule = undefined;
	}
}
