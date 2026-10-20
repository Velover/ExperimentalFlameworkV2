import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";

import { CONNECT_POLL_MS } from "../src/cli.ts";
import type { StudioEntry } from "../src/studio.ts";
import {
	isStudioLog,
	processOf,
	signInFromLog,
	signInReader,
	studioLogDir,
	type LogFiles,
	type SignIn,
} from "../src/studioLog.ts";
import { OTHER_STUDIO, fakeMachine, resultJson, runCli } from "./harness.ts";

// Lines as Studio 0.743 writes them (2026-10-20), shortened; nothing else of a log is read.
const PROCESS = (pid: number) =>
	`2026-10-20T15:50:03.120Z,1.120739,70c4,6,Info [FLog::UIThreadNotifier] Constructing UIThreadNotifier for process '${pid}' with id 'https://www.roblox.com-Studio'`;
const STARTED = "2026-10-20T15:50:05.158Z,3.158177,3098,6,Info [FLog::StudioKeyEvents] login (automatic) [start]";
const SUCCESS = "2026-10-20T15:50:05.864Z,3.864714,72c0,6,Info [FLog::StudioKeyEvents] login [end][success]";
const FAILURE = "2026-10-20T14:10:11.624Z,4.624621,3098,6,Error [FLog::StudioKeyEvents] login [end][failure]";
const DIALOG = "2026-10-20T14:11:00.122Z,2.122130,4bf4,6,Info [FLog::StudioKeyEvents] show login dialog [start]";
const NOISE = "2026-10-20T15:50:02.536Z,0.536715,70c4,6 [FLog::Output] BaseUrl: https://www.roblox.com";

const log = (...lines: string[]) => lines.join("\n");

describe("a Studio process's sign-in, from its log", () => {
	test("the process a log is of, and what it says of the sign-in: the last word of it", () => {
		expect(processOf(log(NOISE, PROCESS(2200), STARTED))).toBe(2200);
		expect(processOf(log(NOISE))).toBeUndefined();

		expect(signInFromLog(log(NOISE, PROCESS(1)))).toBeUndefined();
		expect(signInFromLog(log(PROCESS(1), STARTED))).toBe("signing-in");
		expect(signInFromLog(log(PROCESS(1), STARTED, SUCCESS))).toBe("signed-in");
		// A refresh that failed (one of two Studios signing in at once), and a session already gone.
		expect(signInFromLog(log(PROCESS(1), STARTED, FAILURE))).toBe("signed-out");
		expect(signInFromLog(log(PROCESS(1), STARTED, DIALOG))).toBe("signed-out");
	});

	test("the log folder, and which files in it are a Studio process's log", () => {
		expect(studioLogDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
			join("C:\\Users\\me\\AppData\\Local", "Roblox", "logs"),
		);
		expect(isStudioLog("0.743.0.7431133_20261020T155001Z_Studio_460F5_last.log")).toBe(true);
		expect(isStudioLog("RobloxStudioInstaller_48FCD.log")).toBe(false);
		expect(isStudioLog("0.743.0.7431133_20261020T155001Z_Player_460F5_last.log")).toBe(false);
	});

	test("finds the launched process's log among those written since its launch, once, and reads it again on each look", async () => {
		const dir = studioLogDir({ LOCALAPPDATA: "L:" });
		const files: Record<string, { modifiedMs: number; text: string }> = {
			// Older than the launch: never read, whatever it says.
			"a_Studio_00001_last.log": { modifiedMs: 1_000, text: log(PROCESS(4001), STARTED, DIALOG) },
			// Another process's, written since.
			"b_Studio_00002_last.log": { modifiedMs: 100_000, text: log(PROCESS(777), STARTED, FAILURE) },
			// Not saying whose yet.
			"c_Studio_00003_last.log": { modifiedMs: 100_000, text: log(NOISE) },
		};
		const reads: string[] = [];
		let lists = 0;
		const fake: LogFiles = {
			list: async () => {
				lists += 1;
				return Object.entries(files).map(([name, file]) => ({ name, modifiedMs: file.modifiedMs }));
			},
			head: async (path) => {
				reads.push(basename(path));
				return files[basename(path)]!.text;
			},
		};
		const read = signInReader({ LOCALAPPDATA: "L:" }, fake);

		expect(await read(4001, 99_000)).toBeUndefined();
		expect(reads.filter((name) => name.startsWith("a_"))).toEqual([]);

		// The third log turns out to be the launched one's.
		files["c_Studio_00003_last.log"]!.text = log(NOISE, PROCESS(4001), STARTED);
		expect(await read(4001, 99_000)).toEqual({
			state: "signing-in",
			log: join(dir, "c_Studio_00003_last.log"),
		});
		files["c_Studio_00003_last.log"]!.text += `\n${SUCCESS}`;
		reads.length = 0;
		const listed = lists;
		expect((await read(4001, 99_000))?.state).toBe("signed-in");
		// Known from here: the folder is not listed again, and no other log is read.
		expect(lists).toBe(listed);
		expect(reads).toEqual(["c_Studio_00003_last.log"]);

		// The other process's log was read once, for whose it is.
		expect((await read(777, 99_000))?.state).toBe("signed-out");
	});

	test("nothing is known when the folder cannot be read", async () => {
		const read = signInReader(
			{ LOCALAPPDATA: "L:" },
			{
				list: async () => {
					throw new Error("ENOENT");
				},
				head: async () => "",
			},
		);
		expect(await read(1, 0)).toBeUndefined();
	});
});

const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";

/**
 * A Studio whose windows sign in as `states` says, one state per look at the log (the last one
 * staying), and register with the proxy only once signed in, as a real one does.
 */
function signingStudio(states: Array<SignIn | undefined>) {
	let mode = "Edit";
	const listed: StudioEntry[] = [OTHER_STUDIO];
	const pending: StudioEntry[] = [];
	let looks = 0;
	let state: SignIn | undefined;
	return {
		fake: {
			studios: () => {
				if (state === "signed-in") listed.push(...pending.splice(0));
				return listed;
			},
			answers: {
				get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
				start_stop_play: (args: Record<string, unknown>) => {
					mode = args.is_start ? "Play" : "Edit";
					return args.is_start ? "Game Started" : "Game Stopped";
				},
				execute_luau: (args: Record<string, unknown>) =>
					args.datamodel_type === "Server"
						? JSON.stringify(resultJson())
						: JSON.stringify(resultJson({ realm: "client" })),
			},
		},
		onLaunch: (command: string[]) => {
			const name = basename(command[1]!);
			pending.push({ id: `studio-${name}`, name });
		},
		signIn: () => {
			state = states[Math.min(looks, states.length - 1)];
			looks += 1;
			return state === undefined ? undefined : { state, log: "L:\\Roblox\\logs\\x_Studio_1_last.log" };
		},
		looks: () => looks,
	};
}

describe("a launched Studio that is not signed in", () => {
	test("hidden: the run says so at the first look that shows it, closes the window, and does not wait out the connect timeout", async () => {
		const machine = fakeMachine();
		const start = machine.time.now;
		const studio = signingStudio(["signing-in", "signed-out"]);
		const run = await runCli(["test", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
			signIn: studio.signIn,
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			"Studio started (PID 4001) but is not signed in to Roblox, so place.rbxl never opened: it showed its login dialog on the hidden desktop, where nobody can answer it (Studio's log: L:\\Roblox\\logs\\x_Studio_1_last.log)",
		);
		expect(run.err).toContain("ask the user to open Roblox Studio and sign in");
		expect(run.err).toContain("the window this run opened is closed again");
		expect(run.err).not.toContain("never showed up on the MCP proxy");
		expect(run.closeTargets).toContain("pid 4001 place.rbxl");
		expect(machine.windows).toEqual([]);
		expect(machine.lock.owner).toBeUndefined();
		// Two looks, one poll apart: not the 180 s connect timeout.
		expect(machine.time.now - start).toBe(CONNECT_POLL_MS);
	});

	test("hidden with --keep: the window is left, and the run says it holds the lock", async () => {
		const studio = signingStudio(["signed-out"]);
		const run = await runCli(["test", "place.rbxl", "--keep"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
			signIn: studio.signIn,
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("is not signed in to Roblox");
		expect(run.err).toContain("the window is open, and holds the Studio lock until it closes");
		expect(run.windows).toHaveLength(1);
	});

	test("shown (--show, studio open): said once, and waited for, since someone can sign in there", async () => {
		const states: Array<SignIn | undefined> = [undefined, "signed-out", "signed-out", "signed-in"];
		const studio = signingStudio(states);
		const run = await runCli(["test", "place.rbxl", "--show"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
			signIn: studio.signIn,
		});
		expect(run.code).toBe(0);
		const said =
			"Studio (PID 4001) is showing its login dialog: it is not signed in to Roblox, and opens place.rbxl once someone signs in there";
		expect(run.out.split(said)).toHaveLength(2);
		expect(run.out).toContain("connected: place.rbxl (studio-place.rbxl)");

		const opened = signingStudio(states);
		const open = await runCli(["studio", "open", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: opened.fake,
			onLaunch: opened.onLaunch,
			signIn: opened.signIn,
		});
		expect(open.code).toBe(0);
		expect(open.all.split(said)).toHaveLength(2);
	});

	test("a log that says nothing changes nothing: the window is waited for as before", async () => {
		const studio = signingStudio([undefined]);
		const run = await runCli(["test", "place.rbxl", "--connect-timeout", "20"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
			signIn: studio.signIn,
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("never showed up on the MCP proxy within 20s (--connect-timeout)");
		expect(studio.looks()).toBeGreaterThan(1);
	});
});
