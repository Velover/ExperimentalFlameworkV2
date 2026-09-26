import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The in-place suite in Roblox Studio: builds the packages, then runs `bun run test` in
 * tests/place, which compiles the place against those builds (workspace links, nothing copied),
 * builds it with Rojo and has `flamework-test` run both realms under every project in the place's
 * ROJO_PROJECT. Needs Roblox Studio with "MCP server" enabled, Rojo and Lune, so `bun run test`
 * leaves it out.
 *
 * Arguments go to `flamework-test test`, and paths in them are relative to tests/place:
 *   bun run test:place --project tests/deferred.project.json --sections components
 *   bun run test:place --cloud
 */
const STEPS = [
	// The specs are the Lune suite's, not the place's, so they are left out.
	[
		"build",
		"bun",
		[
			"run",
			"./scripts/build.mjs",
			"transformer-plugin",
			"transformer",
			"core",
			"testing",
			"components",
			"networking",
		],
		root,
	],
	["place", "bun", ["run", "test", ...process.argv.slice(2)], path.join(root, "tests", "place")],
];

for (const [name, command, args, cwd] of STEPS) {
	console.log(`\x1b[36m[test:place]\x1b[0m ${name}`);

	// No shell, so an argument with spaces (a `section/test name` filter) arrives as one.
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`\x1b[31m[test:place]\x1b[0m ${name} failed`);
		process.exit(result.status ?? 1);
	}
}
