import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const FIXTURE = path.resolve(import.meta.dir, "fixture");
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
