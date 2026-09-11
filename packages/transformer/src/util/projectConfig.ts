import crypto from "crypto";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { Logger } from "../classes/logger";
import { coerceBySchema, loadEnv, substituteEnv, type Env } from "./env";
import { getSchema, getSchemaErrors, validateSchema } from "./schema";
import type { TransformerConfig } from "../classes/transformState";

/** The file every Flamework package reads its options from, found from the tsconfig's directory up to the package root. */
export const PROJECT_CONFIG_NAME = "flamework.config.json";

/** The transformer's own section: every transformer option except the one that says where the file is. */
export type TransformerOptions = Omit<TransformerConfig, "configFile">;

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
}

export interface ScopesRuntimeConfig {
	/**
	 * The scopes this build is compiled with. Usually `"${FLAMEWORK_SCOPES:-}"`, which the
	 * environment fills in and the loader splits on commas; `"*"` stands for every scope.
	 */
	active?: string[];
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
}

/** The whole `flamework.config.json`. */
export interface ProjectConfig extends RuntimeConfig {
	$schema?: string;
	transformer?: TransformerOptions;
}

export const RUNTIME_SECTIONS = ["core", "networking", "components", "scopes"] as const;

export interface LoadedProjectConfig {
	/** The effective transformer options: the file's `transformer` section with inline tsconfig options on top. */
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
 * Combines the file's transformer section with the options set inline on the tsconfig entry.
 *
 * Inline options win: they are the more specific place to have written something. `optimizations`
 * merges one level deep so that an inline override of one optimisation keeps the file's others.
 */
export function mergeTransformerConfig(
	fileOptions: TransformerOptions | undefined,
	inlineConfig: TransformerConfig,
): TransformerConfig {
	const merged: Record<string, unknown> = { ...(fileOptions ?? {}) };

	for (const [key, value] of Object.entries(inlineConfig)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	if (fileOptions?.optimizations && inlineConfig.optimizations) {
		merged.optimizations = { ...fileOptions.optimizations, ...inlineConfig.optimizations };
	}

	return merged as TransformerConfig;
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
 * compilation.
 */
export function loadProjectConfig(
	projectDirectory: string,
	rootDirectory: string,
	inlineConfig: TransformerConfig,
	processEnv?: Env,
): LoadedProjectConfig {
	const configPath = findProjectConfig(projectDirectory, rootDirectory, inlineConfig.configFile);
	const env = loadEnv(configPath !== undefined ? path.dirname(configPath) : projectDirectory, processEnv);

	if (configPath === undefined) {
		return { config: mergeTransformerConfig(undefined, inlineConfig), project: {}, env };
	}

	const project = readProjectConfig(configPath, env);
	Logger.infoIfVerbose(`Loaded project config from ${path.relative(projectDirectory, configPath) || configPath}`);

	return { config: mergeTransformerConfig(project.transformer, inlineConfig), project, configPath, env };
}
