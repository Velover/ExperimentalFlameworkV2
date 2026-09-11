// Where the CLI's settings come from: the `cloud` section of the project's flamework.config.json,
// read through the transformer's own loader so that `${NAME}` references, `.env` and `.env.local`
// behave exactly as they do for a build. Flags and environment variables sit on top.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectConfig } from "@flamework-experimental/transformer/out/util/projectConfig.js";

export interface CloudSettings {
	universeId?: string;
	placeId?: string;
	apiKey?: string;
	/** Where the settings were read from, when a file was found. */
	configPath?: string;
	/**
	 * `.env`, then `.env.local`, then the process environment, later ones winning: the CLI reads
	 * its own variables (ROBLOX_API_KEY, UNIVERSE_ID, PLACE_ID, PROJECT) from here, so a `.env`
	 * works without the config file referencing it.
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

	return {
		universeId: cloud.universeId,
		placeId: cloud.placeId,
		// An empty string is what `${ROBLOX_API_KEY:-}` gives when the variable is not set.
		apiKey: cloud.apiKey !== undefined && cloud.apiKey !== "" ? cloud.apiKey : undefined,
		configPath: loaded.configPath,
		env: loaded.env,
	};
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
