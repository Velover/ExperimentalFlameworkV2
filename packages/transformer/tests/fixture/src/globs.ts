import { Flamework } from "@flamework/core";

// Resolved at compile time into the build info (and, for game projects, include/flamework/globs.json).
export const globModule = Flamework.createModule().registerProvidersGlob("src/glob/**/*.ts").build();

// The same macros on a plugin target, whose members are function-typed properties, not methods.
export const globPlugin = Flamework.createPlugin("Globs", (target) => {
	target.registerProvidersGlob("src/glob/**/*.ts");
	target.registerProviders("src/glob");
});
