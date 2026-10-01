import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { compileFixture, compileFixtureFresh, compileWithEntry, emitted } from "./compile";

const {
	addSchemaReference,
	findInstalledSchema,
	findProjectConfig,
	fingerprintProjectConfig,
	getRuntimeConfig,
	getSchemaReference,
	insertSchemaReference,
	loadProjectConfig,
	LOADER_KEYS,
	readProjectConfig,
} = await import("../out/util/projectConfig.js");
const { loadEnv, parseEnvFile } = await import("../out/util/env.js");
const { BuildInfo } = await import("../out/classes/buildInfo.js");
const { ProjectError } = await import("../out/classes/diagnostics.js");
const { Cache } = await import("../out/util/cache.js");

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

	test("accepts components.watchRenames as a boolean and rejects any other type", () => {
		// The components package reads it as the default for components that do not set their own;
		// the schema used to reject the key outright.
		const file = write("flamework.config.json", `{ "components": { "watchRenames": true } }`);
		expect(readProjectConfig(file)).toEqual({ components: { watchRenames: true } });

		write("flamework.config.json", `{ "components": { "watchRenames": "${"${WATCH}"}" } }`);
		expect(readProjectConfig(file, { WATCH: "false" })).toEqual({ components: { watchRenames: false } });
		expect(() => readProjectConfig(file, { WATCH: "sometimes" })).toThrow(
			/\/components\/watchRenames.*not a boolean/,
		);

		write("flamework.config.json", `{ "components": { "watchRenames": 1 } }`);
		expect(() => readProjectConfig(file)).toThrow(/\/components\/watchRenames must be boolean/);
		remove("flamework.config.json");
	});

	test("accepts serialization.checks and refuses unknown keys and values, naming the values it takes", () => {
		const file = write(
			"flamework.config.json",
			`{ "serialization": { "checks": { "category": "all", "mode": "warn", "side": "server" } } }`,
		);
		expect(readProjectConfig(file)).toEqual({
			serialization: { checks: { category: "all", mode: "warn", side: "server" } },
		});

		write("flamework.config.json", `{ "serialization": { "checks": {} } }`);
		expect(readProjectConfig(file)).toEqual({ serialization: { checks: {} } });

		write("flamework.config.json", `{ "serialization": { "checks": { "mode": "${"${MODE:-assert}"}" } } }`);
		expect(readProjectConfig(file, { MODE: "warn" })).toEqual({ serialization: { checks: { mode: "warn" } } });
		expect(readProjectConfig(file, {})).toEqual({ serialization: { checks: { mode: "assert" } } });

		write("flamework.config.json", `{ "serialization": { "checks": { "categry": "all" } } }`);
		expect(() => readProjectConfig(file)).toThrow(
			/\/serialization\/checks must NOT have additional properties 'categry'/,
		);

		write("flamework.config.json", `{ "serialization": { "check": {} } }`);
		expect(() => readProjectConfig(file)).toThrow(/\/serialization must NOT have additional properties 'check'/);

		write("flamework.config.json", `{ "serialization": { "checks": { "category": "strict" } } }`);
		expect(() => readProjectConfig(file)).toThrow(
			/\/serialization\/checks\/category must be equal to one of the allowed values: "implicit", "all", "none"/,
		);

		write("flamework.config.json", `{ "serialization": { "checks": { "mode": "raise" } } }`);
		expect(() => readProjectConfig(file)).toThrow(
			/\/serialization\/checks\/mode must be equal to one of the allowed values: "assert", "warn"/,
		);

		write("flamework.config.json", `{ "serialization": { "checks": { "side": "Server" } } }`);
		expect(() => readProjectConfig(file)).toThrow(
			/\/serialization\/checks\/side must be equal to one of the allowed values: "both", "server", "client"/,
		);

		write("flamework.config.json", `{ "serialization": { "checks": { "side": true } } }`);
		expect(() => readProjectConfig(file)).toThrow(/\/serialization\/checks\/side must be string/);
		remove("flamework.config.json");
	});

	test("reports a parse error with the file name", () => {
		const file = write("flamework.config.json", `{ "transformer": `);
		expect(() => readProjectConfig(file)).toThrow(/Failed to parse .*flamework\.config\.json/);
		remove("flamework.config.json");
	});

	test("raises its errors as the project's, which the build reports without a stack", () => {
		const file = write("flamework.config.json", `{ "transformer": `);
		expect(() => readProjectConfig(file)).toThrow(ProjectError);

		write("flamework.config.json", `{ "transformer": { "hashPrefix": 1 } }`);
		expect(() => readProjectConfig(file)).toThrow(ProjectError);

		write("flamework.config.json", `{ "transformer": { "obfuscation": "${"${FW_UNSET_FLAG}"}" } }`);
		expect(() => readProjectConfig(file, {})).toThrow(ProjectError);

		write("flamework.config.json", `{ "transformer": { "obfuscation": "maybe" } }`);
		expect(() => readProjectConfig(file, {})).toThrow(ProjectError);
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

	test("changes with serialization.checks, which is compiled into every file that writes values", () => {
		// The same as networking.serialization: a watcher that took up a change would leave the files it
		// does not recompile checking the old way, so it keeps the first read and asks for a restart.
		write("flamework.config.json", `{ "serialization": { "checks": { "mode": "${"${FW_FP_MODE:-assert}"}" } } }`);
		const first = fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}));
		expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, { FW_FP_MODE: "warn" }))).not.toBe(first);

		write("flamework.config.json", `{ "serialization": { "checks": { "mode": "assert", "side": "server" } } }`);
		expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}))).not.toBe(first);
		remove("flamework.config.json");
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

	test("refuse a flamework.build that cannot be used, saying why and then what to do", () => {
		// It was a plain Error ("Found invalid build info at <path>", or JSON.parse's own), which
		// roblox-ts prints with a stack.
		const file = path.join(root, "broken.build");
		const valid = JSON.stringify({ version: 1, flameworkVersion: "2.0.0", identifiers: {} }, undefined, "\t");
		const refusal = (text: string) => {
			fs.writeFileSync(file, text);
			try {
				BuildInfo.fromPath(file, "broken.build", ["Do this."]);
			} catch (error) {
				expect(error).toBeInstanceOf(ProjectError);
				return (error as Error).message;
			}
		};

		try {
			// Cut short, as an interrupted write leaves it.
			expect(refusal(valid.slice(0, 30))).toMatch(
				/^Flamework cannot use broken\.build: it is not valid JSON \(.+\)\.\nDo this\.$/,
			);
			expect(refusal(`<<<<<<< HEAD\n${valid}\n=======\n${valid}\n>>>>>>> other\n`)).toMatch(
				/^Flamework cannot use broken\.build: it is not valid JSON \(.+\)\.\nDo this\.$/,
			);
			expect(refusal("")).toBe("Flamework cannot use broken.build: it is empty.\nDo this.");
			expect(refusal(`{ "version": "1", "identifiers": [] }`)).toBe(
				"Flamework cannot use broken.build: it does not have the shape Flamework writes (/ must have required property 'flameworkVersion').\nDo this.",
			);
			expect(refusal("[1, 2]")).toBe(
				"Flamework cannot use broken.build: it does not have the shape Flamework writes (/ must be object).\nDo this.",
			);
			expect(refusal(`{ "version": 1, "flameworkVersion": "2.0.0", "identifiers": { "a": 1 } }`)).toBe(
				"Flamework cannot use broken.build: it does not have the shape Flamework writes (/identifiers/a must be string).\nDo this.",
			);

			// A valid one is read; one that is not there starts empty.
			expect(refusal(valid)).toBeUndefined();
			fs.rmSync(file);
			expect(BuildInfo.fromPath(file).getLatestId()).toBe(1);
		} finally {
			fs.rmSync(file, { force: true });
		}
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

describe("the tsconfig entry", () => {
	const TRANSFORM = "@flamework-experimental/transformer";

	// One value of each transformer option, as v1 (or a habit) would have written it on the entry.
	const OPTIONS: [string, unknown][] = [
		["plugins", ["./plugin.cjs"]],
		["noSemanticDiagnostics", true],
		["salt", "s"],
		["hashPrefix", "$g"],
		["obfuscation", true],
		["idGenerationMode", "short"],
		["optimizations", { guardGenerationDedupLimit: 3 }],
	];

	test("the refused options are exactly the transformer section's", () => {
		expect(OPTIONS.map(([key]) => key).sort()).toEqual(
			Object.keys(
				JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../flamework.config.schema.json"), "utf8"))
					.properties.transformer.properties,
			).sort(),
		);
	});

	test.each(OPTIONS)("refuses the option %p, naming the file it belongs in", (key, value) => {
		const file = write("places/a/flamework.config.json", `{ "transformer": { "obfuscation": false } }`);

		expect(() => loadProjectConfig(place, root, { transform: TRANSFORM, [key]: value })).toThrow(
			`Move '${key}' to the "transformer" section of ${file}.`,
		);
		remove("places/a/flamework.config.json");
	});

	test("names the file it would read when there is none yet", () => {
		expect(() => loadProjectConfig(place, root, { transform: TRANSFORM, obfuscation: true })).toThrow(
			`Move 'obfuscation' to the "transformer" section of ${path.join(place, "flamework.config.json")}, a new file.`,
		);
	});

	test("names the file configFile points at", () => {
		const file = write("places/a/config/fw.json", "{}");
		expect(() =>
			loadProjectConfig(place, root, { transform: TRANSFORM, configFile: "config/fw.json", hashPrefix: "$g" }),
		).toThrow(`Move 'hashPrefix' to the "transformer" section of ${file}.`);
		remove("places/a/config/fw.json");
	});

	test("refuses a key that is no transformer option, v1's or a typo, and says to remove it", () => {
		expect(() =>
			loadProjectConfig(place, root, {
				transform: TRANSFORM,
				$rbxpackmode$: true,
				preloadIds: true,
				hashPrefx: "$g",
			}),
		).toThrow(`Remove '$rbxpackmode$', 'preloadIds', 'hashPrefx': not a transformer option.`);
	});

	test("lists every refused key in one message", () => {
		let message = "";
		try {
			loadProjectConfig(place, root, {
				transform: TRANSFORM,
				obfuscation: true,
				hashPrefix: "$g",
				$rbxpackmode$: true,
			});
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message.split("\n")).toEqual([
			`The tsconfig entry for ${TRANSFORM} takes only "transform" and "configFile"; transformer options are read from flamework.config.json.`,
			`Move 'obfuscation', 'hashPrefix' to the "transformer" section of ${path.join(place, "flamework.config.json")}, a new file.`,
			`Remove '$rbxpackmode$': not a transformer option.`,
		]);
	});

	test("accepts the plugin loader's own keys", () => {
		// roblox-ts reads the first five (and passes `transform` and `import` on); ts-patch the rest.
		expect([...LOADER_KEYS]).toEqual([
			"transform",
			"import",
			"type",
			"after",
			"afterDeclarations",
			"name",
			"transformProgram",
			"isEsm",
			"tsConfig",
			"resolvePathAliases",
		]);

		write("places/a/flamework.config.json", `{ "transformer": { "hashPrefix": "$file" } }`);
		const entry = {
			transform: TRANSFORM,
			import: "default",
			type: "program",
			after: false,
			afterDeclarations: false,
			name: "flamework",
			transformProgram: false,
			isEsm: false,
			tsConfig: "./tsconfig.json",
			resolvePathAliases: false,
		};

		expect(loadProjectConfig(place, root, entry).config).toEqual({ hashPrefix: "$file" });
		remove("places/a/flamework.config.json");
	});

	test("still honours configFile, and takes every option from that file alone", () => {
		const file = write(
			"places/a/config/fw.json",
			`{ "transformer": { "hashPrefix": "$x", "obfuscation": true, "optimizations": { "guardGenerationDedupLimit": 3 } } }`,
		);
		const loaded = loadProjectConfig(place, root, { transform: TRANSFORM, configFile: "config/fw.json" });

		expect(loaded.configPath).toBe(file);
		expect(loaded.config).toEqual({
			hashPrefix: "$x",
			obfuscation: true,
			optimizations: { guardGenerationDedupLimit: 3 },
		});
		remove("places/a/config/fw.json");
	});

	test("refuses a configFile that is not a path", () => {
		expect(() => loadProjectConfig(place, root, { transform: TRANSFORM, configFile: true })).toThrow(
			/"configFile" on the tsconfig entry .* must be a path/,
		);
	});

	test("works with no file at all", () => {
		const loaded = loadProjectConfig(place, root, { transform: TRANSFORM });
		expect(loaded.configPath).toBeUndefined();
		expect(loaded.config).toEqual({});
		expect(loaded.project).toEqual({});
	});
});

describe("the tsconfig entry, through rbxtsc", () => {
	/** A line of a stack trace, which a mistake in the project's files is reported without. */
	const STACK = /^\s+at .+:\d+:\d+\)?$/m;
	const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

	test("an option on the entry fails the build and names the file to move it to", () => {
		const result = compileWithEntry({ transform: "@flamework-experimental/transformer", obfuscation: true });

		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			`Move 'obfuscation' to the "transformer" section of ${path.join(FIXTURE, "flamework.config.json")}.`,
		);
		expect(plain(result.output)).not.toMatch(STACK);
	});

	test("a config file that does not parse or validate fails the build without a stack", () => {
		// It was a plain Error, which roblox-ts printed with a stack.
		const file = path.join(FIXTURE, "probe-config", "flamework.config.json");
		const build = (text: string) => {
			fs.writeFileSync(file, text);
			const result = compileWithEntry({
				transform: "@flamework-experimental/transformer",
				configFile: "probe-config/flamework.config.json",
			});
			expect(result.status).not.toBe(0);
			const output = plain(result.output);
			expect(output).not.toMatch(STACK);
			expect(output).not.toContain("Node.js v");
			return output;
		};

		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			expect(build(`{ "transformer": { "hashPrefix": 1 } }`)).toContain(
				`[Flamework]: Invalid ${file}:\n[Flamework]:   /transformer/hashPrefix must be string\n`,
			);
			expect(build(`{ "transformer": { `)).toContain(`[Flamework]: Failed to parse ${file}: '}' expected.\n`);
			expect(build(`{ "transformer": { "obfuscation": "${"${FW_PROBE_UNSET}"}" } }`)).toContain(
				"uses $FW_PROBE_UNSET, which is not set in the environment, .env or .env.local and has no fallback.",
			);
			expect(build(`{ "transformer": { "hashPrefix": "$probe" } }`)).toContain(
				"[Flamework]: The hashPrefix $ is used internally by Flamework\n",
			);
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	}, 300_000);

	test("the loader's keys and configFile build as before", () => {
		const result = compileWithEntry({
			transform: "@flamework-experimental/transformer",
			import: "default",
			type: "program",
			configFile: "flamework.config.json",
		});

		expect(result.status).toBe(0);
		// The `fw` prefix is in the fixture's config file only.
		expect(fs.readFileSync(path.join(FIXTURE, "out", "nested.luau"), "utf8")).toContain("fw:nested@Target");
	});
});

describe("the $schema line", () => {
	const SCHEMA = "./s.json";

	test("points at the schema from the config file, starting with a dot and with forward slashes", () => {
		const schema = path.join(
			root,
			"node_modules",
			"@flamework-experimental",
			"transformer",
			"flamework.config.schema.json",
		);

		expect(getSchemaReference(path.join(root, "flamework.config.json"), schema)).toBe(
			"./node_modules/@flamework-experimental/transformer/flamework.config.schema.json",
		);
		expect(getSchemaReference(path.join(root, "places", "a", "config", "fw.json"), schema)).toBe(
			"../../../node_modules/@flamework-experimental/transformer/flamework.config.schema.json",
		);
	});

	test.if(process.platform === "win32")("points at a schema on another drive with a file URL", () => {
		const other = /^c:/i.test(root) ? "D:\\x\\flamework.config.schema.json" : "C:\\x\\flamework.config.schema.json";
		expect(getSchemaReference(path.join(root, "flamework.config.json"), other)).toMatch(/^file:\/\/\/[CD]:\/x\//);
	});

	test.each([
		[
			"one key per line, tabs, LF",
			`{\n\t"core": { "profiling": true }\n}\n`,
			`{\n\t"$schema": "./s.json",\n\t"core": { "profiling": true }\n}\n`,
		],
		[
			"two spaces, CRLF",
			`{\r\n  "core": {},\r\n  "networking": {}\r\n}\r\n`,
			`{\r\n  "$schema": "./s.json",\r\n  "core": {},\r\n  "networking": {}\r\n}\r\n`,
		],
		[
			"a comment above the first key, trailing commas",
			`{\n\t// the transformer\n\t"transformer": { "obfuscation": true, },\n}`,
			`{\n\t"$schema": "./s.json",\n\t// the transformer\n\t"transformer": { "obfuscation": true, },\n}`,
		],
		[
			"a comment after the brace",
			`{ // settings\n\t"core": {}\n}`,
			`{ // settings\n\t"$schema": "./s.json",\n\t"core": {}\n}`,
		],
		[
			"a blank line after the brace",
			`{\n\n    "core": {}\n}`,
			`{\n\n    "$schema": "./s.json",\n    "core": {}\n}`,
		],
		["a byte order mark", `\uFEFF{\n\t"core": {}\n}`, `\uFEFF{\n\t"$schema": "./s.json",\n\t"core": {}\n}`],
		["one line", `{ "core": {} }`, `{ "$schema": "./s.json", "core": {} }`],
		["empty", `{}`, `{ "$schema": "./s.json" }`],
		["empty with a space", `{ }\n`, `{ "$schema": "./s.json" }\n`],
		["empty over two lines", `{\r\n}\r\n`, `{\r\n\t"$schema": "./s.json"\r\n}\r\n`],
	])("is added as the first key, every other byte kept: %s", (_, text, expected) => {
		expect(insertSchemaReference(text, SCHEMA)).toBe(expected);
	});

	test("is not added when the file has one, wherever it points and wherever it is", () => {
		expect(insertSchemaReference(`{ "$schema": "https://example.com/other.json" }`, SCHEMA)).toBeUndefined();
		expect(insertSchemaReference(`{\n\t"core": {},\n\t"$schema": "../x.json"\n}`, SCHEMA)).toBeUndefined();
	});

	test("is not added to a file that does not parse or is not an object", () => {
		expect(insertSchemaReference(`{ "core": `, SCHEMA)).toBeUndefined();
		expect(insertSchemaReference(`[]`, SCHEMA)).toBeUndefined();
		expect(insertSchemaReference(`{ /* never\nclosed "core": {} }`, SCHEMA)).toBeUndefined();
	});

	test("leaves a file the loader reads as it did", () => {
		const text = `{\n\t// c\n\t"transformer": { "hashPrefix": "$$g", },\n\t"core": { "profiling": true },\n}\n`;
		const before = write("flamework.config.json", text);
		const project = readProjectConfig(before, {});

		write("flamework.config.json", insertSchemaReference(text, SCHEMA)!);
		expect(readProjectConfig(before, {})).toEqual(project);
		remove("flamework.config.json");
	});

	describe("added by a game's build", () => {
		const schema = () =>
			path.join(root, "node_modules", "@flamework-experimental", "transformer", "flamework.config.schema.json");
		const game = () => ({ isGame: true, schema: schema() });

		test("to the file it reads", () => {
			const text = `{\r\n\t"core": { "profiling": false }\r\n}\r\n`;
			const file = write("flamework.config.json", text);

			expect(addSchemaReference(place, root, {}, game())).toEqual({ change: "added", configPath: file });
			expect(fs.readFileSync(file, "utf8")).toBe(
				`{\r\n\t"$schema": "./node_modules/@flamework-experimental/transformer/flamework.config.schema.json",\r\n\t"core": { "profiling": false }\r\n}\r\n`,
			);
			remove("flamework.config.json");
		});

		test("to the file configFile points at, relative to that file", () => {
			const file = write("places/a/config/fw.json", `{ "core": {} }`);

			expect(addSchemaReference(place, root, { configFile: "config/fw.json" }, game())?.change).toBe("added");
			expect(fs.readFileSync(file, "utf8")).toBe(
				`{ "$schema": "../../../node_modules/@flamework-experimental/transformer/flamework.config.schema.json", "core": {} }`,
			);
			remove("places/a/config/fw.json");
		});

		test("in a new file holding just that line, when the game has none and its tsconfig is at the package root", () => {
			const file = path.join(root, "flamework.config.json");

			expect(addSchemaReference(root, root, {}, game())).toEqual({ change: "created", configPath: file });
			expect(fs.readFileSync(file, "utf8")).toBe(
				`{\n\t"$schema": "./node_modules/@flamework-experimental/transformer/flamework.config.schema.json"\n}\n`,
			);
			expect(readProjectConfig(file, {})).toEqual({});
			remove("flamework.config.json");
		});

		test("in no new file below the package root, where it would hide a shared one added later", () => {
			// Guide 09's multi-place layout: places/a has no file of its own and reads the root's once
			// there is one. A file created in places/a would be found first from then on.
			expect(addSchemaReference(place, root, {}, game())).toBeUndefined();
			expect(fs.existsSync(path.join(place, "flamework.config.json"))).toBe(false);

			write("flamework.config.json", `{ "transformer": { "obfuscation": true } }`);
			expect(loadProjectConfig(place, root, {}, {}).config).toEqual({ obfuscation: true });
			remove("flamework.config.json");
		});

		test("never over a $schema the file has", () => {
			const text = `{\n\t"$schema": "../elsewhere.json",\n\t"core": {}\n}\n`;
			const file = write("flamework.config.json", text);

			expect(addSchemaReference(place, root, {}, game())).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(text);
			remove("flamework.config.json");
		});

		test("never for a package, not even to create the file", () => {
			const text = `{ "transformer": { "hashPrefix": "$x" } }`;
			const file = write("flamework.config.json", text);

			expect(addSchemaReference(place, root, {}, { isGame: false, schema: schema() })).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(text);

			remove("flamework.config.json");
			expect(addSchemaReference(root, root, {}, { isGame: false, schema: schema() })).toBeUndefined();
			expect(fs.existsSync(path.join(root, "flamework.config.json"))).toBe(false);
		});

		test("only on a process's first compilation, not on a watcher's rebuilds", () => {
			const text = `{ "core": {} }`;
			const file = write("flamework.config.json", text);

			Cache.isInitialCompile = false;
			try {
				expect(addSchemaReference(place, root, {}, game())).toBeUndefined();
				expect(fs.readFileSync(file, "utf8")).toBe(text);

				remove("flamework.config.json");
				expect(addSchemaReference(root, root, {}, game())).toBeUndefined();
				expect(fs.existsSync(path.join(root, "flamework.config.json"))).toBe(false);
			} finally {
				Cache.isInitialCompile = true;
			}
		});

		test("before the first read, so a watcher's later reads find nothing changed", () => {
			// The build adds the line and then reads the file; a watcher compares every later read
			// against that first one. Creating the file changes where the config comes from, so it
			// has to happen before the first read; adding the line changes nothing the reads keep.
			expect(addSchemaReference(root, root, {}, game())?.change).toBe("created");
			const first = fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}));
			expect(fingerprintProjectConfig(loadProjectConfig(root, root, {}, {}))).toBe(first);
			remove("flamework.config.json");

			const file = write("flamework.config.json", `{ "core": {} }`);
			const without = fingerprintProjectConfig(loadProjectConfig(place, root, {}, {}));
			addSchemaReference(place, root, {}, game());
			expect(fs.readFileSync(file, "utf8")).toContain("$schema");
			expect(fingerprintProjectConfig(loadProjectConfig(place, root, {}, {}))).toBe(without);
			remove("flamework.config.json");
		});

		test("refuses a bad tsconfig entry before writing anything", () => {
			expect(() => addSchemaReference(root, root, { obfuscation: true }, game())).toThrow(/Move 'obfuscation'/);
			expect(fs.existsSync(path.join(root, "flamework.config.json"))).toBe(false);
		});

		test("leaves a file it cannot write alone, without failing the build", () => {
			const text = `{ "core": {} }`;
			const file = write("flamework.config.json", text);
			fs.chmodSync(file, 0o444);

			try {
				expect(addSchemaReference(place, root, {}, game())).toBeUndefined();
				expect(fs.readFileSync(file, "utf8")).toBe(text);
			} finally {
				fs.chmodSync(file, 0o644);
				remove("flamework.config.json");
			}
		});
	});

	describe("finds the installed schema", () => {
		const own = fs.realpathSync(path.resolve(import.meta.dir, "../flamework.config.schema.json"));

		test("through the nearest node_modules link to the running transformer, not its real path", () => {
			// The fixture reaches the transformer through the workspace root's node_modules, where bun
			// links the package: the same walk roblox-ts made to load the entry's `transform`.
			const found = findInstalledSchema(FIXTURE);
			expect(found).toBe(
				path.resolve(
					import.meta.dir,
					"../../../node_modules/@flamework-experimental/transformer/flamework.config.schema.json",
				),
			);
			expect(fs.realpathSync(found)).toBe(own);
		});

		test("at its real path when no node_modules leads to it", () => {
			expect(findInstalledSchema(place)).toBe(path.resolve(import.meta.dir, "../flamework.config.schema.json"));
		});

		test("past a node_modules copy that is not the running transformer", () => {
			write("node_modules/@flamework-experimental/transformer/flamework.config.schema.json", "{}");
			expect(findInstalledSchema(place)).toBe(path.resolve(import.meta.dir, "../flamework.config.schema.json"));
			fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
		});
	});

	describe("through rbxtsc", () => {
		test("a game's build adds the line to the file configFile names, logs it, and emits the same", () => {
			// The fixture is a game (an unscoped name). Its own config file already has a `$schema`,
			// pointing at the repository's copy, which the build keeps; this copy has none.
			const own = path.join(FIXTURE, "flamework.config.json");
			const ownText = fs.readFileSync(own, "utf8");
			const copy = path.join(FIXTURE, "probe-config", "flamework.config.json");
			fs.mkdirSync(path.dirname(copy), { recursive: true });
			// Plugin paths resolve from the package root, so the copy's list works unchanged.
			fs.writeFileSync(copy, ownText.replace(/^\t"\$schema": .*\n/m, ""));

			try {
				const result = compileWithEntry({
					transform: "@flamework-experimental/transformer",
					configFile: "probe-config/flamework.config.json",
				});

				expect(result.status).toBe(0);
				expect(result.output).toContain(
					`Added a "$schema" line to ${path.join("probe-config", "flamework.config.json")}`,
				);
				expect(fs.readFileSync(copy, "utf8")).toStartWith(
					`{\n\t"$schema": "../../../../../node_modules/@flamework-experimental/transformer/flamework.config.schema.json",\n\t"transformer": {`,
				);
				expect(fs.readFileSync(path.join(FIXTURE, "out", "nested.luau"), "utf8")).toContain("fw:nested@Target");
			} finally {
				fs.rmSync(path.dirname(copy), { recursive: true, force: true });
				// What later tests read from disk is the ordinary build again.
				expect(compileFixtureFresh().status).toBe(0);
			}

			expect(fs.readFileSync(own, "utf8")).toBe(ownText);
		});
	});
});

describe("the schema", () => {
	test("states every option's default, which the $schema line shows in an editor", () => {
		type Node = { description?: string; properties?: Record<string, Node> };
		const schema = JSON.parse(
			fs.readFileSync(path.join(import.meta.dir, "../flamework.config.schema.json"), "utf8"),
		);
		const missing = new Array<string>();
		const walk = (node: Node, name: string) => {
			for (const [key, option] of Object.entries(node.properties ?? {})) {
				if (!/ Default: /.test(option.description ?? "")) missing.push(`${name}${key}`);
				walk(option, `${name}${key}.`);
			}
		};

		// The sections themselves are not options, and neither is `$schema`.
		for (const [section, node] of Object.entries(schema.properties as Record<string, Node>)) {
			walk(node, `${section}.`);
		}

		expect(missing).toEqual([]);
	});
});

describe("runtime sections", () => {
	test("are collected for the config artifact and nothing else is", () => {
		expect(
			getRuntimeConfig({
				transformer: { hashPrefix: "$x" },
				// Compiled into the encoding code, like the transformer's options: not for the runtime.
				serialization: { checks: { category: "all" } },
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
			components: { warningTimeout: 2, watchRenames: true },
			scopes: { active: ["fixture", "demo"] },
			testing: { enabled: false, entry: ["out", "env"] },
		});
	});
});
