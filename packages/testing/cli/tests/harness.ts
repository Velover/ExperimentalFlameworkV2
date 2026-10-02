import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { main, type CliDeps } from "../src/cli.ts";
import type { CloudSettings } from "../src/config.ts";
import type { FetchLike } from "../src/openCloud.ts";
import type { ClosedWindow, CloseTarget, StudioClient, StudioEntry } from "../src/studio.ts";

export const SECRET = "secret-key-that-must-never-be-printed";
export const UNIVERSE = "10765968722";
export const PLACE = "108973151455286";

export const ENV = {
	TESTING_PLACE_API_KEY: SECRET,
	TESTING_UNIVERSE_ID: UNIVERSE,
	TESTING_PLACE_ID: PLACE,
};

/** The directory every run's relative paths resolve against. */
export const FIXTURE_CWD = join(import.meta.dir, "..", "fixture-cwd");

/** A Roblox Studio process on the fake machine: what the real close script would see of it. */
export interface FakeWindow {
	pid: number;
	/** A local file's window is titled with the file's full path: `<file> - Roblox Studio`. */
	title: string;
	/** The place file on the command line it was started with, if any; it may have another open since. */
	startedWith?: string;
}

/**
 * A terminal's Ctrl+C for one run: `press` delivers the signal to the handler the CLI listens with,
 * there and then, as Windows delivers a console Ctrl+C on a thread of its own. One press is one
 * signal, as every shell, `bun run` and bin shim measured delivers it.
 */
export interface FakeCtrlC {
	press: (signal?: string) => void;
	/** Whether the CLI is listening; it stops once the command has returned. */
	readonly listening: boolean;
}

export function fakeCtrlC(): FakeCtrlC & { listen: (handler: (signal: string) => void) => () => void } {
	let handler: ((signal: string) => void) | undefined;
	const ctrlC = {
		press: (signal = "SIGINT") => handler?.(signal),
		get listening() {
			return handler !== undefined;
		},
		listen: (next: (signal: string) => void) => {
			handler = next;
			return () => {
				handler = undefined;
			};
		},
	};
	return ctrlC;
}

/** An answer that never comes: a Studio still running the tests, a lune still patching. */
export const never = <T>(): Promise<T> => new Promise<T>(() => {});

export const TASK_PATH = `universes/${UNIVERSE}/places/${PLACE}/versions/4/luau-execution-sessions/s/tasks/t`;

interface Call {
	url: string;
	init: RequestInit;
}

export interface Harness {
	code: number;
	out: string;
	err: string;
	all: string;
	calls: Call[];
	written: Record<string, string>;
	/** Every child process the CLI ran, with inherited output. */
	spawned: string[][];
	/** Every program the CLI started and left running. */
	launched: string[][];
	/** Every MCP tool call, in order. */
	studioCalls: Array<{ name: string; args: Record<string, unknown> }>;
	/** The timeout each of those calls was given, in the same order. */
	studioCallTimeouts: Array<number | undefined>;
	/** What each close asked for: `pid <n> <file name>`, `file <file name>` or `title <title>`. */
	closeTargets: string[];
	/** The windows the closes ended, by name (the file name, or the title before " - Roblox Studio"), in order. */
	closedWindows: string[];
	/** The Studio windows still open when the run returned. */
	windows: FakeWindow[];
	/** Every window-name claim and release, with how many programs had been launched at that point. */
	claims: string[];
	/** The folders the run made for a patch's files, in order, and the ones it removed again. */
	madeDirs: string[];
	removedDirs: string[];
	/** The files the run removed (Studio's lock files). */
	removedFiles: string[];
	/** Whether the run ended at once through the process's exit (a second Ctrl+C), rather than by returning. */
	exitedAtOnce: boolean;
	/** How many MCP proxies the run connected, and how many of them it left unclosed. */
	proxies: { connected: number; open: number };
	/** Every state the run asked SetThreadExecutionState for, in order (0x80000003 keeps the display on, 0x80000000 lets go). */
	executionStates: number[];
	/** The thread's execution state when the run returned: 0x80000000 when nothing is held. */
	executionState: number;
}

/** A canned Studio: what the proxy lists, and what each tool answers. */
export interface FakeStudio {
	/** What the proxy lists; a function is asked on every listing, so windows can register mid-run. */
	studios?: StudioEntry[] | (() => StudioEntry[]);
	/**
	 * Answers by tool name; a function sees the arguments and may change state between calls. It also
	 * sees the timeout the call was given, and may let fake time pass (`elapse`): a call that never
	 * answers elapses its timeout and throws, as the real proxy does.
	 */
	answers?: Record<string, string | ((args: Record<string, unknown>, call: FakeCall) => string | Promise<string>)>;
}

/** What a fake tool answer sees of the call. */
export interface FakeCall {
	timeoutMs: number | undefined;
	/** Lets this much fake time pass, as `sleep` does. */
	elapse: (ms: number) => void;
}

export const TESTING_STUDIO: StudioEntry = { id: "studio-1", name: `TestingExperience (placeId: ${PLACE})` };
export const OTHER_STUDIO: StudioEntry = { id: "studio-2", name: "Other Place  (placeId: 123456789012345)" };

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

export async function runCli(
	argv: string[],
	options: {
		responses?: Response[];
		files?: Record<string, string>;
		env?: Record<string, string | undefined>;
		/** What the config reader answers; by default nothing, so no real .env is read. */
		settings?: Partial<CloudSettings>;
		/** Exit code of every spawned process; a function may decide per command, and answer later. */
		spawnCode?: number | ((command: string[]) => number | Promise<number>);
		studio?: FakeStudio;
		/** Where Roblox Studio is; undefined means not installed. */
		studioExe?: string | undefined;
		/** Studio windows already open when the run starts; each one the CLI launches is added (PIDs from 4001). */
		windows?: FakeWindow[];
		/** What becomes of each window a close acts on; default "closed". "open": it survives even the forced close. */
		closeOutcome?: "closed" | "forced" | "open";
		/** Another run's PID holding the window name when this run claims it; by default nobody. */
		claimHolder?: number;
		/** Runs when the CLI launches a program, with the command, so a fake Studio can start listing the window it opened. */
		onLaunch?: (command: string[]) => void;
		/** How many removals of a file fail first, as Windows refuses to remove a file an ended process still holds. */
		removalsRefused?: number;
		/** The terminal's Ctrl+C; without one, nothing interrupts the run. */
		ctrlC?: ReturnType<typeof fakeCtrlC>;
		/** Runs when the CLI closes windows, before the close acts. */
		onClose?: (target: CloseTarget) => void;
		/** Runs when the CLI removes a file (a lock beside a place), before the removal acts. */
		onRemoveFile?: (path: string) => void;
		/** Answers a request in place of the queued responses when it returns one: a request still in flight, say. */
		onFetch?: (url: string) => Promise<Response> | undefined;
		/** The platform the run sees; by default `win32`, whatever this machine is. */
		platform?: string;
		/**
		 * Answers SetThreadExecutionState in place of the fake one, which returns the state before;
		 * it may throw (the function could not be reached) or return 0 (Windows refused).
		 */
		setExecutionState?: (state: number) => number;
	} = {},
): Promise<Harness> {
	const out: string[] = [];
	const err: string[] = [];
	const calls: Call[] = [];
	const written: Record<string, string> = {};
	const spawned: string[][] = [];
	const launched: string[][] = [];
	const studioCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const studioCallTimeouts: Array<number | undefined> = [];
	const closeTargets: string[] = [];
	const closedWindows: string[] = [];
	const claims: string[] = [];
	const madeDirs: string[] = [];
	const removedDirs: string[] = [];
	const removedFiles: string[] = [];
	let refusedRemovals = 0;
	const proxies = { connected: 0, open: 0 };
	const executionStates: number[] = [];
	// The thread's state as Windows keeps it: ES_CONTINUOUS alone is nothing held.
	let executionState = 0x80000000;
	let exitedAtOnce = false;
	let exitAtOnce: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => (exitAtOnce = resolve));
	// The caller's own array, so a test can open or retitle a window mid-run.
	const windows: FakeWindow[] = options.windows ?? [];
	let clock = new Date("2026-09-11T12:00:00.000Z").getTime();
	const queue = [...(options.responses ?? [])];
	const files = options.files ?? {};

	// Files given up front, plus whatever the CLI wrote during the run (build/version.json).
	const find = (path: string): string | undefined => {
		const normalized = path.replaceAll("\\", "/");
		for (const [suffix, content] of [...Object.entries(files), ...Object.entries(written)]) {
			if (normalized.endsWith(suffix)) return content;
		}
		return undefined;
	};

	const fetchImpl: FetchLike = async (url, init = {}) => {
		calls.push({ url, init });
		const answer = options.onFetch?.(url);
		if (answer !== undefined) return await answer;
		const next = queue.shift();
		if (!next) throw new Error(`unexpected fetch call: ${url}`);
		return next;
	};

	const deps: CliDeps = {
		fetch: fetchImpl,
		// A clock that only sleeping advances, so a wait for a deadline ends without wall time passing.
		sleep: async (ms) => {
			clock += ms;
		},
		readFile: async () => new Uint8Array([0x89, 0x01]).buffer,
		readTextFile: async (path) => {
			const content = find(path);
			if (content === undefined) throw new Error(`unexpected read: ${path}`);
			return content;
		},
		writeTextFile: async (path, text) => {
			written[path.replaceAll("\\", "/")] = text;
		},
		exists: async (path) => find(path) !== undefined,
		spawn: async (command) => {
			spawned.push(command);
			const code = options.spawnCode ?? 0;
			return typeof code === "function" ? await code(command) : code;
		},
		launch: async (command) => {
			launched.push(command);
			options.onLaunch?.(command);
			// A file is launched as [exe, file]; a cloud place with -task EditPlace and its ids.
			const pid = 4000 + launched.length;
			const file = command.length === 2 ? command[1]! : undefined;
			windows.push(
				file !== undefined
					? { pid, title: `${file} - Roblox Studio`, startedWith: file }
					: { pid, title: "TestingExperience - Roblox Studio" },
			);
			return pid;
		},
		closeWindow: async (target) => {
			options.onClose?.(target);
			return closeFakeWindows(target);
		},
		studioWindows: async () => windows.map((window) => ({ pid: window.pid, title: window.title })),
		claimWindowName: async (name, onWait) => {
			if (options.claimHolder !== undefined) onWait(options.claimHolder);
			claims.push(`claim ${name} (launched ${launched.length}, closed ${closedWindows.length})`);
			return () => claims.push(`release ${name} (launched ${launched.length}, closed ${closedWindows.length})`);
		},
		connectStudio: async (): Promise<StudioClient> => {
			const fake = options.studio ?? {};
			proxies.connected += 1;
			proxies.open += 1;
			return {
				call: async (name, args = {}, timeoutMs) => {
					studioCalls.push({ name, args });
					studioCallTimeouts.push(timeoutMs);
					const answer = fake.answers?.[name];
					if (answer === undefined) throw new Error(`no canned answer for ${name}`);
					const elapse = (ms: number) => {
						clock += ms;
					};
					return typeof answer === "function" ? await answer(args, { timeoutMs, elapse }) : answer;
				},
				studios: async () => (typeof fake.studios === "function" ? fake.studios() : (fake.studios ?? [])),
				close: () => {
					proxies.open -= 1;
				},
			};
		},
		studioExe: () => ("studioExe" in options ? options.studioExe : "C:/Roblox/RobloxStudioBeta.exe"),
		log: (message) => out.push(message),
		error: (message) => err.push(message),
		env: options.env ?? ENV,
		cwd: FIXTURE_CWD,
		// A folder of its own per patch, as mkdtemp makes one; nothing is written to it for real.
		makeTempDir: async () => {
			const dir = `${tmpdir().replaceAll("\\", "/")}/flamework-test-fake${madeDirs.length + 1}`;
			madeDirs.push(dir);
			return dir;
		},
		removeDir: async (path) => {
			removedDirs.push(path.replaceAll("\\", "/"));
		},
		removeFile: async (path) => {
			options.onRemoveFile?.(path);
			const normalized = path.replaceAll("\\", "/");
			if (refusedRemovals < (options.removalsRefused ?? 0)) {
				refusedRemovals += 1;
				throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
			}
			removedFiles.push(normalized);
			for (const key of Object.keys(files)) {
				if (normalized.endsWith(key)) delete files[key];
			}
		},
		now: () => new Date(clock),
		loadSettings: () => ({ env: {}, ...options.settings }),
		// Never the real process's signals: a run hears only the Ctrl+C a test presses.
		onInterrupt: (handler) => (options.ctrlC ? options.ctrlC.listen(handler) : () => {}),
		exit: (code) => {
			exitedAtOnce = true;
			exitAtOnce(code);
		},
		platform: options.platform ?? "win32",
		// Never the real SetThreadExecutionState: what the run asks for is recorded, and answered
		// the way Windows answers, with the state before.
		setExecutionState: (state) => {
			executionStates.push(state);
			if (options.setExecutionState !== undefined) return options.setExecutionState(state);
			const before = executionState;
			executionState = state;
			return before;
		},
	};

	/** What the real close script does, over the fake machine's windows. */
	function closeFakeWindows(target: CloseTarget): ClosedWindow[] {
		const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();
		const titled = (window: FakeWindow, file: string) => same(window.title, `${file} - Roblox Studio`);
		let act: FakeWindow[] = [];
		let leave: FakeWindow[] = [];
		if ("pid" in target) {
			// The process the run started: by its title or the command line it was started with.
			closeTargets.push(`pid ${target.pid} ${basename(target.file)}`);
			act = windows.filter(
				(window) =>
					window.pid === target.pid && (titled(window, target.file) || same(window.startedWith, target.file)),
			);
			leave = windows.filter((window) => window.pid !== target.pid && titled(window, target.file));
		} else if ("file" in target) {
			// A window the run did not open: by its title only.
			closeTargets.push(`file ${basename(target.file)}`);
			act = windows.filter((window) => titled(window, target.file));
		} else {
			closeTargets.push(`title ${target.title}`);
			const title = target.title.toLowerCase();
			act = windows.filter(
				(window) => same(window.title, title) || window.title.toLowerCase().endsWith(`\\${title}`),
			);
			if (act.length > 1) [leave, act] = [act, []];
		}

		// The process a run started is ended without asking, as the real script does: what would be
		// "closed" or "forced" for a window that was asked is "ended" for it.
		const asked = options.closeOutcome ?? "closed";
		const outcome = "pid" in target && asked !== "open" ? "ended" : asked;
		const report: ClosedWindow[] = act.map((window) => ({
			pid: window.pid,
			title: window.title,
			outcome,
			...(outcome === "open" ? { error: "Access is denied" } : {}),
		}));
		if (outcome !== "open") {
			for (const window of act) {
				windows.splice(windows.indexOf(window), 1);
				closedWindows.push(basename(window.startedWith ?? window.title.replace(/ - Roblox Studio$/, "")));
			}
		}
		return [
			...report,
			...leave.map((window) => ({ pid: window.pid, title: window.title, outcome: "untouched" as const })),
		];
	}

	// A second Ctrl+C ends the process at once, whatever the run is still waiting for.
	const code = await Promise.race([main(argv, deps), exited]);
	return {
		code,
		out: out.join("\n"),
		err: err.join("\n"),
		all: [...out, ...err].join("\n"),
		calls,
		written,
		spawned,
		launched,
		studioCalls,
		studioCallTimeouts,
		closeTargets,
		closedWindows,
		windows,
		claims,
		madeDirs,
		removedDirs,
		removedFiles,
		exitedAtOnce,
		proxies,
		executionStates,
		executionState,
	};
}

export function resultJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		ok: true,
		realm: "server",
		passed: 2,
		failed: 0,
		durationMs: 12,
		sections: [
			{
				name: "economy",
				passed: 2,
				failed: 0,
				tests: [
					{ name: "buys", ok: true, durationMs: 1 },
					{ name: "sells", ok: true, durationMs: 2 },
				],
			},
		],
		unknown: [],
		...overrides,
	});
}

/** create -> poll(COMPLETE) -> logs */
export function happyPath(results: string[], logLines: string[] = []): Response[] {
	return [
		json({ path: TASK_PATH, state: "QUEUED" }),
		json({ path: TASK_PATH, state: "COMPLETE", output: { results } }),
		json({
			luauExecutionSessionTaskLogs: [{ messages: logLines }],
			nextPageToken: "",
		}),
	];
}
