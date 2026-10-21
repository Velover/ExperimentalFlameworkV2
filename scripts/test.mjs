import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The specs build with networking serialization on (packages/specs/flamework.config.json reads
 * `FLAMEWORK_SPECS_SERIALIZATION`, true by default); the last two steps build them with it off and
 * run them again, and the specs are built back with it on afterwards, whatever happened.
 */
const SERIALIZATION_OFF = { ...process.env, FLAMEWORK_SPECS_SERIALIZATION: "false" };

/**
 * The runtime specs execute compiled output, so everything has to be built first.
 *
 * Every `bun test` gets a timeout: bun's default is five seconds a test, which the transformer tests'
 * real rbxtsc compile and the packaging checks' `npm pack --dry-run` exceed on a cold cache.
 */
const STEPS = [
	["build", ["bun", ["run", "./scripts/build.mjs"]]],
	["transformer tests", ["bun", ["test", "--timeout", "120000", "packages/transformer/tests"]]],
	["packaging checks", ["bun", ["test", "--timeout", "120000", "tests/packaging"]]],
	["flamework-test CLI tests", ["bun", ["test", "--timeout", "120000", "packages/testing/cli/tests"]]],
	["runtime specs", ["bun", ["run", "./scripts/test-runtime.mjs"]]],
	["specs build, serialization off", ["bun", ["run", "./scripts/build.mjs", "specs"]], SERIALIZATION_OFF],
	["runtime specs, serialization off", ["bun", ["run", "./scripts/test-runtime.mjs"]]],
];

let specsBuiltOff = false;

function run(name, command, args, env) {
	console.log(`\x1b[36m[test]\x1b[0m ${name}`);
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true, env: env ?? process.env });
	return result.status ?? 1;
}

/** Builds the specs back with serialization on, once a step built them with it off. */
function restoreSpecs() {
	if (!specsBuiltOff) return 0;
	specsBuiltOff = false;
	return run("specs build, serialization back on", "bun", ["run", "./scripts/build.mjs", "specs"]);
}

for (const [name, [command, args], env] of STEPS) {
	if (env === SERIALIZATION_OFF) specsBuiltOff = true;

	const status = run(name, command, args, env);
	if (status !== 0) {
		console.error(`\x1b[31m[test]\x1b[0m ${name} failed`);
		if (restoreSpecs() !== 0) {
			console.error("\x1b[31m[test]\x1b[0m specs build, serialization back on failed");
		}
		process.exit(status);
	}
}

const restored = restoreSpecs();
if (restored !== 0) {
	console.error("\x1b[31m[test]\x1b[0m specs build, serialization back on failed");
	process.exit(restored);
}

console.log("\x1b[32m[test]\x1b[0m all suites passed");
