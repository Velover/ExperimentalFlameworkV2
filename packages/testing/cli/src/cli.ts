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
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

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
import {
	describeSignal,
	Interrupted,
	interruptedExitCode,
	Interruption,
	rethrowInterrupted,
	type Release,
} from "./interrupt.ts";
import { parseSections, renderFilter, renderOptions, renderShim, type Filter } from "./luau.ts";
import {
	patchCommand,
	patchedPathFor,
	planPatch,
	projectNameOf,
	type PatchPlan,
	type ProjectChoice,
	type RojoProject,
} from "./patch.ts";
import PATCH_TASK from "../tasks/patch-place.lune" with { type: "text" };
import PROBE_TASK from "../tasks/probe.lune" with { type: "text" };
import RUN_TESTS_TASK from "../tasks/run-tests.lune" with { type: "text" };
import {
	formatList,
	formatSummary,
	missedEverywhere,
	parseRunResult,
	resultPassed,
	ResultParseError,
	type RealmOfSeveral,
	type RunResult,
} from "./results.ts";
import {
	claimWindowName,
	connectStudio,
	findStudioExe,
	findStudio,
	findStudioForPlace,
	findStudioMcp,
	isPlaying,
	isSandboxRefusal,
	listStudioWindows,
	luauErrorMessage,
	placeNameOf,
	renderStudioRun,
	runCloseScript,
	SANDBOX_HINT,
	studioOpenArguments,
	titleShowsFile,
	unquoteLuauResult,
	type CloseTarget,
	type ClosedWindow,
	type DataModelType,
	type StudioClient,
	type StudioEntry,
	type StudioWindow,
} from "./studio.ts";

/** Where `cloud publish` records the version it made, for `cloud run` to pin. */
export const VERSION_FILE = "build/version.json";
export const DEFAULT_PROJECT = "default.project.json";
export const DEFAULT_TIMEOUT = "120s";
export const PROBE_TIMEOUT = "60s";
/** How long a Studio window is waited for after launching it. */
export const STUDIO_OPEN_TIMEOUT = "180s";
/** How long a run waits for another to finish opening a window of the same name. */
export const CLAIM_TIMEOUT_MS = 600_000;
/** How long a play session is waited for once started. */
export const PLAY_START_TIMEOUT_MS = 90_000;
/**
 * How long a stop of the play session a run started is tried again, half a second apart, while
 * Studio refuses it because the start is still under way ("Start play hasn't finished yet"): a
 * Ctrl+C during the start, which takes about five seconds, stops waiting for it at once.
 */
export const PLAY_STOP_RETRY_MS = 30_000;
/** How long a stop of the play session is waited for, when it is not a retry. */
export const PLAY_STOP_TIMEOUT_MS = 120_000;
/**
 * The least a retried stop is waited for, however little of {@link PLAY_STOP_RETRY_MS} is left: a
 * stop Studio accepts takes a few seconds to answer. A retry is over this long past its deadline at most.
 */
export const PLAY_STOP_ANSWER_MS = 10_000;
/** How often Studio's lock beside a place is tried to be removed, half a second apart, once its process has been ended. */
export const LOCK_REMOVAL_ATTEMPTS = 20;
export const POLL_INTERVAL_MS = 2500;
/** How long past the task's own timeout we keep polling before giving up. */
export const QUEUE_SLACK_MS = 300_000;

// ---------------------------------------------------------------- arguments

/** `list`: a string flag that may be repeated, or given comma-separated, and collects every value. */
type FlagKind = "string" | "boolean" | "list";

const FLAGS: Record<string, FlagKind> = {
	file: "string",
	published: "boolean",
	original: "string",
	project: "list",
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
	/** Every `--project` given, in order. */
	project?: string[];
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

/** A comma-separated list, the way `--sections` and the environment give one; blanks dropped. */
export function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
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
				if (kind === "list") {
					const values = splitList(value);
					if (values.length === 0) throw new UsageError(`--${name} needs a value`);
					const record = flags as Record<string, unknown>;
					record[name] = [...((record[name] as string[] | undefined) ?? []), ...values];
				} else {
					(flags as Record<string, unknown>)[name] = value;
				}
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
             --project <path>        the Rojo project the run follows: its $properties are set on the
                                     place (Workspace.SignalBehavior, the streaming radii: what no
                                     script can set) and the patch follows its tree; repeatable or
                                     comma-separated, one run per project, named after the file
                                     (getProject() in a test); needs lune. Default: $ROJO_PROJECT,
                                     else ${DEFAULT_PROJECT}, followed only when an original is patched
             --sections <a,b>        only these sections ("economy", "economy/buys")
             --list                  list the tests instead of running them
             --json                  print the raw result JSON instead of a summary
             --timeout <120s>        per run
  patch      --out <path>            where the patched place goes; default <file>.patched.rbxl, or
                                     <file>.<project>.rbxl under a chosen --project (one project)
  studio run --realm server|client|both   default server
             --keep                  leave the play session running afterwards
             --sections, --list, --json, --timeout   as for test
  studio exec --realm edit|server|client  default edit
  studio *   --studio <name|id>      which window; default: the one with the testing place open,
                                     else the only one with a local place file open
  cloud publish --published          publish live instead of uploading a Saved version
             --original, --project   as for test (one project: one version is published)
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
  ROJO_PROJECT                            the project(s) a run follows, comma-separated, for --project
  LUNE_EXE, ROBLOX_STUDIO_EXE, STUDIO_MCP_EXE   overrides for the tools this finds by itself

Examples:
  rojo build -o place.rbxl && flamework-test test place.rbxl
  rojo build -o place.rbxl && flamework-test test place.rbxl --sections economy --keep
  rojo build -o place.rbxl && flamework-test test place.rbxl --project tests/deferred.project.json
  rojo build -o place.rbxl && flamework-test test place.rbxl --cloud
  flamework-test cloud run --sections economy       again, against the version last published
  flamework-test studio open && flamework-test studio run --realm client

Ctrl+C stops a run and cleans up what it started: the play session, the Studio window it opened
(unless --keep), its temp files and child processes; a second Ctrl+C exits at once. A task already
created on Open Cloud runs on: Open Cloud cannot cancel one.

Exit codes: 0 success, 1 failure, 2 bad usage, 130 interrupted by Ctrl+C. 130 is this process's own
code: run through the flamework-test bin, the shell gets the bin's Ctrl+C status back at once, and
the cleanup's lines follow its prompt.`;

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
	/** Starts a program and returns at once, leaving it running; resolves with its process id when known. */
	launch?: (command: string[]) => Promise<number | undefined>;
	/**
	 * Closes the Studio windows the target matches, and only those, checking each is gone
	 * afterwards; what became of every one of them (none matched: an empty list).
	 */
	closeWindow?: (target: CloseTarget) => Promise<ClosedWindow[]>;
	/**
	 * Holds a window name on this machine until the release is called, waiting while another run
	 * holds it (`onWait` hears which, once).
	 */
	claimWindowName?: (name: string, onWait: (holder: number) => void) => Promise<() => void>;
	/** Every Roblox Studio process on this machine, with its window's title. */
	studioWindows?: () => Promise<StudioWindow[]>;
	/** Connects to Studio's MCP proxy. */
	connectStudio?: () => Promise<StudioClient>;
	/** Where Roblox Studio is; `undefined` when it cannot be found. */
	studioExe?: () => string | undefined;
	log?: (message: string) => void;
	error?: (message: string) => void;
	env?: Record<string, string | undefined>;
	cwd?: string;
	/**
	 * Makes a folder of its own for the files one patch needs while it runs (its plan and its Lune
	 * task), so that nothing but the places a run makes lands in the project, and two runs at once
	 * never read each other's plan. By default a new folder of the system's temp directory.
	 */
	makeTempDir?: () => Promise<string>;
	/** Removes a folder and everything in it; the patch's own folder once it is done. */
	removeDir?: (path: string) => Promise<void>;
	/** Removes a file; Studio's lock beside a place whose window a run ended. */
	removeFile?: (path: string) => Promise<void>;
	now?: () => Date;
	/** Reads the `cloud` section of the nearest flamework.config.json. */
	loadSettings?: (cwd: string, env: Record<string, string | undefined>) => CloudSettings;
	/**
	 * Hears Ctrl+C (and Ctrl+Break on Windows, SIGTERM elsewhere) for as long as a command runs, in
	 * place of the process ending at once; returns what stops listening.
	 */
	onInterrupt?: (handler: (signal: string) => void) => () => void;
	/** Ends the process at once, for a second Ctrl+C during the cleanup. */
	exit?: (code: number) => void;
}

interface Io extends Required<Omit<CliDeps, "fetch">> {
	fetch: FetchLike;
	/** Ctrl+C: what the run holds, and whether it has been interrupted (see interrupt.ts). */
	interruption: Interruption;
}

/**
 * The signals a run cleans up after. SIGBREAK is Ctrl+Break, and Windows only. Windows has no
 * SIGTERM to hear: ending a process there (`process.kill(pid, "SIGTERM")`, `taskkill /F`) ends it
 * at once, running no handler (measured with Bun 1.4.0: exit code 1, no cleanup).
 */
const INTERRUPT_SIGNALS = (): NodeJS.Signals[] =>
	process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

/** A real sleep, which the run's own sleeps and a window-name claim's wait are made of. */
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The CLI's dependencies, the real ones unless injected, made interruptible: once the run is
 * interrupted every wait (a sleep, a child process, a request, a call to Studio) rejects at once
 * and nothing new is started, except in the run's cleanup. What a dependency starts that would
 * outlive the run (a child process, the MCP proxy, a window-name claim) is held on the ledger
 * until it is let go.
 */
function resolveDeps(deps: CliDeps, interruption: Interruption): Io {
	const env = deps.env ?? (process.env as Record<string, string | undefined>);
	const cwd = deps.cwd ?? process.cwd();

	const sleep = deps.sleep ?? pause;
	const fetchImpl: FetchLike =
		deps.fetch ?? ((input, init) => globalThis.fetch(input, { ...init, signal: interruption.abortSignal }));
	const spawnChild =
		deps.spawn ??
		(async (command: string[], cwd: string) => {
			const child = Bun.spawn({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" });
			// On this console the child hears a Ctrl+C itself, and is ended here in case it outlives it.
			const end = () => child.kill();
			interruption.abortSignal.addEventListener("abort", end, { once: true });
			try {
				const code = await child.exited;
				// The Ctrl+C that ended the child can reach it before it reaches this process: a moment's
				// wait lets it arrive, so the run reports the interruption rather than the child's failure.
				if (code !== 0 && !interruption.interrupted) await pause(100);
				return code;
			} finally {
				interruption.abortSignal.removeEventListener("abort", end);
			}
		});
	const launch =
		deps.launch ??
		(async ([exe, ...args]: string[]) => {
			// Detached, or Windows takes Studio down with this process when it exits.
			const child = spawn(exe!, args, { detached: true, stdio: "ignore", windowsHide: false });
			child.unref();
			// Studio opens the file in the process started here, so this is the window's process.
			return child.pid;
		});
	const claimDir = join(tmpdir(), "flamework-test");
	const claim =
		deps.claimWindowName ??
		((name: string, onWait: (holder: number) => void) =>
			claimWindowName(name, {
				dir: claimDir,
				timeoutMs: CLAIM_TIMEOUT_MS,
				sleep: (ms) => interruption.run(() => pause(ms)),
				onWait,
			}));
	const connect =
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
		});
	const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "flamework-test-")));

	return {
		fetch: (input, init) => interruption.run(() => fetchImpl(input, init)),
		sleep: (ms) => interruption.run(() => sleep(ms)),
		readFile: deps.readFile ?? ((path) => Bun.file(path).arrayBuffer()),
		readTextFile: deps.readTextFile ?? ((path) => Bun.file(path).text()),
		writeTextFile:
			deps.writeTextFile ??
			(async (path, text) => {
				await mkdir(dirname(path), { recursive: true });
				await Bun.write(path, text);
			}),
		exists: deps.exists ?? ((path) => Bun.file(path).exists()),
		spawn: async (command, cwd) => {
			interruption.check();
			const name = basename(command[0] ?? "").replace(/\.exe$/i, "");
			// Bun ends the children it started when this process exits (measured: lune, PowerShell and
			// the proxy alike; only Studio, launched detached, outlives it), so exiting at once leaves none.
			const release = interruption.hold(`${name}, which this run started`, `stopped ${name}`, {
				endsWithProcess: true,
			});
			try {
				return await interruption.run(() => spawnChild(command, cwd));
			} finally {
				release();
			}
		},
		launch: async (command) => {
			// Never raced: the process it starts is known only by what it returns.
			interruption.check();
			return await launch(command);
		},
		closeWindow: deps.closeWindow ?? ((target) => runCloseScript(target)),
		claimWindowName: async (name, onWait) => {
			const release = await interruption.run(
				() => claim(name, onWait),
				(late) => late(),
			);
			// Left by a second Ctrl+C, the claim names a process that has gone, and the next run takes it over.
			const held = interruption.hold(
				`the claim on the window name ${name} (a file in ${claimDir}, which the next run takes over)`,
				`released the claim on the window name ${name}`,
			);
			return () => {
				release();
				held();
			};
		},
		studioWindows: deps.studioWindows ?? (() => listStudioWindows()),
		connectStudio: async () => {
			const client = await interruption.run(connect, (late) => late.close());
			const proxy = `the MCP proxy (StudioMCP.exe${client.pid !== undefined ? `, PID ${client.pid}` : ""})`;
			// The proxy ends with this process, as every child Bun started does (measured 2026-10-01).
			const held = interruption.hold(proxy, `closed ${proxy}`, { endsWithProcess: true });
			return {
				call: (name, args, timeoutMs) => interruption.run(() => client.call(name, args, timeoutMs)),
				studios: () => interruption.run(() => client.studios()),
				close: () => {
					client.close();
					held();
				},
				...(client.pid !== undefined ? { pid: client.pid } : {}),
			};
		},
		studioExe: deps.studioExe ?? (() => findStudioExe(env)),
		log: deps.log ?? ((message) => console.log(message)),
		error: deps.error ?? ((message) => console.error(message)),
		env,
		cwd,
		makeTempDir: async () => {
			interruption.check();
			return await makeTempDir();
		},
		removeDir: deps.removeDir ?? ((path) => rm(path, { recursive: true, force: true })),
		removeFile: deps.removeFile ?? ((path) => rm(path, { force: true })),
		now: deps.now ?? (() => new Date()),
		loadSettings: deps.loadSettings ?? loadCloudSettings,
		onInterrupt:
			deps.onInterrupt ??
			((handler) => {
				const listeners = INTERRUPT_SIGNALS().map((signal) => {
					const listener = () => handler(signal);
					process.on(signal, listener);
					return { signal, listener };
				});
				return () => {
					for (const { signal, listener } of listeners) process.off(signal, listener);
				};
			}),
		exit: deps.exit ?? ((code) => process.exit(code)),
		interruption,
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
		fetch: io.fetch,
		sleep: io.sleep,
		readFile: io.readFile,
	});
}

/**
 * The testing place's id when one is configured anywhere, for finding its Studio window; a window
 * named with `--studio`, or the only local-file window, needs none.
 */
function testingPlaceIdIfAny(flags: Flags, io: Io): string | undefined {
	return flags["testing-place"] ?? envOf(io, "TESTING_PLACE_ID") ?? settingsOf(io).testingPlaceId;
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

/**
 * The projects a run follows, in order: `--project`, else `ROJO_PROJECT` (comma-separated; empty
 * turns it off), else the default project, unchosen: followed only when an original is patched.
 * Runs, files and the place's attribute are named after the project file, so two files of the
 * same name are refused.
 */
function projectsOf(flags: Flags, io: Io): ProjectChoice[] {
	const named = flags.project ?? splitList(envOf(io, "ROJO_PROJECT"));
	if (named.length === 0) {
		return [{ path: resolve(io.cwd, DEFAULT_PROJECT), name: projectNameOf(DEFAULT_PROJECT), chosen: false }];
	}

	const projects = named.map((path) => ({ path: resolve(io.cwd, path), name: projectNameOf(path), chosen: true }));
	for (const [index, project] of projects.entries()) {
		const twin = projects.slice(0, index).find((other) => other.name === project.name);
		if (twin !== undefined) {
			throw new UsageError(
				`two projects are both named ${project.name}: ${twin.path} and ${project.path}; a run, its place file and the place's FlameworkTestProject attribute are named after the project file, so give them different names`,
			);
		}
	}
	return projects;
}

/** Commands that make one place follow one project: `patch` writes one file, `cloud publish` one version. */
function singleProjectOf(flags: Flags, io: Io, command: string): ProjectChoice {
	const projects = projectsOf(flags, io);
	if (projects.length > 1) {
		const source = flags.project !== undefined ? "--project" : "ROJO_PROJECT";
		throw new UsageError(
			`${command} follows one project at a time, and ${source} names ${projects.length}; ${source === "--project" ? "give one" : "pass --project <file>"}`,
		);
	}
	return projects[0]!;
}

/** `lune`, or `LUNE_EXE`; checked before anything is opened or uploaded, since the patch cannot run without it. */
async function requireLune(io: Io, what: string): Promise<string> {
	const exe = envOf(io, "LUNE_EXE") ?? "lune";
	let code: number;
	try {
		code = await io.spawn([exe, "--version"], io.cwd);
	} catch (error) {
		rethrowInterrupted(error);
		code = -1;
	}
	if (code !== 0) {
		throw new CliError(
			`lune is needed to ${what}, and it was not found`,
			"install it (rokit or aftman: `lune`), or set LUNE_EXE; nothing was run or uploaded",
		);
	}
	return exe;
}

/** The project file, parsed; refused before anything opens or uploads when it is missing or unreadable. */
async function readProject(project: ProjectChoice, io: Io): Promise<RojoProject> {
	if (!(await io.exists(project.path))) {
		throw new CliError(
			`the Rojo project ${project.path} does not exist`,
			project.chosen
				? "a run follows the project file for the properties to set and what the build replaces; check --project or ROJO_PROJECT"
				: "the patch follows the project file to know what the build replaces; pass --project",
		);
	}

	let rojo: RojoProject;
	try {
		rojo = JSON.parse(await io.readTextFile(project.path)) as RojoProject;
	} catch (error) {
		throw new CliError(
			`${project.path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof rojo.tree !== "object" || rojo.tree === null) {
		throw new CliError(`${project.path} has no "tree"`);
	}
	return rojo;
}

/**
 * Makes the place a project's run uses and returns its path: the build laid over a copy of the
 * original when there is one, else the build with the project's properties set on it. Either
 * way the place carries the project's name.
 */
async function patchPlace(
	built: string,
	original: string | undefined,
	project: ProjectChoice,
	flags: Flags,
	io: Io,
): Promise<string> {
	const lune = await requireLune(
		io,
		original !== undefined ? "patch the original place" : `set the properties of the project ${project.name}`,
	);

	const builtPath = resolve(io.cwd, built);
	if (!(await io.exists(builtPath))) {
		throw new CliError(`${built} does not exist`, `build it first: rojo build -o ${built}`);
	}
	if (original !== undefined && !(await io.exists(original))) {
		throw new CliError(
			`the original place ${original} does not exist`,
			"save a copy of the original place from Studio (File > Save to File) and point --original or cloud.originalPlace at it",
		);
	}

	const rojo = await readProject(project, io);

	const out = resolve(io.cwd, flags.out ?? patchedPathFor(built, project));

	// Only the patch reads these, so they go to a folder of this run's own rather than into the
	// game's: a folder shared by runs let two patches started together read each other's plan.
	const workDir = await io.makeTempDir();
	const releaseDir = io.interruption.hold(`the patch's temp folder ${workDir}`, "removed the patch's temp folder");
	try {
		const planPath = join(workDir, "patch-plan.json");
		const plan: PatchPlan = { project: project.name, ops: planPatch(rojo) };
		await io.writeTextFile(planPath, JSON.stringify(plan));

		// Lune runs a file, so the task ships as text and is written out beside the plan.
		const taskPath = join(workDir, "patch-place.luau");
		await io.writeTextFile(taskPath, PATCH_TASK);

		if (original !== undefined) {
			io.log(`patching a copy of ${original} with ${built}, following ${project.path}`);
		} else {
			io.log(`setting the properties of ${project.path} on ${built}`);
		}
		const code = await io.spawn(
			patchCommand(lune, taskPath, { original: original ?? builtPath, built: builtPath, out, plan: planPath }),
			io.cwd,
		);
		if (code !== 0) {
			throw new CliError(`the patch failed (lune exited ${code})`, "nothing was run or uploaded");
		}
	} finally {
		await io.removeDir(workDir);
		releaseDir();
	}

	io.log(`wrote ${out}`);
	return out;
}

/**
 * The place to run or upload: the build as it is, or the place made under the project when an
 * original is named or the project was chosen. `label` is how it is spoken of: the name the build
 * was given, or the patched file's path.
 */
async function placeToRun(
	flags: Flags,
	io: Io,
	command: string,
	project: ProjectChoice,
): Promise<{ absolute: string; label: string }> {
	const built = placeFileOf(flags, command);
	const original = originalPlaceOf(flags, io);
	if (original !== undefined || project.chosen) {
		const patched = await patchPlace(built, original, project, flags, io);
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
	const project = singleProjectOf(flags, io, "patch");
	const original = originalPlaceOf(flags, io);
	if (original === undefined && !project.chosen) {
		throw new UsageError(
			"patch needs the original place (--original <place.rbxl>, ORIGINAL_PLACE, or cloud.originalPlace), or a project whose properties to set on the build (--project <file>)",
		);
	}
	await patchPlace(built, original, project, flags, io);
	return 0;
}

// ------------------------------------------------------------------- cloud

async function cmdPublish(flags: Flags, io: Io): Promise<number> {
	return await publishProject(flags, io, singleProjectOf(flags, io, "cloud publish"));
}

/** Uploads the place made under the project as a new version of the testing place, and records the number. */
async function publishProject(flags: Flags, io: Io, project: ProjectChoice): Promise<number> {
	const { absolute, label: file } = await placeToRun(flags, io, "cloud publish", project);

	const versionType: VersionType = flags.published ? "Published" : "Saved";
	const client = makeClient(flags, io);
	io.log(`publishing ${file} to the testing place ${client.placeId} as ${versionType}...`);

	// An upload that Ctrl+C cuts short may have reached Roblox all the same.
	const uploaded = io.interruption.hold(
		`the upload to the testing place ${client.placeId}, which may still have made a new version of it`,
	);
	const versionNumber = await client.publishPlace(absolute, { versionType });
	uploaded();
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

	// Open Cloud cannot cancel a task, so one that Ctrl+C leaves behind runs on until it finishes or
	// its own timeout ends it; all a run can do is say where it is.
	const creating = io.interruption.hold(
		`a task being created on the testing place ${client.placeId}, which may still run there for up to ${timeout}`,
	);
	const created = await client.createTask(script, { version, timeout });
	creating();
	io.log(`task ${created.path}`);

	const running = io.interruption.hold(
		`the Open Cloud task ${created.path}, which runs on until it finishes or its timeout (${timeout}) ends it, since Open Cloud cannot cancel a task: read it with GET /cloud/v2/${created.path}`,
	);
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
	running();

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
	const result = readRunResult(results, io);
	if (result === undefined) return 1;

	printResult(result, results, flags, io);
	return resultPassed(result) ? 0 : 1;
}

/** A run's result, or nothing when it cannot be read, which is reported. */
function readRunResult(results: string[], io: Io): RunResult | undefined {
	try {
		return parseRunResult(results);
	} catch (error) {
		if (error instanceof ResultParseError) {
			io.error(error.message);
			io.error(
				"the shim returns whatever @flamework-experimental/testing's cloud runner returns; it must be a JSON string",
			);
			return undefined;
		}
		throw error;
	}
}

/** Prints a result as `--json`, `--list` or the summary ask; `options` when it is one realm of several. */
function printResult(result: RunResult, results: string[], flags: Flags, io: Io, options?: RealmOfSeveral): void {
	if (flags.json) {
		io.log(JSON.stringify(JSON.parse(results[0]!), null, 2));
	} else {
		io.log("");
		for (const line of flags.list ? formatList(result, options) : formatSummary(result, options)) {
			io.log(line);
		}
	}
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

/** `cloud test <file>` is `test <file> --cloud`: the same runs, one per project. */
async function cmdCloudTest(flags: Flags, io: Io): Promise<number> {
	return await cmdTest({ ...flags, cloud: true }, io);
}

/** One project's cloud run: publish the place made under it, then run the server's tests in it. */
async function cloudTestProject(flags: Flags, io: Io, project: ProjectChoice): Promise<number> {
	const published = await publishProject(flags, io, project);
	if (published !== 0) return published;
	return await cmdRun(flags, io, "run");
}

// ------------------------------------------------------------------ studio

/**
 * The connected proxy and the window to drive: the one `--studio` names, else the one with the
 * testing place open, else the only one with a local place file open. Only the second needs the
 * testing place's id, so a window found either other way is driven without one. Refuses clearly
 * when nothing matches.
 */
async function withStudio<T>(
	flags: Flags,
	io: Io,
	body: (client: StudioClient, studio: StudioEntry) => Promise<T>,
): Promise<T> {
	const placeId = flags.studio === undefined ? testingPlaceIdIfAny(flags, io) : undefined;
	const client = await io.connectStudio();
	try {
		const studios = await client.studios();
		const studio = findStudio(studios, placeId, flags.studio);
		if (studio === undefined) {
			const listed = studios.map((entry) => entry.name).join(", ");
			throw new CliError(
				flags.studio !== undefined
					? `no Studio window is named "${flags.studio}"; listed: ${listed || "none"}`
					: placeId !== undefined
						? `no Studio window has the testing place ${placeId} open, and no single window has a local place file open${listed ? `; listed: ${listed}` : ""}`
						: `no single Studio window has a local place file open, and no testing place is configured to look for${listed ? `; listed: ${listed}` : ""}`,
				'name the window with --studio <name|id>, or open it with `flamework-test studio open`; check that "MCP server" is enabled in Studio\'s Assistant settings, since a window that has it disabled is not listed',
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
	find: (studios: StudioEntry[]) => StudioEntry | undefined | Promise<StudioEntry | undefined>,
	flags: Flags,
	io: Io,
): Promise<StudioEntry | undefined> {
	const deadline = io.now().getTime() + parseDurationMs(flags.timeout ?? STUDIO_OPEN_TIMEOUT, 180_000);
	while (io.now().getTime() < deadline) {
		const studio = await find(await client.studios());
		if (studio !== undefined) return studio;
		await io.sleep(5000);
	}
	return undefined;
}

/**
 * A run that cannot tell its own window from another of the same name: the proxy lists a local
 * file's window by its file name alone and says nothing of the process behind it.
 */
function cannotTell(name: string, why: string, others: StudioWindow[]): CliError {
	const listed = others.map((window) => `PID ${window.pid}, "${window.title}"`).join("; ");
	return new CliError(
		`cannot tell which ${name} window on the MCP proxy is the one this run opened: ${why}${listed ? ` (${listed})` : ""}, and the proxy lists a local file's window by its file name alone`,
		"close that window, or let it finish opening, and run again",
	);
}

/**
 * What the hint says of the window: left `open` (`studio open`, `--keep`), `closed` again by
 * `test`, or nothing (`unstated`) when that close failed and has said so itself.
 */
function neverConnected(what: string, window: "open" | "closed" | "unstated" = "open"): CliError {
	const advice =
		'enable "MCP server" in Studio\'s Assistant settings (a window that has it disabled is never listed) and run again';
	return new CliError(
		`Studio started but ${what} never showed up on the MCP proxy`,
		window === "open"
			? 'the window is open; if it stays unlisted, enable "MCP server" in Studio\'s Assistant settings and run `flamework-test studio status` again'
			: window === "closed"
				? `${advice}; the window this run opened is closed again`
				: advice,
	);
}

async function cmdStudioOpen(flags: Flags, io: Io): Promise<number> {
	const exe = requireStudioExe(io);

	let find: (studios: StudioEntry[]) => StudioEntry | undefined;
	let what: string;
	let pid: number | undefined;
	if (flags.file !== undefined) {
		const file = resolve(io.cwd, flags.file);
		if (!(await io.exists(file))) {
			throw new CliError(`${flags.file} does not exist`);
		}
		pid = await io.launch([exe, ...studioOpenArguments({ file })]);
		// A local file's window is listed by its file name, with no place id.
		const name = basename(file);
		find = (studios) => findStudio(studios, undefined, name);
		what = flags.file;
	} else {
		const { universeId, placeId } = resolveIds(flags, io);
		pid = await io.launch([exe, ...studioOpenArguments({ placeId, universeId })]);
		find = (studios) => findStudioForPlace(studios, placeId);
		what = `the testing place ${placeId}`;
	}
	// The window is what was asked for: Ctrl+C stops the wait for it, as the timeout does, and leaves it.
	io.interruption.hold(
		`the Studio window it opened (PID ${pid ?? "unknown"}, ${what}), which studio open leaves open`,
	);
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

/** How a window is named in what the CLI prints: `PID 30020, "…\place.rbxl - Roblox Studio"`. */
function describeWindow(window: ClosedWindow): string {
	return `PID ${window.pid}, "${window.title}"`;
}

/**
 * Closes the windows a target matches and logs what became of each. The close only reports a
 * window closed once its process is gone, asking first and ending the process when asking is not
 * enough -- or, for the process a run started, ending it at once, since Studio answers the ask with
 * a save prompt for every place file (see `closeWindowScript`); a window still running after that
 * throws, naming it. Returns everything matched, `untouched` windows included, for the caller to judge.
 *
 * A second Ctrl+C ends the close script with this process. `options.cutShort` names what that may
 * leave, for a close that asks first (a window can be left showing its save prompt); `options.gone`
 * lets go of the window this run holds as soon as the script has ended it, before its lock is removed.
 */
async function closeWindows(
	target: CloseTarget,
	label: string,
	io: Io,
	options: { cutShort?: string; gone?: () => void } = {},
): Promise<ClosedWindow[]> {
	// A close is seen through, whenever Ctrl+C comes: a window ended and its lock left would be worse.
	return await io.interruption.cleanup(async () => {
		const closing = options.cutShort !== undefined ? io.interruption.hold(options.cutShort) : () => {};
		let windows: ClosedWindow[];
		try {
			windows = await io.closeWindow(target);
		} finally {
			closing();
		}
		for (const window of windows) {
			if (window.outcome === "closed" || window.outcome === "ended") {
				io.log(`closed ${label} (PID ${window.pid})`);
			} else if (window.outcome === "forced") {
				io.log(
					`closed ${label} (PID ${window.pid}) by ending its process: it did not close when asked (a save prompt, usually; nothing a run makes is kept)`,
				);
			}
			if (window.outcome === "closed" || window.outcome === "ended" || window.outcome === "forced") {
				options.gone?.();
			}

			// A Studio that is ended leaves the lock it keeps beside a place file it has open.
			if ((window.outcome === "ended" || window.outcome === "forced") && "file" in target) {
				await removeStudioLock(target.file, window.pid, io);
			}
		}

		const open = windows.filter((window) => window.outcome === "open");
		if (open.length > 0) {
			const why = open.find((window) => window.error)?.error;
			throw new CliError(
				`${label} is still open (${open.map(describeWindow).join("; ")}): it did not close when asked, and ending its process failed${why ? `: ${why}` : ""}`,
				"close it by hand; no other window was touched",
			);
		}
		return windows;
	});
}

/**
 * Removes Studio's lock beside a place file (`place.rbxl.lock`) once the process that wrote it has
 * been ended, which gives Studio no chance to remove it itself. Only a lock that names that process
 * on its first line: a lock of another Studio is left alone.
 */
async function removeStudioLock(file: string, pid: number, io: Io): Promise<void> {
	const lock = `${file}.lock`;
	try {
		if (!(await io.exists(lock))) return;
		const holder = (await io.readTextFile(lock)).split(/\r?\n/)[0]?.trim();
		if (holder !== String(pid)) return;
	} catch {
		return;
	}

	// Windows can hold the file for a moment after the process has gone, and refuses to remove it
	// meanwhile (measured: three locks of four were still there after a run), so it is tried again.
	const removing = io.interruption.hold(`Studio's lock file ${lock}, which names a process that has ended`);
	try {
		for (let attempt = 0; attempt < LOCK_REMOVAL_ATTEMPTS; attempt += 1) {
			try {
				await io.removeFile(lock);
				if (!(await io.exists(lock))) return;
			} catch {
				// Still held: try again below.
			}
			await io.sleep(500);
		}
	} finally {
		removing();
	}
	// A lock that cannot be removed is left where it is: it only needs ignoring.
}

/** How the window a run opened is named in what it holds: `the Studio window it opened (PID 4001, place.rbxl)`. */
function ownWindow(pid: number | undefined, name: string): string {
	return `the Studio window it opened (PID ${pid ?? "unknown"}, ${name})`;
}

/**
 * Closes the window a run opened, by the process it started (the file alone when the launch could
 * not tell), and nothing else: another window with the same file open is named, not closed.
 * `release` lets go of the run's hold on the window once it is closed.
 */
async function closeOwnWindow(pid: number | undefined, file: string, io: Io, release: Release): Promise<void> {
	const name = basename(file);
	const windows = await closeWindows(pid !== undefined ? { pid, file } : { file }, name, io, { gone: release });
	const closed = windows.some((window) => ["closed", "forced", "ended"].includes(window.outcome));
	// Not closed by this run: an interrupted run says so, rather than that it closed the window.
	release(closed ? undefined : `${ownWindow(pid, name)} had already closed`);
	if (!closed) {
		io.log(
			pid !== undefined
				? `${name} had already closed: the Studio this run started (PID ${pid}) no longer has it open`
				: `${name} had already closed: no Studio window has it open`,
		);
	}
	for (const other of windows.filter((window) => window.outcome === "untouched")) {
		io.error(
			`note: another Studio window has ${name} open (${describeWindow(other)}); this run did not open it, so it was left open`,
		);
	}
}

/** Prints an error the way `main` does, for one a run reports and carries on past. */
function printError(error: unknown, io: Io): void {
	io.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	if (error instanceof CliError && error.hint) io.error(error.hint);
}

/**
 * `studio close`: the window the proxy lists, by its title, which is all that is known of a window
 * this invocation did not open. Several windows with that title are ambiguous and none is closed.
 */
async function cmdStudioClose(flags: Flags, io: Io): Promise<number> {
	return await withStudio(flags, io, async (_client, studio) => {
		const name = placeNameOf(studio.name);
		const title = `${name} - Roblox Studio`;
		const windows = await closeWindows({ title }, name, io, {
			cutShort: `the window "${title}", whose close was cut short: it may still be open, showing its save prompt`,
		});

		const untouched = windows.filter((window) => window.outcome === "untouched");
		if (untouched.length > 0) {
			throw new CliError(
				`${untouched.length} windows are titled like "${title}", so none was closed: ${untouched.map(describeWindow).join("; ")}`,
				"close the one you mean by hand",
			);
		}
		if (windows.length === 0) {
			throw new CliError(
				`no window titled "${title}" was found to close`,
				"its title may have changed; close it by hand",
			);
		}
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
		// Studio has no way to stop a snippet it was sent: one that Ctrl+C stops waiting for runs on.
		const sent = io.interruption.hold(
			`the Luau sent to ${studio.name} (${dataModel}), which runs on there until it returns`,
		);
		let answer: string;
		try {
			answer = await client.call(
				"execute_luau",
				{ studio_id: studio.id, datamodel_type: dataModel, code: raw.script },
				parseDurationMs(flags.timeout ?? DEFAULT_TIMEOUT, 120_000),
			);
		} catch (error) {
			rethrowInterrupted(error);
			sent();
			throw new CliError(`the Luau failed in ${dataModel}: ${luauErrorMessage(error)}`);
		}
		sent();
		io.log(answer);
		return 0;
	});
}

/**
 * Runs the tests of each realm in a play session of the window, starting one when none is
 * running and stopping it afterwards unless `--keep`. Every realm is run even after one fails,
 * whether its tests failed, it never answered, or the call itself failed (no test host, say); the
 * exit code is the worst of them.
 *
 * With several realms, a `--sections` entry only one realm has is not a miss in the other: each
 * realm's tests decide its own verdict, and an entry fails the run only when no realm matched it.
 *
 * `window` is the run's hold on the window it opened, when it opened one: the play session ends
 * with that window, so closing it lets the session go too.
 */
async function runRealms(
	client: StudioClient,
	studio: StudioEntry,
	realms: Array<"Server" | "Client">,
	flags: Flags,
	io: Io,
	window?: Release,
): Promise<number> {
	const filter: Filter = parseSections(flags.sections);
	const script = renderStudioRun(renderFilter(filter), renderOptions({ list: flags.list === true }));
	const state = () => client.call("get_studio_state", { studio_id: studio.id }, 30_000);

	let startedHere = false;
	let releaseSession = () => {};
	// The session this run started is stopped as part of its cleanup, whenever Ctrl+C comes.
	const stopSession = async (): Promise<void> => {
		await io.interruption.cleanup(() => stopPlay(client, studio, io));
		releaseSession();
		io.log("play session stopped (--keep leaves it running)");
	};
	if (!isPlaying(await state())) {
		io.log("starting a play session...");
		const within = window !== undefined ? { within: window } : {};
		releaseSession =
			flags.keep === true
				? io.interruption.hold("the play session it started, which --keep leaves running", undefined, within)
				: io.interruption.hold("the play session it started", "stopped the play session it started", within);
		try {
			await client.call("start_stop_play", { studio_id: studio.id, is_start: true }, 180_000);
			startedHere = true;

			const deadline = io.now().getTime() + PLAY_START_TIMEOUT_MS;
			while (io.now().getTime() < deadline) {
				const current = await state();
				if (/Client/.test(current) && /Server/.test(current)) break;
				await io.sleep(1000);
			}
		} catch (error) {
			if (!(error instanceof Interrupted)) {
				releaseSession();
				throw error;
			}
			// Interrupted while the session started, or had just: it is this run's to stop all the same.
			if (flags.keep !== true) {
				try {
					await stopSession();
				} catch (stopError) {
					printError(stopError, io);
				}
			}
			throw error;
		}
	}

	try {
		let code = 0;
		let hinted = false;
		const several = realms.length > 1;
		const answered: Array<{ result: RunResult; results: string[] }> = [];
		for (const dataModel of realms) {
			const realm = dataModel.toLowerCase();
			io.log(`running the ${realm}'s tests in ${placeNameOf(studio.name)}...`);
			const timeout = flags.timeout ?? DEFAULT_TIMEOUT;

			let answer: string;
			try {
				answer = await client.call(
					"execute_luau",
					{ studio_id: studio.id, datamodel_type: dataModel, code: script },
					parseDurationMs(timeout, 120_000),
				);
			} catch (error) {
				rethrowInterrupted(error);
				code = 1;
				if (/timed out/.test(String(error))) {
					// Every test has `testing.timeout` of its own, so a realm that does not answer is
					// stuck somewhere the runner cannot see: the last test that reported places it.
					io.error(`the ${realm}'s run did not finish within ${timeout} (--timeout)`);
					io.error(await describeHangingTest(client, studio, dataModel));
				} else {
					const message = luauErrorMessage(error);
					io.error(`the ${realm}'s run failed: ${message}`);
					// Once a run: both realms are refused alike.
					if (isSandboxRefusal(message) && !hinted) {
						hinted = true;
						io.error(SANDBOX_HINT);
					}
				}
				continue;
			}

			const results = [unquoteLuauResult(answer)];
			const result = readRunResult(results, io);
			if (result === undefined) {
				code = 1;
				continue;
			}

			if (!several) {
				printResult(result, results, flags, io);
				code = Math.max(code, resultPassed(result) ? 0 : 1);
			} else {
				answered.push({ result, results });
			}
		}

		// With several realms, each realm's verdict waits for the others: an entry of the filter that
		// no realm has fails every realm that was given it, and the run, and is known only once every
		// realm has answered. A realm that did not answer has failed the run already.
		if (several) {
			const missed =
				answered.length === realms.length ? missedEverywhere(answered.map(({ result }) => result)) : [];
			const judged: RealmOfSeveral = { realmOfSeveral: true, missed };
			for (const { result, results } of answered) {
				printResult(result, results, flags, io, judged);
				code = Math.max(code, resultPassed(result, judged) ? 0 : 1);
			}
			if (missed.length > 0) {
				io.log("");
				io.log(`MISS matched nothing in any realm: ${missed.join(", ")}`);
				code = 1;
			}
		}
		return code;
	} finally {
		if (startedHere && flags.keep !== true) await stopSession();
	}
}

/**
 * Stops the play session. Studio refuses while the start it was asked for is still under way, which
 * is where a Ctrl+C during the start leaves it (the start takes about five seconds, and the run
 * stops waiting for it at once), so the stop is tried again until the start has finished, for up to
 * {@link PLAY_STOP_RETRY_MS}. A retried stop is waited for only as long as is left of that (or
 * {@link PLAY_STOP_ANSWER_MS}, when less is left), so a Studio that stops answering during the
 * retry holds the cleanup no longer than the retry, rather than for another stop's full timeout.
 */
async function stopPlay(client: StudioClient, studio: StudioEntry, io: Io): Promise<string> {
	const deadline = io.now().getTime() + PLAY_STOP_RETRY_MS;
	let told = false;
	let timeoutMs = PLAY_STOP_TIMEOUT_MS;
	for (;;) {
		try {
			return await client.call("start_stop_play", { studio_id: studio.id, is_start: false }, timeoutMs);
		} catch (error) {
			if (!/hasn't finished yet/i.test(String(error)) || io.now().getTime() >= deadline) throw error;
			if (!told) {
				told = true;
				io.log("the play session is still starting; it is stopped once it has");
			}
			await io.sleep(500);
			timeoutMs = Math.min(PLAY_STOP_TIMEOUT_MS, Math.max(deadline - io.now().getTime(), PLAY_STOP_ANSWER_MS));
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
		rethrowInterrupted(error);
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
 * The tests, run once per project the run follows: in Studio on this machine by default, in the
 * cloud with `--cloud`. One project is the plain run; several are run one after another, each
 * under its own heading and with its own place file, every one of them even after one fails,
 * with a line at the end saying how each fared. The exit code is the worst of them. What refuses
 * up front (a missing project file, no lune, no Studio) is checked before the first run starts.
 */
async function cmdTest(flags: Flags, io: Io): Promise<number> {
	if (flags.published && !flags.cloud) {
		throw new UsageError("--published is for the cloud: flamework-test test <file> --cloud --published");
	}
	if (flags.cloud) {
		placeFileOf(flags, "cloud test");
		requireCloudEntry(io);
	}

	const projects = projectsOf(flags, io);
	if (projects.length === 1) {
		return await testProject(flags, io, projects[0]!);
	}

	// Every project file is read before the first run, so a typo in the last does not cost the runs before it.
	for (const project of projects) await readProject(project, io);

	const outcomes: Array<{ project: ProjectChoice; code: number }> = [];
	for (const project of projects) {
		// A Ctrl+C during the last project's cleanup lets that finish; the next project does not start.
		io.interruption.check();
		io.log("");
		io.log(`=== ${project.name}: ${relative(io.cwd, project.path)} ===`);
		outcomes.push({ project, code: await testProject(flags, io, project) });
	}

	io.log("");
	io.log(
		`projects: ${outcomes.map(({ project, code }) => `${project.name} ${code === 0 ? "passed" : "FAILED"}`).join(", ")}`,
	);
	return Math.max(...outcomes.map(({ code }) => code));
}

async function testProject(flags: Flags, io: Io, project: ProjectChoice): Promise<number> {
	if (flags.cloud) return await cloudTestProject(flags, io, project);
	return await studioTestProject(flags, io, project);
}

/**
 * The default way to run the tests: the place Rojo built, opened in Studio on this machine, run
 * on both realms in a play session, and closed again. A window that already has that very file
 * open is from an earlier build and would test stale code, so it is closed first and the file
 * opened afresh; windows of other files are never touched, whatever their names. The window this
 * run opens is known by the process it started, which is what closes it, whether the run finished
 * or gave up on it (unless `--keep`); a window that will not close fails the run, naming it.
 */
async function studioTestProject(flags: Flags, io: Io, project: ProjectChoice): Promise<number> {
	const realms = realmsOf(flags.realm, "both");
	const { absolute: file, label } = await placeToRun(flags, io, "test", project);
	const name = basename(file);
	const exe = requireStudioExe(io);
	const keep = flags.keep === true;

	const client = await io.connectStudio();
	try {
		const staleLabel = `the window left from an earlier build of ${name}`;
		const stale = await closeWindows({ file }, staleLabel, io, {
			cutShort: `${staleLabel}, if there is one: its close was cut short, and it may still be open, showing its save prompt`,
		});
		if (stale.length > 0) await io.sleep(2000);

		let launched = false;
		let pid: number | undefined;
		let gaveUp = false;
		let releaseWindow: Release = () => {};
		// The run gives up on the window it opened; left open, it would only trip the next one.
		// Whether it is closed now, which is only known once the close has run. Ctrl+C gives up on it too.
		const giveUp = async (): Promise<boolean> => {
			gaveUp = true;
			if (keep) return false;
			try {
				await closeOwnWindow(pid, file, io, releaseWindow);
				return true;
			} catch (closeError) {
				printError(closeError, io);
				return false;
			}
		};

		let code: number;
		// The name is held from before the proxy is looked at until this run's window is listed, or
		// until the window it gave up on is closed: another run of a same-named file waits meanwhile.
		let release: (() => void) | undefined;
		try {
			release = await io.claimWindowName(name, (holder) =>
				io.log(
					`waiting for another flamework-test run (PID ${holder}) to finish opening its ${name} window...`,
				),
			);
			// Whatever the proxy lists now is not this run's window, even when it has the same name.
			const before = new Set((await client.studios()).map((entry) => entry.id));
			pid = await io.launch([exe, ...studioOpenArguments({ file })]);
			launched = true;
			const window = ownWindow(pid, name);
			releaseWindow = keep
				? io.interruption.hold(`${window}, which --keep leaves open`)
				: io.interruption.hold(window, `closed ${window}`);
			io.log(`opening ${label} in Studio; waiting for it to connect...`);

			// The proxy says nothing of the process behind an entry, so a new entry of this name is
			// this run's only when every other window showing a file of this name is accounted for by
			// an entry listed before the launch. One that has not registered yet could own the new
			// entry, so it is waited for; two new entries cannot be told apart, so they are refused.
			let others: StudioWindow[] = [];
			let unaccounted = false;
			const studio = await waitForStudio(
				client,
				async (studios) => {
					const named = studios.filter((entry) => entry.name === name || placeNameOf(entry.name) === name);
					const fresh = named.filter((entry) => !before.has(entry.id));
					if (fresh.length === 0) return undefined;
					others = (await io.studioWindows()).filter(
						(window) => window.pid !== pid && titleShowsFile(window.title, name),
					);
					if (fresh.length > 1) {
						throw cannotTell(
							name,
							"another window of that name registered with it at the same time",
							others,
						);
					}
					unaccounted = named.length < others.length + (pid !== undefined ? 1 : 0);
					return unaccounted ? undefined : fresh[0];
				},
				flags,
				io,
			);
			if (studio === undefined) {
				const closed = await giveUp();
				throw unaccounted
					? cannotTell(
							name,
							"another Studio window showing a file of that name has not registered with it",
							others,
						)
					: neverConnected(label, keep ? "open" : closed ? "closed" : "unstated");
			}
			release();
			release = undefined;
			io.log(`connected: ${studio.name} (${studio.id})`);

			code = await runRealms(client, studio, realms, flags, io, releaseWindow);
		} catch (error) {
			if (launched && !gaveUp) await giveUp();
			throw error;
		} finally {
			release?.();
		}

		if (keep) {
			io.log("Studio left open (--keep)");
			return code;
		}
		try {
			await closeOwnWindow(pid, file, io, releaseWindow);
		} catch (error) {
			// The results stand, but the run did not clean up after itself, and fails saying so.
			printError(error, io);
			return 1;
		}
		return code;
	} finally {
		client.close();
	}
}

// ------------------------------------------------------------------- main

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
	const interruption = new Interruption();
	const io = resolveDeps(deps, interruption);

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

	// Ctrl+C is heard while the command runs: the first unwinds it through its own cleanup, which
	// then says what it cleaned up and what was left; a second exits at once, however soon it comes,
	// naming what may be left. One press is one signal: neither cmd, `bun run` (nested, or from a
	// script) nor the bin shim was measured to repeat one (2026-10-02).
	const stopListening = io.onInterrupt((signal) => {
		if (interruption.interrupt(signal)) {
			io.error("");
			io.error(
				`${describeSignal(signal)}: stopping, and cleaning up what this run started (${describeSignal(signal)} again exits at once)`,
			);
			return;
		}
		io.error(interruption.abandoned(signal));
		io.exit(interruptedExitCode(interruption.by ?? signal));
	});
	try {
		const code = await runCommand(parsed.command, parsed.flags, io);
		if (!interruption.interrupted) return code;
		io.error(interruption.summary());
		return interruptedExitCode(interruption.by!);
	} finally {
		stopListening();
	}
}

async function runCommand(command: string, flags: Flags, io: Io): Promise<number> {
	try {
		switch (command) {
			case "test":
				return await cmdTest(flags, io);
			case "patch":
				return await cmdPatch(flags, io);
			case "studio open":
				return await cmdStudioOpen(flags, io);
			case "studio close":
				return await cmdStudioClose(flags, io);
			case "studio status":
				return await cmdStudioStatus(flags, io);
			case "studio play":
				return await cmdStudioPlay(flags, io, true);
			case "studio stop":
				return await cmdStudioPlay(flags, io, false);
			case "studio exec":
				return await cmdStudioExec(flags, io);
			case "studio run":
				return await cmdStudioRun(flags, io);
			case "cloud publish":
				return await cmdPublish(flags, io);
			case "cloud run":
				return await cmdRun(flags, io, "run");
			case "cloud probe":
				return await cmdRun(flags, io, "probe");
			case "cloud test":
				return await cmdCloudTest(flags, io);
			default:
				io.error(`error: unknown command: ${command}`);
				io.error("");
				io.error(USAGE);
				return 2;
		}
	} catch (error) {
		// Interrupted: what it cleaned up is said once the command has unwound, by main.
		if (error instanceof Interrupted) return interruptedExitCode(error.signal);
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
