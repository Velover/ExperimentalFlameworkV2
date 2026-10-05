import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { judgeLock, leaseFrom, type LockOwner, type LockView, type ProcessInfo } from "../src/lock.ts";
import type { StudioEntry } from "../src/studio.ts";
import {
	FIXTURE_CWD,
	PLACE,
	TESTING_STUDIO,
	fakeCtrlC,
	fakeMachine,
	resultJson,
	runCli,
	type FakeMachine,
	type FakeStudio,
} from "./harness.ts";

const THIS_PROJECT = resolve(FIXTURE_CWD);
const THIS_FILE = join(THIS_PROJECT, "place.rbxl");
const OTHER_PROJECT = "D:\\other";
const OTHER_FILE = "D:\\other\\test.rbxl";
const MINUTE = 60_000;
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";
const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A proxy on the machine: it lists every window a run launches (`own-1`, `own-2`, ...; a file by
 * its name, the testing place with its id) for as long as that window is open, and whatever else
 * it is given.
 */
function proxyOn(machine: FakeMachine, answers: FakeStudio["answers"] = {}, already: StudioEntry[] = []) {
	const entries: Array<StudioEntry & { pid?: number }> = [...already];
	let launches = 0;
	return {
		entries,
		fake: {
			studios: () =>
				entries
					.filter(
						(entry) =>
							entry.pid === undefined || machine.windows.some((window) => window.pid === entry.pid),
					)
					.map(({ id, name }) => ({ id, name })),
			answers: { get_studio_state: EDITING, execute_luau: "1", ...answers },
		} satisfies FakeStudio,
		onLaunch: (command: string[]) => {
			launches += 1;
			const file = command.length === 2 ? command[1]! : undefined;
			entries.push({
				id: `own-${launches}`,
				name: file !== undefined ? basename(file) : `TestingExperience (placeId: ${PLACE})`,
				pid: machine.nextStudioPid,
			});
		},
	};
}

/**
 * Another project's window holding the lock: `studio open` of its own file, launched before and
 * left open, used `idleMs` ago, with a 15-minute hold. Its window runs as Studio PID 5001.
 */
function otherProjectsWindow(
	machine: FakeMachine,
	options: { idleMs?: number; window?: boolean; overrides?: Partial<LockOwner> } = {},
): LockOwner {
	const now = machine.time.now;
	const last = now - (options.idleMs ?? MINUTE);
	const startedAt = last - MINUTE;
	if (options.window !== false) {
		machine.windows.push({ pid: 5001, title: `${OTHER_FILE} - Roblox Studio`, startedWith: OTHER_FILE, startedAt });
	}
	const owner: LockOwner = {
		version: 1,
		token: "other-token",
		cliPid: 8001,
		cliName: "bun",
		cliStartedAt: iso(startedAt),
		studioPid: 5001,
		studioStartedAt: iso(startedAt),
		mcpId: "studio-other",
		project: OTHER_PROJECT,
		command: "studio open",
		place: OTHER_FILE,
		placeFile: OTHER_FILE,
		since: iso(startedAt),
		lastActivity: iso(last),
		expires: iso(last + 15 * MINUTE),
		holdMinutes: 15,
		kept: true,
		...options.overrides,
	};
	machine.lock.owner = owner;
	return owner;
}

/** `studio open place.rbxl` in this project. */
async function openHere(machine: FakeMachine, proxy: ReturnType<typeof proxyOn>, argv: string[] = []) {
	return await runCli(["studio", "open", "place.rbxl", ...argv], {
		machine,
		files: { "place.rbxl": "built" },
		studio: proxy.fake,
		onLaunch: proxy.onLaunch,
	});
}

describe("taking the Studio lock", () => {
	test("studio open takes it for this project and leaves it to the window, which holds it with its MCP id", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		const run = await openHere(machine, proxy);
		expect(run.code).toBe(0);
		expect(run.out).toContain("connected: place.rbxl (own-1)");
		// A line of its own, made to be parsed.
		expect(run.out.split("\n")).toContain("studio_id=own-1 pid=4001");
		expect(run.out).toContain(
			"it holds the Studio lock until `flamework-test studio close`, or until it has sat unused for 15 min",
		);
		const owner = machine.lock.owner!;
		expect(owner).toMatchObject({
			project: THIS_PROJECT,
			command: "studio open",
			place: THIS_FILE,
			placeFile: THIS_FILE,
			studioPid: 4001,
			mcpId: "own-1",
			kept: true,
			holdMinutes: 15,
			cliPid: run.cliPid,
		});
		expect(Date.parse(owner.expires) - Date.parse(owner.lastActivity)).toBe(15 * MINUTE);
		expect(owner.studioStartedAt).toBe(iso(machine.windows[0]!.startedAt!));

		// --json: the window as JSON alone on stdout, the progress on stderr.
		const other = fakeMachine();
		const json = await openHere(other, proxyOn(other), ["--json", "--hold", "30"]);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)).toMatchObject({
			studio_id: "own-1",
			pid: 4001,
			name: "place.rbxl",
			place: THIS_FILE,
			project: THIS_PROJECT,
			holdMinutes: 30,
		});
		expect(json.err).toContain("opening place.rbxl in Studio");
		expect(other.lock.owner!.holdMinutes).toBe(30);
	});

	test("a command that opens a window waits while another project holds it, saying who once and then every minute, and gives up past its timeout", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine);
		const run = await openHere(machine, proxyOn(machine), ["--lock-timeout", "130"]);

		expect(run.code).toBe(1);
		expect(run.launched).toHaveLength(0);
		expect(run.proxies.connected).toBe(0);
		const holder =
			"flamework-test for D:\\other (studio open on D:\\other\\test.rbxl, Studio PID 5001, MCP id studio-other), since";
		expect(run.out.match(/^waiting for the Studio lock, held by /gm)).toHaveLength(1);
		expect(run.out).toContain(holder);
		expect(run.out).toContain("its 15-minute hold runs out in 14 min");
		expect(run.out).toContain("Waiting up to 2 min (--lock-timeout)");
		expect(run.out.match(/^still waiting for the Studio lock \(\d+ min of 2 min\)/gm)).toHaveLength(2);
		expect(run.err).toContain(`error: the Studio lock is still held after waiting 2 min: ${holder}`);
		expect(run.err).toContain(
			"it is freed when that window closes: `flamework-test studio close` run in D:\\other",
		);
		expect(run.err).toContain("Never close a window you did not open");
		// Nothing of the holder's was touched.
		expect(machine.lock.owner!.token).toBe("other-token");
		expect(run.closeTargets).toEqual([]);
		expect(machine.windows.map((window) => window.pid)).toEqual([5001]);
	});

	test("a holder that lets go during the wait is followed at once, and a 0 timeout does not wait", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine);
		const take = machine.lock.take;
		let tries = 0;
		machine.lock.take = async (owner) => {
			tries += 1;
			// The other project closes its window with `studio close`.
			if (tries === 3) {
				machine.lock.owner = undefined;
				machine.windows.splice(0, machine.windows.length);
			}
			return await take(owner);
		};
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(tries).toBe(3);
		expect(run.out.match(/waiting for the Studio lock/g)).toHaveLength(1);
		expect(run.out).not.toContain("took over");
		expect(machine.lock.owner!.project).toBe(THIS_PROJECT);

		for (const refused of [
			await openHere(fakeWith(otherProjectsWindow), proxyOn(fakeMachine()), ["--lock-timeout", "0"]),
			await runCli(["studio", "open", "place.rbxl"], {
				machine: fakeWith(otherProjectsWindow),
				files: { "place.rbxl": "built" },
				env: { FLAMEWORK_TEST_LOCK_TIMEOUT: "0" },
			}),
			await runCli(["studio", "open", "place.rbxl"], {
				machine: fakeWith(otherProjectsWindow),
				files: { "place.rbxl": "built" },
				settings: { lockTimeout: 0 },
			}),
		]) {
			expect(refused.code).toBe(1);
			expect(refused.err).toContain("the Studio lock is still held after waiting 0s");
			expect(refused.launched).toHaveLength(0);
		}
	});

	test("Ctrl+C during the wait exits 130, holding nothing", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine);
		const ctrlC = fakeCtrlC();
		const take = machine.lock.take;
		let tries = 0;
		machine.lock.take = async (owner) => {
			tries += 1;
			if (tries === 2) ctrlC.press();
			return await take(owner);
		};
		const run = await runCli(["test", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			ctrlC,
		});
		expect(run.code).toBe(130);
		expect(run.launched).toHaveLength(0);
		expect(run.err).toContain("interrupted by Ctrl+C: nothing needed cleaning up");
		expect(machine.lock.owner!.token).toBe("other-token");
	});

	test("a window closed by hand frees the lock at the next look, with no command needed", async () => {
		// Closed before the command looked.
		const machine = fakeMachine();
		otherProjectsWindow(machine, { window: false });
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			"took over the Studio lock: the window flamework-test opened for D:\\other (D:\\other\\test.rbxl, Studio PID 5001) has closed",
		);
		expect(machine.lock.owner!.project).toBe(THIS_PROJECT);

		// Closed while the command waits: seen at the next look at the processes, within ten seconds.
		const waiting = fakeMachine();
		otherProjectsWindow(waiting);
		const take = waiting.lock.take;
		let tries = 0;
		waiting.lock.take = async (owner) => {
			tries += 1;
			if (tries === 2) waiting.windows.splice(0, waiting.windows.length);
			return await take(owner);
		};
		const late = await openHere(waiting, proxyOn(waiting));
		expect(late.code).toBe(0);
		expect(late.out).toContain("waiting for the Studio lock");
		expect(late.out).toContain("took over the Studio lock: the window flamework-test opened for D:\\other");
		expect(tries).toBeLessThanOrEqual(8);
	});

	test("a PID that is another process now is taken over, and that process is never touched", async () => {
		for (const now of [
			{ processName: "notepad", startedAt: undefined, says: "is now another process (notepad)" },
			// The user's own Studio, given the PID later: started well after the one launched.
			{ processName: "RobloxStudioBeta", startedAt: "later", says: "is now another process (RobloxStudioBeta)" },
		]) {
			const machine = fakeMachine();
			otherProjectsWindow(machine, { window: false });
			machine.windows.push({
				pid: 5001,
				title: "C:\\Users\\me\\mine.rbxl - Roblox Studio",
				processName: now.processName,
				...(now.startedAt !== undefined ? { startedAt: machine.time.now } : {}),
			});
			const run = await openHere(machine, proxyOn(machine));
			expect(run.code).toBe(0);
			expect(run.out).toContain(
				`took over the Studio lock: the window flamework-test opened for D:\\other has closed: its Studio PID 5001 ${now.says}`,
			);
			expect(run.closeTargets.filter((target) => target.includes("5001"))).toEqual([]);
			expect(machine.windows.map((window) => window.pid)).toContain(5001);
		}
	});

	test("a command that ended before launching Studio, and a record that cannot be read, are taken over", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine, {
			window: false,
			overrides: { studioPid: undefined, mcpId: undefined, kept: undefined },
		});
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			"took over the Studio lock: the flamework-test run that took it for D:\\other (PID 8001) has ended, with no window of its open",
		);

		const half = fakeMachine();
		half.lock.unreadable = { since: half.time.now - MINUTE };
		const left = await openHere(half, proxyOn(half));
		expect(left.code).toBe(0);
		expect(left.out).toContain(
			"took over the Studio lock: its record had been unreadable for 1 min: a command stopped while taking it",
		);

		const fresh = fakeMachine();
		fresh.lock.unreadable = { since: fresh.time.now };
		const taking = await openHere(fresh, proxyOn(fresh), ["--lock-timeout", "0"]);
		expect(taking.code).toBe(1);
		expect(taking.err).toContain("the Studio lock is still being taken after waiting 0s");
	});

	test("its settings are refused when misspelt, and --hold and --keep fit only where a window is left open", async () => {
		const bad = await runCli(["studio", "open", "place.rbxl", "--lock-timeout", "soon"], {
			files: { "place.rbxl": "x" },
		});
		expect(bad.code).toBe(2);
		expect(bad.err).toContain('--lock-timeout must be a number of seconds, 0 or more, got "soon"');
		const badHold = await runCli(["studio", "open", "place.rbxl"], {
			files: { "place.rbxl": "x" },
			env: { FLAMEWORK_TEST_LOCK_HOLD: "0" },
		});
		expect(badHold.code).toBe(2);
		expect(badHold.err).toContain('FLAMEWORK_TEST_LOCK_HOLD must be a number of minutes, 1 or more, got "0"');
		// Under a minute, a lease could lapse between two renewals of a window in use.
		const short = await runCli(["studio", "open", "place.rbxl", "--hold", "0.5"], { files: { "place.rbxl": "x" } });
		expect(short.code).toBe(2);
		expect(short.err).toContain('--hold must be a number of minutes, 1 or more, got "0.5"');
		const configured = await runCli(["studio", "open", "place.rbxl"], {
			files: { "place.rbxl": "x" },
			settings: { lockHold: 0.25 },
		});
		expect(configured.code).toBe(2);
		expect(configured.err).toContain('testing.lockHold must be a number of minutes, 1 or more, got "0.25"');

		const hold = await runCli(["test", "place.rbxl", "--hold", "60"], { files: { "place.rbxl": "x" } });
		expect(hold.code).toBe(2);
		expect(hold.err).toContain("--hold is for a window left open");
		const cloud = await runCli(["test", "place.rbxl", "--cloud", "--lock-timeout", "5"], {
			files: { "place.rbxl": "x" },
		});
		expect(cloud.code).toBe(2);
		expect(cloud.err).toContain("--lock-timeout is for Studio runs: a cloud run opens no Studio window");
		const projects = await runCli(["test", "place.rbxl", "--keep", "--project", "a.project.json,b.project.json"], {
			files: { "place.rbxl": "x" },
		});
		expect(projects.code).toBe(2);
		expect(projects.err).toContain(
			"--keep leaves a Studio window open, and flamework-test keeps one window open at a time",
		);
		expect(projects.launched).toHaveLength(0);
	});
});

/** A fresh machine with `setUp` applied to it. */
function fakeWith(setUp: (machine: FakeMachine) => unknown): FakeMachine {
	const machine = fakeMachine();
	setUp(machine);
	return machine;
}

describe("the lease", () => {
	test("using this project's window renews it; once it runs out, the next project closes the window, and the owner is told why", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		expect((await openHere(machine, proxy)).code).toBe(0);
		const opened = machine.time.now;

		// Used ten minutes later: the hold runs from there.
		machine.advance(10 * MINUTE);
		const status = await runCli(["studio", "status"], { machine, studio: proxy.fake });
		expect(status.code).toBe(0);
		expect(status.studioCalls[0]!.args.studio_id).toBe("own-1");
		expect(machine.lock.owner!.lastActivity).toBe(iso(opened + 10 * MINUTE));
		expect(machine.lock.owner!.expires).toBe(iso(opened + 25 * MINUTE));

		// Twenty minutes in, the other project still waits: five minutes are left.
		machine.advance(10 * MINUTE);
		const other = (argv: string[] = []) =>
			runCli(["studio", "open", "test.rbxl", ...argv], {
				machine,
				cwd: OTHER_PROJECT,
				files: { "test.rbxl": "built" },
				studio: proxy.fake,
				onLaunch: proxy.onLaunch,
			});
		const early = await other(["--lock-timeout", "0"]);
		expect(early.code).toBe(1);
		expect(early.err).toContain(
			`flamework-test for ${THIS_PROJECT} (studio open on ${THIS_FILE}, Studio PID 4001, MCP id own-1)`,
		);
		expect(early.err).toContain("its 15-minute hold runs out in 5 min");
		expect(machine.windows.map((window) => window.pid)).toEqual([4001]);

		// Twenty-six minutes in: idle for sixteen, past its hold. Closed, by its process, and taken.
		machine.advance(6 * MINUTE);
		const late = await other();
		expect(late.code).toBe(0);
		expect(late.closeTargets).toEqual(["pid 4001 place.rbxl"]);
		expect(late.out).toContain(
			`closed the Studio window flamework-test opened for ${THIS_PROJECT} (studio open on ${THIS_FILE}, Studio PID 4001): it had been idle for 16 min, past its 15-minute hold; the Studio lock is free`,
		);
		expect(machine.lock.owner).toMatchObject({ project: OTHER_PROJECT, studioPid: 4002, mcpId: "own-2" });

		// The owner's next command against that window says what became of it.
		const gone = await runCli(["studio", "exec", "--code", "return 1", "--studio", "own-1"], {
			machine,
			studio: proxy.fake,
		});
		expect(gone.code).toBe(1);
		expect(gone.err).toContain(
			`error: the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001, MCP id own-1) was closed at ${iso(opened + 26 * MINUTE)} by flamework-test for ${OTHER_PROJECT} (studio open), after 16 min idle, past its 15-minute hold, so that another project could use Studio`,
		);
		expect(gone.err).toContain(
			`open it again: flamework-test studio open ${THIS_FILE} (--hold <minutes> keeps a window longer)`,
		);
		expect(gone.studioCalls).toEqual([]);
		// Without --studio, the same: this project has no window, and the other project's is never
		// picked in its place only to be refused.
		const noId = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: proxy.fake });
		expect(noId.code).toBe(1);
		expect(noId.err).toContain(
			`error: the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001, MCP id own-1) was closed at`,
		);
		expect(noId.err).not.toContain("refusing to");
		expect(noId.studioCalls).toEqual([]);
		// Naming the other project's window: refused, with the same note.
		const refused = await runCli(["studio", "exec", "--code", "return 1", "--studio", "own-2"], {
			machine,
			studio: proxy.fake,
		});
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(`note: the Studio window flamework-test opened for this project (${THIS_FILE}`);
		expect(refused.err).toContain(`flamework-test opened it for another project, ${OTHER_PROJECT}`);
		expect(refused.studioCalls).toEqual([]);
	});

	test("a running test keeps its window's lease fresh, before each realm, however long a realm takes", async () => {
		const machine = fakeMachine();
		let mode = "Edit";
		const seen: Array<{ realm: string; lastActivity: string; now: string }> = [];
		const proxy = proxyOn(machine, {
			get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
			start_stop_play: (args) => {
				mode = args.is_start ? "Play" : "Edit";
				return "ok";
			},
			execute_luau: (args, call) => {
				const realm = String(args.datamodel_type);
				seen.push({ realm, lastActivity: machine.lock.owner!.lastActivity, now: iso(machine.time.now) });
				call.elapse(20 * MINUTE);
				return JSON.stringify(resultJson({ realm: realm.toLowerCase() }));
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(seen.map((entry) => entry.realm)).toEqual(["Server", "Client"]);
		for (const entry of seen) expect(entry.lastActivity).toBe(entry.now);
		// The run's end frees it.
		expect(machine.lock.owner).toBeUndefined();
	});

	test("--hold gives the window a test --keep leaves a longer one, and the run says how to use it", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, { execute_luau: JSON.stringify(resultJson()), get_studio_state: PLAYING });
		const run = await runCli(["test", "place.rbxl", "--keep", "--hold", "60", "--realm", "server"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(run.out.split("\n")).toContain("studio_id=own-1 pid=4001");
		expect(run.out).toContain("until it has sat unused for 60 min (--hold)");
		expect(machine.lock.owner).toMatchObject({
			command: "test --keep",
			holdMinutes: 60,
			kept: true,
			studioPid: 4001,
			mcpId: "own-1",
		});
		expect(Date.parse(machine.lock.owner!.expires) - Date.parse(machine.lock.owner!.lastActivity)).toBe(
			60 * MINUTE,
		);
	});
});

describe("letting go of the Studio lock", () => {
	test("studio close closes this project's window by its process, even when the proxy has lost it, and frees the lock", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		await openHere(machine, proxy);
		// "MCP server" turned off since: the proxy lists nothing.
		const close = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(close.code).toBe(0);
		expect(close.closeTargets).toEqual(["pid 4001 place.rbxl"]);
		expect(close.out).toContain("closed place.rbxl (PID 4001)");
		expect(close.out).toContain("the Studio lock is free");
		expect(close.proxies.connected).toBe(0);
		expect(machine.lock.owner).toBeUndefined();
		expect(machine.windows).toEqual([]);

		// The testing place, opened from the cloud: closed by the place id its process was started with.
		const cloud = fakeMachine();
		const cloudProxy = proxyOn(cloud);
		const opened = await runCli(["studio", "open"], {
			machine: cloud,
			studio: cloudProxy.fake,
			onLaunch: cloudProxy.onLaunch,
		});
		expect(opened.code).toBe(0);
		expect(cloud.lock.owner).toMatchObject({ placeId: PLACE, place: `the testing place ${PLACE}`, mcpId: "own-1" });
		const closed = await runCli(["studio", "close"], { machine: cloud, studio: cloudProxy.fake });
		expect(closed.closeTargets).toEqual([`pid 4001 ${PLACE}`]);
		expect(closed.removedFiles).toEqual([]);
		expect(cloud.lock.owner).toBeUndefined();
	});

	test("test frees it at its end, and on Ctrl+C once its window is closed", async () => {
		const machine = fakeMachine();
		let during: LockOwner | undefined;
		const proxy = proxyOn(machine, {
			get_studio_state: PLAYING,
			execute_luau: () => {
				during ??= structuredClone(machine.lock.owner);
				return JSON.stringify(resultJson());
			},
		});
		const run = await runCli(["test", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(during).toMatchObject({ command: "test", studioPid: 4001, mcpId: "own-1", project: THIS_PROJECT });
		expect(during!.kept).toBeUndefined();
		expect(machine.lock.owner).toBeUndefined();

		const ctrlC = fakeCtrlC();
		const interrupted = fakeMachine();
		const stopping = proxyOn(interrupted, {
			get_studio_state: PLAYING,
			execute_luau: () => {
				ctrlC.press();
				return new Promise<string>(() => {});
			},
		});
		const cut = await runCli(["test", "place.rbxl"], {
			machine: interrupted,
			files: { "place.rbxl": "built" },
			studio: stopping.fake,
			onLaunch: stopping.onLaunch,
			ctrlC,
		});
		expect(cut.code).toBe(130);
		expect(cut.err).toContain(
			"interrupted by Ctrl+C: cleaned up: closed the Studio window it opened (PID 4001, place.rbxl); closed the MCP proxy (StudioMCP.exe); released the Studio lock",
		);
		expect(interrupted.lock.owner).toBeUndefined();
	});

	test("a window that will not close keeps the lock, until it closes some other way", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine, { get_studio_state: PLAYING, execute_luau: JSON.stringify(resultJson()) });
		const run = await runCli(["test", "place.rbxl", "--realm", "server"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
			closeOutcome: "open",
		});
		expect(run.code).toBe(1);
		expect(machine.lock.owner).toMatchObject({ studioPid: 4001, kept: true });

		// The user closes it by hand; the next command takes the lock over.
		machine.windows.splice(0, machine.windows.length);
		const next = await runCli(["studio", "open", "other.rbxl"], {
			machine,
			cwd: OTHER_PROJECT,
			files: { "other.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(next.code).toBe(0);
		expect(next.out).toContain(`took over the Studio lock: the window flamework-test opened for ${THIS_PROJECT}`);
	});

	test("this project's window left open: the next test of that file closes it; anything else is refused at once, naming it", async () => {
		const machine = fakeMachine();
		const results = { get_studio_state: PLAYING, execute_luau: JSON.stringify(resultJson()) };
		const proxy = proxyOn(machine, results);
		const test = (argv: string[]) =>
			runCli(["test", ...argv, "--realm", "server"], {
				machine,
				files: { "place.rbxl": "built", "other.rbxl": "built" },
				studio: proxy.fake,
				onLaunch: proxy.onLaunch,
			});
		expect((await test(["place.rbxl", "--keep"])).code).toBe(0);
		const again = await test(["place.rbxl"]);
		expect(again.code).toBe(0);
		expect(again.out).toContain("closed the window left from an earlier build of place.rbxl (PID 4001)");
		expect(again.out).not.toContain("waiting for the Studio lock");
		expect(again.launched).toHaveLength(1);
		expect(machine.lock.owner).toBeUndefined();

		// studio open, then a test of another file, and a second open.
		expect((await openHere(machine, proxy)).code).toBe(0);
		const otherFile = await test(["other.rbxl"]);
		expect(otherFile.code).toBe(1);
		expect(otherFile.launched).toHaveLength(0);
		expect(otherFile.err).toContain(
			`error: this project's Studio window is still open: ${THIS_FILE} (Studio PID 4003, MCP id own-3), opened by \`studio open\``,
		);
		expect(otherFile.err).toContain("close it with `flamework-test studio close`, then run this again");
		const second = await openHere(machine, proxy);
		expect(second.code).toBe(1);
		expect(second.launched).toHaveLength(0);
		expect(second.err).toContain(
			"use it (studio_id=own-3: --studio own-3), or close it with `flamework-test studio close` and open again",
		);
	});
});

describe("studio lock and studio unlock", () => {
	test("studio lock says whether the lock is free, live, expired or stale, and what holds it", async () => {
		const free = await runCli(["studio", "lock"]);
		expect(free.code).toBe(0);
		expect(free.out).toBe(
			"Studio lock (C:/Users/me/AppData/Local/flamework-test/studio-lock): free: no window flamework-test opened holds it",
		);

		const machine = fakeMachine();
		otherProjectsWindow(machine, { idleMs: 3 * MINUTE });
		const proxy = { studios: [{ id: "studio-other", name: "test.rbxl" }] };
		// Not asked of the proxy unless --check-window: starting one joins the hub other clients share.
		const quiet = await runCli(["studio", "lock"], { machine, studio: proxy });
		expect(quiet.proxies.connected).toBe(0);
		expect(quiet.out).toContain("  mcp:      studio-other, not checked (--check-window asks the MCP proxy)");
		expect(quiet.out).toContain("  run:      flamework-test PID 8001, ended; it leaves its window open");
		const live = await runCli(["studio", "lock", "--check-window"], { machine, studio: proxy });
		expect(live.code).toBe(0);
		expect(live.out).toContain(
			"Studio lock (C:/Users/me/AppData/Local/flamework-test/studio-lock): live: commands that open a window wait for it, until `flamework-test studio close` in D:\\other, the window closing, or its hold running out at",
		);
		expect(live.out).toContain("  project:  D:\\other");
		expect(live.out).toContain("  command:  studio open");
		expect(live.out).toContain("  place:    D:\\other\\test.rbxl");
		expect(live.out).toContain("(3 min ago)");
		expect(live.out).toContain("(in 12 min; a 15-minute hold)");
		expect(live.out).toContain("  studio:   PID 5001, running");
		expect(live.out).toContain("  mcp:      studio-other, on the MCP proxy");

		const json = await runCli(["studio", "lock", "--json", "--check-window"], { machine, studio: { studios: [] } });
		expect(JSON.parse(json.out)).toMatchObject({
			state: "live",
			studioProcess: "running",
			idleMinutes: 3,
			proxy: "not listed",
			owner: { project: OTHER_PROJECT, mcpId: "studio-other" },
		});

		machine.advance(20 * MINUTE);
		const expired = await runCli(["studio", "lock"], { machine, studio: proxy });
		expect(expired.out).toContain("expired: its window has sat unused past its 15-minute hold");

		machine.windows.splice(0, machine.windows.length);
		const stale = await runCli(["studio", "lock"], { machine, studio: proxy });
		expect(stale.out).toContain(
			"stale: the window flamework-test opened for D:\\other (D:\\other\\test.rbxl, Studio PID 5001) has closed; the next command that opens a window takes it over",
		);
		expect(stale.out).toContain("  studio:   PID 5001, no longer running");
		// A process that has gone is not looked for on the proxy.
		expect(stale.proxies.connected).toBe(0);
		// Read-only: the lock is still there for the next taker.
		expect(machine.lock.owner?.token).toBe("other-token");
	});

	test("studio unlock frees a stale lock, closes an expired window, refuses a live one, and --force closes that too", async () => {
		expect((await runCli(["studio", "unlock"])).out).toBe("the Studio lock is free; nothing to do");

		const stale = fakeWith((machine) => otherProjectsWindow(machine, { window: false }));
		const freed = await runCli(["studio", "unlock"], { machine: stale });
		expect(freed.code).toBe(0);
		expect(freed.out).toContain("freed the Studio lock: the window flamework-test opened for D:\\other");
		expect(stale.lock.owner).toBeUndefined();

		const live = fakeWith((machine) => otherProjectsWindow(machine));
		const refused = await runCli(["studio", "unlock"], { machine: live });
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			"error: the Studio lock is live: flamework-test for D:\\other (studio open on D:\\other\\test.rbxl",
		);
		expect(refused.err).toContain("its 15-minute hold runs out in 14 min");
		expect(refused.err).toContain("--force closes its window now: only with the go-ahead of whoever is using it");
		expect(refused.closeTargets).toEqual([]);
		expect(live.lock.owner?.token).toBe("other-token");

		const forced = await runCli(["studio", "unlock", "--force"], { machine: live });
		expect(forced.code).toBe(0);
		expect(forced.closeTargets).toEqual(["pid 5001 test.rbxl"]);
		expect(forced.out).toContain(
			"closed the Studio window flamework-test opened for D:\\other (studio open on D:\\other\\test.rbxl, Studio PID 5001): `studio unlock --force` freed its lock while it was live; the Studio lock is free",
		);
		expect(live.lock.owner).toBeUndefined();
		expect(live.lock.closed.map((entry) => [entry.reason, entry.by.command])).toEqual([
			["forced", "studio unlock --force"],
		]);
		// The other project hears of it.
		const owner = await runCli(["studio", "run", "--studio", "studio-other"], {
			machine: live,
			cwd: OTHER_PROJECT,
			studio: { studios: [] },
		});
		expect(owner.code).toBe(1);
		expect(owner.err).toContain(
			`by flamework-test for ${THIS_PROJECT} (studio unlock --force), by \`flamework-test studio unlock --force\``,
		);

		const expired = fakeWith((machine) => otherProjectsWindow(machine, { idleMs: 20 * MINUTE }));
		const closed = await runCli(["studio", "unlock"], { machine: expired });
		expect(closed.code).toBe(0);
		expect(closed.out).toContain("it had been idle for 20 min, past its 15-minute hold; the Studio lock is free");
		expect(expired.windows).toEqual([]);
		expect(expired.lock.owner).toBeUndefined();
	});

	test("an expired lock whose PID is a window flamework-test did not launch is freed, and that window never closed", async () => {
		const machine = fakeMachine();
		const owner = otherProjectsWindow(machine, { idleMs: 20 * MINUTE, window: false });
		// Same PID, same start time, so the judge cannot tell; but it has another place open.
		const mine = {
			pid: 5001,
			title: "C:\\Users\\me\\mine.rbxl - Roblox Studio",
			startedWith: "C:\\Users\\me\\mine.rbxl",
			startedAt: Date.parse(owner.studioStartedAt!),
		};
		machine.windows.push(mine);
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(run.closeTargets[0]).toBe("pid 5001 test.rbxl");
		expect(run.closedWindows).toEqual([]);
		expect(run.out).toContain(
			"freed the Studio lock of D:\\other (it had been idle for 20 min, past its 15-minute hold) without closing anything: Studio PID 5001 is no longer the window flamework-test launched on D:\\other\\test.rbxl",
		);
		expect(machine.windows).toContainEqual(mine);
		expect(machine.lock.closed).toEqual([]);
	});
});

describe("which windows a command may change", () => {
	const verbs: Array<[string[], string]> = [
		[["studio", "exec", "--code", "return 1"], "run Luau in"],
		[["studio", "play"], "start a play session in"],
		[["studio", "stop"], "stop the play session of"],
		[["studio", "run"], "run the tests in"],
		[["studio", "close"], "close"],
		[["studio", "call", "get_studio_state"], "call get_studio_state in"],
	];

	test("a window flamework-test did not open is refused before any call to it, naming it and the flag", async () => {
		for (const [argv, verb] of verbs) {
			const run = await runCli([...argv, "--studio", "studio-1"], {
				studio: { studios: [TESTING_STUDIO], answers: { get_studio_state: EDITING } },
			});
			expect(run.code).toBe(1);
			expect(run.err).toContain(
				`error: refusing to ${verb} the Studio window "${TESTING_STUDIO.name}" (studio-1): flamework-test did not open it for this project, so it may be a window the user has open`,
			);
			expect(run.err).toContain(
				"pass --any-window to act on it anyway, but only once the user has said so: never use --any-window on a window the user has open without asking them first",
			);
			expect(run.studioCalls).toEqual([]);
			expect(run.closeTargets).toEqual([]);

			// Not named: this project has no window, said so, rather than another taken in its place.
			const unnamed = await runCli(argv, {
				studio: { studios: [TESTING_STUDIO], answers: { get_studio_state: EDITING } },
			});
			expect(unnamed.code).toBe(1);
			expect(unnamed.err).toContain(
				"error: no Studio window flamework-test opened for this project is open, so this command has no window to act on",
			);
			expect(unnamed.err).toContain("open one first: `flamework-test studio open [file]`");
			expect(unnamed.err).not.toContain("refusing to");
			expect(unnamed.studioCalls).toEqual([]);
			expect(unnamed.closeTargets).toEqual([]);
		}
		// Reading it is fine.
		const status = await runCli(["studio", "status"], {
			studio: { studios: [TESTING_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(status.code).toBe(0);
	});

	test("another project's flamework-test window needs --any-window too, and its lease is left alone", async () => {
		const machine = fakeMachine();
		const owner = otherProjectsWindow(machine);
		const listed = { studios: [{ id: "studio-other", name: "test.rbxl" }], answers: { execute_luau: "1" } };
		const refused = await runCli(["studio", "exec", "--code", "return 1", "--studio", "studio-other"], {
			machine,
			studio: listed,
		});
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			`refusing to run Luau in the Studio window "test.rbxl" (studio-other): flamework-test opened it for another project, D:\\other (studio open, since ${owner.since}), whose run or agent may still be using it`,
		);
		expect(refused.studioCalls).toEqual([]);

		const allowed = await runCli(
			["studio", "exec", "--code", "return 1", "--studio", "studio-other", "--any-window"],
			{
				machine,
				studio: listed,
			},
		);
		expect(allowed.code).toBe(0);
		expect(allowed.studioCalls[0]!.args.studio_id).toBe("studio-other");
		expect(machine.lock.owner!.lastActivity).toBe(owner.lastActivity);
	});

	test("this project's window needs nothing, is the one found by default, and each use renews it", async () => {
		const machine = fakeMachine();
		// The testing place is open in the user's window as well.
		const proxy = proxyOn(machine, {}, [TESTING_STUDIO]);
		await openHere(machine, proxy);
		machine.advance(5 * MINUTE);
		const exec = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: proxy.fake });
		expect(exec.code).toBe(0);
		expect(exec.studioCalls[0]!.args.studio_id).toBe("own-1");
		expect(machine.lock.owner!.lastActivity).toBe(iso(machine.time.now));
	});
});

describe("when Studio's MCP server is off or missing", () => {
	test("Studio running but no window on the proxy: the setting is named, and the user is to turn it on", async () => {
		const run = await runCli(["studio", "status"], {
			studio: { studios: [] },
			windows: [{ pid: 3000, title: "Place1 - Roblox Studio" }],
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			'error: Roblox Studio is running (1 window: PID 3000, "Place1 - Roblox Studio"), but the MCP proxy reaches none of them',
		);
		expect(run.err).toContain(
			'their "MCP server" setting is probably off: ask the user to turn it on in Studio\'s Assistant settings',
		);

		const list = await runCli(["studio", "list"], {
			studio: { studios: [] },
			windows: [{ pid: 3000, title: "Place1 - Roblox Studio" }],
		});
		expect(list.code).toBe(0);
		expect(list.out).toContain("no Studio window is on the MCP proxy");
		expect(list.err).toContain('its "MCP server" setting is probably off; ask the user to turn it on');
	});

	test("this project's window open but off the proxy says so", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		await openHere(machine, proxy);
		const run = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: { studios: [] } });
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			`the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001) is open but not on the MCP proxy`,
		);
		expect(run.err).toContain('its "MCP server" setting is probably off: ask the user to turn it on');

		// Closed by hand: the lock is freed at this look.
		machine.windows.splice(0, machine.windows.length);
		const gone = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: { studios: [] } });
		expect(gone.err).toContain(
			`the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001) has closed`,
		);
		expect(machine.lock.owner).toBeUndefined();
	});

	test("StudioMCP.exe not installed says what it is, where it was looked for, and what to do", async () => {
		const empty = mkdtempSync(join(tmpdir(), "fwnomcp-"));
		try {
			const run = await runCli(["studio", "list"], { proxy: false, env: { LOCALAPPDATA: empty } });
			expect(run.code).toBe(1);
			expect(run.err).toContain(
				"error: StudioMCP.exe, Roblox Studio's MCP proxy, was not found under Roblox Studio's versions folder (%LOCALAPPDATA%\\Roblox\\Versions)",
			);
			expect(run.err).toContain(
				"install Roblox Studio on this machine (the proxy ships with it), or set STUDIO_MCP_EXE",
			);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("a window studio open cannot use", () => {
	test("two windows of its file registering at once: it closes its own and frees the lock", async () => {
		const machine = fakeMachine();
		const listed: StudioEntry[] = [];
		const run = await runCli(["studio", "open", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: { studios: () => [...listed] },
			// Someone else's place.rbxl registers with the proxy together with this command's.
			onLaunch: () => listed.push({ id: "a", name: "place.rbxl" }, { id: "b", name: "place.rbxl" }),
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("another window of that name registered with it at the same time");
		expect(run.closeTargets).toEqual(["pid 4001 place.rbxl"]);
		expect(run.windows).toEqual([]);
		expect(machine.lock.owner).toBeUndefined();
	});
});

/** The real judge's view of the fake machine, as another process's look at the lock would see it. */
function probeOf(machine: FakeMachine) {
	return async (pids: number[]) => {
		const found = new Map<number, ProcessInfo>();
		for (const pid of pids) {
			const window = machine.windows.find((entry) => entry.pid === pid);
			if (window !== undefined) found.set(pid, { name: "RobloxStudioBeta", startedAt: window.startedAt });
			else if (machine.clis.has(pid)) found.set(pid, { name: "bun", startedAt: machine.clis.get(pid)! });
		}
		return found;
	};
}

/** A test of this project, `place.rbxl`, run by another process (PID 8888) and still going, in Studio PID 5005. */
function anotherRunningTest(machine: FakeMachine, overrides: Partial<LockOwner> = {}): LockOwner {
	const now = machine.time.now;
	machine.windows.push({ pid: 5005, title: `${THIS_FILE} - Roblox Studio`, startedWith: THIS_FILE, startedAt: now });
	machine.clis.set(8888, now);
	const owner: LockOwner = {
		version: 1,
		token: "running-token",
		cliPid: 8888,
		cliName: "bun",
		cliStartedAt: iso(now),
		studioPid: 5005,
		studioStartedAt: iso(now),
		mcpId: "running-test",
		project: THIS_PROJECT,
		command: "test",
		place: THIS_FILE,
		placeFile: THIS_FILE,
		since: iso(now),
		...leaseFrom(now, 15),
		holdMinutes: 15,
		...overrides,
	};
	machine.lock.owner = owner;
	return owner;
}

describe("a running command holds the lock to its end", () => {
	test("between one project's window closing and the next one opening, another project waits (V1)", async () => {
		const machine = fakeMachine();
		const update = machine.lock.update;
		const seen: LockView[] = [];
		const others: Array<Awaited<ReturnType<typeof runCli>>> = [];
		machine.lock.update = async (token, patch) => {
			// The window has just closed, and the record does not say so yet: another project's look
			// lands in that gap, and so does its whole command.
			if ("studioPid" in patch && patch.studioPid === undefined && others.length === 0) {
				seen.push(await judgeLock(await machine.lock.read(), machine.time.now, probeOf(machine)));
				others.push(
					await runCli(["studio", "open", "test.rbxl", "--lock-timeout", "0"], {
						machine,
						cwd: OTHER_PROJECT,
						files: { "test.rbxl": "built" },
					}),
				);
			}
			return await update(token, patch);
		};
		let mode = "Edit";
		const results: Record<string, string> = {
			Server: JSON.stringify(resultJson()),
			Client: JSON.stringify(resultJson({ realm: "client" })),
		};
		const proxy = proxyOn(machine, {
			get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
			start_stop_play: (args) => {
				mode = args.is_start ? "Play" : "Edit";
				return "ok";
			},
			execute_luau: (args) => results[args.datamodel_type as string]!,
		});
		const project = JSON.stringify({ tree: { $className: "DataModel" } });
		const run = await runCli(["test", "place.rbxl", "--project", "tests/a.project.json,tests/b.project.json"], {
			machine,
			files: {
				"place.rbxl": "built",
				"tests/a.project.json": project,
				"tests/b.project.json": project,
				"place.a.rbxl": "made",
				"place.b.rbxl": "made",
			},
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ state: "live", cli: "running", window: "gone" });
		const other = others[0]!;
		expect(other.code).toBe(1);
		expect(other.launched).toHaveLength(0);
		expect(other.err).toContain(
			`the Studio lock is still held after waiting 0s: flamework-test for ${THIS_PROJECT} (test on `,
		);
		expect(other.err).toContain(
			`its command is running (flamework-test PID ${run.cliPid}) and holds the lock to its end`,
		);
		expect(other.err).toContain("it is freed when that command ends (it closes its own window)");
		// The run went on to its second project, holding the lock all along, and freed it at its end.
		expect(run.code).toBe(0);
		expect(run.launched).toHaveLength(2);
		expect(run.out).toContain("projects: a passed, b passed");
		expect(machine.lock.owner).toBeUndefined();
	});

	test("a window left open by a command cut short is closed at once by the next taker, which says why", async () => {
		const machine = fakeMachine();
		// A plain test of another project, ended by a second Ctrl+C: its process has gone, its window not.
		const owner = otherProjectsWindow(machine, {
			idleMs: 0,
			overrides: { command: "test", kept: undefined, mcpId: "studio-other" },
		});
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(run.out).not.toContain("waiting for the Studio lock");
		expect(run.closeTargets[0]).toBe("pid 5001 test.rbxl");
		expect(run.out).toContain(
			"closed the Studio window flamework-test opened for D:\\other (test on D:\\other\\test.rbxl, Studio PID 5001): the `test` that opened it (flamework-test PID 8001) has ended without closing it; the Studio lock is free",
		);
		expect(machine.lock.owner!.project).toBe(THIS_PROJECT);
		expect(machine.lock.closed.map((entry) => [entry.reason, entry.owner.token])).toEqual([
			["abandoned", owner.token],
		]);

		// studio lock names it so before anything takes it.
		const seen = fakeWith((fresh) =>
			otherProjectsWindow(fresh, { overrides: { command: "test", kept: undefined } }),
		);
		const lock = await runCli(["studio", "lock"], { machine: seen });
		expect(lock.out).toContain(
			"expired: the `test` that opened it (flamework-test PID 8001) has ended without closing it; the next command that opens a window closes it and takes the lock",
		);
	});

	test("test --keep and studio open mark their window kept as soon as it is launched", async () => {
		const machine = fakeMachine();
		let during: LockOwner | undefined;
		const proxy = proxyOn(machine, {
			get_studio_state: PLAYING,
			execute_luau: () => {
				during = structuredClone(machine.lock.owner);
				return JSON.stringify(resultJson());
			},
		});
		const run = await runCli(["test", "place.rbxl", "--keep", "--realm", "server"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(during).toMatchObject({ command: "test --keep", kept: true, studioPid: 4001 });
	});
});

describe("a window that is this project's by its id alone is not this project's (V3)", () => {
	test("its window closed by hand and the id reused for the user's own: nothing is sent to it", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		expect((await openHere(machine, proxy)).code).toBe(0);
		const id = machine.lock.owner!.mcpId!;
		// The user closes it and opens their own place, which the proxy lists under the same id.
		machine.windows.splice(0, machine.windows.length);
		const users = { studios: [{ id, name: "UsersGame (placeId: 42)" }], answers: { execute_luau: "1" } };

		const exec = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: users });
		expect(exec.code).toBe(1);
		expect(exec.studioCalls).toEqual([]);
		expect(exec.err).toContain(
			`the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001) has closed`,
		);
		expect(machine.lock.owner).toBeUndefined();

		// Named by its id: the user's window, refused as such.
		const named = await runCli(["studio", "exec", "--code", "return 1", "--studio", id], {
			machine,
			studio: users,
		});
		expect(named.code).toBe(1);
		expect(named.studioCalls).toEqual([]);
		expect(named.err).toContain(
			`refusing to run Luau in the Studio window "UsersGame (placeId: 42)" (${id}): flamework-test did not open it for this project`,
		);
	});

	test("the window still running, the id listed as another place: said so, nothing sent, and studio list agrees", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		expect((await openHere(machine, proxy)).code).toBe(0);
		const users = { studios: [{ id: "own-1", name: "UsersGame (placeId: 42)" }], answers: { execute_luau: "1" } };
		const exec = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: users });
		expect(exec.code).toBe(1);
		expect(exec.studioCalls).toEqual([]);
		expect(exec.err).toContain(
			'is not on the MCP proxy as own-1: the proxy lists "UsersGame (placeId: 42)" under that id now, which is not that place, so nothing was sent to it',
		);
		const list = await runCli(["studio", "list"], { machine, studio: users });
		expect(list.out).toContain(
			"own-1  UsersGame (placeId: 42)  [not opened by flamework-test for any project (the user's, an older flamework-test's, or opened by hand)]",
		);
	});
});

describe("a window another process's test of this project is running in (V4)", () => {
	test("studio close refuses, naming the run, and so does every command that changes it; --any-window goes ahead", async () => {
		const machine = fakeMachine();
		anotherRunningTest(machine);
		const close = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(close.code).toBe(1);
		expect(close.closeTargets).toEqual([]);
		expect(close.err).toContain(
			`error: refusing to close this project's Studio window (${THIS_FILE}, Studio PID 5005): \`test\` is running in it (flamework-test PID 8888, since `,
		);
		expect(close.err).toContain("wait for that run to end");
		expect(machine.windows.map((window) => window.pid)).toEqual([5005]);
		expect(machine.lock.owner?.token).toBe("running-token");

		const listed = { studios: [{ id: "running-test", name: "place.rbxl" }], answers: { execute_luau: "1" } };
		const exec = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: listed });
		expect(exec.code).toBe(1);
		expect(exec.studioCalls).toEqual([]);
		expect(exec.err).toContain("refusing to run Luau in this project's Studio window");
		// Reading it is fine.
		const status = await runCli(["studio", "status"], {
			machine,
			studio: { ...listed, answers: { get_studio_state: EDITING } },
		});
		expect(status.code).toBe(0);

		const forced = await runCli(["studio", "close", "--any-window"], { machine, studio: { studios: [] } });
		expect(forced.code).toBe(0);
		expect(forced.closeTargets).toEqual(["pid 5005 place.rbxl"]);
	});

	test("once that run has ended, its window is this project's to close", async () => {
		const machine = fakeMachine();
		anotherRunningTest(machine, { kept: true, command: "test --keep" });
		machine.clis.delete(8888);
		const close = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(close.code).toBe(0);
		expect(close.closeTargets).toEqual(["pid 5005 place.rbxl"]);
		expect(close.out).toContain("the Studio lock is free");
	});

	test("a close whose free lost to a takeover does not say the lock is free", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		await openHere(machine, proxy);
		const free = machine.lock.free;
		machine.lock.free = async (token) => {
			// Another command found the window gone and took the lock over first.
			machine.lock.owner = { ...machine.lock.owner!, token: "taker" };
			return await free(token);
		};
		const close = await runCli(["studio", "close"], { machine, studio: proxy.fake });
		expect(close.code).toBe(0);
		expect(close.out).not.toContain("the Studio lock is free");
		expect(close.out).toContain(
			"the Studio lock has already been taken over by another command; `flamework-test studio lock` shows which",
		);
	});
});

describe("studio list judges the lock before naming its holder", () => {
	test("a stale record holds nothing, an expired one says so", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine, { window: false });
		const listed = { studios: [{ id: "studio-other", name: "test.rbxl" }] };
		const stale = await runCli(["studio", "list"], { machine, studio: listed });
		expect(stale.out.split("\n")[0]).toBe(
			"Studio lock: stale, held by nothing: the window flamework-test opened for D:\\other (D:\\other\\test.rbxl, Studio PID 5001) has closed; the next command that opens a window takes it over",
		);
		expect(stale.out).not.toContain("holds the Studio lock");
		const json = await runCli(["studio", "list", "--json"], { machine, studio: listed });
		expect(JSON.parse(json.out).lock.state).toBe("stale");
		expect(JSON.parse(json.out).studios[0].holdsLock).toBe(false);

		const old = fakeWith((fresh) => otherProjectsWindow(fresh, { idleMs: 20 * MINUTE }));
		const expired = await runCli(["studio", "list"], { machine: old, studio: listed });
		expect(expired.out.split("\n")[0]).toContain("Studio lock: expired, flamework-test for D:\\other");
		expect(expired.out).toContain("its 15-minute hold has run out");
		expect(expired.out).toContain(
			"studio-other  test.rbxl  [opened by flamework-test for D:\\other; holds the Studio lock, expired]",
		);
	});
});

describe("a lock forced away before the launch", () => {
	test("the command launches nothing, and says why", async () => {
		const machine = fakeMachine();
		let looks = 0;
		const run = await runCli(["studio", "open", "place.rbxl"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: {
				studios: () => {
					looks += 1;
					// `studio unlock --force` from another project, between the take and the launch.
					if (looks === 1) machine.lock.owner = { ...machine.lock.owner!, token: "forced-away" };
					return [];
				},
			},
		});
		expect(run.code).toBe(1);
		expect(run.launched).toHaveLength(0);
		expect(run.err).toContain(
			"error: the Studio lock was taken from this command before it opened Studio: `flamework-test studio unlock --force` freed it",
		);
		expect(machine.lock.owner!.token).toBe("forced-away");
	});
});

describe("a window another process's command of this project is using, kept or not (fix2 1, b7)", () => {
	test("test --keep running in it: exec, call and close are refused before anything is sent, and allowed once it has ended", async () => {
		const machine = fakeMachine();
		const during: Array<Awaited<ReturnType<typeof runCli>>> = [];
		let owner: LockOwner | undefined;
		let asked = false;
		const proxy = proxyOn(machine, {
			get_studio_state: PLAYING,
			execute_luau: async () => {
				if (!asked) {
					asked = true;
					owner = structuredClone(machine.lock.owner);
					// Another agent in this project, while the run is in the window.
					for (const argv of [
						["studio", "exec", "--code", "return 2"],
						["studio", "call", "get_studio_state"],
						["studio", "close"],
					]) {
						during.push(await runCli(argv, { machine, studio: proxy.fake }));
					}
				}
				return JSON.stringify(resultJson());
			},
		});
		const run = await runCli(["test", "place.rbxl", "--keep", "--realm", "server"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		// Kept from its launch on, and refused all the same while its command runs.
		expect(owner).toMatchObject({ command: "test --keep", kept: true, studioPid: 4001 });
		expect(during.map((other) => other.code)).toEqual([1, 1, 1]);
		for (const [other, verb] of [
			[during[0]!, "run Luau in"],
			[during[1]!, "call get_studio_state in"],
			[during[2]!, "close"],
		] as const) {
			expect(other.err).toContain(
				`error: refusing to ${verb} this project's Studio window (${THIS_FILE}, Studio PID 4001): \`test --keep\` is running in it (flamework-test PID ${run.cliPid}, since `,
			);
			expect(other.err).toContain("and leaves it open when it ends");
			expect(other.err).toContain("wait for that run to end, then use the window it leaves open");
			expect(other.studioCalls).toEqual([]);
			expect(other.closeTargets).toEqual([]);
		}
		// The window is the run's: only the run's own calls reached it, and it is still open.
		expect(machine.windows.map((window) => window.pid)).toEqual([4001]);

		// The run has ended: its window is this project's to use and to close.
		const exec = await runCli(["studio", "exec", "--code", "return 2"], { machine, studio: proxy.fake });
		expect(exec.code).toBe(0);
		expect(exec.studioCalls[0]!.args.studio_id).toBe("own-1");
		const close = await runCli(["studio", "close"], { machine, studio: proxy.fake });
		expect(close.code).toBe(0);
		expect(close.closeTargets).toEqual(["pid 4001 place.rbxl"]);
	});

	test("studio open still waiting for its window to connect: refused the same way", async () => {
		const machine = fakeMachine();
		anotherRunningTest(machine, { command: "studio open", kept: true, mcpId: undefined });
		const exec = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: { studios: [] } });
		expect(exec.code).toBe(1);
		expect(exec.err).toContain("`studio open` is running in it (flamework-test PID 8888");
		expect(exec.proxies.connected).toBe(0);
		const close = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(close.code).toBe(1);
		expect(close.closeTargets).toEqual([]);
	});

	test("between two of a test's windows: the in-use refusal, not a window the user may have open", async () => {
		const machine = fakeMachine();
		const owner = anotherRunningTest(machine, {
			studioPid: undefined,
			studioStartedAt: undefined,
			mcpId: undefined,
		});
		machine.windows.splice(0, machine.windows.length);
		const listed = { studios: [TESTING_STUDIO], answers: { execute_luau: "1", get_studio_state: EDITING } };
		for (const [argv, verb] of [
			[["studio", "exec", "--code", "return 1"], "run Luau in"],
			[["studio", "close"], "close"],
			[["studio", "run"], "run the tests in"],
		] as const) {
			const run = await runCli([...argv], { machine, studio: listed });
			expect(run.code).toBe(1);
			expect(run.err).toContain(
				`error: refusing to ${verb} this project's Studio window: \`test\` is running for this project (flamework-test PID 8888, since ${owner.since}) with no window open right now, between two of its windows or before its first (${THIS_FILE}), and closes its windows when it ends`,
			);
			expect(run.err).not.toContain("may be a window the user has open");
			expect(run.studioCalls).toEqual([]);
			// Refused before the proxy is asked anything.
			expect(run.proxies.connected).toBe(0);
		}
		// Reading still works, and takes the testing place's window, as without a lock.
		const status = await runCli(["studio", "status"], { machine, studio: listed });
		expect(status.code).toBe(0);
	});

	test("a multi-project test: a command in the gap is refused as in use, and the record names the next project's place (b8)", async () => {
		const machine = fakeMachine();
		const update = machine.lock.update;
		const gap: Array<Awaited<ReturnType<typeof runCli>>> = [];
		machine.lock.update = async (token, patch) => {
			const result = await update(token, patch);
			// The first project's window has just closed.
			if ("studioPid" in patch && patch.studioPid === undefined && gap.length === 0) {
				gap.push(await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: { studios: [] } }));
			}
			return result;
		};
		const placesWhilePatching: string[] = [];
		let mode = "Edit";
		const proxy = proxyOn(machine, {
			get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
			start_stop_play: (args) => {
				mode = args.is_start ? "Play" : "Edit";
				return "ok";
			},
			execute_luau: (args) => JSON.stringify(resultJson({ realm: String(args.datamodel_type).toLowerCase() })),
		});
		const project = JSON.stringify({ tree: { $className: "DataModel" } });
		const run = await runCli(["test", "place.rbxl", "--project", "tests/a.project.json,tests/b.project.json"], {
			machine,
			files: {
				"place.rbxl": "built",
				"tests/a.project.json": project,
				"tests/b.project.json": project,
				"place.a.rbxl": "made",
				"place.b.rbxl": "made",
			},
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
			spawnCode: (command) => {
				// The patch of each project, with what the lock's record names then.
				if (command.some((part) => part.endsWith(".luau")))
					placesWhilePatching.push(machine.lock.owner?.place ?? "(free)");
				return 0;
			},
		});
		expect(run.code).toBe(0);
		expect(gap).toHaveLength(1);
		expect(gap[0]!.err).toContain(
			`refusing to run Luau in this project's Studio window: \`test\` is running for this project (flamework-test PID ${run.cliPid}`,
		);
		// The first project's patch runs before the lock is taken; the second's under it, naming its own place.
		expect(placesWhilePatching).toEqual(["(free)", join(THIS_PROJECT, "place.b.rbxl")]);
		expect(machine.lock.owner).toBeUndefined();
	});
});

describe("a window closed by hand, then taken over by another project (fix2 2, 6)", () => {
	const studioLockFile = (pid: number) => `${pid}\nRobloxStudioBeta\nPC\n898721bc-125e-4af1-a247-dcbabd4c100a\n\n`;

	test("the takeover leaves a note, removes the dead window's Studio lock file, and the old owner's next command says its window has closed", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		expect((await openHere(machine, proxy)).code).toBe(0);
		// Closed by hand (or Studio exited, leaving its lock file beside the place).
		machine.windows.splice(0, machine.windows.length);
		const files: Record<string, string> = { "test.rbxl": "built", "place.rbxl.lock": studioLockFile(4001) };
		const other = await runCli(["studio", "open", "test.rbxl"], {
			machine,
			cwd: OTHER_PROJECT,
			files,
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(other.code).toBe(0);
		expect(other.out).toContain(
			`took over the Studio lock: the window flamework-test opened for ${THIS_PROJECT} (${THIS_FILE}, Studio PID 4001) has closed`,
		);
		expect(other.removedFiles).toEqual([`${THIS_FILE}.lock`.replaceAll("\\", "/")]);
		expect(machine.lock.closed.map((entry) => [entry.reason, entry.owner.mcpId, entry.by.project])).toEqual([
			["gone", "own-1", OTHER_PROJECT],
		]);

		const said = `error: the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001, MCP id own-1) has closed: closed by hand, or Studio exited; flamework-test for ${OTHER_PROJECT} (studio open) found it so at ${iso(machine.time.now)}, and took over its Studio lock`;
		// Without --studio: not the other project's window, refused; this one's fate.
		const noId = await runCli(["studio", "exec", "--code", "return 1"], { machine, studio: proxy.fake });
		expect(noId.code).toBe(1);
		expect(noId.err).toContain(said);
		expect(noId.err).toContain(`open it again: flamework-test studio open ${THIS_FILE}`);
		expect(noId.err).not.toContain("refusing to");
		expect(noId.studioCalls).toEqual([]);
		// With its old id: the same, not "no Studio window is named".
		const oldId = await runCli(["studio", "exec", "--code", "return 1", "--studio", "own-1"], {
			machine,
			studio: proxy.fake,
		});
		expect(oldId.code).toBe(1);
		expect(oldId.err).toContain(said);
		expect(oldId.studioCalls).toEqual([]);
		// Its own close: no window of its, the same note; the other project's window is left alone.
		const close = await runCli(["studio", "close"], { machine, studio: proxy.fake });
		expect(close.code).toBe(1);
		expect(close.err).toContain(said);
		expect(close.closeTargets).toEqual([]);
		expect(machine.lock.owner!.project).toBe(OTHER_PROJECT);
	});

	test("Studio's lock file is removed only when it names the dead window, and studio unlock leaves a note too", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine, { window: false });
		// Another Studio's lock beside that place: left alone.
		const kept = await openHere(machine, proxyOn(machine), []);
		expect(kept.code).toBe(0);
		expect(kept.removedFiles).toEqual([]);

		const freed = fakeMachine();
		otherProjectsWindow(freed, { window: false });
		const unlock = await runCli(["studio", "unlock"], {
			machine: freed,
			files: { "test.rbxl.lock": studioLockFile(5001) },
		});
		expect(unlock.code).toBe(0);
		expect(unlock.removedFiles).toEqual(["D:/other/test.rbxl.lock"]);
		expect(freed.lock.closed.map((entry) => [entry.reason, entry.by.command])).toEqual([["gone", "studio unlock"]]);
		const owner = await runCli(["studio", "exec", "--code", "return 1"], {
			machine: freed,
			cwd: OTHER_PROJECT,
			studio: { studios: [] },
		});
		expect(owner.err).toContain(`found it so at ${iso(freed.time.now)}, and freed its Studio lock`);

		const wrongPid = fakeMachine();
		otherProjectsWindow(wrongPid, { window: false });
		const left = await runCli(["studio", "unlock"], {
			machine: wrongPid,
			files: { "test.rbxl.lock": studioLockFile(7777) },
		});
		expect(left.code).toBe(0);
		expect(left.removedFiles).toEqual([]);
	});

	test("its own next command, with no other project about, frees the lock and removes the lock file, leaving no note", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		await openHere(machine, proxy);
		machine.windows.splice(0, machine.windows.length);
		const run = await runCli(["studio", "exec", "--code", "return 1"], {
			machine,
			files: { "place.rbxl.lock": studioLockFile(4001) },
			studio: { studios: [] },
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			`the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001) has closed`,
		);
		expect(run.removedFiles).toEqual([`${THIS_FILE}.lock`.replaceAll("\\", "/")]);
		expect(machine.lock.owner).toBeUndefined();
		expect(machine.lock.closed).toEqual([]);
	});
});

describe("notes of closed windows (fix2 3)", () => {
	test("an old note is not shown once this project has taken the lock again; another project's is kept", async () => {
		const machine = fakeMachine();
		const note = (project: string, token: string, minutesAgo: number) => ({
			owner: {
				...otherProjectsWindow(fakeMachine(), { window: false }),
				project,
				token,
				place: join(project, "place.rbxl"),
				placeFile: join(project, "place.rbxl"),
				mcpId: `id-${token}`,
			},
			closedAt: iso(machine.time.now - minutesAgo * MINUTE),
			reason: "expired" as const,
			idleMinutes: 16,
			by: { project: "D:\\third", command: "studio open" },
		});
		machine.lock.closed.push(note(THIS_PROJECT, "old-mine", 60), note(OTHER_PROJECT, "theirs", 30));

		// The note is news until this project takes the lock again.
		const before = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(before.err).toContain("MCP id id-old-mine) was closed at");

		const proxy = proxyOn(machine, { get_studio_state: PLAYING, execute_luau: JSON.stringify(resultJson()) });
		const run = await runCli(["test", "place.rbxl", "--realm", "server"], {
			machine,
			files: { "place.rbxl": "built" },
			studio: proxy.fake,
			onLaunch: proxy.onLaunch,
		});
		expect(run.code).toBe(0);
		expect(machine.lock.closed.map((entry) => entry.owner.token)).toEqual(["theirs"]);

		const after = await runCli(["studio", "close"], { machine, studio: { studios: [] } });
		expect(after.code).toBe(1);
		expect(after.err).not.toContain("was closed at");
		expect(after.err).toContain("error: no Studio window flamework-test opened for this project is open");
	});
});

describe("this project's window by its id and place, but its Studio process gone (b6)", () => {
	test("a command that changes it sends nothing, and frees the lock saying the window has closed", async () => {
		const machine = fakeMachine();
		const proxy = proxyOn(machine);
		await openHere(machine, proxy);
		machine.windows.splice(0, machine.windows.length);
		// The proxy still lists the id with the place.
		const listed = { studios: [{ id: "own-1", name: "place.rbxl" }], answers: { execute_luau: "1" } };
		const run = await runCli(["studio", "exec", "--code", "return 1", "--studio", "own-1"], {
			machine,
			studio: listed,
		});
		expect(run.code).toBe(1);
		expect(run.studioCalls).toEqual([]);
		expect(run.err).toContain(
			`the Studio window flamework-test opened for this project (${THIS_FILE}, Studio PID 4001) has closed`,
		);
		expect(machine.lock.owner).toBeUndefined();
	});
});

describe("taking an expired lock whose window closes meanwhile (b11)", () => {
	test("the next try judges from a fresh look, at once, rather than spinning on the cached one", async () => {
		const machine = fakeMachine();
		otherProjectsWindow(machine, { idleMs: 20 * MINUTE });
		const read = machine.lock.read;
		let reads = 0;
		machine.lock.read = async () => {
			reads += 1;
			if (reads > 40) throw new Error("busy loop: the lock was read over and over without a sleep");
			// The close looks again (the second read): the window has closed by then.
			if (reads === 2) machine.windows.splice(0, machine.windows.length);
			return await read();
		};
		const run = await openHere(machine, proxyOn(machine));
		expect(run.code).toBe(0);
		expect(run.closeTargets).toEqual([]);
		expect(run.out).toContain("took over the Studio lock: the window flamework-test opened for D:\\other");
		expect(reads).toBeLessThan(10);
	});
});
