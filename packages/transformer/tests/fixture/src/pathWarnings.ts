import { Flamework, requireModules } from "@flamework-experimental/core";
import { ComponentPlugin } from "@flamework-experimental/components";

// Paths the build warns about, and ones it does not. A path with nothing the build emits under it
// still compiles to a Rojo path, but the place has no folder there, so the call would wait for it
// at runtime. src/typesOnly holds a declaration file and nothing that compiles to a module.
export const pathWarnings = Flamework.createModule()
	.registerProviders("src/missing")
	.registerProviders("src/Glob")
	.registerProviders("src/typesOnly")
	.registerProviders("src/glob")
	.includePlugin(ComponentPlugin.fromPath("src/missing/components"))
	.build();

export function requireMisspelled() {
	return requireModules("src/glob/Target");
}

export function requireData() {
	// A folder of JSON only: Rojo makes each file a ModuleScript, so this is not warned about.
	return requireModules("src/jsonOnly");
}
