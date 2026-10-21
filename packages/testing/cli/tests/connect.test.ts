import { describe, expect, test } from "bun:test";
import { basename, resolve } from "node:path";

import {
	ASK_TIMEOUT_MS,
	ASK_WINDOW_LUAU,
	askWindow,
	CONNECT_POLL_MS,
	CONNECT_TIMEOUT_SECONDS,
	parseArgs,
	parseIdentity,
	UNREADABLE_ASKS,
	type WindowIdentity,
} from "../src/cli.ts";
import type { StudioClient, StudioEntry } from "../src/studio.ts";
import type { SignInReading } from "../src/studioLog.ts";
import {
	FIXTURE_CWD,
	fakeMachine,
	flatOf,
	fromFlat,
	resultJson,
	runCli,
	type FakeCall,
	type FakeMachine,
	type FakeStudio,
} from "./harness.ts";

const THIS_PROJECT = resolve(FIXTURE_CWD);
const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";
const PROJECT = JSON.stringify({ tree: { $className: "DataModel" } });
const iso = (ms: number) => new Date(ms).toISOString();

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

/** A window that registers with the proxy by itself, once the run has launched Studio: someone else's. */
interface Joining {
	entry: StudioEntry;
	/** What it answers when asked who it is; an error when a string. */
	identity?: WindowIdentity | string;
	/** Its answer's very text, or what it throws, when given; it may let fake time pass. */
	answer?: (call: FakeCall) => string;
}

/** A window the run launched, as its answer to who it is sees it. */
interface Launched {
	file: string;
	/** How long ago it was launched, by fake time, when asked. */
	sinceLaunch: number;
	/** The launch id the patch wrote into its file, if any. */
	launch: string | undefined;
}

/** One question to a window: which, when it was asked (fake time) and the timeout it was given. */
interface Ask {
	id: string;
	at: number;
	timeoutMs: number | undefined;
}

/**
 * Studio's MCP proxy on a fake machine, where a launched window may register under a name that is
 * not its place's. Each window the run launches is listed as `listAs(file, sinceLaunch)` ("Game" by
 * default) under the id `win-<file>` for as long as its process runs, answers who it is with
 * `answer` (by default its file's name and the launch id the patch wrote into that file, at once),
 * and runs the tests in a play session. `before` is listed from the start; `joining` registers once
 * the first window has been launched. A launched window registers `registerAfterMs` after its
 * launch (at once by default). `asked` records every window asked who it is, in order, and `asks`
 * when and with what timeout.
 */
function proxyOn(
	machine: FakeMachine,
	setup: {
		listAs?: (file: string, sinceLaunch: number) => string;
		before?: StudioEntry[];
		joining?: Joining[];
		answer?: (window: Launched, call: FakeCall) => WindowIdentity;
		registerAfterMs?: number;
	} = {},
) {
	const entries: Array<StudioEntry & { pid?: number; file?: string; at?: number }> = [...(setup.before ?? [])];
	const plans = new Map<string, string | undefined>();
	const launches = new Map<string, string | undefined>();
	const mode = new Map<string, string>();
	const asked: string[] = [];
	const asks: Ask[] = [];
	const runs: string[] = [];
	let launched = 0;
	const listed = (entry: (typeof entries)[number]): string =>
		entry.file !== undefined && setup.listAs !== undefined
			? setup.listAs(entry.file, machine.time.now - entry.at!)
			: entry.name;
	const fake = {
		studios: () =>
			entries
				.filter(
					(entry) => entry.pid === undefined || machine.windows.some((window) => window.pid === entry.pid),
				)
				.filter(
					(entry) => entry.at === undefined || machine.time.now - entry.at >= (setup.registerAfterMs ?? 0),
				)
				.map((entry) => ({ id: entry.id, name: listed(entry) })),
		answers: {
			get_studio_state: (args: Record<string, unknown>) =>
				mode.get(args.studio_id as string) === "Play" ? PLAYING : EDITING,
			start_stop_play: (args: Record<string, unknown>) => {
				mode.set(args.studio_id as string, args.is_start ? "Play" : "Edit");
				return args.is_start ? "Game Started" : "Game Stopped";
			},
			execute_luau: (args: Record<string, unknown>, call: FakeCall) => {
				const id = args.studio_id as string;
				if (args.code === ASK_WINDOW_LUAU) {
					asked.push(id);
					asks.push({ id, at: machine.time.now, timeoutMs: call.timeoutMs });
					expect(args.datamodel_type).toBe("Edit");
					const joining = setup.joining?.find((entry) => entry.entry.id === id);
					if (joining !== undefined) {
						if (joining.answer !== undefined) return joining.answer(call);
						if (typeof joining.identity === "string") throw new Error(`execute_luau: ${joining.identity}`);
						return JSON.stringify(joining.identity ?? { name: "Game" });
					}
					const own = entries.find((entry) => entry.id === id && entry.file !== undefined);
					if (own === undefined) throw new Error(`asked a window this test never meant to be asked: ${id}`);
					const launch = launches.get(own.file!);
					if (setup.answer !== undefined) {
						return JSON.stringify(
							setup.answer({ file: own.file!, sinceLaunch: machine.time.now - own.at!, launch }, call),
						);
					}
					return JSON.stringify({ name: own.file, ...(launch !== undefined ? { launch } : {}) });
				}
				runs.push(`${id} ${String(args.datamodel_type)}`);
				const file = entries.find((entry) => entry.id === id)?.file ?? "?";
				return JSON.stringify(
					resultJson({ realm: (args.datamodel_type as string).toLowerCase(), project: file }),
				);
			},
		},
	} satisfies FakeStudio;
	return {
		fake,
		entries,
		asked,
		asks,
		runs,
		/** Hears the patch's plan being written: the launch id it carries. */
		onWrite: (path: string, text: string) => {
			if (path.endsWith("patch-plan.json")) plans.set(path, (JSON.parse(text) as { launch?: string }).launch);
		},
		/** Hears lune run the patch: which place file the plan's launch id went into. */
		spawnCode: (command: string[]) => {
			if (command[1] === "run") launches.set(basename(command[5]!), plans.get(command[6]!.replaceAll("\\", "/")));
			return 0;
		},
		onLaunch: (command: string[]) => {
			const file = basename(command[1]!);
			launched += 1;
			// The others register first, so they come before the run's own in the list.
			if (launched === 1) for (const joining of setup.joining ?? []) entries.push(joining.entry);
			entries.push({ id: `win-${file}`, name: "Game", pid: machine.nextStudioPid, file, at: machine.time.now });
		},
	};
}

/**
 * A window still loading its place `loadMs` after its launch, as a slow start leaves it: it answers
 * `game.Name` "Game" and no launch id (in 0.3 s), then its file's name and launch id.
 */
const loadingFor =
	(loadMs: number) =>
	(window: Launched, call: FakeCall): WindowIdentity => {
		call.elapse(300);
		if (window.sinceLaunch < loadMs) return { name: "Game" };
		return { name: window.file, ...(window.launch !== undefined ? { launch: window.launch } : {}) };
	};

/**
 * A window that cannot be reached for `loadMs` after its launch, as one asked while it registers
 * says (in 4.7 s, measured 2026-10-07), then answers with its file's name and launch id.
 */
const unreachableFor =
	(loadMs: number) =>
	(window: Launched, call: FakeCall): WindowIdentity => {
		call.elapse(300);
		if (window.sinceLaunch < loadMs) {
			call.elapse(4400);
			throw new Error("execute_luau: Target is not reachable (createExecuteLuauBridge_loadCodeAsync, Edit)");
		}
		return { name: window.file, ...(window.launch !== undefined ? { launch: window.launch } : {}) };
	};

/**
 * No window is asked again sooner than a look after it was last asked, whichever project asks. It
 * measures from the start of each question; the CLI spaces them from the end of the last answer, so
 * this is the weaker bound.
 */
function expectSpacedAsks(asks: Ask[]): void {
	for (const id of new Set(asks.map((ask) => ask.id))) {
		const times = asks.filter((ask) => ask.id === id).map((ask) => ask.at);
		for (let index = 1; index < times.length; index += 1) {
			expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(CONNECT_POLL_MS);
		}
	}
}

async function runWith(
	proxy: ReturnType<typeof proxyOn>,
	machine: FakeMachine,
	argv: string[],
	names: string[],
	extra: {
		launchIds?: string[];
		env?: Record<string, string | undefined>;
		signIn?: (pid: number, since: number) => SignInReading | undefined;
	} = {},
) {
	const ids = [...(extra.launchIds ?? names.map((name) => `launch-${name}`))];
	return await runCli(argv, {
		machine,
		files: filesOf(names),
		studio: proxy.fake,
		onLaunch: proxy.onLaunch,
		onWrite: proxy.onWrite,
		spawnCode: proxy.spawnCode,
		launchId: () => ids.shift() ?? "launch-spare",
		...(extra.env !== undefined ? { env: extra.env } : {}),
		...(extra.signIn !== undefined ? { signIn: extra.signIn } : {}),
	});
}

describe("a launched window the MCP proxy lists under another name", () => {
	test("a window listed as Game is told by the launch id its place carries, and driven by its MCP id from then on", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(["deferred"]), "--keep"],
			["deferred"],
		);
		expect(run.code).toBe(0);

		// The patch wrote this launch's id into the place, which the window answered with.
		const plan = Object.entries(run.written).find(([path]) => path.endsWith("patch-plan.json"))!;
		expect(JSON.parse(plan[1]).launch).toBe("launch-deferred");
		expect(proxy.asked).toEqual(["win-place.deferred.rbxl"]);
		expect(run.out).toContain(
			'connected: place.deferred.rbxl (win-place.deferred.rbxl), which the MCP proxy lists as "Game": told by the launch id its place carries',
		);
		// Its runs go to that id, and say the place's name rather than the listed one.
		expect(proxy.runs).toEqual(["win-place.deferred.rbxl Server", "win-place.deferred.rbxl Client"]);
		expect(run.out).toContain("running the server's tests in place.deferred.rbxl...");
		expect(run.out).toContain("studio_id=win-place.deferred.rbxl pid=4001");

		// The lock's record names it by that id, and the name it is listed under.
		const owner = flatOf(machine.lock.owner!);
		expect(owner).toMatchObject({ mcpId: "win-place.deferred.rbxl", mcpName: "Game", studioPid: 4001 });

		// So the studio commands find this project's window by its id, though the proxy lists no place's name for it.
		const again = await runCli(["studio", "run", "--realm", "server"], { machine, studio: proxy.fake });
		expect(again.code).toBe(0);
		expect(proxy.runs.at(-1)).toBe("win-place.deferred.rbxl Server");
		expect(again.out).toContain("running the server's tests in place.deferred.rbxl...");
		const list = await runCli(["studio", "list"], { machine, studio: proxy.fake });
		expect(list.out).toContain("win-place.deferred.rbxl  Game  [opened by flamework-test for this project");
		// It was asked once, at the launch: the studio commands know it by its id.
		expect(proxy.asked).toEqual(["win-place.deferred.rbxl"]);
	});

	test("of two new windows nobody has claimed, each is asked once, and only the one with this launch's id is taken", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, {
			// Another Game window registers alongside, carrying some other launch's id.
			joining: [
				{
					entry: { id: "stranger", name: "Game" },
					identity: { name: "place.deferred.rbxl", launch: "not-ours" },
				},
			],
		});
		const run = await runWith(proxy, machine, ["test", "place.rbxl", ...projectFlag(["deferred"])], ["deferred"]);
		expect(run.code).toBe(0);
		expect([...proxy.asked].sort()).toEqual(["stranger", "win-place.deferred.rbxl"]);
		expect(run.out).toContain("connected: place.deferred.rbxl (win-place.deferred.rbxl)");
		expect(proxy.runs.every((call) => call.startsWith("win-place.deferred.rbxl "))).toBe(true);
	});

	test("the projects of a --parallel run ask each window once between them", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		const names = ["deferred", "streaming"];
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(names), "--parallel", "2"],
			names,
		);
		expect(run.code).toBe(0);
		expect(run.out).toContain("projects: deferred passed, streaming passed");
		expect(run.out).toContain(
			"connected: place.deferred.rbxl (win-place.deferred.rbxl), which the MCP proxy lists as",
		);
		expect(run.out).toContain(
			"connected: place.streaming.rbxl (win-place.streaming.rbxl), which the MCP proxy lists as",
		);
		expect([...proxy.asked].sort()).toEqual(["win-place.deferred.rbxl", "win-place.streaming.rbxl"]);
	});

	test("the projects of a --parallel run whose windows register late tell each other's apart by launch id", async () => {
		// Each Studio signs in at once, which lets the next launch go, and its window registers
		// 20 s after its launch, by when the other project has launched its own: each project then
		// sees its sibling's window as new too, and only the launch id tells them apart.
		const machine = fakeMachine();
		const proxy = proxyOn(machine, { registerAfterMs: 20_000 });
		const names = ["deferred", "streaming"];
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(names), "--parallel", "2"],
			names,
			{ signIn: () => ({ state: "signed-in", log: "studio.log" }) },
		);
		expect(run.code).toBe(0);
		expect(run.out).toContain("projects: deferred passed, streaming passed");
		expect(run.out).toContain("connected: place.deferred.rbxl (win-place.deferred.rbxl)");
		expect(run.out).toContain("connected: place.streaming.rbxl (win-place.streaming.rbxl)");
		expect([...proxy.asked].sort()).toEqual(["win-place.deferred.rbxl", "win-place.streaming.rbxl"]);
		expect(proxy.runs.filter((call) => call.startsWith("win-place.deferred.rbxl ")).length).toBeGreaterThan(0);
		expect(proxy.runs.filter((call) => call.startsWith("win-place.streaming.rbxl ")).length).toBeGreaterThan(0);
		// Both registered at once, so each project's look found both new.
		expect(new Set(proxy.asks.map((ask) => ask.at)).size).toBe(1);
		expectSpacedAsks(proxy.asks);
	});

	test("a window listed before the launch is never asked, whatever it is listed as", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, {
			before: [
				{ id: "earlier-game", name: "Game" },
				{ id: "earlier-loading", name: "" },
			],
		});
		const run = await runWith(proxy, machine, ["test", "place.rbxl", ...projectFlag(["deferred"])], ["deferred"]);
		expect(run.code).toBe(0);
		expect(proxy.asked).toEqual(["win-place.deferred.rbxl"]);

		// Nor when the run's own window never comes: it waits out its connect timeout without asking them.
		const silentMachine = fakeMachine();
		const silent = proxyOn(silentMachine, { before: [{ id: "earlier-game", name: "Game" }] });
		silent.fake.studios = () => [{ id: "earlier-game", name: "Game" }];
		const none = await runWith(
			silent,
			silentMachine,
			["test", "place.rbxl", ...projectFlag(["deferred"])],
			["deferred"],
		);
		expect(none.code).toBe(1);
		expect(silent.asked).toEqual([]);
		expect(none.err).toContain("no other window registered with it meanwhile");
	});

	test("a window a flamework-test project has claimed is never asked", async () => {
		const machine = fakeMachine();
		// Closed for another project lately, by the lock's notes; still listed, as Game.
		machine.lock.closed.push({
			owner: fromFlat({
				token: "other-token",
				cliPid: 8001,
				project: "D:\\other",
				command: "test --keep",
				place: "D:\\other\\test.rbxl",
				placeFile: "D:\\other\\test.rbxl",
				studioPid: 5001,
				mcpId: "other-project-window",
				since: iso(machine.time.now - 60_000),
				lastActivity: iso(machine.time.now - 60_000),
				expires: iso(machine.time.now + 60_000),
				holdMinutes: 15,
			}),
			windows: [
				{
					place: "D:\\other\\test.rbxl",
					placeFile: "D:\\other\\test.rbxl",
					studioPid: 5001,
					mcpId: "other-project-window",
				},
			],
			closedAt: iso(machine.time.now),
			reason: "expired",
			idleMinutes: 16,
			by: { project: THIS_PROJECT, command: "test" },
		});
		const proxy = proxyOn(machine, {
			listAs: (file) => (file === "place.deferred.rbxl" ? "Game" : file),
			joining: [{ entry: { id: "other-project-window", name: "Game" } }],
		});
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(["deferred"]), "--connect-timeout", "30"],
			["deferred"],
		);
		expect(run.code).toBe(0);
		expect(proxy.asked).toEqual(["win-place.deferred.rbxl"]);

		// And a window the Studio lock's record names, listed as Game too: not asked either.
		const recorded = fakeMachine();
		const named = proxyOn(recorded, { joining: [{ entry: { id: "recorded-window", name: "Game" } }] });
		const list = named.fake.studios;
		named.fake.studios = () => {
			const windows = recorded.lock.owner?.windows;
			if (windows !== undefined && !windows.some((window) => window.mcpId === "recorded-window")) {
				windows.push({ place: "D:\\other\\place.other.rbxl", studioPid: 5002, mcpId: "recorded-window" });
			}
			return list();
		};
		const inRecord = await runWith(
			named,
			recorded,
			["test", "place.rbxl", ...projectFlag(["deferred"])],
			["deferred"],
		);
		expect(inRecord.code).toBe(0);
		expect(named.asked).toEqual(["win-place.deferred.rbxl"]);
	});

	test("the connect wait has a limit of its own, and its error names every new window it saw", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, {
			// The run's own window never registers.
			joining: [
				{
					entry: { id: "someone-else", name: "Game" },
					identity: { name: "place.deferred.rbxl", launch: "not-ours" },
				},
				{ entry: { id: "stuck", name: "" }, identity: { name: "Game" } },
				{ entry: { id: "broken", name: "Game" }, identity: "the plugin is not answering" },
				{ entry: { id: "odd", name: "Game" }, answer: () => "table: 0x01" },
				{ entry: { id: "users", name: "Dive In (placeId: 123)" } },
			],
		});
		const fake = proxy.fake;
		const list = fake.studios;
		fake.studios = () => list().filter((entry) => entry.id !== "win-place.deferred.rbxl");
		const startedAt = machine.time.now;
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(["deferred"]), "--run-timeout", "900s", "--connect-timeout", "60"],
			["deferred"],
		);
		expect(run.code).toBe(1);
		// The run's --run-timeout is its realms', not the connect wait's.
		expect(machine.time.now - startedAt).toBeLessThan(120_000);
		const message = run.err.split("\n").find((line) => line.startsWith("error: Studio started"))!;
		expect(message).toContain(
			"place.deferred.rbxl never showed up on the MCP proxy within 1 min (--connect-timeout)",
		);
		expect(message).toContain(
			`someone-else "Game": asked: game.Name "place.deferred.rbxl", launch id not-ours; not this launch's`,
		);
		expect(message).toContain(
			`stuck "": asked 6 times, and none of its answers said which place it has open (the last: its place had not loaded yet (game.Name "Game"))`,
		);
		expect(message).toContain(
			`broken "Game": asked 12 times, and none of its answers said which place it has open (the last: the plugin is not answering)`,
		);
		expect(message).toContain(
			`odd "Game": asked 3 times, and its answers could not be read (the last: it answered "table: 0x01"), so it was asked no more`,
		);
		expect(message).toContain(
			`users "Dive In (placeId: 123)": listed under another place's name, so not this launch's; not asked`,
		);
		// An answer that tells is not asked for again. One that says nothing yet is, a look (5 s) apart,
		// until the wait runs out: every look of the 60 s, and from 30 s on for a window listed with no
		// name. One that cannot be read, three times. The user's window, listed under its place's name,
		// never.
		expect(proxy.asked.filter((id) => id === "someone-else")).toHaveLength(1);
		expect(proxy.asked.filter((id) => id === "stuck")).toHaveLength(6);
		expect(proxy.asked.filter((id) => id === "broken")).toHaveLength(12);
		expect(proxy.asked.filter((id) => id === "odd")).toHaveLength(UNREADABLE_ASKS);
		expect(proxy.asked).not.toContain("users");
		expectSpacedAsks(proxy.asks);
		// The window it launched is closed again, as ever.
		expect(run.err).toContain("the window this run opened is closed again");
		expect(run.windows).toHaveLength(0);

		// Without the flag, FLAMEWORK_TEST_CONNECT_TIMEOUT, else 180 seconds.
		for (const [env, seconds] of [
			[{ FLAMEWORK_TEST_CONNECT_TIMEOUT: "20" }, 20],
			[{}, CONNECT_TIMEOUT_SECONDS],
		] as const) {
			const quiet = fakeMachine();
			const nothing = proxyOn(quiet);
			nothing.fake.studios = () => [];
			const from = quiet.time.now;
			const waited = await runWith(
				nothing,
				quiet,
				["test", "place.rbxl", ...projectFlag(["deferred"]), "--run-timeout", "900s"],
				["deferred"],
				{ env },
			);
			expect(waited.code).toBe(1);
			// The error names what set the wait.
			expect(waited.err).toContain(
				seconds === 20
					? "never showed up on the MCP proxy within 20s (FLAMEWORK_TEST_CONNECT_TIMEOUT)"
					: "never showed up on the MCP proxy within 3 min (--connect-timeout)",
			);
			expect(quiet.time.now - from).toBeLessThan((seconds + 30) * 1000);
		}
	});

	test("a window listed under its place's name is taken by that name, as ever, and never asked", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, { listAs: (file) => file });
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(["deferred"]), "--keep"],
			["deferred"],
		);
		expect(run.code).toBe(0);
		expect(proxy.asked).toEqual([]);
		expect(run.out).toContain("connected: place.deferred.rbxl (win-place.deferred.rbxl)\n");
		expect(run.out).not.toContain("which the MCP proxy lists as");
		const owner = flatOf(machine.lock.owner!);
		expect(owner.mcpId).toBe("win-place.deferred.rbxl");
		expect(owner.mcpName).toBeUndefined();
	});

	test("a plain run's place carries no launch id: a Game window is told by its game.Name, unless another window shows that file", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		const run = await runWith(proxy, machine, ["test", "place.rbxl"], []);
		expect(run.code).toBe(0);
		expect(run.spawned).toHaveLength(0);
		expect(run.out).toContain(
			'connected: place.rbxl (win-place.rbxl), which the MCP proxy lists as "Game": told by its game.Name, as this run made no launch id for its place',
		);

		// Another Studio shows a file of that name, and could be that window: not taken.
		const crowded = fakeMachine({
			windows: [{ pid: 3100, title: "D:\\so2\\place.rbxl - Roblox Studio", startedWith: "D:\\so2\\place.rbxl" }],
		});
		const other = proxyOn(crowded);
		const refused = await runWith(other, crowded, ["test", "place.rbxl", "--connect-timeout", "30"], []);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			"cannot tell which place.rbxl window on the MCP proxy is the one this run opened: another Studio window showing a file of that name has not registered with it (PID 3100",
		);
	});

	test("by game.Name, another Studio showing that file is accounted for by its window listed under that name before the launch, as by the listed name", async () => {
		// The same other Studio as above, listed under that name before the launch, accounts for it,
		// as it does when the run's own window is listed by name: the Game window is taken.
		const accounted = fakeMachine({
			windows: [{ pid: 3100, title: "D:\\so2\\place.rbxl - Roblox Studio", startedWith: "D:\\so2\\place.rbxl" }],
		});
		const listedBefore = proxyOn(accounted, { before: [{ id: "so2-window", name: "place.rbxl" }] });
		const taken = await runWith(listedBefore, accounted, ["test", "place.rbxl", "--connect-timeout", "30"], []);
		expect(taken.code).toBe(0);
		expect(taken.out).toContain(
			'connected: place.rbxl (win-place.rbxl), which the MCP proxy lists as "Game": told by its game.Name',
		);
		expect(listedBefore.asked).toEqual(["win-place.rbxl"]);
		expect(listedBefore.runs.every((call) => call.startsWith("win-place.rbxl "))).toBe(true);
	});

	test("studio open tells a window the same way", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		const run = await runCli(["studio", "open", "place.rbxl", "--json"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(JSON.parse(run.out)).toMatchObject({
			studio_id: "win-place.rbxl",
			name: "place.rbxl",
			listedAs: "Game",
		});
		expect(flatOf(machine.lock.owner!)).toMatchObject({ mcpId: "win-place.rbxl", mcpName: "Game" });
	});

	test("studio open of a file an earlier test patched goes by game.Name, whatever launch id the file carries", async () => {
		// That file carries the earlier launch's id; studio open made none, so the id tells nothing.
		const patched = fakeMachine();
		const earlier = proxyOn(patched, {
			answer: (window) => ({ name: window.file, launch: "an-earlier-test-launch" }),
		});
		const opened = await runCli(["studio", "open", "place.deferred.rbxl", "--json"], {
			machine: patched,
			files: { "place.deferred.rbxl": "made" },
			studio: earlier.fake,
			onLaunch: earlier.onLaunch,
		});
		expect(opened.code).toBe(0);
		expect(JSON.parse(opened.out)).toMatchObject({
			studio_id: "win-place.deferred.rbxl",
			name: "place.deferred.rbxl",
			listedAs: "Game",
		});
		expect(earlier.asked).toEqual(["win-place.deferred.rbxl"]);
	});

	test("studio open of a patched file whose window answers Game first, with the file's launch id, waits for its game.Name", async () => {
		// Its place still loading, the window says Game, yet its Workspace already carries the
		// earlier launch's id: that says nothing yet, rather than making it another run's window
		// for good.
		const patched = fakeMachine();
		const loading = proxyOn(patched, {
			answer: (window, call) => {
				call.elapse(300);
				return { name: window.sinceLaunch < 8000 ? "Game" : window.file, launch: "an-earlier-test-launch" };
			},
		});
		const opened = await runCli(["studio", "open", "place.deferred.rbxl", "--json"], {
			machine: patched,
			files: { "place.deferred.rbxl": "made" },
			studio: loading.fake,
			onLaunch: loading.onLaunch,
		});
		expect(opened.code).toBe(0);
		expect(JSON.parse(opened.out)).toMatchObject({ studio_id: "win-place.deferred.rbxl", listedAs: "Game" });
		expect(loading.asked.length).toBeGreaterThan(1);
		expect(new Set(loading.asked)).toEqual(new Set(["win-place.deferred.rbxl"]));
	});
});

describe("a launched window that is slow to say who it is", () => {
	for (const loadMs of [30_000, 60_000]) {
		for (const names of [["deferred"], ["deferred", "streaming"]]) {
			const how = names.length === 1 ? "alone" : "--parallel 2";
			test(`a Game window whose place loads ${loadMs / 1000}s after its launch is asked until it tells (${how})`, async () => {
				const machine = fakeMachine();
				const proxy = proxyOn(machine, { answer: loadingFor(loadMs) });
				const run = await runWith(
					proxy,
					machine,
					["test", "place.rbxl", ...projectFlag(names), ...(names.length > 1 ? ["--parallel", "2"] : [])],
					names,
				);
				expect(run.code).toBe(0);
				for (const name of names) {
					expect(run.out).toContain(
						`connected: place.${name}.rbxl (win-place.${name}.rbxl), which the MCP proxy lists as "Game": told by the launch id its place carries`,
					);
				}
				// Asked a look apart at most, whichever project asked, and no more once it told.
				expectSpacedAsks(proxy.asks);
				for (const name of names) {
					const own = proxy.asks.filter((ask) => ask.id === `win-place.${name}.rbxl`);
					expect(own.length).toBeGreaterThan(loadMs / CONNECT_POLL_MS / 2);
					expect(own.length).toBeLessThanOrEqual(loadMs / CONNECT_POLL_MS + 1);
				}
			});
		}
	}

	for (const names of [["deferred"], ["deferred", "streaming"]]) {
		const how = names.length === 1 ? "alone" : "--parallel 2";
		test(`a window listed with no name for 80s, then as Game, unreachable until then, is taken (${how})`, async () => {
			const machine = fakeMachine();
			const proxy = proxyOn(machine, {
				listAs: (_file, sinceLaunch) => (sinceLaunch < 80_000 ? "" : "Game"),
				answer: unreachableFor(80_000),
			});
			const run = await runWith(
				proxy,
				machine,
				["test", "place.rbxl", ...projectFlag(names), ...(names.length > 1 ? ["--parallel", "2"] : [])],
				names,
			);
			expect(run.code).toBe(0);
			for (const name of names) {
				expect(run.out).toContain(
					`connected: place.${name}.rbxl (win-place.${name}.rbxl), which the MCP proxy lists as`,
				);
			}
			expectSpacedAsks(proxy.asks);
		});
	}

	test("a window that names this file before its launch id can be read is asked again, not taken for another's", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, {
			// The attribute is not readable yet for 20 s after the launch.
			answer: (window, call) => {
				call.elapse(300);
				return window.sinceLaunch < 20_000
					? { name: window.file }
					: { name: window.file, ...(window.launch !== undefined ? { launch: window.launch } : {}) };
			},
		});
		const run = await runWith(proxy, machine, ["test", "place.rbxl", ...projectFlag(["deferred"])], ["deferred"]);
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			'connected: place.deferred.rbxl (win-place.deferred.rbxl), which the MCP proxy lists as "Game": told by the launch id its place carries',
		);
		expect(proxy.asked.length).toBeGreaterThan(1);
		expectSpacedAsks(proxy.asks);
	});

	test("a question another project has in flight is not waited for, and its answer is shared once it comes", async () => {
		// One invocation's view, as two projects of a --parallel run share it.
		let now = Date.parse("2026-09-11T12:00:00.000Z");
		const io = { memo: {}, now: () => new Date(now) } as unknown as Parameters<typeof askWindow>[2];
		let answer: (text: string) => void = () => {};
		const timeouts: Array<number | undefined> = [];
		const client = {
			call: (_name: string, _args: Record<string, unknown>, timeoutMs?: number) => {
				timeouts.push(timeoutMs);
				return new Promise<string>((resolve) => (answer = resolve));
			},
		} as unknown as StudioClient;
		const deadline = now + 60_000;
		const always = () => true;

		// The first project's question does not come back yet.
		const first = askWindow(client, "slow", io, deadline, always);
		// The second project does not wait for it, and asks nothing itself.
		const second = await askWindow(client, "slow", io, deadline - 50_000, always);
		expect(second.attempts).toBe(1);
		expect(second.answer).toBeUndefined();
		expect(timeouts).toEqual([ASK_TIMEOUT_MS]);

		// Once it comes, both have it, and nobody asks again for an answer that tells.
		answer(JSON.stringify({ name: "place.deferred.rbxl", launch: "a" }));
		expect((await first).answer).toEqual({ name: "place.deferred.rbxl", launch: "a" });
		now += 60_000;
		const later = await askWindow(client, "slow", io, now + 60_000, always);
		expect(later.attempts).toBe(1);
		expect(timeouts).toHaveLength(1);

		// One whose answer says nothing yet is asked again a look after its last answer, not sooner,
		// and given no more than what is left of the wait.
		const unsettled = () => false;
		const again = askWindow(client, "slow", io, now + 3_000, unsettled);
		expect(timeouts).toEqual([ASK_TIMEOUT_MS, 3_000]);
		answer(JSON.stringify({ name: "Game" }));
		await again;
		now += CONNECT_POLL_MS - 1;
		await askWindow(client, "slow", io, now + 60_000, unsettled);
		expect(timeouts).toHaveLength(2);
	});

	test("each question is given no more than what is left of the wait, so the wait ends on time", async () => {
		const machine = fakeMachine();
		// Two windows that never answer, each question running out its timeout; the run's own never registers.
		const never = (call: FakeCall): string => {
			call.elapse(call.timeoutMs!);
			throw new Error(`tools/call timed out after ${call.timeoutMs}ms`);
		};
		const proxy = proxyOn(machine, {
			joining: [
				{ entry: { id: "silent-1", name: "Game" }, answer: never },
				{ entry: { id: "silent-2", name: "Game" }, answer: never },
			],
		});
		const list = proxy.fake.studios;
		proxy.fake.studios = () => list().filter((entry) => entry.id !== "win-place.deferred.rbxl");
		const run = await runWith(
			proxy,
			machine,
			["test", "place.rbxl", ...projectFlag(["deferred"]), "--connect-timeout", "30"],
			["deferred"],
		);
		expect(run.code).toBe(1);
		expect(run.err).toContain("never showed up on the MCP proxy within 30s (--connect-timeout)");
		const launchedAt = proxy.entries.find((entry) => entry.id === "win-place.deferred.rbxl")!.at!;
		const deadline = launchedAt + 30_000;
		expect(proxy.asks.length).toBeGreaterThan(0);
		for (const ask of proxy.asks) {
			expect(ask.timeoutMs).toBeLessThanOrEqual(ASK_TIMEOUT_MS);
			expect(ask.at + ask.timeoutMs!).toBeLessThanOrEqual(deadline);
		}
	});
});

describe("--connect-timeout", () => {
	test("is a flag of test and studio open, refused with --cloud and when it is not a number", async () => {
		expect(parseArgs(["test", "p.rbxl", "--connect-timeout", "300"]).flags["connect-timeout"]).toBe("300");
		expect(parseArgs(["studio", "open", "--connect-timeout", "300"]).flags["connect-timeout"]).toBe("300");
		expect(() => parseArgs(["studio", "run", "--connect-timeout", "300"])).toThrow(
			'--connect-timeout is not a flag of "studio run"',
		);

		const cloud = await runCli(["test", "place.rbxl", "--cloud", "--connect-timeout", "30"], {
			files: { "place.rbxl": "built" },
		});
		expect(cloud.code).toBe(2);
		expect(cloud.err).toContain("--connect-timeout is for Studio runs");

		const word = await runCli(["test", "place.rbxl", "--connect-timeout", "soon"], {
			files: { "place.rbxl": "built" },
		});
		expect(word.code).toBe(2);
		expect(word.err).toContain('--connect-timeout must be a number of seconds, 1 or more, got "soon"');
		expect(word.launched).toHaveLength(0);
	});

	test("studio open's wait is --connect-timeout, and the error names what set it; its old --timeout is refused", async () => {
		const old = await runCli(["studio", "open", "place.rbxl", "--timeout", "30s"], {
			files: { "place.rbxl": "built" },
		});
		expect(old.code).toBe(2);
		expect(old.err).toContain(
			"error: --timeout is now --connect-timeout <seconds> (how long the window is waited for)",
		);
		expect(old.launched).toHaveLength(0);

		for (const [flags, env, said] of [
			[["--connect-timeout", "20"], {}, "within 20s (--connect-timeout)"],
			[[], { FLAMEWORK_TEST_CONNECT_TIMEOUT: "25" }, "within 25s (FLAMEWORK_TEST_CONNECT_TIMEOUT)"],
		] as const) {
			const machine = fakeMachine();
			const proxy = proxyOn(machine);
			proxy.fake.studios = () => [];
			const from = machine.time.now;
			const run = await runCli(["studio", "open", "place.rbxl", ...flags], {
				machine,
				env,
				files: { "place.rbxl": "built" },
				studio: proxy.fake,
				onLaunch: proxy.onLaunch,
			});
			expect(run.code).toBe(1);
			expect(run.err).toContain(`place.rbxl never showed up on the MCP proxy ${said}`);
			expect(machine.time.now - from).toBeLessThan(60_000);
		}
	});
});

describe("a window's answer", () => {
	test("is read from the proxy's text, quoted or not; anything else is none", () => {
		expect(parseIdentity('{"name":"place.rbxl","launch":"abc"}')).toEqual({ name: "place.rbxl", launch: "abc" });
		expect(parseIdentity(JSON.stringify('{"name":"place.rbxl"}'))).toEqual({ name: "place.rbxl" });
		expect(parseIdentity('{"name":"place.rbxl","launch":12}')).toEqual({ name: "place.rbxl" });
		expect(parseIdentity("table: 0x01")).toBeUndefined();
		expect(parseIdentity('{"launch":"abc"}')).toBeUndefined();
	});

	test("the question reads game.Name and the launch id, and nothing else", () => {
		expect(ASK_WINDOW_LUAU).toBe(
			'return game:GetService("HttpService"):JSONEncode({ name = game.Name, launch = workspace:GetAttribute("FlameworkTestLaunch") })',
		);
	});
});
