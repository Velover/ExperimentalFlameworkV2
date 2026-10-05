// Where the CLI's settings come from: the `cloud` section of the project's flamework.config.json
// (and its own keys in the `testing` section),
// read through the transformer's own loader so that `${NAME}` references, `.env` and `.env.local`
// behave exactly as they do for a build. Flags and environment variables sit on top.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectConfig } from "@flamework-experimental/transformer/out/util/projectConfig.js";

export interface CloudSettings {
	/** The experience the testing place is in. Named so nothing confuses it with the original. */
	testingUniverseId?: string;
	/** The place tests are published to and run in. Never the original place. */
	testingPlaceId?: string;
	apiKey?: string;
	/** A copy of the original place to lay the build over, resolved against the config file's directory. */
	originalPlace?: string;
	/**
	 * The ModuleScript exporting `ignite()` that a cloud task requires to start the game, from the
	 * config's `testing.entry`; Studio needs none, the place runs itself.
	 */
	testingEntry?: string;
	/**
	 * `testing.keepAwake`: a Studio run asks Windows to keep the display on while it lasts. After
	 * `--keep-awake` and `KEEP_AWAKE`.
	 */
	keepAwake?: boolean;
	/** `testing.failOnSkip`: a skipped test fails the run. After `--fail-on-skip` and `FAIL_ON_SKIP`. */
	failOnSkip?: boolean;
	/**
	 * `testing.lockTimeout`: seconds a command that opens a Studio window waits for the Studio lock.
	 * After `--lock-timeout` and `FLAMEWORK_TEST_LOCK_TIMEOUT`.
	 */
	lockTimeout?: number;
	/**
	 * `testing.lockHold`: minutes a window flamework-test opened may sit unused before another
	 * project may close it. After `--hold` and `FLAMEWORK_TEST_LOCK_HOLD`.
	 */
	lockHold?: number;
	/**
	 * `testing.parallel`: how many projects' Studio windows a `test` of several runs side by side.
	 * After `--parallel` and `FLAMEWORK_TEST_PARALLEL`; never read by a cloud run.
	 */
	parallel?: number;
	/** Where the settings were read from, when a file was found. */
	configPath?: string;
	/**
	 * `.env`, then `.env.local`, then the process environment, later ones winning: the CLI reads
	 * its own variables (ROBLOX_API_KEY, TESTING_UNIVERSE_ID, TESTING_PLACE_ID, ORIGINAL_PLACE,
	 * ROJO_PROJECT, KEEP_AWAKE, FAIL_ON_SKIP, FLAMEWORK_TEST_LOCK_TIMEOUT, FLAMEWORK_TEST_LOCK_HOLD,
	 * FLAMEWORK_TEST_PARALLEL)
	 * from here, so a `.env` works without the config file referencing it.
	 */
	env: Record<string, string>;
}

/**
 * Reads the `cloud` section of the nearest flamework.config.json at or above `cwd`, with its
 * environment substituted. A directory with no config file gives empty settings, not an error:
 * the ids and the key can still come from flags and the environment.
 */
export function loadCloudSettings(cwd: string, env: Record<string, string | undefined>): CloudSettings {
	const loaded = loadProjectConfig(cwd, packageRoot(cwd), {}, env as Record<string, string>);
	const cloud = loaded.project.cloud ?? {};
	const base = loaded.configPath !== undefined ? dirname(loaded.configPath) : cwd;
	const entry = loaded.project.testing?.entry;
	// The CLI's own keys in the `testing` section (the transformer leaves them out of the place).
	const testing = loaded.project.testing ?? {};

	return {
		testingUniverseId: cloud.testingUniverseId,
		testingPlaceId: cloud.testingPlaceId,
		// An empty string is what `${ROBLOX_API_KEY:-}` gives when the variable is not set.
		apiKey: cloud.apiKey !== undefined && cloud.apiKey !== "" ? cloud.apiKey : undefined,
		originalPlace:
			cloud.originalPlace !== undefined && cloud.originalPlace !== ""
				? resolve(base, cloud.originalPlace)
				: undefined,
		testingEntry: entry !== undefined && entry !== "" ? entry : undefined,
		...(typeof testing.keepAwake === "boolean" ? { keepAwake: testing.keepAwake } : {}),
		...(typeof testing.failOnSkip === "boolean" ? { failOnSkip: testing.failOnSkip } : {}),
		...(typeof testing.lockTimeout === "number" ? { lockTimeout: testing.lockTimeout } : {}),
		...(typeof testing.lockHold === "number" ? { lockHold: testing.lockHold } : {}),
		...(typeof testing.parallel === "number" ? { parallel: testing.parallel } : {}),
		configPath: loaded.configPath,
		env: loaded.env,
	};
}

/**
 * The project a command runs for, which the Studio lock records and compares: the nearest folder
 * at or above `cwd` holding a flamework.config.json, else the nearest holding a package.json, else
 * `cwd` itself. So a command run from any folder of a game, one with a package.json of its own
 * included, speaks for the same project.
 */
export function findProjectRoot(cwd: string, isFile: (path: string) => boolean = existsSync): string {
	const start = resolve(cwd);
	let withPackage: string | undefined;
	for (let directory = start; ;) {
		if (isFile(join(directory, "flamework.config.json"))) return directory;
		if (withPackage === undefined && isFile(join(directory, "package.json"))) withPackage = directory;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return withPackage ?? start;
}

/** The nearest directory at or above `cwd` holding a package.json, else the top of the tree: how far up the config file is looked for. */
function packageRoot(cwd: string): string {
	let directory = resolve(cwd);
	for (;;) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return directory;
		directory = parent;
	}
}
