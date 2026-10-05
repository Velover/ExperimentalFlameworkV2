import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, loadCloudSettings } from "../src/config.ts";

function scratch(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "flamework-test-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

describe("loadCloudSettings", () => {
	test("reads the cloud section with its environment substituted", () => {
		const dir = scratch({
			"flamework.config.json": JSON.stringify({
				cloud: {
					testingUniverseId: "10765968722",
					testingPlaceId: "108973151455286",
					apiKey: "${FLAMEWORK_CLOUD_TEST_KEY:-}",
				},
			}),
			".env": "FLAMEWORK_CLOUD_TEST_KEY=from-dotenv\n",
		});
		try {
			const settings = loadCloudSettings(dir, {});
			expect(settings.testingUniverseId).toBe("10765968722");
			expect(settings.testingPlaceId).toBe("108973151455286");
			expect(settings.apiKey).toBe("from-dotenv");
			expect(settings.configPath).toBe(join(dir, "flamework.config.json"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the process environment wins over .env, and an unset key is absent rather than empty", () => {
		const dir = scratch({
			"flamework.config.json": JSON.stringify({ cloud: { apiKey: "${FLAMEWORK_CLOUD_TEST_KEY:-}" } }),
			".env": "FLAMEWORK_CLOUD_TEST_KEY=from-dotenv\n",
		});
		try {
			expect(loadCloudSettings(dir, { FLAMEWORK_CLOUD_TEST_KEY: "from-process" }).apiKey).toBe("from-process");
			rmSync(join(dir, ".env"));
			expect(loadCloudSettings(dir, {}).apiKey).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads the CLI's own keys of the testing section, testing.keepAwake and testing.failOnSkip", () => {
		const dir = scratch({
			"flamework.config.json": JSON.stringify({ testing: { keepAwake: true, failOnSkip: false, timeout: 5 } }),
		});
		try {
			const settings = loadCloudSettings(dir, {});
			expect(settings.keepAwake).toBe(true);
			expect(settings.failOnSkip).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads the Studio lock's keys, testing.lockTimeout and testing.lockHold, from the environment too", () => {
		const dir = scratch({
			"flamework.config.json": JSON.stringify({
				testing: { lockTimeout: 90, lockHold: "${FLAMEWORK_TEST_HOLD_FOR_CONFIG:-30}" },
			}),
		});
		try {
			expect(loadCloudSettings(dir, {})).toMatchObject({ lockTimeout: 90, lockHold: 30 });
			expect(loadCloudSettings(dir, { FLAMEWORK_TEST_HOLD_FOR_CONFIG: "45" }).lockHold).toBe(45);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a directory with no config file gives empty settings", () => {
		const dir = scratch({});
		try {
			const settings = loadCloudSettings(dir, {});
			expect(settings).toEqual({
				testingUniverseId: undefined,
				testingPlaceId: undefined,
				originalPlace: undefined,
				apiKey: undefined,
				configPath: undefined,
				env: {},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(".env variables are exposed without the config referencing them, the process environment winning", () => {
		const dir = scratch({ ".env": "ROBLOX_API_KEY=from-dotenv\nPLACE_ID=7\n" });
		try {
			expect(loadCloudSettings(dir, {}).env).toMatchObject({ ROBLOX_API_KEY: "from-dotenv", PLACE_ID: "7" });
			expect(loadCloudSettings(dir, { PLACE_ID: "8" }).env.PLACE_ID).toBe("8");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a config file found above the working directory is used", () => {
		const dir = scratch({
			"flamework.config.json": JSON.stringify({ cloud: { testingPlaceId: "42" } }),
			"src/server/.keep": "",
		});
		try {
			expect(loadCloudSettings(join(dir, "src", "server"), {}).testingPlaceId).toBe("42");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findProjectRoot", () => {
	test("the nearest folder with a flamework.config.json, else the nearest with a package.json, else the folder itself", () => {
		const root = mkdtempSync(join(tmpdir(), "fwroot-"));
		try {
			// A game with its config, a subfolder with a package.json of its own, and a package without a config.
			const game = join(root, "game");
			mkdirSync(join(game, "src", "deep"), { recursive: true });
			mkdirSync(join(game, "pkg", "inner"), { recursive: true });
			mkdirSync(join(root, "noconfig", "src"), { recursive: true });
			mkdirSync(join(root, "bare", "deep"), { recursive: true });
			writeFileSync(join(game, "package.json"), "{}");
			writeFileSync(join(game, "flamework.config.json"), "{}");
			writeFileSync(join(game, "pkg", "package.json"), "{}");
			writeFileSync(join(root, "noconfig", "package.json"), "{}");

			expect(findProjectRoot(game)).toBe(game);
			expect(findProjectRoot(join(game, "src", "deep"))).toBe(game);
			// Its own package.json does not make a subfolder another project.
			expect(findProjectRoot(join(game, "pkg", "inner"))).toBe(game);
			expect(findProjectRoot(join(game, "pkg"))).toBe(game);
			// No config anywhere above: the nearest package.json.
			expect(findProjectRoot(join(root, "noconfig", "src"))).toBe(join(root, "noconfig"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("with neither above it, the folder itself", () => {
		const top = resolve("/");
		const files = new Set<string>();
		const isFile = (path: string) => files.has(path);
		expect(findProjectRoot(join(top, "a", "b"), isFile)).toBe(join(top, "a", "b"));
		files.add(join(top, "a", "package.json"));
		expect(findProjectRoot(join(top, "a", "b"), isFile)).toBe(join(top, "a"));
		files.add(join(top, "flamework.config.json"));
		expect(findProjectRoot(join(top, "a", "b"), isFile)).toBe(top);
	});
});
