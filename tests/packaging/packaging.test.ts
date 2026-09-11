import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

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
