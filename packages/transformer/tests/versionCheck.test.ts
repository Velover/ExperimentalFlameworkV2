import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { compileFixtureFresh } from "./compile";

const FIXTURE = path.resolve(import.meta.dir, "fixture");
const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");
const VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")).version as string;
const STACK = /^\s+at .+:\d+:\d+\)?$/m;

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");
const build = () => {
	const result = spawnSync("node", [RBXTSC], { cwd: FIXTURE, encoding: "utf8" });
	return { status: result.status, output: plain(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
};

/**
 * A package under the fixture's src, with a flamework.build written by `flameworkVersion`: the
 * build finds it next to the package's file, as it finds an installed package's.
 */
function fakePackage(folder: string, name: string, flameworkVersion: string) {
	const directory = path.join(FIXTURE, "src", folder);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: flameworkVersion }));
	fs.writeFileSync(path.join(directory, "probe.ts"), "export const value = 1;\n");
	fs.writeFileSync(
		path.join(directory, "flamework.build"),
		JSON.stringify({ version: 1, flameworkVersion, identifierPrefix: "$probe", identifiers: {} }),
	);
	return directory;
}

describe("Flamework's packages at another version", () => {
	// Package build infos were loaded without looking at the version that wrote them: a mixed install
	// built, and failed at runtime in ways that did not name the cause.
	const folders = ["versionProbe", "versionProbeOther"];
	const cleanUp = () => {
		for (const folder of folders) {
			fs.rmSync(path.join(FIXTURE, "src", folder), { recursive: true, force: true });
			fs.rmSync(path.join(FIXTURE, "out", folder), { recursive: true, force: true });
		}
	};
	const restore = () => {
		cleanUp();
		const restored = compileFixtureFresh();
		if (restored.status !== 0) throw new Error(`fixture failed to restore:\n${restored.output}`);
	};

	test("refuses one built by another version, naming it, both versions and the fix", () => {
		cleanUp();
		try {
			fakePackage("versionProbe", "@flamework-experimental/probe", "2.0.0-alpha.1");
			const result = build();

			expect(result.status).not.toBe(0);
			expect(result.output).not.toMatch(STACK);
			expect(result.output).toContain(
				`[Flamework]: Flamework's packages are not all the same version: @flamework-experimental/transformer is ${VERSION}, and this package was built by another version.\n`,
			);
			expect(result.output).toContain(
				"[Flamework]:   @flamework-experimental/probe 2.0.0-alpha.1 (src/versionProbe/flamework.build)\n",
			);
			expect(result.output).toContain(
				`[Flamework]: Install the same version of every @flamework-experimental package: update it to ${VERSION}, or install @flamework-experimental/transformer@2.0.0-alpha.1 instead, then build again.\n`,
			);
		} finally {
			cleanUp();
		}
	}, 300_000);

	test("takes one built by the same version, and another scope's package built by any", () => {
		cleanUp();
		try {
			fakePackage("versionProbe", "@flamework-experimental/probe", VERSION);
			fakePackage("versionProbeOther", "@probe/library", "2.0.0-alpha.1");
			const result = build();

			expect(result.output).not.toContain("not all the same version");
			expect(result.status).toBe(0);
		} finally {
			restore();
		}
	}, 300_000);
});
