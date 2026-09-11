import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The runtime specs execute compiled output, so everything has to be built first.
 */
const STEPS = [
	["build", ["bun", ["run", "./scripts/build.mjs"]]],
	// The transformer tests compile the fixture with the real rbxtsc inside a hook, which takes longer
	// than bun's default five second hook timeout on a cold cache.
	["transformer tests", ["bun", ["test", "--timeout", "120000", "packages/transformer/tests"]]],
	["packaging checks", ["bun", ["test", "tests/packaging"]]],
	["cloud-testing tests", ["bun", ["test", "packages/cloud-testing/tests"]]],
	["runtime specs", ["bun", ["run", "./scripts/test-runtime.mjs"]]],
];

for (const [name, [command, args]] of STEPS) {
	console.log(`\x1b[36m[test]\x1b[0m ${name}`);

	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
	if (result.status !== 0) {
		console.error(`\x1b[31m[test]\x1b[0m ${name} failed`);
		process.exit(result.status ?? 1);
	}
}

console.log("\x1b[32m[test]\x1b[0m all suites passed");
