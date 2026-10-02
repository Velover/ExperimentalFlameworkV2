import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Builds src/widthChecks/codecs.ts once more per `serialization.checks` configuration: each folder
 * here is a project of its own (a tsconfig that compiles that one file into its own `out`, and a
 * flamework.config.json that the transformer finds first), since the checks are compiled in and one
 * build has one configuration. The Lune harness loads them through `__harness.checkVariant(name)`.
 *
 *   warn         category "all", mode "warn": strict widths too, warned about and written as they are
 *   none         category "none": nothing checked
 *   server       side "server": raises on the server only
 *   client       mode "warn", side "client": warns on the client only
 *   types        types: every value's type tested, raising
 *   typesWarn    types, mode "warn": raises all the same, but warns about a boolean and writes it
 *   typesServer  types, side "server": tests on the server only
 *
 * The type-check specs' encodings (src/typeChecks/codecs.ts) come along in every build, as
 * codecs.ts hands them out (`types`).
 */
const VARIANTS = ["warn", "none", "server", "client", "types", "typesWarn", "typesServer"];

const here = path.dirname(fileURLToPath(import.meta.url));
// The specs' own roblox-ts, run by node as the transformer tests run it, whatever PATH holds.
const rbxtsc = createRequire(path.join(here, "..", "package.json")).resolve("roblox-ts/out/CLI/cli.js");

for (const name of VARIANTS) {
	console.log(`\x1b[36m[variants]\x1b[0m ${name}`);
	const result = spawnSync("node", [rbxtsc, "-p", path.join(here, name)], {
		cwd: path.join(here, ".."),
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error(`\x1b[31m[variants]\x1b[0m ${name} failed`);
		process.exit(result.status ?? 1);
	}
}
