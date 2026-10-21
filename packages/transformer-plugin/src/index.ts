export * from "./types";
export { registerPlugin } from "./registry";
// The transformer drains the registry; a plugin that did would take the other plugins' registrations.
// Left out of the typings (stripInternal), like its declaration.
/** @internal */
export { drainRegisteredPlugins } from "./registry";
export type { PluginCallback } from "./registry";
