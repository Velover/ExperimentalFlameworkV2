import fs from "fs";
import path from "path";

/**
 * Writes a file whole or not at all, for files Rojo or a later build reads while the build runs: the
 * text goes to a temporary file in the same folder, which is then renamed over the target, so a
 * reader sees the old file or the new one, never half of one. The temporary name ends in `.tmp`,
 * which Rojo does not sync.
 *
 * On Windows a rename over a file that another process has open (Rojo reading it, a virus scanner)
 * can fail for a moment; it is tried again a few times, and then the file is written in place.
 */
export function writeFileAtomic(file: string, contents: string) {
	removeStaleTemporaries(file);

	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, contents);

	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(temporary, file);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 5) {
				fs.rmSync(temporary, { force: true });
				if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
					fs.writeFileSync(file, contents);
					return;
				}
				throw error;
			}
			// The build is synchronous, so the wait is too: a short spin, only when a rename is refused.
			const until = Date.now() + 20;
			while (Date.now() < until) continue;
		}
	}
}

/** Whether a process with this id is running; one that cannot be signalled for lack of rights is. */
function isRunning(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Removes the temporary files of `file` that a build killed between its write and its rename left
 * behind: `.<name>.<pid>.tmp` of a process that is no longer running. Another build writing the
 * same file at this moment keeps its own.
 */
function removeStaleTemporaries(file: string) {
	const prefix = `.${path.basename(file)}.`;
	let entries: string[];
	try {
		entries = fs.readdirSync(path.dirname(file));
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;

		const pid = Number(entry.slice(prefix.length, -".tmp".length));
		if (!Number.isInteger(pid) || pid === process.pid || isRunning(pid)) continue;

		try {
			fs.rmSync(path.join(path.dirname(file), entry), { force: true });
		} catch {
			// Left for the next build.
		}
	}
}
