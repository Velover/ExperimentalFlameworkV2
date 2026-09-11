import { describe, expect, test } from "bun:test";

import { parseArgs, UsageError } from "../src/cli.ts";
import { PLACE, SECRET, TASK_PATH, UNIVERSE, happyPath, json, resultJson, runCli, type Harness } from "./harness.ts";

describe("argument parsing", () => {
	test("publish and test take the place file as an argument", () => {
		expect(parseArgs(["test", "dist/place.rbxl"]).flags.file).toBe("dist/place.rbxl");
		expect(parseArgs(["publish", "dist/place.rbxl", "--published"]).flags).toEqual({
			file: "dist/place.rbxl",
			published: true,
		});
		expect(() => parseArgs(["run", "dist/place.rbxl"])).toThrow(UsageError);
		expect(() => parseArgs(["test", "a.rbxl", "b.rbxl"])).toThrow(UsageError);
		expect(() => parseArgs(["test", "a.rbxl", "--file", "b.rbxl"])).toThrow(UsageError);
	});

	test("flags work before and after the command", () => {
		expect(parseArgs(["run", "--version", "4"])).toEqual({
			command: "run",
			flags: { version: "4" },
		});
		expect(parseArgs(["--version", "4", "run"])).toEqual({
			command: "run",
			flags: { version: "4" },
		});
		expect(parseArgs(["--version=4", "run"]).flags.version).toBe("4");
	});

	test("unknown flags and commands are usage errors", () => {
		expect(() => parseArgs(["run", "--nope"])).toThrow(UsageError);
		expect(() => parseArgs(["fly"])).toThrow(/unknown command/);
		expect(() => parseArgs(["run", "--version"])).toThrow(/needs a value/);
		expect(() => parseArgs(["run", "extra"])).toThrow(/unexpected argument/);
	});

	test("a flag from another command is rejected", () => {
		expect(() => parseArgs(["publish", "--sections", "a"])).toThrow(/not a flag of "publish"/);
		// but "test" takes the flags of both phases
		expect(parseArgs(["test", "--sections", "a"]).flags.sections).toBe("a");
	});

	test("an unknown flag exits 2 and prints the usage", async () => {
		const run = await runCli(["run", "--wat"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("unknown flag: --wat");
		expect(run.err).toContain("Usage:");
	});

	test("no command at all exits 2", async () => {
		const run = await runCli([]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("no command given");
	});

	test("--help exits 0", async () => {
		const run = await runCli(["--help"]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("flamework-cloud");
		expect(run.out).toContain("test <file>");
	});
});

describe("dry run", () => {
	test("prints the request and the script, never the key", async () => {
		const run = await runCli(["run", "--dry-run", "--version", "4", "--sections", "economy,shop/buys"]);

		expect(run.code).toBe(0);
		expect(run.calls).toHaveLength(0);
		expect(run.out).toContain(
			`POST https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/places/${PLACE}/versions/4/luau-execution-session-tasks`,
		);
		expect(run.out).toContain("x-api-key: <redacted>");
		expect(run.out).toContain("timeout: 120s");
		// the real shim, with the filter substituted
		expect(run.out).toContain('.run({ "economy", "shop/buys" }, nil)');
		expect(run.out).toContain("@flamework-experimental");
		expect(run.all).not.toContain(SECRET);
	});

	test("without --version the url is unversioned", async () => {
		const run = await runCli(["run", "--dry-run"]);
		expect(run.out).toContain(`/places/${PLACE}/luau-execution-session-tasks`);
		expect(run.out).toContain(".run(nil, nil)");
		expect(run.all).not.toContain(SECRET);
	});

	test("--list is passed to the runner", async () => {
		const run = await runCli(["run", "--dry-run", "--list"]);
		expect(run.out).toContain(".run(nil, { list = true })");
	});

	test("--code replaces the shim", async () => {
		const run = await runCli(["run", "--dry-run", "--code", "return 1 + 1"]);
		expect(run.out).toContain("return 1 + 1");
		expect(run.out).not.toContain("@flamework-experimental");
	});
});

describe("run", () => {
	test("pins the version from build/version.json", async () => {
		const run = await runCli(["run"], {
			responses: happyPath([resultJson()]),
			files: {
				"build/version.json": JSON.stringify({ versionNumber: 4 }),
			},
		});

		expect(run.code).toBe(0);
		expect(run.calls[0]!.url).toContain("/versions/4/luau-execution-session-tasks");
		expect(run.out).toContain("build/version.json");
	});

	test("prints logs, the summary and exits 0 when ok", async () => {
		const run = await runCli(["run"], {
			responses: happyPath([resultJson()], ["boot", "done"]),
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("  [place] boot");
		expect(run.out).toContain("  [place] done");
		expect(run.out).toContain("PASS economy  2 passed, 0 failed");
		expect(run.out).toContain("2 passed, 0 failed in 12ms (server)");
		expect(run.out.trimEnd().endsWith("PASS")).toBe(true);
	});

	test("exits 1 when the result is not ok and names the failing test", async () => {
		const failing = resultJson({
			ok: false,
			passed: 1,
			failed: 1,
			sections: [
				{
					name: "economy",
					passed: 1,
					failed: 1,
					tests: [
						{ name: "buys", ok: true },
						{ name: "refunds", ok: false, error: "expected 5, got 4" },
					],
				},
			],
		});
		const run = await runCli(["run"], { responses: happyPath([failing]) });

		expect(run.code).toBe(1);
		expect(run.out).toContain("x refunds");
		expect(run.out).toContain("expected 5, got 4");
		expect(run.out.trimEnd().endsWith("FAIL")).toBe(true);
	});

	test("unknown section names fail the run", async () => {
		const run = await runCli(["run", "--sections", "ghost"], {
			responses: happyPath([resultJson({ ok: false, unknown: ["ghost"] })]),
		});

		expect(run.code).toBe(1);
		expect(run.out).toContain("matched nothing: ghost");
	});

	test("a FAILED task prints the error code and message and exits 1", async () => {
		const run = await runCli(["run"], {
			responses: [
				json({ path: TASK_PATH, state: "QUEUED" }),
				json({
					path: TASK_PATH,
					state: "FAILED",
					error: {
						code: "SCRIPT_ERROR",
						message:
							"@flamework-experimental/testing is not in this place: include TestingPlugin in the module testing.entry ignites and publish again",
					},
				}),
				json({ luauExecutionSessionTaskLogs: [], nextPageToken: "" }),
			],
		});

		expect(run.code).toBe(1);
		expect(run.err).toContain("task FAILED");
		expect(run.err).toContain("SCRIPT_ERROR");
		expect(run.err).toContain("include TestingPlugin");
	});

	test("--json prints the raw result instead of the summary", async () => {
		const run = await runCli(["run", "--json"], {
			responses: happyPath([resultJson()]),
		});

		expect(run.code).toBe(0);
		expect(run.out).not.toContain("PASS economy");
		const printed = run.out.slice(run.out.indexOf("{"));
		expect(JSON.parse(printed).sections[0].name).toBe("economy");
	});

	test("--code prints output.results", async () => {
		const run = await runCli(["run", "--code", "return 1 + 1"], {
			responses: happyPath(["2"]),
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("results (1):");
		expect(run.out).toContain("  [0] 2");
		expect(JSON.parse(run.calls[0]!.init.body as string).script).toBe("return 1 + 1");
	});

	test("a result that is not the runner's JSON exits 1", async () => {
		const run = await runCli(["run"], { responses: happyPath(["nil"]) });
		expect(run.code).toBe(1);
		expect(run.err).toContain("not JSON");
	});

	test("a missing key is reported without a stack", async () => {
		const run = await runCli(["run"], {
			env: { TESTING_UNIVERSE_ID: UNIVERSE, TESTING_PLACE_ID: PLACE },
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("no Open Cloud API key");
		expect(run.err).toContain("--key");
	});
});

describe("test", () => {
	test("uploads the place Rojo built, then runs against the version it made", async () => {
		const run = await runCli(["test", "dist/place.rbxl"], {
			responses: [json({ versionNumber: 9 }), ...happyPath([resultJson()])],
			files: { "dist/place.rbxl": "binary" },
		});

		expect(run.code).toBe(0);
		expect(run.calls[0]!.url).toEndWith("versions?versionType=Saved");
		expect(run.out).toContain("published version 9");
		expect(run.calls[1]!.url).toContain("/versions/9/luau-execution-session-tasks");
		expect(run.out).toContain("2 passed, 0 failed");
	});

	test("without the file it is a usage error that names the rojo command", async () => {
		const run = await runCli(["test"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("rojo build -o place.rbxl && flamework-cloud test place.rbxl");
		expect(run.calls).toHaveLength(0);
	});
});

describe("publish", () => {
	test("without the file it is a usage error", async () => {
		const run = await runCli(["publish"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("publish needs the place Rojo built");
		expect(run.calls).toHaveLength(0);
	});

	test("--key, then the shell, then .env supply the key", async () => {
		const upload = () => [json({ versionNumber: 5 })];
		const files = { "build/place.rbxl": "binary" };
		const ids = { TESTING_UNIVERSE_ID: UNIVERSE, TESTING_PLACE_ID: PLACE };
		const keyOf = (run: Harness) => (run.calls[0]!.init.headers as Record<string, string>)["x-api-key"];

		const flag = await runCli(["publish", "build/place.rbxl", "--key", "flag-key"], {
			env: ids,
			responses: upload(),
			files,
		});
		expect(keyOf(flag)).toBe("flag-key");

		const shell = await runCli(["publish", "build/place.rbxl"], {
			env: { ...ids, ROBLOX_API_KEY: "shell-key" },
			settings: { env: { ROBLOX_API_KEY: "dotenv-key" } },
			responses: upload(),
			files,
		});
		expect(keyOf(shell)).toBe("shell-key");

		const dotenv = await runCli(["publish", "build/place.rbxl"], {
			env: {},
			settings: { env: { ROBLOX_API_KEY: "dotenv-key", ...ids } },
			responses: upload(),
			files,
		});
		expect(keyOf(dotenv)).toBe("dotenv-key");
		expect(dotenv.calls[0]!.url).toContain(`/${UNIVERSE}/places/${PLACE}/`);
		expect(dotenv.all).not.toContain("dotenv-key");
	});

	test("uploads a Saved version and records it", async () => {
		const run = await runCli(["publish", "build/place.rbxl"], {
			responses: [json({ versionNumber: 5 })],
			files: { "build/place.rbxl": "binary" },
		});

		expect(run.code).toBe(0);
		expect(run.calls[0]!.url).toEndWith("versions?versionType=Saved");
		expect(run.out).toContain("published version 5");

		const record = JSON.parse(
			Object.entries(run.written).find(([path]) => path.endsWith("build/version.json"))![1],
		);
		expect(record).toEqual({
			versionNumber: 5,
			file: "build/place.rbxl",
			at: "2026-09-11T12:00:00.000Z",
		});
	});

	test("--published goes live", async () => {
		const run = await runCli(["publish", "build/place.rbxl", "--published"], {
			responses: [json({ versionNumber: 6 })],
			files: { "build/place.rbxl": "binary" },
		});
		expect(run.calls[0]!.url).toEndWith("versions?versionType=Published");
	});

	test("a 409 prints the Studio hint and exits 1", async () => {
		const busy = () =>
			new Response('{"message":"Save failed. Server is busy ..."}', {
				status: 409,
			});
		const run = await runCli(["publish", "build/place.rbxl"], {
			responses: [busy(), busy()],
			files: { "build/place.rbxl": "binary" },
		});

		expect(run.code).toBe(1);
		expect(run.err).toContain("Save failed. Server is busy");
		expect(run.err).toContain("close the place in Roblox Studio and retry");
		// retried exactly once
		expect(run.calls).toHaveLength(2);
		expect(run.all).not.toContain(SECRET);
	});

	test("a missing place file is caught before any request", async () => {
		const run = await runCli(["publish", "build/place.rbxl"]);
		expect(run.code).toBe(1);
		expect(run.err).toContain("build/place.rbxl does not exist");
		expect(run.err).toContain("rojo build -o build/place.rbxl");
		expect(run.calls).toHaveLength(0);
	});
});

describe("probe", () => {
	test("prints the decoded answer", async () => {
		const run = await runCli(["probe"], {
			responses: happyPath([
				JSON.stringify({
					isRunning: false,
					isServer: true,
					isClient: false,
					heartbeatsPerSecond: 60,
				}),
			]),
		});

		expect(run.code).toBe(0);
		expect(run.out).toMatch(/isRunning\s+false/);
		expect(run.out).toMatch(/isServer\s+true/);
		expect(run.out).toMatch(/heartbeatsPerSecond\s+60/);
		expect(JSON.parse(run.calls[0]!.init.body as string).script).toContain("Heartbeat");
	});
});
