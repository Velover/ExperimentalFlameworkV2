// Where the CLI's settings come from: the `flameworkTest` section of the project's
// flamework.config.json (and `testing.entry`, for a cloud run),
// read through the transformer's own loader so that `${NAME}` references, `.env` and `.env.local`
// behave exactly as they do for a build. Flags and environment variables sit on top.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectConfig } from "@flamework-experimental/transformer/out/util/projectConfig.js";

export interface CloudSettings {
	/** The experience the testing place is in: `flameworkTest.universeId`. */
	universeId?: string;
	/** The place tests are published to and run in, `flameworkTest.placeId`. Never the original place. */
	placeId?: string;
	apiKey?: string;
	/** A copy of the original place to lay the build over, resolved against the config file's directory. */
	originalPlace?: string;
	/**
	 * The ModuleScript exporting `ignite()` that a cloud task requires to start the game, from the
	 * config's `testing.entry`; Studio needs none, the place runs itself.
	 */
	testingEntry?: string;
	/**
	 * `flameworkTest.keepAwake`: a Studio run asks Windows to keep the display on while it lasts.
	 * After `--keep-awake` and `FLAMEWORK_TEST_KEEP_AWAKE`.
	 */
	keepAwake?: boolean;
	/** `flameworkTest.failOnSkip`: a skipped test fails the run. After `--fail-on-skip` and `FLAMEWORK_TEST_FAIL_ON_SKIP`. */
	failOnSkip?: boolean;
	/**
	 * `flameworkTest.lockTimeout`: seconds a command that opens a Studio window waits for the Studio
	 * lock. After `--lock-timeout` and `FLAMEWORK_TEST_LOCK_TIMEOUT`.
	 */
	lockTimeout?: number;
	/**
	 * `flameworkTest.lockHold`: minutes a window flamework-test opened may sit unused before another
	 * project may close it. After `--lock-hold` and `FLAMEWORK_TEST_LOCK_HOLD`.
	 */
	lockHold?: number;
	/**
	 * `flameworkTest.parallel`: how many projects' Studio windows a `test` of several runs side by
	 * side. After `--parallel` and `FLAMEWORK_TEST_PARALLEL`; never read by a cloud run.
	 */
	parallel?: number;
	/**
	 * `flameworkTest.showWindows`: a Studio `test` opens its windows where they can be seen, rather
	 * than on the hidden desktop. After `--show-windows` and `FLAMEWORK_TEST_SHOW_WINDOWS`; never read
	 * by a cloud run.
	 */
	showWindows?: boolean;
	/** Where the settings were read from, when a file was found. */
	configPath?: string;
	/**
	 * `.env`, then `.env.local`, then the process environment, later ones winning: the CLI reads
	 * its own variables (ROBLOX_API_KEY and the FLAMEWORK_TEST_ ones) from here, so a `.env` works
	 * without the config file referencing it.
	 */
	env: Record<string, string>;
}

/**
 * Reads the `flameworkTest` section of the nearest flamework.config.json at or above `cwd`, with its
 * environment substituted. A directory with no config file gives empty settings, not an error:
 * the ids and the key can still come from flags and the environment. A file that still has the
 * settings where they were before 2.0.0-beta.0 (`cloud`, the CLI's keys in `testing`) is refused
 * by the loader, naming where each goes now.
 */
export function loadCloudSettings(cwd: string, env: Record<string, string | undefined>): CloudSettings {
	const loaded = loadProjectConfig(cwd, packageRoot(cwd), {}, env as Record<string, string>);
	const cli = loaded.project.flameworkTest ?? {};
	const base = loaded.configPath !== undefined ? dirname(loaded.configPath) : cwd;
	const entry = loaded.project.testing?.entry;

	return {
		universeId: cli.universeId,
		placeId: cli.placeId,
		// An empty string is what `${ROBLOX_API_KEY:-}` gives when the variable is not set.
		apiKey: cli.apiKey !== undefined && cli.apiKey !== "" ? cli.apiKey : undefined,
		originalPlace:
			cli.originalPlace !== undefined && cli.originalPlace !== "" ? resolve(base, cli.originalPlace) : undefined,
		testingEntry: entry !== undefined && entry !== "" ? entry : undefined,
		...(typeof cli.keepAwake === "boolean" ? { keepAwake: cli.keepAwake } : {}),
		...(typeof cli.failOnSkip === "boolean" ? { failOnSkip: cli.failOnSkip } : {}),
		...(typeof cli.lockTimeout === "number" ? { lockTimeout: cli.lockTimeout } : {}),
		...(typeof cli.lockHold === "number" ? { lockHold: cli.lockHold } : {}),
		...(typeof cli.parallel === "number" ? { parallel: cli.parallel } : {}),
		...(typeof cli.showWindows === "boolean" ? { showWindows: cli.showWindows } : {}),
		configPath: loaded.configPath,
		env: loaded.env,
	};
}

/**
 * The environment variables flamework-test read before 2.0.0-beta.0, and the name of each now. Every
 * one of its variables is `FLAMEWORK_TEST_` and its flag's name now (`--show-windows`,
 * `FLAMEWORK_TEST_SHOW_WINDOWS`), but for the API key, which keeps the one conventional name.
 */
export const RENAMED_VARIABLES: Readonly<Record<string, string>> = {
	FAIL_ON_SKIP: "FLAMEWORK_TEST_FAIL_ON_SKIP",
	KEEP_AWAKE: "FLAMEWORK_TEST_KEEP_AWAKE",
	FLAMEWORK_TEST_SHOW: "FLAMEWORK_TEST_SHOW_WINDOWS",
	ROJO_PROJECT: "FLAMEWORK_TEST_PROJECT",
	ORIGINAL_PLACE: "FLAMEWORK_TEST_ORIGINAL_PLACE",
	TESTING_UNIVERSE_ID: "FLAMEWORK_TEST_UNIVERSE_ID",
	TESTING_PLACE_ID: "FLAMEWORK_TEST_PLACE_ID",
	TESTING_PLACE_API_KEY: "ROBLOX_API_KEY",
	LUNE_EXE: "FLAMEWORK_TEST_LUNE_EXE",
	ROBLOX_STUDIO_EXE: "FLAMEWORK_TEST_STUDIO_EXE",
	STUDIO_MCP_EXE: "FLAMEWORK_TEST_STUDIO_MCP_EXE",
};

/**
 * The old variables set anywhere the CLI reads its own (the shell, `.env`, `.env.local`), one line
 * each naming the new name; empty when there is none. They are refused rather than read or
 * ignored: an old name left in a CI's settings would otherwise turn a setting off without a word.
 * Where each was set is not said: Bun loads the `.env` of the folder a command runs in into the
 * shell's environment, so the two cannot be told apart.
 */
export function describeRenamedVariables(...sources: Array<Record<string, string | undefined>>): string[] {
	return Object.entries(RENAMED_VARIABLES)
		.filter(([old]) => sources.some((source) => source[old] !== undefined))
		.map(([old, renamed]) => `${old} is now ${renamed}`);
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
