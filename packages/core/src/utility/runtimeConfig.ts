import { findMetadataContainer } from "./metadata";

export interface CoreRuntimeConfig {
	/** Whether lifecycle events are wrapped in `debug.profilebegin`. Defaults to running in Studio. */
	profiling?: boolean;
}

export interface NetworkingRuntimeConfig {
	/** Whether event and function payloads are serialized. Compiled into the metadata; informational at runtime. */
	serialization?: boolean;
}

export interface ComponentsRuntimeConfig {
	/** Default `warningTimeout` for components that do not set one. */
	warningTimeout?: number;

	/** Default `attributeWarningTimeout` for components that do not set one. */
	attributeWarningTimeout?: number;

	/** Default `streamingMode` for components that do not set one. */
	streamingMode?: "Disabled" | "Watching" | "Contextual";
}

/**
 * The runtime sections of the project's `flamework.config.json`. The transformer writes them to
 * `include/flamework/config.json` for game projects; a project without them gets an empty object.
 */
export interface RuntimeConfig {
	core?: CoreRuntimeConfig;
	networking?: NetworkingRuntimeConfig;
	components?: ComponentsRuntimeConfig;
}

let cached: RuntimeConfig | undefined;

/**
 * Returns the runtime sections of `flamework.config.json`, read once. Every package takes its
 * defaults from here, so one file configures the transformer and the runtime alike.
 */
export function getRuntimeConfig(): RuntimeConfig {
	cached ??= findMetadataContainer<RuntimeConfig>("config") ?? {};
	return cached;
}
