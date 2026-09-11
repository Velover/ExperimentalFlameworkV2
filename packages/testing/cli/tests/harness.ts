import { join } from "node:path";

import { main, type CliDeps } from "../src/cli.ts";
import type { CloudSettings } from "../src/config.ts";
import type { FetchLike } from "../src/openCloud.ts";
import type { StudioClient, StudioEntry } from "../src/studio.ts";

export const SECRET = "secret-key-that-must-never-be-printed";
export const UNIVERSE = "10765968722";
export const PLACE = "108973151455286";

export const ENV = {
	TESTING_PLACE_API_KEY: SECRET,
	TESTING_UNIVERSE_ID: UNIVERSE,
	TESTING_PLACE_ID: PLACE,
};

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
	closedWindows: string[];
}

/** A canned Studio: what the proxy lists, and what each tool answers. */
export interface FakeStudio {
	studios?: StudioEntry[];
	/** Answers by tool name; a function sees the arguments and may change state between calls. */
	answers?: Record<string, string | ((args: Record<string, unknown>) => string)>;
}

export const TESTING_STUDIO: StudioEntry = { id: "studio-1", name: `TestingExperience (placeId: ${PLACE})` };
export const OTHER_STUDIO: StudioEntry = { id: "studio-2", name: "Dive In  (placeId: 107977544283224)" };

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
		/** Exit code of every spawned process; a function may decide per command. */
		spawnCode?: number | ((command: string[]) => number);
		studio?: FakeStudio;
		/** Where Roblox Studio is; undefined means not installed. */
		studioExe?: string | undefined;
		closeOutcome?: "closed" | "forced" | "none";
		/** Runs when the CLI launches a program, so a fake Studio can start listing the window it opened. */
		onLaunch?: () => void;
	} = {},
): Promise<Harness> {
	const out: string[] = [];
	const err: string[] = [];
	const calls: Call[] = [];
	const written: Record<string, string> = {};
	const spawned: string[][] = [];
	const launched: string[][] = [];
	const studioCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const closedWindows: string[] = [];
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
			return typeof code === "function" ? code(command) : code;
		},
		launch: async (command) => {
			launched.push(command);
			options.onLaunch?.();
		},
		closeWindow: async (titlePrefix) => {
			closedWindows.push(titlePrefix);
			return options.closeOutcome ?? "closed";
		},
		connectStudio: async (): Promise<StudioClient> => {
			const fake = options.studio ?? {};
			return {
				call: async (name, args = {}) => {
					studioCalls.push({ name, args });
					const answer = fake.answers?.[name];
					if (answer === undefined) throw new Error(`no canned answer for ${name}`);
					return typeof answer === "function" ? answer(args) : answer;
				},
				studios: async () => fake.studios ?? [],
				close: () => {},
			};
		},
		studioExe: () => ("studioExe" in options ? options.studioExe : "C:/Roblox/RobloxStudioBeta.exe"),
		log: (message) => out.push(message),
		error: (message) => err.push(message),
		env: options.env ?? ENV,
		cwd: join(import.meta.dir, "..", "fixture-cwd"),
		now: () => new Date(clock),
		loadSettings: () => ({ env: {}, ...options.settings }),
	};

	const code = await main(argv, deps);
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
		closedWindows,
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
