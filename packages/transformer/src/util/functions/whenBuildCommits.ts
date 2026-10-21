import ts from "typescript";

const listeners = new WeakMap<ts.Program, () => void>();

/**
 * Calls `listener` when roblox-ts commits the build of `program`: once it has written every compiled
 * file, which it does only when the build has no error, its own or a transformer's.
 *
 * roblox-ts tells a transformer nothing about how the build ended, and the diagnostics it reports
 * are gone by the time a transformer could look. What it does do, in 3.0.0 and after, is call
 * `program.emitBuildInfo()` on the program it gave the transformer exactly once per build, right
 * after the Luau is written and only when nothing failed (`compileFiles` in
 * `out/Project/functions/compileFiles.js` in 3.0.0, `src/Project/functions/compileFiles.ts` after it;
 * every earlier return is an `emitSkipped` one with errors). That call is the signal. A program
 * handed to transformers more than once (a later `compileFiles` with the same program) calls the
 * listener of the latest.
 */
export function whenBuildCommits(program: ts.Program, listener: () => void) {
	if (!listeners.has(program)) {
		const emitBuildInfo = program.emitBuildInfo;
		program.emitBuildInfo = function (this: ts.Program, ...args: Parameters<ts.Program["emitBuildInfo"]>) {
			const result = emitBuildInfo.apply(this, args);
			listeners.get(program)?.();
			return result;
		};
	}

	listeners.set(program, listener);
}
