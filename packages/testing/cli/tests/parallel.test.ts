import { describe, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";

import { parseArgs, PARALLEL_MOST } from "../src/cli.ts";
import type { CloudSettings } from "../src/config.ts";
import type { CloseTarget, StudioEntry } from "../src/studio.ts";
import {
	FIXTURE_CWD,
	fakeCtrlC,
	fakeMachine,
	flatOf,
	fromFlat,
	never,
	resultJson,
	runCli,
	type FakeMachine,
	type FakeStudio,
} from "./harness.ts";

const THIS_PROJECT = resolve(FIXTURE_CWD);
const OTHER_PROJECT = "D:\\other";
const MINUTE = 60_000;
const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";
const iso = (ms: number) => new Date(ms).toISOString();
const PROJECT = JSON.stringify({ tree: { $className: "DataModel" } });

/** Lets the other projects' work run: a realm in Studio takes a while. */
const ticks = async (count: number) => {
	for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The files of a run under the projects `names`: each project file, the build, and each project's place. */
function filesOf(names: string[]): Record<string, string> {
	const files: Record<string, string> = { "place.rbxl": "built" };
	for (const name of names) {
		files[`tests/${name}.project.json`] = PROJECT;
		files[`place.${name}.rbxl`] = "made";
	}
	return files;
}

const projectFlag = (names: string[]) => ["--project", names.map((name) => `tests/${name}.project.json`).join(",")];

type Answer = string | (() => string | Promise<string>);

/**
 * Studio with several windows at once: each window the run launches is listed by its file name as
 * `studio-<file>` while its process runs (once `register` lets it, by default at once), keeps its
 * own play mode, and answers each realm from `results[file][realm]` after `delay[file]` ticks.
 * `timeline` records every launch and close in order; `mostOpen` the most windows open at once.
 */
function sideBySide(
	machine: FakeMachine,
	results: Record<string, Record<string, Answer>>,
	options: { delay?: Record<string, number>; register?: (file: string) => boolean } = {},
) {
	const entries: Array<StudioEntry & { pid: number; file: string }> = [];
	const mode = new Map<string, string>();
	const timeline: string[] = [];
	let mostOpen = 0;
	const fake = {
		studios: () =>
			entries
				.filter((entry) => machine.windows.some((window) => window.pid === entry.pid))
				.filter((entry) => options.register?.(entry.file) ?? true)
				.map(({ id, name }) => ({ id, name })),
		answers: {
			get_studio_state: (args: Record<string, unknown>) =>
				mode.get(args.studio_id as string) === "Play" ? PLAYING : EDITING,
			start_stop_play: (args: Record<string, unknown>) => {
				mode.set(args.studio_id as string, args.is_start ? "Play" : "Edit");
				return args.is_start ? "Game Started" : "Game Stopped";
			},
			execute_luau: async (args: Record<string, unknown>) => {
				const entry = entries.find((candidate) => candidate.id === args.studio_id);
				if (entry === undefined) throw new Error(`no window ${String(args.studio_id)}`);
				await ticks(options.delay?.[entry.file] ?? 2);
				const answer = results[entry.file]?.[args.datamodel_type as string];
				if (answer === undefined) throw new Error(`no result for ${entry.file} ${String(args.datamodel_type)}`);
				return typeof answer === "function" ? await answer() : answer;
			},
		},
	} satisfies FakeStudio;
	return {
		fake,
		timeline,
		entries,
		mostOpen: () => mostOpen,
		onLaunch: (command: string[]) => {
			const file = basename(command[1]!);
			entries.push({ id: `studio-${file}`, name: file, pid: machine.nextStudioPid, file });
			timeline.push(`launch ${file}`);
			// The window this launch adds, and every one of the run's still open.
			mostOpen = Math.max(mostOpen, machine.windows.length + 1);
		},
		onClose: (target: CloseTarget) => {
			if ("pid" in target) timeline.push(`close ${basename(target.file)}`);
		},
	};
}

/** Both realms of a project pass, the place saying which project it is. */
function passing(name: string): Record<string, Answer> {
	return {
		Server: JSON.stringify(resultJson({ project: name })),
		Client: JSON.stringify(resultJson({ realm: "client", project: name })),
	};
}

async function runSideBySide(
	names: string[],
	extra: string[],
	setup: {
		machine?: FakeMachine;
		results?: Record<string, Record<string, Answer>>;
		delay?: Record<string, number>;
		register?: (file: string) => boolean;
		env?: Record<string, string | undefined>;
		settings?: Partial<CloudSettings>;
		ctrlC?: ReturnType<typeof fakeCtrlC>;
		closeOutcome?: (target: CloseTarget) => "closed" | "open";
		spawnCode?: (command: string[]) => number | Promise<number>;
	} = {},
) {
	const machine = setup.machine ?? fakeMachine();
	const results = setup.results ?? Object.fromEntries(names.map((name) => [`place.${name}.rbxl`, passing(name)]));
	const studio = sideBySide(machine, results, {
		...(setup.delay !== undefined ? { delay: setup.delay } : {}),
		...(setup.register !== undefined ? { register: setup.register } : {}),
	});
	const options: Parameters<typeof runCli>[1] & {} = {
		machine,
		files: filesOf(names),
		studio: studio.fake,
		onLaunch: studio.onLaunch,
		...(setup.env !== undefined ? { env: setup.env } : {}),
		...(setup.settings !== undefined ? { settings: setup.settings } : {}),
		...(setup.ctrlC !== undefined ? { ctrlC: setup.ctrlC } : {}),
		...(setup.spawnCode !== undefined ? { spawnCode: setup.spawnCode } : {}),
	};
	options.onClose = (target) => {
		studio.onClose(target);
		if (setup.closeOutcome !== undefined) options.closeOutcome = setup.closeOutcome(target);
	};
	const run = await runCli(["test", "place.rbxl", ...projectFlag(names), ...extra], options);
	return { run, studio, machine };
}

describe("--parallel: several projects' windows side by side", () => {
	test("never more windows at once than asked, a slot refilling in project order as a window closes", async () => {
		const names = ["a", "b", "c", "d"];
		// b takes longest, so a's slot frees first and c takes it, then d takes the next to free.
		const { run, studio, machine } = await runSideBySide(names, ["--parallel", "2"], {
			delay: { "place.a.rbxl": 2, "place.b.rbxl": 40, "place.c.rbxl": 4, "place.d.rbxl": 2 },
		});
		expect(run.code).toBe(0);
		expect(studio.mostOpen()).toBe(2);
		expect(studio.timeline).toEqual([
			"launch place.a.rbxl",
			"launch place.b.rbxl",
			"close place.a.rbxl",
			"launch place.c.rbxl",
			"close place.c.rbxl",
			"launch place.d.rbxl",
			"close place.d.rbxl",
			"close place.b.rbxl",
		]);
		expect(run.out).toContain("projects: a passed, b passed, c passed, d passed");
		expect(run.windows).toHaveLength(0);
		expect(machine.lock.owner).toBeUndefined();

		// Three at a time, and every project in one go when asked for as many.
		const three = await runSideBySide(names, ["--parallel", "3"], {
			delay: { "place.a.rbxl": 10, "place.b.rbxl": 10, "place.c.rbxl": 10, "place.d.rbxl": 2 },
		});
		expect(three.run.code).toBe(0);
		expect(three.studio.mostOpen()).toBe(3);
		expect(three.studio.timeline.slice(0, 3)).toEqual([
			"launch place.a.rbxl",
			"launch place.b.rbxl",
			"launch place.c.rbxl",
		]);
	});

	test("each project's lines stay together, in project order, and stdout is what a run one after another prints", async () => {
		const names = ["a", "b", "c"];
		// a is slow: b and c finish first, and their lines wait for a's.
		const delay = { "place.a.rbxl": 30, "place.b.rbxl": 2, "place.c.rbxl": 2 };
		const parallel = await runSideBySide(names, ["--parallel", "3"], { delay });
		const serial = await runSideBySide(names, [], { delay });
		expect(parallel.run.code).toBe(0);
		expect(serial.run.code).toBe(0);
		expect(parallel.run.out).toBe(serial.run.out);
		const out = parallel.run.out;
		const at = (text: string) => out.indexOf(text);
		expect(at("=== a: ")).toBeLessThan(at("(server, project a)"));
		expect(at("(client, project a)")).toBeLessThan(at("=== b: "));
		expect(at("=== b: ")).toBeLessThan(at("(server, project b)"));
		expect(at("closed place.b.rbxl")).toBeLessThan(at("=== c: "));

		// While a runs, the others say how they get on, briefly, on stderr.
		const err = parallel.run.err;
		expect(err).toContain("[b] started");
		expect(err).toContain("[b] opening place.b.rbxl in Studio (PID 4002, hidden)");
		expect(err).toContain("[b] connected: place.b.rbxl (studio-place.b.rbxl)");
		expect(err).toContain("[b] server: 2 passed, 0 failed, 0 skipped");
		expect(err).toMatch(/\[b\] passed in \d+s; its lines follow a's/);
		expect(err).toMatch(/\[c\] passed in \d+s; its lines follow a's/);
		// a's lines are its own, as they come: nothing of it is said twice.
		expect(err).not.toContain("[a]");
		expect(serial.run.err).not.toContain("[b]");

		// --json too: stdout as one after another prints it.
		const json = await runSideBySide(names, ["--parallel", "3", "--json"], { delay });
		const jsonSerial = await runSideBySide(names, ["--json"], { delay });
		expect(json.run.out).toBe(jsonSerial.run.out);
	});

	test("what a project's child processes print (lune's patch) stays among its own lines", async () => {
		const names = ["a", "b"];
		const lines = (command: string[]) => {
			const plan = command.find((part) => part.endsWith(".rbxl") && /place\.\w\.rbxl$/.test(part));
			return command[1] === "--version" ? ["lune 0.10.5"] : [`  replaced for ${basename(plan ?? "?")}`];
		};
		const run = async (extra: string[]) => {
			const machine = fakeMachine();
			const studio = sideBySide(
				machine,
				{ "place.a.rbxl": passing("a"), "place.b.rbxl": passing("b") },
				{ delay: { "place.a.rbxl": 20, "place.b.rbxl": 1 } },
			);
			return await runCli(["test", "place.rbxl", ...projectFlag(names), ...extra], {
				machine,
				files: filesOf(names),
				studio: studio.fake,
				onLaunch: studio.onLaunch,
				spawnLines: lines,
			});
		};
		const parallel = await run(["--parallel"]);
		expect(parallel.code).toBe(0);
		const out = parallel.out;
		const b = out.indexOf("=== b: ");
		expect(out.indexOf("  replaced for place.a.rbxl")).toBeLessThan(b);
		expect(out.indexOf("  replaced for place.b.rbxl")).toBeGreaterThan(b);
		expect(out.split("\n").filter((line) => line === "lune 0.10.5")).toHaveLength(2);
		expect(out.lastIndexOf("lune 0.10.5")).toBeGreaterThan(b);
		// And what one after another prints, where the lines are inherited as they come.
		const serial = await run([]);
		expect(serial.out).toBe(out);
	});

	test("a project that fails, by a window that never connects or a realm that errs, fails alone", async () => {
		const names = ["a", "b", "c", "d"];
		const results: Record<string, Record<string, Answer>> = {
			"place.a.rbxl": passing("a"),
			"place.b.rbxl": passing("b"),
			"place.c.rbxl": {
				Server: () => {
					throw new Error("execute_luau: AssistantCommand:3: kaboom");
				},
				Client: JSON.stringify(resultJson({ realm: "client", project: "c" })),
			},
			"place.d.rbxl": passing("d"),
		};
		// b's window never shows up on the proxy.
		const { run, studio, machine } = await runSideBySide(names, ["--parallel", "2"], {
			results,
			register: (file) => file !== "place.b.rbxl",
		});
		expect(run.code).toBe(1);
		expect(run.out).toContain("projects: a passed, b FAILED, c FAILED, d passed");
		// Each project's failure is among its own lines, and its window was closed.
		const all = run.all;
		expect(run.err).toContain("Studio started (PID 4002) but");
		expect(run.err).toContain("the server's run failed: kaboom");
		expect(studio.timeline.filter((line) => line.startsWith("launch"))).toHaveLength(4);
		expect(run.windows).toHaveLength(0);
		expect(machine.lock.owner).toBeUndefined();
		expect(all).toContain("(client, project c)");
	});

	test("two windows launched at once are each taken for their own project's, whichever registers first", async () => {
		const names = ["a", "b"];
		const machine = fakeMachine();
		let both = false;
		// Neither registers until both have been launched, and then b's is listed first.
		const results = { "place.a.rbxl": passing("a"), "place.b.rbxl": passing("b") };
		const studio = sideBySide(machine, results, { register: () => both });
		const fake = {
			...studio.fake,
			studios: () => [...studio.fake.studios()].reverse(),
		};
		const run = await runCli(["test", "place.rbxl", ...projectFlag(names), "--parallel"], {
			machine,
			files: filesOf(names),
			studio: fake,
			onLaunch: (command) => {
				studio.onLaunch(command);
				both = studio.entries.length === 2;
			},
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain("connected: place.a.rbxl (studio-place.a.rbxl)");
		expect(run.out).toContain("connected: place.b.rbxl (studio-place.b.rbxl)");
		// Each realm ran in its own project's window.
		for (const name of names) {
			const calls = run.studioCalls.filter(
				(call) => call.name === "execute_luau" && call.args.studio_id === `studio-place.${name}.rbxl`,
			);
			expect(calls).toHaveLength(2);
		}
		expect(run.out).toContain("(server, project a)");
		expect(run.out).toContain("(server, project b)");
	});

	test("Ctrl+C with several windows open closes every one of them, frees the lock and exits 130; no project starts after it", async () => {
		const names = ["a", "b", "c"];
		const ctrlC = fakeCtrlC();
		const machine = fakeMachine();
		let pressed = false;
		const hang = async () => {
			// Pressed once both windows are open and running their realms.
			while (machine.windows.length < 2) await ticks(1);
			if (!pressed) {
				pressed = true;
				ctrlC.press();
			}
			return await never<string>();
		};
		const results = { "place.a.rbxl": { Server: hang }, "place.b.rbxl": { Server: hang } };
		const { run, studio } = await runSideBySide(names, ["--parallel", "2"], { machine, results, ctrlC });
		expect(run.code).toBe(130);
		expect(studio.timeline.filter((line) => line.startsWith("launch"))).toEqual([
			"launch place.a.rbxl",
			"launch place.b.rbxl",
		]);
		expect(run.closedWindows.sort()).toEqual(["place.a.rbxl", "place.b.rbxl"]);
		expect(run.windows).toHaveLength(0);
		expect(machine.lock.owner).toBeUndefined();
		expect(run.err).toContain("interrupted by Ctrl+C: cleaned up:");
		expect(run.err).toContain("closed the Studio window it opened (PID 4001, place.a.rbxl)");
		expect(run.err).toContain("closed the Studio window it opened (PID 4002, place.b.rbxl)");
		expect(run.err).toContain("released the Studio lock");
		expect(run.err).not.toContain("left:");
		// Each session the run started was stopped too.
		expect(
			run.studioCalls.filter((call) => call.name === "start_stop_play" && call.args.is_start === false),
		).toHaveLength(2);
		expect(run.out).not.toContain("projects:");
	});
});

describe("--parallel: the Studio lock with several windows", () => {
	test("the record lists every window; studio lock, studio list and --check-window name each; a change to one is refused as in use", async () => {
		const names = ["a", "b"];
		const machine = fakeMachine();
		const seen: Array<Awaited<ReturnType<typeof runCli>>> = [];
		let record: ReturnType<typeof flatOf> | undefined;
		const box: { studio?: ReturnType<typeof sideBySide> } = {};
		const look = async () => {
			// Once both windows have connected, from the other project and from this one.
			while ((machine.lock.owner?.windows.filter((window) => window.mcpId !== undefined).length ?? 0) < 2) {
				await ticks(1);
			}
			if (seen.length > 0) return JSON.stringify(resultJson({ project: "b" }));
			record = flatOf(structuredClone(machine.lock.owner!));
			const other = { machine, cwd: OTHER_PROJECT, studio: box.studio!.fake };
			seen.push(await runCli(["studio", "lock", "--check-window"], other));
			seen.push(await runCli(["studio", "list"], other));
			seen.push(
				await runCli(["studio", "exec", "--studio", "studio-place.a.rbxl", "--code", "return 1"], {
					machine,
					studio: box.studio!.fake,
				}),
			);
			seen.push(await runCli(["studio", "close"], { machine, studio: box.studio!.fake }));
			seen.push(await runCli(["studio", "status"], { machine, studio: box.studio!.fake }));
			return JSON.stringify(resultJson({ project: "b" }));
		};
		const results = { "place.a.rbxl": passing("a"), "place.b.rbxl": { ...passing("b"), Server: look } };
		const studio = sideBySide(machine, results, { delay: { "place.a.rbxl": 60, "place.b.rbxl": 1 } });
		box.studio = studio;
		const run = await runCli(["test", "place.rbxl", ...projectFlag(names), "--parallel", "2"], {
			machine,
			files: filesOf(names),
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});
		expect(run.code).toBe(0);

		const placeA = join(THIS_PROJECT, "place.a.rbxl");
		const placeB = join(THIS_PROJECT, "place.b.rbxl");
		expect(record).toMatchObject({ command: "test --parallel 2", project: THIS_PROJECT, cliPid: run.cliPid });
		expect(record!.windows).toEqual([
			{
				place: placeA,
				placeFile: placeA,
				studioPid: 4001,
				studioStartedAt: expect.any(String),
				mcpId: "studio-place.a.rbxl",
				hidden: true,
			},
			{
				place: placeB,
				placeFile: placeB,
				studioPid: 4002,
				studioStartedAt: expect.any(String),
				mcpId: "studio-place.b.rbxl",
				hidden: true,
			},
		]);

		const [lock, list, exec, close, status] = seen;
		expect(lock!.out).toContain(`live: its \`test --parallel 2\` is running (flamework-test PID ${run.cliPid})`);
		expect(lock!.out).toContain("  window 1 of 2:");
		expect(lock!.out).toContain(`  place:    ${placeA}`);
		expect(lock!.out).toContain("  studio:   PID 4001, running, on the hidden desktop");
		expect(lock!.out).toContain("  mcp:      studio-place.a.rbxl, on the MCP proxy");
		expect(lock!.out).toContain("  window 2 of 2:");
		expect(lock!.out).toContain("  mcp:      studio-place.b.rbxl, on the MCP proxy");
		expect(list!.out).toContain(
			`studio-place.a.rbxl  place.a.rbxl  [opened by flamework-test for ${THIS_PROJECT}; holds the Studio lock; on the hidden desktop]`,
		);
		expect(list!.out).toContain(
			`studio-place.b.rbxl  place.b.rbxl  [opened by flamework-test for ${THIS_PROJECT}; holds the Studio lock; on the hidden desktop]`,
		);
		// This project's own windows, while its run uses them: refused before anything is sent.
		expect(exec!.code).toBe(1);
		expect(exec!.err).toContain(
			`refusing to run Luau in this project's Studio window (${placeA}, Studio PID 4001): \`test --parallel 2\` is running in it`,
		);
		expect(exec!.err).toContain("and closes it when it ends");
		expect(exec!.studioCalls).toHaveLength(0);
		expect(close!.code).toBe(1);
		expect(close!.err).toContain(
			`refusing to close this project's Studio windows (${placeA}, Studio PID 4001; ${placeB}, Studio PID 4002): \`test --parallel 2\` is running in them`,
		);
		expect(close!.closeTargets).toHaveLength(0);
		// A read-only command needs to be told which.
		expect(status!.code).toBe(1);
		expect(status!.err).toContain("has 2 Studio windows");
		expect(status!.err).toContain("name one with --studio <id>");
		expect(machine.lock.owner).toBeUndefined();
	});

	test("a window that will not close stays in the record with its own file, and the next taker closes it (L2)", async () => {
		const names = ["a", "b"];
		const machine = fakeMachine();
		// One after another, as the case was found: a's window will not close, and is still open, so b,
		// which would be a second window at once, is not run.
		const { run } = await runSideBySide(names, [], {
			machine,
			closeOutcome: (target) => ("pid" in target && target.pid === 4001 ? "open" : "closed"),
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("place.a.rbxl is still open");
		expect(run.err).toContain(
			"error: not run: the Studio window of a would not close, and this run opens no more than one window at once (--parallel)",
		);
		expect(run.launched).toHaveLength(1);
		expect(run.out).toContain("projects: a FAILED, b FAILED");
		// The window that would not close holds the lock, named by its own process and file, never
		// b's; the lock is left to it under the lease.
		const placeA = join(THIS_PROJECT, "place.a.rbxl");
		expect(machine.lock.owner).toMatchObject({ kept: true, command: "test" });
		expect(machine.lock.owner!.windows).toEqual([
			{
				place: placeA,
				placeFile: placeA,
				studioPid: 4001,
				studioStartedAt: expect.any(String),
				mcpId: "studio-place.a.rbxl",
				hidden: true,
			},
		]);

		// Past its hold, another project's command closes that very window, by its process and file.
		machine.advance(16 * MINUTE);
		const other = await runCli(["studio", "open", "test.rbxl"], {
			machine,
			cwd: OTHER_PROJECT,
			files: { "test.rbxl": "built" },
			studio: { studios: () => [{ id: "theirs", name: "test.rbxl" }] },
		});
		expect(other.closeTargets[0]).toBe("pid 4001 place.a.rbxl");
		expect(other.out).toContain(
			`closed the Studio window flamework-test opened for ${THIS_PROJECT} (test on ${placeA}, Studio PID 4001)`,
		);
	});

	test("a run cut short with several windows open: the next taker closes every one, and their owner is told", async () => {
		const machine = fakeMachine();
		const now = machine.time.now;
		const fileA = "D:\\other\\place.a.rbxl";
		const fileB = "D:\\other\\place.b.rbxl";
		machine.windows.push(
			{ pid: 5001, title: `${fileA} - Roblox Studio`, startedWith: fileA, startedAt: now - MINUTE },
			{ pid: 5002, title: `${fileB} - Roblox Studio`, startedWith: fileB, startedAt: now - MINUTE },
		);
		const abandoned = fromFlat({
			token: "parallel-token",
			cliPid: 8001,
			cliName: "bun",
			cliStartedAt: iso(now - 2 * MINUTE),
			project: OTHER_PROJECT,
			command: "test --parallel 2",
			windows: [
				{
					place: fileA,
					placeFile: fileA,
					studioPid: 5001,
					studioStartedAt: iso(now - MINUTE),
					mcpId: "their-a",
				},
				{
					place: fileB,
					placeFile: fileB,
					studioPid: 5002,
					studioStartedAt: iso(now - MINUTE),
					mcpId: "their-b",
				},
			],
			since: iso(now - 2 * MINUTE),
			lastActivity: iso(now),
			expires: iso(now + 15 * MINUTE),
			holdMinutes: 15,
		});
		machine.lock.owner = abandoned;
		let run1Launched = false;

		// The lock and the list say so before anything takes it.
		const lock = await runCli(["studio", "lock"], { machine });
		expect(lock.out).toContain(
			"expired: the `test --parallel 2` that opened them (flamework-test PID 8001) has ended without closing them",
		);

		const run = await runCli(["studio", "open", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: { studios: () => (run1Launched ? [{ id: "mine", name: "place.rbxl" }] : []) },
			onLaunch: () => {
				run1Launched = true;
			},
		});
		expect(run.code).toBe(0);
		expect(run.closeTargets.slice(0, 2)).toEqual(["pid 5001 place.a.rbxl", "pid 5002 place.b.rbxl"]);
		expect(run.out).toContain(
			`closed the Studio windows flamework-test opened for ${OTHER_PROJECT} (test --parallel 2 on ${fileA}, Studio PID 5001; ${fileB}, Studio PID 5002): the \`test --parallel 2\` that opened them (flamework-test PID 8001) has ended without closing them; the Studio lock is free`,
		);
		expect(flatOf(machine.lock.owner!)).toMatchObject({ project: THIS_PROJECT, mcpId: "mine" });
		expect(machine.lock.closed).toHaveLength(1);
		expect(machine.lock.closed[0]!.windows.map((window) => window.mcpId)).toEqual(["their-a", "their-b"]);

		// Their owner's next command says what became of both.
		const told = await runCli(["studio", "exec", "--studio", "their-b", "--code", "return 1"], {
			machine,
			cwd: OTHER_PROJECT,
			studio: { studios: [] },
		});
		expect(told.code).toBe(1);
		expect(told.err).toContain(
			`the Studio windows flamework-test opened for this project (${fileA}, Studio PID 5001, MCP id their-a; ${fileB}, Studio PID 5002, MCP id their-b) were closed at`,
		);
		expect(told.err).toContain(
			"because the `test --parallel 2` that opened them (flamework-test PID 8001) had ended without closing them",
		);
		// Had again by the run that opened them: `studio open` would give one window, of one file.
		expect(told.err).toContain("`test --parallel 2` opened them: run it again for new ones");
		expect(told.err).not.toContain("flamework-test studio open");
	});

	test("a window that will not close keeps its place: no more windows at once than asked, and what cannot start is not run", async () => {
		const names = ["a", "b", "c"];
		// a's window will not close: its worker stops, and b and c run in the other place, one after another.
		const one = await runSideBySide(names, ["--parallel", "2"], {
			delay: { "place.a.rbxl": 2, "place.b.rbxl": 20, "place.c.rbxl": 2 },
			closeOutcome: (target) => ("pid" in target && target.pid === 4001 ? "open" : "closed"),
		});
		expect(one.run.code).toBe(1);
		expect(one.studio.mostOpen()).toBe(2);
		expect(one.studio.timeline).toEqual([
			"launch place.a.rbxl",
			"launch place.b.rbxl",
			"close place.a.rbxl",
			"close place.b.rbxl",
			"launch place.c.rbxl",
			"close place.c.rbxl",
		]);
		expect(one.run.out).toContain("projects: a FAILED, b passed, c passed");

		// a's and b's will not close: both places are held, and c is not run, saying why among its own lines.
		const both = await runSideBySide(names, ["--parallel", "2"], {
			closeOutcome: (target) => ("pid" in target && target.pid !== 4003 ? "open" : "closed"),
		});
		expect(both.run.code).toBe(1);
		expect(both.run.launched).toHaveLength(2);
		expect(both.run.err).toContain(
			"error: not run: the Studio windows of a, b would not close, and this run opens no more than 2 windows at once (--parallel)",
		);
		expect(both.run.err).toContain("close them by hand (or with `flamework-test studio close`)");
		const out = both.run.out;
		expect(out.indexOf("=== c: ")).toBeGreaterThan(out.indexOf("=== b: "));
		expect(out).toContain("projects: a FAILED, b FAILED, c FAILED");
		expect(both.machine.lock.owner!.windows.map((window) => window.studioPid)).toEqual([4001, 4002]);
	});

	test("what taking the lock says is among the lines of the project that took it", async () => {
		const machine = fakeMachine();
		const now = machine.time.now;
		const otherFile = "D:\\other\\test.rbxl";
		// Another project's window, idle past its hold: whoever takes the lock closes it, saying so.
		machine.windows.push({
			pid: 5001,
			title: `${otherFile} - Roblox Studio`,
			startedWith: otherFile,
			startedAt: now - 30 * MINUTE,
		});
		machine.lock.owner = fromFlat({
			token: "other-token",
			cliPid: 8001,
			cliName: "bun",
			cliStartedAt: iso(now - 30 * MINUTE),
			studioPid: 5001,
			studioStartedAt: iso(now - 30 * MINUTE),
			mcpId: "studio-other",
			project: OTHER_PROJECT,
			command: "studio open",
			place: otherFile,
			placeFile: otherFile,
			since: iso(now - 30 * MINUTE),
			lastActivity: iso(now - 20 * MINUTE),
			expires: iso(now - 5 * MINUTE),
			holdMinutes: 15,
			kept: true,
		});
		// a's patch takes longer, so b, the later project, takes the lock while a's lines are the live ones.
		const { run } = await runSideBySide(["a", "b"], ["--parallel", "2"], {
			machine,
			spawnCode: async (command) => {
				if (command.some((arg) => arg.endsWith("place.a.rbxl"))) await ticks(40);
				return 0;
			},
		});
		expect(run.code).toBe(0);
		const out = run.out;
		const closedLine = out.indexOf(`closed the Studio window flamework-test opened for ${OTHER_PROJECT}`);
		expect(closedLine).toBeGreaterThan(out.indexOf("=== b: "));
		expect(out.indexOf("=== b: ")).toBeGreaterThan(out.indexOf("=== a: "));
		// Said as b's progress meanwhile, while a's lines were the ones printing.
		expect(run.err).toContain(`[b] closed the Studio window flamework-test opened for ${OTHER_PROJECT}`);
	});

	test("every window gone: the lock is taken over, each one's Studio lock file removed; one still open keeps it", async () => {
		const machine = fakeMachine();
		const now = machine.time.now;
		const fileA = "D:\\other\\place.a.rbxl";
		const fileB = "D:\\other\\place.b.rbxl";
		const record = (token: string) =>
			fromFlat({
				token,
				cliPid: 8001,
				cliName: "bun",
				cliStartedAt: iso(now - 2 * MINUTE),
				project: OTHER_PROJECT,
				command: "test --parallel 2",
				windows: [
					{ place: fileA, placeFile: fileA, studioPid: 5001, studioStartedAt: iso(now - MINUTE) },
					{ place: fileB, placeFile: fileB, studioPid: 5002, studioStartedAt: iso(now - MINUTE) },
				],
				since: iso(now - 2 * MINUTE),
				lastActivity: iso(now),
				expires: iso(now + 15 * MINUTE),
				holdMinutes: 15,
			});
		machine.lock.owner = record("gone-token");
		const files = { "place.rbxl": "built", "place.a.rbxl.lock": "5001\nx", "place.b.rbxl.lock": "5002\nx" };
		let launched = false;
		const studio = { studios: () => (launched ? [{ id: "mine", name: "place.rbxl" }] : []) };
		const run = await runCli(["studio", "open", "place.rbxl"], {
			machine,
			files,
			studio,
			onLaunch: () => {
				launched = true;
			},
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			`took over the Studio lock: the windows flamework-test opened for ${OTHER_PROJECT} have closed: ${fileA}, Studio PID 5001; ${fileB}, Studio PID 5002`,
		);
		expect(run.removedFiles.map((path) => path.split("/").pop())).toEqual([
			"place.a.rbxl.lock",
			"place.b.rbxl.lock",
		]);
		expect(machine.lock.closed[0]).toMatchObject({
			reason: "gone",
			windows: [{ studioPid: 5001 }, { studioPid: 5002 }],
		});

		// One of the two still open: the lock is that window's, expired (abandoned), not stale.
		const second = fakeMachine();
		second.windows.push({
			pid: 5002,
			title: `${fileB} - Roblox Studio`,
			startedWith: fileB,
			startedAt: now - MINUTE,
		});
		second.lock.owner = record("half-token");
		const half = await runCli(["studio", "lock"], { machine: second });
		expect(half.out).toContain("expired: the `test --parallel 2` that opened it (flamework-test PID 8001)");
		expect(half.out).toContain("  studio:   PID 5001, no longer running");
		expect(half.out).toContain("  studio:   PID 5002, running");
	});

	test("a takeover whose close of one window fails leaves that window, alone, in the record for the next taker", async () => {
		const machine = fakeMachine();
		const now = machine.time.now;
		const fileA = "D:\\other\\place.a.rbxl";
		const fileB = "D:\\other\\place.b.rbxl";
		machine.windows.push(
			{ pid: 5001, title: `${fileA} - Roblox Studio`, startedWith: fileA, startedAt: now - MINUTE },
			{ pid: 5002, title: `${fileB} - Roblox Studio`, startedWith: fileB, startedAt: now - MINUTE },
		);
		machine.lock.owner = fromFlat({
			token: "parallel-token",
			cliPid: 8001,
			cliName: "bun",
			cliStartedAt: iso(now - 2 * MINUTE),
			project: OTHER_PROJECT,
			command: "test --parallel 2",
			windows: [
				{ place: fileA, placeFile: fileA, studioPid: 5001, studioStartedAt: iso(now - MINUTE) },
				{ place: fileB, placeFile: fileB, studioPid: 5002, studioStartedAt: iso(now - MINUTE) },
			],
			since: iso(now - 2 * MINUTE),
			lastActivity: iso(now),
			expires: iso(now + 15 * MINUTE),
			holdMinutes: 15,
		});
		const options: Parameters<typeof runCli>[1] & {} = { machine, files: { "place.rbxl": "built" } };
		options.onClose = (target) => {
			options.closeOutcome = "pid" in target && target.pid === 5002 ? "open" : "closed";
		};
		const run = await runCli(["studio", "open", "place.rbxl"], options);
		expect(run.code).toBe(1);
		expect(run.err).toContain("place.b.rbxl is still open");
		expect(run.launched).toHaveLength(0);
		expect(machine.lock.owner).toMatchObject({ token: "parallel-token" });
		expect(machine.lock.owner!.windows.map((window) => window.studioPid)).toEqual([5002]);
	});
});

describe("--parallel: how many", () => {
	test("--parallel alone is 2, a number after it is its value, anything else is left for what comes next", () => {
		expect(parseArgs(["test", "place.rbxl", "--parallel"]).flags).toMatchObject({
			parallel: "2",
			file: "place.rbxl",
		});
		expect(parseArgs(["test", "--parallel", "place.rbxl"]).flags).toMatchObject({
			parallel: "2",
			file: "place.rbxl",
		});
		expect(parseArgs(["test", "--parallel", "3", "place.rbxl"]).flags).toMatchObject({
			parallel: "3",
			file: "place.rbxl",
		});
		expect(parseArgs(["test", "--parallel", "--sections", "x"]).flags).toMatchObject({
			parallel: "2",
			sections: "x",
		});
		expect(parseArgs(["test", "--parallel=4"]).flags.parallel).toBe("4");
		expect(parseArgs(["test", "--parallel", "-1"]).flags.parallel).toBe("-1");
		expect(() => parseArgs(["studio", "run", "--parallel"])).toThrow('--parallel is not a flag of "studio run"');
	});

	test("refused before anything is patched or opened unless a whole number, 1 or more: the flag, the variable, the key", async () => {
		const names = ["a", "b"];
		for (const [extra, env, settings, message] of [
			[["--parallel", "0"], undefined, undefined, '--parallel must be a whole number, 1 or more, got "0"'],
			[["--parallel=1.5"], undefined, undefined, '--parallel must be a whole number, 1 or more, got "1.5"'],
			[["--parallel", "-1"], undefined, undefined, '--parallel must be a whole number, 1 or more, got "-1"'],
			[
				[],
				{ FLAMEWORK_TEST_PARALLEL: "two" },
				undefined,
				'FLAMEWORK_TEST_PARALLEL must be a whole number, 1 or more, got "two"',
			],
			[[], undefined, { parallel: 0 }, 'testing.parallel must be a whole number, 1 or more, got "0"'],
		] as const) {
			const { run } = await runSideBySide(names, [...extra], {
				...(env !== undefined ? { env } : {}),
				...(settings !== undefined ? { settings } : {}),
			});
			expect(run.code).toBe(2);
			expect(run.err).toContain(message);
			expect(run.spawned).toHaveLength(0);
			expect(run.launched).toHaveLength(0);
		}
	});

	test("the flag comes first, then FLAMEWORK_TEST_PARALLEL, then testing.parallel; cut to the projects there are", async () => {
		const names = ["a", "b", "c"];
		const delay = { "place.a.rbxl": 10, "place.b.rbxl": 10, "place.c.rbxl": 10 };
		const most = async (extra: string[], env?: Record<string, string>, settings?: Partial<CloudSettings>) =>
			(
				await runSideBySide(names, extra, {
					delay,
					...(env !== undefined ? { env } : {}),
					...(settings !== undefined ? { settings } : {}),
				})
			).studio.mostOpen();
		expect(await most([])).toBe(1);
		expect(await most([], undefined, { parallel: 2 })).toBe(2);
		expect(await most([], { FLAMEWORK_TEST_PARALLEL: "3" }, { parallel: 2 })).toBe(3);
		expect(await most(["--parallel", "1"], { FLAMEWORK_TEST_PARALLEL: "3" })).toBe(1);
		expect(await most(["--parallel"], { FLAMEWORK_TEST_PARALLEL: "3" })).toBe(2);
		// More than the projects: one window per project, said nothing of.
		const clamped = await runSideBySide(names, ["--parallel", "4"], { delay });
		expect(clamped.studio.mostOpen()).toBe(3);
		expect(clamped.run.err).not.toContain("note:");
		expect(clamped.machine.lock.owner).toBeUndefined();
		// The record names the windows it runs at once, the clamped number.
		expect(clamped.run.code).toBe(0);
	});

	test(`never more than ${PARALLEL_MOST} at once, saying so when more are asked for`, async () => {
		const names = ["a", "b", "c", "d", "e", "f"];
		const delay = Object.fromEntries(names.map((name) => [`place.${name}.rbxl`, 10]));
		const { run, studio } = await runSideBySide(names, ["--parallel", "6"], { delay });
		expect(run.code).toBe(0);
		expect(studio.mostOpen()).toBe(PARALLEL_MOST);
		expect(run.err).toContain(
			`note: --parallel 6 is more than the ${PARALLEL_MOST} Studio windows flamework-test opens at once (each takes about 3 GB with its play session); running ${PARALLEL_MOST} at a time`,
		);
	});

	test("a cloud run refuses an explicit --parallel, and ignores the variable and the key; --keep under several projects is refused still", async () => {
		const names = ["a", "b"];
		const cloud = await runCli(["test", "place.rbxl", "--cloud", ...projectFlag(names), "--parallel", "2"], {
			files: filesOf(names),
		});
		expect(cloud.code).toBe(2);
		expect(cloud.err).toContain(
			"--parallel is for Studio runs: the cloud runs of several projects publish to the one testing place, so they run one after another",
		);
		expect(cloud.spawned).toHaveLength(0);

		// FLAMEWORK_TEST_PARALLEL, even misspelt, and testing.parallel are not a cloud run's.
		const ignored = await runCli(["test", "place.rbxl", "--cloud", ...projectFlag(names)], {
			files: filesOf(names),
			env: {
				TESTING_PLACE_API_KEY: "k",
				TESTING_UNIVERSE_ID: "1",
				TESTING_PLACE_ID: "2",
				FLAMEWORK_TEST_PARALLEL: "two",
			},
			settings: { parallel: 0 },
			responses: [],
		});
		expect(ignored.err).not.toContain("FLAMEWORK_TEST_PARALLEL");
		expect(ignored.err).not.toContain("testing.parallel");

		const keep = await runSideBySide(names, ["--keep", "--parallel", "2"]);
		expect(keep.run.code).toBe(2);
		expect(keep.run.err).toContain("--keep leaves a Studio window open");
	});
});

describe("Ctrl+C belongs to the work that is cleaning up (interrupt.ts)", () => {
	test("one project's cleanup never makes another project's waits deaf to Ctrl+C", async () => {
		const { Interruption, Interrupted } = await import("../src/interrupt.ts");
		const interruption = new Interruption();
		let releaseCleanup: () => void = () => {};
		const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
		// One piece of work is in its cleanup, waiting on something...
		const cleaning = interruption.cleanup(async () => {
			await cleanupGate;
			return await interruption.run(async () => "stopped");
		});
		// ...while another, beside it, starts a wait of its own.
		await ticks(1);
		const beside = interruption.run(() => never<string>());
		interruption.interrupt("SIGINT");
		await expect(beside).rejects.toBeInstanceOf(Interrupted);
		expect(() => interruption.check()).toThrow(Interrupted);
		// The cleanup's own waits are seen through.
		releaseCleanup();
		expect(await cleaning).toBe("stopped");
	});
});
