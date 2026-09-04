import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `@Provider` writes its metadata when the decorator evaluates, so a realm cannot be switched
 * inside a single run -- each one needs a fresh module graph, and therefore a fresh process.
 */
const REALMS = ["Server", "Client"];

let failed = false;

for (const realm of REALMS) {
	const result = spawnSync("lune", ["run", "tests/runtime/main.luau", realm], {
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
