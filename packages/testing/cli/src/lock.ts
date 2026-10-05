/**
 * The Studio lock: one Studio window opened through flamework-test at a time on this machine,
 * across projects and agents. A command that opens a window (`test`, `studio open`) takes it
 * before it launches Studio, and the window holds it while it is open; every other command that
 * would open one waits its turn.
 *
 * The lock is a folder (`mkdir` either makes it or finds it there, atomically) holding the owner
 * record, `owner.json`: who took it, the Studio process it launched, the window's MCP id, the
 * project, the place and the lease. Every change to it (taking, renewing, freeing) is made under a
 * short sub-lock of its own, so a renewal never lands on the record of a command that took the
 * lock over a moment before. The sub-lock names the process holding it, and is broken only once
 * that process has gone: a holder that is slow, not dead, is waited for.
 *
 * While the command that took it runs, the lock is live, window or not (a `test` closes one
 * project's window before it opens the next). Once that command has ended, a window it left open on
 * purpose (`kept`: `test --keep`, `studio open`) holds the lock under a lease, an idle timeout that
 * every command using the window renews; once the lease has run out another project may close that
 * window (it is flamework-test's own, known by the Studio PID the record names) and take the lock.
 * A window left open by a command that ended without meaning to (a second Ctrl+C) may be closed at
 * once.
 *
 * A lock whose holder has gone is stale and is taken over: its command has ended and the Studio
 * process it names has exited (closed by hand, say) or is another process now, or no window was
 * open. A PID Windows has reused is told apart by the process's name and its start time, which the
 * record keeps.
 *
 * It lives in a per-user folder every project and agent shares, never the temp folder, which an
 * agent's harness may set per agent: `%LOCALAPPDATA%\flamework-test` on Windows (see
 * {@link stateDirOf}). A window opened by an older flamework-test, or by hand, holds no lock.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The owner record, `owner.json` in the lock's folder. Times are ISO strings. */
export interface LockOwner {
	version: 1;
	/** Tells this holder from the next one: a record is changed or freed only under its own token. */
	token: string;
	/** The flamework-test process that took the lock, its name (`bun`) and when it started. */
	cliPid: number;
	cliName?: string;
	cliStartedAt?: string;
	/** The Studio process flamework-test launched, once launched, and when it started. */
	studioPid?: number;
	studioStartedAt?: string;
	/** The window's id on the MCP proxy, once it has connected. */
	mcpId?: string;
	/**
	 * The project directory: the nearest folder holding a flamework.config.json, else the nearest
	 * holding a package.json, else where the command ran.
	 */
	project: string;
	/** The command that took it: `test`, `test --keep`, `studio open`. */
	command: string;
	/** What the window has open, as people read it: a place file's path, or `the testing place <id>`. */
	place: string;
	/** The place file Studio was launched on, which closing the window by its process checks. */
	placeFile?: string;
	/** The cloud place's id Studio was launched on, for the same. */
	placeId?: string;
	since: string;
	/** When the window was last used through flamework-test; the lease runs from here. */
	lastActivity: string;
	/** When the lease runs out: `lastActivity` plus the hold. */
	expires: string;
	/** The idle timeout of this window, in minutes. */
	holdMinutes: number;
	/**
	 * The window is left open on purpose when the command that took the lock ends (`test --keep`,
	 * `studio open`, set when it launches Studio; or a window that would not close), and holds the
	 * lock under its lease then. Without it, a window still open once that command has ended was
	 * left behind by a command cut short.
	 */
	kept?: boolean;
}

/** What the lock's folder holds. */
export type LockRecord =
	| { kind: "free" }
	| { kind: "held"; owner: LockOwner }
	/** A folder with no record that can be read: being taken right now, or left by a run that died taking it. */
	| { kind: "unreadable"; ageMs: number };

/** A window another project's command closed, so its owner's next command can say why it is gone. */
export interface ClosedWindowRecord {
	/** The owner record the window had when it was closed. */
	owner: LockOwner;
	closedAt: string;
	/**
	 * `expired`: idle past its hold; `abandoned`: the command that opened it had ended without
	 * closing it, or meaning to leave it open; `forced`: `studio unlock --force`; `gone`: it was found
	 * closed already (closed by hand, or Studio exited), and its lock was taken over or freed.
	 */
	reason: "expired" | "abandoned" | "forced" | "gone";
	/** How long it had been idle, in minutes. */
	idleMinutes: number;
	/** Who closed it. */
	by: { project: string; command: string };
}

/** Where the lock is kept, and the operations on it. Injected, so the CLI's tests keep it in memory. */
export interface LockStore {
	/** The lock's folder, for messages. */
	readonly where: string;
	/** Takes the lock if nothing holds it, live or not; false when something does. */
	take: (owner: LockOwner) => Promise<boolean>;
	read: () => Promise<LockRecord>;
	/**
	 * Changes fields of the record while `token` still holds the lock; false when it no longer does.
	 * A field given as `undefined` is removed.
	 */
	update: (token: string, patch: Partial<LockOwner>) => Promise<boolean>;
	/**
	 * Frees the lock while `token` still holds it (`undefined`: while its record cannot be read);
	 * false when something else holds it now.
	 */
	free: (token: string | undefined) => Promise<boolean>;
	/** Remembers a window closed for another project's sake, so its owner's next command can say so. */
	recordClosed: (entry: ClosedWindowRecord) => Promise<void>;
	/** The windows closed so within the last day, newest first. */
	closedWindows: () => Promise<ClosedWindowRecord[]>;
	/**
	 * Forgets the notes of these windows (by their owner's token): those of a project that has taken
	 * the lock again since, whose next command has a window of its own to speak of.
	 */
	forgetClosed: (tokens: string[]) => Promise<void>;
}

/** How long a record that cannot be read is taken for one being written, before it is stale. */
export const UNREADABLE_GRACE_MS = 30_000;
/** How long a closed window is remembered for its owner's next command. */
export const CLOSED_MEMORY_MS = 24 * 60 * 60 * 1000;
/**
 * How old a sub-lock that names no process may be before it is taken for one whose maker died
 * between making it and naming itself in it (a moment), or one an older flamework-test left, which
 * names none. A sub-lock that names its process is broken only once that process has gone, however
 * old it is; it is looked up by its start time too once it is this old, in case its PID is another
 * process's now. A change holds it for milliseconds.
 */
export const MUTEX_STALE_MS = 5_000;
/** How long a change waits for the sub-lock before it gives up, saying so. */
export const MUTEX_WAIT_MS = 15_000;
/**
 * How old a folder a process set aside (a sub-lock it let go of or broke, a lock it freed) may be
 * before the next taker removes it as left by a process killed between moving it and removing it.
 * One is removed within milliseconds otherwise.
 */
export const LEFTOVER_STALE_MS = 60_000;

/** The variable that moves the lock's folder (and the window-name claims): for tests, and setups where the default does not fit. */
export const STATE_DIR_VARIABLE = "FLAMEWORK_TEST_STATE_DIR";

/**
 * The per-user folder the Studio lock, the notes of windows closed for another project and the
 * window-name claims live in, which every project and agent of this user shares:
 * `FLAMEWORK_TEST_STATE_DIR` when set; else `%LOCALAPPDATA%\flamework-test` on Windows,
 * `~/Library/Application Support/flamework-test` on macOS, and `$XDG_STATE_HOME/flamework-test`
 * (`~/.local/state/flamework-test`) elsewhere. Never the temp folder: an agent's harness may give
 * each agent a temp folder of its own, which would give each its own lock.
 *
 * The variable is read from the process's environment, and every project has to agree on it, so it
 * is not one of the settings flamework-test reads from the `.env` files next to
 * flamework.config.json. Bun itself, though, loads a `.env` (and `.env.local`) from the folder a
 * command runs in into that environment before any of this code runs, where it cannot be told from
 * the shell's; and the bin, run as `bun cli.ts`, has no way to pass Bun the flag that turns that
 * off. So it is documented as such: set it in the shell, never in a project's `.env`.
 */
export function stateDirOf(
	env: Record<string, string | undefined>,
	platform: string = process.platform,
	home: string = homedir(),
): string {
	const set = (value: string | undefined) => (value !== undefined && value.trim() !== "" ? value : undefined);
	const override = set(env[STATE_DIR_VARIABLE]);
	if (override !== undefined) return resolve(override);
	if (platform === "win32") return join(set(env.LOCALAPPDATA) ?? join(home, "AppData", "Local"), "flamework-test");
	if (platform === "darwin") return join(home, "Library", "Application Support", "flamework-test");
	const xdg = set(env.XDG_STATE_HOME);
	return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "flamework-test");
}

const OWNER_FILE = "owner.json";

/** A new token. */
export function newToken(): string {
	return randomBytes(12).toString("hex");
}

/** Retries a file operation Windows refuses for a moment while another process has the file open. */
function retrying<T>(action: () => T): T {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return action();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
			// A busy wait of a few milliseconds: these calls are synchronous, and the hold is that short.
			const until = Date.now() + 10;
			while (Date.now() < until) {
				// waiting
			}
		}
	}
}

/** Writes a file whole or not at all: a reader never sees half a record. */
function writeAtomically(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temporary, text);
	try {
		retrying(() => renameSync(temporary, path));
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readOwner(folder: string): LockOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(folder, OWNER_FILE), "utf8")) as LockOwner;
		return typeof parsed === "object" && parsed !== null && typeof parsed.token === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const pause = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** The file in the sub-lock's folder that names the process holding it. */
const MUTEX_HOLDER_FILE = "holder.json";

/** Who holds the sub-lock: its process (PID, name, start time), and a token of that one hold. */
interface MutexHolder {
	pid: number;
	name?: string;
	/** Milliseconds since the epoch. */
	startedAt?: number;
	token: string;
}

/** How a sub-lock's holder is told to have gone; see {@link FileLockOptions}. */
interface MutexJudge {
	isAlive: (pid: number) => boolean;
	probe?: ProbeProcesses;
	/** What the processes already looked up by start time were found to be, by the token of their hold. */
	looked: Map<string, ProcessFate>;
}

function readMutexHolder(folder: string): MutexHolder | undefined {
	try {
		const parsed = JSON.parse(retrying(() => readFileSync(join(folder, MUTEX_HOLDER_FILE), "utf8"))) as MutexHolder;
		return typeof parsed === "object" &&
			parsed !== null &&
			Number.isInteger(parsed.pid) &&
			typeof parsed.token === "string"
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

/** Whether a process is running; signal 0 only asks. */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Runs `body` holding the sub-lock `mutex`, a folder that `mkdir` makes or finds there, atomically:
 * every change to the lock is made under it, so none interleaves with another. The folder names the
 * process holding it, and is broken only once that process has gone (see {@link breakDeadMutex}):
 * a holder that is slow, not dead, is waited for, up to {@link MUTEX_WAIT_MS}.
 */
async function withMutex<T>(mutex: string, body: () => T, judge: MutexJudge): Promise<T> {
	const deadline = Date.now() + MUTEX_WAIT_MS;
	const self: MutexHolder = {
		pid: process.pid,
		name: basename(process.execPath).replace(/\.exe$/i, ""),
		startedAt: Date.now() - process.uptime() * 1000,
		token: randomBytes(8).toString("hex"),
	};
	for (;;) {
		try {
			mkdirSync(mutex);
			try {
				writeFileSync(join(mutex, MUTEX_HOLDER_FILE), JSON.stringify(self));
			} catch (error) {
				rmSync(mutex, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// EPERM and EACCES: Windows, while a folder of that name is being removed.
			if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
			if (Date.now() > deadline) {
				const holder = readMutexHolder(mutex);
				throw new Error(
					`the Studio lock stayed busy for ${MUTEX_WAIT_MS / 1000}s (${mutex} is held${holder !== undefined ? ` by PID ${holder.pid}, which is still running` : ""}, ${code}); if no flamework-test is running, delete that folder`,
				);
			}
		}
		await breakDeadMutex(mutex, judge);
		await pause(2 + Math.floor(Math.random() * 8));
	}
	try {
		return body();
	} finally {
		releaseMutex(mutex, self.token);
	}
}

/**
 * Lets go of the sub-lock: moved aside first, so its name is free at once, then removed. Only this
 * hold's own (`token`): one that names another holder was made after this one was broken, which it
 * never is while this process runs, and is not this one's to remove.
 */
function releaseMutex(mutex: string, token: string): void {
	if (readMutexHolder(mutex)?.token !== token) return;
	const aside = `${mutex}.done-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		retrying(() => renameSync(mutex, aside));
	} catch {
		return;
	}
	rmSync(aside, { recursive: true, force: true });
}

/**
 * Breaks a sub-lock whose holder has gone: the process it names is not running, or, once it is
 * {@link MUTEX_STALE_MS} old, runs under another name or start time (its PID is another process's
 * now; looked up once per hold, and only with `judge.probe`). One that names no process is broken
 * once it is that old: its maker died between making it and naming itself in it, or it is an older
 * flamework-test's, which names none. A holder that runs is never broken, however slow it is.
 *
 * Moving it aside is what only one process can do; one found to be another hold once moved (made
 * between the look and the move) is put back.
 */
async function breakDeadMutex(mutex: string, judge: MutexJudge): Promise<void> {
	let ageMs: number;
	try {
		ageMs = Date.now() - statSync(mutex).mtimeMs;
	} catch {
		return;
	}
	const holder = readMutexHolder(mutex);
	if (holder === undefined) {
		if (ageMs < MUTEX_STALE_MS) return;
	} else if (judge.isAlive(holder.pid)) {
		if (ageMs < MUTEX_STALE_MS || judge.probe === undefined) return;
		let fate = judge.looked.get(holder.token);
		if (fate === undefined) {
			try {
				const info = (await judge.probe([holder.pid])).get(holder.pid);
				const started = holder.startedAt !== undefined ? new Date(holder.startedAt).toISOString() : undefined;
				fate = fateOf(info, holder.name, started, CLI_START_TOLERANCE_MS);
			} catch {
				// Not known: a running holder is waited for.
				fate = "running";
			}
			judge.looked.set(holder.token, fate);
		}
		if (fate === "running") return;
	}
	// Still the one judged, and not one made since.
	if (readMutexHolder(mutex)?.token !== holder?.token) return;
	const aside = `${mutex}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(mutex, aside);
	} catch {
		return;
	}
	if (readMutexHolder(aside)?.token !== holder?.token) {
		try {
			renameSync(aside, mutex);
		} catch {
			// Another was made meanwhile: the hold set aside finds the name another's when it lets go,
			// and leaves it; the next taker removes what is left aside.
		}
		return;
	}
	rmSync(aside, { recursive: true, force: true });
}

/** What a process sets aside for a moment, named with its PID: a sub-lock it let go of or broke, a lock it freed. */
const SET_ASIDE = /^studio-lock(?:\.mutex\.(?:done|stale)|\.free)-(\d+)-[0-9a-f]+$/;

/**
 * Removes what processes killed at the wrong moment left beside the lock: a folder set aside and
 * never removed, once its process has gone or it is {@link LEFTOVER_STALE_MS} old (a process
 * removes its own within milliseconds). Called by a taker, under the sub-lock. The window-name
 * claims beside them are left to their next claimant, which takes over one whose process has gone:
 * removing one here could race with a claimant replacing it.
 */
function sweepLeftovers(dir: string, isAlive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const match = SET_ASIDE.exec(name);
		if (match === null) continue;
		const path = join(dir, name);
		try {
			if (isAlive(Number(match[1])) && Date.now() - statSync(path).mtimeMs < LEFTOVER_STALE_MS) continue;
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Removed by another taker meanwhile, or still held for a moment: the next taker tries again.
		}
	}
}

/** Options of {@link fileLockStore}. */
export interface FileLockOptions {
	/** Whether a process runs under a PID; by default `process.kill(pid, 0)`. */
	isAlive?: (pid: number) => boolean;
	/**
	 * Looks a sub-lock's holder up by its name and start time once the sub-lock is
	 * {@link MUTEX_STALE_MS} old, to tell it from another process given its PID since. Without it, a
	 * running PID is taken for the holder (and the wait gives up after {@link MUTEX_WAIT_MS}, saying
	 * which folder to delete).
	 */
	probe?: ProbeProcesses;
}

/**
 * The lock kept in a folder of `dir`, `studio-lock`, with the windows closed for being idle
 * remembered beside it, in `closed`, and the sub-lock every change takes, `studio-lock.mutex`.
 * `dir` is per user and shared by every project: {@link stateDirOf}.
 */
export function fileLockStore(dir: string, options: FileLockOptions = {}): LockStore {
	const folder = join(dir, "studio-lock");
	const mutex = `${folder}.mutex`;
	const closed = join(dir, "closed");
	const isAlive = options.isAlive ?? isRunning;
	const judge: MutexJudge = {
		isAlive,
		...(options.probe !== undefined ? { probe: options.probe } : {}),
		looked: new Map(),
	};
	const locked = <T>(body: () => T): Promise<T> => {
		mkdirSync(dir, { recursive: true });
		return withMutex(mutex, body, judge);
	};

	/**
	 * Moves the lock's folder aside, so that a reader sees it held or free and never half removed,
	 * and removes it when it still holds the record judged (`token`); anything else is moved back.
	 * Called under the sub-lock, so nothing can take the lock in between.
	 */
	const breakFolder = (token: string | undefined): boolean => {
		const aside = `${folder}.free-${process.pid}-${randomBytes(4).toString("hex")}`;
		try {
			retrying(() => renameSync(folder, aside));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (readOwner(aside)?.token !== token) {
			try {
				renameSync(aside, folder);
			} catch {
				rmSync(aside, { recursive: true, force: true });
			}
			return false;
		}
		rmSync(aside, { recursive: true, force: true });
		return true;
	};

	return {
		where: folder,
		take: (owner) =>
			locked(() => {
				try {
					mkdirSync(folder);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
					throw error;
				}
				try {
					writeAtomically(join(folder, OWNER_FILE), `${JSON.stringify(owner, null, "\t")}\n`);
				} catch (error) {
					// The folder went before its record was in it: not this taker's, so nothing of it is removed.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
					rmSync(folder, { recursive: true, force: true });
					throw error;
				}
				sweepLeftovers(dir, isAlive);
				return true;
			}),
		read: async () => {
			let made: number;
			try {
				made = statSync(folder).mtimeMs;
			} catch {
				return { kind: "free" };
			}
			const owner = readOwner(folder);
			if (owner !== undefined) return { kind: "held", owner };
			// Gone between the two looks, or still being written.
			try {
				statSync(folder);
			} catch {
				return { kind: "free" };
			}
			return { kind: "unreadable", ageMs: Math.max(0, Date.now() - made) };
		},
		update: (token, patch) =>
			locked(() => {
				const owner = readOwner(folder);
				if (owner === undefined || owner.token !== token) return false;
				const next: Record<string, unknown> = { ...owner };
				for (const [key, value] of Object.entries(patch)) {
					if (value === undefined) delete next[key];
					else next[key] = value;
				}
				try {
					writeAtomically(join(folder, OWNER_FILE), `${JSON.stringify(next, null, "\t")}\n`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
					throw error;
				}
				return true;
			}),
		free: (token) =>
			locked(() => {
				const owner = readOwner(folder);
				if (owner !== undefined && owner.token !== token) return false;
				return breakFolder(token);
			}),
		recordClosed: async (entry) => {
			mkdirSync(closed, { recursive: true });
			writeAtomically(join(closed, `${entry.owner.token}.json`), `${JSON.stringify(entry, null, "\t")}\n`);
		},
		closedWindows: async () => {
			let names: string[];
			try {
				names = readdirSync(closed);
			} catch {
				return [];
			}
			const entries: ClosedWindowRecord[] = [];
			for (const name of names) {
				const path = join(closed, name);
				if (!name.endsWith(".json")) {
					// A note half written by a process killed at that moment: one is written within milliseconds.
					try {
						if (name.endsWith(".tmp") && Date.now() - statSync(path).mtimeMs > LEFTOVER_STALE_MS) {
							rmSync(path, { force: true });
						}
					} catch {
						// Gone meanwhile.
					}
					continue;
				}
				try {
					const entry = JSON.parse(readFileSync(path, "utf8")) as ClosedWindowRecord;
					if (Date.now() - Date.parse(entry.closedAt) > CLOSED_MEMORY_MS) {
						rmSync(path, { force: true });
						continue;
					}
					entries.push(entry);
				} catch {
					// Being written, or not a record: skipped.
				}
			}
			return entries.sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
		},
		forgetClosed: async (tokens) => {
			for (const token of tokens) {
				// A token is hex, so it names a file in `closed` and nothing else.
				if (/^[0-9a-z-]+$/i.test(token)) rmSync(join(closed, `${token}.json`), { force: true });
			}
		},
	};
}

// ------------------------------------------------------------------ judging

/** What is known of a running process: its name (`RobloxStudioBeta`, `bun`) and when it started. */
export interface ProcessInfo {
	name?: string;
	/** Milliseconds since the epoch. */
	startedAt?: number;
}

/** Looks the processes up; a PID missing from the answer is not running. */
export type ProbeProcesses = (pids: number[]) => Promise<Map<number, ProcessInfo>>;

/**
 * How far a Studio process's start time may be from the one recorded when its PID was taken down:
 * the record takes the time the CLI saw the launch, a moment after Windows made the process.
 */
export const START_TOLERANCE_MS = 60_000;
/**
 * How far a flamework-test process's start time may be from the one it recorded for itself (its
 * clock less its uptime: measured 25 ms off what Windows says). Tighter than Studio's, since another
 * bun process is given a PID that has come free far more often than another Studio is.
 */
export const CLI_START_TOLERANCE_MS = 5_000;

/** Whether the process a record names is still that process. */
export type ProcessFate = "running" | "gone" | "reused";

/**
 * The process behind a recorded PID: gone when nothing runs under it; `reused` when what runs
 * under it now has another name, or started at another time, than the one recorded.
 */
export function fateOf(
	info: ProcessInfo | undefined,
	expectedName: RegExp | string | undefined,
	startedAt: string | undefined,
	toleranceMs: number = START_TOLERANCE_MS,
): ProcessFate {
	if (info === undefined) return "gone";
	if (info.name !== undefined && expectedName !== undefined) {
		const same =
			typeof expectedName === "string"
				? info.name.toLowerCase() === expectedName.toLowerCase()
				: expectedName.test(info.name);
		if (!same) return "reused";
	}
	if (info.startedAt !== undefined && startedAt !== undefined) {
		const recorded = Date.parse(startedAt);
		if (Number.isFinite(recorded) && Math.abs(info.startedAt - recorded) > toleranceMs) return "reused";
	}
	return "running";
}

/** Roblox Studio's process, as Windows names it. */
export const STUDIO_PROCESS = /^RobloxStudio/i;

/**
 * Where the lock stands:
 * - `free`: nothing holds it;
 * - `live`: the command that took it is still running (window or not), or, once it has ended, the
 *   window it left open on purpose is open and has been used within its hold;
 * - `expired`: another project may close the window and take the lock: a window left open on
 *   purpose, idle past its hold; or (`abandoned`) a window still open after the command that
 *   opened it ended without meaning to leave it (a second Ctrl+C, a killed process);
 * - `stale`: its holder has gone: the command has ended, and its window has closed, or its PID is
 *   another process now, or it had none open. The next taker takes it over.
 */
export interface LockView {
	state: "free" | "live" | "expired" | "stale";
	owner?: LockOwner;
	/** The Studio process the record names; undefined while it names none. */
	window?: ProcessFate;
	/** The flamework-test process that took it. */
	cli?: ProcessFate;
	/** What the running process under the window's PID is called, when it is another one. */
	reusedBy?: string;
	/** What the running process under the command's PID is called, when it is another one. */
	cliReusedBy?: string;
	/** Expired because its command ended leaving a window it did not mean to leave open. */
	abandoned?: boolean;
	/** Milliseconds since the window was last used. */
	idleMs?: number;
	/** For an unreadable record: how old its folder is. */
	unreadableMs?: number;
}

/** Judges a record at `now`, looking up the processes it names. */
export async function judgeLock(record: LockRecord, now: number, probe: ProbeProcesses): Promise<LockView> {
	if (record.kind === "free") return { state: "free" };
	if (record.kind === "unreadable") {
		return { state: record.ageMs > UNREADABLE_GRACE_MS ? "stale" : "live", unreadableMs: record.ageMs };
	}

	const owner = record.owner;
	const pids = [owner.cliPid, ...(owner.studioPid !== undefined ? [owner.studioPid] : [])];
	const found = await probe(pids);
	const cliInfo = found.get(owner.cliPid);
	const cli = fateOf(cliInfo, owner.cliName, owner.cliStartedAt, CLI_START_TOLERANCE_MS);
	const idleMs = Math.max(0, now - Date.parse(owner.lastActivity));
	let window: ProcessFate | undefined;
	let reusedBy: string | undefined;
	if (owner.studioPid !== undefined) {
		const info = found.get(owner.studioPid);
		window = fateOf(info, STUDIO_PROCESS, owner.studioStartedAt);
		if (window === "reused") reusedBy = info?.name;
	}
	const view: LockView = {
		state: "live",
		owner,
		cli,
		idleMs,
		...(window !== undefined ? { window } : {}),
		...(reusedBy !== undefined ? { reusedBy } : {}),
		...(cli === "reused" && cliInfo?.name !== undefined ? { cliReusedBy: cliInfo.name } : {}),
	};

	// The command that took it is still going, and using it: between one project's window and the
	// next, a window it is closing, or one it has yet to launch.
	if (cli === "running") return view;
	if (window !== "running") return { ...view, state: "stale" };
	if (owner.kept !== true) return { ...view, state: "expired", abandoned: true };
	return { ...view, state: now > Date.parse(owner.expires) ? "expired" : "live" };
}

/** The lease's two times from a moment of activity. */
export function leaseFrom(at: number, holdMinutes: number): { lastActivity: string; expires: string } {
	return {
		lastActivity: new Date(at).toISOString(),
		expires: new Date(at + holdMinutes * 60_000).toISOString(),
	};
}
