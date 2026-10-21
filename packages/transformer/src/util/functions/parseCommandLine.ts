import ts from "typescript";
import path from "path";
import fs from "fs";
import { RojoResolver } from "@roblox-ts/rojo-resolver";

/**
 * The project roblox-ts is building, as roblox-ts itself resolves it. A transformer plugin is given
 * only the program, not roblox-ts's resolved options, so these are worked out again here, the way
 * roblox-ts does, so that Flamework writes beside what roblox-ts writes. Each step names the roblox-ts
 * code it follows: `out/CLI/commands/build.js` and `out/Project/functions/createProjectData.js` in
 * roblox-ts 3.0.0, and, after 3.0.0, `src/Project/classes/ProjectGraph.ts`,
 * `src/Project/functions/readProjectOptions.ts` and `src/Project/functions/createProjectData.ts`.
 */
export interface CommandLine {
	/** The tsconfig roblox-ts builds (`-p`/`--project`, default `.`). */
	tsconfigPath: string;

	/** The folder of that tsconfig: roblox-ts's `projectPath`. */
	project: string;

	/** Where roblox-ts copies its runtime, and Flamework writes `include/flamework`. */
	includePath: string;

	/** The Rojo project file roblox-ts reads, if there is one. */
	rojoConfigPath?: string;
}

/** The roblox-ts build options Flamework reads, as yargs gives them to roblox-ts's build command. */
interface ArgvOptions {
	project?: string;
	includePath?: string;
	rojo?: string;
}

/** roblox-ts's build command's options that Flamework reads, with their one-letter aliases (`build.ts`). */
const ARGV_OPTIONS: Record<keyof ArgvOptions, string | undefined> = {
	project: "p",
	includePath: "i",
	rojo: undefined,
};

const NEGATIVE_NUMBER = /^-\d+(\.\d*)?(e-?\d+)?$/;

/**
 * The options from the command line, as roblox-ts's yargs parses them: `--includePath x`,
 * `--includePath=x`, `--include-path x`, `-i x`, `-i=x`, `--i x`, a group ending in the letter (`-wi x`), and
 * `-i` with no value (or a letter inside a group, `-ix`) for an empty string. Nothing after `--`.
 * yargs makes a list of a repeated option, which roblox-ts then fails on; the last one is taken here.
 */
export function readArgv(argv: readonly string[]): ArgvOptions {
	const options: ArgvOptions = {};
	const shortNames = new Map<string, keyof ArgvOptions>();
	for (const [name, short] of Object.entries(ARGV_OPTIONS)) {
		if (short !== undefined) shortNames.set(short, name as keyof ArgvOptions);
	}

	// The value after a flag, unless it is the next flag: yargs then gives a string option "".
	const takeNext = (index: number) => {
		const next = argv[index + 1];
		return next !== undefined && (!next.startsWith("-") || NEGATIVE_NUMBER.test(next)) ? next : undefined;
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;

		if (arg.startsWith("--")) {
			const body = arg.slice(2);
			const equals = body.indexOf("=");
			const flag = equals === -1 ? body : body.slice(0, equals);
			// yargs reads `--i` and `--p` as the aliases they spell, which the transformer once required.
			const name = shortNames.get(flag) ?? flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
			if (!(name in ARGV_OPTIONS)) continue;

			let value = equals === -1 ? undefined : body.slice(equals + 1);
			if (value === undefined) {
				value = takeNext(i);
				if (value !== undefined) i++;
			}
			options[name as keyof ArgvOptions] = value ?? "";
		} else if (arg.startsWith("-") && arg.length > 1 && !NEGATIVE_NUMBER.test(arg)) {
			const body = arg.slice(1);
			const equals = body.indexOf("=");
			const letters = equals === -1 ? body : body.slice(0, equals);

			for (let j = 0; j < letters.length; j++) {
				const name = shortNames.get(letters[j]);
				if (name === undefined) continue;

				if (j < letters.length - 1) {
					// Inside a group (`-ix`): yargs sets it, to "".
					options[name] = "";
				} else if (equals !== -1) {
					options[name] = body.slice(equals + 1);
				} else {
					const value = takeNext(i);
					if (value !== undefined) i++;
					options[name] = value ?? "";
				}
			}
		}
	}

	return options;
}

/**
 * Whether the running roblox-ts reads the tsconfig's `rbxts` options as the releases after 3.0.0 do:
 * through `extends`, with paths relative to the config that sets them (`readProjectOptions.ts`). Told
 * by whether roblox-ts loaded that module, which 3.0.0 does not have.
 */
function readsExtendedOptions() {
	// Case-insensitive: a build of roblox-ts can load it as `out/project/functions/...`.
	return Object.keys(require.cache).some((file) =>
		/[\\/]project[\\/]functions[\\/]readprojectoptions\.js$/i.test(file),
	);
}

type PathOptions = Pick<ArgvOptions, "includePath" | "rojo">;

/** A string option of a tsconfig's own `rbxts` block; roblox-ts refuses one of any other type. */
function readPathOptions(rbxts: unknown, resolveFrom?: string): PathOptions {
	const options: PathOptions = {};
	if (rbxts === null || typeof rbxts !== "object") return options;

	for (const key of ["includePath", "rojo"] as const) {
		const value = (rbxts as Record<string, unknown>)[key];
		if (typeof value !== "string") continue;
		// After 3.0.0 a path is resolved against the config that sets it; an empty one stays empty.
		options[key] = resolveFrom !== undefined && value !== "" ? path.resolve(resolveFrom, value) : value;
	}

	return options;
}

/**
 * The `extends` of a tsconfig as roblox-ts after 3.0.0 resolves them (`getExtendedConfigPaths.ts`):
 * a relative or rooted path from the config's folder, `.json` added when the file is not there, and
 * anything else as a package.
 */
function getExtendedConfigPaths(configPath: string, extended: unknown) {
	const paths = new Array<string>();
	const values = typeof extended === "string" ? [extended] : Array.isArray(extended) ? extended : [];
	for (const value of values) {
		if (typeof value !== "string") continue;

		const normalized = ts.normalizeSlashes(value);
		let resolved: string | undefined;
		if (ts.isRootedDiskPath(normalized) || normalized.startsWith("./") || normalized.startsWith("../")) {
			resolved = ts.getNormalizedAbsolutePath(normalized, path.dirname(configPath));
			if (!ts.sys.fileExists(resolved) && !resolved.endsWith(".json")) {
				resolved += ".json";
			}
		} else {
			resolved = ts.nodeNextJsonConfigResolver(normalized, configPath, ts.sys).resolvedModule?.resolvedFileName;
		}

		// roblox-ts stops the build on one it cannot find, before any transformer runs.
		if (resolved !== undefined && ts.sys.fileExists(resolved)) paths.push(path.normalize(resolved));
	}
	return paths;
}

/** `readProjectOptions.ts`: every extended config's options first, then the config's own over them. */
function readExtendedPathOptions(configPath: string, seen = new Set<string>()): PathOptions {
	const options: PathOptions = {};
	const key = path.normalize(configPath).toLowerCase();
	if (seen.has(key)) return options;
	seen.add(key);

	const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config === undefined) return options;

	for (const extendedPath of getExtendedConfigPaths(configPath, config.extends)) {
		Object.assign(options, readExtendedPathOptions(extendedPath, seen));
	}
	Object.assign(options, readPathOptions(config.rbxts, path.dirname(configPath)));
	return options;
}

/**
 * The tsconfig's `rbxts` options. roblox-ts 3.0.0 reads the config's own block only, and leaves its
 * paths to be resolved against the working directory (`getTsConfigProjectOptions` in `build.js`);
 * later releases follow `extends` and resolve each path against its config.
 */
function readTsConfigOptions(tsconfigPath: string): PathOptions {
	if (readsExtendedOptions()) return readExtendedPathOptions(tsconfigPath);

	const text = ts.sys.readFile(tsconfigPath);
	if (text === undefined) return {};
	return readPathOptions(ts.parseConfigFileTextToJson(tsconfigPath, text).config?.rbxts);
}

function findTsConfigPath(projectPath: string, cwd: string) {
	let tsConfigPath: string | undefined = path.resolve(cwd, projectPath);
	if (!fs.existsSync(tsConfigPath) || !fs.statSync(tsConfigPath).isFile()) {
		tsConfigPath = ts.findConfigFile(tsConfigPath, ts.sys.fileExists);
		if (tsConfigPath === undefined) {
			throw new Error("Unable to find tsconfig.json!");
		}
	}
	return path.resolve(cwd, tsConfigPath);
}

/**
 * The project roblox-ts builds, from the command line and the tsconfig, with roblox-ts's precedence:
 * its defaults, then the tsconfig's `rbxts` block, then the command line (`{ ...DEFAULT_PROJECT_OPTIONS,
 * ...rbxts, ...argv }` in 3.0.0's `build.js`, `explicitOptions` in `ProjectGraph.ts`). Only the root
 * project of a build with project references is followed.
 */
export function parseCommandLine(argv: readonly string[] = process.argv, cwd = process.cwd()): CommandLine {
	const flags = readArgv(argv);
	const tsconfigPath = findTsConfigPath(flags.project ?? ".", cwd);
	const project = path.dirname(tsconfigPath);
	const options = { ...readTsConfigOptions(tsconfigPath) };
	if (flags.includePath !== undefined) options.includePath = flags.includePath;
	if (flags.rojo !== undefined) options.rojo = flags.rojo;

	// `createProjectData`: an empty include path is the default, `include` beside the tsconfig, and
	// an empty Rojo path means the one found beside the tsconfig.
	const includePath = path.resolve(cwd, options.includePath || path.join(project, "include"));
	const rojoConfigPath = options.rojo
		? path.resolve(cwd, options.rojo)
		: RojoResolver.findRojoConfigFilePath(project).path;

	return { tsconfigPath, project, includePath, rojoConfigPath };
}
