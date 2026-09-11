import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCloudSettings } from "../src/config.ts";

function scratch(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "flamework-cloud-"));
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
					universeId: "10765968722",
					placeId: "108973151455286",
					apiKey: "${FLAMEWORK_CLOUD_TEST_KEY:-}",
				},
			}),
			".env": "FLAMEWORK_CLOUD_TEST_KEY=from-dotenv\n",
		});
		try {
			const settings = loadCloudSettings(dir, {});
			expect(settings.universeId).toBe("10765968722");
			expect(settings.placeId).toBe("108973151455286");
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

	test("a directory with no config file gives empty settings", () => {
		const dir = scratch({});
		try {
			const settings = loadCloudSettings(dir, {});
			expect(settings).toEqual({
				universeId: undefined,
				placeId: undefined,
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
			"flamework.config.json": JSON.stringify({ cloud: { placeId: "42" } }),
			"src/server/.keep": "",
		});
		try {
			expect(loadCloudSettings(join(dir, "src", "server"), {}).placeId).toBe("42");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
