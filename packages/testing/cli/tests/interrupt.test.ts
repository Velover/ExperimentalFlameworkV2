import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PLAY_STOP_ANSWER_MS, PLAY_STOP_RETRY_MS, PLAY_STOP_TIMEOUT_MS } from "../src/cli.ts";
import { Interrupted, interruptedExitCode, Interruption } from "../src/interrupt.ts";
import type { StudioEntry } from "../src/studio.ts";
import {
	fakeCtrlC,
	FIXTURE_CWD,
	json,
	never,
	OTHER_STUDIO,
	PLACE,
	resultJson,
	runCli,
	TASK_PATH,
	TESTING_STUDIO,
	type FakeStudio,
	type FakeWindow,
} from "./harness.ts";

const BUILT_STUDIO: StudioEntry = { id: "studio-4", name: "place.rbxl" };
/** The built place as the CLI resolves it, which a window left from an earlier build is titled with. */
const FIXTURE_PLACE = join(FIXTURE_CWD, "place.rbxl");
const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";
const PROJECT = JSON.stringify({
	tree: { $className: "DataModel", ServerScriptService: { TS: { $path: "out/server" } } },
});

type Answer = string | Promise<string> | (() => string | Promise<string>);

/**
 * A Studio that lists the window the CLI launches and plays when told to. `answers` override the
 * tools' answers (a function is asked each time, so it can press Ctrl+C), and `onListing` runs on
 * every listing once the window has been launched, before it is listed.
 *
 * `slowStart` is Studio's own start, which takes about five seconds: `onStart` runs when the start
 * is asked for (a Ctrl+C, say), and until the start has finished every stop is refused as Studio
 * refuses it, "Start play hasn't finished yet". It finishes once `refusals` stops have been
 * refused (Infinity: never). With `hangAfter`, Studio stops answering once that many stops have
 * been refused: every stop after that waits out its timeout and fails, as the proxy fails it.
 */
function studio(options: {
	execute?: Record<string, Answer>;
	stop?: () => string | Promise<string>;
	onListing?: (listing: number) => boolean;
	playing?: boolean;
	window?: StudioEntry;
	slowStart?: { onStart: () => void; refusals: number; hangAfter?: number };
}) {
	const window = options.window ?? BUILT_STUDIO;
	let mode = options.playing ? "Play" : "Edit";
	let launched = false;
	let listings = 0;
	let starting: { refused: number; finish: () => void } | undefined;
	const listed: StudioEntry[] = [OTHER_STUDIO];
	const fake: FakeStudio = {
		studios: () => {
			if (!launched) return listed;
			listings += 1;
			// Not listed yet while the hook says so: the window is still loading.
			if (options.onListing?.(listings) === false) return listed;
			return listed.includes(window) ? listed : [...listed, window];
		},
		answers: {
			get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
			start_stop_play: (args, call) => {
				if (args.is_start && options.slowStart) {
					const started = new Promise<string>((resolve) => {
						starting = {
							refused: 0,
							finish: () => {
								starting = undefined;
								mode = "Play";
								resolve("Game Started");
							},
						};
					});
					options.slowStart.onStart();
					return started;
				}
				if (!args.is_start && starting) {
					if (starting.refused >= (options.slowStart!.hangAfter ?? Infinity)) {
						call.elapse(call.timeoutMs ?? 60_000);
						throw new Error(`tools/call timed out after ${call.timeoutMs ?? 60_000}ms`);
					}
					starting.refused += 1;
					if (starting.refused >= options.slowStart!.refusals) starting.finish();
					throw new Error("start_stop_play: Start play hasn't finished yet");
				}
				if (!args.is_start && options.stop) return options.stop();
				mode = args.is_start ? "Play" : "Edit";
				return args.is_start ? "Game Started" : "Game Stopped";
			},
			execute_luau: (args) => {
				const answer = options.execute?.[args.datamodel_type as string];
				if (answer === undefined) throw new Error(`no result for ${String(args.datamodel_type)}`);
				return typeof answer === "function" ? answer() : answer;
			},
		},
	};
	return {
		fake,
		onLaunch: () => {
			launched = true;
		},
		get mode() {
			return mode;
		},
	};
}

const RESULTS = {
	Server: JSON.stringify(resultJson()),
	Client: JSON.stringify(resultJson({ realm: "client" })),
};

describe("the interruption", () => {
	test("pending waits reject at once, nothing new starts, and a late result is handed back to be let go", async () => {
		const interruption = new Interruption();
		let resolveLate: (value: string) => void = () => {};
		const pending = interruption.run(() => new Promise<string>((resolve) => (resolveLate = resolve)));
		const disposed: string[] = [];
		const claimed = interruption.run(
			() => new Promise<string>((resolve) => setTimeout(() => resolve("claim"), 5)),
			(late) => disposed.push(late),
		);

		expect(interruption.interrupt("SIGINT")).toBe(true);
		expect(interruption.interrupt("SIGINT")).toBe(false);
		await expect(pending).rejects.toBeInstanceOf(Interrupted);
		await expect(claimed).rejects.toBeInstanceOf(Interrupted);
		resolveLate("too late");

		let started = false;
		await expect(
			interruption.run(async () => {
				started = true;
				return 1;
			}),
		).rejects.toBeInstanceOf(Interrupted);
		expect(started).toBe(false);
		expect(() => interruption.check()).toThrow(Interrupted);

		// What a run waits for in its cleanup is never refused.
		expect(await interruption.cleanup(() => interruption.run(async () => "stopped"))).toBe("stopped");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(disposed).toEqual(["claim"]);
	});

	test("the ledger says what was cleaned up once interrupted and what is left, and a signal names its exit code", () => {
		const interruption = new Interruption();
		const before = interruption.hold("the temp folder", "removed the temp folder");
		before();
		const window = interruption.hold("the Studio window", "closed the Studio window");
		interruption.hold("the Open Cloud task");
		interruption.interrupt("SIGINT");
		window();
		window();

		expect(interruption.report()).toEqual({ cleaned: ["closed the Studio window"], left: ["the Open Cloud task"] });
		expect(interruption.summary()).toBe(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window; left: the Open Cloud task",
		);
		expect(interruption.abandoned("SIGINT")).toBe(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the Open Cloud task",
		);
		expect(new Interruption().summary()).toBe("interrupted by Ctrl+C: nothing needed cleaning up");

		// What is held within another hold ends with it: a play session with its window.
		const ending = new Interruption();
		const closed = ending.hold("the Studio window", "closed the Studio window");
		ending.hold("the play session", "stopped the play session", { within: closed });
		ending.hold("the MCP proxy", "closed the MCP proxy", { endsWithProcess: true });
		expect(ending.abandoned("SIGINT")).toBe(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the Studio window; the play session",
		);
		ending.interrupt("SIGINT");
		closed();
		expect(ending.report()).toEqual({
			cleaned: ["closed the Studio window", "the play session ended with it"],
			left: ["the MCP proxy"],
		});
		// Let go before any Ctrl+C, they go without a word.
		const quiet = new Interruption();
		const gone = quiet.hold("the Studio window", "closed the Studio window");
		quiet.hold("the play session", "stopped the play session", { within: gone });
		gone();
		quiet.interrupt("SIGINT");
		expect(quiet.report()).toEqual({ cleaned: [], left: [] });
		expect([
			interruptedExitCode("SIGINT"),
			interruptedExitCode("SIGBREAK"),
			interruptedExitCode("SIGTERM"),
		]).toEqual([130, 149, 143]);
	});
});

describe("Ctrl+C during test", () => {
	test("before Studio starts: the patch's lune is stopped and its temp folder removed, and Studio is never opened", async () => {
		const ctrlC = fakeCtrlC();
		const run = await runCli(["test", "place.rbxl", "--project", "default.project.json"], {
			files: { "place.rbxl": "built", "default.project.json": PROJECT },
			ctrlC,
			spawnCode: (command) => {
				if (command[1] !== "run") return 0;
				ctrlC.press();
				return never();
			},
		});

		expect(run.code).toBe(130);
		expect(run.exitedAtOnce).toBe(false);
		expect(run.madeDirs).toHaveLength(1);
		expect(run.removedDirs).toEqual(run.madeDirs);
		expect(run.launched).toHaveLength(0);
		expect(run.proxies.connected).toBe(0);
		expect(run.err).toContain(
			"Ctrl+C: stopping, and cleaning up what this run started (Ctrl+C again exits at once)",
		);
		expect(run.err).toContain("interrupted by Ctrl+C: cleaned up: stopped lune; removed the patch's temp folder");
		expect(run.err).not.toContain("left:");
		expect(run.err).not.toContain("the patch failed");
		expect(ctrlC.listening).toBe(false);
	});

	test("while Studio loads: the window it opened is closed by its PID, the claim released and the proxy closed", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			onListing: (listing) => {
				if (listing === 2) ctrlC.press();
				return false;
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(run.launched).toHaveLength(1);
		expect(run.closeTargets).toEqual(["file place.rbxl", "pid 4001 place.rbxl"]);
		expect(run.windows).toHaveLength(0);
		expect(run.claims).toEqual([
			"claim place.rbxl (launched 0, closed 0)",
			"release place.rbxl (launched 1, closed 1)",
		]);
		expect(run.proxies).toEqual({ connected: 1, open: 0 });
		expect(run.studioCalls.map((call) => call.name)).toEqual([]);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window it opened (PID 4001, place.rbxl); released the claim on the window name place.rbxl; closed the MCP proxy (StudioMCP.exe)",
		);
		// Not a window that never connected: no word of the MCP server setting.
		expect(run.err).not.toContain("never showed up");
	});

	test("during play: the session is stopped, the window closed, and the other realm never runs", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					return never();
				},
				Client: RESULTS.Client,
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(run.studioCalls.map((call) => [call.name, call.args.is_start ?? call.args.datamodel_type])).toEqual([
			["get_studio_state", undefined],
			["start_stop_play", true],
			["get_studio_state", undefined],
			["execute_luau", "Server"],
			["start_stop_play", false],
		]);
		expect(place.mode).toBe("Edit");
		expect(run.windows).toHaveLength(0);
		expect(run.closeTargets).toEqual(["file place.rbxl", "pid 4001 place.rbxl"]);
		expect(run.proxies.open).toBe(0);
		expect(run.out).toContain("play session stopped");
		expect(run.err).not.toContain("the server's run failed");
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the Studio window it opened (PID 4001, place.rbxl); closed the MCP proxy (StudioMCP.exe)",
		);
	});

	test("during play with --keep: the window and the session are left, and named", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					return never();
				},
			},
		});
		const run = await runCli(["test", "place.rbxl", "--keep"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(run.studioCalls.filter((call) => call.name === "start_stop_play")).toHaveLength(1);
		expect(run.windows.map((window) => window.pid)).toEqual([4001]);
		expect(run.closeTargets).toEqual(["file place.rbxl"]);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the MCP proxy (StudioMCP.exe); left: the Studio window it opened (PID 4001, place.rbxl), which --keep leaves open; the play session it started, which --keep leaves running",
		);
	});

	test("during the cleanup a finished run does anyway: it is seen through, then the run exits 130", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			execute: RESULTS,
			stop: () => {
				ctrlC.press();
				return "Game Stopped";
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		// The results came in and were printed, and the cleanup ran to the end.
		expect(run.out).toContain("2 passed, 0 failed, 0 skipped in 12ms (server)");
		expect(run.out).toContain("2 passed, 0 failed, 0 skipped in 12ms (client)");
		expect(run.windows).toHaveLength(0);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the Studio window it opened (PID 4001, place.rbxl); closed the MCP proxy (StudioMCP.exe)",
		);

		// A Ctrl+C while the window is being closed does not cut the close short either.
		const closing = fakeCtrlC();
		const again = studio({ execute: RESULTS });
		const closed = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: again.fake,
			onLaunch: again.onLaunch,
			ctrlC: closing,
			onClose: (target) => {
				if ("pid" in target) closing.press();
			},
		});
		expect(closed.code).toBe(130);
		expect(closed.windows).toHaveLength(0);
		expect(closed.err).toContain("cleaned up: closed the Studio window it opened (PID 4001, place.rbxl)");
	});

	test("a second Ctrl+C during the cleanup exits at once, naming what may be left", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					return never();
				},
			},
			// Studio takes its time to stop the session, and the second Ctrl+C comes meanwhile.
			stop: () => {
				ctrlC.press();
				return never();
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(run.exitedAtOnce).toBe(true);
		expect(run.windows.map((window) => window.pid)).toEqual([4001]);
		expect(run.err).toContain(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the Studio window it opened (PID 4001, place.rbxl); the play session it started",
		);
	});

	test("a second Ctrl+C exits at once, however soon it comes after the first", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					ctrlC.press();
					return never();
				},
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(run.exitedAtOnce).toBe(true);
		expect(run.err.match(/stopping, and cleaning up/g)).toHaveLength(1);
		expect(run.err).toContain(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the Studio window it opened (PID 4001, place.rbxl); the play session it started",
		);
	});

	test("during the play start: the stop waits for Studio to finish starting, with no error, then the window is closed", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({ slowStart: { onStart: () => ctrlC.press(), refusals: 3 } });
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		expect(
			run.studioCalls.filter((call) => call.name === "start_stop_play").map((call) => call.args.is_start),
		).toEqual([true, false, false, false, false]);
		expect(place.mode).toBe("Edit");
		expect(run.windows).toHaveLength(0);
		expect(run.out).toContain("the play session is still starting; it is stopped once it has");
		expect(run.out).toContain("play session stopped");
		expect(run.err).not.toContain("error:");
		expect(run.err).not.toContain("hasn't finished");
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the Studio window it opened (PID 4001, place.rbxl); closed the MCP proxy (StudioMCP.exe)",
		);
		expect(run.err).not.toContain("left:");
	});

	test("during a play start that never finishes: the stop gives up, and the session ends with the window closed", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({ slowStart: { onStart: () => ctrlC.press(), refusals: Infinity } });
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(130);
		// The start, then the stop for PLAY_STOP_RETRY_MS, half a second apart.
		expect(run.studioCalls.filter((call) => call.name === "start_stop_play")).toHaveLength(1 + 61);
		expect(run.err.match(/^error: /gm)).toHaveLength(1);
		expect(run.err).toContain("error: start_stop_play: Start play hasn't finished yet");
		expect(run.windows).toHaveLength(0);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window it opened (PID 4001, place.rbxl); the play session it started ended with it; closed the MCP proxy (StudioMCP.exe)",
		);
		expect(run.err).not.toContain("left:");
	});

	test("a Studio that stops answering during the stop's retry holds the cleanup no longer than the retry", async () => {
		const stops = (run: Awaited<ReturnType<typeof runCli>>) =>
			run.studioCalls
				.map((call, index) => ({ call, timeoutMs: run.studioCallTimeouts[index] }))
				.filter(({ call }) => call.name === "start_stop_play" && call.args.is_start === false)
				.map(({ timeoutMs }) => timeoutMs);

		// Refused three times, half a second apart; the fourth stop gets what is left of the retry.
		const early = fakeCtrlC();
		const hangs = studio({ slowStart: { onStart: () => early.press(), refusals: Infinity, hangAfter: 3 } });
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: hangs.fake,
			onLaunch: hangs.onLaunch,
			ctrlC: early,
		});
		expect(run.code).toBe(130);
		expect(stops(run)).toEqual([
			PLAY_STOP_TIMEOUT_MS,
			PLAY_STOP_RETRY_MS - 500,
			PLAY_STOP_RETRY_MS - 1000,
			PLAY_STOP_RETRY_MS - 1500,
		]);
		expect(run.err).toContain(`error: tools/call timed out after ${PLAY_STOP_RETRY_MS - 1500}ms`);
		expect(run.windows).toHaveLength(0);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window it opened (PID 4001, place.rbxl); the play session it started ended with it; closed the MCP proxy (StudioMCP.exe)",
		);

		// Near the end of the retry, a stop still gets the few seconds an accepted one takes to answer.
		const late = fakeCtrlC();
		const hangsLate = studio({ slowStart: { onStart: () => late.press(), refusals: Infinity, hangAfter: 59 } });
		const lateRun = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: hangsLate.fake,
			onLaunch: hangsLate.onLaunch,
			ctrlC: late,
		});
		expect(lateRun.code).toBe(130);
		const lateStops = stops(lateRun);
		expect(lateStops).toHaveLength(60);
		expect(lateStops.at(-1)).toBe(PLAY_STOP_ANSWER_MS);
		expect(lateRun.err).toContain(`error: tools/call timed out after ${PLAY_STOP_ANSWER_MS}ms`);
		expect(lateRun.windows).toHaveLength(0);
	});

	test("a window that had already closed when the cleanup reached it is named so, not as closed by the run", async () => {
		const ctrlC = fakeCtrlC();
		const windows: FakeWindow[] = [];
		const place = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					return never();
				},
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
			windows,
			// Closed by hand, or crashed, before the run came to close it.
			onClose: (target) => {
				if ("pid" in target) windows.splice(0, windows.length);
			},
		});

		expect(run.code).toBe(130);
		expect(run.closeTargets).toEqual(["file place.rbxl", "pid 4001 place.rbxl"]);
		expect(run.closedWindows).toEqual([]);
		expect(run.out).toContain(
			"place.rbxl had already closed: the Studio this run started (PID 4001) no longer has it open",
		);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; the Studio window it opened (PID 4001, place.rbxl) had already closed; closed the MCP proxy (StudioMCP.exe)",
		);
		expect(run.err).not.toContain("closed the Studio window it opened");
	});

	test("a second Ctrl+C names what it cuts short, and nothing that ends with the process", async () => {
		// lune ends with the CLI; the patch's temp folder does not.
		const duringLune = fakeCtrlC();
		const patched = await runCli(["test", "place.rbxl", "--project", "default.project.json"], {
			files: { "place.rbxl": "built", "default.project.json": PROJECT },
			ctrlC: duringLune,
			spawnCode: (command) => {
				if (command[1] !== "run") return 0;
				duringLune.press();
				duringLune.press();
				return never();
			},
		});
		expect(patched.exitedAtOnce).toBe(true);
		expect(patched.err).toMatch(/may be left: the patch's temp folder \S+flamework-test-fake1$/m);
		expect(patched.err).not.toMatch(/may be left:.*lune/);

		// The close of a window left from an earlier build asks first, and can leave a save prompt.
		const duringStale = fakeCtrlC();
		const stale = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			windows: [{ pid: 3001, title: `${FIXTURE_PLACE} - Roblox Studio` }],
			ctrlC: duringStale,
			onClose: () => {
				duringStale.press();
				duringStale.press();
			},
		});
		expect(stale.exitedAtOnce).toBe(true);
		expect(stale.err).toContain(
			"Ctrl+C again: exiting without finishing the cleanup; may be left: the window left from an earlier build of place.rbxl, if there is one: its close was cut short, and it may still be open, showing its save prompt",
		);
		expect(stale.err).not.toContain("MCP proxy");

		// While the window loads, the claim on its name is held: the next run takes it over.
		const duringLoad = fakeCtrlC();
		const loading = studio({
			onListing: () => {
				duringLoad.press();
				duringLoad.press();
				return false;
			},
		});
		const loaded = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: loading.fake,
			onLaunch: loading.onLaunch,
			ctrlC: duringLoad,
		});
		expect(loaded.exitedAtOnce).toBe(true);
		expect(loaded.err).toMatch(
			/may be left: the claim on the window name place\.rbxl \(a file in \S+flamework-test, which the next run takes over\); the Studio window it opened \(PID 4001, place\.rbxl\)$/m,
		);

		// Once its process has been ended, the window is gone: only Studio's lock beside the file may be left.
		const duringLock = fakeCtrlC();
		const locked = studio({ execute: RESULTS });
		const unlocked = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built", "place.rbxl.lock": "4001\nRobloxStudioBeta" },
			studio: locked.fake,
			onLaunch: locked.onLaunch,
			ctrlC: duringLock,
			removalsRefused: 1,
			onRemoveFile: () => {
				duringLock.press();
				duringLock.press();
			},
		});
		expect(unlocked.exitedAtOnce).toBe(true);
		expect(unlocked.err).toMatch(
			/may be left: Studio's lock file \S+place\.rbxl\.lock, which names a process that has ended$/m,
		);
		expect(unlocked.err).not.toContain("the Studio window it opened");
	});

	test("under several projects the next project never starts, and Ctrl+Break is told apart", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({
			window: { id: "studio-a", name: "place.a.rbxl" },
			execute: {
				Server: () => {
					ctrlC.press("SIGBREAK");
					return never();
				},
			},
		});
		const run = await runCli(["test", "place.rbxl", "--project", "a.project.json,b.project.json"], {
			files: { "place.rbxl": "built", "a.project.json": PROJECT, "b.project.json": PROJECT },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});

		expect(run.code).toBe(149);
		expect(run.launched).toHaveLength(1);
		expect(run.spawned.filter((command) => command[1] === "run")).toHaveLength(1);
		expect(run.out).not.toContain("=== b:");
		expect(run.out).not.toContain("projects:");
		expect(run.err).toContain("interrupted by Ctrl+Break: cleaned up: stopped the play session it started");
	});

	test("a Ctrl+C during a project's last window close lets it finish, and prints nothing of the next project", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({ window: { id: "studio-a", name: "place.a.rbxl" }, execute: RESULTS });
		const run = await runCli(["test", "place.rbxl", "--project", "a.project.json,b.project.json"], {
			files: { "place.rbxl": "built", "a.project.json": PROJECT, "b.project.json": PROJECT },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
			onClose: (target) => {
				if ("pid" in target) ctrlC.press();
			},
		});

		expect(run.code).toBe(130);
		expect(run.exitedAtOnce).toBe(false);
		expect(run.out).toContain("=== a: a.project.json ===");
		expect(run.out).toContain("closed place.a.rbxl (PID 4001)");
		expect(run.out).not.toContain("=== b:");
		expect(run.out).not.toContain("projects:");
		expect(run.launched).toHaveLength(1);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window it opened (PID 4001, place.a.rbxl); closed the MCP proxy (StudioMCP.exe)",
		);
	});

	test("a run that is not interrupted stops listening when it returns, and says nothing of Ctrl+C", async () => {
		const ctrlC = fakeCtrlC();
		const place = studio({ execute: RESULTS });
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
			ctrlC,
		});
		expect(run.code).toBe(0);
		expect(run.all).not.toContain("Ctrl+C");
		expect(ctrlC.listening).toBe(false);
		// A press after the run has returned reaches nothing.
		ctrlC.press();
	});
});

describe("Ctrl+C during the studio commands", () => {
	test("studio run stops the session it started, and leaves one it found running", async () => {
		const ctrlC = fakeCtrlC();
		const started = studio({
			execute: {
				Server: () => {
					ctrlC.press();
					return never();
				},
			},
		});
		started.onLaunch();
		const run = await runCli(["studio", "run", "--studio", "place.rbxl"], { studio: started.fake, ctrlC });
		expect(run.code).toBe(130);
		expect(started.mode).toBe("Edit");
		expect(run.proxies.open).toBe(0);
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the MCP proxy (StudioMCP.exe)",
		);

		const found = fakeCtrlC();
		const running = studio({
			playing: true,
			execute: {
				Server: () => {
					found.press();
					return never();
				},
			},
		});
		running.onLaunch();
		const left = await runCli(["studio", "run", "--studio", "place.rbxl"], { studio: running.fake, ctrlC: found });
		expect(left.code).toBe(130);
		expect(running.mode).toBe("Play");
		expect(left.studioCalls.filter((call) => call.name === "start_stop_play")).toHaveLength(0);
		expect(left.err).toContain("interrupted by Ctrl+C: cleaned up: closed the MCP proxy (StudioMCP.exe)");
		expect(left.err).not.toContain("left:");
	});

	test("studio run, interrupted during the play start, stops the session once Studio has started it", async () => {
		const ctrlC = fakeCtrlC();
		const slow = studio({ slowStart: { onStart: () => ctrlC.press(), refusals: 2 } });
		slow.onLaunch();
		const run = await runCli(["studio", "run", "--studio", "place.rbxl"], { studio: slow.fake, ctrlC });
		expect(run.code).toBe(130);
		expect(slow.mode).toBe("Edit");
		expect(run.err).not.toContain("error:");
		expect(run.err).toContain(
			"interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the MCP proxy (StudioMCP.exe)",
		);

		// A start that never finishes leaves the session, and says so.
		const stuck = fakeCtrlC();
		const stuckStudio = studio({ slowStart: { onStart: () => stuck.press(), refusals: Infinity } });
		stuckStudio.onLaunch();
		const left = await runCli(["studio", "run", "--studio", "place.rbxl"], {
			studio: stuckStudio.fake,
			ctrlC: stuck,
		});
		expect(left.code).toBe(130);
		expect(left.err).toContain("error: start_stop_play: Start play hasn't finished yet");
		expect(left.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the MCP proxy (StudioMCP.exe); left: the play session it started",
		);
	});

	test("studio exec stops waiting for its Luau, and says it runs on in Studio", async () => {
		const ctrlC = fakeCtrlC();
		const run = await runCli(["studio", "exec", "--code", "while true do task.wait() end"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					execute_luau: () => {
						ctrlC.press();
						return never();
					},
				},
			},
			ctrlC,
		});
		expect(run.code).toBe(130);
		expect(run.err).not.toContain("the Luau failed");
		expect(run.err).toContain(
			`interrupted by Ctrl+C: cleaned up: closed the MCP proxy (StudioMCP.exe); left: the Luau sent to ${TESTING_STUDIO.name} (Edit), which runs on there until it returns`,
		);
	});

	test("studio open stops waiting and leaves the window it was asked to open", async () => {
		const ctrlC = fakeCtrlC();
		const run = await runCli(["studio", "open"], {
			studio: {
				studios: () => {
					ctrlC.press();
					return [OTHER_STUDIO];
				},
			},
			ctrlC,
		});
		expect(run.code).toBe(130);
		expect(run.windows.map((window) => window.pid)).toEqual([4001]);
		expect(run.closeTargets).toHaveLength(0);
		expect(run.err).toContain(
			`left: the Studio window it opened (PID 4001, the testing place ${PLACE}), which studio open leaves open`,
		);
	});
});

describe("Ctrl+C during a cloud run", () => {
	test("a task already created runs on, and the run says where it is; nothing more is asked of Open Cloud", async () => {
		const ctrlC = fakeCtrlC();
		const run = await runCli(["cloud", "run", "--code", "return 1"], {
			responses: [json({ path: TASK_PATH, state: "QUEUED" })],
			ctrlC,
			onFetch: (url) => {
				if (!url.endsWith(TASK_PATH)) return undefined;
				ctrlC.press();
				return never();
			},
		});

		expect(run.code).toBe(130);
		expect(run.calls).toHaveLength(2);
		expect(run.err).toContain(
			`interrupted by Ctrl+C: nothing needed cleaning up; left: the Open Cloud task ${TASK_PATH}, which runs on until it finishes or its timeout (120s) ends it, since Open Cloud cannot cancel a task: read it with GET /cloud/v2/${TASK_PATH}`,
		);
	});

	test("an upload cut short may have made a version all the same, and no task is created after it", async () => {
		const ctrlC = fakeCtrlC();
		const run = await runCli(["cloud", "test", "place.rbxl", "--code", "return 1"], {
			files: { "place.rbxl": "built" },
			ctrlC,
			onFetch: () => {
				ctrlC.press();
				return never();
			},
		});

		expect(run.code).toBe(130);
		expect(run.calls).toHaveLength(1);
		expect(Object.keys(run.written).some((path) => path.endsWith("version.json"))).toBe(false);
		expect(run.err).toContain(
			`left: the upload to the testing place ${PLACE}, which may still have made a new version of it`,
		);
	});
});
