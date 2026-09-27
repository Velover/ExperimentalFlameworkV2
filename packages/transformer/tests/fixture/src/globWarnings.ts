import { Flamework } from "@flamework-experimental/core";

// Globs the build warns about, and ones it does not. A glob that matches no files still compiles
// and resolves to no paths at runtime, so the registration it is given to registers nothing.
export const globWarnings = Flamework.createModule()
	.registerProvidersGlob("src/missing/**/*.ts")
	.registerProvidersGlob("./missing/*.ts")
	.registerProvidersGlob("./glob/*.ts")
	.build();
