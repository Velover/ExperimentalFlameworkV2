/**
 * Whether a Studio process this run launched is signed in to Roblox, read from the log Studio writes
 * for every process (`%LOCALAPPDATA%\Roblox\logs\<version>_<time>_Studio_<id>_last.log`).
 *
 * A Studio that is not signed in shows its login dialog and never opens the file it was started
 * with, so its window never registers with the MCP proxy. On the hidden desktop nobody sees that
 * dialog: without this, a run would wait out `--connect-timeout` (3 minutes) for each such window.
 *
 * Studio signs in by itself at start-up (`login (automatic)`), from the session every Studio of the
 * user shares. Seen 2026-10-20 (Studio 0.743, hidden desktop): two windows `test --parallel 2`
 * launched in the same second after Studio had sat closed for two hours both signed in at once; one
 * succeeded, the other got 401 from `oauth/v1/userinfo`, failed (`Login error: 'Failed to fetch user
 * info'`), and "deleted and logged out the security cookies": the session every Studio shares, so
 * every Studio started after it showed its login dialog until the user signed in again. Hence
 * {@link signInOf}, which a run reads while it waits for its window, and the launches a run with
 * `--parallel` makes one at a time, each once the one before has signed in (see cli.ts).
 *
 * Only the lines below are looked for, and nothing of a log is ever printed or kept: it holds
 * request URLs and ids.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How a launched Studio's sign-in went: `signing-in` (started, not ended yet), `signed-in`, or
 * `signed-out`: its login dialog is showing, or its sign-in failed, which leaves it showing one.
 */
export type SignIn = "signing-in" | "signed-in" | "signed-out";

/** What a launched process's log says of its sign-in, and whether its log was found at all. */
export interface SignInReading {
	state: SignIn;
	/** The log it was read from, for the error to name. */
	log: string;
	/**
	 * What says `signed-out`: the login dialog showing, or a sign-in that failed, in a log
	 * that does not show the dialog (yet). Absent for the other states.
	 */
	cause?: "dialog" | "failure";
}

/** The line that names a log's process: `Constructing UIThreadNotifier for process '<pid>' ...`. */
const PROCESS_LINE = /UIThreadNotifier for process '(\d+)'/;
const SIGN_IN_STARTED = "[FLog::StudioKeyEvents] login (automatic) [start]";
const SIGNED_IN = "[FLog::StudioKeyEvents] login [end][success]";
const SIGN_IN_FAILED = "[FLog::StudioKeyEvents] login [end][failure]";
const LOGIN_DIALOG = "[FLog::StudioKeyEvents] show login dialog [start]";

/**
 * How much of a log is read: its start, where the sign-in is (within the first few seconds; a
 * failed one 4.6 s in, the login dialog 2 s in, measured; its end at up to 53 KB in the logs of
 * 2026-10-21). A log grows by megabytes over a long session.
 */
export const LOG_HEAD_BYTES = 128 * 1024;

/**
 * How much of a log is read for whose it is: the process line is within its first second, at up
 * to 5.3 KB in the logs of 2026-10-21.
 */
export const LOG_OWNER_BYTES = 16 * 1024;

/** The process a log is of, from its text; undefined when it does not say (yet). */
export function processOf(text: string): number | undefined {
	const match = PROCESS_LINE.exec(text);
	return match === null ? undefined : Number(match[1]);
}

/**
 * What a log's text says of its process's sign-in: the last word of it, whichever of a success, a
 * failure and the login dialog comes last (a sign-in that failed ends showing the dialog, and one
 * someone made there ends in a success); `signing-in` once it has started and none has come yet;
 * undefined when it has not started (or never does, as a Studio run by Studio itself for a play
 * session's server).
 */
export function signInFromLog(text: string): SignIn | undefined {
	return signInDetail(text)?.state;
}

/** {@link signInFromLog}, with what said `signed-out` (see {@link SignInReading.cause}). */
function signInDetail(text: string): { state: SignIn; cause?: "dialog" | "failure" } | undefined {
	const dialog = text.lastIndexOf(LOGIN_DIALOG);
	const failure = text.lastIndexOf(SIGN_IN_FAILED);
	const success = text.lastIndexOf(SIGNED_IN);
	const last = Math.max(dialog, failure, success);
	if (last >= 0) {
		if (last === success) return { state: "signed-in" };
		return { state: "signed-out", cause: dialog >= 0 ? "dialog" : "failure" };
	}
	if (text.includes(SIGN_IN_STARTED)) return { state: "signing-in" };
	return undefined;
}

/** Studio's log folder: `%LOCALAPPDATA%\Roblox\logs`. */
export function studioLogDir(env: Record<string, string | undefined>): string {
	return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Roblox", "logs");
}

/** Whether a file name is a Studio process's log: `..._Studio_<id>_last.log`. */
export function isStudioLog(name: string): boolean {
	return /_Studio_[0-9A-Fa-f]+_last\.log$/.test(name);
}

/** What reads the logs: the folder, and a file's start (`bytes` of it) as text. Real files by default. */
export interface LogFiles {
	list: (dir: string) => Promise<Array<{ name: string; modifiedMs: number }>>;
	head: (path: string, bytes: number) => Promise<string>;
}

const realFiles: LogFiles = {
	list: async (dir) => {
		const names = await readdir(dir);
		const found: Array<{ name: string; modifiedMs: number }> = [];
		for (const name of names) {
			if (!isStudioLog(name)) continue;
			try {
				found.push({ name, modifiedMs: (await stat(join(dir, name))).mtimeMs });
			} catch {
				// Removed meanwhile: Studio keeps only its latest logs.
			}
		}
		return found;
	},
	head: (path, bytes) => Bun.file(path).slice(0, bytes).text(),
};

/**
 * Reads launched processes' sign-in from their logs, remembering which log is whose: a log is
 * found once per launch (the newest one, written since `since`, that names the process; a PID
 * Windows reuses within one run is another launch, with a later `since`) and read again on each
 * look. A log is bound to one launch only. One last written before the launch is never read for
 * it: it may be the log of an earlier process with that PID, and the launch's own log, written
 * after `since` (taken before the launch), is found at a later look. Undefined when no log names
 * the process: not written yet, Studio's log folder elsewhere, a Studio whose log says neither, or
 * not Windows.
 */
export function signInReader(
	env: Record<string, string | undefined>,
	files: LogFiles = realFiles,
): (pid: number, since: number) => Promise<SignInReading | undefined> {
	const dir = studioLogDir(env);
	// By launch: `<pid>:<since>`; and the launch each of those logs is bound to.
	const logOf = new Map<string, string>();
	const launchOf = new Map<string, string>();
	// Whose each log read so far is, so that no log is read twice for that.
	const ownerOf = new Map<string, number>();
	return async (pid, since) => {
		try {
			const launch = `${pid}:${since}`;
			let path = logOf.get(launch);
			if (path === undefined) {
				// Written since the launch, the newest first, so an older log of a process that
				// had the same PID is not taken.
				const recent = (await files.list(dir))
					.filter((entry) => entry.modifiedMs >= since)
					.sort((a, b) => b.modifiedMs - a.modifiedMs);
				for (const entry of recent) {
					const candidate = join(dir, entry.name);
					const bound = launchOf.get(candidate);
					if (bound !== undefined && bound !== launch) continue;
					let owner = ownerOf.get(candidate);
					if (owner === undefined) {
						owner = processOf(await files.head(candidate, LOG_OWNER_BYTES));
						// Not saying yet: read again at the next look.
						if (owner === undefined) continue;
						ownerOf.set(candidate, owner);
					}
					if (owner === pid) {
						path = candidate;
						logOf.set(launch, path);
						launchOf.set(path, launch);
						break;
					}
				}
			}
			if (path === undefined) return undefined;
			const detail = signInDetail(await files.head(path, LOG_HEAD_BYTES));
			return detail === undefined ? undefined : { ...detail, log: path };
		} catch {
			// No log folder, or a log that cannot be read: nothing is known.
			return undefined;
		}
	};
}
