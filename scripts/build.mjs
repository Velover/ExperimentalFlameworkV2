import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Packages in dependency order.
 *
 * The transformer must be built before any roblox-ts package, as `rbxtsc` loads it
 * from `out/` while compiling them.
 */
const ORDER = ["transformer-plugin", "transformer", "core", "components", "networking", "testing"];

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ORDER;

for (const target of targets) {
	if (!ORDER.includes(target)) {
		console.error(`unknown package '${target}', expected one of: ${ORDER.join(", ")}`);
		process.exit(1);
	}
}

for (const pkg of ORDER.filter((v) => targets.includes(v))) {
	const cwd = path.join(root, "packages", pkg);
	console.log(`\x1b[36m[build]\x1b[0m ${pkg}`);

	const result = spawnSync("bun", ["run", "build"], { cwd, stdio: "inherit", shell: true });
	if (result.status !== 0) {
		console.error(`\x1b[31m[build]\x1b[0m ${pkg} failed`);
		process.exit(result.status ?? 1);
	}
}
