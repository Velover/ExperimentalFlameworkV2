import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { compileFixture, compileFixtureFresh, normalize, transformInProcess } from "./compile";

// When and where the transformer writes `include/flamework/*.json` and `flamework.build`, and which
// inputs it takes from roblox-ts: what a watcher or an incremental build reads back.

const FIXTURE = path.resolve(import.meta.dir, "fixture");
const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");
const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

const build = (args: string[] = [], env: Record<string, string> = {}) => {
	const result = spawnSync("node", [RBXTSC, ...args], {
		cwd: FIXTURE,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return { status: result.status ?? 1, output: plain(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
};
const fixturePath = (...parts: string[]) => path.join(FIXTURE, ...parts);
const read = (...parts: string[]) => fs.readFileSync(fixturePath(...parts), "utf8");
const restore = () => {
	const restored = compileFixtureFresh();
	if (restored.status !== 0) throw new Error(`fixture failed to restore:\n${restored.output}`);
};

/** The fixture's Rojo project with `edit` applied to its tree, written as `name` in the fixture. */
const writeRojoProbe = (name: string, edit: (tree: Record<string, unknown>) => void) => {
	const project = JSON.parse(read("default.project.json"));
	edit(project.tree);
	fs.writeFileSync(fixturePath(name), JSON.stringify(project, undefined, "\t"));
};

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) throw new Error(`fixture failed to compile:\n${result.output}`);
});

describe("a build that fails", () => {
	// roblox-ts writes nothing when a build has an error, but the transformer wrote its artifacts all
	// the same: `globs.json` then named a module whose Luau was never written, and `flamework.build`
	// held what the failed pass had made of it. Each probe is a file the fixture's glob matches and
	// that globs.json does not list yet, so any write of the artifacts would show.
	const probe = (name: string) => fixturePath("src", "glob", `${name}.ts`);
	const probeOutput = (name: string) => fixturePath("out", "glob", `${name}.luau`);
	const names = ["artifactProbe", "artifactProbeNull"];

	afterAll(() => {
		for (const name of names) {
			fs.rmSync(probe(name), { force: true });
			fs.rmSync(probeOutput(name), { force: true });
		}
		restore();
	});

	const expectNothingWritten = (name: string, source: string) => {
		const before = { globs: read("include", "flamework", "globs.json"), build: read("flamework.build") };
		expect(before.globs).not.toContain(`"${name}"`);
		fs.writeFileSync(probe(name), source);
		const result = build();

		expect(result.status).not.toBe(0);
		expect(fs.existsSync(probeOutput(name))).toBe(false);
		expect(read("include", "flamework", "globs.json")).toBe(before.globs);
		expect(read("flamework.build")).toBe(before.build);
		return result.output;
	};

	test("with a type error writes no artifacts, and the next good build writes them", () => {
		expectNothingWritten("artifactProbe", `export const broken: number = "text";\n`);

		// A build killed between a temporary write and its rename leaves the temporary behind; the next
		// build that writes the file removes it, once that process is gone.
		const stale = fixturePath(".flamework.build.999999.tmp");
		fs.writeFileSync(stale, "{}");

		fs.writeFileSync(probe("artifactProbe"), `export const fixed = 1;\n`);
		const fixed = build();
		expect(fixed.status).toBe(0);
		expect(read("include", "flamework", "globs.json")).toContain('"artifactProbe"');
		expect(fs.existsSync(stale)).toBe(false);
		expect(JSON.parse(read("flamework.build")).metadata.globs.paths["src/glob/**/*.ts"]).toContain(
			"out/glob/artifactProbe.lua",
		);
	}, 300_000);

	test("with an error only roblox-ts reports writes no artifacts either", () => {
		// TypeScript takes `null`; roblox-ts refuses it once Flamework's pass is over.
		const output = expectNothingWritten("artifactProbeNull", `export const value = null;\n`);
		expect(output).toContain("null");
	}, 300_000);
});

describe("the project options roblox-ts resolves", () => {
	// The transformer worked these out from argv on its own: it looked for `--i` where roblox-ts's alias
	// is `-i`, ignored the tsconfig's `rbxts` block, and put `include` beside package.json where
	// roblox-ts puts it beside the tsconfig.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { parseCommandLine, readArgv } = require("../out/util/functions/parseCommandLine");
	const argv = (...args: string[]) => ["node", "cli.js", ...args];
	const probeConfig = fixturePath("tsconfig.options-probe.json");
	const baseFolder = fixturePath("options-probe-base");

	afterAll(() => {
		fs.rmSync(probeConfig, { force: true });
		fs.rmSync(baseFolder, { recursive: true, force: true });
	});

	test("reads the include path in every form yargs gives roblox-ts", () => {
		expect(readArgv(argv("-i", "a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("-i=a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("--includePath", "a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("--includePath=a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("--include-path", "a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("-wi", "a"))).toEqual({ includePath: "a" });
		// yargs reads `--i` and `--p` as the aliases, and the transformer once asked for `--i`.
		expect(readArgv(argv("--i", "a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("--i=a"))).toEqual({ includePath: "a" });
		expect(readArgv(argv("--p", "q"))).toEqual({ project: "q" });
		expect(readArgv(argv("-i", "-w"))).toEqual({ includePath: "" });
		expect(readArgv(argv("-ix"))).toEqual({ includePath: "" });
		expect(readArgv(argv("--rojo=r.json", "-p", "q", "--", "-i", "x"))).toEqual({ rojo: "r.json", project: "q" });
		expect(readArgv(argv("build", "-w", "--verbose"))).toEqual({});
	});

	test("puts include beside the tsconfig by default, and takes the tsconfig's rbxts block under the command line", () => {
		expect(parseCommandLine(argv(), FIXTURE)).toMatchObject({
			project: FIXTURE,
			includePath: fixturePath("include"),
			rojoConfigPath: fixturePath("default.project.json"),
		});
		expect(parseCommandLine(argv("-i", "custom"), FIXTURE).includePath).toBe(fixturePath("custom"));

		const { config } = ts.readConfigFile(fixturePath("tsconfig.json"), ts.sys.readFile);
		config.rbxts = { includePath: "from-config", rojo: "from-config.project.json" };
		fs.writeFileSync(probeConfig, JSON.stringify(config));
		expect(parseCommandLine(argv("-p", probeConfig), FIXTURE)).toMatchObject({
			includePath: fixturePath("from-config"),
			rojoConfigPath: fixturePath("from-config.project.json"),
		});
		expect(
			parseCommandLine(argv("-p", probeConfig, "-i", "flag", "--rojo", "flag.project.json"), FIXTURE),
		).toMatchObject({ includePath: fixturePath("flag"), rojoConfigPath: fixturePath("flag.project.json") });
		// An empty flag still overrides the config, and stands for the default.
		expect(parseCommandLine(argv("-p", probeConfig, "-i"), FIXTURE).includePath).toBe(fixturePath("include"));
	});

	test("follows extends, from the config that sets a path, when roblox-ts does", () => {
		// roblox-ts after 3.0.0 reads `rbxts` through `extends`; the transformer tells it by the module
		// that does so being loaded, which a key in the require cache stands in for here.
		fs.mkdirSync(baseFolder, { recursive: true });
		fs.writeFileSync(
			path.join(baseFolder, "tsconfig.base.json"),
			JSON.stringify({ rbxts: { includePath: "inc" } }),
		);
		const { config } = ts.readConfigFile(fixturePath("tsconfig.json"), ts.sys.readFile);
		config.extends = ["../../../../tsconfig.roblox-ts.json", "./options-probe-base/tsconfig.base.json"];
		fs.writeFileSync(probeConfig, JSON.stringify(config));

		// 3.0.0 reads the config's own block only.
		expect(parseCommandLine(argv("-p", probeConfig), FIXTURE).includePath).toBe(fixturePath("include"));

		const key = path.join(baseFolder, "out", "Project", "functions", "readProjectOptions.js");
		require.cache[key] = { id: key } as never;
		try {
			expect(parseCommandLine(argv("-p", probeConfig), FIXTURE).includePath).toBe(path.join(baseFolder, "inc"));
		} finally {
			delete require.cache[key];
		}
	});

	describe("through rbxtsc", () => {
		const probeInclude = fixturePath("probe-include");
		const probeRojo = fixturePath("probe.project.json");
		let ownGlobs: string;

		beforeAll(() => {
			ownGlobs = read("include", "flamework", "globs.json");
			writeRojoProbe("probe.project.json", (tree) => {
				tree.include = { $path: "probe-include" };
			});
		});

		afterAll(() => {
			fs.rmSync(probeInclude, { recursive: true, force: true });
			fs.rmSync(probeRojo, { force: true });
			fs.rmSync(probeConfig, { force: true });
			fs.rmSync(fixturePath("out", "include"), { recursive: true, force: true });
			restore();
		});

		test("writes include/flamework into the folder `-i` names", () => {
			const result = build(["-i", "probe-include", "--rojo", "probe.project.json"]);
			expect(result).toMatchObject({ status: 0 });
			expect(fs.existsSync(path.join(probeInclude, "RuntimeLib.lua"))).toBe(true);
			expect(JSON.parse(fs.readFileSync(path.join(probeInclude, "flamework", "paths.json"), "utf8"))).toEqual({
				includeDepth: 1,
			});
			expect(fs.existsSync(path.join(probeInclude, "flamework", "globs.json"))).toBe(true);
			expect(read("include", "flamework", "globs.json")).toBe(ownGlobs);
		}, 300_000);

		test("writes it where the tsconfig's rbxts.includePath and rbxts.rojo say", () => {
			fs.rmSync(probeInclude, { recursive: true, force: true });
			const { config } = ts.readConfigFile(fixturePath("tsconfig.json"), ts.sys.readFile);
			config.rbxts = { includePath: "probe-include", rojo: "probe.project.json" };
			fs.writeFileSync(probeConfig, JSON.stringify(config, undefined, "\t"));

			const result = build(["-p", probeConfig]);
			expect(result).toMatchObject({ status: 0 });
			expect(fs.existsSync(path.join(probeInclude, "RuntimeLib.lua"))).toBe(true);
			expect(fs.existsSync(path.join(probeInclude, "flamework", "globs.json"))).toBe(true);
			expect(read("include", "flamework", "globs.json")).toBe(ownGlobs);
		}, 300_000);

		test("keeps an include folder inside outDir with its JSON through a build", () => {
			// roblox-ts removes what has no source in `out`: 3.0.0 before it compiles, later releases
			// after. The JSON is written after both.
			for (let i = 0; i < 2; i++) {
				const result = build(["-i", "out/include"]);
				expect(result).toMatchObject({ status: 0 });
				expect(result.output).toContain("The include folder out/include is inside outDir");
				const flamework = fixturePath("out", "include", "flamework");
				expect(JSON.parse(fs.readFileSync(path.join(flamework, "paths.json"), "utf8"))).toEqual({
					includeDepth: 2,
				});
				expect(fs.readFileSync(path.join(flamework, "globs.json"), "utf8")).toContain('"glob"');
			}
			expect(read("include", "flamework", "globs.json")).toBe(ownGlobs);
		}, 600_000);
	});
});

describe("a nested Rojo project file", () => {
	// The transformer kept its Rojo resolver while the top project file's text was unchanged, so a
	// watcher's rebuild after an edit to a nested one (`$path` to a folder holding a
	// `default.project.json`) emitted path macros from the old tree, while roblox-ts read the new one.
	const top = fixturePath("rojo-probe.project.json");
	const nestedFolder = fixturePath("rojo-probe");
	const nested = path.join(nestedFolder, "default.project.json");

	afterAll(() => {
		fs.rmSync(top, { force: true });
		fs.rmSync(nestedFolder, { recursive: true, force: true });
	});

	test("is read again by the next compilation of the same process once it changes", async () => {
		writeRojoProbe("rojo-probe.project.json", (tree) => {
			tree.out = { $path: "rojo-probe" };
		});
		fs.mkdirSync(nestedFolder, { recursive: true });
		fs.writeFileSync(nested, JSON.stringify({ name: "nested", tree: { $path: "../out" } }));

		process.argv.push("--rojo", top);
		try {
			await transformInProcess({}, (fixture) => {
				const program = fixture.program();
				// The printer breaks the path's array over lines.
				const pass = () => normalize(fixture.pass(program, [fixture.file(program, "globs")]).printed[0]);
				const first = pass();
				expect(first).toContain('registerProviders("src/glob", undefined, [ "out", "glob" ] as never)');

				fs.writeFileSync(
					nested,
					JSON.stringify({ name: "nested", tree: { $className: "Folder", moved: { $path: "../out" } } }),
				);
				expect(pass()).toContain(
					'registerProviders("src/glob", undefined, [ "out", "moved", "glob" ] as never)',
				);
			});
		} finally {
			process.argv.splice(process.argv.length - 2, 2);
		}
	}, 120_000);
});

describe("an incremental build whose Flamework inputs changed", () => {
	// roblox-ts recompiles only the files that changed, and nothing of flamework.config.json or the
	// environment is part of what it compares. A new idGenerationMode dropped the id table while the
	// files left alone kept their ids, so one class had two, and the build said "every identifier is
	// regenerated". It now stops and says to build every file.
	const probe = fixturePath("tsconfig.inputs-probe.json");
	const tsBuildInfo = fixturePath("inputs-probe.tsbuildinfo");
	const changed = fixturePath("src", "inputsProbe.ts");
	const remedy = "Delete inputs-probe.tsbuildinfo and build again: the next build compiles every file.";

	const cleanUp = () => [probe, tsBuildInfo, changed].forEach((file) => fs.rmSync(file, { force: true }));
	afterAll(() => {
		cleanUp();
		fs.rmSync(fixturePath("out", "inputsProbe.luau"), { force: true });
		restore();
	});

	test("is refused, naming what changed, until it builds every file", () => {
		cleanUp();
		const { config } = ts.readConfigFile(fixturePath("tsconfig.json"), ts.sys.readFile);
		config.compilerOptions.incremental = true;
		config.compilerOptions.tsBuildInfoFile = "inputs-probe.tsbuildinfo";
		fs.writeFileSync(probe, JSON.stringify(config, undefined, "\t"));
		// The probe inlines a variable of its own, which is dropped from the record once it is deleted.
		const edit = (n: number) =>
			fs.writeFileSync(
				changed,
				`import { Flamework } from "@flamework-experimental/core";\n` +
					`export const probe = Flamework.env("FLAMEWORK_FIXTURE_PROBE");\nexport const edit = ${n};\n`,
			);
		edit(0);

		expect(build(["-p", probe])).toMatchObject({ status: 0 });
		expect(fs.existsSync(tsBuildInfo)).toBe(true);
		const written = read("flamework.build");
		expect(JSON.parse(written).inputs.env["src/env.ts"]).toHaveProperty("FLAMEWORK_FIXTURE_SCOPES");
		expect(JSON.parse(written).inputs.env["src/inputsProbe.ts"]).toEqual({ FLAMEWORK_FIXTURE_PROBE: "unset" });

		const refused = (env: Record<string, string>) => {
			edit(Math.random());
			const result = build(["-p", probe], env);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(remedy);
			expect(read("flamework.build")).toBe(written);
			return result.output;
		};

		expect(refused({ FLAMEWORK_FIXTURE_IDMODE: "short" })).toContain(
			"Flamework's inputs changed since flamework.build was written: idGenerationMode is 'short', and was 'full'.",
		);
		expect(refused({ FLAMEWORK_FIXTURE_DEDUP: "4" })).toContain(
			"an option in flamework.config.json that shapes the emitted code changed",
		);
		expect(refused({ FLAMEWORK_FIXTURE_SCOPES: "other" })).toContain(
			"the value of the variable FLAMEWORK_FIXTURE_SCOPES, which Flamework.env inlines, changed",
		);

		// The same inputs build incrementally as before.
		edit(1);
		expect(build(["-p", probe])).toMatchObject({ status: 0 });

		// A deleted file's variables are dropped, so a new value of one refuses nothing.
		fs.rmSync(changed, { force: true });
		expect(build(["-p", probe])).toMatchObject({ status: 0 });
		expect(JSON.parse(read("flamework.build")).inputs.env).not.toHaveProperty("src/inputsProbe.ts");
		expect(build(["-p", probe], { FLAMEWORK_FIXTURE_PROBE: "set" })).toMatchObject({ status: 0 });

		// Without the tsbuildinfo every file is compiled, with the new mode.
		fs.rmSync(tsBuildInfo, { force: true });
		expect(build(["-p", probe], { FLAMEWORK_FIXTURE_IDMODE: "short" })).toMatchObject({ status: 0 });
		expect(JSON.parse(read("flamework.build")).idGenerationMode).toBe("short");
	}, 900_000);
});
