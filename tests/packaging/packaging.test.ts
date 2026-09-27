import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Guards the shape of the Luau that ships in the published packages.
 *
 * The Lune runtime specs resolve requires against this repository's node_modules, so they cannot
 * notice a require path that only exists here. Inside a consumer's place every dependency has to be
 * reached with `TS.getModule(script, "<scope>", "<name>")`, never through another package's
 * node_modules folder. The first Studio battletest of v2 failed on exactly that (see
 * docs/testing/studio.md).
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const PACKAGES = ["core", "components", "networking", "testing"];

function luauFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...luauFiles(full));
		else if (entry.name.endsWith(".luau") || entry.name.endsWith(".lua")) files.push(full);
	}
	return files;
}

describe.each(PACKAGES)("@flamework-experimental/%s", (pkg) => {
	const out = path.join(ROOT, "packages", pkg, "out");

	test("is built", () => {
		expect(fs.existsSync(path.join(out, "init.luau"))).toBe(true);
	});

	test("never requires through another package's node_modules", () => {
		const offenders: string[] = [];
		for (const file of luauFiles(out)) {
			const source = fs.readFileSync(file, "utf8");
			for (const line of source.split(/\r?\n/)) {
				if (/TS\.(import|getModule)\(/.test(line) && /\.node_modules|\["node_modules"\]/.test(line)) {
					offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("imports @rbxts/t through its package entry", () => {
		const offenders: string[] = [];
		for (const file of luauFiles(out)) {
			const source = fs.readFileSync(file, "utf8");
			for (const match of source.matchAll(/TS\.getModule\(script, "@rbxts", "t"\)([^)]*)/g)) {
				if (match[1] !== ".lib.ts") offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("peer dependency ranges", () => {
	// A range such as `*` matches no prerelease under semver, so every install of an alpha printed
	// `incorrect peer dependency` for each package that names core. Each Flamework peer range has to
	// take the version the package it names is at now, prerelease or not.
	const manifest = (pkg: string) =>
		JSON.parse(fs.readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8")) as {
			version: string;
			peerDependencies?: Record<string, string>;
		};

	test.each(["components", "networking", "testing"])(
		"%s accepts the Flamework versions it is released with",
		(pkg) => {
			const peers = Object.entries(manifest(pkg).peerDependencies ?? {}).filter(([name]) =>
				name.startsWith("@flamework-experimental/"),
			);
			expect(peers.length).toBeGreaterThan(0);

			for (const [name, range] of peers) {
				const version = manifest(name.slice("@flamework-experimental/".length)).version;
				expect(`${name}@${version} in ${range}: ${Bun.semver.satisfies(version, range)}`).toBe(
					`${name}@${version} in ${range}: true`,
				);

				// Every later release of the same major, and the releases the prerelease leads to.
				for (const later of ["2.0.0", "2.3.1"]) {
					expect(Bun.semver.satisfies(later, range)).toBe(true);
				}
				expect(Bun.semver.satisfies("3.0.0", range)).toBe(false);
			}
		},
	);
});

describe("@flamework-experimental/testing's CLI", () => {
	// A game's Rojo project syncs node_modules/@flamework-experimental into the place, and Rojo makes a
	// ModuleScript of every .luau it finds; the CLI's Luau is kept under another extension for that.
	test("ships no .luau under cli/", () => {
		expect(luauFiles(path.join(ROOT, "packages", "testing", "cli"))).toEqual([]);
	});
});

describe("package ids", () => {
	// A game's build names a package's classes and interfaces with the prefix in the package's
	// flamework.build, and the package's own compiled code compares against those exact strings (the
	// lifecycle plugin observes "$:lifecycle/lifecycleInterfaces@OnStart"). A changed prefix breaks
	// every game built against the package.
	const PREFIXES: [string, string][] = [
		["core", "$"],
		["components", "$c"],
		["networking", "$n"],
		["testing", "$T"],
	];

	test.each(PREFIXES)("%s is built with the prefix %p", (pkg, prefix) => {
		const buildInfo = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", pkg, "flamework.build"), "utf8"));
		expect(buildInfo.identifierPrefix).toBe(prefix);
		expect(buildInfo.idGenerationMode).toBe("full");
	});

	test.each(PREFIXES)("%s takes the prefix from its flamework.config.json, not its tsconfig entry", (pkg, prefix) => {
		const directory = path.join(ROOT, "packages", pkg);
		const config = JSON.parse(fs.readFileSync(path.join(directory, "flamework.config.json"), "utf8"));
		expect(config.transformer).toEqual({ hashPrefix: prefix });

		// The build refuses any option on the entry; this only says where to look.
		const { config: tsconfig } = ts.readConfigFile(path.join(directory, "tsconfig.json"), ts.sys.readFile);
		expect(tsconfig.compilerOptions.plugins).toEqual([{ transform: "@flamework-experimental/transformer" }]);
	});

	test("the compiled packages hold the ids games compare against", () => {
		const read = (file: string) => fs.readFileSync(path.join(ROOT, "packages", file), "utf8");
		expect(read("core/out/lifecycle/lifecyclePlugin.luau")).toContain('"$:lifecycle/lifecycleInterfaces@OnStart"');
		expect(read("core/out/lifecycle/lifecyclePlugin.luau")).toContain('"$:lifecycle/lifecycleInterfaces@OnInit"');
		expect(
			luauFiles(path.join(ROOT, "packages", "components", "out")).some((file) =>
				fs.readFileSync(file, "utf8").includes('"$c:components@Components"'),
			),
		).toBe(true);
	});
});

describe("repository links", () => {
	// npm shows these on each package's page. They point at this monorepo, with each package's folder,
	// and not at the original v1 repositories the forked packages started from.
	const REPO = "https://github.com/Velover/ExperimentalFlameworkV2";

	test.each(["core", "components", "networking", "testing", "transformer", "transformer-plugin"])(
		"%s links this repository",
		(pkg) => {
			const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8")) as {
				repository?: { type?: string; url?: string; directory?: string };
				homepage?: string;
				bugs?: { url?: string };
			};

			expect(manifest.repository).toEqual({ type: "git", url: `git+${REPO}.git`, directory: `packages/${pkg}` });
			expect(manifest.homepage).toBe(`${REPO}#readme`);
			expect(manifest.bugs).toEqual({ url: `${REPO}/issues` });
		},
	);
});
