export { Flamework } from "./flamework";
export { Modding } from "./modding";
export { Reflect } from "./reflect";
export { Provider } from "./provider";
export { Injectable } from "./injectable";
export { Dependency } from "./dependency";
export { Serialization } from "./serialization/types";

export type { ProviderDecoratorConfig } from "./provider";
export type { InjectableDecoratorConfig } from "./injectable";

// Modules
export { ModuleDefinition } from "./module/moduleDefinition";
export { ModuleBuilder } from "./module/moduleBuilder";
export { HookPriority } from "./module/moduleHooks";

export type { Module, ProviderLookup } from "./module/module";
export type {
	IgniteOptions,
	InjectionContext,
	ModuleProvider,
	ModuleState,
	PluginInclusion,
	ProviderConfig,
	ProviderRegistrationOptions,
} from "./module/moduleDefinition";
export type { HookOptions } from "./module/moduleHooks";

// Scopes
export { describeConditions, holdsCondition, holdsEveryCondition, __setActiveScopes } from "./module/scopes";
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
export { getClassesInPath } from "./utility/getClassesInPath";
export { getClassesInGlob, getGlobPaths } from "./utility/globs";
export { getRuntimeConfig } from "./utility/runtimeConfig";
export type {
	ComponentsRuntimeConfig,
	CoreRuntimeConfig,
	NetworkingRuntimeConfig,
	RuntimeConfig,
	ScopesRuntimeConfig,
} from "./utility/runtimeConfig";
export type { AbstractConstructor, Constructor } from "./utility/constructors";
