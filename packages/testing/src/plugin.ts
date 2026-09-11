import {
	Flamework,
	HookPriority,
	getRuntimeConfig,
	type Module,
	type PluginDefinition,
	type ScopeCondition,
} from "@flamework-experimental/core";
import { attach, detach, Testing } from "./host";
import { __getCurrentModule, __setCurrentModule } from "./registry";
import { DEFAULT_TIMEOUT } from "./runner";

/** The scope tests are on under when the config names none. */
export const DEFAULT_TESTING_SCOPE = "testing";

/** The `testing` section of `flamework.config.json`; options given in code override it. */
export interface TestingOptions {
	/**
	 * Whether the plugin attaches the host at all. Unset, it follows the scope condition, so this
	 * is an override for either direction.
	 */
	enabled?: boolean;

	/**
	 * Scopes under which tests are on: the host attaches when at least one is active, the way
	 * `activeIn` works everywhere else. Defaults to `["testing"]`.
	 */
	activeIn?: readonly string[];

	/** Scopes under which tests stay off, whatever else is active. */
	inactiveIn?: readonly string[];

	/** Runs every test right after ignition, instead of only when the bindable is invoked. */
	autoRun?: boolean;

	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout?: number;
}

/** The options in effect: what was given in code, else the config file, else the defaults. */
export interface ResolvedTestingOptions {
	/** The override, when one was given; the condition decides otherwise. */
	enabled: boolean | undefined;
	condition: ScopeCondition;
	autoRun: boolean;
	timeout: number;
}

export function resolveTestingOptions(options?: TestingOptions): ResolvedTestingOptions {
	const config = getRuntimeConfig().testing ?? {};
	return {
		enabled: options?.enabled ?? config.enabled,
		condition: {
			activeIn: options?.activeIn ?? config.activeIn ?? [DEFAULT_TESTING_SCOPE],
			inactiveIn: options?.inactiveIn ?? config.inactiveIn,
		},
		autoRun: options?.autoRun ?? config.autoRun ?? false,
		timeout: options?.timeout ?? config.timeout ?? DEFAULT_TIMEOUT,
	};
}

/**
 * A plugin that answers `Workspace.FlameworkTests` (and, on the server, `FlameworkTestsServer`)
 * for the sections the module's providers define. Include it in the module whose providers the
 * tests exercise; the tests themselves are ordinary providers, usually scoped to `testing`, that
 * call `defineTests` as they start.
 *
 * Tests are on when the scope condition holds, the `testing` scope by default, unless `enabled`
 * says otherwise. Off, the plugin is inert: no instance is made.
 */
export function createTestingPlugin(options?: TestingOptions): PluginDefinition {
	return Flamework.createPlugin("Testing", (target) => {
		const resolved = resolveTestingOptions(options);
		const enabled = resolved.enabled ?? target.isActive(resolved.condition);
		if (!enabled) {
			return;
		}

		// The module is current from before its providers construct until after they have started,
		// so a section defined in a constructor, `onInit` or `onStart` knows the module it belongs
		// to. First and Last, so that the window holds whatever order the plugins were included in.
		let previous: Module | undefined;
		target.onPreIgnite(
			(module) => {
				previous = __getCurrentModule();
				__setCurrentModule(module);
			},
			{ priority: HookPriority.First },
		);

		let attached = false;
		target.onPostIgnite(
			() => {
				__setCurrentModule(previous);
				previous = undefined;

				attach({ timeout: resolved.timeout });
				attached = true;

				// Deferred rather than spawned: a run that never yields would otherwise complete inside
				// the ignition that started it.
				if (resolved.autoRun) {
					task.defer(() => Testing.run());
				}
			},
			{ priority: HookPriority.Last },
		);

		target.onExtinguished(() => {
			if (attached) {
				attached = false;
				detach();
			}
		});
	});
}

/** The plugin with the config file's settings. */
export const TestingPlugin: PluginDefinition = createTestingPlugin();
