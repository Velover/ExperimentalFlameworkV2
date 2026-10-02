import { describe, expect, test } from "bun:test";
import { basename } from "node:path";

import { parseArgs } from "../src/cli.ts";
import { Interruption } from "../src/interrupt.ts";
import { ES_CONTINUOUS, KEEP_AWAKE_STATE, keepDisplayAwake } from "../src/keepAwake.ts";
import { ENV, fakeCtrlC, happyPath, json, never, OTHER_STUDIO, resultJson, runCli, TESTING_STUDIO } from "./harness.ts";
import type { StudioEntry } from "../src/studio.ts";

/** ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED: the display and the machine kept on. */
const HELD = 0x80000003;
/** ES_CONTINUOUS alone: let go. */
const LET_GO = 0x80000000;

const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";

const RESULTS = {
	Server: JSON.stringify(resultJson()),
	Client: JSON.stringify(resultJson({ realm: "client" })),
};

/** A Studio that lists every file the CLI launches and answers each realm from `execute`. */
/** What each realm answers: the result, or a function that answers it (or never does). */
type Answers = Record<string, string | (() => string | Promise<string>)>;

function studio(execute: Answers = RESULTS) {
	let mode = "Edit";
	const listed: StudioEntry[] = [OTHER_STUDIO];
	return {
		fake: {
			studios: listed,
			answers: {
				get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
				start_stop_play: (args: Record<string, unknown>) => {
					mode = args.is_start ? "Play" : "Edit";
					return args.is_start ? "Game Started" : "Game Stopped";
				},
				execute_luau: (args: Record<string, unknown>) => {
					const answer = execute[args.datamodel_type as string];
					if (answer === undefined) throw new Error(`no result for ${String(args.datamodel_type)}`);
					return typeof answer === "function" ? answer() : answer;
				},
			},
		},
		onLaunch: (command: string[]) => {
			const name = basename(command[1]!);
			listed.push({ id: `studio-${name}-${listed.length}`, name });
		},
	};
}

/** `test place.rbxl` with `argv`, against a Studio that answers both realms. */
async function testRun(argv: string[], options: Parameters<typeof runCli>[1] = {}, execute: Answers = RESULTS) {
	const place = studio(execute);
	return await runCli(["test", "place.rbxl", ...argv], {
		files: { "place.rbxl": "built" },
		studio: place.fake,
		onLaunch: place.onLaunch,
		...options,
	});
}

function fakeIo(options: { platform?: string; answer?: (state: number) => number } = {}) {
	const calls: number[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const interruption = new Interruption();
	return {
		calls,
		out,
		err,
		interruption,
		io: {
			platform: options.platform ?? "win32",
			setExecutionState: (state: number) => {
				calls.push(state);
				return options.answer?.(state) ?? LET_GO;
			},
			log: (message: string) => out.push(message),
			error: (message: string) => err.push(message),
			interruption,
		},
	};
}

describe("keepDisplayAwake", () => {
	test("asks for the display and the machine, and lets go with ES_CONTINUOUS alone, once however often released", () => {
		expect(KEEP_AWAKE_STATE).toBe(HELD);
		expect(ES_CONTINUOUS).toBe(LET_GO);

		const fake = fakeIo();
		const release = keepDisplayAwake(fake.io);
		expect(fake.calls).toEqual([HELD]);
		expect(fake.out).toEqual(["keeping the display on until the run ends (keep-awake)"]);
		expect(fake.interruption.report().left).toEqual(["the request to keep the display on"]);

		release();
		release();
		expect(fake.calls).toEqual([HELD, LET_GO]);
		expect(fake.interruption.report().left).toEqual([]);
	});

	test("anywhere but Windows it asks nothing, and says so in one line", () => {
		const fake = fakeIo({ platform: "linux" });
		keepDisplayAwake(fake.io)();
		expect(fake.calls).toEqual([]);
		expect(fake.out).toEqual(["keep-awake does nothing on linux: only Windows is asked to keep the display on"]);
	});

	test("a refusal, or a function that cannot be reached, is one warning, and the run goes on without it", () => {
		const refused = fakeIo({ answer: () => 0 });
		keepDisplayAwake(refused.io)();
		expect(refused.calls).toEqual([HELD]);
		expect(refused.err).toEqual([
			"warning: Windows refused to keep the display on (SetThreadExecutionState returned 0); the run goes on without it",
		]);
		expect(refused.interruption.report().left).toEqual([]);

		const missing = fakeIo({
			answer: () => {
				throw new Error("Failed to open library");
			},
		});
		keepDisplayAwake(missing.io)();
		expect(missing.err).toEqual([
			"warning: could not ask Windows to keep the display on (Failed to open library); the run goes on without it",
		]);
	});

	test("an interrupted run says it let go; a second Ctrl+C does not name it as left, since the process's exit lets go of it", () => {
		const fake = fakeIo();
		const release = keepDisplayAwake(fake.io);
		fake.interruption.interrupt("SIGINT");
		expect(fake.interruption.abandoned("SIGINT")).toBe("Ctrl+C again: exiting without finishing the cleanup");
		release();
		expect(fake.interruption.summary()).toBe("interrupted by Ctrl+C: cleaned up: let the display sleep again");
	});
});

describe("--keep-awake", () => {
	test("off by default: a run asks nothing of Windows", async () => {
		const run = await testRun([]);
		expect(run.code).toBe(0);
		expect(run.executionStates).toEqual([]);
		expect(run.out).not.toContain("keep-awake");
	});

	test("test holds it from before Studio opens until its window has closed, then lets go", async () => {
		const seen: string[] = [];
		const place = studio();
		const states: number[] = [];
		const run = await runCli(["test", "place.rbxl", "--keep-awake"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: (command) => {
				seen.push(`launch, ${states.length} asked`);
				place.onLaunch(command);
			},
			onClose: (target) => seen.push(`close ${"pid" in target ? "own" : "stale"}, ${states.length} asked`),
			setExecutionState: (state) => {
				states.push(state);
				return LET_GO;
			},
		});

		expect(run.code).toBe(0);
		expect(run.executionStates).toEqual([HELD, LET_GO]);
		// Asked for before the window opened, and still held when it closed.
		expect(seen).toEqual(["close stale, 1 asked", "launch, 1 asked", "close own, 1 asked"]);
		expect(run.out.split("\n")[0]).toBe("keeping the display on until the run ends (keep-awake)");
	});

	test("a failing run and a run that refuses part way let go too", async () => {
		const failing = await testRun(
			["--keep-awake"],
			{},
			{
				Server: JSON.stringify(resultJson({ ok: false, failed: 1 })),
				Client: RESULTS.Client,
			},
		);
		expect(failing.code).toBe(1);
		expect(failing.executionStates).toEqual([HELD, LET_GO]);
		expect(failing.executionState).toBe(LET_GO);

		// No Studio installed: refused after the request was made, which is let go all the same.
		const refused = await testRun(["--keep-awake"], { studioExe: undefined });
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("RobloxStudioBeta.exe was not found");
		expect(refused.executionStates).toEqual([HELD, LET_GO]);
	});

	test("Ctrl+C lets go, and the run's last line says so", async () => {
		const ctrlC = fakeCtrlC();
		const run = await testRun(
			["--keep-awake"],
			{ ctrlC },
			{
				Server: () => {
					ctrlC.press();
					return never();
				},
				Client: RESULTS.Client,
			},
		);

		expect(run.code).toBe(130);
		expect(run.executionStates).toEqual([HELD, LET_GO]);
		expect(run.executionState).toBe(LET_GO);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the Studio window it opened (PID 4001, place.rbxl); closed the MCP proxy (StudioMCP.exe); let the display sleep again",
		);
	});

	test("a second Ctrl+C exits at once and does not name the request as left: Windows lets go of it with the process", async () => {
		const ctrlC = fakeCtrlC();
		const run = await testRun(
			["--keep-awake"],
			{ ctrlC },
			{
				Server: () => {
					ctrlC.press();
					ctrlC.press();
					return never();
				},
			},
		);

		expect(run.exitedAtOnce).toBe(true);
		// Still held when the process exits, which is what lets go of it.
		expect(run.executionStates).toEqual([HELD]);
		expect(run.err).toContain(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the Studio window it opened (PID 4001, place.rbxl); the play session it started",
		);
		expect(run.err).not.toContain("display");
	});

	test("KEEP_AWAKE and testing.keepAwake turn it on; the flag wins over both, the variable over the config", async () => {
		const on = (run: { executionStates: number[] }) => run.executionStates.length > 0;

		expect(on(await testRun([], { env: { KEEP_AWAKE: "1" } }))).toBe(true);
		expect(on(await testRun([], { settings: { keepAwake: true } }))).toBe(true);
		// From .env or .env.local, which the settings carry.
		expect(on(await testRun([], { env: {}, settings: { env: { KEEP_AWAKE: "yes" } } }))).toBe(true);
		expect(on(await testRun([], { env: { KEEP_AWAKE: "false" }, settings: { keepAwake: true } }))).toBe(false);
		expect(on(await testRun(["--keep-awake=false"], { env: { KEEP_AWAKE: "on" } }))).toBe(false);
		expect(on(await testRun(["--keep-awake"], { env: { KEEP_AWAKE: "0" } }))).toBe(true);
		expect(on(await testRun([], { env: { KEEP_AWAKE: "" }, settings: { keepAwake: true } }))).toBe(false);

		const misspelt = await testRun([], { env: { KEEP_AWAKE: "always" } });
		expect(misspelt.code).toBe(2);
		expect(misspelt.err).toContain('KEEP_AWAKE must be true or false (or 1 or 0), got "always"');
		expect(misspelt.launched).toHaveLength(0);
	});

	test("under several projects it is held once, across all of them", async () => {
		const project = JSON.stringify({ tree: { $className: "DataModel" } });
		const place = studio();
		const run = await runCli(
			["test", "place.rbxl", "--project", "tests/a.project.json,tests/b.project.json", "--keep-awake"],
			{
				files: {
					"place.rbxl": "built",
					"tests/a.project.json": project,
					"tests/b.project.json": project,
					"place.a.rbxl": "made",
					"place.b.rbxl": "made",
				},
				studio: place.fake,
				onLaunch: place.onLaunch,
			},
		);

		expect(run.code).toBe(0);
		expect(run.launched).toHaveLength(2);
		expect(run.executionStates).toEqual([HELD, LET_GO]);
	});

	test("studio run holds it while the realms run, and lets go", async () => {
		const states: number[] = [];
		let during: number[] = [];
		const run = await runCli(["studio", "run", "--keep-awake"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					get_studio_state: PLAYING,
					execute_luau: () => {
						during = [...states];
						return RESULTS.Server;
					},
				},
			},
			setExecutionState: (state) => {
				states.push(state);
				return LET_GO;
			},
		});
		expect(run.code).toBe(0);
		expect(during).toEqual([HELD]);
		expect(run.executionStates).toEqual([HELD, LET_GO]);
	});

	test("on another system the flag is accepted, asks nothing, and says so once", async () => {
		const run = await testRun(["--keep-awake"], { platform: "darwin" });
		expect(run.code).toBe(0);
		expect(run.executionStates).toEqual([]);
		expect(run.out.match(/keep-awake does nothing on darwin/g)).toHaveLength(1);
	});

	test("not for the cloud: refused with --cloud, left alone by KEEP_AWAKE there, and no cloud command has it", async () => {
		const refused = await runCli(["test", "place.rbxl", "--cloud", "--keep-awake"], {
			files: { "place.rbxl": "built" },
		});
		expect(refused.code).toBe(2);
		expect(refused.err).toContain(
			"--keep-awake is for Studio runs: a cloud run has no display on this machine to keep on",
		);
		expect(refused.calls).toHaveLength(0);

		const cloud = await runCli(["test", "place.rbxl", "--cloud"], {
			responses: [json({ versionNumber: 9 }), ...happyPath([resultJson()])],
			files: { "place.rbxl": "built" },
			env: { ...ENV, KEEP_AWAKE: "true" },
		});
		expect(cloud.code).toBe(0);
		expect(cloud.executionStates).toEqual([]);

		for (const command of [
			["cloud", "run"],
			["cloud", "test", "place.rbxl"],
			["studio", "open"],
			["studio", "exec"],
		]) {
			expect(() => parseArgs([...command, "--keep-awake"])).toThrow(/--keep-awake is not a flag of/);
		}
	});
});
