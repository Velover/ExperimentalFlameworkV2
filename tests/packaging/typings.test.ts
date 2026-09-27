import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Guards the declaration files the packages publish.
 *
 * roblox-ts builds with `skipLibCheck`, so a declaration file that does not type-check never fails
 * a build; a game that runs plain `tsc` without it does, inside the package. The packages build
 * with `stripInternal`, which removes an `@internal` declaration from its module's typings but not
 * a re-export of it elsewhere: the entry points once re-exported the test harness's hooks
 * (`__setActiveScopes`, `__resetTests`, ...) and every such check failed with TS2305/TS2724.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_PACKAGES = ["core", "components", "networking", "testing"];

function declarationFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...declarationFiles(full));
		else if (entry.name.endsWith(".d.ts")) files.push(full);
	}
	return files;
}

/** Every declaration file a package publishes: its `out` folder, its `types` entry and any other listed in `files`. */
function publishedDeclarations(pkg: string): string[] {
	const directory = path.join(ROOT, "packages", pkg);
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
		types?: string;
		files?: string[];
	};

	const files = new Set<string>();
	for (const listed of manifest.files ?? []) {
		const full = path.join(directory, listed);
		if (!fs.existsSync(full)) continue;
		if (fs.statSync(full).isDirectory()) {
			// The transformer's own `out` is Node code; a game's program only ever sees its `types` entry.
			if (pkg !== "transformer") declarationFiles(full).forEach((file) => files.add(file));
		} else if (full.endsWith(".d.ts")) {
			files.add(full);
		}
	}
	if (manifest.types !== undefined) files.add(path.join(directory, manifest.types));

	return [...files];
}

const PUBLISHED = [...RUNTIME_PACKAGES, "transformer"].flatMap(publishedDeclarations);

describe("published declaration files", () => {
	test("are found", () => {
		expect(PUBLISHED.length).toBeGreaterThan(RUNTIME_PACKAGES.length);
		for (const pkg of RUNTIME_PACKAGES) {
			expect(PUBLISHED).toContain(path.join(ROOT, "packages", pkg, "out", "index.d.ts"));
		}
	});

	test("type-check without skipLibCheck", () => {
		// A game's options (tsconfig.roblox-ts.json), with its roblox-ts globals as type roots.
		const program = ts.createProgram(PUBLISHED, {
			noLib: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.CommonJS,
			moduleResolution: ts.ModuleResolutionKind.Node10,
			moduleDetection: ts.ModuleDetectionKind.Force,
			experimentalDecorators: true,
			allowSyntheticDefaultImports: true,
			downlevelIteration: true,
			resolveJsonModule: true,
			skipLibCheck: false,
			noEmit: true,
			typeRoots: [path.join(ROOT, "packages", "core", "node_modules", "@rbxts")],
			types: ["compiler-types", "types"],
		});

		// Only the packages' own files are judged: @rbxts/types has errors of its own under a
		// plain check, which a game sees with or without Flamework.
		const ours = (file: string) => {
			const relative = path.relative(path.join(ROOT, "packages"), fs.realpathSync(file));
			return !relative.startsWith("..") && !relative.split(path.sep).includes("node_modules");
		};

		const errors = ts
			.getPreEmitDiagnostics(program)
			.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
			.filter((diagnostic) => diagnostic.file === undefined || ours(diagnostic.file.fileName))
			.map((diagnostic) => {
				const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
				if (diagnostic.file === undefined || diagnostic.start === undefined) return message;

				const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
				const file = path.relative(ROOT, fs.realpathSync(diagnostic.file.fileName)).replace(/\\/g, "/");
				return `${file}(${line + 1},${character + 1}): TS${diagnostic.code}: ${message}`;
			});

		expect(errors).toEqual([]);
	}, 120_000);

	test("export none of the test harness's internals", () => {
		// The hooks stay exported from the Luau for the harness, which reaches them through a cast;
		// in the typings they would be public API.
		const offenders: string[] = [];
		for (const file of PUBLISHED) {
			const source = fs.readFileSync(file, "utf8");
			const exported = [
				...source.matchAll(/export\s+(?:declare\s+)?(?:function|const|let|var|class|namespace)\s+(__\w+)/g),
				...[...source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)].flatMap((match) =>
					[...match[1].matchAll(/\b(__\w+)/g)].map((name) => name),
				),
			].map((match) => match[1]);

			for (const name of exported) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}: ${name}`);
		}

		expect(offenders).toEqual([]);
	});
});
