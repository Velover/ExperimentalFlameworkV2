import { Flamework } from "@flamework/core";

// Resolved at compile time into the build info (and, for game projects, include/flamework/globs.json).
export const globModule = Flamework.createModule().registerProvidersGlob("src/glob/**/*.ts").build();
