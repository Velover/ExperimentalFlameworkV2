import {
	Flamework,
	Modding,
	getGlobPaths,
	getRuntimeConfig,
	requireModulesInPath,
	type PluginDefinition,
	type ScopeCondition,
} from "@flamework-experimental/core";
import { attach, detach, Testing } from "./host";
import { __setCurrentModule } from "./registry";
import { DEFAULT_TIMEOUT } from "./runner";

/** The `testing` section of `flamework.config.json`; options given in code override it. */
export interface TestingOptions {
	/** Whether the plugin does anything. Off, no test file is loaded and no instance is made. */
	enabled?: boolean;

	/** Runs every test right after ignition, instead of only when the bindable is invoked. */
	autoRun?: boolean;

	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout?: number;
}

interface Registration {
	readonly paths: ReadonlyArray<readonly string[]>;
	readonly scope?: ScopeCondition;
}

/** No condition: what a registration that was not given one contributes to a list. */
const NO_CONDITION: ScopeCondition = {};

/** The options in effect: what was given in code, else the config file, else the defaults. */
export function resolveTestingOptions(options?: TestingOptions): Required<TestingOptions> {
	const config = getRuntimeConfig().testing ?? {};
	return {
		enabled: options?.enabled ?? config.enabled ?? false,
		autoRun: options?.autoRun ?? config.autoRun ?? false,
		timeout: options?.timeout ?? config.timeout ?? DEFAULT_TIMEOUT,
	};
}

/**
 * The plugin that loads test folders and answers `Workspace.FlameworkTests`. Include it in the
 * module whose providers the tests exercise: the test files are required after that module has
 * ignited, so `Dependency<T>()` and top-level imports of its providers work in them.
 */
export class TestingPlugin {
	public static createPlugin(options?: TestingOptions) {
		return new TestingPlugin(options);
	}

	/**
	 * A plugin that loads every module under a source folder.
	 *
	 * @metadata macro
	 */
	public static fromPath<T extends string>(
		_stringPath: T,
		scope?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		return this.createPlugin().registerTests(_stringPath, scope, path).build();
	}

	/**
	 * A plugin that loads every module under every folder a compile-time glob matches.
	 *
	 * @metadata macro
	 */
	public static fromGlob<T extends string>(
		_glob: T,
		scope?: ScopeCondition,
		glob?: Modding.Intrinsic<"pathglob", [T], string>,
	) {
		return this.createPlugin().registerTestsGlob(_glob, scope, glob).build();
	}

	private registrations = new Array<Registration>();

	private constructor(private readonly options?: TestingOptions) {}

	/**
	 * Loads every module under the specified path when the module ignites, so that the
	 * `defineTests` calls in them register. With a scope condition, only in a build where it
	 * holds, on top of the module's condition.
	 *
	 * @metadata macro
	 */
	public registerTests<T extends string>(
		_stringPath: T,
		scope?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		assert(path !== undefined);
		this.registrations.push({ paths: [path], scope });
		return this;
	}

	/**
	 * Loads every module under every path a compile-time glob matches.
	 *
	 * @metadata macro
	 */
	public registerTestsGlob<T extends string>(
		_glob: T,
		scope?: ScopeCondition,
		glob?: Modding.Intrinsic<"pathglob", [T], string>,
	) {
		assert(glob !== undefined);
		this.registrations.push({ paths: getGlobPaths(glob), scope });
		return this;
	}

	public build(): PluginDefinition {
		const registrations = this.registrations;
		const options = this.options;

		return Flamework.createPlugin("Testing", (target) => {
			const resolved = resolveTestingOptions(options);
			if (!resolved.enabled) {
				return;
			}

			const active = registrations.filter((registration) => target.isActive(registration.scope ?? NO_CONDITION));
			let attached = false;

			// After ignition, so that a test file can import the module's providers at its top level.
			target.onPostIgnite((module) => {
				__setCurrentModule(module);
				try {
					for (const registration of active) {
						for (const path of registration.paths) {
							requireModulesInPath(path);
						}
					}
				} finally {
					__setCurrentModule(undefined);
				}

				attach({ timeout: resolved.timeout });
				attached = true;

				// Deferred rather than spawned: a run that never yields would otherwise complete inside
				// the ignition that started it.
				if (resolved.autoRun) {
					task.defer(() => Testing.run());
				}
			});

			target.onExtinguished(() => {
				if (attached) {
					attached = false;
					detach();
				}
			});
		});
	}
}

/** A plugin with no folders to load, for tests defined in files the game requires anyway. */
export function createTestingPlugin(options?: TestingOptions) {
	return TestingPlugin.createPlugin(options).build();
}
