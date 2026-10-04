import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { links, REPOSITORY, rewriteLinks, withoutRepositoryOnly } from "../../scripts/links.mjs";

/**
 * Guards what the published tarballs hold beyond the Luau: the Rojo project files that let a game map
 * the whole `node_modules/@flamework-experimental` folder in one line, the guide that ships in core
 * so that a game's own docs can point at the version it installed, and the links in the READMEs.
 *
 * The file lists come from the packers themselves, `npm pack --dry-run` and `bun pm pack --dry-run`
 * (which `bun publish` packs with), not from reading `files`.
 */
const ROOT = path.resolve(import.meta.dir, "../..");

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: true, timeout: 120_000 });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
	}

	return result.stdout;
}

/** What a packer puts in a package's tarball, relative to the package; with `scripts`, its prepack runs first. */
function packed(pkg: string, packer: "npm" | "bun", scripts = false): string[] {
	const cwd = path.join(ROOT, "packages", pkg);
	const args = packer === "npm" ? ["pack", "--dry-run", "--json"] : ["pm", "pack", "--dry-run"];
	if (!scripts) args.push("--ignore-scripts");

	const stdout = run(packer, args, cwd);
	const files =
		packer === "npm"
			? (JSON.parse(stdout) as { files: { path: string }[] }[])[0].files.map((file) => file.path)
			: [...stdout.matchAll(/^packed \S+ (.+?)\s*$/gm)].map((match) => match[1]);

	expect(files.length).toBeGreaterThan(0);
	return files.map((file) => file.replace(/\\/g, "/")).sort();
}

const PACKERS = ["npm", "bun"] as const;

describe("Rojo project files", () => {
	// Rojo uses a directory's default.project.json in place of the directory, and names the instance
	// after the project, so each name is the package's folder name.
	test.each(["transformer", "transformer-plugin"])("%s ships one that maps it to an empty Folder", (pkg) => {
		for (const packer of PACKERS) {
			expect(packed(pkg, packer)).toContain("default.project.json");
		}

		const project = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", pkg, "default.project.json"), "utf8"));
		expect(project).toEqual({ name: pkg, tree: { $className: "Folder" } });
	});

	// Rojo maps core's whole folder, so the nested node_modules a conflicting @rbxts/t leaves there
	// reaches the place and core's prelude finds its own t. The shipped docs arrive as two empty Folders.
	test("core ships none, so Rojo maps its whole folder", () => {
		for (const packer of PACKERS) {
			expect(packed("core", packer)).not.toContain("default.project.json");
		}
	});

	// The package also ships the CLI's sources, which a place has no use for: mapped as a folder, they
	// arrived as empty Folders (`testing.cli`, `cli.src`, `cli.tasks`). Its project maps `out` alone.
	test("testing ships one that maps its out folder alone", () => {
		for (const packer of PACKERS) {
			const files = packed("testing", packer);
			expect(files).toContain("default.project.json");
			expect(files.some((file) => file.startsWith("cli/src/"))).toBe(true);
		}

		const project = JSON.parse(
			fs.readFileSync(path.join(ROOT, "packages", "testing", "default.project.json"), "utf8"),
		);
		expect(project).toEqual({ name: "testing", tree: { $className: "Folder", out: { $path: "out" } } });
	});

	// A nested node_modules is left out of the place, so its compiled code must reach nothing a
	// conflicting install would nest there: only @rbxts/services, which answers the same in every
	// version, and core, a peer, which is never nested.
	test("testing's compiled code reaches only packages every place has at the top level", () => {
		const reached = new Set<string>();
		const visit = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) visit(full);
				else if (entry.name.endsWith(".luau")) {
					const source = fs.readFileSync(full, "utf8");
					for (const match of source.matchAll(/TS\.getModule\(script, "([^"]+)", "([^"]+)"\)/g)) {
						reached.add(`${match[1]}/${match[2]}`);
					}
				}
			}
		};
		visit(path.join(ROOT, "packages", "testing", "out"));

		expect([...reached].sort()).toEqual(["@flamework-experimental/core", "@rbxts/services"]);
	});
});

/**
 * The anchors GitHub gives a Markdown file's headings: lower case, punctuation and symbols dropped,
 * each space a hyphen, and `-1`, `-2`, ... after a repeated one. Headings inside code blocks are
 * not headings.
 */
function anchors(text: string): Set<string> {
	const found = new Set<string>();
	let fenced = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (fenced) continue;

		const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
		if (!heading) continue;

		const base = heading[1]
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
			.replace(/ /g, "-");

		let slug = base;
		for (let i = 1; found.has(slug); i++) slug = `${base}-${i}`;
		found.add(slug);
	}

	return found;
}

/**
 * Every problem with the links of a shipped Markdown file: each must name a file the package ships
 * (relative), a file of the repository it does not ship (on GitHub, `blob` or `tree` as it is), or
 * another site over https, and every anchor into the repository must name a heading of its target.
 */
function linkProblems(pkg: string, file: string, shipped: string[]): string[] {
	const problems: string[] = [];
	const read = (shippedFile: string) => fs.readFileSync(path.join(ROOT, "packages", pkg, shippedFile), "utf8");
	const text = read(file);

	for (const target of links(text)) {
		const [linked, anchor] = target.split("#", 2) as [string, string | undefined];
		const where = `${pkg}/${file}: ${target}`;

		// An anchor in the same page.
		if (linked === "") {
			if (!anchors(text).has(anchor!)) problems.push(`${where} names no heading`);
			continue;
		}

		// The repository on GitHub: a file that exists, and an anchor its headings give.
		if (target.startsWith(`${REPOSITORY}/`)) {
			const [, kind, repositoryPath] =
				linked.slice(REPOSITORY.length + 1).match(/^(blob|tree)\/HEAD\/(.+)$/) ?? [];
			const absolute = path.join(ROOT, repositoryPath ?? "");
			if (repositoryPath === undefined || !fs.existsSync(absolute)) {
				problems.push(`${where} is no file of the repository`);
			} else if (shipped.includes(repositoryPath)) {
				problems.push(`${where} is shipped, and should stay a relative link`);
			} else if ((kind === "tree") !== fs.statSync(absolute).isDirectory()) {
				problems.push(`${where} should be ${kind === "tree" ? "blob" : "tree"}`);
			} else if (anchor !== undefined && !anchors(fs.readFileSync(absolute, "utf8")).has(anchor)) {
				problems.push(`${where} names no heading`);
			}
			continue;
		}

		// Any other site (the v1 docs, Bun, Lune): over https.
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
			if (!target.startsWith("https://")) problems.push(where);
			continue;
		}

		// Relative: a shipped file, whose headings give the anchor.
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), linked));
		if (!shipped.includes(resolved)) {
			problems.push(`${where} is not shipped (${resolved})`);
		} else if (anchor !== undefined && !anchors(read(resolved)).has(anchor)) {
			problems.push(`${where} names no heading`);
		}
	}

	return problems;
}

/** Markdown with its link targets blanked, outside code: what a copy must keep of its source. */
const withoutTargets = (text: string) => text.replace(/\]\([^)\s]+\)/g, "]()");

const guide = fs
	.readdirSync(path.join(ROOT, "docs", "guide"))
	.filter((name) => name.endsWith(".md"))
	.map((name) => `docs/guide/${name}`)
	.sort();

const ai = fs
	.readdirSync(path.join(ROOT, "docs", "ai"))
	.filter((name) => name.endsWith(".md"))
	.map((name) => `docs/ai/${name}`)
	.sort();

const coreShipped = ["README.md", "docs/README.md", ...ai, ...guide];

describe("core's docs", () => {
	beforeAll(() => {
		// The copies are made before publishing and not committed.
		run("node", [path.join(ROOT, "scripts", "copy-readme.mjs")], ROOT);
		run("node", [path.join(ROOT, "scripts", "copy-docs.mjs")], ROOT);
	});

	test.each(PACKERS)("%s packs the index, the assistant's instructions and every guide page", (packer) => {
		expect(guide.length).toBe(12);
		expect(ai).toEqual([
			"docs/ai/components.md",
			"docs/ai/flamework.md",
			"docs/ai/networking.md",
			"docs/ai/plugins.md",
			"docs/ai/providers.md",
			"docs/ai/testing.md",
		]);

		const files = packed("core", packer);
		expect(files.filter((file) => file.startsWith("docs/"))).toEqual(["docs/README.md", ...ai, ...guide]);
	});

	// A pack or publish made without `prepare:docs` shipped no docs, and neither packer said so:
	// core's prepack makes the copy itself.
	test.each(PACKERS)("%s makes the copy through core's prepack when there is none", (packer) => {
		fs.rmSync(path.join(ROOT, "packages", "core", "docs"), { recursive: true, force: true });
		fs.rmSync(path.join(ROOT, "packages", "core", "README.md"), { force: true });

		const files = packed("core", packer, true);
		expect(files.filter((file) => file.startsWith("docs/") || file === "README.md")).toEqual([
			"README.md",
			"docs/README.md",
			...ai,
			...guide,
		]);
	});

	test("ships the pages as written, except for the links to files it does not ship", () => {
		for (const file of coreShipped.filter((shippedFile) => shippedFile.startsWith("docs/"))) {
			const source = fs.readFileSync(path.join(ROOT, file), "utf8");
			const copy = fs.readFileSync(path.join(ROOT, "packages", "core", file), "utf8");
			expect(withoutTargets(copy)).toBe(withoutTargets(source));
		}
	});

	test("links only to shipped files, and to the repository on GitHub for the rest, with every anchor resolving", () => {
		const problems = coreShipped
			.filter((file) => file.startsWith("docs/"))
			.flatMap((file) => linkProblems("core", file, coreShipped));
		expect(problems).toEqual([]);
	});

	test("keeps the links between shipped pages relative", () => {
		const read = (file: string) => fs.readFileSync(path.join(ROOT, "packages", "core", file), "utf8");
		expect(links(read("docs/guide/10-migrating-from-v1.md"))).toContain("07-macros.md#paths");
		expect(links(read("docs/README.md"))).toContain("guide/01-getting-started.md");
		expect(links(read("docs/guide/10-migrating-from-v1.md"))).toContain(`${REPOSITORY}/blob/HEAD/CHANGELOG.md`);
	});
});

describe("the README copied into each package", () => {
	const PACKAGES = ["core", "components", "networking", "transformer", "transformer-plugin"];

	beforeAll(() => {
		run("node", [path.join(ROOT, "scripts", "copy-readme.mjs")], ROOT);
	});

	test.each(PACKAGES)("%s ships it with links that work from node_modules", (pkg) => {
		for (const packer of PACKERS) {
			expect(packed(pkg, packer)).toContain("README.md");
		}

		const shipped = pkg === "core" ? coreShipped : ["README.md"];
		expect(linkProblems(pkg, "README.md", shipped)).toEqual([]);

		const source = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
		const copy = fs.readFileSync(path.join(ROOT, "packages", pkg, "README.md"), "utf8");
		expect(withoutTargets(copy)).toBe(withoutTargets(withoutRepositoryOnly(source)));
	});

	// The notes for contributors to this repository (how the specs and their variants are built)
	// stay in the root README and out of what npm shows.
	test.each(PACKAGES)("%s ships it without the repository-only blocks", (pkg) => {
		const source = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
		const copy = fs.readFileSync(path.join(ROOT, "packages", pkg, "README.md"), "utf8");
		expect(source).toContain("packages/specs/variants");
		expect(copy).not.toContain("packages/specs/variants");
		expect(copy).not.toContain("repository only");
	});

	test("core's keeps its link to the shipped index relative; the others point at GitHub", () => {
		const read = (pkg: string) => links(fs.readFileSync(path.join(ROOT, "packages", pkg, "README.md"), "utf8"));
		expect(read("core")).toContain("docs/README.md");
		expect(read("components")).toContain(`${REPOSITORY}/blob/HEAD/docs/README.md`);
		expect(read("core")).toContain(`${REPOSITORY}/blob/HEAD/docs/reference/internals.md`);
	});
});

describe("testing's own README", () => {
	// copy-readme leaves it as it is, so its links must work from node_modules and on npm as written.
	test("links only to its own headings, files of the repository on GitHub, and other sites", () => {
		for (const packer of PACKERS) {
			expect(packed("testing", packer)).toContain("README.md");
		}

		expect(linkProblems("testing", "README.md", ["README.md"])).toEqual([]);
	});
});

describe("the link rewriter", () => {
	const shipped = ["docs/guide/a.md", "docs/guide/b.md"];

	test("leaves code alone: fences, indented fences and code spans, even across a line", () => {
		const sample = [
			"See [the reference](../reference/internals.md#paths) and [b](b.md).",
			"",
			"```ts",
			"handlers[i](value);",
			"```",
			"",
			"- A list item:",
			"  ~~~lua",
			"  callbacks[1](x)",
			"  ~~~",
			"",
			"Inline `handlers[i](value)` and ``a `nested` ](x)`` stay; a span across",
			"a line `x",
			"y[0](arg)` too, and [after](../../CHANGELOG.md) is rewritten.",
			"",
			"An unmatched ` backtick leaves [this](../testing/place.md) a link.",
		].join("\n");

		const rewritten = rewriteLinks(sample, "docs/guide/a.md", shipped);
		expect(rewritten).toContain("handlers[i](value);");
		expect(rewritten).toContain("callbacks[1](x)");
		expect(rewritten).toContain("`handlers[i](value)`");
		expect(rewritten).toContain("``a `nested` ](x)``");
		expect(rewritten).toContain("`x\ny[0](arg)`");
		expect(links(rewritten)).toEqual([
			`${REPOSITORY}/blob/HEAD/docs/reference/internals.md#paths`,
			"b.md",
			`${REPOSITORY}/blob/HEAD/CHANGELOG.md`,
			`${REPOSITORY}/blob/HEAD/docs/testing/place.md`,
		]);
	});

	test("refuses a link to a file the repository does not have", () => {
		expect(() => rewriteLinks("[gone](missing.md)", "docs/guide/a.md", shipped)).toThrow(
			"docs/guide/a.md links to missing.md, which is not in the repository",
		);
	});
});
