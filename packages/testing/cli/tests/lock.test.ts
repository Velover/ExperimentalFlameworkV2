import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	CLI_START_TOLERANCE_MS,
	CLOSED_MEMORY_MS,
	fateOf,
	LEFTOVER_STALE_MS,
	fileLockStore,
	judgeLock,
	leaseFrom,
	MUTEX_STALE_MS,
	START_TOLERANCE_MS,
	stateDirOf,
	UNREADABLE_GRACE_MS,
	type LockOwner,
	type ProcessInfo,
} from "../src/lock.ts";
import { probeProcesses } from "../src/studio.ts";

const T0 = Date.parse("2026-10-04T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function owner(overrides: Partial<LockOwner> = {}): LockOwner {
	return {
		version: 1,
		token: "token-a",
		cliPid: 9001,
		cliName: "bun",
		cliStartedAt: iso(T0 - 60_000),
		project: "E:\\game",
		command: "studio open",
		place: "E:\\game\\test.rbxl",
		placeFile: "E:\\game\\test.rbxl",
		since: iso(T0 - 60_000),
		...leaseFrom(T0 - 60_000, 15),
		holdMinutes: 15,
		...overrides,
	};
}

const probeOf =
	(processes: Record<number, ProcessInfo>) =>
	async (pids: number[]): Promise<Map<number, ProcessInfo>> =>
		new Map(pids.filter((pid) => processes[pid] !== undefined).map((pid) => [pid, processes[pid]!]));

describe("the lock's folder", () => {
	const dirOf = () => mkdtempSync(join(tmpdir(), "fwlock-"));

	test("is taken once, read back, changed and freed only under its own token", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			expect(store.where).toBe(join(dir, "studio-lock"));
			expect(await store.read()).toEqual({ kind: "free" });

			const first = owner();
			expect(await store.take(first)).toBe(true);
			expect(await store.take(owner({ token: "token-b" }))).toBe(false);
			expect(await store.read()).toEqual({ kind: "held", owner: first });

			expect(await store.update("token-a", { studioPid: 4001, mcpId: "abc", kept: true })).toBe(true);
			expect(await store.update("token-b", { studioPid: 1 })).toBe(false);
			// A field given as undefined is removed.
			expect(await store.update("token-a", { kept: undefined })).toBe(true);
			const read = await store.read();
			expect(read.kind === "held" && read.owner.studioPid).toBe(4001);
			expect(read.kind === "held" && "kept" in read.owner).toBe(false);

			expect(await store.free("token-b")).toBe(false);
			expect(await store.free("token-a")).toBe(true);
			expect(await store.read()).toEqual({ kind: "free" });
			expect(await store.update("token-a", { studioPid: 1 })).toBe(false);
			expect(await store.free("token-a")).toBe(false);
			// Nothing is left behind: no folder set aside, no half-written record.
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a folder with no record is being taken, and is freed only as such", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			mkdirSync(join(dir, "studio-lock"));
			const record = await store.read();
			expect(record.kind).toBe("unreadable");
			expect(await store.take(owner())).toBe(false);
			// A record judged readable is not freed in its place.
			expect(await store.free("token-a")).toBe(false);
			expect((await store.read()).kind).toBe("unreadable");
			expect(await store.free(undefined)).toBe(true);
			expect(await store.read()).toEqual({ kind: "free" });

			// An unreadable record is aged by its folder.
			mkdirSync(join(dir, "studio-lock"));
			writeFileSync(join(dir, "studio-lock", "owner.json"), "{ half");
			const old = (Date.now() - 120_000) / 1000;
			utimesSync(join(dir, "studio-lock"), old, old);
			const aged = await store.read();
			expect(aged.kind === "unreadable" && aged.ageMs).toBeGreaterThan(UNREADABLE_GRACE_MS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("freeing the lock someone took after it was judged gives it back", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			await store.take(owner({ token: "judged" }));
			// Judged stale by one command, freed and taken anew by another meanwhile.
			await store.free("judged");
			await store.take(owner({ token: "fresh" }));
			expect(await store.free("judged")).toBe(false);
			const record = await store.read();
			expect(record.kind === "held" && record.owner.token).toBe("fresh");
			expect(readdirSync(dir)).toEqual(["studio-lock"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("forgets the notes asked, and a note half written by a killed process once it is old", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			const entry = (token: string) => ({
				owner: owner({ token }),
				closedAt: iso(Date.now()),
				reason: "gone" as const,
				idleMinutes: 0,
				by: { project: "D:\\other", command: "test" },
			});
			await store.recordClosed(entry("one"));
			await store.recordClosed(entry("two"));
			const half = join(dir, "closed", "three.json.123.abcd.tmp");
			writeFileSync(half, "{ half");
			const old = (Date.now() - LEFTOVER_STALE_MS - 5_000) / 1000;
			utimesSync(half, old, old);
			const fresh = join(dir, "closed", "four.json.124.abcd.tmp");
			writeFileSync(fresh, "{ being written");
			await store.forgetClosed(["one", "../studio-lock"]);
			expect((await store.closedWindows()).map((closed) => closed.owner.token)).toEqual(["two"]);
			expect(readdirSync(join(dir, "closed")).sort()).toEqual(["four.json.124.abcd.tmp", "two.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("remembers the windows closed for another project, newest first, for a day", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			expect(await store.closedWindows()).toEqual([]);
			const entry = (token: string, closedAt: number) => ({
				owner: owner({ token }),
				closedAt: iso(closedAt),
				reason: "expired" as const,
				idleMinutes: 20,
				by: { project: "D:\\other", command: "test" },
			});
			await store.recordClosed(entry("older", Date.now() - 60_000));
			await store.recordClosed(entry("newer", Date.now()));
			await store.recordClosed(entry("gone", Date.now() - CLOSED_MEMORY_MS - 60_000));
			expect((await store.closedWindows()).map((closed) => closed.owner.token)).toEqual(["newer", "older"]);
			// The one past a day is forgotten.
			expect(readdirSync(join(dir, "closed")).sort()).toEqual(["newer.json", "older.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("judging the lock", () => {
	const studio = { name: "RobloxStudioBeta", startedAt: T0 - 60_000 };
	const cli = { name: "bun", startedAt: T0 - 60_000 };
	const launched = owner({ studioPid: 4001, studioStartedAt: iso(T0 - 60_000), mcpId: "abc", kept: true });

	test("free, and a record being taken: live for a while, then stale", async () => {
		expect(await judgeLock({ kind: "free" }, T0, probeOf({}))).toEqual({ state: "free" });
		expect((await judgeLock({ kind: "unreadable", ageMs: 1000 }, T0, probeOf({}))).state).toBe("live");
		expect((await judgeLock({ kind: "unreadable", ageMs: UNREADABLE_GRACE_MS + 1 }, T0, probeOf({}))).state).toBe(
			"stale",
		);
	});

	test("a window that runs is live within its hold and expired past it, whether its command is still going or not", async () => {
		const live = await judgeLock({ kind: "held", owner: launched }, T0, probeOf({ 4001: studio }));
		expect(live).toMatchObject({ state: "live", window: "running", cli: "gone", idleMs: 60_000 });
		const going = await judgeLock({ kind: "held", owner: launched }, T0, probeOf({ 4001: studio, 9001: cli }));
		expect(going).toMatchObject({ state: "live", cli: "running" });
		const expired = await judgeLock({ kind: "held", owner: launched }, T0 + 15 * 60_000, probeOf({ 4001: studio }));
		expect(expired).toMatchObject({ state: "expired", window: "running", idleMs: 16 * 60_000 });
	});

	test("a window that has closed, or whose PID is another process now, is stale", async () => {
		expect(await judgeLock({ kind: "held", owner: launched }, T0, probeOf({}))).toMatchObject({
			state: "stale",
			window: "gone",
		});
		expect(
			await judgeLock(
				{ kind: "held", owner: launched },
				T0,
				probeOf({ 4001: { name: "notepad", startedAt: T0 } }),
			),
		).toMatchObject({ state: "stale", window: "reused", reusedBy: "notepad" });
		// Another Studio under the same PID, started well after the one launched: the user's own.
		expect(
			await judgeLock(
				{ kind: "held", owner: launched },
				T0,
				probeOf({ 4001: { name: "RobloxStudioBeta", startedAt: T0 - 60_000 + START_TOLERANCE_MS + 1 } }),
			),
		).toMatchObject({ state: "stale", window: "reused" });
		// Even past its hold: what has gone is stale, not expired.
		expect((await judgeLock({ kind: "held", owner: launched }, T0 + 60 * 60_000, probeOf({}))).state).toBe("stale");
	});

	test("the command that took it is judged by a tighter start time than Studio: another bun given its PID is told apart", async () => {
		const window = { name: "RobloxStudioBeta", startedAt: T0 - 60_000 + 10_000 };
		// Ten seconds off: the same Studio still, but another bun.
		const view = await judgeLock(
			{ kind: "held", owner: launched },
			T0,
			probeOf({ 4001: window, 9001: { name: "bun", startedAt: T0 - 60_000 + 10_000 } }),
		);
		expect(view).toMatchObject({ window: "running", cli: "reused", cliReusedBy: "bun", state: "live" });
		const same = await judgeLock(
			{ kind: "held", owner: launched },
			T0,
			probeOf({ 4001: window, 9001: { name: "bun", startedAt: T0 - 60_000 + 2_000 } }),
		);
		expect(same.cli).toBe("running");
	});

	test("while the command that took it runs, it is live: before the launch, between two windows, past its hold", async () => {
		const taking = owner();
		expect((await judgeLock({ kind: "held", owner: taking }, T0, probeOf({ 9001: cli }))).state).toBe("live");
		expect(await judgeLock({ kind: "held", owner: taking }, T0, probeOf({}))).toMatchObject({
			state: "stale",
			cli: "gone",
		});
		expect(
			await judgeLock({ kind: "held", owner: taking }, T0, probeOf({ 9001: { name: "node", startedAt: T0 } })),
		).toMatchObject({ state: "stale", cli: "reused", cliReusedBy: "node" });
		// A command running is using the lock, whatever its lease says (a machine that slept, say).
		expect((await judgeLock({ kind: "held", owner: taking }, T0 + 20 * 60_000, probeOf({ 9001: cli }))).state).toBe(
			"live",
		);
		// A test whose window has just closed, before its record says so, and before the next
		// project's window opens: still its own (another project's poll in that gap took it before).
		const running = owner({ command: "test", studioPid: 4001, studioStartedAt: iso(T0 - 60_000) });
		expect(await judgeLock({ kind: "held", owner: running }, T0, probeOf({ 9001: cli }))).toMatchObject({
			state: "live",
			cli: "running",
			window: "gone",
		});
	});

	test("a window its command did not mean to leave open, once that command has ended, may be closed at once", async () => {
		// A plain test cut off by a second Ctrl+C, or killed: its window is still open, its run is not.
		const left = owner({ command: "test", studioPid: 4001, studioStartedAt: iso(T0 - 60_000) });
		expect(await judgeLock({ kind: "held", owner: left }, T0, probeOf({ 4001: studio }))).toMatchObject({
			state: "expired",
			abandoned: true,
			window: "running",
			cli: "gone",
		});
		// Its window gone too: nothing holds it.
		expect((await judgeLock({ kind: "held", owner: left }, T0, probeOf({}))).state).toBe("stale");
		// A window left open on purpose holds it under its lease instead.
		expect(
			await judgeLock({ kind: "held", owner: { ...left, kept: true } }, T0, probeOf({ 4001: studio })),
		).toMatchObject({ state: "live" });
		expect(
			(await judgeLock({ kind: "held", owner: { ...left, kept: true } }, T0, probeOf({ 4001: studio })))
				.abandoned,
		).toBeUndefined();
	});

	test("a process is the one recorded by its name and its start time, within the tolerance; unknowns pass", () => {
		const at = iso(T0);
		expect(fateOf(undefined, "bun", at)).toBe("gone");
		expect(fateOf({ name: "BUN", startedAt: T0 + 500 }, "bun", at)).toBe("running");
		expect(fateOf({ name: "bun", startedAt: T0 + START_TOLERANCE_MS + 1 }, "bun", at)).toBe("reused");
		expect(
			fateOf({ name: "bun", startedAt: T0 + CLI_START_TOLERANCE_MS + 1 }, "bun", at, CLI_START_TOLERANCE_MS),
		).toBe("reused");
		expect(fateOf({ name: "RobloxStudioBeta" }, /^RobloxStudio/i, at)).toBe("running");
		expect(fateOf({}, "bun", at)).toBe("running");
		expect(fateOf({ name: "x", startedAt: T0 }, undefined, undefined)).toBe("running");
	});
});

describe.skipIf(process.platform !== "win32")("looking processes up, for real", () => {
	test("this process is found by its name and start time; a PID nothing runs under is missing", async () => {
		const self = process.pid;
		const found = await probeProcesses([self, 999_999_9, self]);
		expect([...found.keys()]).toEqual([self]);
		const info = found.get(self)!;
		expect(info.name?.toLowerCase()).toBe("bun");
		// What the CLI records for itself is within the (CLI's, tighter) tolerance of what Windows says.
		const recorded = Date.now() - process.uptime() * 1000;
		expect(Math.abs(info.startedAt! - recorded)).toBeLessThan(CLI_START_TOLERANCE_MS);
		expect(await probeProcesses([])).toEqual(new Map());
	}, 60_000);
});

describe("where the lock lives", () => {
	test("a per-user folder, never the temp folder; FLAMEWORK_TEST_STATE_DIR moves it", () => {
		const home = join("C:", "Users", "me");
		expect(
			stateDirOf({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", TEMP: "C:\\agent\\temp" }, "win32", home),
		).toBe(join("C:\\Users\\me\\AppData\\Local", "flamework-test"));
		// No LOCALAPPDATA (or an empty one): the same folder, from the home folder.
		expect(stateDirOf({ LOCALAPPDATA: "" }, "win32", home)).toBe(join(home, "AppData", "Local", "flamework-test"));
		expect(stateDirOf({ FLAMEWORK_TEST_STATE_DIR: "some/where", LOCALAPPDATA: "C:\\x" }, "win32", home)).toBe(
			resolve("some/where"),
		);
		expect(stateDirOf({}, "darwin", "/Users/me")).toBe(
			join("/Users/me", "Library", "Application Support", "flamework-test"),
		);
		expect(stateDirOf({ XDG_STATE_HOME: "/var/state/me" }, "linux", "/home/me")).toBe(
			join("/var/state/me", "flamework-test"),
		);
		expect(stateDirOf({ XDG_STATE_HOME: "relative" }, "linux", "/home/me")).toBe(
			join("/home/me", ".local", "state", "flamework-test"),
		);
		expect(stateDirOf({}, "linux", "/home/me")).toBe(join("/home/me", ".local", "state", "flamework-test"));
	});
});

describe("the sub-lock every change takes", () => {
	const dirOf = () => mkdtempSync(join(tmpdir(), "fwmutex-"));

	const mutexOf = (dir: string) => join(dir, "studio-lock.mutex");
	/** A sub-lock as a process holds it, named in it, made `ageMs` ago. */
	const heldBy = (
		dir: string,
		holder: { pid: number; token: string; name?: string; startedAt?: number },
		ageMs = 0,
	) => {
		mkdirSync(mutexOf(dir));
		writeFileSync(join(mutexOf(dir), "holder.json"), JSON.stringify(holder));
		const at = (Date.now() - ageMs) / 1000;
		utimesSync(mutexOf(dir), at, at);
	};

	test("one that names no process (its maker died at once, or an older flamework-test's) is broken once old", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			mkdirSync(join(dir, "studio-lock.mutex"));
			const old = (Date.now() - MUTEX_STALE_MS - 5_000) / 1000;
			utimesSync(join(dir, "studio-lock.mutex"), old, old);
			expect(await store.take(owner())).toBe(true);
			expect(await store.update("token-a", { mcpId: "x" })).toBe(true);
			expect(await store.free("token-a")).toBe(true);
			// Nothing is left: no sub-lock, no folder set aside.
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("one whose process has gone is broken at once, however young", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir, { isAlive: (pid) => pid !== 4242 });
			heldBy(dir, { pid: 4242, token: "dead" });
			const started = Date.now();
			expect(await store.take(owner())).toBe(true);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(readdirSync(dir)).toEqual(["studio-lock"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("one whose process runs is waited for, however old: a slow holder is never broken", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir, { isAlive: () => true });
			heldBy(dir, { pid: 4343, token: "slow" }, MUTEX_STALE_MS + 60_000);
			const started = Date.now();
			setTimeout(() => rmSync(mutexOf(dir), { recursive: true, force: true }), 400);
			expect(await store.take(owner())).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(350);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("with a probe, one whose PID is another process now (by its start time) is broken once old; its own is waited for", async () => {
		const dir = dirOf();
		try {
			const startedAt = Date.now() - 600_000;
			const looked: number[][] = [];
			const store = (later: number) =>
				fileLockStore(dir, {
					isAlive: () => true,
					probe: async (pids) => {
						looked.push(pids);
						return new Map([[4343, { name: "bun", startedAt: startedAt + later }]]);
					},
				});
			heldBy(dir, { pid: 4343, token: "reused", name: "bun", startedAt }, MUTEX_STALE_MS + 1_000);
			expect(await store(CLI_START_TOLERANCE_MS + 30_000).take(owner())).toBe(true);
			expect(looked).toEqual([[4343]]);
			await store(0).free("token-a");

			// The same process still, within the tolerance: waited for, and looked up once only.
			looked.length = 0;
			heldBy(dir, { pid: 4343, token: "same", name: "bun", startedAt }, MUTEX_STALE_MS + 1_000);
			setTimeout(() => rmSync(mutexOf(dir), { recursive: true, force: true }), 400);
			const started = Date.now();
			expect(await store(1_000).take(owner())).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(350);
			expect(looked).toEqual([[4343]]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a hold lets go of its own sub-lock only: one another process made meanwhile is left", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			await store.take(owner());
			// Inside the sub-lock (while the record is written), this hold's sub-lock is replaced by
			// another's, as if it had been broken: what this hold lets go of must not be that one.
			const swap = {
				toJSON: () => {
					rmSync(mutexOf(dir), { recursive: true, force: true });
					heldBy(dir, { pid: process.pid, token: "another" });
					return "x";
				},
			};
			expect(await store.update("token-a", { mcpId: swap as unknown as string })).toBe(true);
			expect(existsSync(mutexOf(dir))).toBe(true);
			expect(JSON.parse(readFileSync(join(mutexOf(dir), "holder.json"), "utf8")).token).toBe("another");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a taker removes what killed processes left set aside: a dead one's at once, a live one's once old", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir, { isAlive: (pid) => pid === 2222 });
			const old = (Date.now() - LEFTOVER_STALE_MS - 5_000) / 1000;
			const made = (name: string, aged = false) => {
				mkdirSync(join(dir, name), { recursive: true });
				writeFileSync(join(dir, name, "holder.json"), "{}");
				if (aged) utimesSync(join(dir, name), old, old);
			};
			made("studio-lock.mutex.done-1111-6e8378ca");
			made("studio-lock.mutex.stale-1111-0a0b0c0d");
			made("studio-lock.free-1111-beba2a28");
			made("studio-lock.mutex.done-2222-aad20d01");
			made("studio-lock.free-2222-7df8f771", true);
			writeFileSync(join(dir, "0123456789abcdef.claim"), "1111");
			expect(await store.take(owner())).toBe(true);
			expect(readdirSync(dir).sort()).toEqual([
				"0123456789abcdef.claim",
				"studio-lock",
				"studio-lock.mutex.done-2222-aad20d01",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("one held by another change is waited for", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			mkdirSync(join(dir, "studio-lock.mutex"));
			const started = Date.now();
			setTimeout(() => rmSync(join(dir, "studio-lock.mutex"), { recursive: true, force: true }), 300);
			expect(await store.take(owner())).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("changes made at once in one process take turns, and each sees the last", async () => {
		const dir = dirOf();
		try {
			const store = fileLockStore(dir);
			await store.take(owner());
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, index) => store.update("token-a", { mcpId: String(index) })),
			);
			expect(results.every(Boolean)).toBe(true);
			const read = await store.read();
			expect(read.kind === "held" && read.owner.mcpId).toBe("19");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
