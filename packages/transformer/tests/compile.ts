import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const FIXTURE = path.resolve(import.meta.dir, "fixture");

// What `compileWithEntry` and projectConfig.test.ts's `$schema` build write into the fixture. Both
// remove it when they finish; a run killed halfway leaves it behind, so it goes before anything compiles.
for (const leftover of [
	"tsconfig.entry-probe.json",
	"probe-config",
	// regressions.test.ts's incremental build.
	"tsconfig.incremental-probe.json",
	"tsconfig.incremental-probe.tsbuildinfo",
	"src/incrementalAlpha.ts",
	"src/incrementalBeta.ts",
]) {
	fs.rmSync(path.join(FIXTURE, leftover), { recursive: true, force: true });
}

const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");

export interface CompileResult {
	/** Emitted Luau, keyed by path relative to `out` without its extension (e.g. `"plugins"`). */
	files: Map<string, string>;

	/** Everything rbxtsc wrote to stdout/stderr, for asserting on diagnostics. */
	output: string;

	status: number;
}

let cached: CompileResult | undefined;

/**
 * Compiles the fixture project once per test run and returns its emitted Luau.
 *
 * The fixture is compiled with the real `rbxtsc` rather than by driving the transformer directly,
 * so these tests cover the transformer as it is actually loaded.
 */
export function compileFixture(): CompileResult {
	if (cached) {
		return cached;
	}

	fs.rmSync(path.join(FIXTURE, "out"), { recursive: true, force: true });

	const result = spawnSync("node", [RBXTSC], { cwd: FIXTURE, encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

	const files = new Map<string, string>();
	const outDir = path.join(FIXTURE, "out");

	if (fs.existsSync(outDir)) {
		for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".luau")) {
				continue;
			}

			const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
			const key = path
				.relative(outDir, absolute)
				.replace(/\\/g, "/")
				.replace(/\.luau$/, "");

			files.set(key, fs.readFileSync(absolute, "utf8"));
		}
	}

	cached = { files, output, status: result.status ?? 1 };
	return cached;
}

/** Compiles the fixture again in a fresh rbxtsc process, ignoring the cached result. */
export function compileFixtureFresh(): CompileResult {
	cached = undefined;
	return compileFixture();
}

/**
 * Compiles the fixture in a fresh rbxtsc process with extra environment variables, which its
 * `flamework.config.json` reads, and returns that emit without caching it.
 *
 * The files on disk are left as this compilation wrote them: a test that changes the fixture's
 * options this way should end with `compileFixtureFresh()` so that what later tests read from disk
 * is the ordinary build again.
 */
export function compileFixtureWithEnv(env: Record<string, string>): CompileResult {
	fs.rmSync(path.join(FIXTURE, "out"), { recursive: true, force: true });

	const result = spawnSync("node", [RBXTSC], { cwd: FIXTURE, encoding: "utf8", env: { ...process.env, ...env } });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

	return { files: readEmitted(), output, status: result.status ?? 1 };
}

function readEmitted() {
	const files = new Map<string, string>();
	const outDir = path.join(FIXTURE, "out");

	if (fs.existsSync(outDir)) {
		for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".luau")) {
				continue;
			}

			const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
			const key = path
				.relative(outDir, absolute)
				.replace(/\\/g, "/")
				.replace(/\.luau$/, "");

			files.set(key, fs.readFileSync(absolute, "utf8"));
		}
	}

	return files;
}

/**
 * Compiles the fixture with one extra source file and reports what rbxtsc said about it.
 *
 * A file that must not compile cannot live in the fixture itself, which every other test needs to
 * build. The cached result is left alone, so this does not disturb the emit they read.
 */
export function compileProbe(name: string, source: string): CompileResult {
	const file = path.join(FIXTURE, "src", `${name}.ts`);
	fs.writeFileSync(file, source);

	try {
		const result = spawnSync("node", [RBXTSC], { cwd: FIXTURE, encoding: "utf8" });

		return {
			files: new Map(),
			output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
			status: result.status ?? 1,
		};
	} finally {
		fs.rmSync(file, { force: true });
		fs.rmSync(path.join(FIXTURE, "out", `${name}.luau`), { force: true });
	}
}

/**
 * Compiles the fixture with several extra source files, with extra environment variables for its
 * `flamework.config.json`, and returns what rbxtsc said and the Luau emitted for those files (none
 * when any file fails, since rbxtsc then emits nothing). The files are removed again afterwards; the
 * rest of `out` is left as this compilation wrote it, and the cached result is left alone.
 */
export function compileProbes(sources: Record<string, string>, env: Record<string, string> = {}): CompileResult {
	const names = Object.keys(sources);
	for (const name of names) {
		fs.rmSync(path.join(FIXTURE, "out", `${name}.luau`), { force: true });
		fs.writeFileSync(path.join(FIXTURE, "src", `${name}.ts`), sources[name]);
	}

	try {
		const result = spawnSync("node", [RBXTSC], {
			cwd: FIXTURE,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});

		const files = new Map<string, string>();
		for (const name of names) {
			const emittedFile = path.join(FIXTURE, "out", `${name}.luau`);
			if (fs.existsSync(emittedFile)) files.set(name, fs.readFileSync(emittedFile, "utf8"));
		}

		return { files, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status ?? 1 };
	} finally {
		for (const name of names) {
			fs.rmSync(path.join(FIXTURE, "src", `${name}.ts`), { force: true });
			fs.rmSync(path.join(FIXTURE, "out", `${name}.luau`), { force: true });
		}
	}
}

/**
 * Compiles the fixture through a tsconfig whose transformer entry is `entry`, and reports what
 * rbxtsc said. The probe tsconfig is the fixture's own with only the entry replaced, and is removed
 * again afterwards. An entry the transformer refuses stops the build before anything is emitted;
 * one it accepts must read the fixture's own config, so what is left on disk is the ordinary build.
 */
export function compileWithEntry(entry: Record<string, unknown>): CompileResult {
	const probe = path.join(FIXTURE, "tsconfig.entry-probe.json");
	const { config } = ts.readConfigFile(path.join(FIXTURE, "tsconfig.json"), ts.sys.readFile);
	config.compilerOptions.plugins = [entry];
	fs.writeFileSync(probe, JSON.stringify(config, undefined, "\t"));

	try {
		const result = spawnSync("node", [RBXTSC, "-p", probe], { cwd: FIXTURE, encoding: "utf8" });

		return {
			files: new Map(),
			output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
			status: result.status ?? 1,
		};
	} finally {
		fs.rmSync(probe, { force: true });
	}
}

export function emitted(name: string): string {
	const file = compileFixture().files.get(name);
	if (file === undefined) {
		throw new Error(`fixture did not emit '${name}' (emitted: ${[...compileFixture().files.keys()].join(", ")})`);
	}

	return file;
}

/** Collapses whitespace so assertions do not depend on the emitter's formatting. */
export function normalize(source: string): string {
	return source.replace(/\s+/g, " ").trim();
}
