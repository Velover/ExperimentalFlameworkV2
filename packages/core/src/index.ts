export { Flamework } from "./flamework";
export { Modding } from "./modding";
export { Reflect } from "./reflect";
export { Provider } from "./provider";
export { Injectable } from "./injectable";
export { Dependency } from "./dependency";
export { requireModules } from "./utility/getClassesInPath";
export { Serialization } from "./serialization/types";

export type { ProviderDecoratorConfig } from "./provider";
export type { InjectableDecoratorConfig } from "./injectable";

// Modules
export { ModuleDefinition } from "./module/moduleDefinition";
export { ModuleBuilder } from "./module/moduleBuilder";
export { HookPriority } from "./module/moduleHooks";

export type { Module } from "./module/module";
export type {
	IgniteOptions,
	InjectionContext,
	ProviderConfig,
	ProviderRegistrationOptions,
} from "./module/moduleDefinition";
export type { HookOptions } from "./module/moduleHooks";

// Scopes
export { holdsCondition } from "./module/scopes";
export type { ScopeCondition } from "./module/scopes";

// Plugins
export { PluginDefinition } from "./plugin/pluginDefinition";
export { LifecyclePlugin, LifecycleProvider, createLifecyclePlugin } from "./lifecycle/lifecyclePlugin";

export type { LifecyclePluginOptions } from "./lifecycle/lifecyclePlugin";
export type {
	InterfaceConfiguration,
	InterfaceContext,
	InterfaceTargetKind,
	PluginTarget,
} from "./plugin/pluginDefinition";

// Lifecycle events
export type { OnExtinguished, OnInit, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycle/lifecycleInterfaces";

// Utilities that plugins need in order to implement path-based registration.
export { getClassesInPath, requireModulesInPath } from "./utility/getClassesInPath";
export { getClassesInGlob, getGlobPaths } from "./utility/globs";
export { getPathRoot, resolveRbxPath } from "./utility/pathRoot";
export { getRuntimeConfig } from "./utility/runtimeConfig";
export type {
	ComponentsRuntimeConfig,
	CoreRuntimeConfig,
	NetworkingRuntimeConfig,
	RuntimeConfig,
	ScopesRuntimeConfig,
	TestingRuntimeConfig,
} from "./utility/runtimeConfig";
export type { AbstractConstructor, Constructor } from "./utility/constructors";

// Shared with Flamework's other packages, which import them from here and are always installed at
// the same version: typed, since they import them, but @hidden and outside the stability promise
// (docs/stability.md).
export { describeConditions } from "./module/scopes";
export { importModule } from "./utility/getClassesInPath";
export { explainLeftOut, leftOutRegistration } from "./utility/leftOut";
export type { LeftOutRegistration } from "./utility/leftOut";

// Core's own internals, which no other package needs: left out of the typings (stripInternal), and
// outside the stability promise (docs/stability.md). The Luau keeps the function's export.
/** @internal */
export { holdsEveryCondition } from "./module/scopes";
/** @internal */
export type { ProviderLookup } from "./module/module";
/** @internal */
export type { ModuleProvider, ModuleState, PluginInclusion } from "./module/moduleDefinition";

// The test harness's hooks: exported for the Luau it reaches through the package entry, and marked
// @internal like their declarations so that stripInternal leaves them out of the typings as well
// (a re-export of a stripped declaration would not type-check).
/** @internal */
export { __setActiveScopes } from "./module/scopes";
/** @internal */
export { __setPathRoot } from "./utility/pathRoot";
