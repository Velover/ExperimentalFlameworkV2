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
import { findProjectRoot, loadCloudSettings, type CloudSettings } from "./config.ts";
import {
	describeSignal,
	Interrupted,
	interruptedExitCode,
	Interruption,
	rethrowInterrupted,
	type Release,
} from "./interrupt.ts";
import { keepDisplayAwake, setThreadExecutionState, type SetExecutionState } from "./keepAwake.ts";
import {
	fileLockStore,
	judgeLock,
	leaseFrom,
	newToken,
	stateDirOf,
	type ClosedWindowRecord,
	type LockOwner,
	type LockStore,
	type LockView,
	type ProbeProcesses,
	type ProcessInfo,
} from "./lock.ts";
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
	skipFailureNote,
	type Judgement,
	type RunResult,
} from "./results.ts";
import {
	claimWindowName,
	connectStudio,
	findStudioExe,
	findStudio,
	findStudioForPlace,
	findStudioMcp,
	isCapabilityRefusal,
	isPlaying,
	isSandboxRefusal,
	listStudioWindows,
	luauErrorMessage,
	placeNameOf,
	probeProcesses,
	renderStudioRun,
	runCloseScript,
	SANDBOX_HINT,
	SNIPPET_SANDBOX_HINT,
	studioOpenArguments,
	textOf,
	titleShowsFile,
	toolErrorMessage,
	unquoteLuauResult,
	type CloseTarget,
	type ClosedWindow,
	type DataModelType,
	type StudioClient,
	type StudioEntry,
	type StudioWindow,
	type ToolInfo,
	type ToolResult,
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
/** How long `lune --version` may take: lune is checked for before anything opens or uploads. */
export const LUNE_VERSION_TIMEOUT_MS = 60_000;
/**
 * How long a patch may take: lune laying the build over a copy of the original place, or setting a
 * project's properties on it, takes seconds. A lune that hangs is stopped past it, rather than
 * holding the run, and between two projects the Studio lock, for as long as the CLI lives.
 */
export const PATCH_TIMEOUT_MS = 300_000;
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
/**
 * How long a command that opens a Studio window waits for the Studio lock, in seconds: long enough
 * to ride out another agent's test run (one to three minutes), short enough that a wait and a run
 * of its own fit in the ten minutes an agent's tool call allows at most, so the agent reads the
 * message saying what holds the lock rather than being cut off. `--lock-timeout`,
 * FLAMEWORK_TEST_LOCK_TIMEOUT and `testing.lockTimeout` change it; 0 does not wait.
 */
export const LOCK_TIMEOUT_SECONDS = 300;
/**
 * How long a window flamework-test opened may sit unused before another project may close it and
 * take the Studio lock, in minutes. Longer than an agent's pause between two commands in its
 * window (reading a result, changing code, rebuilding), short enough that a forgotten window frees
 * Studio within a quarter of an hour. A running `test` keeps its window in use. `--hold`,
 * FLAMEWORK_TEST_LOCK_HOLD and `testing.lockHold` change it.
 */
export const LOCK_HOLD_MINUTES = 15;
/** The shortest hold, in minutes: twice the heartbeat, so a lease never lapses between two renewals. */
export const LOCK_HOLD_LEAST_MINUTES = 1;
/** How often a command waiting for the Studio lock tries it again. */
export const LOCK_POLL_MS = 2000;
/** How often a waiting command looks the holder's processes up again, to see whether it has gone. */
export const LOCK_PROBE_MS = 10_000;
/** How often a waiting command says again what it waits for. */
export const LOCK_REMIND_MS = 60_000;
/** How often a command that uses its window renews the lease while it runs: half the shortest hold. */
export const LEASE_HEARTBEAT_MS = 30_000;
/**
 * The tools of Studio's MCP proxy known to act on no window: `studio call` sends them without one.
 * Every other tool the proxy offers takes a `studio_id` (checked against the live tool list on
 * 2026-10-04); one that does not is sent only with `--any-window`, since the CLI cannot tell which
 * window it would act on.
 */
export const WINDOWLESS_TOOLS: readonly string[] = ["list_roblox_studios"];
/** How often, half a second apart, a windowless call from a proxy still joining the hub is tried, as listing the windows is. */
export const WINDOWLESS_ATTEMPTS = 20;

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
	"fail-on-skip": "boolean",
	"keep-awake": "boolean",
	"testing-universe": "string",
	"testing-place": "string",
	key: "string",
	studio: "string",
	"lock-timeout": "string",
	hold: "string",
	"any-window": "boolean",
	"args-file": "string",
	force: "boolean",
	"check-window": "boolean",
	help: "boolean",
};

const COMMON_FLAGS = ["testing-universe", "testing-place", "key", "help"];
/** `studio` commands may name their window; every other way of finding it is automatic. */
const STUDIO_FLAGS = ["studio"];
/** What a command that changes a window takes: its window, and leave to act on one flamework-test did not open for this project. */
const CHANGING_FLAGS = ["studio", "any-window"];
/** Commands that open a Studio window, and so take the Studio lock. */
const LOCK_FLAGS = ["lock-timeout", "hold"];
/** Commands that take a file as a positional argument as well as `--file`. */
const FILE_COMMANDS = ["test", "patch", "studio open", "cloud publish", "cloud test"];
const PATCH_FLAGS = ["original", "project"];
const PUBLISH_FLAGS = ["file", "published", ...PATCH_FLAGS];
const RUN_FLAGS = ["version", "sections", "list", "timeout", "code", "script", "dry-run", "json", "fail-on-skip"];
const REPORT_FLAGS = ["sections", "list", "json", "timeout", "fail-on-skip"];

const COMMANDS: Record<string, string[]> = {
	test: ["file", "realm", "keep", "keep-awake", "cloud", ...PATCH_FLAGS, ...REPORT_FLAGS, "published", ...LOCK_FLAGS],
	patch: ["file", "out", ...PATCH_FLAGS],
	"studio open": ["file", "timeout", "json", ...LOCK_FLAGS],
	"studio close": CHANGING_FLAGS,
	"studio status": STUDIO_FLAGS,
	"studio play": CHANGING_FLAGS,
	"studio stop": CHANGING_FLAGS,
	"studio exec": ["code", "script", "realm", "timeout", ...CHANGING_FLAGS],
	"studio run": ["realm", "keep", "keep-awake", ...REPORT_FLAGS, ...CHANGING_FLAGS],
	"studio list": ["json"],
	"studio tools": ["json"],
	"studio call": ["args-file", "out", "json", "timeout", ...CHANGING_FLAGS],
	"studio lock": ["json", "check-window"],
	"studio unlock": ["force"],
	"cloud publish": PUBLISH_FLAGS,
	"cloud run": RUN_FLAGS,
	"cloud test": [...PUBLISH_FLAGS, ...RUN_FLAGS],
	"cloud probe": ["version", "timeout", "json", "dry-run"],
	help: [],
};

const GROUPS: Record<string, string> = {
	studio: "open, close, status, play, stop, exec, run, list, tools, call, lock, unlock",
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
	/** A skipped test fails the run; a run resolves it from FAIL_ON_SKIP and testing.failOnSkip too. */
	"fail-on-skip"?: boolean;
	/** A Studio run keeps the display on; after it, KEEP_AWAKE and testing.keepAwake. */
	"keep-awake"?: boolean;
	"testing-universe"?: string;
	"testing-place"?: string;
	key?: string;
	studio?: string;
	/** Seconds a command that opens a window waits for the Studio lock; after it, FLAMEWORK_TEST_LOCK_TIMEOUT and testing.lockTimeout. */
	"lock-timeout"?: string;
	/** Minutes the window a command leaves open may sit unused; after it, FLAMEWORK_TEST_LOCK_HOLD and testing.lockHold. */
	hold?: string;
	/** Acts on a window flamework-test did not open for this project. */
	"any-window"?: boolean;
	/** `studio call`: the tool's arguments, as JSON in a file. */
	"args-file"?: string;
	/** `studio unlock`: frees a live lock too, closing its window. */
	force?: boolean;
	/** `studio lock`: asks the MCP proxy whether the holder's window is on it. */
	"check-window"?: boolean;
	help?: boolean;
	/** `studio tools <name>`, `studio call <name>`: the tool, a positional argument. */
	tool?: string;
	/** `studio call <name> <json>`: the tool's arguments, a positional argument. */
	arguments?: string;
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

		// `studio tools [name]` and `studio call <name> [json]`: the tool, and its arguments.
		if (command === "studio tools" || command === "studio call") {
			const [tool, json, ...extra] = positionals;
			const most = command === "studio tools" ? 1 : 2;
			const unexpected = [json, ...extra].slice(most - 1).find((value) => value !== undefined);
			if (unexpected !== undefined) {
				throw new UsageError(
					command === "studio call"
						? `unexpected argument: ${unexpected}; the tool's arguments are one JSON object (quote it whole, or put it in a file for --args-file)`
						: `unexpected argument: ${unexpected}`,
				);
			}
			if (tool !== undefined) flags.tool = tool;
			if (json !== undefined) flags.arguments = json;
			positionals.length = 0;
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
  studio open [file]  open the testing place from the cloud, or a local place file, in Studio, and
                      print its MCP id:  studio_id=<id> pid=<pid>
  studio close        close the window flamework-test opened for this project
  studio status       what that window reports: edit or play, which data models exist
  studio play         start a play session in it;  studio stop  ends one
  studio exec         run Luau in it:  --code "<luau>" | --script <file>  [--realm edit|server|client]
  studio run          run the tests in it, in a play session, without opening or closing anything
  studio list         the windows on the MCP proxy: id, place, whether flamework-test opened it
  studio tools [name] the proxy's tools, read live; with a name, its description and arguments
  studio call <tool> [json-args]   call any tool; --studio <id> fills in its studio_id
  studio lock         who holds the Studio lock, and whether it is live, expired or stale
  studio unlock       free a stale or expired lock (closing an expired window); --force: a live one

One Studio window opened through flamework-test at a time on this machine: test and studio open
take the Studio lock before they launch Studio and wait while another project holds it. A running
command holds it to its end; a window left open holds it until it closes, or until it has been
idle past its hold (then the next taker closes it). The lock lives in %LOCALAPPDATA%\\flamework-test
on Windows ($FLAMEWORK_TEST_STATE_DIR moves it). close, play, stop, exec, run and call act only on
the window flamework-test opened for this project; --any-window acts on another, and needs the
user's go-ahead for a window they have open.

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
             --fail-on-skip          a skipped test fails the run, for CI that must run everything
                                     (default: $FAIL_ON_SKIP, else testing.failOnSkip; off)
             --keep-awake            keep the display on while the run lasts: RenderStepped stops
                                     while it sleeps, which fails onRender tests in a run nobody
                                     watches; Windows only, not with --cloud (default: $KEEP_AWAKE,
                                     else testing.keepAwake; off)
             --lock-timeout <seconds>  how long to wait for the Studio lock; 0 does not wait
                                     (default: $FLAMEWORK_TEST_LOCK_TIMEOUT, else
                                     testing.lockTimeout, else ${LOCK_TIMEOUT_SECONDS})
             --hold <minutes>        with --keep: how long the window may sit unused before another
                                     project may close it, ${LOCK_HOLD_LEAST_MINUTES} or more (default:
                                     $FLAMEWORK_TEST_LOCK_HOLD, else testing.lockHold, else ${LOCK_HOLD_MINUTES})
  patch      --out <path>            where the patched place goes; default <file>.patched.rbxl, or
                                     <file>.<project>.rbxl under a chosen --project (one project)
  studio run --realm server|client|both   default server
             --keep                  leave the play session running afterwards
             --sections, --list, --json, --timeout, --fail-on-skip, --keep-awake   as for test
  studio exec --realm edit|server|client  default edit
  studio open --json                 print the window as JSON;  --lock-timeout, --hold  as for test
  studio call --args-file <file>     the tool's arguments as JSON in a file (no shell quoting)
             --out <dir>             where image answers (screen_capture) are written; default
                                     <temp>/flamework-test/captures
             --json                  print the tool's raw answer;  --timeout <120s>
                                     a tool that takes no studio_id (but list_roblox_studios) is
                                     sent only with --any-window: which window it acts on is unknown
  studio list, tools, lock  --json   as JSON
  studio lock --check-window         also ask the MCP proxy whether the holder's window is on it
  studio unlock --force              also free a live lock, closing its window (flamework-test's only)
  studio *   --studio <name|id>      which window; default: the one flamework-test opened for this
                                     project (status, with none open: the one with the testing place
                                     open, else the only one with a local place file open)
             --any-window            act on a window flamework-test did not open for this project
                                     (close, play, stop, exec, run, call); ask the user first
  cloud publish --published          publish live instead of uploading a Saved version
             --original, --project   as for test (one project: one version is published)
  cloud run  --version <n>           default: ${VERSION_FILE}, else the current version
             --code "<luau>"         run this Luau instead of the test shim
             --script <file>         run this Luau file instead of the test shim
             --dry-run               print the request that would be sent, then stop
             --sections, --list, --json, --timeout, --fail-on-skip   as for test (timeout: the
                                     task's, max 300s)
  common     --testing-universe <id> default: $TESTING_UNIVERSE_ID, else cloud.testingUniverseId
             --testing-place <id>    default: $TESTING_PLACE_ID, else cloud.testingPlaceId
             --key <apiKey>          default: $ROBLOX_API_KEY, else cloud.apiKey; prefer the
                                     environment, a flag lands in the shell history
             -h, --help

Settings come from flags, then the shell environment, then .env and .env.local next to the
nearest flamework.config.json, then that file's "cloud" section (and the "testing" keys below),
which may itself use \${NAME}:
  "cloud": { "testingUniverseId": "...", "testingPlaceId": "...", "apiKey": "\${ROBLOX_API_KEY:-}",
             "originalPlace": "places/original.rbxl" }
A cloud run also needs "testing": { "entry": "src/server/main" }, the ModuleScript that ignites
the game: a cloud task runs none of the place's Scripts, so the runner has to. Studio needs nothing.
"testing": { "failOnSkip": true, "keepAwake": true } turns those two on; --fail-on-skip=false and
--keep-awake=false turn them off for one run. "testing": { "lockTimeout": 300, "lockHold": 15 } sets
the Studio lock's wait (seconds) and hold (minutes).

Environment (the shell, .env or .env.local):
  ROBLOX_API_KEY                          Open Cloud key: universe-places:write and
  (or TESTING_PLACE_API_KEY)              universe.place.luau-execution-session:read/:write
  TESTING_UNIVERSE_ID, TESTING_PLACE_ID   the testing experience and the place inside it
  ORIGINAL_PLACE                          a copy of the original place, for --original
  ROJO_PROJECT                            the project(s) a run follows, comma-separated, for --project
  FAIL_ON_SKIP, KEEP_AWAKE                true or false (1 or 0), for --fail-on-skip and --keep-awake
  FLAMEWORK_TEST_LOCK_TIMEOUT             seconds, for --lock-timeout
  FLAMEWORK_TEST_LOCK_HOLD                minutes, for --hold
  FLAMEWORK_TEST_STATE_DIR                where the Studio lock lives; every project must agree on it,
                                          so set it in the shell, never in a project's .env (Bun loads
                                          the .env of the folder a command runs in, which moves it)
  LUNE_EXE, ROBLOX_STUDIO_EXE, STUDIO_MCP_EXE   overrides for the tools this finds by itself

Examples:
  rojo build -o place.rbxl && flamework-test test place.rbxl
  rojo build -o place.rbxl && flamework-test test place.rbxl --sections economy --keep
  rojo build -o place.rbxl && flamework-test test place.rbxl --project tests/deferred.project.json
  rojo build -o place.rbxl && flamework-test test place.rbxl --cloud
  flamework-test cloud run --sections economy       again, against the version last published
  flamework-test studio open && flamework-test studio run --realm client
  flamework-test studio open place.rbxl         then, with the id it prints:
  flamework-test studio call screen_capture --studio <id> --args-file capture.json
  flamework-test studio close

Ctrl+C stops a run and cleans up what it started: the play session, the Studio window it opened
and the Studio lock (unless --keep), its temp files and child processes, and the keep-awake
request; a second Ctrl+C exits at once. A Ctrl+C while waiting for the Studio lock holds nothing.
A task already created on Open Cloud runs on: Open Cloud cannot cancel one.

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
	/**
	 * Runs a child process with inherited output; resolves with its exit code, or throws when it
	 * cannot start. Past `timeoutMs` the child is ended, and it rejects with {@link ChildTimedOut}.
	 */
	spawn?: (command: string[], cwd: string, timeoutMs?: number) => Promise<number>;
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
	/** `process.platform` by default: keep-awake asks only Windows. */
	platform?: string;
	/** kernel32's SetThreadExecutionState, through bun:ffi by default: what keep-awake calls. */
	setExecutionState?: SetExecutionState;
	/**
	 * The machine-wide Studio lock; by default the folder `studio-lock` of the per-user state folder
	 * (`%LOCALAPPDATA%\flamework-test` on Windows, `FLAMEWORK_TEST_STATE_DIR`; see `stateDirOf`).
	 */
	studioLock?: LockStore;
	/** The project a command in `cwd` runs for: see `findProjectRoot`. */
	projectRoot?: (cwd: string) => string;
	/** Looks processes up by PID (name and start time); a PID missing from the answer runs nothing. */
	probeProcesses?: ProbeProcesses;
	/** This process, as the Studio lock's owner record names it. */
	self?: () => SelfInfo;
	/** Writes a file of bytes, making its folder; what `studio call` does with an image answer. */
	writeBinaryFile?: (path: string, data: Uint8Array) => Promise<void>;
}

/** This process: its PID, its name (`bun`) and when it started (milliseconds since the epoch). */
export interface SelfInfo {
	pid: number;
	name: string;
	startedAt: number;
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

/** A child process that ran past its timeout, and was ended. */
export class ChildTimedOut extends Error {
	constructor(
		readonly command: string[],
		readonly timeoutMs: number,
	) {
		super(`${basename(command[0] ?? "")} did not finish within ${timeoutMs / 1000}s, and was stopped`);
	}
}

/**
 * Runs a child process with inherited output and resolves with its exit code. `signal` ends it (a
 * Ctrl+C); past `timeoutMs` it is ended too, and the run rejects with {@link ChildTimedOut}.
 * `interrupted` says whether the run has been interrupted, when the child's failure is reported.
 */
export async function runInheriting(
	command: string[],
	cwd: string,
	options: { signal?: AbortSignal; interrupted?: () => boolean; timeoutMs?: number } = {},
): Promise<number> {
	const child = Bun.spawn({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" });
	// On this console the child hears a Ctrl+C itself, and is ended here in case it outlives it.
	const end = () => child.kill();
	options.signal?.addEventListener("abort", end, { once: true });
	let timedOut = false;
	const timer =
		options.timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeoutMs)
			: undefined;
	try {
		const code = await child.exited;
		if (timedOut) throw new ChildTimedOut(command, options.timeoutMs!);
		// The Ctrl+C that ended the child can reach it before it reaches this process: a moment's
		// wait lets it arrive, so the run reports the interruption rather than the child's failure.
		if (code !== 0 && options.interrupted?.() !== true) await pause(100);
		return code;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		options.signal?.removeEventListener("abort", end);
	}
}

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
		((command: string[], cwd: string, timeoutMs?: number) =>
			runInheriting(command, cwd, {
				signal: interruption.abortSignal,
				interrupted: () => interruption.interrupted,
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			}));
	const launch =
		deps.launch ??
		(async ([exe, ...args]: string[]) => {
			// Detached, or Windows takes Studio down with this process when it exits.
			const child = spawn(exe!, args, { detached: true, stdio: "ignore", windowsHide: false });
			child.unref();
			// Studio opens the file in the process started here, so this is the window's process.
			return child.pid;
		});
	// Per user, never the temp folder, which an agent's harness may set per agent: the window-name
	// claims and the Studio lock have to be seen by every flamework-test of this user.
	const claimDir = stateDirOf(env);
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
					"StudioMCP.exe, Roblox Studio's MCP proxy, was not found under Roblox Studio's versions folder (%LOCALAPPDATA%\\Roblox\\Versions), so no Studio window can be driven from here",
					"install Roblox Studio on this machine (the proxy ships with it), or set STUDIO_MCP_EXE to the file's path; to run the tests without Studio, use the cloud: flamework-test test <file> --cloud",
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
		spawn: async (command, cwd, timeoutMs) => {
			interruption.check();
			const name = basename(command[0] ?? "").replace(/\.exe$/i, "");
			// Bun ends the children it started when this process exits (measured: lune, PowerShell and
			// the proxy alike; only Studio, launched detached, outlives it), so exiting at once leaves none.
			const release = interruption.hold(`${name}, which this run started`, `stopped ${name}`, {
				endsWithProcess: true,
			});
			try {
				return await interruption.run(() => spawnChild(command, cwd, timeoutMs));
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
			const client = await interruption.run(connect, (late) => void late.close());
			const proxy = `the MCP proxy (StudioMCP.exe${client.pid !== undefined ? `, PID ${client.pid}` : ""})`;
			// The proxy ends with this process, as every child Bun started does (measured 2026-10-01).
			const held = interruption.hold(proxy, `closed ${proxy}`, { endsWithProcess: true });
			return {
				call: (name, args, timeoutMs) => interruption.run(() => client.call(name, args, timeoutMs)),
				callRaw: (name, args, timeoutMs) => interruption.run(() => client.callRaw(name, args, timeoutMs)),
				tools: () => interruption.run(() => client.tools()),
				studios: () => interruption.run(() => client.studios()),
				// Waited for, a Ctrl+C or not: the proxy is let go of in order, a moment at most.
				close: async () => {
					try {
						await client.close();
					} finally {
						held();
					}
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
		platform: deps.platform ?? process.platform,
		setExecutionState: deps.setExecutionState ?? setThreadExecutionState,
		// A sub-lock's holder is looked up by its start time too, once it has held it a while.
		studioLock: deps.studioLock ?? fileLockStore(claimDir, { probe: deps.probeProcesses ?? probeProcesses }),
		projectRoot: deps.projectRoot ?? ((at) => findProjectRoot(at)),
		probeProcesses: deps.probeProcesses ?? probeProcesses,
		self:
			deps.self ??
			(() => ({
				pid: process.pid,
				name: basename(process.execPath).replace(/\.exe$/i, ""),
				startedAt: Date.now() - process.uptime() * 1000,
			})),
		writeBinaryFile:
			deps.writeBinaryFile ??
			(async (path, data) => {
				await mkdir(dirname(path), { recursive: true });
				await Bun.write(path, data);
			}),
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

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["", "0", "false", "no", "off"];

/**
 * A yes-or-no setting, from the first of: the flag (`--fail-on-skip`, or `--fail-on-skip=false` to
 * turn off for one run what the others turn on), the variable from the shell, else from `.env` or
 * `.env.local` (`1`, `true`, `yes`, `on`, or `0`, `false`, `no`, `off`; empty is off, as an empty
 * `ROJO_PROJECT` is none), the config file's key; else off. Anything else in the variable is refused.
 */
function booleanSetting(flag: boolean | undefined, variable: string, configured: boolean | undefined, io: Io): boolean {
	if (flag !== undefined) return flag;
	const value = envOf(io, variable);
	if (value !== undefined) {
		const word = value.trim().toLowerCase();
		if (TRUE_WORDS.includes(word)) return true;
		if (FALSE_WORDS.includes(word)) return false;
		throw new UsageError(`${variable} must be true or false (or 1 or 0), got "${value}"`);
	}
	return configured ?? false;
}

/** Whether a skipped test fails the run: `--fail-on-skip`, `FAIL_ON_SKIP`, `testing.failOnSkip`. */
function failOnSkipOf(flags: Flags, io: Io): boolean {
	return booleanSetting(flags["fail-on-skip"], "FAIL_ON_SKIP", settingsOf(io).failOnSkip, io);
}

/** Whether a Studio run keeps the display on: `--keep-awake`, `KEEP_AWAKE`, `testing.keepAwake`. */
function keepAwakeOf(flags: Flags, io: Io): boolean {
	return booleanSetting(flags["keep-awake"], "KEEP_AWAKE", settingsOf(io).keepAwake, io);
}

/**
 * A number setting, from the first of: the flag, the variable (shell, `.env`, `.env.local`), the
 * config key; else the default. Anything but a number in the flag or the variable is refused, as
 * is one below `least`.
 */
function numberSetting(
	flag: string | undefined,
	flagName: string,
	variable: string,
	configured: number | undefined,
	fallback: number,
	io: Io,
	options: { least: number; unit: string; key: string },
): number {
	const wanted = `a number of ${options.unit}, ${options.least} or more`;
	const check = (value: number, from: string): number => {
		if (!Number.isFinite(value) || value < options.least) {
			throw new UsageError(`${from} must be ${wanted}, got "${String(value)}"`);
		}
		return value;
	};
	const parse = (text: string, from: string): number => {
		const trimmed = text.trim();
		if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
			throw new UsageError(`${from} must be ${wanted}, got "${text}"`);
		}
		return check(Number(trimmed), from);
	};
	if (flag !== undefined) return parse(flag, `--${flagName}`);
	const value = envOf(io, variable);
	if (value !== undefined && value.trim() !== "") return parse(value, variable);
	if (configured !== undefined) return check(configured, `testing.${options.key}`);
	return fallback;
}

/** How long, in milliseconds, a command waits for the Studio lock: `--lock-timeout`, the variable, the config key, 300 seconds. */
function lockTimeoutOf(flags: Flags, io: Io): number {
	return (
		numberSetting(
			flags["lock-timeout"],
			"lock-timeout",
			"FLAMEWORK_TEST_LOCK_TIMEOUT",
			settingsOf(io).lockTimeout,
			LOCK_TIMEOUT_SECONDS,
			io,
			{ least: 0, unit: "seconds", key: "lockTimeout" },
		) * 1000
	);
}

/**
 * How long, in minutes, the window a command opens may sit unused: `--hold`, the variable, the
 * config key, 15. One minute at least, twice the lease's heartbeat, so that a window in use never
 * lapses between two renewals.
 */
function holdOf(flags: Flags, io: Io): number {
	return numberSetting(
		flags.hold,
		"hold",
		"FLAMEWORK_TEST_LOCK_HOLD",
		settingsOf(io).lockHold,
		LOCK_HOLD_MINUTES,
		io,
		{ least: LOCK_HOLD_LEAST_MINUTES, unit: "minutes", key: "lockHold" },
	);
}

/**
 * The flags of a run with `--fail-on-skip` resolved from its variable and config key too, so that a
 * misspelt variable is refused before anything opens or uploads, and what runs reads one flag.
 */
function withRunSettings(flags: Flags, io: Io): Flags {
	return { ...flags, "fail-on-skip": failOnSkipOf(flags, io) };
}

/**
 * Runs `body` with the display kept on when `on` (see keepAwake.ts): from here to the run's end,
 * whichever way it ends. The request is let go when `body` returns or throws, a failure or a Ctrl+C
 * alike; a second Ctrl+C exits at once, and Windows lets go of the request with the process.
 */
async function withKeepAwake<T>(on: boolean, io: Io, body: () => Promise<T>): Promise<T> {
	if (!on) return await body();
	const release = keepDisplayAwake(io);
	try {
		return await body();
	} finally {
		release();
	}
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
		code = await io.spawn([exe, "--version"], io.cwd, LUNE_VERSION_TIMEOUT_MS);
	} catch (error) {
		rethrowInterrupted(error);
		if (error instanceof ChildTimedOut) {
			throw new CliError(
				`\`${exe} --version\` did not answer within ${span(LUNE_VERSION_TIMEOUT_MS)}, and was stopped, so lune could not be checked`,
				"check that `lune --version` answers in this shell, or set LUNE_EXE; nothing was run or uploaded",
			);
		}
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

	const out = patchedPlaceOf(built, project, flags, io);

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
		let code: number;
		try {
			code = await io.spawn(
				patchCommand(lune, taskPath, {
					original: original ?? builtPath,
					built: builtPath,
					out,
					plan: planPath,
				}),
				io.cwd,
				PATCH_TIMEOUT_MS,
			);
		} catch (error) {
			if (error instanceof ChildTimedOut) {
				throw new CliError(
					`the patch did not finish within ${span(PATCH_TIMEOUT_MS)}, and lune was stopped`,
					"nothing was run or uploaded; `flamework-test patch` runs the patch alone, to see where it stops",
				);
			}
			throw error;
		}
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

/** Where the place made under a project goes: `--out`, else beside the build, named after the project. */
function patchedPlaceOf(built: string, project: ProjectChoice, flags: Flags, io: Io): string {
	return resolve(io.cwd, flags.out ?? patchedPathFor(built, project));
}

/** The file {@link placeToRun} gives for a project, known before it is made. */
function plannedPlaceOf(flags: Flags, io: Io, command: string, project: ProjectChoice): string {
	const built = placeFileOf(flags, command);
	return originalPlaceOf(flags, io) !== undefined || project.chosen
		? patchedPlaceOf(built, project, flags, io)
		: resolve(io.cwd, built);
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
	if (scriptKind === "shim") flags = withRunSettings(flags, io);
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

	const judged: Judgement = { failOnSkip: flags["fail-on-skip"] === true };
	printResult(result, results, flags, io, judged);
	return resultPassed(result, judged) ? 0 : 1;
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

/**
 * How many tests the results a run has printed skipped, for the line a run under several projects
 * ends on.
 */
const skipTally = new WeakMap<Io, number>();

/**
 * Prints a result as `--json`, `--list` or the summary ask, judged as `options` says. Under
 * `--json`, a run its skips fail says so on stderr, outside the JSON, which is the place's own.
 */
function printResult(result: RunResult, results: string[], flags: Flags, io: Io, options?: Judgement): void {
	if (!flags.list) skipTally.set(io, (skipTally.get(io) ?? 0) + result.skipped);
	if (flags.json) {
		io.log(JSON.stringify(JSON.parse(results[0]!), null, 2));
		const note = flags.list ? undefined : skipFailureNote(result, options);
		if (note !== undefined) io.error(note);
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

// ------------------------------------------------------------- the Studio lock

/** The project a command runs for, looked up once per invocation. */
const projectCache = new WeakMap<Io, string>();

/**
 * The project a command runs for: the nearest folder holding a flamework.config.json, else the
 * nearest holding a package.json, else where it ran (see `findProjectRoot`).
 */
function projectOf(io: Io): string {
	let project = projectCache.get(io);
	if (project === undefined) {
		project = resolve(io.projectRoot(io.cwd));
		projectCache.set(io, project);
	}
	return project;
}

/** Whether two paths name the same place; Windows compares them ignoring case. */
function samePath(a: string, b: string, io: Io): boolean {
	const normal = (path: string) => resolve(path).replace(/[\\/]+$/, "");
	return io.platform === "win32" ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A stretch of time as a person says it: `40s`, `12 min`, `2 h 5 min`. */
function span(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The holder of the Studio lock as every message names it. */
function describeOwner(owner: LockOwner): string {
	const window =
		owner.studioPid !== undefined
			? `Studio PID ${owner.studioPid}${owner.mcpId !== undefined ? `, MCP id ${owner.mcpId}` : ""}`
			: "no Studio window open";
	return `flamework-test for ${owner.project} (${owner.command} on ${owner.place}, ${window}), since ${owner.since}`;
}

/** Where the holder's lease stands: when it was last used, and when its hold runs out. */
function describeLease(owner: LockOwner, now: number): string {
	const expires = Date.parse(owner.expires);
	return `last used ${span(now - Date.parse(owner.lastActivity))} ago; its ${owner.holdMinutes}-minute hold ${
		expires > now ? `runs out in ${span(expires - now)} (${owner.expires})` : `ran out ${span(now - expires)} ago`
	}`;
}

/**
 * The holder and how long it holds on: while its command runs, to that command's end (the hold
 * does not count then); once it has ended, its window's lease.
 */
function describeHolder(view: LockView, now: number): string {
	const owner = view.owner!;
	if (view.cli === "running") {
		return `${describeOwner(owner)}; its command is running (flamework-test PID ${owner.cliPid}) and holds the lock to its end${owner.kept === true ? ", then leaves it to its window" : ""}`;
	}
	return `${describeOwner(owner)}; ${describeLease(owner, now)}`;
}

/** The command that took a lock, once it has ended or its PID is another process now: `PID 9001, now another process (node)`. */
function describeEndedCli(view: LockView): string {
	const owner = view.owner!;
	return view.cli === "reused"
		? `PID ${owner.cliPid}, now another process${view.cliReusedBy !== undefined ? ` (${view.cliReusedBy})` : ""}`
		: `PID ${owner.cliPid}`;
}

/** Why a lock is stale, in a clause: `its window ... has closed`. */
function whyStale(view: LockView): string {
	const owner = view.owner;
	if (owner === undefined) {
		return `its record had been unreadable for ${span(view.unreadableMs ?? 0)}: a command stopped while taking it`;
	}
	if (owner.studioPid !== undefined) {
		return view.window === "reused"
			? `the window flamework-test opened for ${owner.project} has closed: its Studio PID ${owner.studioPid} is now another process${view.reusedBy !== undefined ? ` (${view.reusedBy})` : ""}`
			: `the window flamework-test opened for ${owner.project} (${owner.place}, Studio PID ${owner.studioPid}) has closed`;
	}
	return `the flamework-test run that took it for ${owner.project} (${describeEndedCli(view)}) has ended, with no window of its open`;
}

/** Why a window left behind may be closed at once, in a clause. */
function whyAbandoned(view: LockView): string {
	const owner = view.owner!;
	return `the \`${owner.command}\` that opened it (flamework-test ${describeEndedCli(view)}) has ended without closing it`;
}

/** What `studio open` and `test` ask of the lock. */
interface LockRequest {
	/** How the record names the command: `test`, `test --keep`, `studio open`. */
	command: string;
	place: string;
	placeFile?: string;
	placeId?: string;
	holdMinutes: number;
	/** The window is left open when the command ends (`--keep`, `studio open`), and holds the lock then. */
	keep: boolean;
}

/**
 * The Studio lock as a command holds it: it records the window the command launches, renews the
 * lease while the command uses it, and at the end frees the lock, or leaves it to the window
 * when the window stays open.
 */
class HeldLock {
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	/** Whether the window this command launched is open as far as it knows. */
	private windowOpen = false;

	constructor(
		private readonly io: Io,
		readonly owner: LockOwner,
		private ledger: Release | undefined,
		private readonly keep: boolean,
	) {}

	private async patch(patch: Partial<LockOwner>): Promise<boolean> {
		const held = await this.io.studioLock.update(this.owner.token, patch);
		if (held) {
			const record = this.owner as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) delete record[key];
				else record[key] = value;
			}
		}
		return held;
	}

	private lease(): { lastActivity: string; expires: string } {
		return leaseFrom(this.io.now().getTime(), this.owner.holdMinutes);
	}

	/** Refuses to go on when another command has taken the lock from this one. */
	async check(): Promise<void> {
		const record = await this.io.studioLock.read();
		if (record.kind !== "held" || record.owner.token !== this.owner.token) {
			throw new CliError(
				"the Studio lock was taken from this command before it opened Studio: `flamework-test studio unlock --force` freed it, or another command could not see this one running",
				"run the command again",
			);
		}
	}

	/**
	 * Records the window launched for a place, and keeps the lease fresh while the command runs. A
	 * window left open on purpose (`--keep`, `studio open`) is marked kept from here: once the
	 * command has ended it holds the lock under its lease, where a window any other command leaves
	 * open was left by a run cut short, and may be closed at once.
	 */
	async launched(pid: number | undefined, place: Pick<LockOwner, "place" | "placeFile" | "placeId">): Promise<void> {
		this.windowOpen = true;
		await this.patch({
			studioPid: pid,
			studioStartedAt: pid !== undefined ? iso(this.io.now().getTime()) : undefined,
			mcpId: undefined,
			place: place.place,
			placeFile: place.placeFile,
			placeId: place.placeId,
			...(this.keep ? { kept: true } : {}),
			...this.lease(),
		});
		// The window holds the lock from here: a window left open on purpose is not this run's to free.
		if (this.keep) {
			this.ledger?.();
			this.ledger = undefined;
		}
		this.heartbeat ??= setInterval(() => void this.renew().catch(() => {}), LEASE_HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	async connected(mcpId: string): Promise<void> {
		await this.patch({ mcpId, ...this.lease() });
	}

	async renew(): Promise<void> {
		await this.patch(this.lease());
	}

	/** The window closed, and the command goes on (the next project's window). */
	async windowClosed(): Promise<void> {
		this.windowOpen = false;
		await this.patch({ studioPid: undefined, studioStartedAt: undefined, mcpId: undefined, ...this.lease() });
	}

	/**
	 * The command goes on to another place, with no window open (the next project's, being made): the
	 * record names that place from here, so that a look at the lock meanwhile does not name the last.
	 */
	async moveTo(place: Pick<LockOwner, "place" | "placeFile" | "placeId">): Promise<void> {
		await this.patch({ place: place.place, placeFile: place.placeFile, placeId: place.placeId, ...this.lease() });
	}

	/**
	 * The end of the command. With its window still open (`--keep`, `studio open`, or a window that
	 * would not close), the lock is left to the window, which holds it until it closes or its hold
	 * runs out; otherwise it is freed.
	 */
	async finish(): Promise<void> {
		if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		if (this.windowOpen) {
			await this.patch({ kept: true, ...this.lease() });
			return;
		}
		await this.io.studioLock.free(this.owner.token);
		this.ledger?.();
		this.ledger = undefined;
	}
}

/**
 * Takes the Studio lock for a command that is about to launch Studio, waiting while another
 * holds it, and saying who, once and then about every minute. What it meets:
 * - a stale lock (its command has ended, and its window has closed or it had none) is taken over;
 * - an expired one (its window idle past its hold, or left open by a command cut short) has its
 *   window closed, the way flamework-test closes its own, and is taken over; a window the record's
 *   PID no longer is, is never closed;
 * - this project's own window, left open on purpose (`--keep`, `studio open`) by a command that has
 *   ended: `test` of that very file closes it, as a window left from an earlier build, and takes
 *   over; anything else refuses at once, naming it, since waiting would only wait for itself;
 * - anything live, a running command of this project included: waits, up to the lock timeout, then
 *   refuses naming the holder and how it is freed.
 * A Ctrl+C during the wait ends it holding nothing.
 */
async function takeStudioLock(
	io: Io,
	flags: Flags,
	request: LockRequest,
	say: (line: string) => void,
): Promise<HeldLock> {
	const store = io.studioLock;
	const project = projectOf(io);
	const timeoutMs = lockTimeoutOf(flags, io);
	const self = io.self();
	const startedAt = io.now().getTime();
	let told: string | undefined;
	let toldAt = Number.NEGATIVE_INFINITY;
	// The holder is judged from its record on every try; its processes are looked up again when
	// they change and every so often, since a lookup takes PowerShell a moment.
	let looked: { at: number; pids: string; found: Map<number, ProcessInfo> } | undefined;
	const probe: ProbeProcesses = async (pids) => {
		const at = io.now().getTime();
		const key = pids.join(",");
		if (looked !== undefined && looked.pids === key && at - looked.at < LOCK_PROBE_MS) return looked.found;
		looked = { at, pids: key, found: await io.probeProcesses(pids) };
		return looked.found;
	};

	for (;;) {
		io.interruption.check();
		const now = io.now().getTime();
		const owner: LockOwner = {
			version: 1,
			token: newToken(),
			cliPid: self.pid,
			cliName: self.name,
			cliStartedAt: iso(self.startedAt),
			project,
			command: request.command,
			place: request.place,
			...(request.placeFile !== undefined ? { placeFile: request.placeFile } : {}),
			...(request.placeId !== undefined ? { placeId: request.placeId } : {}),
			since: iso(now),
			...leaseFrom(now, request.holdMinutes),
			holdMinutes: request.holdMinutes,
		};
		if (await store.take(owner)) {
			const ledger = io.interruption.hold(
				"the Studio lock, which the next command takes over once this run and its window have gone",
				"released the Studio lock",
			);
			await forgetNotesOf(io, project);
			return new HeldLock(io, owner, ledger, request.keep);
		}

		const record = await store.read();
		if (record.kind === "free") continue;
		const token = record.kind === "held" ? record.owner.token : undefined;
		const view = await judgeLock(record, now, probe);

		if (view.state === "stale") {
			if (await store.free(token)) {
				say(`took over the Studio lock: ${whyStale(view)}`);
				await afterWindowGone(io, view, { project, command: request.command });
			}
			continue;
		}

		// This project's own window, left open on purpose by a command that has ended: waiting would be
		// waiting for itself, expired or not. One a command cut short left is closed below, as anyone's.
		const holder = view.owner;
		if (
			holder !== undefined &&
			holder.studioPid !== undefined &&
			holder.kept === true &&
			view.cli !== "running" &&
			samePath(holder.project, project, io)
		) {
			const sameFile =
				request.placeFile !== undefined &&
				holder.placeFile !== undefined &&
				samePath(holder.placeFile, request.placeFile, io);
			if (request.command.startsWith("test") && sameFile) {
				await closeOwnLeftWindow(io, holder);
				continue;
			}
			throw ownWindowStillOpen(holder, request);
		}

		if (view.state === "expired") {
			// The close judges the lock again from a fresh look at its processes; when that finds it
			// otherwise (its window gone since, say), the next try judges from a fresh look too, rather
			// than trying the close again on this one's cached look until it ages.
			if (!(await closeExpiredWindow(io, view, { project, command: request.command }, "expired", say))) {
				looked = undefined;
			}
			continue;
		}

		if (now - startedAt >= timeoutMs) throw lockTimedOut(view, timeoutMs, io);
		const holderText = holder !== undefined ? describeHolder(view, now) : "a command that is taking it right now";
		const key = token ?? "(being taken)";
		if (told !== key) {
			told = key;
			toldAt = now;
			say(
				`waiting for the Studio lock, held by ${holderText}. Waiting up to ${span(timeoutMs)} (--lock-timeout); \`flamework-test studio lock\` shows it`,
			);
		} else if (now - toldAt >= LOCK_REMIND_MS) {
			toldAt = now;
			say(
				`still waiting for the Studio lock (${span(now - startedAt)} of ${span(timeoutMs)}): held by ${holderText}`,
			);
		}
		await io.sleep(LOCK_POLL_MS);
	}
}

/**
 * Closes the window of a lock that has expired (idle past its hold, or left open by a command cut
 * short), or that `studio unlock --force` frees, and frees the lock. Only the Studio process the
 * record names, and only while it is still the one flamework-test launched on that place (its
 * command line names the file or the place id): a PID Windows has given another process is left
 * alone, as is anything a close cannot tie to the record. Its owner's next command finds a note of
 * it, and says why the window is gone.
 */
async function closeExpiredWindow(
	io: Io,
	view: LockView,
	by: { project: string; command: string },
	reason: "expired" | "forced",
	say: (line: string) => void,
): Promise<boolean> {
	// Looked at once more right before the close, its processes too: a window its owner used a
	// moment ago is not idle, and a command that took the lock just now is not cut short.
	const fresh = await io.studioLock.read();
	if (fresh.kind !== "held" || fresh.owner.token !== view.owner!.token) return false;
	if (reason === "expired") {
		view = await judgeLock(fresh, io.now().getTime(), io.probeProcesses);
		if (view.state !== "expired") return false;
	}
	const owner = fresh.owner;
	const idleMs = view.idleMs ?? 0;
	const startedWith = owner.placeFile ?? owner.placeId;
	let closed = false;
	if (owner.studioPid !== undefined && view.window === "running" && startedWith !== undefined) {
		const windows = await closeWindows({ pid: owner.studioPid, file: startedWith }, owner.place, io, {
			quiet: true,
			lockFile: owner.placeFile !== undefined,
		});
		closed = windows.some((window) => ["closed", "forced", "ended"].includes(window.outcome));
	}
	if (!(await io.studioLock.free(owner.token))) return false;
	const noted = reason === "forced" ? "forced" : view.abandoned === true ? "abandoned" : "expired";
	const why =
		noted === "expired"
			? `it had been idle for ${span(idleMs)}, past its ${owner.holdMinutes}-minute hold`
			: noted === "abandoned"
				? whyAbandoned(view)
				: "`studio unlock --force` freed its lock while it was live";
	if (closed && !samePath(owner.project, by.project, io)) {
		await io.studioLock.recordClosed({
			owner,
			closedAt: iso(io.now().getTime()),
			reason: noted,
			idleMinutes: Math.round(idleMs / 60_000),
			by,
		});
	}
	if (closed) {
		say(
			`closed the Studio window flamework-test opened for ${owner.project} (${owner.command} on ${owner.place}, Studio PID ${owner.studioPid}): ${why}; the Studio lock is free`,
		);
	} else if (owner.studioPid !== undefined) {
		say(
			`freed the Studio lock of ${owner.project} (${why}) without closing anything: Studio PID ${owner.studioPid} is no longer the window flamework-test launched on ${owner.place}`,
		);
	} else {
		say(`freed the Studio lock of ${owner.project} (${why}); it had no Studio window open`);
	}
	return true;
}

/** `test` of the very file this project's window has open: that window is from an earlier build. */
async function closeOwnLeftWindow(io: Io, holder: LockOwner): Promise<void> {
	const name = basename(holder.placeFile!);
	await closeWindows(
		{ pid: holder.studioPid!, file: holder.placeFile! },
		`the window left from an earlier build of ${name}`,
		io,
	);
	await io.studioLock.free(holder.token);
}

/** This project's own window holds the lock: the command would wait for itself. */
function ownWindowStillOpen(holder: LockOwner, request: LockRequest): CliError {
	const id = holder.mcpId !== undefined ? `, MCP id ${holder.mcpId}` : ", never seen on the MCP proxy";
	return new CliError(
		`this project's Studio window is still open: ${holder.place} (Studio PID ${holder.studioPid}${id}), opened by \`${holder.command}\` at ${holder.since}; flamework-test keeps one window open at a time`,
		request.command === "studio open" && holder.mcpId !== undefined
			? `use it (studio_id=${holder.mcpId}: --studio ${holder.mcpId}), or close it with \`flamework-test studio close\` and open again`
			: "close it with `flamework-test studio close`, then run this again",
	);
}

function lockTimedOut(view: LockView, timeoutMs: number, io: Io): CliError {
	const holder = view.owner;
	if (holder === undefined) {
		return new CliError(
			`the Studio lock is still being taken after waiting ${span(timeoutMs)}: ${io.studioLock.where} has no record that can be read yet`,
			"`flamework-test studio lock` shows it; if no flamework-test is running, `flamework-test studio unlock` frees it",
		);
	}
	const freedWhen =
		view.cli === "running"
			? `it is freed when that command ends${holder.kept === true ? " and then its window closes, or its hold runs out" : " (it closes its own window)"}`
			: `it is freed when that window closes: \`flamework-test studio close\` run in ${holder.project}, the user closing it, or its hold running out, after which the next command closes it`;
	return new CliError(
		`the Studio lock is still held after waiting ${span(timeoutMs)}: ${describeHolder(view, io.now().getTime())}`,
		`${freedWhen}. Wait longer with --lock-timeout <seconds>; \`flamework-test studio lock\` shows the holder. Never close a window you did not open: ask the user, or the agent working in ${holder.project}.`,
	);
}

/** A window closed for another project's sake, or found closed by it, as its owner's next command explains it. */
function closedWindowError(entry: ClosedWindowRecord): CliError {
	const owner = entry.owner;
	if (entry.reason === "gone") {
		return new CliError(
			`the Studio window flamework-test opened for this project (${owner.place}, Studio PID ${owner.studioPid}${owner.mcpId !== undefined ? `, MCP id ${owner.mcpId}` : ""}) has closed: closed by hand, or Studio exited; flamework-test for ${entry.by.project} (${entry.by.command}) found it so at ${entry.closedAt}, and ${entry.by.command.startsWith("studio unlock") ? "freed" : "took over"} its Studio lock`,
			`open it again: flamework-test studio open${owner.placeFile !== undefined ? ` ${owner.placeFile}` : ""}`,
		);
	}
	const why =
		entry.reason === "expired"
			? `after ${entry.idleMinutes} min idle, past its ${owner.holdMinutes}-minute hold, so that another project could use Studio`
			: entry.reason === "abandoned"
				? `because the \`${owner.command}\` that opened it (flamework-test PID ${owner.cliPid}) had ended without closing it`
				: "by `flamework-test studio unlock --force`";
	return new CliError(
		`the Studio window flamework-test opened for this project (${owner.place}, Studio PID ${owner.studioPid}${owner.mcpId !== undefined ? `, MCP id ${owner.mcpId}` : ""}) was closed at ${entry.closedAt} by flamework-test for ${entry.by.project} (${entry.by.command}), ${why}`,
		`open it again: flamework-test studio open${owner.placeFile !== undefined ? ` ${owner.placeFile}` : ""}${entry.reason === "expired" ? " (--hold <minutes> keeps a window longer)" : ""}`,
	);
}

/**
 * The newest note of a window of this project closed for another's sake, matching an id when one is
 * given. Only notes from after this project last took the lock: those before are forgotten then.
 */
async function closedForThisProject(io: Io, id: string | undefined): Promise<ClosedWindowRecord | undefined> {
	const project = projectOf(io);
	return (await io.studioLock.closedWindows()).find(
		(entry) => samePath(entry.owner.project, project, io) && (id === undefined || entry.owner.mcpId === id),
	);
}

/** Says, on stderr, what became of this project's last window, when another project closed it or found it closed. */
async function noteClosedWindow(io: Io): Promise<void> {
	const closed = await closedForThisProject(io, undefined);
	if (closed !== undefined) io.error(`note: ${closedWindowError(closed).message}`);
}

/**
 * Forgets the notes of this project's windows closed for another project's sake, once it takes the
 * lock again: its next command has a window of its own to speak of, and an old note would read as news.
 */
async function forgetNotesOf(io: Io, project: string): Promise<void> {
	try {
		const own = (await io.studioLock.closedWindows()).filter((entry) => samePath(entry.owner.project, project, io));
		if (own.length > 0) await io.studioLock.forgetClosed(own.map((entry) => entry.owner.token));
	} catch {
		// Not forgotten: shown once more, at worst.
	}
}

/**
 * After a lock was freed because its window had gone (closed by hand, or Studio exited) or its PID is
 * another process now: Studio's own lock beside the place file, which a Studio that was ended leaves
 * behind, is removed when it names that process, as a close removes its own; and when `by` is
 * another project, the owner gets a note, so that its next command says its window has closed,
 * rather than not finding it or picking another. The owner's own command says so itself.
 */
async function afterWindowGone(io: Io, view: LockView, by?: { project: string; command: string }): Promise<void> {
	const owner = view.owner;
	if (owner?.studioPid === undefined) return;
	if (view.window === "gone" && owner.placeFile !== undefined) {
		await removeStudioLock(owner.placeFile, owner.studioPid, io);
	}
	if (by !== undefined && !samePath(owner.project, by.project, io)) {
		try {
			await io.studioLock.recordClosed({
				owner,
				closedAt: iso(io.now().getTime()),
				reason: "gone",
				idleMinutes: Math.round((view.idleMs ?? 0) / 60_000),
				by,
			});
		} catch {
			// A note is for the owner's next message only.
		}
	}
}

/**
 * This project's window has gone (closed by hand, or Studio exited; or its PID is another process
 * now), or its command ended with none open: the lock is freed at this look, and the command says so.
 */
async function ownWindowClosed(io: Io, ours: LockOwner, view: LockView): Promise<CliError> {
	if (await io.studioLock.free(ours.token)) await afterWindowGone(io, view);
	if (ours.studioPid === undefined) {
		return new CliError(
			`no Studio window flamework-test opened for this project is open: the \`${ours.command}\` that took the Studio lock for it (flamework-test ${describeEndedCli(view)}) has ended without one`,
			"open one first: flamework-test studio open [file]",
		);
	}
	return new CliError(
		`the Studio window flamework-test opened for this project (${ours.place}, Studio PID ${ours.studioPid}) has closed${
			view.window === "reused"
				? `: its PID is another process now${view.reusedBy !== undefined ? ` (${view.reusedBy})` : ""}`
				: ""
		}`,
		`open it again: flamework-test studio open${ours.placeFile !== undefined ? ` ${ours.placeFile}` : ""}`,
	);
}

/**
 * Keeps the lease of this project's window fresh while a command uses it: renewed at the start,
 * every {@link LEASE_HEARTBEAT_MS} (30 seconds) meanwhile, and at the end. Nothing for any other window.
 */
async function withLease<T>(io: Io, mine: LockOwner | undefined, body: () => Promise<T>): Promise<T> {
	if (mine === undefined) return await body();
	const renew = () =>
		io.studioLock.update(mine.token, leaseFrom(io.now().getTime(), mine.holdMinutes)).catch(() => false);
	await renew();
	const heartbeat = setInterval(() => void renew(), LEASE_HEARTBEAT_MS);
	heartbeat.unref?.();
	try {
		return await body();
	} finally {
		clearInterval(heartbeat);
		await renew();
	}
}

// ------------------------------------------------------------------ studio

/**
 * Whether an entry of the proxy's list shows the place a lock record's window was launched on: a
 * local file's window is listed by the file's name, a cloud place's with its place id.
 */
function listsPlaceOf(owner: LockOwner, entry: StudioEntry): boolean {
	if (owner.placeFile !== undefined) {
		const file = (owner.placeFile.split(/[\\/]/).pop() ?? owner.placeFile).toLowerCase();
		return entry.name.toLowerCase() === file || placeNameOf(entry.name).toLowerCase() === file;
	}
	if (owner.placeId !== undefined) return findStudioForPlace([entry], owner.placeId) !== undefined;
	return false;
}

/**
 * Whether an entry of the proxy's list is the window a lock record names: its MCP id, and the
 * place that window was launched on. The id alone could be one the proxy has given another window
 * since, the user's own, once the one flamework-test opened has closed.
 */
function isLockWindow(owner: LockOwner | undefined, entry: StudioEntry): boolean {
	return owner?.mcpId !== undefined && owner.mcpId === entry.id && listsPlaceOf(owner, entry);
}

/**
 * The command of another process that took this project's lock and is still running: in its window,
 * between two of its windows (a `test` of several projects), or before its first. It drives the
 * window while it runs (`test` closes it at its end; `test --keep` and `studio open` leave it
 * open), so nothing else may change it meanwhile, whether it means to leave the window open or not.
 * Undefined once that command has ended, a window it left open being this project's to use then,
 * and for this process's own. `view` is the lock judged already, when it is.
 */
async function runningIn(io: Io, owner: LockOwner, view?: LockView): Promise<LockView | undefined> {
	if (owner.cliPid === io.self().pid) return undefined;
	const judged = view ?? (await judgeLock({ kind: "held", owner }, io.now().getTime(), io.probeProcesses));
	return judged.cli === "running" ? judged : undefined;
}

/** The refusal of a command that would change this project's window while another process's command uses it. */
function inUseError(owner: LockOwner, verb: string): CliError {
	// `test --keep` and `studio open` leave their window open (kept from its launch on); a `test` closes its own.
	const leaves = owner.kept === true || owner.command !== "test";
	const running = `\`${owner.command}\` is running`;
	const who = `(flamework-test PID ${owner.cliPid}, since ${owner.since})`;
	return new CliError(
		owner.studioPid !== undefined
			? `refusing to ${verb} this project's Studio window (${owner.place}, Studio PID ${owner.studioPid}): ${running} in it ${who}, and ${leaves ? "leaves it open" : "closes it"} when it ends`
			: `refusing to ${verb} this project's Studio window: ${running} for this project ${who} with no window open right now, between two of its windows or before its first (${owner.place}), and ${leaves ? "leaves its window open" : "closes its windows"} when it ends`,
		`wait for that run to end${leaves ? ", then use the window it leaves open" : ""} (\`flamework-test studio lock\` shows it), or stop it with Ctrl+C where it runs; --any-window acts on a window anyway`,
	);
}

/**
 * The refusal of a command that changes a window flamework-test did not open for this project:
 * the user's own window, one opened by an older flamework-test or by hand, or another project's,
 * whose run or agent may be using it. Comes before any call to that window.
 */
function refuseWindow(studio: StudioEntry, holder: LockOwner | undefined, verb: string, io: Io): CliError | undefined {
	if (holder !== undefined && isLockWindow(holder, studio)) {
		if (samePath(holder.project, projectOf(io), io)) return undefined;
		return new CliError(
			`refusing to ${verb} the Studio window "${studio.name}" (${studio.id}): flamework-test opened it for another project, ${holder.project} (${holder.command}, since ${holder.since}), whose run or agent may still be using it`,
			"pass --any-window to act on it anyway, once the user has confirmed it is free to use; `flamework-test studio lock` shows who holds it",
		);
	}
	return new CliError(
		`refusing to ${verb} the Studio window "${studio.name}" (${studio.id}): flamework-test did not open it for this project, so it may be a window the user has open`,
		"pass --any-window to act on it anyway, but only once the user has said so: never use --any-window on a window the user has open without asking them first. For a window of your own: flamework-test studio open [file]",
	);
}

/**
 * Says why no window was found, for a person or an agent to act on. `guarded`: the command would
 * change the window, and acts only on this project's.
 */
async function noWindow(
	flags: Flags,
	io: Io,
	studios: StudioEntry[],
	placeId: string | undefined,
	ours: LockOwner | undefined,
	guarded: boolean,
): Promise<CliError> {
	const closed = await closedForThisProject(io, flags.studio);
	if (closed !== undefined && (flags.studio !== undefined || ours === undefined)) return closedWindowError(closed);

	if (flags.studio === undefined && ours !== undefined) {
		const view = await judgeLock({ kind: "held", owner: ours }, io.now().getTime(), io.probeProcesses);
		// A window closed by hand frees the lock at the next look.
		if (view.state === "stale") return await ownWindowClosed(io, ours, view);
		if (view.cli === "running" && ours.cliPid !== io.self().pid) {
			return new CliError(
				`this project's \`${ours.command}\` (flamework-test PID ${ours.cliPid}) is running, and its window is not on the MCP proxy${ours.studioPid === undefined ? "; it has none open right now" : " yet"}`,
				"wait for it to connect, or for that run to end; `flamework-test studio lock` shows it",
			);
		}
		const reused = ours.mcpId !== undefined ? studios.find((entry) => entry.id === ours.mcpId) : undefined;
		if (reused !== undefined) {
			return new CliError(
				`the Studio window flamework-test opened for this project (${ours.place}, Studio PID ${ours.studioPid ?? "none"}) is not on the MCP proxy as ${ours.mcpId}: the proxy lists "${reused.name}" under that id now, which is not that place, so nothing was sent to it`,
				"`flamework-test studio list` shows the windows; `flamework-test studio close` closes this project's window, and `flamework-test studio open` opens it again",
			);
		}
		if (ours.studioPid !== undefined) {
			return new CliError(
				`the Studio window flamework-test opened for this project (${ours.place}, Studio PID ${ours.studioPid}) is open but not on the MCP proxy`,
				'its "MCP server" setting is probably off: ask the user to turn it on in Studio\'s Assistant settings, then run this again; `flamework-test studio close` closes the window',
			);
		}
	}

	// None of this project's is open, and a command that would change a window never takes another
	// in its place (the testing place's, the only local file's): it would only be refused.
	if (guarded && flags.studio === undefined && ours === undefined) {
		return new CliError(
			"no Studio window flamework-test opened for this project is open, so this command has no window to act on",
			"open one first: `flamework-test studio open [file]` (or `flamework-test test <file> --keep`). To act on another window, name it with --studio <id> (`flamework-test studio list` lists them), and add --any-window only once the user has said so",
		);
	}

	if (studios.length === 0) {
		const running = await io.studioWindows();
		if (running.length > 0) {
			return new CliError(
				`Roblox Studio is running (${running.length === 1 ? "1 window" : `${running.length} windows`}: ${running.map((window) => `PID ${window.pid}, "${window.title}"`).join("; ")}), but the MCP proxy reaches none of them`,
				'their "MCP server" setting is probably off: ask the user to turn it on in Studio\'s Assistant settings (it lets flamework-test and AI assistants drive a window), then run this again',
			);
		}
	}

	const listed = studios.map((entry) => entry.name).join(", ");
	return new CliError(
		flags.studio !== undefined
			? `no Studio window is named "${flags.studio}"; listed: ${listed || "none"}`
			: placeId !== undefined
				? `no Studio window has the testing place ${placeId} open, and no single window has a local place file open${listed ? `; listed: ${listed}` : ""}`
				: `no single Studio window has a local place file open, and no testing place is configured to look for${listed ? `; listed: ${listed}` : ""}`,
		'name the window with --studio <name|id> (`flamework-test studio list` lists them), or open one with `flamework-test studio open`; check that "MCP server" is enabled in Studio\'s Assistant settings, since a window that has it disabled is not listed',
	);
}

/**
 * The connected proxy and the window to drive: the one `--studio` names, else the window
 * flamework-test opened for this project. A read-only command, when this project has none open,
 * takes the one with the testing place open, else the only one with a local place file open; only
 * that needs the testing place's id, so a window found any other way is driven without one.
 * Refuses clearly when nothing matches.
 *
 * `changes` is what a command that changes the window does to it (`close`, `run Luau in`): such a
 * command acts only on the window flamework-test opened for this project, unless `--any-window`,
 * and refuses before any call to the window: another window named, none of this project's open, or
 * this project's while another process's command of this project runs in it (or between two of its
 * windows). Read-only commands work on any window. Using this project's window renews its lease.
 * `shared` is a proxy the caller connected and closes itself.
 */
async function withStudio<T>(
	flags: Flags,
	io: Io,
	changes: string | undefined,
	body: (client: StudioClient, studio: StudioEntry, mine: LockOwner | undefined) => Promise<T>,
	shared?: StudioClient,
): Promise<T> {
	const record = await io.studioLock.read();
	const holder = record.kind === "held" ? record.owner : undefined;
	const ours = holder !== undefined && samePath(holder.project, projectOf(io), io) ? holder : undefined;
	// A command that changes a window, without leave to act on any but this project's.
	const guarded = changes !== undefined && flags["any-window"] !== true;
	// This project's lock, judged once (its processes looked up) for a command that would change its
	// window: another process's command of this project running, in the window or between two of
	// them, refuses before the proxy is asked anything.
	let judged: LockView | undefined;
	if (guarded && ours !== undefined && (flags.studio === undefined || flags.studio === ours.mcpId)) {
		judged = await judgeLock({ kind: "held", owner: ours }, io.now().getTime(), io.probeProcesses);
		if ((await runningIn(io, ours, judged)) !== undefined) throw inUseError(ours, changes!);
	}
	const placeId = flags.studio === undefined ? testingPlaceIdIfAny(flags, io) : undefined;
	const client = shared ?? (await io.connectStudio());
	try {
		const studios = await client.studios();
		let studio: StudioEntry | undefined;
		if (flags.studio !== undefined) {
			studio = findStudio(studios, undefined, flags.studio);
		} else if (ours?.mcpId !== undefined) {
			// This project's window, or none: never some other window in its place, nor another
			// window the proxy lists under its id since.
			studio = studios.find((entry) => isLockWindow(ours, entry));
		} else if (!guarded && ours?.studioPid === undefined) {
			studio = findStudio(studios, placeId);
			// Another window than this project's last one: said so, when another project closed that.
			if (studio !== undefined && ours === undefined) await noteClosedWindow(io);
		}
		if (studio === undefined) throw await noWindow(flags, io, studios, placeId, ours, guarded);

		const mine = ours !== undefined && isLockWindow(ours, studio) ? ours : undefined;
		if (guarded) {
			const refusal = refuseWindow(studio, holder, changes!, io);
			if (refusal !== undefined) {
				if (ours === undefined) await noteClosedWindow(io);
				throw refusal;
			}
			if (mine !== undefined) {
				const view =
					judged ?? (await judgeLock({ kind: "held", owner: mine }, io.now().getTime(), io.probeProcesses));
				if ((await runningIn(io, mine, view)) !== undefined) throw inUseError(mine, changes!);
				// Listed under its id, with its place, but the Studio process it was launched as has gone:
				// not the window flamework-test opened, and nothing is sent to it.
				if (view.state === "stale") throw await ownWindowClosed(io, mine, view);
			}
		}
		const found = studio;
		return await withLease(io, mine, () => body(client, found, mine));
	} finally {
		if (shared === undefined) await client.close();
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
 * A window flamework-test launched that never showed up on the proxy. What the hint says of the
 * window: left `open` (`--keep`), `closed` again, or nothing (`unstated`) when that close failed
 * and has said so itself. Written for whoever reads it next, an AI agent as often as a person.
 */
function neverConnected(what: string, window: "open" | "closed" | "unstated" = "open", pid?: number): CliError {
	const advice =
		'Studio\'s "MCP server" setting is probably off, and a window with it off is never listed: ask the user to enable "MCP server" in Studio\'s Assistant settings, then run this again';
	return new CliError(
		`Studio started${pid !== undefined ? ` (PID ${pid})` : ""} but ${what} never showed up on the MCP proxy`,
		window === "open"
			? `${advice}; the window is open, and holds the Studio lock until it closes (\`flamework-test studio close\` closes it)`
			: window === "closed"
				? `${advice}; the window this run opened is closed again`
				: advice,
	);
}

/**
 * Waits for the window a launch opened to show up on the proxy, and returns its entry. The proxy
 * says nothing of the process behind an entry, so an entry listed before the launch (`before`) is
 * never taken for it, even under the same name.
 *
 * A local file's window is listed by the file's name alone, so a new entry of that name is this
 * launch's only when every other window showing a file of that name is accounted for by an entry
 * listed before the launch. One that has not registered yet could own the new entry, so it is
 * waited for (`unaccounted`, when the wait ends that way); two new entries cannot be told apart,
 * so they are refused. A cloud place's window is listed with its place id: one new entry with it.
 */
async function findLaunchedWindow(
	client: StudioClient,
	target: { file: string } | { placeId: string },
	pid: number | undefined,
	before: Set<string>,
	flags: Flags,
	io: Io,
): Promise<{ studio: StudioEntry | undefined; unaccounted: boolean; others: StudioWindow[] }> {
	if ("placeId" in target) {
		const studio = await waitForStudio(
			client,
			(studios) => {
				const fresh = studios.filter(
					(entry) => findStudioForPlace([entry], target.placeId) !== undefined && !before.has(entry.id),
				);
				if (fresh.length > 1) {
					throw new CliError(
						`cannot tell which window of the testing place ${target.placeId} on the MCP proxy is the one this command opened: ${fresh.length} registered with it at once`,
						"close the one this command did not open (ask the user if it is theirs), and run again",
					);
				}
				return fresh[0];
			},
			flags,
			io,
		);
		return { studio, unaccounted: false, others: [] };
	}

	const name = basename(target.file);
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
				throw cannotTell(name, "another window of that name registered with it at the same time", others);
			}
			unaccounted = named.length < others.length + (pid !== undefined ? 1 : 0);
			return unaccounted ? undefined : fresh[0];
		},
		flags,
		io,
	);
	return { studio, unaccounted, others };
}

/** The line `studio open` and `test --keep` print for the window they leave open, made to be parsed. */
function windowLine(id: string, pid: number | undefined): string {
	return `studio_id=${id} pid=${pid ?? "unknown"}`;
}

/**
 * Opens a window and leaves it open, holding the Studio lock: the testing place from the cloud,
 * or a local place file. Prints the window's MCP id (`studio_id=<id> pid=<pid>`), which the other
 * studio commands take with `--studio`; `--json` prints it as JSON, and the progress on stderr.
 *
 * While a window it opened for this project is still open, it refuses, naming that window: the
 * lock allows one window at a time anyway, and reusing it could hand back a window with an older
 * build of the file in it (Studio reads the file once) or another place than the one asked for.
 * A window that never shows up on the proxy is closed again, since nothing could drive it.
 */
async function cmdStudioOpen(flags: Flags, io: Io): Promise<number> {
	const exe = requireStudioExe(io);
	const json = flags.json === true;
	const say = (line: string) => (json ? io.error(line) : io.log(line));
	const holdMinutes = holdOf(flags, io);

	let launch: { file: string } | { placeId: string; universeId: string };
	let place: Pick<LockOwner, "place" | "placeFile" | "placeId">;
	let what: string;
	if (flags.file !== undefined) {
		const file = resolve(io.cwd, flags.file);
		if (!(await io.exists(file))) {
			throw new CliError(`${flags.file} does not exist`);
		}
		launch = { file };
		place = { place: file, placeFile: file };
		what = flags.file;
	} else {
		const { universeId, placeId } = resolveIds(flags, io);
		launch = { placeId, universeId };
		place = { place: `the testing place ${placeId}`, placeId };
		what = `the testing place ${placeId}`;
	}

	const lock = await takeStudioLock(io, flags, { command: "studio open", ...place, holdMinutes, keep: true }, say);
	try {
		const client = await io.connectStudio();
		try {
			const name = "file" in launch ? basename(launch.file) : undefined;
			let release: (() => void) | undefined;
			let pid: number | undefined;
			let studio: StudioEntry;
			try {
				if (name !== undefined) {
					release = await io.claimWindowName(name, (holder) =>
						say(
							`waiting for another flamework-test run (PID ${holder}) to finish opening its ${name} window...`,
						),
					);
				}
				// Whatever the proxy lists now is not this command's window, even when it has the same name.
				const before = new Set((await client.studios()).map((entry) => entry.id));
				await lock.check();
				pid = await io.launch([exe, ...studioOpenArguments(launch)]);
				await lock.launched(pid, place);
				// The window is what was asked for: Ctrl+C stops the wait for it, and leaves it.
				const window = io.interruption.hold(
					`${ownWindow(pid, "file" in launch ? basename(launch.file) : what)}, which studio open leaves open`,
				);
				say(`opening ${what} in Studio; waiting for it to connect...`);

				// A window this command cannot drive, or cannot tell from another, would hold Studio for
				// nobody: it is closed again. Whether it is closed now.
				const giveUp = async (): Promise<boolean> => {
					try {
						const closed = await closeLaunchedWindow(pid, launch, what, io, window);
						if (closed) await lock.windowClosed();
						return closed;
					} catch (error) {
						printError(error, io);
						return false;
					}
				};
				let found: Awaited<ReturnType<typeof findLaunchedWindow>>;
				try {
					found = await findLaunchedWindow(
						client,
						"file" in launch ? { file: launch.file } : { placeId: launch.placeId },
						pid,
						before,
						flags,
						io,
					);
				} catch (error) {
					// Ctrl+C leaves the window, which is what was asked for.
					if (!(error instanceof Interrupted)) await giveUp();
					throw error;
				}
				if (found.studio === undefined) {
					const closed = await giveUp();
					throw found.unaccounted && name !== undefined
						? cannotTell(
								name,
								"another Studio window showing a file of that name has not registered with it",
								found.others,
							)
						: neverConnected(what, closed ? "closed" : "unstated", pid);
				}
				studio = found.studio;
			} finally {
				release?.();
			}

			await lock.connected(studio.id);
			if (json) {
				io.log(
					JSON.stringify(
						{
							studio_id: studio.id,
							pid: pid ?? null,
							name: studio.name,
							place: place.place,
							project: lock.owner.project,
							holdMinutes,
							expires: lock.owner.expires,
						},
						null,
						2,
					),
				);
			} else {
				io.log(`connected: ${studio.name} (${studio.id})`);
				io.log(windowLine(studio.id, pid));
				io.log(
					`it holds the Studio lock until \`flamework-test studio close\`, or until it has sat unused for ${holdMinutes} min (--hold)`,
				);
			}
			return 0;
		} finally {
			await client.close();
		}
	} finally {
		await lock.finish();
	}
}

/**
 * Closes the window a command launched, by its process: a local file's with `closeOwnWindow`, a
 * cloud place's by the place id on its command line. Whether it is closed now.
 */
async function closeLaunchedWindow(
	pid: number | undefined,
	launch: { file: string } | { placeId: string },
	what: string,
	io: Io,
	release: Release,
): Promise<boolean> {
	if ("file" in launch) {
		await closeOwnWindow(pid, launch.file, io, release);
		return true;
	}
	if (pid === undefined) return false;
	const windows = await closeWindows({ pid, file: launch.placeId }, what, io, { gone: release, lockFile: false });
	const closed = windows.some((window) => ["closed", "forced", "ended"].includes(window.outcome));
	if (!closed) release(`${ownWindow(pid, what)} had already closed`);
	return true;
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
 * `options.quiet` leaves the saying to the caller; `options.lockFile: false` says the target's
 * `file` is a place id, with no Studio lock file beside it.
 */
async function closeWindows(
	target: CloseTarget,
	label: string,
	io: Io,
	options: { cutShort?: string; gone?: () => void; quiet?: boolean; lockFile?: boolean } = {},
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
			if (options.quiet === true) {
				// Said by the caller.
			} else if (window.outcome === "closed" || window.outcome === "ended") {
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
			if (
				(window.outcome === "ended" || window.outcome === "forced") &&
				"file" in target &&
				options.lockFile !== false
			) {
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
 * `studio close`: the window flamework-test opened for this project, closed by the Studio process
 * it launched (ended without asking, as `test` ends its own), even when the proxy does not list
 * it, and the Studio lock freed. With `--studio`, the window named, which has to be that one
 * unless `--any-window`; then any window the proxy lists, by its title, which is all that is known
 * of a window flamework-test did not open: several windows with that title are ambiguous, and none
 * is closed. A window another process's command of this project is running in (`test`, `test
 * --keep`, `studio open`) is refused, naming it: that run closes it, or leaves it, when it ends.
 */
async function cmdStudioClose(flags: Flags, io: Io): Promise<number> {
	const record = await io.studioLock.read();
	const holder = record.kind === "held" ? record.owner : undefined;
	if (flags.studio === undefined && holder?.studioPid !== undefined && samePath(holder.project, projectOf(io), io)) {
		if (flags["any-window"] !== true && (await runningIn(io, holder)) !== undefined) {
			throw inUseError(holder, "close");
		}
		return await closeThisProjectsWindow(holder, io);
	}

	return await withStudio(flags, io, "close", async (_client, studio, mine) => {
		if (mine?.studioPid !== undefined) return await closeThisProjectsWindow(mine, io);

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

/**
 * Closes the window the Studio lock's record names for this project, by its process and only
 * while that process still has the place it was launched on, and frees the lock.
 */
async function closeThisProjectsWindow(owner: LockOwner, io: Io): Promise<number> {
	const label = owner.placeFile !== undefined ? basename(owner.placeFile) : owner.place;
	const startedWith = owner.placeFile ?? owner.placeId;
	let closed = false;
	if (owner.studioPid !== undefined && startedWith !== undefined) {
		const windows = await closeWindows({ pid: owner.studioPid, file: startedWith }, label, io, {
			lockFile: owner.placeFile !== undefined,
		});
		closed = windows.some((window) => ["closed", "forced", "ended"].includes(window.outcome));
	}
	const freed = await io.studioLock.free(owner.token);
	if (!closed) {
		io.log(
			`${label} had already closed: the Studio flamework-test opened for this project (PID ${owner.studioPid ?? "unknown"}) no longer has it open`,
		);
	}
	// Taken over meanwhile (its window found closed, by a command that was waiting): not this one's to free.
	io.log(
		freed
			? "the Studio lock is free"
			: "the Studio lock has already been taken over by another command; `flamework-test studio lock` shows which",
	);
	return 0;
}

async function cmdStudioStatus(flags: Flags, io: Io): Promise<number> {
	return await withStudio(flags, io, undefined, async (client, studio) => {
		io.log(`${studio.name} (${studio.id})`);
		const state = await client.call("get_studio_state", { studio_id: studio.id }, 30_000);
		for (const line of state.split("\n")) io.log(`  ${line}`);
		return 0;
	});
}

async function cmdStudioPlay(flags: Flags, io: Io, start: boolean): Promise<number> {
	const verb = start ? "start a play session in" : "stop the play session of";
	return await withStudio(flags, io, verb, async (client, studio) => {
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

	return await withStudio(flags, io, "run Luau in", async (client, studio) => {
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
			const message = luauErrorMessage(error);
			throw new CliError(
				`the Luau failed in ${dataModel}: ${message}`,
				isCapabilityRefusal(message) ? SNIPPET_SANDBOX_HINT : undefined,
			);
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
 * with that window, so closing it lets the session go too. `activity` renews the Studio lock's
 * lease, before each realm and after the last.
 */
async function runRealms(
	client: StudioClient,
	studio: StudioEntry,
	realms: Array<"Server" | "Client">,
	flags: Flags,
	io: Io,
	window?: Release,
	activity: () => Promise<void> = async () => {},
): Promise<number> {
	const filter: Filter = parseSections(flags.sections);
	const script = renderStudioRun(renderFilter(filter), renderOptions({ list: flags.list === true }));
	const state = () => client.call("get_studio_state", { studio_id: studio.id }, 30_000);
	const failOnSkip = flags["fail-on-skip"] === true;

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
			await activity();
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
				const judged: Judgement = { failOnSkip };
				printResult(result, results, flags, io, judged);
				code = Math.max(code, resultPassed(result, judged) ? 0 : 1);
			} else {
				answered.push({ result, results });
			}
		}

		await activity();
		// With several realms, each realm's verdict waits for the others: an entry of the filter that
		// no realm has fails every realm that was given it, and the run, and is known only once every
		// realm has answered. A realm that did not answer has failed the run already.
		if (several) {
			const missed =
				answered.length === realms.length ? missedEverywhere(answered.map(({ result }) => result)) : [];
			const judged: Judgement = { realmOfSeveral: true, missed, failOnSkip };
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
 * line of a test (`PASS`, `FAIL` or `SKIP`, with its duration) names the last test that reported,
 * so the one after it in that section is the one that has not returned. A test's name runs up to
 * the first `: PASS (`, `: FAIL (` or `: SKIP (` and its milliseconds, spaces and all. No line at
 * all means the host never started the run.
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
		.map((line) => line.match(new RegExp(`\\[FWTEST\\] ${realm} (.+?): (PASS|FAIL|SKIP) \\(\\d+ms\\)`)))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (reported.length === 0) {
		return `no test of the ${realm} reported in Studio's output: the host never started the run, or the place is not built with the testing scope`;
	}

	const last = reported[reported.length - 1]!;
	return `last test that reported: ${last[1]} (${last[2]}); the test after it in that section is hanging, past its own timeout`;
}

async function cmdStudioRun(flags: Flags, io: Io): Promise<number> {
	const realms = realmsOf(flags.realm, "server");
	const settled = withRunSettings(flags, io);
	return await withKeepAwake(keepAwakeOf(settled, io), io, () =>
		withStudio(settled, io, "run the tests in", (client, studio) => runRealms(client, studio, realms, settled, io)),
	);
}

// ------------------------------------------------- Studio's MCP tools, any of them

/** Where `studio call` writes an image answer by default: the temp folder, never the project. */
function capturesDir(): string {
	return join(tmpdir(), "flamework-test", "captures");
}

/**
 * `studio list`: every window the MCP proxy reaches, with its id and place, whether flamework-test
 * opened it (for this project or another) and whether it holds the Studio lock, under a line on
 * the lock. Read-only. Studio processes the proxy reaches none of are named, with the setting
 * that is probably off.
 */
async function cmdStudioList(flags: Flags, io: Io): Promise<number> {
	const record = await io.studioLock.read();
	const holder = record.kind === "held" ? record.owner : undefined;
	const now = io.now().getTime();
	// Judged before anything is said of it: a record whose window has gone holds nothing.
	const view = await judgeLock(record, now, io.probeProcesses);
	const project = projectOf(io);
	const client = await io.connectStudio();
	let studios: StudioEntry[];
	try {
		studios = await client.studios();
	} finally {
		await client.close();
	}
	const running = await io.studioWindows();

	const rows = studios.map((studio) => {
		const opened = isLockWindow(holder, studio);
		return {
			studio_id: studio.id,
			name: studio.name,
			openedByFlameworkTest: opened,
			project: opened ? holder!.project : null,
			thisProject: opened && samePath(holder!.project, project, io),
			holdsLock: opened && view.state !== "stale",
		};
	});
	const lockLine =
		holder === undefined
			? record.kind === "free"
				? "Studio lock: free"
				: `Studio lock: ${view.state === "stale" ? "stale" : "being taken"} (its record cannot be read)`
			: view.state === "stale"
				? `Studio lock: stale, held by nothing: ${whyStale(view)}; the next command that opens a window takes it over`
				: view.state === "expired"
					? `Studio lock: expired, ${describeOwner(holder)}: ${view.abandoned === true ? whyAbandoned(view) : `its ${holder.holdMinutes}-minute hold has run out`}; the next command that opens a window closes it and takes the lock`
					: `Studio lock: held by ${describeHolder(view, now)}`;
	const unreachable = Math.max(0, running.length - studios.length);

	if (flags.json === true) {
		io.log(
			JSON.stringify(
				{
					lock:
						holder !== undefined
							? {
									state: view.state,
									project: holder.project,
									command: holder.command,
									place: holder.place,
									studioPid: holder.studioPid ?? null,
									studio_id: holder.mcpId ?? null,
									since: holder.since,
									lastActivity: holder.lastActivity,
									expires: holder.expires,
								}
							: record.kind === "free"
								? null
								: { state: view.state, unreadable: true },
					studios: rows,
					studioProcesses: running,
				},
				null,
				2,
			),
		);
		return 0;
	}

	io.log(lockLine);
	if (rows.length === 0) {
		io.log("no Studio window is on the MCP proxy");
	}
	for (const row of rows) {
		const flamework = row.openedByFlameworkTest
			? `opened by flamework-test for ${row.thisProject ? "this project" : row.project}; ${
					row.holdsLock
						? view.state === "expired"
							? "holds the Studio lock, expired"
							: "holds the Studio lock"
						: "its lock is stale"
				}`
			: "not opened by flamework-test for any project (the user's, an older flamework-test's, or opened by hand)";
		io.log(`${row.studio_id}  ${row.name || "(still loading)"}  [${flamework}]`);
	}
	if (studios.length === 0 && running.length > 0) {
		io.error(
			`Roblox Studio is running (${running.map((window) => `PID ${window.pid}, "${window.title}"`).join("; ")}), but the MCP proxy reaches none of it: its "MCP server" setting is probably off; ask the user to turn it on in Studio's Assistant settings, then run this again`,
		);
	} else if (unreachable > 0) {
		io.error(
			`note: ${running.length} Studio processes are running and ${studios.length} windows are on the MCP proxy; a window whose "MCP server" setting is off is not listed`,
		);
	}
	return 0;
}

/** A tool's description, its first line only, for the list. */
function firstLine(text: string | undefined): string {
	return (text ?? "").trim().split(/\r?\n/)[0] ?? "";
}

/** The tool the proxy offers under a name, or a refusal listing the names it has. */
function findTool(tools: ToolInfo[], name: string): ToolInfo {
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) {
		throw new CliError(
			`the MCP proxy has no tool named "${name}"`,
			`it has: ${tools.map((entry) => entry.name).join(", ") || "none"}; \`flamework-test studio tools\` describes them`,
		);
	}
	return tool;
}

/**
 * `studio tools [name]`: the tools the proxy offers, read live from it (`tools/list`), so the list
 * is whatever this Studio has. With a name, that tool's whole description and input schema.
 */
async function cmdStudioTools(flags: Flags, io: Io): Promise<number> {
	const client = await io.connectStudio();
	let tools: ToolInfo[];
	try {
		tools = await client.tools();
	} finally {
		await client.close();
	}

	if (flags.tool !== undefined) {
		const tool = findTool(tools, flags.tool);
		if (flags.json === true) {
			io.log(JSON.stringify(tool, null, 2));
			return 0;
		}
		io.log(tool.name);
		io.log("");
		io.log((tool.description ?? "(no description)").trim());
		io.log("");
		io.log("arguments (JSON schema):");
		io.log(JSON.stringify(tool.inputSchema ?? {}, null, 2));
		if (takesStudioId(tool)) {
			io.log("");
			io.log("studio_id is filled in from --studio <id> (`flamework-test studio list` lists the ids).");
		}
		return 0;
	}

	if (flags.json === true) {
		io.log(JSON.stringify(tools, null, 2));
		return 0;
	}
	const width = Math.max(0, ...tools.map((tool) => tool.name.length));
	for (const tool of tools) io.log(`${tool.name.padEnd(width)}  ${firstLine(tool.description)}`);
	io.log("");
	io.log(
		"`flamework-test studio tools <name>` prints one tool's description and arguments; `flamework-test studio call <name> --studio <id> '<json>'` calls it",
	);
	return 0;
}

function takesStudioId(tool: ToolInfo): boolean {
	return tool.inputSchema?.properties?.studio_id !== undefined;
}

/** The arguments `studio call` was given: the positional JSON, or `--args-file`, or none. */
async function toolArguments(flags: Flags, io: Io): Promise<Record<string, unknown>> {
	if (flags.arguments !== undefined && flags["args-file"] !== undefined) {
		throw new UsageError("the tool's arguments were given twice: as JSON and with --args-file");
	}
	let text: string;
	let from: string;
	if (flags["args-file"] !== undefined) {
		const path = resolve(io.cwd, flags["args-file"]);
		if (!(await io.exists(path))) throw new CliError(`${flags["args-file"]} does not exist`);
		text = await io.readTextFile(path);
		from = flags["args-file"];
	} else if (flags.arguments !== undefined) {
		text = flags.arguments;
		from = "the arguments";
	} else {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UsageError(
			`${from} must be a JSON object, and did not parse (${error instanceof Error ? error.message : String(error)}): ${text.length > 200 ? `${text.slice(0, 200)}...` : text}. A shell may strip the quotes inside it (Windows PowerShell does): put the JSON in a file and pass --args-file <file>`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new UsageError(`${from} must be a JSON object, like {"code": "return 1"}`);
	}
	return parsed as Record<string, unknown>;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

/** Prints a tool's answer: text on stdout, each image written to a file under `dir`, its path printed. */
async function printToolResult(result: ToolResult, tool: string, dir: string, io: Io): Promise<void> {
	let images = 0;
	const stamp = iso(io.now().getTime()).replace(/[:.]/g, "-");
	for (const content of result.content ?? []) {
		if (content.type === "text") {
			io.log(content.text ?? "");
		} else if ((content.type === "image" || content.type === "audio") && typeof content.data === "string") {
			images += 1;
			const extension = IMAGE_EXTENSIONS[content.mimeType ?? ""] ?? content.mimeType?.split("/")[1] ?? "bin";
			const path = join(dir, `${tool}-${stamp}-${images}.${extension}`);
			await io.writeBinaryFile(path, new Uint8Array(Buffer.from(content.data, "base64")));
			io.log(path);
		} else if (content.type === "resource" && typeof content.resource === "object" && content.resource !== null) {
			const resource = content.resource as { text?: string; uri?: string };
			io.log(resource.text ?? JSON.stringify(content.resource));
		} else {
			io.log(JSON.stringify(content));
		}
	}
}

/**
 * `studio call <tool> --studio <id> [json-args | --args-file <file>]`: calls any tool the proxy
 * offers. A tool that takes `studio_id` gets the window `--studio` names (else the window
 * flamework-test opened for this project, as every studio command finds it), and acts only on a
 * window flamework-test opened for this project unless `--any-window`, refused before any call to
 * it. Text is printed, images are written to files (`--out`, else the temp folder) and their
 * paths printed; `--json` prints the raw answer. A tool's error exits 1 with its message, without
 * the Studio Assistant's own locations in front of it.
 */
async function cmdStudioCall(flags: Flags, io: Io): Promise<number> {
	if (flags.tool === undefined) {
		throw new UsageError(
			"studio call needs the tool's name: flamework-test studio call <tool> --studio <id> [json-args]; `flamework-test studio tools` lists them",
		);
	}
	const name = flags.tool;
	const args = await toolArguments(flags, io);
	const given = args.studio_id;
	if (given !== undefined && typeof given !== "string") throw new UsageError("studio_id must be a string");
	if (given !== undefined && flags.studio !== undefined && given !== flags.studio) {
		throw new UsageError(
			`studio_id is given twice, and differently: --studio ${flags.studio} and "studio_id": "${given}"`,
		);
	}
	const timeoutMs = parseDurationMs(flags.timeout ?? DEFAULT_TIMEOUT, 120_000);
	const dir = flags.out !== undefined ? resolve(io.cwd, flags.out) : capturesDir();

	// Only a refusal of the sandbox's: an error that merely names require (one of something that is
	// not a ModuleScript, say) is not one, and Studio need not run MCP code sandboxed at all.
	const failed = (message: string): CliError =>
		new CliError(
			`${name} failed: ${message}`,
			name === "execute_luau" && isCapabilityRefusal(message) ? SNIPPET_SANDBOX_HINT : undefined,
		);

	/**
	 * One call. `retry`: a windowless listing, tried again half a second apart while it fails, as a
	 * proxy just started fails until it has joined the proxies' hub (listing the windows does the same).
	 */
	const call = async (client: StudioClient, studio: StudioEntry | undefined, retry = false): Promise<number> => {
		const sent = io.interruption.hold(
			`the call of ${name}${studio !== undefined ? ` in ${studio.name}` : ""}, which runs on in Studio until it returns`,
		);
		let result: ToolResult | undefined;
		let failure: unknown;
		for (let attempt = 1; ; attempt += 1) {
			try {
				result = await client.callRaw(
					name,
					studio !== undefined ? { ...args, studio_id: studio.id } : args,
					timeoutMs,
				);
				failure = undefined;
			} catch (error) {
				rethrowInterrupted(error);
				failure = error;
				result = undefined;
			}
			const ok = failure === undefined && result?.isError !== true;
			if (ok || !retry || attempt >= WINDOWLESS_ATTEMPTS) break;
			await io.sleep(500);
		}
		sent();
		if (result === undefined) {
			throw failed(toolErrorMessage(failure instanceof Error ? failure.message : String(failure), name));
		}

		if (flags.json === true) {
			io.log(JSON.stringify(result, null, 2));
			return result.isError === true ? 1 : 0;
		}
		if (result.isError === true) throw failed(toolErrorMessage(textOf(result).trim(), name));
		await printToolResult(result, name, dir, io);
		return 0;
	};

	const client = await io.connectStudio();
	try {
		const tool = findTool(await client.tools(), name);
		const named = flags.studio ?? given;
		// A window named, by --studio or in the arguments, is found and refused as every command's is,
		// whatever the tool's arguments say.
		if (named !== undefined || takesStudioId(tool)) {
			if (!takesStudioId(tool)) {
				io.error(
					`note: ${name} lists no studio_id argument (\`flamework-test studio tools ${name}\`); it is sent with the studio_id of the window named all the same`,
				);
			}
			const target = { ...flags, ...(named !== undefined ? { studio: named } : {}) };
			return await withStudio(target, io, `call ${name} in`, (proxy, studio) => call(proxy, studio), client);
		}
		// No window named, and none in its arguments: only a tool known to act on no window is sent so.
		const windowless = WINDOWLESS_TOOLS.includes(name);
		if (!windowless && flags["any-window"] !== true) {
			throw new CliError(
				`refusing to call ${name}: it takes no studio_id (\`flamework-test studio tools ${name}\` shows its arguments), so which Studio window it acts on cannot be told, and it may be a window the user has open`,
				"pass --any-window to call it anyway, but only once the user has said so",
			);
		}
		return await call(client, undefined, windowless);
	} finally {
		await client.close();
	}
}

/**
 * `studio lock`: who holds the Studio lock, and whether it is live, expired or stale: the holder's
 * project, place, command, since when, its last activity and when its hold runs out, whether its
 * command and its Studio process are still running, and with `--check-window`, whether its window
 * is on the MCP proxy (asked only while the process runs: starting a proxy joins the hub other
 * clients share, so it is not done unasked). Read-only: a stale lock is freed by the next command
 * that takes it, or by `studio unlock`.
 */
async function cmdStudioLock(flags: Flags, io: Io): Promise<number> {
	const record = await io.studioLock.read();
	const now = io.now().getTime();
	const view = await judgeLock(record, now, io.probeProcesses);
	const owner = view.owner;

	let proxy: "listed" | "listed as another place" | "not listed" | "not checked" = "not checked";
	let proxyWhy: string | undefined;
	if (flags["check-window"] === true && owner?.mcpId !== undefined && view.window === "running") {
		try {
			const client = await io.connectStudio();
			try {
				const entry = (await client.studios()).find((listed) => listed.id === owner.mcpId);
				proxy =
					entry === undefined
						? "not listed"
						: isLockWindow(owner, entry)
							? "listed"
							: "listed as another place";
			} finally {
				await client.close();
			}
		} catch (error) {
			rethrowInterrupted(error);
			proxyWhy = error instanceof Error ? error.message : String(error);
		}
	}

	const state = view.state;
	const verdict =
		state === "free"
			? "free: no window flamework-test opened holds it"
			: state === "stale"
				? `stale: ${whyStale(view)}; the next command that opens a window takes it over (or \`flamework-test studio unlock\`)`
				: state === "expired"
					? `expired: ${view.abandoned === true ? whyAbandoned(view) : `its window has sat unused past its ${owner!.holdMinutes}-minute hold`}; the next command that opens a window closes it and takes the lock (or \`flamework-test studio unlock\`)`
					: owner === undefined
						? "live: a command is taking it right now"
						: view.cli === "running"
							? `live: its \`${owner.command}\` is running (flamework-test PID ${owner.cliPid}); commands that open a window wait until it ends${owner.kept === true ? ", and then for the window it leaves open" : ", which frees it"}`
							: `live: commands that open a window wait for it, until \`flamework-test studio close\` in ${owner.project}, the window closing, or its hold running out at ${owner.expires}`;

	if (flags.json === true) {
		io.log(
			JSON.stringify(
				{
					state,
					owner: owner ?? null,
					studioProcess: owner?.studioPid !== undefined ? view.window : null,
					cliProcess: view.cli ?? null,
					idleMinutes: view.idleMs !== undefined ? Math.round(view.idleMs / 60_000) : null,
					proxy,
					where: io.studioLock.where,
				},
				null,
				2,
			),
		);
		return 0;
	}

	io.log(`Studio lock (${io.studioLock.where}): ${verdict}`);
	if (owner === undefined) return 0;
	io.log(`  project:  ${owner.project}`);
	io.log(`  command:  ${owner.command}`);
	io.log(`  place:    ${owner.place}`);
	io.log(`  since:    ${owner.since}`);
	io.log(`  used:     ${owner.lastActivity} (${span(now - Date.parse(owner.lastActivity))} ago)`);
	io.log(
		`  expires:  ${owner.expires} (${Date.parse(owner.expires) > now ? `in ${span(Date.parse(owner.expires) - now)}` : `${span(now - Date.parse(owner.expires))} ago`}; a ${owner.holdMinutes}-minute hold)`,
	);
	io.log(
		`  run:      flamework-test PID ${owner.cliPid}, ${
			view.cli === "running"
				? "running"
				: view.cli === "reused"
					? `ended: its PID is another process now${view.cliReusedBy !== undefined ? ` (${view.cliReusedBy})` : ""}`
					: "ended"
		}${owner.kept === true ? "; it leaves its window open" : ""}`,
	);
	io.log(
		owner.studioPid !== undefined
			? `  studio:   PID ${owner.studioPid}, ${view.window === "running" ? "running" : view.window === "reused" ? `no longer that Studio (PID reused${view.reusedBy !== undefined ? ` by ${view.reusedBy}` : ""})` : "no longer running"}`
			: "  studio:   no window open",
	);
	if (owner.mcpId !== undefined) {
		io.log(
			`  mcp:      ${owner.mcpId}, ${
				proxy === "listed"
					? "on the MCP proxy"
					: proxy === "listed as another place"
						? "listed by the MCP proxy as another place: the id is another window's now"
						: proxy === "not listed"
							? "not on the MCP proxy"
							: proxyWhy !== undefined
								? `not checked (${proxyWhy})`
								: flags["check-window"] === true
									? "not checked: its Studio process is not running"
									: "not checked (--check-window asks the MCP proxy)"
			}`,
		);
	}
	return 0;
}

/**
 * `studio unlock`: frees a stale lock, and an expired one, closing its window as a command that
 * takes the lock would (flamework-test's window only). A live lock with time left on its hold is
 * refused, naming the holder and when its hold runs out; `--force` frees it too, closing its window.
 */
async function cmdStudioUnlock(flags: Flags, io: Io): Promise<number> {
	const record = await io.studioLock.read();
	const view = await judgeLock(record, io.now().getTime(), io.probeProcesses);
	const by = { project: projectOf(io), command: flags.force === true ? "studio unlock --force" : "studio unlock" };
	const say = (line: string) => io.log(line);

	if (view.state === "free") {
		io.log("the Studio lock is free; nothing to do");
		return 0;
	}
	if (view.state === "stale") {
		const token = record.kind === "held" ? record.owner.token : undefined;
		if (await io.studioLock.free(token)) {
			io.log(`freed the Studio lock: ${whyStale(view)}`);
			await afterWindowGone(io, view, by);
		} else {
			io.log("the Studio lock changed hands meanwhile; `flamework-test studio lock` shows it");
		}
		return 0;
	}
	if (view.state === "expired") {
		if (!(await closeExpiredWindow(io, view, by, "expired", say))) {
			io.log("the Studio lock was used or changed hands meanwhile; `flamework-test studio lock` shows it");
		}
		return 0;
	}
	if (flags.force !== true || view.owner === undefined) {
		const owner = view.owner;
		throw new CliError(
			owner !== undefined
				? `the Studio lock is live: ${describeHolder(view, io.now().getTime())}`
				: "the Studio lock is being taken right now",
			owner === undefined
				? "try again in a moment"
				: view.cli === "running"
					? `it is freed when that command ends${owner.kept === true ? " and its window closes" : ""}. --force closes its window now: only with the go-ahead of whoever is using it`
					: `it is freed by \`flamework-test studio close\` in ${owner.project}, by the window closing, or once its hold runs out (${owner.expires}). --force closes its window now: only with the go-ahead of whoever is using it`,
		);
	}
	if (!(await closeExpiredWindow(io, view, by, "forced", say))) {
		io.log("the Studio lock changed hands meanwhile; `flamework-test studio lock` shows it");
	}
	return 0;
}

// -------------------------------------------------------------------- test

/**
 * The tests, run once per project the run follows: in Studio on this machine by default, in the
 * cloud with `--cloud`. One project is the plain run; several are run one after another, each
 * under its own heading and with its own place file, every one of them even after one fails,
 * with a line at the end saying how each fared. The exit code is the worst of them. What refuses
 * up front (a missing project file, no lune, no Studio) is checked before the first run starts.
 *
 * A Studio run takes the Studio lock before it launches its first window, and holds it until its
 * last window has closed: its projects' windows open one after another, never beside another
 * project's. `--keep` leaves the window open, holding the lock, so it keeps one project's only.
 */
async function cmdTest(flags: Flags, io: Io): Promise<number> {
	if (flags.published && !flags.cloud) {
		throw new UsageError("--published is for the cloud: flamework-test test <file> --cloud --published");
	}
	if (flags.cloud && flags["keep-awake"] === true) {
		throw new UsageError("--keep-awake is for Studio runs: a cloud run has no display on this machine to keep on");
	}
	if (flags.cloud && (flags["lock-timeout"] !== undefined || flags.hold !== undefined)) {
		throw new UsageError(
			`--${flags.hold !== undefined ? "hold" : "lock-timeout"} is for Studio runs: a cloud run opens no Studio window and takes no lock`,
		);
	}
	if (!flags.cloud && flags.hold !== undefined && flags.keep !== true) {
		throw new UsageError(
			"--hold is for a window left open: flamework-test test <file> --keep --hold <minutes>, or studio open --hold <minutes>",
		);
	}
	if (flags.cloud) {
		placeFileOf(flags, "cloud test");
		requireCloudEntry(io);
	}

	flags = withRunSettings(flags, io);
	// KEEP_AWAKE and testing.keepAwake are for the Studio runs: a cloud run leaves them alone.
	const keepAwake = flags.cloud !== true && keepAwakeOf(flags, io);
	const projects = projectsOf(flags, io);
	if (flags.cloud === true) return await withKeepAwake(keepAwake, io, () => testProjects(flags, io, projects));

	if (flags.keep === true && projects.length > 1) {
		throw new UsageError(
			"--keep leaves a Studio window open, and flamework-test keeps one window open at a time: keep one project's (--project <file> --keep)",
		);
	}
	// Misspelt settings are refused before anything is patched or opened.
	lockTimeoutOf(flags, io);
	const lock = new LazyStudioLock(io, flags, {
		command: flags.keep === true ? "test --keep" : "test",
		holdMinutes: holdOf(flags, io),
		keep: flags.keep === true,
	});
	try {
		return await withKeepAwake(keepAwake, io, () => testProjects(flags, io, projects, lock));
	} finally {
		await lock.finish();
	}
}

/** The Studio lock of a `test`, taken when its first window is about to open and kept to its end. */
class LazyStudioLock {
	private held: HeldLock | undefined;

	constructor(
		private readonly io: Io,
		private readonly flags: Flags,
		private readonly request: Pick<LockRequest, "command" | "holdMinutes" | "keep">,
	) {}

	async take(place: Pick<LockOwner, "place" | "placeFile" | "placeId">): Promise<HeldLock> {
		this.held ??= await takeStudioLock(this.io, this.flags, { ...this.request, ...place }, (line) =>
			this.io.log(line),
		);
		return this.held;
	}

	/** A project after the first: the lock, held already, names the place it is about to make and open. */
	async next(file: string): Promise<void> {
		await this.held?.moveTo({ place: file, placeFile: file });
	}

	async finish(): Promise<void> {
		await this.held?.finish();
	}
}

/** Runs the tests under every project, and says how each fared when there are several. */
async function testProjects(flags: Flags, io: Io, projects: ProjectChoice[], lock?: LazyStudioLock): Promise<number> {
	if (projects.length === 1) {
		return await testProject(flags, io, projects[0]!, lock);
	}

	// Every project file is read before the first run, so a typo in the last does not cost the runs before it.
	for (const project of projects) await readProject(project, io);

	const outcomes: Array<{ project: ProjectChoice; code: number; skipped: number }> = [];
	for (const project of projects) {
		// A Ctrl+C during the last project's cleanup lets that finish; the next project does not start.
		io.interruption.check();
		io.log("");
		io.log(`=== ${project.name}: ${relative(io.cwd, project.path)} ===`);
		const before = skipTally.get(io) ?? 0;
		const code = await testProject(flags, io, project, lock);
		outcomes.push({ project, code, skipped: (skipTally.get(io) ?? 0) - before });
	}

	io.log("");
	io.log(
		`projects: ${outcomes
			.map(
				({ project, code, skipped }) =>
					`${project.name} ${code === 0 ? "passed" : "FAILED"}${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
			)
			.join(", ")}`,
	);
	return Math.max(...outcomes.map(({ code }) => code));
}

async function testProject(flags: Flags, io: Io, project: ProjectChoice, lock?: LazyStudioLock): Promise<number> {
	if (flags.cloud) return await cloudTestProject(flags, io, project);
	return await studioTestProject(flags, io, project, lock!);
}

/**
 * The default way to run the tests: the place Rojo built, opened in Studio on this machine, run
 * on both realms in a play session, and closed again. A window that already has that very file
 * open is from an earlier build and would test stale code, so it is closed first and the file
 * opened afresh; windows of other files are never touched, whatever their names. The window this
 * run opens is known by the process it started, which is what closes it, whether the run finished
 * or gave up on it (unless `--keep`); a window that will not close fails the run, naming it.
 */
async function studioTestProject(flags: Flags, io: Io, project: ProjectChoice, lock: LazyStudioLock): Promise<number> {
	const realms = realmsOf(flags.realm, "both");
	await lock.next(plannedPlaceOf(flags, io, "test", project));
	const { absolute: file, label } = await placeToRun(flags, io, "test", project);
	const name = basename(file);
	const exe = requireStudioExe(io);
	const keep = flags.keep === true;
	const place = { place: file, placeFile: file };
	const held = await lock.take(place);

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
				await held.windowClosed();
				return true;
			} catch (closeError) {
				printError(closeError, io);
				return false;
			}
		};

		let code: number;
		let studio: StudioEntry | undefined;
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
			await held.check();
			pid = await io.launch([exe, ...studioOpenArguments({ file })]);
			launched = true;
			await held.launched(pid, place);
			const window = ownWindow(pid, name);
			releaseWindow = keep
				? io.interruption.hold(`${window}, which --keep leaves open`)
				: io.interruption.hold(window, `closed ${window}`);
			io.log(`opening ${label} in Studio; waiting for it to connect...`);

			const found = await findLaunchedWindow(client, { file }, pid, before, flags, io);
			studio = found.studio;
			if (studio === undefined) {
				const closed = await giveUp();
				throw found.unaccounted
					? cannotTell(
							name,
							"another Studio window showing a file of that name has not registered with it",
							found.others,
						)
					: neverConnected(label, keep ? "open" : closed ? "closed" : "unstated", pid);
			}
			release();
			release = undefined;
			io.log(`connected: ${studio.name} (${studio.id})`);
			await held.connected(studio.id);

			code = await runRealms(client, studio, realms, flags, io, releaseWindow, () => held.renew());
		} catch (error) {
			if (launched && !gaveUp) await giveUp();
			throw error;
		} finally {
			release?.();
		}

		if (keep) {
			io.log("Studio left open (--keep)");
			io.log(windowLine(studio.id, pid));
			io.log(
				`it holds the Studio lock until \`flamework-test studio close\`, or until it has sat unused for ${held.owner.holdMinutes} min (--hold)`,
			);
			return code;
		}
		try {
			await closeOwnWindow(pid, file, io, releaseWindow);
			await held.windowClosed();
		} catch (error) {
			// The results stand, but the run did not clean up after itself, and fails saying so.
			printError(error, io);
			return 1;
		}
		return code;
	} finally {
		await client.close();
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

	// `studio call <tool> --help` is `studio tools <tool>`: the tool's own description and arguments.
	if (parsed.flags.help && parsed.command === "studio call" && parsed.flags.tool !== undefined) {
		parsed = {
			command: "studio tools",
			flags: { tool: parsed.flags.tool, ...(parsed.flags.json ? { json: true } : {}) },
		};
	} else if (parsed.flags.help || parsed.command === "help") {
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
			case "studio list":
				return await cmdStudioList(flags, io);
			case "studio tools":
				return await cmdStudioTools(flags, io);
			case "studio call":
				return await cmdStudioCall(flags, io);
			case "studio lock":
				return await cmdStudioLock(flags, io);
			case "studio unlock":
				return await cmdStudioUnlock(flags, io);
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
