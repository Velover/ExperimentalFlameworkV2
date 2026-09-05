import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { compileFixture, emitted } from "./compile";

const { findProjectConfig, getRuntimeConfig, loadProjectConfig, readProjectConfig } =
	await import("../out/util/projectConfig.js");

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
			}),
		).toEqual({ core: { profiling: false }, networking: { serialization: true } });
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

	test("writes the runtime sections to include/flamework/config.json", () => {
		compileFixture();
		const artifact = path.join(FIXTURE, "include", "flamework", "config.json");
		expect(fs.existsSync(artifact)).toBe(true);
		expect(JSON.parse(fs.readFileSync(artifact, "utf8"))).toEqual({
			networking: { serialization: true },
			components: { warningTimeout: 2 },
		});
	});
});
