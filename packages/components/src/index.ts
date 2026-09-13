export { BaseComponent } from "./baseComponent";
export { Components } from "./components";
export { Component, ComponentStreamingMode } from "./decorator";
export { ComponentPlugin } from "./componentModule";

// Required to subclass `BaseComponent` with a constructor of your own, which is how a component
// declares dependencies of its own.
export type { ComponentMetadata } from "./baseComponent";

export type { ComponentConfig, ComponentLink } from "./decorator";
export type { InstanceShape } from "./instanceTree";
export type { ComponentModuleConfig } from "./componentModule";
