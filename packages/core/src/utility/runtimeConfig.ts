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

export interface ScopesRuntimeConfig {
	/**
	 * The scopes this build was compiled with, usually taken from the environment at compile time.
	 * `"*"` stands for every scope. Read by the scope checks in `@flamework-experimental/core`.
	 */
	active?: string[];
}

export interface TestingRuntimeConfig {
	/** Whether the testing plugin loads test folders and answers the bindable and remote. */
	enabled?: boolean;

	/** Runs every test right after ignition, instead of only on request. */
	autoRun?: boolean;

	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout?: number;

	/**
	 * The tree path of a ModuleScript exporting `ignite()`, resolved by the transformer from the
	 * source path in `flamework.config.json`, for runs where nothing starts the game by itself.
	 */
	entry?: readonly string[];
}

/**
 * The runtime sections of the project's `flamework.config.json`. The transformer writes them to
 * `include/flamework/config.json` for game projects; a project without them gets an empty object.
 */
export interface RuntimeConfig {
	core?: CoreRuntimeConfig;
	networking?: NetworkingRuntimeConfig;
	components?: ComponentsRuntimeConfig;
	scopes?: ScopesRuntimeConfig;
	testing?: TestingRuntimeConfig;
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
