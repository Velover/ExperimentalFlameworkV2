import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { compileFixture, emitted } from "./compile";

const { findProjectConfig, fingerprintProjectConfig, getRuntimeConfig, loadProjectConfig, readProjectConfig } =
	await import("../out/util/projectConfig.js");
const { loadEnv, parseEnvFile } = await import("../out/util/env.js");
const { BuildInfo } = await import("../out/classes/buildInfo.js");

const FIXTURE = path.resolve(import.meta.dir, "fixture");

/** A throwaway package tree: <root>/package.json, <root>/places/a (a nested tsconfig directory). */
let root: string;
let place: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "flamework-config-"));
	place = path.join(root, "places", "a");
	fs.mkdirSync(place, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "config-test" }));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string) {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
	return file;
}

function remove(relative: string) {
	fs.rmSync(path.join(root, relative), { force: true });
}

describe("locating flamework.config.json", () => {
	test("finds it in the tsconfig's directory", () => {
		const file = write("places/a/flamework.config.json", "{}");
		expect(findProjectConfig(place, root)).toBe(file);
		remove("places/a/flamework.config.json");
	});

	test("walks up to the package root", () => {
		const file = write("flamework.config.json", "{}");
		expect(findProjectConfig(place, root)).toBe(file);
		remove("flamework.config.json");
	});

	test("does not look above the package root", () => {
		expect(findProjectConfig(place, root)).toBeUndefined();
	});

	test("honours an explicit configFile relative to the tsconfig directory", () => {
		const file = write("places/a/config/fw.json", `{ "transformer": { "hashPrefix": "$x" } }`);
		const loaded = loadProjectConfig(place, root, { configFile: "config/fw.json" });

		expect(loaded.configPath).toBe(file);
		expect(loaded.config.hashPrefix).toBe("$x");
		remove("places/a/config/fw.json");
	});

	test("raises when an explicit configFile is missing", () => {
		expect(() => findProjectConfig(place, root, "missing.json")).toThrow(/does not exist/);
	});
});

describe("reading flamework.config.json", () => {
	test("accepts comments and trailing commas", () => {
		const file = write(
			"flamework.config.json",
			`{
				// like tsconfig
				"transformer": { "hashPrefix": "$c", "optimizations": { "guardGenerationDedupLimit": 4, }, },
			}`,
		);

		expect(readProjectConfig(file)).toEqual({
			transformer: { hashPrefix: "$c", optimizations: { guardGenerationDedupLimit: 4 } },
		});
		remove("flamework.config.json");
	});

	test("drops the $schema key", () => {
		const file = write(
			"flamework.config.json",
			`{ "$schema": "./x.json", "transformer": { "obfuscation": true } }`,
		);
		expect(readProjectConfig(file)).toEqual({ transformer: { obfuscation: true } });
		remove("flamework.config.json");
	});

	test("rejects unknown keys by name, at the top level and inside a section", () => {
		const file = write("flamework.config.json", `{ "hashPrefix": "$c" }`);
		expect(() => readProjectConfig(file)).toThrow(/hashPrefix/);

		write("flamework.config.json", `{ "transformer": { "hashPrefx": "$c" } }`);
		expect(() => readProjectConfig(file)).toThrow(/hashPrefx/);
		remove("flamework.config.json");
	});

	test("rejects a bad idGenerationMode", () => {
		const file = write("flamework.config.json", `{ "transformer": { "idGenerationMode": "medium" } }`);
		expect(() => readProjectConfig(file)).toThrow(/idGenerationMode|allowed values/);
		remove("flamework.config.json");
	});

	test("validates the runtime sections", () => {
		const file = write("flamework.config.json", `{ "components": { "streamingMode": "Sometimes" } }`);
		expect(() => readProjectConfig(file)).toThrow(/streamingMode|allowed values/);

		write("flamework.config.json", `{ "networking": { "serialization": "yes" } }`);
		expect(() => readProjectConfig(file)).toThrow(/serialization|boolean/);
		remove("flamework.config.json");
	});

	test("reports a parse error with the file name", () => {
		const file = write("flamework.config.json", `{ "transformer": `);
		expect(() => readProjectConfig(file)).toThrow(/Failed to parse .*flamework\.config\.json/);
		remove("flamework.config.json");
	});
});

describe("environment substitution", () => {
	test("fills ${NAME} and ${NAME:-fallback} from the given environment", () => {
		const file = write(
			"flamework.config.json",
			`{ "transformer": { "hashPrefix": "${"${PREFIX}"}", "salt": "${"${SALT:-fixed}"}" } }`,
		);

		expect(readProjectConfig(file, { PREFIX: "$e" })).toEqual({
			transformer: { hashPrefix: "$e", salt: "fixed" },
		});
		expect(readProjectConfig(file, { PREFIX: "$e", SALT: "given" }).transformer?.salt).toBe("given");
		remove("flamework.config.json");
	});

	test("converts a substituted string to what the schema expects", () => {
		const file = write(
			"flamework.config.json",
			`{
				"transformer": { "obfuscation": "${"${OBFUSCATE:-false}"}", "optimizations": { "guardGenerationDedupLimit": "${"${DEDUP}"}" } },
				"scopes": { "active": "${"${SCOPES:-}"}" }
			}`,
		);

		expect(readProjectConfig(file, { OBFUSCATE: "TRUE", DEDUP: "4", SCOPES: "components, providers" })).toEqual({
			transformer: { obfuscation: true, optimizations: { guardGenerationDedupLimit: 4 } },
			scopes: { active: ["components", "providers"] },
		});

		// An empty variable is an empty list, and `*` is passed through for the runtime to read.
		expect(readProjectConfig(file, { DEDUP: "2", SCOPES: "" }).scopes).toEqual({ active: [] });
		expect(readProjectConfig(file, { DEDUP: "2", SCOPES: "*" }).scopes).toEqual({ active: ["*"] });
		remove("flamework.config.json");
	});

	test("rejects a converted value that does not parse, naming where it was used", () => {
		const file = write("flamework.config.json", `{ "transformer": { "obfuscation": "${"${OBFUSCATE}"}" } }`);
		expect(() => readProjectConfig(file, { OBFUSCATE: "maybe" })).toThrow(
			/\/transformer\/obfuscation.*not a boolean/,
		);

		write("flamework.config.json", `{ "components": { "warningTimeout": "${"${TIMEOUT}"}" } }`);
		expect(() => readProjectConfig(file, { TIMEOUT: "soon" })).toThrow(
			/\/components\/warningTimeout.*not a number/,
		);
		remove("flamework.config.json");
	});

	test("raises on a variable that is not set and has no fallback", () => {
		const file = write("flamework.config.json", `{ "transformer": { "hashPrefix": "${"${PREFIX}"}" } }`);
		expect(() => readProjectConfig(file, {})).toThrow(/\/transformer\/hashPrefix.*\$PREFIX.*not set/);
		remove("flamework.config.json");
	});

	test("writes a literal dollar with $$ and leaves other strings alone", () => {
		const file = write("flamework.config.json", `{ "transformer": { "hashPrefix": "$$g", "salt": "plain" } }`);
		expect(readProjectConfig(file, {}).transformer).toEqual({ hashPrefix: "$g", salt: "plain" });
		remove("flamework.config.json");
	});

	test("reads .env, then .env.local over it, then the process environment over both", () => {
		write(
			"flamework.config.json",
			`{ "transformer": { "hashPrefix": "${"${FW_TEST_PREFIX}"}", "salt": "${"${FW_TEST_SALT}"}" }, "scopes": { "active": "${"${FW_TEST_SCOPES}"}" } }`,
		);
		write(".env", "FW_TEST_PREFIX=$a\nFW_TEST_SALT=from-env\nFW_TEST_SCOPES=a\n");
		write(".env.local", "FW_TEST_SALT=from-local\nFW_TEST_SCOPES=b\n");

		process.env.FW_TEST_SCOPES = "c";
		try {
			expect(loadProjectConfig(root, root, {}).project).toEqual({
				transformer: { hashPrefix: "$a", salt: "from-local" },
				scopes: { active: ["c"] },
			});
		} finally {
			delete process.env.FW_TEST_SCOPES;
		}

		expect(loadEnv(root, {})).toEqual({ FW_TEST_PREFIX: "$a", FW_TEST_SALT: "from-local", FW_TEST_SCOPES: "b" });

		remove("flamework.config.json");
		remove(".env");
		remove(".env.local");
	});

	test("parses quotes, escapes, comments and an export prefix in an env file", () => {
		expect(
			parseEnvFile(
				[
					"# a comment",
					"",
					"PLAIN=value # trailing comment",
					'DOUBLE="a \\"quoted\\" line\\nnext"',
					"SINGLE='kept \\n as written'",
					"export EXPORTED=yes",
					"not a line",
					"SPACED =  padded  ",
				].join("\n"),
			),
		).toEqual({
			PLAIN: "value",
			DOUBLE: 'a "quoted" line\nnext',
			SINGLE: "kept \\n as written",
			EXPORTED: "yes",
			SPACED: "padded",
		});
	});
});

describe("the watcher's fingerprint", () => {
	test("is stable across reads and changes with the file or with any variable", () => {
		write("flamework.config.json", `{ "transformer": { "hashPrefix": "${"${FW_FP_PREFIX:-$a}"}" } }`);
		write(".env", "FW_FP_PREFIX=$a\nFW_FP_UNUSED=1\n");

		const first = fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}));
		expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}))).toBe(first);

		// A variable the file does not mention still counts: Flamework.env may read it.
		write(".env", "FW_FP_PREFIX=$a\nFW_FP_UNUSED=2\n");
		expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}))).not.toBe(first);

		write(".env", "FW_FP_PREFIX=$a\nFW_FP_UNUSED=1\n");
		write(
			"flamework.config.json",
			`{ "transformer": { "hashPrefix": "${"${FW_FP_PREFIX:-$a}"}" }, "core": { "profiling": true } }`,
		);
		expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}))).not.toBe(first);

		remove("flamework.config.json");
		remove(".env");
	});

	test("reads .env next to the tsconfig when there is no config file", () => {
		write("places/a/.env", "FW_FP_LONE=yes\n");
		expect(loadProjectConfig(place, root, {}, {}).env).toEqual({ FW_FP_LONE: "yes" });
		remove("places/a/.env");
	});

	test("drop the identifier table when idGenerationMode changes", () => {
		const info = new BuildInfo(path.join(root, "flamework.build"));
		info.addIdentifier("pkg:file@Class", "pkg:file@Class");

		expect(info.setIdGenerationMode("full")).toBeUndefined();
		expect(info.getIdentifierFromInternal("pkg:file@Class")).toBe("pkg:file@Class");

		expect(info.setIdGenerationMode("obfuscated")).toBe("full");
		expect(info.getIdentifierFromInternal("pkg:file@Class")).toBeUndefined();
		expect(info.getIdGenerationMode()).toBe("obfuscated");

		// A table from before the mode was recorded is kept.
		const older = new BuildInfo(path.join(root, "flamework.build"), {
			version: 1,
			flameworkVersion: "0",
			identifiers: { "pkg:file@Class": "x" },
		});
		expect(older.setIdGenerationMode("obfuscated")).toBeUndefined();
		expect(older.getIdentifierFromInternal("pkg:file@Class")).toBe("x");
	});

	test("keep a build seed for as long as the build info lives, and start a new one with a new build info", () => {
		// The seed follows the salt's lifecycle: a plain build recreates the build info, a watcher
		// keeps reading the saved one. Obfuscated callsite uuids take their namespace from it.
		const file = path.join(root, "seeded.build");
		const info = new BuildInfo(file);
		const seed = info.getBuildSeed();

		expect(seed).toMatch(/^[0-9a-f-]{36}$/);
		expect(info.getBuildSeed()).toBe(seed);

		info.save();
		expect(BuildInfo.fromPath(file).getBuildSeed()).toBe(seed);
		expect(new BuildInfo(file).getBuildSeed()).not.toBe(seed);

		fs.rmSync(file, { force: true });
	});
});

describe("merging with tsconfig options", () => {
	test("inline options override the transformer section, one level deep for optimizations", () => {
		write(
			"flamework.config.json",
			`{ "transformer": { "hashPrefix": "$file", "obfuscation": true, "optimizations": { "guardGenerationDedupLimit": 3 } } }`,
		);

		const { config } = loadProjectConfig(place, root, { hashPrefix: "$inline", optimizations: {} });

		expect(config.hashPrefix).toBe("$inline");
		expect(config.obfuscation).toBe(true);
		expect(config.optimizations).toEqual({ guardGenerationDedupLimit: 3 });
		remove("flamework.config.json");
	});

	test("works with no file at all", () => {
		const loaded = loadProjectConfig(place, root, { salt: "s" });
		expect(loaded.configPath).toBeUndefined();
		expect(loaded.config).toEqual({ salt: "s" });
		expect(loaded.project).toEqual({});
	});
});

describe("runtime sections", () => {
	test("are collected for the config artifact and nothing else is", () => {
		expect(
			getRuntimeConfig({
				transformer: { hashPrefix: "$x" },
				core: { profiling: false },
				networking: { serialization: true },
				scopes: { active: ["a"] },
			}),
		).toEqual({ core: { profiling: false }, networking: { serialization: true }, scopes: { active: ["a"] } });
	});

	test("are absent when the file only configures the transformer", () => {
		expect(getRuntimeConfig({ transformer: { obfuscation: true } })).toBeUndefined();
	});
});

describe("the fixture", () => {
	test("takes its transformer options from the transformer section", () => {
		// The fixture's tsconfig entry is just `{ "transform": ... }`; the `$f` prefix, the dedup limit
		// and the plugin list all live in its flamework.config.json, so this only passes if that file was read.
		const result = compileFixture();
		expect(result.status).toBe(0);
		expect(emitted("nested")).toContain("fw:nested@Target");
	});

	test("writes the runtime sections to include/flamework/config.json, with its .env substituted", () => {
		// The fixture's `scopes.active` is `${FLAMEWORK_FIXTURE_SCOPES:-unset}` and its `.env` sets
		// the variable, so the artifact only holds the split list if the file was read and applied.
		compileFixture();
		const artifact = path.join(FIXTURE, "include", "flamework", "config.json");
		expect(fs.existsSync(artifact)).toBe(true);
		// `testing.entry` is a source path in the file and a tree path in the artifact, resolved the
		// way a path macro is; `cloud` is read by the CLI only and never reaches the place.
		expect(JSON.parse(fs.readFileSync(artifact, "utf8"))).toEqual({
			networking: { serialization: true },
			components: { warningTimeout: 2 },
			scopes: { active: ["fixture", "demo"] },
			testing: { enabled: false, entry: ["out", "env"] },
		});
	});
});
