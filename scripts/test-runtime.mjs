import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The single-realm suites, once per realm. A realm's module graph caches decisions made at require
 * time, so each one needs a fresh graph and therefore a fresh process.
 *
 * The replication run builds two graphs inside one process instead, and covers the traffic between
 * them that neither single-realm run can see.
 */
const RUNS = [
	["tests/runtime/main.luau", "Server"],
	["tests/runtime/main.luau", "Client"],
	["tests/runtime/replication.luau"],
];

let failed = false;

for (const [script, ...args] of RUNS) {
	const result = spawnSync("lune", ["run", script, ...args], {
		cwd: root,
		stdio: "inherit",
		shell: true,
	});

	if (result.error) {
		console.error(
			"\x1b[31m[test]\x1b[0m could not run lune. Install it from https://lune-org.github.io/docs and make sure it is on PATH.",
		);
		process.exit(1);
	}

	if (result.status !== 0) {
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
