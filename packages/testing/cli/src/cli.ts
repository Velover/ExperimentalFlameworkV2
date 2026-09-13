#!/usr/bin/env bun
/**
 * flamework-test - runs a place's Flamework tests where the engine is real. First and by default on
 * this machine: it opens the place Rojo built in Roblox Studio, runs the tests in a play session on
 * both realms through Studio's MCP proxy, and closes it again. Second, when asked, in the cloud:
 * it publishes the build to a testing place and runs the server's tests through the Open Cloud
 * Luau Execution API. A copy of the original place can be patched with the build first either
 * way, so the tests see the assets only the original has.
 *
 * Everything is injectable (`CliDeps`) so `bun test` can drive the whole CLI without a network,
 * a file system, a Studio or a real API key.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
	API_BASE,
	createClient,
	createTaskUrl,
	OpenCloudError,
	parseDurationMs,
	redactHeaders,
	TaskTimeoutError,
	type FetchLike,
	type LuauTask,
	type OpenCloudClient,
	type VersionType,
} from "./openCloud.ts";
import { loadCloudSettings, type CloudSettings } from "./config.ts";
import { parseSections, renderFilter, renderOptions, renderShim, type Filter } from "./luau.ts";
import { defaultPatchedPath, patchCommand, planPatch, type RojoProject } from "./patch.ts";
import PATCH_TASK from "../tasks/patch-place.lune" with { type: "text" };
import PROBE_TASK from "../tasks/probe.lune" with { type: "text" };
import RUN_TESTS_TASK from "../tasks/run-tests.lune" with { type: "text" };
import { formatList, formatSummary, parseRunResult, ResultParseError } from "./results.ts";
import {
	connectStudio,
	findStudioExe,
	findStudio,
	findStudioForPlace,
	findStudioMcp,
	isPlaying,
	placeNameOf,
	renderStudioRun,
	studioOpenArguments,
	unquoteLuauResult,
	type DataModelType,
	type StudioClient,
	type StudioEntry,
} from "./studio.ts";

/** Where `cloud publish` records the version it made, for `cloud run` to pin. */
export const VERSION_FILE = "build/version.json";
export const DEFAULT_PROJECT = "default.project.json";
export const DEFAULT_TIMEOUT = "120s";
export const PROBE_TIMEOUT = "60s";
/** How long a Studio window is waited for after launching it. */
export const STUDIO_OPEN_TIMEOUT = "180s";
/** How long a play session is waited for once started. */
export const PLAY_START_TIMEOUT_MS = 90_000;
export const POLL_INTERVAL_MS = 2500;
/** How long past the task's own timeout we keep polling before giving up. */
export const QUEUE_SLACK_MS = 300_000;

// ---------------------------------------------------------------- arguments

type FlagKind = "string" | "boolean";

const FLAGS: Record<string, FlagKind> = {
	file: "string",
	published: "boolean",
	original: "string",
	project: "string",
	out: "string",
	version: "string",
	sections: "string",
	list: "boolean",
	timeout: "string",
	code: "string",
	script: "string",
	realm: "string",
	keep: "boolean",
	cloud: "boolean",
	"dry-run": "boolean",
	json: "boolean",
	"testing-universe": "string",
	"testing-place": "string",
	key: "string",
	studio: "string",
	help: "boolean",
};

const COMMON_FLAGS = ["testing-universe", "testing-place", "key", "help"];
/** `studio` commands may name their window; every other way of finding it is automatic. */
const STUDIO_FLAGS = ["studio"];
/** Commands that take a file as a positional argument as well as `--file`. */
const FILE_COMMANDS = ["test", "patch", "studio open", "cloud publish", "cloud test"];
const PATCH_FLAGS = ["original", "project"];
const PUBLISH_FLAGS = ["file", "published", ...PATCH_FLAGS];
const RUN_FLAGS = ["version", "sections", "list", "timeout", "code", "script", "dry-run", "json"];
const REPORT_FLAGS = ["sections", "list", "json", "timeout"];

const COMMANDS: Record<string, string[]> = {
	test: ["file", "realm", "keep", "cloud", ...PATCH_FLAGS, ...REPORT_FLAGS, "published"],
	patch: ["file", "out", ...PATCH_FLAGS],
	"studio open": ["file", "timeout"],
	"studio close": STUDIO_FLAGS,
	"studio status": STUDIO_FLAGS,
	"studio play": STUDIO_FLAGS,
	"studio stop": STUDIO_FLAGS,
	"studio exec": ["code", "script", "realm", "timeout", ...STUDIO_FLAGS],
	"studio run": ["realm", "keep", ...REPORT_FLAGS, ...STUDIO_FLAGS],
	"cloud publish": PUBLISH_FLAGS,
	"cloud run": RUN_FLAGS,
	"cloud test": [...PUBLISH_FLAGS, ...RUN_FLAGS],
	"cloud probe": ["version", "timeout", "json", "dry-run"],
	help: [],
};

const GROUPS: Record<string, string> = {
	studio: "open, close, status, play, stop, exec, run",
	cloud: "publish, run, test, probe",
};

export interface Flags {
	file?: string;
	published?: boolean;
	original?: string;
	project?: string;
	out?: string;
	version?: string;
	sections?: string;
	list?: boolean;
	timeout?: string;
	code?: string;
	script?: string;
	realm?: string;
	keep?: boolean;
	cloud?: boolean;
	"dry-run"?: boolean;
	json?: boolean;
	"testing-universe"?: string;
	"testing-place"?: string;
	key?: string;
	studio?: string;
	help?: boolean;
}

export class UsageError extends Error {}
/** An expected failure: printed without a stack, exits 1. */
export class CliError extends Error {
	readonly hint: string | undefined;
	constructor(message: string, hint?: string) {
		super(message);
		this.hint = hint;
	}
}

export interface ParsedArgs {
	/** `"test"`, or a two-word one such as `"studio run"` or `"cloud publish"`. */
	command?: string;
	flags: Flags;
}

/**
 * Flags may appear before or after the command. `studio` and `cloud` commands are two words;
 * `test`, `patch`, `studio open`, `cloud publish` and `cloud test` accept a file as the next
 * positional, the same as `--file`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags: Flags = {};
	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;

		if (arg === "-h" || arg === "--help") {
			flags.help = true;
			continue;
		}

		if (arg.startsWith("--")) {
			let name = arg.slice(2);
			let value: string | undefined;
			const eq = name.indexOf("=");
			if (eq !== -1) {
				value = name.slice(eq + 1);
				name = name.slice(0, eq);
			}

			const kind = FLAGS[name];
			if (kind === undefined) throw new UsageError(`unknown flag: --${name}`);

			if (kind === "boolean") {
				if (value !== undefined && value !== "true" && value !== "false") {
					throw new UsageError(`--${name} does not take a value`);
				}
				(flags as Record<string, unknown>)[name] = value !== "false";
			} else {
				if (value === undefined) {
					const next = argv[i + 1];
					if (next === undefined) {
						throw new UsageError(`--${name} needs a value`);
					}
					value = next;
					i += 1;
				}
				(flags as Record<string, unknown>)[name] = value;
			}
			continue;
		}

		if (arg.startsWith("-") && arg.length > 1) {
			throw new UsageError(`unknown flag: ${arg}`);
		}

		positionals.push(arg);
	}

	let command = positionals.shift();
	if (command !== undefined && GROUPS[command] !== undefined) {
		const sub = positionals.shift();
		if (sub === undefined) {
			throw new UsageError(`${command} needs a subcommand: ${GROUPS[command]}`);
		}
		command = `${command} ${sub}`;
	}

	if (command !== undefined) {
		const allowed = COMMANDS[command];
		if (allowed === undefined) {
			throw new UsageError(`unknown command: ${command}`);
		}
		for (const name of Object.keys(flags)) {
			if (!allowed.includes(name) && !COMMON_FLAGS.includes(name)) {
				throw new UsageError(`--${name} is not a flag of "${command}"`);
			}
		}

		const [file, ...extra] = positionals;
		if (file !== undefined) {
			if (!FILE_COMMANDS.includes(command)) {
				throw new UsageError(`unexpected argument: ${file}`);
			}
			if (extra.length > 0) {
				throw new UsageError(`unexpected argument: ${extra[0]}`);
			}
			if (flags.file !== undefined) {
				throw new UsageError(`the file was given twice: "${file}" and --file ${flags.file}`);
			}
			flags.file = file;
		}
	}

	return { command, flags };
}

const USAGE = `flamework-test - run Flamework tests inside a real place: Roblox Studio on this machine by
default, or a testing place in the cloud

Usage:
  flamework-test <command> [file] [flags]     (flags may come before the command)

  test <file>     open the place Rojo built in Roblox Studio, run the tests in a play session on
                  the server and the client, report, and close it again
  patch <file>    lay the build over a copy of the original place and write the result

Studio (needs "MCP server" enabled in Studio's Assistant settings):
  studio open [file]  open the testing place from the cloud, or a local place file, in Studio
  studio close        close the Studio window that has the testing place open
  studio status       what that window reports: edit or play, which data models exist
  studio play         start a play session in it;  studio stop  ends one
  studio exec         run Luau in it:  --code "<luau>" | --script <file>  [--realm edit|server|client]
  studio run          run the tests in it, in a play session, without opening or closing anything

Cloud (a testing place and an Open Cloud key; the server's tests only):
  cloud publish <file>  upload the place Rojo built to the testing place as a new version
  cloud run             run the tests in that version through Open Cloud and report the results
  cloud test <file>     publish the file, then run  (the same as: test <file> --cloud)
  cloud probe           report what the execution sandbox looks like from the inside

Flags:
  test       --realm server|client|both  which realm's tests; default both
             --keep                  leave Studio and the play session open afterwards
             --cloud                 run in the cloud instead of Studio
             --original <place.rbxl> patch a copy of this place with the build first, and run that
                                     (needs lune; default: $ORIGINAL_PLACE, cloud.originalPlace)
             --project <path>        the Rojo project the patch follows; default ${DEFAULT_PROJECT}
             --sections <a,b>        only these sections ("economy", "economy/buys")
             --list                  list the tests instead of running them
             --json                  print the raw result JSON instead of a summary
             --timeout <120s>        per run
  patch      --out <path>            where the patched place goes; default <file>.patched.rbxl
  studio run --realm server|client|both   default server
             --keep                  leave the play session running afterwards
             --sections, --list, --json, --timeout   as for test
  studio exec --realm edit|server|client  default edit
  studio *   --studio <name|id>      which window; default: the one with the testing place open,
                                     else the only one with a local place file open
  cloud publish --published          publish live instead of uploading a Saved version
             --original, --project   as for test
  cloud run  --version <n>           default: ${VERSION_FILE}, else the current version
             --code "<luau>"         run this Luau instead of the test shim
             --script <file>         run this Luau file instead of the test shim
             --dry-run               print the request that would be sent, then stop
             --sections, --list, --json, --timeout   as for test (timeout: the task's, max 300s)
  common     --testing-universe <id> default: $TESTING_UNIVERSE_ID, else cloud.testingUniverseId
             --testing-place <id>    default: $TESTING_PLACE_ID, else cloud.testingPlaceId
             --key <apiKey>          default: $ROBLOX_API_KEY, else cloud.apiKey; prefer the
                                     environment, a flag lands in the shell history
             -h, --help

Settings come from flags, then the shell environment, then .env and .env.local next to the
nearest flamework.config.json, then that file's "cloud" section, which may itself use \${NAME}:
  "cloud": { "testingUniverseId": "...", "testingPlaceId": "...", "apiKey": "\${ROBLOX_API_KEY:-}",
             "originalPlace": "places/original.rbxl" }
A cloud run also needs "testing": { "entry": "src/server/main" }, the ModuleScript that ignites
the game: a cloud task runs none of the place's Scripts, so the runner has to. Studio needs nothing.

Environment (the shell, .env or .env.local):
  ROBLOX_API_KEY                          Open Cloud key: universe-places:write and
  (or TESTING_PLACE_API_KEY)              universe.place.luau-execution-session:read/:write
  TESTING_UNIVERSE_ID, TESTING_PLACE_ID   the testing experience and the place inside it
  ORIGINAL_PLACE                          a copy of the original place, for --original
  LUNE_EXE, ROBLOX_STUDIO_EXE, STUDIO_MCP_EXE   overrides for the tools this finds by itself

Examples:
  rojo build -o place.rbxl && flamework-test test place.rbxl
  rojo build -o place.rbxl && flamework-test test place.rbxl --sections economy --keep
  rojo build -o place.rbxl && flamework-test test place.rbxl --cloud
  flamework-test cloud run --sections economy       again, against the version last published
  flamework-test studio open && flamework-test studio run --realm client

Exit codes: 0 success, 1 failure, 2 bad usage.`;

// ------------------------------------------------------------------- deps

export interface CliDeps {
	fetch?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	readFile?: (path: string) => Promise<ArrayBuffer>;
	readTextFile?: (path: string) => Promise<string>;
	writeTextFile?: (path: string, text: string) => Promise<void>;
	exists?: (path: string) => Promise<boolean>;
	/** Runs a child process with inherited output; resolves with its exit code, or throws when it cannot start. */
	spawn?: (command: string[], cwd: string) => Promise<number>;
	/** Starts a program and returns at once, leaving it running. */
	launch?: (command: string[]) => Promise<void>;
	/** Closes the window whose title ends with the suffix; what it did, or nothing found. */
	closeWindow?: (titleSuffix: string) => Promise<"closed" | "forced" | "none">;
	/** Connects to Studio's MCP proxy. */
	connectStudio?: () => Promise<StudioClient>;
	/** Where Roblox Studio is; `undefined` when it cannot be found. */
	studioExe?: () => string | undefined;
	log?: (message: string) => void;
	error?: (message: string) => void;
	env?: Record<string, string | undefined>;
	cwd?: string;
	now?: () => Date;
	/** Reads the `cloud` section of the nearest flamework.config.json. */
	loadSettings?: (cwd: string, env: Record<string, string | undefined>) => CloudSettings;
}

interface Io extends Required<Omit<CliDeps, "fetch">> {
	fetch: FetchLike | undefined;
}

/**
 * A PowerShell one-liner that closes a window by the end of its title, politely first. The end,
 * because a local file's window is titled with the file's full path while the proxy lists only
 * its name; a cloud place's title is the place name alone, which the same pattern matches.
 */
function closeWindowScript(titleSuffix: string): string {
	const escaped = titleSuffix.replaceAll("'", "''");
	return [
		`$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${escaped}' } | Select-Object -First 1`,
		"if (-not $p) { 'none'; exit 0 }",
		"$null = $p.CloseMainWindow()",
		"for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh(); if ($p.HasExited) { 'closed'; exit 0 } }",
		"Stop-Process -Id $p.Id -Force; 'forced'",
	].join("; ");
}

function resolveDeps(deps: CliDeps): Io {
	const env = deps.env ?? (process.env as Record<string, string | undefined>);
	return {
		fetch: deps.fetch,
		sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
		readFile: deps.readFile ?? ((path) => Bun.file(path).arrayBuffer()),
		readTextFile: deps.readTextFile ?? ((path) => Bun.file(path).text()),
		writeTextFile:
			deps.writeTextFile ??
			(async (path, text) => {
				await mkdir(dirname(path), { recursive: true });
				await Bun.write(path, text);
			}),
		exists: deps.exists ?? ((path) => Bun.file(path).exists()),
		spawn:
			deps.spawn ??
			(async (command, cwd) => {
				const child = Bun.spawn({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" });
				return await child.exited;
			}),
		launch:
			deps.launch ??
			(async ([exe, ...args]) => {
				// Detached, or Windows takes Studio down with this process when it exits.
				spawn(exe!, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
			}),
		closeWindow:
			deps.closeWindow ??
			(async (titleSuffix) => {
				const result = spawnSync("powershell", ["-NoProfile", "-Command", closeWindowScript(titleSuffix)], {
					encoding: "utf8",
				});
				const answer = (result.stdout ?? "").trim();
				return answer === "closed" || answer === "forced" ? answer : "none";
			}),
		connectStudio:
			deps.connectStudio ??
			(async () => {
				const exe = findStudioMcp(env);
				if (exe === undefined) {
					throw new CliError(
						"StudioMCP.exe was not found under Roblox Studio's versions folder",
						"is Roblox Studio installed on this machine? Set STUDIO_MCP_EXE to point at it otherwise, or run in the cloud: flamework-test test <file> --cloud",
					);
				}
				return await connectStudio(exe);
			}),
		studioExe: deps.studioExe ?? (() => findStudioExe(env)),
		log: deps.log ?? ((message) => console.log(message)),
		error: deps.error ?? ((message) => console.error(message)),
		env,
		cwd: deps.cwd ?? process.cwd(),
		now: deps.now ?? (() => new Date()),
		loadSettings: deps.loadSettings ?? loadCloudSettings,
	};
}

/** The config file's settings, read once per invocation. */
const settingsCache = new WeakMap<Io, CloudSettings>();
function settingsOf(io: Io): CloudSettings {
	let settings = settingsCache.get(io);
	if (settings === undefined) {
		settings = io.loadSettings(io.cwd, io.env);
		settingsCache.set(io, settings);
	}
	return settings;
}

/** A variable from the shell, else from `.env` / `.env.local` next to the config file. */
function envOf(io: Io, name: string): string | undefined {
	return io.env[name] ?? settingsOf(io).env[name];
}

function makeClient(flags: Flags, io: Io): OpenCloudClient {
	const apiKey =
		flags.key ?? envOf(io, "ROBLOX_API_KEY") ?? envOf(io, "TESTING_PLACE_API_KEY") ?? settingsOf(io).apiKey ?? "";
	if (!apiKey) {
		throw new CliError(
			"no Open Cloud API key",
			"put ROBLOX_API_KEY in .env.local next to flamework.config.json (never in a committed file), or pass --key",
		);
	}
	const { universeId, placeId } = resolveIds(flags, io);
	return createClient({
		apiKey,
		universeId,
		placeId,
		...(io.fetch ? { fetch: io.fetch } : {}),
		sleep: io.sleep,
		readFile: io.readFile,
	});
}

/** The testing place: never the original, which is why every name here says so. */
function resolveIds(flags: Flags, io: Io): { universeId: string; placeId: string } {
	const settings = settingsOf(io);
	const universeId = flags["testing-universe"] ?? envOf(io, "TESTING_UNIVERSE_ID") ?? settings.testingUniverseId;
	const placeId = flags["testing-place"] ?? envOf(io, "TESTING_PLACE_ID") ?? settings.testingPlaceId;
	if (universeId === undefined || placeId === undefined) {
		throw new CliError(
			"no testing universe and place to use",
			'put TESTING_UNIVERSE_ID and TESTING_PLACE_ID in .env, give flamework.config.json a "cloud" section with "testingUniverseId" and "testingPlaceId", or pass --testing-universe and --testing-place',
		);
	}
	if (universeId === placeId) {
		io.error(
			`warning: the testing universe and place ids are both ${placeId} - the universe id is the one in the dashboard URL, the place id the one in the game URL`,
		);
	}
	return { universeId, placeId };
}

// ----------------------------------------------------------------- patching

/** The place file a command was given, which Rojo built; the CLI does not wrap `rojo build`. */
function placeFileOf(flags: Flags, command: string): string {
	if (flags.file === undefined) {
		throw new UsageError(
			`${command} needs the place Rojo built: rojo build -o place.rbxl && flamework-test ${command} place.rbxl`,
		);
	}
	return flags.file;
}

/** The original place to patch, when one was named anywhere; an empty name is none, so `ORIGINAL_PLACE=` turns it off. */
function originalPlaceOf(flags: Flags, io: Io): string | undefined {
	const named = flags.original ?? envOf(io, "ORIGINAL_PLACE");
	if (named !== undefined) return named === "" ? undefined : resolve(io.cwd, named);
	return settingsOf(io).originalPlace;
}

/** `lune`, or `LUNE_EXE`; checked before anything is opened or uploaded, since the patch cannot run without it. */
async function requireLune(io: Io): Promise<string> {
	const exe = envOf(io, "LUNE_EXE") ?? "lune";
	let code: number;
	try {
		code = await io.spawn([exe, "--version"], io.cwd);
	} catch {
		code = -1;
	}
	if (code !== 0) {
		throw new CliError(
			"lune is needed to patch the original place, and it was not found",
			"install it (rokit or aftman: `lune`), or set LUNE_EXE; nothing was run or uploaded",
		);
	}
	return exe;
}

/** Lays the build over a copy of the original and returns the patched file's path. */
async function patchPlace(built: string, original: string, flags: Flags, io: Io): Promise<string> {
	const lune = await requireLune(io);

	const builtPath = resolve(io.cwd, built);
	if (!(await io.exists(builtPath))) {
		throw new CliError(`${built} does not exist`, `build it first: rojo build -o ${built}`);
	}
	if (!(await io.exists(original))) {
		throw new CliError(
			`the original place ${original} does not exist`,
			"save a copy of the original place from Studio (File > Save to File) and point --original or cloud.originalPlace at it",
		);
	}

	const projectPath = resolve(io.cwd, flags.project ?? envOf(io, "PROJECT") ?? DEFAULT_PROJECT);
	if (!(await io.exists(projectPath))) {
		throw new CliError(
			`the Rojo project ${projectPath} does not exist`,
			"the patch follows the project file to know what the build replaces; pass --project",
		);
	}

	let project: RojoProject;
	try {
		project = JSON.parse(await io.readTextFile(projectPath)) as RojoProject;
	} catch (error) {
		throw new CliError(
			`${projectPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof project.tree !== "object" || project.tree === null) {
		throw new CliError(`${projectPath} has no "tree"`);
	}

	const out = resolve(io.cwd, flags.out ?? defaultPatchedPath(built));
	const planPath = resolve(io.cwd, "build", "patch-plan.json");
	const plan = planPatch(project);
	await io.writeTextFile(planPath, JSON.stringify(plan));

	// Lune runs a file, so the task ships as text and is written out beside the plan.
	const taskPath = resolve(io.cwd, "build", "patch-place.luau");
	await io.writeTextFile(taskPath, PATCH_TASK);

	io.log(`patching a copy of ${original} with ${built}, following ${projectPath}`);
	const code = await io.spawn(
		patchCommand(lune, taskPath, { original, built: builtPath, out, plan: planPath }),
		io.cwd,
	);
	if (code !== 0) {
		throw new CliError(`the patch failed (lune exited ${code})`, "nothing was run or uploaded");
	}

	io.log(`wrote ${out}`);
	return out;
}

/**
 * The place to run or upload: the build, or the build laid over the original when one is named.
 * `label` is how it is spoken of: the name the build was given, or the patched file's path.
 */
async function placeToRun(flags: Flags, io: Io, command: string): Promise<{ absolute: string; label: string }> {
	const built = placeFileOf(flags, command);
	const original = originalPlaceOf(flags, io);
	if (original !== undefined) {
		const patched = await patchPlace(built, original, flags, io);
		return { absolute: patched, label: patched };
	}

	const absolute = resolve(io.cwd, built);
	if (!(await io.exists(absolute))) {
		throw new CliError(`${built} does not exist`, `build it first: rojo build -o ${built}`);
	}
	return { absolute, label: built };
}

async function cmdPatch(flags: Flags, io: Io): Promise<number> {
	const built = placeFileOf(flags, "patch");
	const original = originalPlaceOf(flags, io);
	if (original === undefined) {
		throw new UsageError(
			"patch needs the original place: --original <place.rbxl>, ORIGINAL_PLACE, or cloud.originalPlace",
		);
	}
	await patchPlace(built, original, flags, io);
	return 0;
}

// ------------------------------------------------------------------- cloud

async function cmdPublish(flags: Flags, io: Io): Promise<number> {
	const { absolute, label: file } = await placeToRun(flags, io, "cloud publish");

	const versionType: VersionType = flags.published ? "Published" : "Saved";
	const client = makeClient(flags, io);
	io.log(`publishing ${file} to the testing place ${client.placeId} as ${versionType}...`);

	const versionNumber = await client.publishPlace(absolute, { versionType });
	io.log(`published version ${versionNumber} (${versionType})`);

	const record = {
		versionNumber,
		file,
		at: io.now().toISOString(),
	};
	await io.writeTextFile(resolve(io.cwd, VERSION_FILE), `${JSON.stringify(record, null, 2)}\n`);
	io.log(`wrote ${VERSION_FILE}`);
	return 0;
}

interface VersionChoice {
	version: number | undefined;
	source: string;
}

async function resolveVersion(flags: Flags, io: Io, useVersionFile: boolean): Promise<VersionChoice> {
	if (flags.version !== undefined) {
		const parsed = Number(flags.version);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new UsageError(`--version must be a positive integer, got "${flags.version}"`);
		}
		return { version: parsed, source: "--version" };
	}

	if (useVersionFile) {
		const path = resolve(io.cwd, VERSION_FILE);
		if (await io.exists(path)) {
			try {
				const record = JSON.parse(await io.readTextFile(path)) as {
					versionNumber?: number;
				};
				if (typeof record.versionNumber === "number") {
					return { version: record.versionNumber, source: VERSION_FILE };
				}
			} catch {
				io.error(`warning: ${VERSION_FILE} is not readable JSON, ignoring it`);
			}
		}
	}

	return { version: undefined, source: "the place's current version" };
}

type ScriptKind = "shim" | "raw" | "probe";

async function buildScript(
	flags: Flags,
	io: Io,
	kind: "run" | "probe",
): Promise<{ script: string; scriptKind: ScriptKind; label: string }> {
	if (kind === "probe") {
		return {
			script: PROBE_TASK,
			scriptKind: "probe",
			label: "the probe",
		};
	}

	const raw = await rawScript(flags, io);
	if (raw !== undefined) return { ...raw, scriptKind: "raw" };

	requireCloudEntry(io);

	const filter: Filter = parseSections(flags.sections);
	const script = renderShim(RUN_TESTS_TASK, filter, { list: flags.list === true });
	return { script, scriptKind: "shim", label: "the test shim" };
}

/**
 * A cloud task runs none of the place's Scripts, so the shim has to ignite the game itself, from
 * the ModuleScript `testing.entry` names. Checked here, before anything is published: the task
 * would only fail after the upload. Only a project whose config file was found can be checked;
 * ids given by the environment alone say nothing about the place.
 */
function requireCloudEntry(io: Io): void {
	const settings = settingsOf(io);
	if (settings.configPath === undefined || settings.testingEntry !== undefined) return;

	throw new CliError(
		`a cloud run needs "testing": { "entry": "src/server/main" } in ${settings.configPath}`,
		"a Luau execution task runs none of the place's Scripts, so the runner requires that ModuleScript and calls its ignite(); Studio needs no entry, the place runs itself: flamework-test test <file>",
	);
}

/** `--code` or `--script`, when either was given. */
async function rawScript(flags: Flags, io: Io): Promise<{ script: string; label: string } | undefined> {
	if (flags.code !== undefined && flags.script !== undefined) {
		throw new UsageError("--code and --script are mutually exclusive");
	}
	if (flags.code !== undefined) {
		return { script: flags.code, label: "--code" };
	}
	if (flags.script !== undefined) {
		const path = resolve(io.cwd, flags.script);
		if (!(await io.exists(path))) {
			throw new CliError(`${flags.script} does not exist`);
		}
		return { script: await io.readTextFile(path), label: flags.script };
	}
	return undefined;
}

async function cmdRun(flags: Flags, io: Io, kind: "run" | "probe" = "run"): Promise<number> {
	const { script, scriptKind, label } = await buildScript(flags, io, kind);
	const { version, source } = await resolveVersion(flags, io, kind === "run" && flags.version === undefined);
	const timeout = flags.timeout ?? (kind === "probe" ? PROBE_TIMEOUT : DEFAULT_TIMEOUT);

	if (flags["dry-run"]) {
		printDryRun(flags, io, { script, label, version, source, timeout });
		return 0;
	}

	const client = makeClient(flags, io);
	io.log(
		`running ${label} against ${version === undefined ? "the current version" : `version ${version}`} (${source}), timeout ${timeout}`,
	);

	const created = await client.createTask(script, { version, timeout });
	io.log(`task ${created.path}`);

	let lastState = "";
	const task = await client.waitForTask(created.path, {
		intervalMs: POLL_INTERVAL_MS,
		// the server's own timeout plus room for a long queue
		deadlineMs: parseDurationMs(timeout, 120_000) + QUEUE_SLACK_MS,
		onPoll: (polled) => {
			if (polled.state !== lastState) {
				lastState = polled.state;
				io.log(`  ${polled.state}`);
			}
		},
	});

	const lines = await client.getLogs(created.path);
	for (const line of lines) io.log(`  [place] ${line}`);

	if (task.state !== "COMPLETE") {
		printTaskFailure(task, io);
		return 1;
	}

	const results = task.output?.results ?? [];
	if (scriptKind === "raw") {
		io.log(`results (${results.length}):`);
		results.forEach((result, index) => io.log(`  [${index}] ${result}`));
		return 0;
	}

	if (scriptKind === "probe") {
		return printProbe(results[0], flags, io);
	}

	return printRunResult(results, flags, io);
}

function printTaskFailure(task: LuauTask, io: Io): void {
	io.error("");
	io.error(`task ${task.state}`);
	io.error(`  code:    ${task.error?.code ?? "<none>"}`);
	io.error(`  message: ${task.error?.message ?? "<none>"}`);
}

function printRunResult(results: string[], flags: Flags, io: Io): number {
	let result;
	try {
		result = parseRunResult(results);
	} catch (error) {
		if (error instanceof ResultParseError) {
			io.error(error.message);
			io.error(
				"the shim returns whatever @flamework-experimental/testing's cloud runner returns; it must be a JSON string",
			);
			return 1;
		}
		throw error;
	}

	if (flags.json) {
		io.log(JSON.stringify(JSON.parse(results[0]!), null, 2));
	} else {
		io.log("");
		for (const line of flags.list ? formatList(result) : formatSummary(result)) {
			io.log(line);
		}
	}

	return result.ok ? 0 : 1;
}

function printProbe(raw: string | undefined, flags: Flags, io: Io): number {
	if (raw === undefined) {
		io.error("the probe returned nothing");
		return 1;
	}
	let decoded: Record<string, unknown>;
	try {
		decoded = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		io.error(`the probe result was not JSON: ${raw}`);
		return 1;
	}

	if (flags.json) {
		io.log(JSON.stringify(decoded, null, 2));
		return 0;
	}

	io.log("");
	const width = Math.max(...Object.keys(decoded).map((key) => key.length));
	for (const [key, value] of Object.entries(decoded)) {
		io.log(`  ${key.padEnd(width)}  ${JSON.stringify(value)}`);
	}
	return 0;
}

function printDryRun(
	flags: Flags,
	io: Io,
	info: {
		script: string;
		label: string;
		version: number | undefined;
		source: string;
		timeout: string;
	},
): void {
	const { universeId, placeId } = resolveIds(flags, io);
	const url = createTaskUrl(API_BASE, universeId, placeId, info.version);
	const headers = redactHeaders({
		"x-api-key": "never printed",
		"Content-Type": "application/json",
	});

	io.log(`POST ${url}`);
	for (const [key, value] of Object.entries(headers)) {
		io.log(`  ${key}: ${value}`);
	}
	io.log(`  version: ${info.version ?? "current"} (${info.source})`);
	io.log(`  timeout: ${info.timeout}`);
	io.log(`  script:  ${info.label} (${info.script.split("\n").length} lines)`);
	io.log("--- script ---");
	io.log(info.script.replace(/\n$/, ""));
	io.log("--- end script ---");
}

async function cmdCloudTest(flags: Flags, io: Io): Promise<number> {
	placeFileOf(flags, "cloud test");
	requireCloudEntry(io);
	const published = await cmdPublish(flags, io);
	if (published !== 0) return published;
	return await cmdRun(flags, io, "run");
}

// ------------------------------------------------------------------ studio

/** The connected proxy and the window with the testing place open; refuses clearly when there is none. */
async function withStudio<T>(
	flags: Flags,
	io: Io,
	body: (client: StudioClient, studio: StudioEntry) => Promise<T>,
): Promise<T> {
	const { placeId } = resolveIds(flags, io);
	const client = await io.connectStudio();
	try {
		const studios = await client.studios();
		const studio = findStudio(studios, placeId, flags.studio);
		if (studio === undefined) {
			const listed = studios.map((entry) => entry.name).join(", ");
			throw new CliError(
				flags.studio !== undefined
					? `no Studio window is named "${flags.studio}"; listed: ${listed || "none"}`
					: `no Studio window has the testing place ${placeId} open${listed ? `; listed: ${listed}` : ""}`,
				'open it with `flamework-test studio open`, and check that "MCP server" is enabled in Studio\'s Assistant settings; a window that has it disabled is not listed',
			);
		}
		return await body(client, studio);
	} finally {
		client.close();
	}
}

function dataModelOf(realm: string | undefined, fallback: DataModelType): DataModelType {
	if (realm === undefined) return fallback;
	const map: Record<string, DataModelType> = { edit: "Edit", server: "Server", client: "Client" };
	const mapped = map[realm.toLowerCase()];
	if (mapped === undefined) {
		throw new UsageError(`--realm must be edit, server or client, got "${realm}"`);
	}
	return mapped;
}

/** The realms a run covers: `server`, `client`, or `both`, in the order they run. */
function realmsOf(realm: string | undefined, fallback: "server" | "both"): Array<"Server" | "Client"> {
	const chosen = (realm ?? fallback).toLowerCase();
	if (chosen === "both") return ["Server", "Client"];
	if (chosen === "server") return ["Server"];
	if (chosen === "client") return ["Client"];
	throw new UsageError(`--realm must be server, client or both, got "${realm}"`);
}

/** Where Roblox Studio is, or a clear refusal with the cloud as the way out. */
function requireStudioExe(io: Io): string {
	const exe = io.studioExe();
	if (exe === undefined) {
		throw new CliError(
			"RobloxStudioBeta.exe was not found under Roblox Studio's versions folder",
			"is Roblox Studio installed on this machine? Set ROBLOX_STUDIO_EXE to point at it otherwise, or run in the cloud: flamework-test test <file> --cloud",
		);
	}
	return exe;
}

/** Polls the proxy until a window matches, or the deadline passes. */
async function waitForStudio(
	client: StudioClient,
	find: (studios: StudioEntry[]) => StudioEntry | undefined,
	flags: Flags,
	io: Io,
): Promise<StudioEntry | undefined> {
	const deadline = io.now().getTime() + parseDurationMs(flags.timeout ?? STUDIO_OPEN_TIMEOUT, 180_000);
	while (io.now().getTime() < deadline) {
		const studio = find(await client.studios());
		if (studio !== undefined) return studio;
		await io.sleep(5000);
	}
	return undefined;
}

function neverConnected(what: string): CliError {
	return new CliError(
		`Studio started but ${what} never showed up on the MCP proxy`,
		'the window is open; if it stays unlisted, enable "MCP server" in Studio\'s Assistant settings and run `flamework-test studio status` again',
	);
}

async function cmdStudioOpen(flags: Flags, io: Io): Promise<number> {
	const exe = requireStudioExe(io);

	let find: (studios: StudioEntry[]) => StudioEntry | undefined;
	let what: string;
	if (flags.file !== undefined) {
		const file = resolve(io.cwd, flags.file);
		if (!(await io.exists(file))) {
			throw new CliError(`${flags.file} does not exist`);
		}
		await io.launch([exe, ...studioOpenArguments({ file })]);
		// A local file's window is listed by its file name, with no place id.
		const name = basename(file);
		find = (studios) => findStudio(studios, undefined, name);
		what = flags.file;
	} else {
		const { universeId, placeId } = resolveIds(flags, io);
		await io.launch([exe, ...studioOpenArguments({ placeId, universeId })]);
		find = (studios) => findStudioForPlace(studios, placeId);
		what = `the testing place ${placeId}`;
	}
	io.log(`opening ${what} in Studio; waiting for it to connect...`);

	const client = await io.connectStudio();
	try {
		const studio = await waitForStudio(client, find, flags, io);
		if (studio === undefined) throw neverConnected(what);
		io.log(`connected: ${studio.name} (${studio.id})`);
		return 0;
	} finally {
		client.close();
	}
}

/** Closes a window by the name the proxy lists it under; what happened, for the log. */
async function closeStudioWindow(name: string, io: Io): Promise<void> {
	const outcome = await io.closeWindow(`${name} - Roblox Studio`);
	if (outcome === "none") {
		throw new CliError(`no window titled "${name} - Roblox Studio" was found to close`);
	}
	io.log(
		outcome === "closed"
			? `closed ${name}`
			: `closed ${name}, which asked before going (a save prompt, usually; nothing a run makes is kept)`,
	);
}

async function cmdStudioClose(flags: Flags, io: Io): Promise<number> {
	return await withStudio(flags, io, async (_client, studio) => {
		await closeStudioWindow(placeNameOf(studio.name), io);
		return 0;
	});
}

async function cmdStudioStatus(flags: Flags, io: Io): Promise<number> {
	return await withStudio(flags, io, async (client, studio) => {
		io.log(`${studio.name} (${studio.id})`);
		const state = await client.call("get_studio_state", { studio_id: studio.id }, 30_000);
		for (const line of state.split("\n")) io.log(`  ${line}`);
		return 0;
	});
}

async function cmdStudioPlay(flags: Flags, io: Io, start: boolean): Promise<number> {
	return await withStudio(flags, io, async (client, studio) => {
		const answer = await client.call("start_stop_play", { studio_id: studio.id, is_start: start }, 180_000);
		io.log(answer.trim());
		return 0;
	});
}

async function cmdStudioExec(flags: Flags, io: Io): Promise<number> {
	const raw = await rawScript(flags, io);
	if (raw === undefined) {
		throw new UsageError('studio exec needs --code "<luau>" or --script <file>');
	}
	const dataModel = dataModelOf(flags.realm, "Edit");

	return await withStudio(flags, io, async (client, studio) => {
		const answer = await client.call(
			"execute_luau",
			{ studio_id: studio.id, datamodel_type: dataModel, code: raw.script },
			parseDurationMs(flags.timeout ?? DEFAULT_TIMEOUT, 120_000),
		);
		io.log(answer);
		return 0;
	});
}

/**
 * Runs the tests of each realm in a play session of the window, starting one when none is
 * running and stopping it afterwards unless `--keep`. Every realm is run even after one fails;
 * the exit code is the worst of them.
 */
async function runRealms(
	client: StudioClient,
	studio: StudioEntry,
	realms: Array<"Server" | "Client">,
	flags: Flags,
	io: Io,
): Promise<number> {
	const filter: Filter = parseSections(flags.sections);
	const script = renderStudioRun(renderFilter(filter), renderOptions({ list: flags.list === true }));
	const state = () => client.call("get_studio_state", { studio_id: studio.id }, 30_000);

	let startedHere = false;
	if (!isPlaying(await state())) {
		io.log("starting a play session...");
		await client.call("start_stop_play", { studio_id: studio.id, is_start: true }, 180_000);
		startedHere = true;

		const deadline = io.now().getTime() + PLAY_START_TIMEOUT_MS;
		while (io.now().getTime() < deadline) {
			const current = await state();
			if (/Client/.test(current) && /Server/.test(current)) break;
			await io.sleep(1000);
		}
	}

	try {
		let code = 0;
		for (const dataModel of realms) {
			io.log(`running the ${dataModel.toLowerCase()}'s tests in ${placeNameOf(studio.name)}...`);
			const timeout = flags.timeout ?? DEFAULT_TIMEOUT;

			let answer: string;
			try {
				answer = await client.call(
					"execute_luau",
					{ studio_id: studio.id, datamodel_type: dataModel, code: script },
					parseDurationMs(timeout, 120_000),
				);
			} catch (error) {
				if (!/timed out/.test(String(error))) throw error;

				// Every test has `testing.timeout` of its own, so a realm that does not answer is
				// stuck somewhere the runner cannot see: the last test that reported places it.
				code = 1;
				io.error(`the ${dataModel.toLowerCase()}'s run did not finish within ${timeout} (--timeout)`);
				io.error(await describeHangingTest(client, studio, dataModel));
				continue;
			}

			code = Math.max(code, printRunResult([unquoteLuauResult(answer)], flags, io));
		}
		return code;
	} finally {
		if (startedHere && flags.keep !== true) {
			await client.call("start_stop_play", { studio_id: studio.id, is_start: false }, 120_000);
			io.log("play session stopped (--keep leaves it running)");
		}
	}
}

/**
 * Where a realm's run that never answered got to, read off Studio's output: the last `[FWTEST]`
 * line names the last test that reported, so the one after it in that section is the one that has
 * not returned. No line at all means the host never started the run.
 */
async function describeHangingTest(client: StudioClient, studio: StudioEntry, dataModel: string): Promise<string> {
	const realm = dataModel.toLowerCase();

	let output: string;
	try {
		output = await client.call("get_console_output", { studio_id: studio.id }, 30_000);
	} catch (error) {
		return `could not read Studio's output to place it: ${String(error)}`;
	}

	const reported = output
		.split(/\r?\n/)
		.map((line) => line.match(new RegExp(`\\[FWTEST\\] ${realm} (\\S+): (PASS|FAIL)`)))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (reported.length === 0) {
		return `no test of the ${realm} reported in Studio's output: the host never started the run, or the place is not built with the testing scope`;
	}

	const last = reported[reported.length - 1]!;
	return `last test that reported: ${last[1]} (${last[2]}); the test after it in that section is hanging, past its own timeout`;
}

async function cmdStudioRun(flags: Flags, io: Io): Promise<number> {
	const realms = realmsOf(flags.realm, "server");
	return await withStudio(flags, io, (client, studio) => runRealms(client, studio, realms, flags, io));
}

// -------------------------------------------------------------------- test

/**
 * The default way to run the tests: the place Rojo built, opened in Studio on this machine, run
 * on both realms in a play session, and closed again. A window that already has a file of that
 * name open is from an earlier build and would test stale code, so it is closed first and the
 * file opened afresh.
 */
async function cmdTest(flags: Flags, io: Io): Promise<number> {
	if (flags.cloud) return await cmdCloudTest(flags, io);
	if (flags.published) {
		throw new UsageError("--published is for the cloud: flamework-test test <file> --cloud --published");
	}

	const realms = realmsOf(flags.realm, "both");
	const { absolute: file, label } = await placeToRun(flags, io, "test");
	const name = basename(file);
	const exe = requireStudioExe(io);

	const client = await io.connectStudio();
	try {
		const stale = findStudio(await client.studios(), undefined, name);
		if (stale !== undefined) {
			io.log(`${name} is already open in Studio, from an earlier build; closing it`);
			await closeStudioWindow(name, io);
			await io.sleep(2000);
		}

		await io.launch([exe, ...studioOpenArguments({ file })]);
		io.log(`opening ${label} in Studio; waiting for it to connect...`);
		const studio = await waitForStudio(client, (studios) => findStudio(studios, undefined, name), flags, io);
		if (studio === undefined) throw neverConnected(label);
		io.log(`connected: ${studio.name} (${studio.id})`);

		const code = await runRealms(client, studio, realms, flags, io);

		if (flags.keep === true) {
			io.log("Studio left open (--keep)");
		} else {
			await closeStudioWindow(name, io);
		}
		return code;
	} finally {
		client.close();
	}
}

// ------------------------------------------------------------------- main

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
	const io = resolveDeps(deps);

	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			io.error(`error: ${error.message}`);
			io.error("");
			io.error(USAGE);
			return 2;
		}
		throw error;
	}

	if (parsed.flags.help || parsed.command === "help") {
		io.log(USAGE);
		return 0;
	}
	if (parsed.command === undefined) {
		io.error("error: no command given");
		io.error("");
		io.error(USAGE);
		return 2;
	}

	try {
		switch (parsed.command) {
			case "test":
				return await cmdTest(parsed.flags, io);
			case "patch":
				return await cmdPatch(parsed.flags, io);
			case "studio open":
				return await cmdStudioOpen(parsed.flags, io);
			case "studio close":
				return await cmdStudioClose(parsed.flags, io);
			case "studio status":
				return await cmdStudioStatus(parsed.flags, io);
			case "studio play":
				return await cmdStudioPlay(parsed.flags, io, true);
			case "studio stop":
				return await cmdStudioPlay(parsed.flags, io, false);
			case "studio exec":
				return await cmdStudioExec(parsed.flags, io);
			case "studio run":
				return await cmdStudioRun(parsed.flags, io);
			case "cloud publish":
				return await cmdPublish(parsed.flags, io);
			case "cloud run":
				return await cmdRun(parsed.flags, io, "run");
			case "cloud probe":
				return await cmdRun(parsed.flags, io, "probe");
			case "cloud test":
				return await cmdCloudTest(parsed.flags, io);
			default:
				io.error(`error: unknown command: ${parsed.command}`);
				io.error("");
				io.error(USAGE);
				return 2;
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.error(`error: ${error.message}`);
			io.error("");
			io.error(USAGE);
			return 2;
		}
		if (error instanceof TaskTimeoutError) {
			io.error(`error: ${error.message}`);
			io.error("the task is still on Roblox's side; poll it later with GET /cloud/v2/<path>");
			return 1;
		}
		if (error instanceof OpenCloudError) {
			io.error(error.message);
			if (error.hint) io.error(error.hint);
			return 1;
		}
		if (error instanceof CliError) {
			io.error(`error: ${error.message}`);
			if (error.hint) io.error(error.hint);
			return 1;
		}
		io.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(Bun.argv.slice(2)));
}
