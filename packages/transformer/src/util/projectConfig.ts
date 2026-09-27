import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import ts from "typescript";
import { Logger } from "../classes/logger";
import { Cache } from "./cache";
import { coerceBySchema, loadEnv, substituteEnv, type Env } from "./env";
import { TRANSFORMER_PACKAGE } from "./packages";
import { getSchema, getSchemaErrors, validateSchema } from "./schema";
import type { TransformerConfig } from "../classes/transformState";

/** The file every Flamework package reads its options from, found from the tsconfig's directory up to the package root. */
export const PROJECT_CONFIG_NAME = "flamework.config.json";

/** The schema of that file, shipped at the root of the transformer package. */
export const PROJECT_CONFIG_SCHEMA_NAME = "flamework.config.schema.json";

/** The transformer's own section of the file: every transformer option. */
export type TransformerOptions = TransformerConfig;

/**
 * The transformer's entry in the tsconfig's `compilerOptions.plugins`. It says which transformer to
 * load and, optionally, where the config file is. Transformer options are not read from here.
 */
export interface TransformerEntry {
	/** The module the plugin loader loads: `@flamework-experimental/transformer`. */
	transform?: string;

	/**
	 * Where `flamework.config.json` is, relative to the tsconfig's directory. By default it is
	 * looked for in the tsconfig's directory and then in each parent up to the package root.
	 */
	configFile?: string;

	/** The plugin loader's own keys (see `LOADER_KEYS`), and anything else the build refuses. */
	[key: string]: unknown;
}

/**
 * Keys of the tsconfig entry that belong to the plugin loader rather than to Flamework, so they are
 * never refused. roblox-ts reads `transform`, `import`, `type`, `after` and `afterDeclarations`, and
 * hands the transformer the entry without the last three; ts-patch also reads `name`,
 * `transformProgram`, `isEsm`, `tsConfig` and `resolvePathAliases`.
 */
export const LOADER_KEYS: ReadonlySet<string> = new Set([
	"transform",
	"import",
	"type",
	"after",
	"afterDeclarations",
	"name",
	"transformProgram",
	"isEsm",
	"tsConfig",
	"resolvePathAliases",
]);

export interface CoreRuntimeConfig {
	/** Whether lifecycle events are wrapped in `debug.profilebegin`. Defaults to running in Studio. */
	profiling?: boolean;
}

export interface NetworkingRuntimeConfig {
	/**
	 * Serialises every event and function payload into a buffer with code generated at each
	 * `createServer`/`createClient` call site. Read by the transformer, since the codecs are compiled in.
	 */
	serialization?: boolean;
}

export interface ComponentsRuntimeConfig {
	/** Default `warningTimeout` for components that do not set one. */
	warningTimeout?: number;

	/** Default `streamingMode` for components that do not set one. */
	streamingMode?: "Disabled" | "Watching" | "Contextual";

	/** Default `watchRenames` for components that do not set one. */
	watchRenames?: boolean;
}

export interface ScopesRuntimeConfig {
	/**
	 * The scopes this build is compiled with. Usually `"${FLAMEWORK_SCOPES:-}"`, which the
	 * environment fills in and the loader splits on commas; `"*"` stands for every scope.
	 */
	active?: string[];
}

export interface TestingRuntimeConfig {
	/**
	 * Whether the plugin attaches the host at all. Unset, it follows the scope condition below, so
	 * this is an override for either direction.
	 */
	enabled?: boolean;

	/** Scopes under which tests are on: the host attaches when at least one is active. Default `["testing"]`. */
	activeIn?: readonly string[];

	/** Scopes under which tests stay off, whatever else is active. */
	inactiveIn?: readonly string[];

	/** Runs every test right after ignition, instead of only on request. */
	autoRun?: boolean;

	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout?: number;

	/**
	 * The source path of a ModuleScript exporting `ignite()`, for runs where nothing starts the
	 * game by itself. A string here; the artifact carries it resolved to a tree path.
	 */
	entry?: string;
}

/**
 * The sections the runtime packages read. Game projects get them written to
 * `include/flamework/config.json`, which the packages find by walking up from their own script.
 */
export interface RuntimeConfig {
	core?: CoreRuntimeConfig;
	networking?: NetworkingRuntimeConfig;
	components?: ComponentsRuntimeConfig;
	scopes?: ScopesRuntimeConfig;
	testing?: TestingRuntimeConfig;
}

/**
 * Where the `flamework-test` CLI (`@flamework-experimental/testing`) publishes the place and runs its tests. Read by
 * that CLI only: it is not a runtime section and never reaches the place.
 */
export interface CloudConfig {
	/** The experience the testing place is in; named so nothing confuses it with the original. */
	testingUniverseId?: string;
	/** The place tests are published to and run in. Never the original place. */
	testingPlaceId?: string;
	/** Usually `"${ROBLOX_API_KEY:-}"`, so that the key stays in the environment. */
	apiKey?: string;
	/** A copy of the original place the build is laid over before publishing, relative to the config file. */
	originalPlace?: string;
}

/** The whole `flamework.config.json`. */
export interface ProjectConfig extends RuntimeConfig {
	$schema?: string;
	transformer?: TransformerOptions;
	cloud?: CloudConfig;
}

export const RUNTIME_SECTIONS = ["core", "networking", "components", "scopes", "testing"] as const;

export interface LoadedProjectConfig {
	/** The effective transformer options: the file's `transformer` section, empty when there is none. */
	config: TransformerConfig;

	/** The whole file, or an empty object when there is none. */
	project: ProjectConfig;

	/** Where the file options came from, if a file was found. */
	configPath?: string;

	/**
	 * The environment the file was substituted from, and that `Flamework.env` reads: `.env` and
	 * `.env.local` next to the file (or next to the tsconfig when there is no file) with the process
	 * environment on top.
	 */
	env: Env;
}

/**
 * Locates `flamework.config.json`.
 *
 * With `configFile` set on the tsconfig entry, that path (relative to the tsconfig's directory) is
 * used and must exist. Otherwise the tsconfig's directory is searched first, then each parent up to
 * and including the package root, so a multi-place repository can keep one file at the root and
 * still override it per place.
 */
export function findProjectConfig(
	projectDirectory: string,
	rootDirectory: string,
	explicitPath?: string,
): string | undefined {
	if (explicitPath !== undefined) {
		const resolved = path.resolve(projectDirectory, explicitPath);
		if (!fs.existsSync(resolved)) {
			throw new Error(`The Flamework config file '${explicitPath}' does not exist (looked at '${resolved}').`);
		}

		return resolved;
	}

	const root = path.resolve(rootDirectory);
	let current = path.resolve(projectDirectory);

	while (true) {
		const candidate = path.join(current, PROJECT_CONFIG_NAME);
		if (fs.existsSync(candidate)) {
			return candidate;
		}

		if (path.relative(current, root) === "") {
			return;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return;
		}

		current = parent;
	}
}

/**
 * Reads and validates a `flamework.config.json`. Comments and trailing commas are allowed, as in tsconfig.
 *
 * Every string in the file can reference the environment as `${NAME}` or `${NAME:-fallback}`
 * (`$$` for a literal dollar). The environment is `.env` and `.env.local` next to the file with the
 * process environment on top, unless one is given. A string sitting where the schema expects a
 * boolean, a number or a list of strings is converted before validation, since a variable is
 * always a string.
 */
export function readProjectConfig(configPath: string, env: Env = loadEnv(path.dirname(configPath))): ProjectConfig {
	const text = fs.readFileSync(configPath, "utf8");
	// TypeScript asserts a forward-slash path when it attaches a diagnostic to the JSON source file.
	const { config: parsed, error } = ts.parseConfigFileTextToJson(configPath.replace(/\\/g, "/"), text);
	if (error) {
		throw new Error(`Failed to parse ${configPath}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
	}

	const describe = (pointer: string) => `${configPath}: '${pointer === "" ? "/" : pointer}'`;
	const config = coerceBySchema(substituteEnv(parsed, env, describe).value, getSchema("projectConfig"), describe);

	if (!validateSchema("projectConfig", config)) {
		const details = getSchemaErrors().map((v) => {
			const location = v.instancePath === "" ? "/" : v.instancePath;
			const extra = v.params && "additionalProperty" in v.params ? ` '${v.params.additionalProperty}'` : "";
			return `${location} ${v.message}${extra}`;
		});

		throw new Error(`Invalid ${configPath}:\n  ${details.join("\n  ")}`);
	}

	const projectConfig = { ...config } as ProjectConfig;
	delete projectConfig.$schema;

	return projectConfig;
}

/**
 * Refuses a tsconfig entry that sets anything but the plugin loader's keys and `configFile`.
 *
 * Transformer options are read from the config file only. v1 read them from the entry, so an
 * option left there from v1 (or written there by habit) would otherwise be dropped without a word:
 * a game that set `obfuscation` in both places built unobfuscated. `configPath` is the file the
 * options belong in, found or about to be looked for, and `exists` says which.
 */
export function assertTransformerEntry(entry: TransformerEntry, configPath: string, exists: boolean) {
	const optionKeys = Object.keys(
		(getSchema("projectConfig") as { properties: { transformer: { properties: object } } }).properties.transformer
			.properties,
	);

	const options = new Array<string>();
	const unknown = new Array<string>();
	for (const [key, value] of Object.entries(entry)) {
		if (value === undefined || key === "configFile" || LOADER_KEYS.has(key)) continue;
		(optionKeys.includes(key) ? options : unknown).push(`'${key}'`);
	}

	if (options.length === 0 && unknown.length === 0) return;

	const lines = [
		`The tsconfig entry for ${TRANSFORMER_PACKAGE} takes only "transform" and "configFile"; transformer options are read from ${PROJECT_CONFIG_NAME}.`,
	];
	if (options.length > 0) {
		const target = exists ? configPath : `${configPath}, a new file`;
		lines.push(`Move ${options.join(", ")} to the "transformer" section of ${target}.`);
	}
	if (unknown.length > 0) {
		lines.push(`Remove ${unknown.join(", ")}: not a transformer option.`);
	}

	throw new Error(lines.join("\n"));
}

/**
 * Finds the config file for a tsconfig entry, after checking the entry: its `configFile` if set,
 * else the nearest `flamework.config.json` from the tsconfig's directory up to the package root.
 */
function locateProjectConfig(projectDirectory: string, rootDirectory: string, entry: TransformerEntry) {
	if (entry.configFile !== undefined && typeof entry.configFile !== "string") {
		throw new Error(
			`"configFile" on the tsconfig entry for ${TRANSFORMER_PACKAGE} must be a path, relative to the tsconfig's directory.`,
		);
	}

	const configPath = findProjectConfig(projectDirectory, rootDirectory, entry.configFile);
	assertTransformerEntry(
		entry,
		configPath ?? path.join(projectDirectory, PROJECT_CONFIG_NAME),
		configPath !== undefined,
	);

	return configPath;
}

/**
 * The schema file of the transformer that is running, as the project reaches it: through the
 * nearest `node_modules/@flamework-experimental/transformer` from the tsconfig's directory up, the
 * way roblox-ts resolved the entry's `transform`. That path keeps working across upgrades, where
 * the real path of a linked install (bun, pnpm) names the version. Falls back to the real path when
 * no `node_modules` entry leads to this transformer.
 */
export function findInstalledSchema(projectDirectory: string) {
	const own = path.join(__dirname, "../..", PROJECT_CONFIG_SCHEMA_NAME);
	const ownReal = fs.realpathSync(own);

	let current = path.resolve(projectDirectory);
	while (true) {
		const candidate = path.join(current, "node_modules", TRANSFORMER_PACKAGE, PROJECT_CONFIG_SCHEMA_NAME);
		if (fs.existsSync(candidate) && fs.realpathSync(candidate) === ownReal) {
			return candidate;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return own;
		}

		current = parent;
	}
}

/**
 * The `$schema` value that points a config file at a schema file. Relative, with forward slashes,
 * and starting with `./` or `../`: VS Code's JSON service (vscode-json-languageservice) resolves a
 * value against the file unless it has a scheme, where a drive letter counts as one, and before
 * its 4.0 resolved only a value that starts with a dot. A schema on another drive gets a
 * `file://` URL.
 */
export function getSchemaReference(configPath: string, schemaPath: string) {
	const relative = path.relative(path.dirname(configPath), schemaPath);
	if (path.isAbsolute(relative)) {
		return pathToFileURL(schemaPath).href;
	}

	const reference = relative.replace(/\\/g, "/");
	return reference.startsWith("../") ? reference : `./${reference}`;
}

/**
 * Adds `"$schema": reference` as the first key of a config file's text, keeping every other byte:
 * the file's indentation, line endings, comments and trailing commas. Returns `undefined` when the
 * file already has a `$schema` (whatever it points at) or is not an object that parses, which the
 * config loader then reports.
 */
export function insertSchemaReference(text: string, reference: string): string | undefined {
	const parse = (source: string) => {
		const file = ts.parseJsonText(PROJECT_CONFIG_NAME, source);
		const statement = file.statements[0];
		const diagnostics = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
		if (diagnostics !== undefined && diagnostics.length > 0) return;
		if (statement === undefined || !ts.isObjectLiteralExpression(statement.expression)) return;

		return { file, root: statement.expression };
	};

	const parsed = parse(text);
	if (parsed === undefined) return;

	const { file, root } = parsed;
	const isSchema = (property: ts.ObjectLiteralElementLike) =>
		property.name !== undefined && ts.isStringLiteral(property.name) && property.name.text === "$schema";
	if (root.properties.some(isSchema)) return;

	const property = `"$schema": ${JSON.stringify(reference)}`;
	const open = root.getStart(file);
	const firstToken = root.properties.length > 0 ? root.properties[0].getStart(file) : root.end - 1;
	const lineBreak = text.slice(open, firstToken).search(/\r?\n/);

	let result: string;
	if (lineBreak === -1) {
		// Written on one line with its first key (or empty): `{ "$schema": "...", "a": 1 }`.
		const separator = root.properties.length > 0 ? "," : text[open + 1] === "}" ? " " : "";
		result = `${text.slice(0, open + 1)} ${property}${separator}${text.slice(open + 1)}`;
	} else {
		// One key per line: a line of its own above the first line with anything on it, indented like
		// it and ended like the brace's line. In an empty object that line is the closing brace.
		const breakAt = open + lineBreak;
		const newline = text[breakAt] === "\r" ? "\r\n" : "\n";
		let lineStart = breakAt + newline.length;
		for (;;) {
			const end = text.indexOf("\n", lineStart);
			if (end === -1 || text.slice(lineStart, end).trim() !== "") break;
			lineStart = end + 1;
		}

		let indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
		if (root.properties.length === 0) indent += "\t";

		const comma = root.properties.length > 0 ? "," : "";
		result = `${text.slice(0, lineStart)}${indent}${property}${comma}${newline}${text.slice(lineStart)}`;
	}

	// Never write a file the loader could no longer read.
	const check = parse(result);
	return check !== undefined && check.root.properties.some(isSchema) ? result : undefined;
}

/** What `addSchemaReference` did, when it did anything. */
export interface SchemaReferenceChange {
	change: "added" | "created";
	configPath: string;
}

/**
 * Gives a game's `flamework.config.json` a `$schema` line when it has none, so that an editor lists
 * every option with its description and default. A game without the file gets one holding just
 * that line, when its tsconfig is at the package root; a place below the root gets none, since the
 * new file would hide a shared one added above it later. Writing the defaults themselves would pin
 * them, and some follow other options.
 *
 * Only on the first compilation of a process: a watcher's rebuilds leave the file alone. Never for
 * a package (a scoped package name, which roblox-ts also builds as a package): a package has no
 * config file unless its author wrote one, and nothing is added to it. A `$schema` already in the
 * file stays, wherever it points. `project.schema` names the schema file to point at instead of
 * the installed transformer's.
 */
export function addSchemaReference(
	projectDirectory: string,
	rootDirectory: string,
	entry: TransformerEntry,
	project: { isGame: boolean; schema?: string },
): SchemaReferenceChange | undefined {
	if (!project.isGame || !Cache.isInitialCompile) return;

	const configPath = locateProjectConfig(projectDirectory, rootDirectory, entry);
	const schema = project.schema ?? findInstalledSchema(projectDirectory);

	if (configPath === undefined) {
		// Only where nothing above could be shadowed. Below the package root the new file would be the
		// first one found, and would hide a shared file added at the root later (guide 09's multi-place
		// layout), with every setting in it silently ignored.
		if (path.relative(path.resolve(projectDirectory), path.resolve(rootDirectory)) !== "") return;

		const created = path.join(projectDirectory, PROJECT_CONFIG_NAME);
		const reference = getSchemaReference(created, schema);
		if (!tryWriteConfig(created, `{\n\t"$schema": ${JSON.stringify(reference)}\n}\n`)) return;
		return { change: "created", configPath: created };
	}

	const text = fs.readFileSync(configPath, "utf8");
	const updated = insertSchemaReference(text, getSchemaReference(configPath, schema));
	if (updated === undefined || !tryWriteConfig(configPath, updated)) return;

	return { change: "added", configPath };
}

/** Writes the config file, or warns and carries on: the line is a convenience, never worth a failed build. */
function tryWriteConfig(file: string, text: string) {
	try {
		fs.writeFileSync(file, text);
		return true;
	} catch (error) {
		Logger.warn(`Could not write a "$schema" line to ${file}`, `${error instanceof Error ? error.message : error}`);
		return false;
	}
}

/**
 * The runtime sections of a project config, or `undefined` when it has none, so that a project
 * without any gets no `config.json` artifact.
 */
export function getRuntimeConfig(project: ProjectConfig): RuntimeConfig | undefined {
	const runtime: RuntimeConfig = {};
	let any = false;

	for (const section of RUNTIME_SECTIONS) {
		const value = project[section];
		if (value !== undefined) {
			runtime[section] = value as never;
			any = true;
		}
	}

	return any ? runtime : undefined;
}

/**
 * A fingerprint of everything a compilation takes from the config file and the environment: the
 * effective options, the whole file after substitution, and the environment itself, since
 * `Flamework.env` reads variables the file never mentions.
 *
 * A watcher reads all of this once, when it starts, and compares later reads against the first:
 * a change means files that do not recompile would disagree with files that do, so the first read
 * stays in force and the watcher says to restart.
 */
export function fingerprintProjectConfig(loaded: LoadedProjectConfig): string {
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map(stable);
		}

		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, stable((value as Record<string, unknown>)[key])]),
			);
		}

		return value;
	};

	const snapshot = { config: loaded.config, project: loaded.project, configPath: loaded.configPath, env: loaded.env };
	return crypto
		.createHash("sha1")
		.update(JSON.stringify(stable(snapshot)))
		.digest("hex");
}

/**
 * Resolves the project config, the effective transformer options and the environment for a
 * compilation. Raises when the tsconfig entry sets anything but the loader's keys and `configFile`.
 */
export function loadProjectConfig(
	projectDirectory: string,
	rootDirectory: string,
	entry: TransformerEntry,
	processEnv?: Env,
): LoadedProjectConfig {
	const configPath = locateProjectConfig(projectDirectory, rootDirectory, entry);
	const env = loadEnv(configPath !== undefined ? path.dirname(configPath) : projectDirectory, processEnv);

	if (configPath === undefined) {
		return { config: {}, project: {}, env };
	}

	const project = readProjectConfig(configPath, env);
	Logger.infoIfVerbose(`Loaded project config from ${path.relative(projectDirectory, configPath) || configPath}`);

	return { config: { ...project.transformer }, project, configPath, env };
}
