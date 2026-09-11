#!/usr/bin/env bun
/**
 * place-test-runner - build a Roblox place with Rojo, publish it through Open
 * Cloud, and run the Flamework test suite inside it with the Luau Execution
 * API.
 *
 * Everything is injectable (`CliDeps`) so `bun test` can drive the whole CLI
 * without a network, a file system or a real API key.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
import { parseSections, renderShim, type Filter } from "./luau.ts";
import { formatList, formatSummary, parseRunResult, ResultParseError } from "./results.ts";

export const DEFAULT_PROJECT = "default.project.json";
export const DEFAULT_PLACE_FILE = "build/place.rbxl";
export const VERSION_FILE = "build/version.json";
export const DEFAULT_UNIVERSE_ID = "10765968722";
export const DEFAULT_PLACE_ID = "108973151455286";
export const DEFAULT_TIMEOUT = "120s";
export const PROBE_TIMEOUT = "60s";
export const POLL_INTERVAL_MS = 2500;
/** How long past the task's own timeout we keep polling before giving up. */
export const QUEUE_SLACK_MS = 300_000;

// ---------------------------------------------------------------- arguments

type FlagKind = "string" | "boolean";

const FLAGS: Record<string, FlagKind> = {
	project: "string",
	file: "string",
	published: "boolean",
	version: "string",
	sections: "string",
	list: "boolean",
	timeout: "string",
	code: "string",
	script: "string",
	"dry-run": "boolean",
	json: "boolean",
	universe: "string",
	place: "string",
	help: "boolean",
};

const COMMON_FLAGS = ["universe", "place", "help"];
const BUILD_FLAGS = ["project"];
const PUBLISH_FLAGS = ["file", "published"];
const RUN_FLAGS = ["version", "sections", "list", "timeout", "code", "script", "dry-run", "json"];

const COMMANDS: Record<string, string[]> = {
	build: BUILD_FLAGS,
	publish: PUBLISH_FLAGS,
	run: RUN_FLAGS,
	test: [...BUILD_FLAGS, ...PUBLISH_FLAGS, ...RUN_FLAGS],
	probe: ["version", "timeout", "json", "dry-run"],
	help: [],
};

export interface Flags {
	project?: string;
	file?: string;
	published?: boolean;
	version?: string;
	sections?: string;
	list?: boolean;
	timeout?: string;
	code?: string;
	script?: string;
	"dry-run"?: boolean;
	json?: boolean;
	universe?: string;
	place?: string;
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
	command?: string;
	flags: Flags;
}

/** Flags may appear before or after the subcommand. */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags: Flags = {};
	let command: string | undefined;

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

		if (command !== undefined) {
			throw new UsageError(`unexpected argument: ${arg}`);
		}
		command = arg;
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
	}

	return { command, flags };
}

const USAGE = `place-test-runner - run Flamework tests inside a published Roblox place

Usage:
  bun run src/cli.ts <command> [flags]        (flags may come before the command)

Commands:
  build      rojo build the project into ${DEFAULT_PLACE_FILE}
  publish    upload ${DEFAULT_PLACE_FILE} as a new place version
  run        run the test shim in the place and report the results
  test       build, then publish, then run
  probe      report what the execution sandbox looks like from the inside

Flags:
  build      --project <path>        default: $PROJECT, else cloud.project, else ${DEFAULT_PROJECT}
  publish    --file <path>           default: ${DEFAULT_PLACE_FILE}
             --published             publish live instead of uploading a Saved version
  run        --version <n>           default: ${VERSION_FILE}, else the current version
             --sections <a,b>        only these sections ("economy", "economy/buys")
             --list                  list the tests instead of running them
             --timeout <120s>        task timeout, max 300s
             --code "<luau>"         run this Luau instead of the test shim
             --script <file>         run this Luau file instead of the test shim
             --dry-run               print the request that would be sent, then stop
             --json                  print the raw result JSON instead of a summary
  common     --universe <id>         default: $UNIVERSE_ID, else cloud.universeId
             --place <id>            default: $PLACE_ID, else cloud.placeId
             -h, --help

Settings come from the "cloud" section of the nearest flamework.config.json, read the way the
transformer reads it (\${NAME} references, .env and .env.local next to it), with flags and the
environment on top:
  "cloud": { "universeId": "...", "placeId": "...", "apiKey": "\${ROBLOX_API_KEY:-}", "project": "default.project.json" }

Environment:
  ROBLOX_API_KEY          Open Cloud key: universe-places:write and
  (or TESTING_PLACE_API_KEY) universe.place.luau-execution-session:read/:write
  UNIVERSE_ID, PLACE_ID   the experience and the place inside it
  PROJECT                 Rojo project for "build"

Exit codes: 0 success, 1 failure, 2 bad usage.`;

// ------------------------------------------------------------------- deps

export interface CliDeps {
	fetch?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	readFile?: (path: string) => Promise<ArrayBuffer>;
	readTextFile?: (path: string) => Promise<string>;
	writeTextFile?: (path: string, text: string) => Promise<void>;
	/** `mkdir -p`. */
	mkdirp?: (path: string) => Promise<void>;
	exists?: (path: string) => Promise<boolean>;
	/** Runs a child process; resolves with its exit code. */
	spawn?: (command: string[], cwd: string) => Promise<number>;
	log?: (message: string) => void;
	error?: (message: string) => void;
	env?: Record<string, string | undefined>;
	cwd?: string;
	/** Where `run-tests.luau` and `probe.luau` live. */
	tasksDir?: string;
	now?: () => Date;
	/** Reads the `cloud` section of the nearest flamework.config.json. */
	loadSettings?: (cwd: string, env: Record<string, string | undefined>) => CloudSettings;
}

interface Io extends Required<Omit<CliDeps, "fetch">> {
	fetch: FetchLike | undefined;
}

function resolveDeps(deps: CliDeps): Io {
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
		mkdirp:
			deps.mkdirp ??
			(async (path) => {
				await mkdir(path, { recursive: true });
			}),
		exists: deps.exists ?? ((path) => Bun.file(path).exists()),
		spawn:
			deps.spawn ??
			(async (command, cwd) => {
				const proc = Bun.spawn({
					cmd: command,
					cwd,
					stdout: "inherit",
					stderr: "inherit",
				});
				return await proc.exited;
			}),
		log: deps.log ?? ((message) => console.log(message)),
		error: deps.error ?? ((message) => console.error(message)),
		env: deps.env ?? (process.env as Record<string, string | undefined>),
		cwd: deps.cwd ?? process.cwd(),
		tasksDir: deps.tasksDir ?? join(import.meta.dir, "..", "tasks"),
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

function makeClient(flags: Flags, io: Io, { requireKey = true }: { requireKey?: boolean } = {}): OpenCloudClient {
	const apiKey = io.env.ROBLOX_API_KEY ?? io.env.TESTING_PLACE_API_KEY ?? settingsOf(io).apiKey ?? "";
	if (!apiKey && requireKey) {
		throw new CliError(
			"no Open Cloud API key",
			'set ROBLOX_API_KEY in .env.local next to flamework.config.json and give the cloud section "apiKey": "\${ROBLOX_API_KEY:-}"',
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

function resolveIds(flags: Flags, io: Io): { universeId: string; placeId: string } {
	const settings = settingsOf(io);
	const universeId = flags.universe ?? io.env.UNIVERSE_ID ?? settings.universeId;
	const placeId = flags.place ?? io.env.PLACE_ID ?? settings.placeId;
	if (universeId === undefined || placeId === undefined) {
		throw new CliError(
			"no universe and place to run in",
			'give flamework.config.json a "cloud" section with "universeId" and "placeId", or pass --universe and --place',
		);
	}
	if (universeId === placeId) {
		io.error(
			`warning: UNIVERSE_ID and PLACE_ID are both ${placeId} - the universe id is the one in the dashboard URL, the place id the one in the game URL`,
		);
	}
	return { universeId, placeId };
}

// --------------------------------------------------------------- commands

async function cmdBuild(flags: Flags, io: Io): Promise<number> {
	const project = flags.project ?? io.env.PROJECT ?? settingsOf(io).project ?? DEFAULT_PROJECT;
	const outFile = resolve(io.cwd, DEFAULT_PLACE_FILE);
	await io.mkdirp(dirname(outFile));

	const command = ["rojo", "build", project, "-o", outFile];
	io.log(`$ rojo build ${project} -o ${DEFAULT_PLACE_FILE}`);
	const code = await io.spawn(command, io.cwd);
	if (code !== 0) {
		io.error(`rojo build failed (exit ${code})`);
		return 1;
	}

	let size = "";
	try {
		size = ` (${(Bun.file(outFile).size / 1024).toFixed(0)} KiB)`;
	} catch {
		size = "";
	}
	io.log(`built ${DEFAULT_PLACE_FILE}${size}`);
	return 0;
}

async function cmdPublish(flags: Flags, io: Io): Promise<number> {
	const file = flags.file ?? DEFAULT_PLACE_FILE;
	const absolute = resolve(io.cwd, file);
	if (!(await io.exists(absolute))) {
		throw new CliError(`${file} does not exist`, "run `bun run build` first, or pass --file");
	}

	const versionType: VersionType = flags.published ? "Published" : "Saved";
	const client = makeClient(flags, io);
	io.log(`publishing ${file} to place ${client.placeId} as ${versionType}...`);

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
			script: await io.readTextFile(join(io.tasksDir, "probe.luau")),
			scriptKind: "probe",
			label: "tasks/probe.luau",
		};
	}

	if (flags.code !== undefined && flags.script !== undefined) {
		throw new UsageError("--code and --script are mutually exclusive");
	}
	if (flags.code !== undefined) {
		return { script: flags.code, scriptKind: "raw", label: "--code" };
	}
	if (flags.script !== undefined) {
		const path = resolve(io.cwd, flags.script);
		if (!(await io.exists(path))) {
			throw new CliError(`${flags.script} does not exist`);
		}
		return {
			script: await io.readTextFile(path),
			scriptKind: "raw",
			label: flags.script,
		};
	}

	const template = await io.readTextFile(join(io.tasksDir, "run-tests.luau"));
	const filter: Filter = parseSections(flags.sections);
	const script = renderShim(template, filter, { list: flags.list === true });
	return { script, scriptKind: "shim", label: "tasks/run-tests.luau" };
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

async function cmdTest(flags: Flags, io: Io): Promise<number> {
	const built = await cmdBuild(flags, io);
	if (built !== 0) return built;
	const published = await cmdPublish(flags, io);
	if (published !== 0) return published;
	return await cmdRun(flags, io, "run");
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
			case "build":
				return await cmdBuild(parsed.flags, io);
			case "publish":
				return await cmdPublish(parsed.flags, io);
			case "run":
				return await cmdRun(parsed.flags, io, "run");
			case "probe":
				return await cmdRun(parsed.flags, io, "probe");
			case "test":
				return await cmdTest(parsed.flags, io);
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
