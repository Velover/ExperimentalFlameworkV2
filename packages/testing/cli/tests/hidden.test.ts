import { describe, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";

import { KEPT_HIDDEN, parseArgs } from "../src/cli.ts";
import type { LockOwner } from "../src/lock.ts";
import type { StudioEntry } from "../src/studio.ts";
import { ENV, FIXTURE_CWD, OTHER_STUDIO, fakeMachine, happyPath, json, resultJson, runCli } from "./harness.ts";

const THIS_FILE = join(resolve(FIXTURE_CWD), "place.rbxl");
const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";
const RESULTS: Record<string, string> = {
	Server: JSON.stringify(resultJson()),
	Client: JSON.stringify(resultJson({ realm: "client" })),
};

/**
 * A Studio that lists every file the CLI launches, by name (unless `listing` is off: "MCP server"
 * off, or a dialog holding the window up), and answers both realms; `during` sees each realm's run.
 */
function studio(options: { listing?: boolean; during?: () => void } = {}) {
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
					options.during?.();
					return RESULTS[args.datamodel_type as string]!;
				},
			},
		},
		onLaunch: (command: string[]) => {
			if (options.listing === false) return;
			const name = basename(command[1]!);
			listed.push({ id: `studio-${name}-${listed.length}`, name });
		},
	};
}

/** `test place.rbxl` with `argv`, against a Studio that answers both realms. */
async function testRun(
	argv: string[],
	options: Parameters<typeof runCli>[1] = {},
	place: ReturnType<typeof studio> = studio(),
) {
	return await runCli(["test", "place.rbxl", ...argv], {
		files: { "place.rbxl": "built" },
		studio: place.fake,
		onLaunch: place.onLaunch,
		...options,
	});
}

/** Whether the run launched its window hidden. */
const hidden = (run: { launchOptions: Array<{ hidden: boolean } | undefined> }) => run.launchOptions[0]?.hidden;

describe("a test's windows on the hidden desktop", () => {
	test("test opens its window there, lists it so in the lock while it runs, and closes it by its process", async () => {
		const machine = fakeMachine();
		let record: LockOwner | undefined;
		const run = await testRun(
			[],
			{ machine },
			studio({ during: () => (record ??= structuredClone(machine.lock.owner)) }),
		);
		expect(run.code).toBe(0);
		expect(run.launchOptions).toEqual([{ hidden: true }]);
		expect(run.out).toContain(
			"opening place.rbxl in Studio, on the hidden desktop (--show shows it); waiting for it to connect...",
		);
		expect(record!.windows).toMatchObject([{ placeFile: THIS_FILE, studioPid: 4001, hidden: true }]);
		// Before the launch, a window left from an earlier build of the file; after the run, its own.
		expect(run.closeTargets).toEqual(["file place.rbxl", "pid 4001 place.rbxl"]);
		expect(run.out).toContain("closed place.rbxl (PID 4001)");
		expect(machine.windows).toEqual([]);
		expect(machine.lock.owner).toBeUndefined();
	});

	test("studio open opens where it is seen, and so does a test anywhere but Windows", async () => {
		const place = studio();
		const opened = await runCli(["studio", "open", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: place.fake,
			onLaunch: place.onLaunch,
		});
		expect(opened.code).toBe(0);
		expect(opened.launchOptions).toEqual([{ hidden: false }]);
		expect(opened.all).not.toContain("hidden desktop");
		expect(opened.machine.lock.owner!.windows[0]!.hidden).toBeUndefined();

		const linux = await testRun([], { platform: "linux" });
		expect(linux.code).toBe(0);
		expect(linux.launchOptions).toEqual([{ hidden: false }]);
		expect(linux.all).not.toContain("hidden");
	});

	test("--show, FLAMEWORK_TEST_SHOW and testing.showWindows show it: the flag first, then the variable, then the key", async () => {
		expect(hidden(await testRun([]))).toBe(true);
		expect(hidden(await testRun(["--show"]))).toBe(false);
		expect(hidden(await testRun([], { env: { FLAMEWORK_TEST_SHOW: "1" } }))).toBe(false);
		expect(hidden(await testRun([], { settings: { showWindows: true } }))).toBe(false);
		// From .env or .env.local, which the settings carry.
		expect(hidden(await testRun([], { env: {}, settings: { env: { FLAMEWORK_TEST_SHOW: "yes" } } }))).toBe(false);
		expect(
			hidden(await testRun([], { env: { FLAMEWORK_TEST_SHOW: "false" }, settings: { showWindows: true } })),
		).toBe(true);
		expect(hidden(await testRun(["--show=false"], { env: { FLAMEWORK_TEST_SHOW: "on" } }))).toBe(true);
		expect(hidden(await testRun(["--show"], { env: { FLAMEWORK_TEST_SHOW: "0" } }))).toBe(false);
		expect(hidden(await testRun([], { env: { FLAMEWORK_TEST_SHOW: "" }, settings: { showWindows: true } }))).toBe(
			true,
		);

		const shown = await testRun(["--show"]);
		expect(shown.out).toContain("opening place.rbxl in Studio; waiting for it to connect...");

		const misspelt = await testRun([], { env: { FLAMEWORK_TEST_SHOW: "sometimes" } });
		expect(misspelt.code).toBe(2);
		expect(misspelt.err).toContain('FLAMEWORK_TEST_SHOW must be true or false (or 1 or 0), got "sometimes"');
		expect(misspelt.launched).toHaveLength(0);
	});

	test("every window of a --parallel run opens hidden", async () => {
		const project = JSON.stringify({ tree: { $className: "DataModel" } });
		const place = studio();
		const run = await runCli(
			["test", "place.rbxl", "--project", "tests/a.project.json,tests/b.project.json", "--parallel"],
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
		expect(run.launchOptions).toEqual([{ hidden: true }, { hidden: true }]);
	});

	test("not for the cloud: --show is refused there, the variable and key are left alone, and no other command has it", async () => {
		const refused = await runCli(["test", "place.rbxl", "--cloud", "--show"], { files: { "place.rbxl": "built" } });
		expect(refused.code).toBe(2);
		expect(refused.err).toContain("--show is for Studio runs: a cloud run opens no window on this machine to show");
		expect(refused.calls).toHaveLength(0);

		const cloud = await runCli(["test", "place.rbxl", "--cloud"], {
			responses: [json({ versionNumber: 9 }), ...happyPath([resultJson()])],
			files: { "place.rbxl": "built" },
			env: { ...ENV, FLAMEWORK_TEST_SHOW: "sometimes" },
		});
		expect(cloud.code).toBe(0);

		for (const command of [
			["studio", "open"],
			["studio", "run"],
			["cloud", "test", "place.rbxl"],
		]) {
			expect(() => parseArgs([...command, "--show"])).toThrow(/--show is not a flag of/);
		}
	});
});

describe("what a hidden window needs said", () => {
	test("one that never connects may be showing a dialog nobody sees: the error says so and points to --show", async () => {
		const run = await testRun([], {}, studio({ listing: false }));
		expect(run.code).toBe(1);
		expect(run.err).toContain("error: Studio started (PID 4001) but place.rbxl never showed up on the MCP proxy");
		expect(run.err).toContain(
			"it opened on the hidden desktop, where nobody sees it: it may be showing a dialog there that nobody can answer (a login, an update, a crash report), so run again with --show to see it",
		);
		expect(run.err).toContain("the window this run opened is closed again");
		expect(run.closeTargets).toContain("pid 4001 place.rbxl");

		// Shown, the window speaks for itself: the hint is the MCP setting's alone.
		const shown = await testRun(["--show"], {}, studio({ listing: false }));
		expect(shown.code).toBe(1);
		expect(shown.err).toContain('Studio\'s "MCP server" setting is probably off');
		expect(shown.err).not.toContain("--show");
		expect(shown.err).not.toContain("hidden desktop");
	});

	test("--keep leaves the window hidden, says how it is driven and closed, and studio close closes it by its process", async () => {
		const machine = fakeMachine();
		const kept = await testRun(["--keep"], { machine });
		expect(kept.code).toBe(0);
		expect(kept.out).toContain("Studio left open (--keep)");
		expect(kept.out.split("\n")).toContain(KEPT_HIDDEN);
		expect(machine.lock.owner!.windows).toMatchObject([{ studioPid: 4001, hidden: true }]);
		expect(machine.windows).toMatchObject([{ pid: 4001, hidden: true }]);

		const lock = await runCli(["studio", "lock"], { machine });
		expect(lock.out).toContain("  studio:   PID 4001, running, on the hidden desktop");
		const lockJson = JSON.parse((await runCli(["studio", "lock", "--json"], { machine })).out);
		expect(lockJson.windows).toMatchObject([{ studioPid: 4001, hidden: true }]);

		const listed = studio();
		listed.fake.studios.push({ id: "studio-place.rbxl-1", name: "place.rbxl" });
		machine.lock.owner!.windows[0]!.mcpId = "studio-place.rbxl-1";
		const list = await runCli(["studio", "list"], { machine, studio: listed.fake });
		expect(list.out).toContain(
			"studio-place.rbxl-1  place.rbxl  [opened by flamework-test for this project; holds the Studio lock; on the hidden desktop]",
		);
		const listJson = JSON.parse((await runCli(["studio", "list", "--json"], { machine, studio: listed.fake })).out);
		expect(listJson.studios).toContainEqual(
			expect.objectContaining({ studio_id: "studio-place.rbxl-1", hidden: true }),
		);
		expect(listJson.studioProcesses).toEqual([{ pid: 4001, title: `${THIS_FILE} - Roblox Studio`, hidden: true }]);

		// Closed by the process it was launched as, as every window flamework-test opened is, whatever the proxy lists.
		const close = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(close.code).toBe(0);
		expect(close.closeTargets).toEqual(["pid 4001 place.rbxl"]);
		expect(close.out).toContain("the Studio lock is free");
		expect(machine.windows).toEqual([]);

		// --show --keep: a window to look at, which says nothing of a hidden desktop.
		const shown = await testRun(["--keep", "--show"]);
		expect(shown.code).toBe(0);
		expect(shown.out).not.toContain("hidden desktop");
		expect(shown.machine.lock.owner!.windows[0]!.hidden).toBeUndefined();
	});

	test("a launch the hidden desktop refuses fails the run, with --show as the way out, and frees the lock", async () => {
		const run = await testRun([], {
			refuseLaunch: (command, how) =>
				how?.hidden === true
					? `could not start ${command[0]} on the hidden desktop flamework-test (CreateProcessW: error 5)`
					: undefined,
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			"error: could not start C:/Roblox/RobloxStudioBeta.exe on the hidden desktop flamework-test (CreateProcessW: error 5)",
		);
		expect(run.err).toContain("run again with --show to open Studio on your desktop instead");
		expect(run.machine.lock.owner).toBeUndefined();
		expect(run.windows).toEqual([]);
	});

	test("a window left on the hidden desktop is closed before a run of its file by its command line, which no title shows", async () => {
		const machine = fakeMachine({
			windows: [
				// Still loading: its title does not show the file yet, but its command line names it.
				{ pid: 4100, title: "Roblox Studio", startedWith: THIS_FILE, startedAt: 0, hidden: true },
				// The same, on the user's desktop: theirs, for all a run knows, and left alone.
				{ pid: 4200, title: "Roblox Studio", startedWith: THIS_FILE, startedAt: 0 },
			],
		});
		const run = await testRun([], { machine });
		expect(run.code).toBe(0);
		expect(run.out).toContain("closed the window left from an earlier build of place.rbxl (PID 4100)");
		expect(machine.windows.map((window) => window.pid)).toEqual([4200]);
	});
});
