import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import {
	compileFixture,
	compileFixtureFresh,
	compileFixtureWithEnv,
	compileProbe,
	compileProbes,
	emitted,
	normalize,
	transformInProcess,
} from "./compile";

const FIXTURE = path.resolve(import.meta.dir, "fixture");

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile:\n${result.output}`);
	}
});

describe("inherited constructors", () => {
	test("resolves a generic base's parameter to the type argument at the subclass", () => {
		// Regression: read as `T`, this crashed rbxtsc with a TypeError inside the emitter.
		const source = normalize(emitted("inherited"));

		expect(source).toContain('Reflect.defineMetadata(Derived, "flamework:parameters", { "fw:inherited@Dep" })');
		expect(source).toMatch(
			/defineMetadata\(Derived, "flamework:dependencies", \{ \{ id = "fw:inherited@Dep",? \},? \}\)/,
		);

		// The generic base's own constructor cannot resolve `T`; it gets a named placeholder instead of
		// failing the build, since only its subclasses are ever constructed.
		expect(source).toContain('Reflect.defineMetadata(GenericBase, "flamework:parameters", { "$tp:T" })');
	});
});

describe("guard emission", () => {
	test("uses the list variants beyond two members", () => {
		const source = normalize(emitted("guards"));

		expect(source).toContain('t.literalList({ "a", "b", "c", "d", "e" })');
		expect(source).toContain("t.unionList({ t.string, t.number, t.Vector3 })");
	});

	test("keeps the vararg form for two members", () => {
		expect(emitted("guards")).toContain("t.union(t.string, t.number)");
	});

	test("deduplicates a type repeated past the configured limit", () => {
		const source = normalize(emitted("dedup"));

		// `Point` is hoisted into one local and referenced by each field.
		expect(source).toMatch(/local Point\w* = t\.interface\(\{ x = t\.number, y = t\.number, \}\)/);
		expect(source).toMatch(/t\.interface\(\{ a = Point\w*, b = Point\w*, c = Point\w*, \}\)/);
		expect(source.match(/t\.interface\(\{ x = t\.number/g) ?? []).toHaveLength(1);
	});
});

describe("callsite uuids", () => {
	function uuids(source: string) {
		return [...source.matchAll(/callsiteId\("([0-9a-f-]{36})"\)/g)].map((m) => m[1]);
	}

	test("gives distinct callsites distinct ids", () => {
		const ids = uuids(emitted("callsites"));

		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
	});

	test("emits the same ids on a second compilation", () => {
		// Regression: `randomUUID()` per compile renamed every remote folder on every build.
		const before = uuids(emitted("callsites"));

		const fresh = compileFixtureFresh();
		if (fresh.status !== 0) {
			throw new Error(`fixture failed to recompile:\n${fresh.output}`);
		}

		expect(uuids(emitted("callsites"))).toEqual(before);
	});

	test("change with every build under obfuscation", () => {
		// The uuids name every remote, so ones that survived a release could be mapped once and
		// reused against the next. A plain build recreates flamework.build and with it the seed
		// they are derived from, so two builds disagree; the plain run above is the control.
		const plain = uuids(emitted("callsites"));

		const first = compileFixtureWithEnv({
			FLAMEWORK_FIXTURE_OBFUSCATE: "true",
			FLAMEWORK_FIXTURE_IDMODE: "obfuscated",
		});
		if (first.status !== 0) {
			throw new Error(`fixture failed to compile obfuscated:\n${first.output}`);
		}

		const second = compileFixtureWithEnv({
			FLAMEWORK_FIXTURE_OBFUSCATE: "true",
			FLAMEWORK_FIXTURE_IDMODE: "obfuscated",
		});
		if (second.status !== 0) {
			throw new Error(`fixture failed to compile obfuscated again:\n${second.output}`);
		}

		try {
			const firstIds = uuids(first.files.get("callsites")!);
			const secondIds = uuids(second.files.get("callsites")!);

			expect(firstIds).toHaveLength(2);
			expect(secondIds).toHaveLength(2);
			expect(firstIds).not.toEqual(secondIds);
			expect(firstIds).not.toEqual(plain);
			expect(firstIds[0]).not.toBe(firstIds[1]);
		} finally {
			// Back to the ordinary build on disk, which later tests read artifacts from.
			const restored = compileFixtureFresh();
			if (restored.status !== 0) {
				throw new Error(`fixture failed to restore:\n${restored.output}`);
			}
		}
	});
});

describe("module records", () => {
	// Path registration finds a class its module does not export through the record of the module
	// that defined it: the ModuleScript itself, `script`, never the identifier, which says nothing
	// about where a class came from once ids are short, tiny or obfuscated.
	const record = (name: string) => `Reflect.defineMetadata(${name}, "flamework:module", script)`;

	function expectRecords(source: string) {
		const normalized = normalize(source);
		expect(normalized).toContain(record("FixtureHiddenProvider"));
		expect(normalized).toContain(record("FixtureExportedProvider"));
		expect(normalized).toContain(record("FixtureNamespacedProvider"));
		expect(normalized).not.toContain(record("FixtureLocalProvider"));
		expect(normalized).not.toContain(record("FixtureUndecorated"));
	}

	test("records every class the module creates as it loads, exported or not, and none a function creates", () => {
		const source = emitted("discovery");
		expectRecords(source);

		// The class made by a call still gets everything else: only the record is left out.
		expect(normalize(source)).toContain(
			`Reflect.defineMetadata(FixtureLocalProvider, "identifier", "fw:discovery@fixtureFactory.FixtureLocalProvider")`,
		);
	});

	test.each(["short", "tiny", "obfuscated"])("records the same way under the %s id generation mode", (mode) => {
		const result = compileFixtureWithEnv({ FLAMEWORK_FIXTURE_IDMODE: mode });
		try {
			expect(result.status).toBe(0);
			const source = result.files.get("discovery")!;
			expectRecords(source);

			// The ids themselves no longer name the file.
			expect(normalize(source)).not.toContain(`"fw:discovery@FixtureHiddenProvider"`);
		} finally {
			const restored = compileFixtureFresh();
			if (restored.status !== 0) {
				throw new Error(`fixture failed to restore:\n${restored.output}`);
			}
		}
	});

	test("records the same way with obfuscation on", () => {
		const result = compileFixtureWithEnv({
			FLAMEWORK_FIXTURE_OBFUSCATE: "true",
		});
		try {
			expect(result.status).toBe(0);
			expectRecords(result.files.get("discovery")!);
		} finally {
			const restored = compileFixtureFresh();
			if (restored.status !== 0) {
				throw new Error(`fixture failed to restore:\n${restored.output}`);
			}
		}
	});
});

describe("dependencies on components", () => {
	const component = `import { BaseComponent, Component } from "@flamework-experimental/components";

@Component({})
export class QuestsUI extends BaseComponent<{}, Instance> {}
`;

	test("refuses Dependency<T>() on a component", () => {
		const result = compileProbe(
			"dependencyOnComponent",
			`${component}
import { Dependency } from "@flamework-experimental/core";

export const ui = Dependency<QuestsUI>();
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("'QuestsUI' is a component (@Component), not a provider");
		expect(result.output).toContain("Make 'QuestsUI' a @Provider()");
		expect(result.output).toContain("getComponent<QuestsUI>(instance)");
	});

	test("refuses module.resolveDependency<T>() on a component", () => {
		const result = compileProbe(
			"resolveOnComponent",
			`${component}
import { Flamework } from "@flamework-experimental/core";

export const ui = Flamework.createModule().ignite().resolveDependency<QuestsUI>();
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("'QuestsUI' is a component (@Component), not a provider");
	});

	test("refuses a provider's constructor taking a component", () => {
		const result = compileProbe(
			"providerTakesComponent",
			`${component}
import { Provider } from "@flamework-experimental/core";

@Provider()
export class QuestHandler {
	constructor(private readonly ui: QuestsUI) {}
}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("'QuestHandler' takes 'QuestsUI' in its constructor");
		expect(result.output).toContain("take Components");
	});

	test("judges nothing it cannot be sure of", () => {
		const result = compileProbe(
			"dependencyNotJudged",
			`${component}
import { Components, ComponentMetadata } from "@flamework-experimental/components";
import { Dependency, Flamework, Injectable, Modding, Provider } from "@flamework-experimental/core";

export interface Storage {}
export abstract class AbstractStorage {}

@Provider()
export class Economy {}

/** A class a function provider may stand behind. */
export class Plain {}

// Provided by the component plugin, not registered.
export const components = Dependency<Components>();
export const economy = Dependency<Economy>();
export const storage = Dependency<Storage>();
export const abstractStorage = Dependency<AbstractStorage>();
export const plain = Dependency<Plain>();

// An id passed by hand generates no metadata, and is the way past this check.
export const explicit = Dependency<QuestsUI>(undefined, Flamework.id<QuestsUI>());

// A component's constructor takes components on its own instance.
@Component({ tag: "Car" })
export class Car extends BaseComponent<{}, Instance> {
	constructor(metadata: ComponentMetadata, public readonly ui: QuestsUI) {
		super(metadata);
	}
}

// An injectable may be handed one through overrideDependency.
@Injectable()
export class Session {
	constructor(public readonly ui: QuestsUI) {}
}

// A macro of the user's may do anything with the dependency it is given.
/** @metadata macro */
export function myDependency<T>(info?: Modding.Target.Dependency<T>) {
	return info;
}
export const custom = myDependency<QuestsUI>();
`,
		);

		expect(result.output).not.toContain("not a provider");
		expect(result.status).toBe(0);
	});
});

describe("glob registration", () => {
	test("records the paths a glob matched in the build info", () => {
		const buildInfo = JSON.parse(fs.readFileSync(path.join(FIXTURE, "flamework.build"), "utf8"));
		const paths: string[] | undefined = buildInfo.metadata?.globs?.paths?.["src/glob/**/*.ts"];

		expect(paths).toBeDefined();
		expect(paths!.some((p) => p.replace(/\\/g, "/").startsWith("out/glob/target"))).toBe(true);
	});

	test("records how deep the include folder sits, so paths resolve from the tree's root", () => {
		// The fixture's Rojo tree is a plain Folder, as a plugin's is: paths are emitted relative to
		// it (`{ "out", "glob" }`, no service) and the runtime climbs from the include folder to it.
		const paths = JSON.parse(fs.readFileSync(path.join(FIXTURE, "include", "flamework", "paths.json"), "utf8"));

		expect(paths).toEqual({ includeDepth: 1 });
		expect(emitted("globs")).toContain('registerProviders("src/glob", nil, { "out", "glob" })');
	});

	test("passes the glob through to the runtime as a string, past the options parameter", () => {
		// The registration options sit between the glob and the generated argument, so a call
		// without them gets a `nil` there and the generated string lands on the right parameter.
		expect(emitted("globs")).toContain('registerProvidersGlob("src/glob/**/*.ts", nil, "src/glob/**/*.ts")');
	});

	test("fires the path macros on a plugin target", () => {
		// `PluginTarget`'s members are function-typed properties; a macro on one has to fire as it
		// does on the builder's method, or the plugin registers nothing and nothing complains.
		const source = emitted("globs");

		expect(
			source.match(/registerProvidersGlob\("src\/glob\/\*\*\/\*\.ts", nil, "src\/glob\/\*\*\/\*\.ts"\)/g),
		).toHaveLength(2);
		expect(source).toMatch(/registerProviders\("src\/glob", nil, \{/);
	});
});

describe("a glob that matches no files", () => {
	// A glob matching nothing resolves to no paths, so whatever it is given to registers nothing;
	// the build says so where the glob is used, without failing, since a folder may be empty on
	// purpose. fixture/src/globWarnings.ts has two such globs and a relative one that matches.
	const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");
	const warning = (location: string, glob: string) =>
		`${location} - the glob ${glob} given to registerProvidersGlob matches no files`;

	test("is warned about where it is used, once per use, and the build still passes", () => {
		const result = compileFixture();
		const output = plain(result.output);

		expect(result.status).toBe(0);
		expect(output).toContain(warning("src/globWarnings.ts:6:3", "'src/missing/**/*.ts'"));
		expect(output.match(/matches no files/g)).toHaveLength(2);
	});

	test("is named as written and as resolved when it is relative", () => {
		expect(plain(compileFixture().output)).toContain(
			warning("src/globWarnings.ts:7:3", "'./missing/*.ts' (src/missing/*.ts)"),
		);
	});

	test("is not warned about once it matches, relative or not", () => {
		const output = plain(compileFixture().output);

		expect(output).not.toContain("'./glob/*.ts'");
		expect(output).not.toContain("'src/glob/**/*.ts'");
	});

	test("still resolves, to no paths", () => {
		const source = emitted("globWarnings");
		expect(source).toContain('registerProvidersGlob("src/missing/**/*.ts", nil, "src/missing/**/*.ts")');
		expect(source).toContain('registerProvidersGlob("./missing/*.ts", nil, "src/missing/*.ts")');

		const globs = JSON.parse(fs.readFileSync(path.join(FIXTURE, "include", "flamework", "globs.json"), "utf8"));
		expect(globs.game["src/missing/**/*.ts"]).toEqual([]);
		expect(globs.game["src/missing/*.ts"]).toEqual([]);
		expect(globs.game["src/glob/*.ts"]).toEqual([["out", "glob", "target"]]);
	});

	test("is named as written under obfuscation, which hashes the glob the runtime is given", () => {
		const result = compileFixtureWithEnv({ FLAMEWORK_FIXTURE_OBFUSCATE: "true" });
		try {
			const output = plain(result.output);
			expect(result.status).toBe(0);
			expect(output).toContain(warning("src/globWarnings.ts:6:3", "'src/missing/**/*.ts'"));
			expect(output).toContain(warning("src/globWarnings.ts:7:3", "'./missing/*.ts' (src/missing/*.ts)"));
			expect(output.match(/matches no files/g)).toHaveLength(2);

			// The generated argument is the hash, not the glob.
			expect(result.files.get("globWarnings")).not.toContain('nil, "src/missing/**/*.ts")');
		} finally {
			const restored = compileFixtureFresh();
			if (restored.status !== 0) {
				throw new Error(`fixture failed to restore:\n${restored.output}`);
			}
		}
	});
});

describe("a path macro whose source path holds no module", () => {
	// The path still compiles to a Rojo path, but the place has nothing there, or nothing but an empty
	// folder, and the call waits for it at runtime (requireModules raises after five seconds); the
	// build says so where the path is used, without failing. fixture/src/pathWarnings.ts has three
	// such paths, one misspelled module, one that holds modules and a folder of JSON modules.
	const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

	test("is warned about where it is used, naming the call and the path, and the build still passes", () => {
		const result = compileFixture();
		const output = plain(result.output);

		expect(result.status).toBe(0);
		expect(output).toContain(
			`src/pathWarnings.ts:8:3 - registerProviders("src/missing"): there is no such file or folder, so the place will not have it, and the call waits for it at runtime`,
		);
		expect(output).toContain(
			`src/pathWarnings.ts:12:33 - ComponentPlugin.fromPath("src/missing/components"): there is no such file or folder`,
		);
	});

	test("names what is on disk when only the case differs, since the place keeps the case", () => {
		const output = plain(compileFixture().output);

		expect(output).toContain(
			`src/pathWarnings.ts:9:3 - registerProviders("src/Glob"): there is no such file or folder; on disk it is 'src/glob', and the place names it as the disk does`,
		);
		expect(output).toContain(
			`src/pathWarnings.ts:16:9 - requireModules("src/glob/Target"): there is no such file or folder; on disk it is 'src/glob/target.ts'`,
		);
	});

	test("says that requireModules raises, where registration waits", () => {
		const output = plain(compileFixture().output);

		expect(output).toContain(
			`requireModules("src/glob/Target"): there is no such file or folder; on disk it is 'src/glob/target.ts', and the place names it as the disk does, so the call raises at runtime after waiting five seconds for a name the place does not have`,
		);
		expect(output).toContain(
			`registerProviders("src/Glob"): there is no such file or folder; on disk it is 'src/glob', and the place names it as the disk does, so the call waits at runtime for a name the place does not have`,
		);
	});

	test("says when the folder is there but nothing in it compiles to a module", () => {
		expect(plain(compileFixture().output)).toContain(
			`src/pathWarnings.ts:10:3 - registerProviders("src/typesOnly"): nothing in that folder compiles to a module`,
		);
	});

	test("is not warned about for a folder or a module that is there", () => {
		const output = plain(compileFixture().output);

		expect(output).not.toContain(`registerProviders("src/glob")`);
		expect(output).not.toContain(`requireModules("src/glob")`);
		expect(output).not.toContain(`requireModules("src/glob/target")`);
		expect(output).not.toContain(`requireModules("src/jsonOnly")`);
		expect(output.match(/ - [\w.]+\("[^"]*"\): (there is no such|nothing in that folder)/g)).toHaveLength(5);
	});

	test("still compiles to the Rojo path", () => {
		const source = normalize(emitted("pathWarnings"));
		expect(source).toContain('registerProviders("src/missing", nil, { "out", "missing" })');
		expect(source).toContain('requireModules("src/glob/Target", { "out", "glob", "Target" })');
	});
});

describe("an incremental build without a tsBuildInfoFile", () => {
	// TypeScript builds such a project incrementally into its default tsbuildinfo, beside the config,
	// and recompiles only the files that changed. Flamework went by `tsBuildInfoFile` alone, took every
	// such build for a clean one and made a fresh flamework.build, so a recompiled file named the class
	// of a file left alone by a new id in the short, tiny and obfuscated modes: a dependency that never
	// resolves. The build info has to be reused whenever TypeScript's own tsbuildinfo is there.
	const probe = path.join(FIXTURE, "tsconfig.incremental-probe.json");
	const alphaFile = path.join(FIXTURE, "src", "incrementalAlpha.ts");
	const betaFile = path.join(FIXTURE, "src", "incrementalBeta.ts");
	const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");

	const compile = () => {
		const result = spawnSync("node", [RBXTSC, "-p", probe], {
			cwd: FIXTURE,
			encoding: "utf8",
			env: { ...process.env, FLAMEWORK_FIXTURE_IDMODE: "short" },
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		expect({ status: result.status, output }).toMatchObject({ status: 0 });
	};
	const read = (file: string) => fs.readFileSync(path.join(FIXTURE, "out", file), "utf8");
	const declared = () => read("incrementalAlpha.luau").match(/"identifier", "([^"]+)"/)![1];
	const named = () => read("incrementalBeta.luau").match(/"flamework:parameters", \{ "([^"]+)" \}/)![1];
	const salt = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, "flamework.build"), "utf8")).salt as string;

	test("reuses flamework.build once the tsbuildinfo is there, and starts afresh without it", () => {
		const { config } = ts.readConfigFile(path.join(FIXTURE, "tsconfig.json"), ts.sys.readFile);
		config.compilerOptions.incremental = true;
		const buildInfoFile = ts.getTsBuildInfoEmitOutputFilePath(
			ts.parseJsonConfigFileContent(config, ts.sys, FIXTURE, undefined, probe).options,
		)!;
		const leftovers = [probe, buildInfoFile, alphaFile, betaFile];
		const cleanUp = () => leftovers.forEach((file) => fs.rmSync(file, { force: true }));

		cleanUp();
		fs.writeFileSync(probe, JSON.stringify(config, undefined, "\t"));
		fs.writeFileSync(
			alphaFile,
			`import { Provider } from "@flamework-experimental/core";\n\n@Provider()\nexport class IncrementalAlpha {}\n`,
		);
		fs.writeFileSync(
			betaFile,
			`import { Provider } from "@flamework-experimental/core";\nimport { IncrementalAlpha } from "./incrementalAlpha";\n\n@Provider()\nexport class IncrementalBeta {\n\tconstructor(private readonly alpha: IncrementalAlpha) {}\n}\n`,
		);

		try {
			// With no tsbuildinfo yet: a clean build, a flamework.build of its own.
			compile();
			expect(fs.existsSync(buildInfoFile)).toBe(true);
			const first = { declared: declared(), salt: salt(), alpha: read("incrementalAlpha.luau") };
			expect(named()).toBe(first.declared);

			// Only beta changes, so only beta is compiled again: it must name alpha as alpha still says.
			fs.appendFileSync(betaFile, "\n// changed\n");
			compile();
			expect(read("incrementalAlpha.luau")).toBe(first.alpha);
			expect(named()).toBe(first.declared);
			expect(salt()).toBe(first.salt);

			// A genuinely clean build still starts afresh: a new salt, and every file compiled again.
			fs.rmSync(buildInfoFile, { force: true });
			compile();
			expect(salt()).not.toBe(first.salt);
			expect(named()).toBe(declared());
		} finally {
			cleanUp();
			const restored = compileFixtureFresh();
			if (restored.status !== 0) {
				throw new Error(`fixture failed to restore:\n${restored.output}`);
			}
		}
	}, 600_000);
});

describe("findSourcePath", () => {
	// What the path warning is judged on, against a folder of its own.
	const load = async () => (await import("../out/util/functions/findSourcePath.js")).findSourcePath;

	test("matches names exactly, maps a module to its instance name and looks through folders", async () => {
		const findSourcePath = await load();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-source-path-"));
		try {
			for (const file of [
				"src/server/commands/kick.ts",
				"src/server/main.server.ts",
				"src/shared/types/shapes.d.ts",
				"src/shared/nested/deep/module.luau",
				"src/shared/withPackages/node_modules/x/index.ts",
			]) {
				fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
				fs.writeFileSync(path.join(root, file), "");
			}
			fs.mkdirSync(path.join(root, "src/shared/empty"), { recursive: true });

			expect(findSourcePath(root, "src/server/commands")).toEqual({ kind: "modules" });
			expect(findSourcePath(root, "src/server/commands/kick")).toEqual({ kind: "modules" });
			expect(findSourcePath(root, "src/server/main")).toEqual({ kind: "modules" });
			expect(findSourcePath(root, "src/shared/nested")).toEqual({ kind: "modules" });
			expect(findSourcePath(root, "./src/server/../server/commands")).toEqual({ kind: "modules" });

			expect(findSourcePath(root, "src/shared/types")).toEqual({ kind: "empty" });
			expect(findSourcePath(root, "src/shared/empty")).toEqual({ kind: "empty" });
			expect(findSourcePath(root, "src/shared/withPackages")).toEqual({ kind: "empty" });

			expect(findSourcePath(root, "src/server/nope")).toEqual({ kind: "missing" });
			expect(findSourcePath(root, "src/server/Commands")).toEqual({
				kind: "missing",
				actual: "src/server/commands",
			});
			expect(findSourcePath(root, "src/Server/commands/Kick")).toEqual({
				kind: "missing",
				actual: "src/server/commands/kick.ts",
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("findPlaceSource", () => {
	// The same judgement, made the way Rojo builds the place: from the deepest `$path` that covers the
	// Rojo path, which is the sources for a folder inside `out`, and the disk for a `$path` of its own.
	const load = async () => (await import("../out/util/functions/findSourcePath.js")).findPlaceSource;

	test("follows the project's $paths, Rojo's modules, and exact names below the $path", async () => {
		const findPlaceSource = await load();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-place-source-"));
		try {
			for (const file of [
				"src/server/services2/thing.ts",
				"src/shared/json/a.json",
				"src/shared/toml/a.toml",
				"src/shared/yaml/a.yml",
				"src/shared/model/a.rbxm",
				"src/shared/text/a.txt",
				"src/shared/types/a.d.ts",
				"extra2/mod.luau",
				"extra2/config.json",
			]) {
				fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
				fs.writeFileSync(path.join(root, file), "");
			}

			const at = (...parts: string[]) => path.join(root, ...parts);
			// As the Rojo resolver lists them: a nested `$path` inside the out-mapped TS folder, and the
			// folder itself.
			const partitions = [
				{ rbxPath: ["ServerScriptService", "TS", "Nested"], fsPath: at("extra2") },
				{ rbxPath: ["ServerScriptService", "TS"], fsPath: at("out", "server") },
				{ rbxPath: ["ReplicatedStorage", "TS"], fsPath: at("out", "shared") },
			];
			const directories = { rootDir: at("src"), outDir: at("out") };
			const find = (...rbxPath: string[]) => findPlaceSource(rbxPath, partitions, directories, root);

			// A `$path` nested in an out-mapped folder is what the place has there, and its modules count.
			expect(find("ServerScriptService", "TS", "Nested")).toEqual({ kind: "modules" });
			expect(find("ServerScriptService", "TS", "Nested", "mod")).toEqual({ kind: "modules" });
			expect(find("ServerScriptService", "TS", "Nested", "config")).toEqual({ kind: "modules" });
			expect(find("ServerScriptService", "TS", "Nested", "nope")).toEqual({ kind: "missing" });

			// Inside out, the sources: exact below the $path, and a case difference is named.
			expect(find("ServerScriptService", "TS", "services2")).toEqual({ kind: "modules" });
			expect(find("ServerScriptService", "TS", "Services2")).toEqual({
				kind: "missing",
				actual: "src/server/services2",
			});

			// JSON, TOML, YAML and model files are modules to Rojo; text and declarations are not.
			for (const folder of ["json", "toml", "yaml", "model"]) {
				expect(find("ReplicatedStorage", "TS", folder)).toEqual({ kind: "modules" });
			}
			expect(find("ReplicatedStorage", "TS", "json", "a")).toEqual({ kind: "modules" });
			expect(find("ReplicatedStorage", "TS", "text")).toEqual({ kind: "empty" });
			expect(find("ReplicatedStorage", "TS", "types")).toEqual({ kind: "empty" });

			// No $path covers it: the caller falls back to the source path.
			expect(find("Workspace", "Thing")).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("plugin host", () => {
	test("loads a plugin for a second transformer state in the same process", async () => {
		// Regression: the host relied on `require` re-running the plugin's top level, which Node's
		// module cache prevents, so every watch-mode rebuild failed with "did not call registerPlugin()".
		const { createPluginHost } = await import("../out/transformations/plugins/pluginHost.js");

		const state = {
			config: { plugins: [{ path: "./fieldInfoPlugin.cjs", options: { prefix: "" } }] },
			rootDirectory: FIXTURE,
			typeChecker: undefined,
			nextRootStatements: [],
		} as never;

		const first = createPluginHost(state);
		const second = createPluginHost(state);

		expect(first?.getRegisteredMacroTypes()).toContain("fieldInfo");
		expect(second?.getRegisteredMacroTypes()).toContain("fieldInfo");
	});
});

describe("constant callsite metadata", () => {
	test("hoists Constant metadata to the file root whether or not it is wrapped in Emit", () => {
		const source = normalize(emitted("constant"));

		// Regression: `Constant<Emit<T>>` has both markers and the `Emit` one was found first, so the
		// documented form was rebuilt on every call instead of being shared.
		expect(source).toMatch(/local withEmit_\d+ = \{ marker = true, \}/);
		expect(source).toMatch(/withEmit\(withEmit_\d+\)/);
		expect(source).toMatch(/local plain_\d+ = \{ marker = true, \}/);
		expect(source).toMatch(/plain\(plain_\d+\)/);
	});
});

describe("component links", () => {
	test("stores an instance-valued attribute as a handle and links the instance it names", () => {
		const source = normalize(emitted("components"));

		// The attribute holds an `InstanceHandle`, so that is what the attribute guard checks. The
		// class it has to resolve to is checked by the link instead.
		expect(source).toContain(`Target = t.typeof("InstanceHandle")`);
		expect(source).toContain(`Spare = t.optional(t.typeof("InstanceHandle"))`);
		expect(source).toContain(
			`kind = "attribute", name = "Target", optional = false, shape = { isA = { "BasePart" }, },`,
		);
		expect(source).toContain(`kind = "attribute", name = "Spare", optional = true, shape = { isA = { "Part" }, },`);
	});

	test("links the component an attribute names, by its identifier, with no shape of its own", () => {
		// The instance has to carry the component, and that component's tracker checks its tree.
		expect(normalize(emitted("components"))).toContain(
			`kind = "attribute", name = "Handler", optional = false, component = "fw:components@HandlerComponent",`,
		);
	});

	test("links a component named by the instance tree, guarding the child as its instance", () => {
		const source = normalize(emitted("components"));

		// The child's own class is part of the instance shape, so the link only has to name the
		// component that must be attached to it.
		expect(source).toContain(`EffectHandler = { isA = { "BasePart" }, }`);
		expect(source).toContain(
			`kind = "child", name = "EffectHandler", optional = false, component = "fw:components@HandlerComponent",`,
		);
	});

	test("leaves the tree a linked component needs to that component", () => {
		// The link names the component; what its instance has to look like is that component's
		// own shape, checked and watched by its own tracker rather than written here again.
		const source = normalize(emitted("components"));

		expect(source).toContain(`name = "Rig", optional = false, component = "fw:components@RigComponent",`);
		expect(source).not.toContain(`name = "Rig", optional = false, shape`);
	});

	test("leaves an attribute that asks for the handle itself unlinked", () => {
		const source = normalize(emitted("components"));

		expect(source).toContain(`Raw = t.typeof("InstanceHandle")`);
		expect(source).not.toContain(`name = "Raw"`);
	});

	test("rewrites writes to an attribute into the component's setter", () => {
		const source = normalize(emitted("components"));

		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "label", "renamed")`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "speed", self.attributes.speed + 1)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "speed", self.attributes.speed + 1, true)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "label", nil)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "Target", part)`);
	});

	test("keeps a macro call's identifier in the value a mutating write is given", () => {
		// Regression: `++` and `--` handed the operand to the emitter as written, so the copy of the
		// receiver inside the value was never transformed and lost the id this pass injects. The
		// write then called `getComponent` with no specifier and threw at runtime.
		const source = normalize(emitted("components"));
		const receiver = `self.components:getComponent(other, "fw:components@CounterComponent")`;

		expect(source).toContain(`_[SYMBOL_ATTRIBUTE_SETTER](_, "count", ${receiver}.attributes.count + 1, true)`);
		expect(source).toContain(`_[SYMBOL_ATTRIBUTE_SETTER](_, "count", ${receiver}.attributes.count + 1)`);
		expect(source).not.toContain(`getComponent(other).attributes`);
	});

	test("links a second child naming a component, and keeps the shapes beside it legal", () => {
		// The fixture compiling at all is the assertion for the legal shapes (see `beforeAll`): a
		// required child, an optional attribute, and two children naming a component.
		const source = normalize(emitted("components"));

		expect(source).toContain(`Plain = { isA = { "BasePart" }, }`);
		expect(source).toContain(`label = t.optional(t.string)`);
		expect(source).toContain(`SpareHandler = { isA = { "BasePart" }, }`);
		expect(source).toContain(
			`kind = "child", name = "SpareHandler", optional = false, component = "fw:components@HandlerComponent",`,
		);
	});

	test("rejects an optional child naming a component", () => {
		// A component that may be missing is not a child `this.instance` can be indexed for
		// either: it is reached through an optional link attribute, or looked up.
		const result = compileProbe(
			"optionalComponentChild",
			`import { BaseComponent, Component } from "@flamework-experimental/components";

@Component({ tag: "FixtureOptionalCore" })
export class CoreComponent extends BaseComponent<{}, BasePart> {}

@Component({ tag: "FixtureOptionalCannon" })
export class CannonComponent extends BaseComponent<{}, Model & { Core?: CoreComponent }> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Child 'Core' of the instance tree of 'CannonComponent' is optional");
		expect(result.output).toContain("optional link attribute");
	});
});

describe("instance shapes", () => {
	test("writes the instance tree as data, class names and children by name", () => {
		const source = normalize(emitted("components"));

		expect(source).toContain(
			`instanceShape = { isA = { "Model" }, children = { Root = { isA = { "BasePart" }, }, }, }`,
		);
		expect(source).toContain(`instanceShape = { isA = { "BasePart" }, }`);
	});

	test("nests the shape as deep as the tree goes, and lists the classes a child may be", () => {
		expect(normalize(emitted("components"))).toContain(
			`instanceShape = { isA = { "Model" }, children = { Root = { isA = { "BasePart" }, children = { Texture = { isA = { "Texture", "Decal" }, }, }, }, }, }`,
		);
	});

	test("falls back to a guard for a union whose members declare children of their own", () => {
		// Which children go with which class is more than a shape says.
		const source = normalize(emitted("components"));

		expect(source).toContain(
			`tag = "FixtureEither", attributes = {}, instanceGuard = t.union(t.intersection(t.instanceIsA("Model"), t.children({ Root = t.instanceIsA("BasePart"), })), t.intersection(t.instanceIsA("Folder"), t.children({ Core = t.instanceIsA("Folder"), }))), }`,
		);
	});

	test("stops at the class of a child that names a component", () => {
		// `RigComponent` asks for a `Root`; the owner's shape does not repeat that, because the
		// child's component is what checks and watches the tree below the child.
		expect(normalize(emitted("components"))).toContain(
			`instanceShape = { isA = { "Model" }, children = { Rig = { isA = { "Model" }, }, }, }`,
		);
	});

	test("keeps a guard written by hand, with no shape beside it", () => {
		expect(normalize(emitted("components"))).toContain(
			`tag = "FixtureCustom", instanceGuard = t.instanceIsA("Part"), attributes = {}, }`,
		);
	});

	test("rejects an optional child of the instance tree", () => {
		// `this.instance.Head` is an index into the instance, which raises on a child that is not
		// there, so the optional type would promise a read Roblox does not allow.
		const result = compileProbe(
			"optionalChild",
			`import { BaseComponent, Component } from "@flamework-experimental/components";

interface Character extends Model {
	Head?: BasePart;
	HumanoidRootPart: BasePart;
}

@Component({ tag: "FixtureOptionalChild" })
export class CharacterComponent extends BaseComponent<{}, Character> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Child 'Head' of the instance tree of 'CharacterComponent' is optional");
		expect(result.output).toContain("Roblox raises when a child that does not exist is indexed");
	});

	test("rejects an optional child deeper in the instance tree", () => {
		const result = compileProbe(
			"optionalGrandchild",
			`import { BaseComponent, Component } from "@flamework-experimental/components";

@Component({ tag: "FixtureOptionalGrandchild" })
export class RiggedComponent extends BaseComponent<{}, Model & { Torso: BasePart & { Neck?: Motor6D } }> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Child 'Torso.Neck' of the instance tree of 'RiggedComponent' is optional");
	});

	test("rejects a component that is not a direct child of the instance tree", () => {
		const result = compileProbe(
			"nestedLink",
			`import { BaseComponent, Component } from "@flamework-experimental/components";
import { HandlerComponent } from "./components";

@Component({ tag: "FixtureNested" })
export class NestedComponent extends BaseComponent<{}, Model & { Core: Folder & { Handler: HandlerComponent } }> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("which is not a direct child of this component");
	});
});

describe("literal arguments at a packed call site", () => {
	// A packed argument that is not an identifier or a literal is bound to a local first, as it is
	// read more than once. `const arg = []` is an implicit `any[]`, which roblox-ts's check of the
	// transformed file rejected under `noImplicitAny` (TS7034, TS7005); only the players list ahead
	// of the payload was bound with a type. The members' types live in a file the calls do not import
	// from, and one of them is kept to its module, so a binding typed by the parameter would name a
	// type the calling file cannot.
	const types = `import { Networking } from "@flamework-experimental/networking";

export interface Item {
	x: number;
}

interface Hidden {
	y: string;
}

interface ProbeServerEvents {
	items(items: Item[]): void;
	hidden(items: Hidden[]): void;
	serializedItems: Networking.SerializedReliable<(items: Item[]) => void>;
	serializedHidden: Networking.SerializedReliable<(items: Hidden[]) => void>;
	pair(count: number, items: Item[]): void;
	optional(items?: Item[]): void;
	tuple(values: [number?]): void;
	either(value: string | Item[]): void;
	lists(...lists: number[][]): void;
	nested(value: { list: number[]; map?: Map<string, number> }): void;
	record(value: Record<string, number>): void;
	map(value: Map<string, number>): void;
	grid(rows: number[][]): void;
	readonlyItems(items: ReadonlyArray<Item>): void;
}

interface ProbeClientEvents {
	items(items: Item[]): void;
	serializedItems: Networking.SerializedReliable<(items: Item[]) => void>;
}

interface ProbeServerFunctions {
	lookup(items: Item[]): number;
	serializedLookup: Networking.Serialized<(items: Item[]) => number>;
}

interface ProbeClientFunctions {
	ask(items: Item[]): number;
	serializedAsk: Networking.Serialized<(items: Item[]) => number>;
}

const events = Networking.createEvent<ProbeServerEvents, ProbeClientEvents>();
const functions = Networking.createFunction<ProbeServerFunctions, ProbeClientFunctions>();
export const client = events.createClient({});
export const server = events.createServer({});
export const clientFunctions = functions.createClient({});
export const serverFunctions = functions.createServer({});
`;

	const calls = `import { client, clientFunctions, server, serverFunctions } from "./literalArgTypes";

export function clientSends(flag: boolean, rest: number[][]) {
	client.items.fire([]);
	client.items([]);
	client.items.fire(([]));
	client.items?.fire([]);
	client.items.fire(flag ? [] : [{ x: 1 }]);
	client.hidden.fire([]);
	client.serializedItems.fire([]);
	client.serializedHidden.fire([]);
	client.pair.fire(1, []);
	client.optional.fire([]);
	client.optional.fire();
	client.tuple.fire([]);
	client.either.fire([]);
	client.lists.fire([], [], []);
	client.lists.fire([], ...rest);
	client.nested.fire({ list: [] });
	client.nested.fire({ list: [], map: new Map() });
	client.record.fire({});
	client.map.fire(new Map());
	client.grid.fire([[]]);
	client.readonlyItems.fire([]);
}

export function serverSends(player: Player) {
	server.items.fire(player, []);
	server.items.fire([], []);
	server.items.broadcast([]);
	server.items.except([], []);
	server.items(player, []);
	server.serializedItems.fire([player], []);
}

export function invokes(player: Player) {
	clientFunctions.lookup.invoke([]);
	clientFunctions.serializedLookup.invoke([]);
	clientFunctions.serializedLookup.invokeWithTimeout(1, []);
	serverFunctions.ask.invoke(player, []);
	serverFunctions.serializedAsk.invokeWithTimeout(player, 1, []);
}

export const deferred = () => client.serializedItems.fire([]);
`;

	const compile = (env: Record<string, string>) =>
		compileProbes({ literalArgTypes: types, literalArgCalls: calls }, env);
	const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");
	const body = (source: string, name: string) =>
		source.match(new RegExp(`local function ${name}\\([^)]*\\)\\n[\\s\\S]*?\\nend\\n`))?.[0] ?? "";

	test("compile under strict with networking.serialization on, each empty list bound as a table", () => {
		const result = compile({});

		expect(plain(result.output)).not.toContain("error TS");
		expect(result.status).toBe(0);
		const emit = result.files.get("literalArgCalls")!;
		// `client.items.fire([])`: the list is a local of its own, packed and sent.
		expect(body(emit, "clientSends")).toMatch(/^\tlocal arg\w* = \{\}\n[\s\S]*?client\.items:_fire\(buf\w*\)/m);
		// A players list ahead of an empty payload list: both are bound.
		expect(body(emit, "serverSends")).toMatch(
			/local target\w* = \{\}\n\s*local arg\w* = \{\}\n[\s\S]*?server\.items:_fire\(target\w*, buf\w*\)/,
		);
		expect(body(emit, "invokes")).toMatch(/clientFunctions\.lookup:_invoke\(buf\w*\)/);
		expect(body(emit, "invokes")).toMatch(/serverFunctions\.ask:_invoke\(player, buf\w*\)/);
	}, 120_000);

	test("compile under strict with networking.serialization off, where only Serialized members pack", () => {
		const result = compile({ FLAMEWORK_FIXTURE_SERIALIZATION: "false" });

		expect(plain(result.output)).not.toContain("error TS");
		expect(result.status).toBe(0);
		const emit = result.files.get("literalArgCalls")!;
		expect(body(emit, "clientSends")).toMatch(/client\.items:fire\(\{\}\)/);
		expect(body(emit, "clientSends")).toMatch(
			/local arg\w* = \{\}\n[\s\S]*?client\.serializedHidden:_fire\(buf\w*\)/,
		);
		expect(body(emit, "invokes")).toMatch(/clientFunctions\.serializedLookup:_invokeWithTimeout\(1, buf\w*\)/);
	}, 120_000);
});

describe("a flamework.build that cannot be used", () => {
	// A malformed flamework.build was a stack trace (JSON.parse's SyntaxError, or a plain "Found invalid
	// build info at <path>"), and a full build refused one it was about to replace without reading.
	const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");
	const own = path.join(FIXTURE, "flamework.build");
	const STACK = /^\s+at .+:\d+:\d+\)?$/m;
	const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");
	const VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")).version;

	const build = (args: string[] = []) => {
		const result = spawnSync("node", [RBXTSC, ...args], { cwd: FIXTURE, encoding: "utf8" });
		return { status: result.status, output: plain(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
	};
	const restore = () => {
		const restored = compileFixtureFresh();
		if (restored.status !== 0) throw new Error(`fixture failed to restore:\n${restored.output}`);
	};

	test("is replaced by a full build, which does not read it", () => {
		try {
			fs.writeFileSync(own, `{ "version": 1, "identifiers": `);
			const result = build();

			expect(result.output).not.toContain("flamework.build");
			expect(result.status).toBe(0);
			expect(JSON.parse(fs.readFileSync(own, "utf8")).flameworkVersion).toBe(VERSION);
		} finally {
			restore();
		}
	}, 300_000);

	test("stops an incremental build, which reuses it, naming it and the file to delete", () => {
		const probe = path.join(FIXTURE, "tsconfig.buildinfo-probe.json");
		const tsBuildInfo = path.join(FIXTURE, "buildinfo-probe.tsbuildinfo");
		const { config } = ts.readConfigFile(path.join(FIXTURE, "tsconfig.json"), ts.sys.readFile);
		config.compilerOptions.incremental = true;
		config.compilerOptions.tsBuildInfoFile = "buildinfo-probe.tsbuildinfo";
		const cleanUp = () => [probe, tsBuildInfo].forEach((file) => fs.rmSync(file, { force: true }));

		const REMEDY =
			"[Flamework]: This incremental build reads it to keep the ids of the files it does not recompile. Delete buildinfo-probe.tsbuildinfo and build again: a full build does not read flamework.build, and writes a new one.\n";
		const refused = (text: string) => {
			fs.writeFileSync(own, text);
			const result = build(["-p", probe]);
			expect(result.status).not.toBe(0);
			expect(result.output).not.toMatch(STACK);
			expect(result.output).not.toContain("Node.js v");
			return result.output;
		};

		cleanUp();
		fs.writeFileSync(probe, JSON.stringify(config, undefined, "\t"));
		try {
			// The first build has no tsbuildinfo to go by: a full one.
			expect(build(["-p", probe]).status).toBe(0);
			expect(fs.existsSync(tsBuildInfo)).toBe(true);
			const written = fs.readFileSync(own, "utf8");

			const cutShort = refused(written.slice(0, 200));
			expect(cutShort).toMatch(
				/\[Flamework\]: Flamework cannot use flamework\.build: it is not valid JSON \(.+\)\.\n/,
			);
			expect(cutShort).toContain(REMEDY);

			expect(refused("")).toContain(`[Flamework]: Flamework cannot use flamework.build: it is empty.\n${REMEDY}`);
			expect(refused(`{ "version": "1", "identifiers": [] }`)).toContain(
				`[Flamework]: Flamework cannot use flamework.build: it does not have the shape Flamework writes (/ must have required property 'flameworkVersion').\n${REMEDY}`,
			);

			// One from another version is read, and refused as before.
			const older = JSON.parse(written);
			older.flameworkVersion = "2.0.0-alpha.1";
			const outdated = refused(JSON.stringify(older));
			expect(outdated).toContain("[Flamework]: Project was compiled on different version of Flamework.\n");
			expect(outdated).toContain("Delete buildinfo-probe.tsbuildinfo and build again");
			expect(outdated).toContain("Previous Flamework Version: 2.0.0-alpha.1");
		} finally {
			cleanUp();
			restore();
		}
	}, 600_000);

	test("stops a build that reads a package's, naming the package", () => {
		const folder = path.join(FIXTURE, "src", "buildInfoPackage");
		try {
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, "package.json"), `{ "name": "@probe/package", "version": "1.0.0" }`);
			fs.writeFileSync(path.join(folder, "probe.ts"), "export const value = 1;\n");
			fs.writeFileSync(path.join(folder, "flamework.build"), `{ "version": 1`);

			const result = build();
			expect(result.status).not.toBe(0);
			expect(result.output).not.toMatch(STACK);
			expect(result.output).toMatch(
				/\[Flamework\]: Flamework cannot use src\/buildInfoPackage\/flamework\.build: it is not valid JSON \(.+\)\.\n/,
			);
			expect(result.output).toContain(
				"[Flamework]: It came with the package @probe/package, which wrote it when it was built, and this build reads it for the ids of that package's classes. Reinstall the package, or build it again if it is your own.\n",
			);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
			fs.rmSync(path.join(FIXTURE, "out", "buildInfoPackage"), { recursive: true, force: true });
			restore();
		}
	}, 300_000);
});

describe("a file transformed again in a later pass", () => {
	// roblox-ts after 3.0.0 gives a watcher's rebuild the same SourceFile for a file whose text did not
	// change, and transforms it again when a file it imports changed. A generator kept per SourceFile
	// believed its codec table and helpers were already emitted, and the second output called `codec`,
	// `vsize`, `vwrite` and `vread` without declaring them.
	test("emits its codec table, helpers and hoisted functions again", async () => {
		await transformInProcess({}, (fixture) => {
			const program = fixture.program();
			const file = fixture.file(program, "serialization");
			const first = fixture.pass(program, [file]);
			const second = fixture.pass(program, [file]);

			const fields = [...first.printed[0].matchAll(/^codec\.(\w+) = /gm)].map((match) => match[1]);
			expect(fields).toContain("w_Payload");
			expect(second.printed[0]).toMatch(/const codec\w*: \{/);
			expect(second.printed[0]).toMatch(/const vsize\w* = /);
			for (const field of fields) expect(second.printed[0]).toContain(`codec.${field} = `);
			expect(second.diagnostics.filter((message) => message.includes("never defines"))).toEqual([]);
		});
	}, 120_000);
});

describe("the serializer's self-check", () => {
	// Every field of a file's `codec` table that its generated code calls has to be defined in that
	// file. The table has an index signature, so nothing else notices a missing one until the call
	// runs, as a call of nil. Forced here by transforming one file twice in one pass: the file's one
	// generator hands its definitions out the first time only, so the second output calls every one of
	// them without defining it, which is what reusing a generator across passes did.
	test("stops a build whose file calls a codec field it never defines, naming the type", async () => {
		await transformInProcess({}, (fixture) => {
			const program = fixture.program();
			const file = fixture.file(program, "serialization");

			const once = fixture.pass(program, [file]);
			expect(once.diagnostics.filter((message) => message.includes("never defines"))).toEqual([]);

			const twice = fixture.pass(program, [file, file]);
			expect(twice.diagnostics).toContainEqual(
				expect.stringMatching(
					/^Flamework's generated code for the type 'Payload' calls .*'codec\.w_Payload'.*, which this file never defines\.$/,
				),
			);
		});
	}, 120_000);
});

describe("a value whose serializer fails to build", () => {
	// A failure while one of a file's values is built is reported, and the file's next value is built
	// after it in the same pass. Nothing the failed build left behind may count as finished: the next
	// value would call table fields or helpers that were never defined. Forced here by a failure
	// injected into the first build; the build stops with that error either way, so only
	// `--writeTransformedFiles` ever showed such output, but a later value must still come out whole.

	/**
	 * The `codec` fields and varint helpers the code from `from` on calls, followed through the
	 * definitions `printed` makes, that `printed` never defines or declares.
	 */
	function undefinedCalls(printed: string, from: string): string[] {
		const definitions = new Map<string, string>();
		for (const match of printed.matchAll(/^codec\w*\.(\w+) = ([\s\S]*?)(?=^\S)/gm)) {
			definitions.set(match[1], match[2]);
		}
		const declared = new Set([...printed.matchAll(/\b(?:const|let) ([A-Za-z_]\w*)/g)].map((match) => match[1]));

		const missing = new Array<string>();
		const seen = new Set<string>();
		const visit = (code: string) => {
			for (const [, field] of code.matchAll(/\bcodec\w*\.(\w+)\b(?! =)/g)) {
				if (seen.has(field)) continue;
				seen.add(field);
				const definition = definitions.get(field);
				if (definition === undefined) missing.push(`codec.${field}`);
				else visit(definition);
			}
			for (const [, helper] of code.matchAll(/(?<![.\w])((?:vsize|vwrite|vread)\w*)\(/g)) {
				if (!declared.has(helper) && !missing.includes(helper)) missing.push(helper);
			}
		};
		const start = printed.indexOf(from);
		expect(start).toBeGreaterThan(-1);
		visit(printed.slice(start));
		return missing;
	}

	test("takes a type that failed out again, with every type hoisted while it was built", async () => {
		// `Inner` is hoisted while `Outer` is built, and calls Outer's functions; the guard `P1 | P2`
		// needs fails after it. Kept, `Outer` would be called by `second` and never defined; kept,
		// `Inner` would call the Outer that failed.
		const source = `import { Flamework } from "@flamework-experimental/core";
interface Inner { x: string; up?: Outer[] }
interface P1 { a: string; n: number }
interface P2 { a: number; n: string }
export interface Outer { first: Inner; second: P1 | P2 }
export const first = Flamework.createSerializer<Outer>();
export const second = Flamework.createSerializer<Outer>();
`;
		await transformInProcess({ failedHoist: source }, (fixture) => {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const guards = require("../out/util/functions/buildGuardFromType");
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { Diagnostics } = require("../out/classes/diagnostics");
			const original = guards.buildGuardFromType;
			let calls = 0;
			guards.buildGuardFromType = function (this: unknown, state: unknown, node: ts.Node, ...rest: unknown[]) {
				if (calls++ === 0) Diagnostics.error(node, "injected failure");
				return original.call(this, state, node, ...rest);
			};

			try {
				const program = fixture.program();
				const { printed, diagnostics } = fixture.pass(program, [fixture.file(program, "failedHoist")]);
				expect(diagnostics).toEqual(["injected failure"]);
				expect(calls).toBe(2);
				// Both built again, under new names: what the failed build made of them is still handed out.
				expect(printed[0]).toMatch(/^codec\.s_Outer_1 = /m);
				expect(printed[0]).toMatch(/^codec\.s_Inner_1 = /m);
				expect(undefinedCalls(printed[0], "export const second")).toEqual([]);
			} finally {
				guards.buildGuardFromType = original;
			}
		});
	}, 120_000);

	for (const [helpers, global, firstType, secondType] of [
		["varint helpers", "math", "{ name: string }", "{ title: string }"],
		["width check", "error", "{ a: Serialization.Implicit.u8 }", "{ b: Serialization.Implicit.u16 }"],
	]) {
		test(`builds the ${helpers} again for the file's next value when building them failed`, async () => {
			// The first time the file's hoisted code looks up the global its helpers use, a declaration of
			// the file hides it: building them fails, and the helpers must not count as built.
			const source = `import { Flamework, Serialization } from "@flamework-experimental/core";
export const first = Flamework.createSerializer<${firstType}>();
export const second = Flamework.createSerializer<${secondType}>();
`;
			await transformInProcess({ failedHelper: source }, (fixture) => {
				const program = fixture.program();
				const file = fixture.file(program, "failedHelper");
				const checker = program.getTypeChecker();
				const statement = file.statements.find(ts.isVariableStatement)!;
				const hiding = checker.getSymbolAtLocation(statement.declarationList.declarations[0].name)!;
				const original = checker.resolveName;
				let lookups = 0;
				checker.resolveName = function (this: ts.TypeChecker, name, location, meaning, excludeGlobals) {
					if (name === global && location && ts.isSourceFile(location) && lookups++ === 0) return hiding;
					return original.call(this, name, location, meaning, excludeGlobals);
				};

				try {
					const { printed, diagnostics } = fixture.pass(program, [file]);
					expect(diagnostics).toEqual([
						expect.stringContaining(`uses the global '${global}', which the declaration of '${global}'`),
					]);
					expect(lookups).toBe(2);
					expect(undefinedCalls(printed[0], "export const second")).toEqual([]);
				} finally {
					checker.resolveName = original;
				}
			});
		}, 120_000);
	}
});
