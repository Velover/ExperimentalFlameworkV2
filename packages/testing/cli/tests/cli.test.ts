import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { cliVersion, parseArgs, UsageError } from "../src/cli.ts";
import { RENAMED_VARIABLES } from "../src/config.ts";
import {
	ENV,
	PLACE,
	SECRET,
	TASK_PATH,
	UNIVERSE,
	happyPath,
	json,
	resultJson,
	runCli,
	type Harness,
} from "./harness.ts";

describe("argument parsing", () => {
	test("test and cloud publish take the place file as an argument", () => {
		expect(parseArgs(["test", "dist/place.rbxl"]).flags.file).toBe("dist/place.rbxl");
		expect(parseArgs(["cloud", "publish", "dist/place.rbxl", "--published"])).toEqual({
			command: "cloud publish",
			flags: { file: "dist/place.rbxl", published: true },
		});
		expect(() => parseArgs(["cloud", "run", "dist/place.rbxl"])).toThrow(UsageError);
		expect(() => parseArgs(["cloud"])).toThrow(/cloud needs a subcommand/);
		expect(() => parseArgs(["publish", "dist/place.rbxl"])).toThrow(/unknown command: publish/);
		expect(() => parseArgs(["test", "a.rbxl", "b.rbxl"])).toThrow(UsageError);
		expect(() => parseArgs(["test", "a.rbxl", "--file", "b.rbxl"])).toThrow(UsageError);
	});

	test("flags work before and after the command", () => {
		expect(parseArgs(["cloud", "run", "--place-version", "4"])).toEqual({
			command: "cloud run",
			flags: { "place-version": "4" },
		});
		expect(parseArgs(["--place-version", "4", "cloud", "run"])).toEqual({
			command: "cloud run",
			flags: { "place-version": "4" },
		});
		expect(parseArgs(["--place-version=4", "cloud", "run"]).flags["place-version"]).toBe("4");
	});

	test("--project collects every value, repeated or comma-separated", () => {
		expect(parseArgs(["test", "place.rbxl", "--project", "a.project.json"]).flags.project).toEqual([
			"a.project.json",
		]);
		expect(
			parseArgs(["test", "--project", "a.project.json", "place.rbxl", "--project=b.project.json"]).flags.project,
		).toEqual(["a.project.json", "b.project.json"]);
		expect(parseArgs(["test", "place.rbxl", "--project", "a.project.json, b.project.json"]).flags.project).toEqual([
			"a.project.json",
			"b.project.json",
		]);
		expect(() => parseArgs(["test", "place.rbxl", "--project", ","])).toThrow(/--project needs a value/);
		expect(() => parseArgs(["test", "place.rbxl", "--project"])).toThrow(/--project needs a value/);
	});

	test("unknown flags and commands are usage errors", () => {
		expect(() => parseArgs(["cloud", "run", "--nope"])).toThrow(UsageError);
		expect(() => parseArgs(["fly"])).toThrow(/unknown command/);
		expect(() => parseArgs(["cloud", "run", "--place-version"])).toThrow(/needs a value/);
		expect(() => parseArgs(["cloud", "run", "extra"])).toThrow(/unexpected argument/);
	});

	test("a flag from another command is rejected", () => {
		expect(() => parseArgs(["cloud", "publish", "--sections", "a"])).toThrow(/not a flag of "cloud publish"/);
		expect(parseArgs(["test", "--sections", "a", "--realm", "client", "--keep"]).flags.keep).toBe(true);
		expect(() => parseArgs(["test", "--place-version", "4"])).toThrow(/not a flag of "test"/);
	});

	test("an unknown flag exits 2 and prints the usage", async () => {
		const run = await runCli(["cloud", "run", "--wat"]);
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
		expect(run.out).toContain("flamework-test");
		expect(run.out).toContain("test <file>");
	});
});

describe("dry run", () => {
	test("prints the request and the script, never the key", async () => {
		const run = await runCli([
			"cloud",
			"run",
			"--dry-run",
			"--place-version",
			"4",
			"--sections",
			"economy,shop/buys",
		]);

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

	test("without --place-version the url is unversioned", async () => {
		const run = await runCli(["cloud", "run", "--dry-run"]);
		expect(run.out).toContain(`/places/${PLACE}/luau-execution-session-tasks`);
		expect(run.out).toContain(".run(nil, nil)");
		expect(run.all).not.toContain(SECRET);
	});

	test("--list is passed to the runner", async () => {
		const run = await runCli(["cloud", "run", "--dry-run", "--list"]);
		expect(run.out).toContain(".run(nil, { list = true })");
	});

	test("--concurrency is passed to the runner, and a bad value is bad usage", async () => {
		const run = await runCli(["cloud", "run", "--dry-run", "--concurrency", "3"]);
		expect(run.out).toContain(".run(nil, { concurrency = 3 })");

		for (const bad of ["0", "1.5", "two"]) {
			const refused = await runCli(["cloud", "run", "--dry-run", "--concurrency", bad]);
			expect(refused.code).toBe(2);
			expect(refused.err).toContain(`--concurrency must be a whole number, 1 or more, got "${bad}"`);
		}
	});

	test("--code replaces the shim", async () => {
		const run = await runCli(["cloud", "run", "--dry-run", "--code", "return 1 + 1"]);
		expect(run.out).toContain("return 1 + 1");
		expect(run.out).not.toContain("@flamework-experimental");
	});
});

describe("run", () => {
	test("pins the version from build/version.json", async () => {
		const run = await runCli(["cloud", "run"], {
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
		const run = await runCli(["cloud", "run"], {
			responses: happyPath([resultJson()], ["boot", "done"]),
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("  [place] boot");
		expect(run.out).toContain("  [place] done");
		expect(run.out).toContain("PASS economy  2 passed, 0 failed");
		expect(run.out).toContain("2 passed, 0 failed, 0 skipped in 12ms (server)");
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
		const run = await runCli(["cloud", "run"], { responses: happyPath([failing]) });

		expect(run.code).toBe(1);
		expect(run.out).toContain("x refunds");
		expect(run.out).toContain("expected 5, got 4");
		expect(run.out.trimEnd().endsWith("FAIL")).toBe(true);
	});

	test("unknown section names fail the run", async () => {
		const run = await runCli(["cloud", "run", "--sections", "ghost"], {
			responses: happyPath([resultJson({ ok: false, unknown: ["ghost"] })]),
		});

		expect(run.code).toBe(1);
		expect(run.out).toContain("matched nothing: ghost");
	});

	test("a FAILED task prints the error code and message and exits 1", async () => {
		const run = await runCli(["cloud", "run"], {
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
		const run = await runCli(["cloud", "run", "--json"], {
			responses: happyPath([resultJson()]),
		});

		expect(run.code).toBe(0);
		expect(run.out).not.toContain("PASS economy");
		const printed = run.out.slice(run.out.indexOf("{"));
		expect(JSON.parse(printed).sections[0].name).toBe("economy");
	});

	test("--code prints output.results", async () => {
		const run = await runCli(["cloud", "run", "--code", "return 1 + 1"], {
			responses: happyPath(["2"]),
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("results (1):");
		expect(run.out).toContain("  [0] 2");
		expect(JSON.parse(run.calls[0]!.init.body as string).script).toBe("return 1 + 1");
	});

	test("a result that is not the runner's JSON exits 1", async () => {
		const run = await runCli(["cloud", "run"], { responses: happyPath(["nil"]) });
		expect(run.code).toBe(1);
		expect(run.err).toContain("not JSON");
	});

	test("a missing key is reported without a stack", async () => {
		const run = await runCli(["cloud", "run"], {
			env: { FLAMEWORK_TEST_UNIVERSE_ID: UNIVERSE, FLAMEWORK_TEST_PLACE_ID: PLACE },
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("no Open Cloud API key");
		expect(run.err).toContain("--api-key");
	});
});

describe("test --cloud", () => {
	test("uploads the place Rojo built, then runs against the version it made", async () => {
		const run = await runCli(["test", "dist/place.rbxl", "--cloud"], {
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
		const run = await runCli(["test", "--cloud"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("rojo build -o place.rbxl && flamework-test test place.rbxl");
		expect(run.calls).toHaveLength(0);
	});
});

describe("publish", () => {
	test("without the file it is a usage error", async () => {
		const run = await runCli(["cloud", "publish"]);
		expect(run.code).toBe(2);
		expect(run.err).toContain("publish needs the place Rojo built");
		expect(run.calls).toHaveLength(0);
	});

	test("--api-key, then the shell, then .env supply the key", async () => {
		const upload = () => [json({ versionNumber: 5 })];
		const files = { "build/place.rbxl": "binary" };
		const ids = { FLAMEWORK_TEST_UNIVERSE_ID: UNIVERSE, FLAMEWORK_TEST_PLACE_ID: PLACE };
		const keyOf = (run: Harness) => (run.calls[0]!.init.headers as Record<string, string>)["x-api-key"];

		const flag = await runCli(["cloud", "publish", "build/place.rbxl", "--api-key", "flag-key"], {
			env: ids,
			responses: upload(),
			files,
		});
		expect(keyOf(flag)).toBe("flag-key");

		const shell = await runCli(["cloud", "publish", "build/place.rbxl"], {
			env: { ...ids, ROBLOX_API_KEY: "shell-key" },
			settings: { env: { ROBLOX_API_KEY: "dotenv-key" } },
			responses: upload(),
			files,
		});
		expect(keyOf(shell)).toBe("shell-key");

		const dotenv = await runCli(["cloud", "publish", "build/place.rbxl"], {
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
		const run = await runCli(["cloud", "publish", "build/place.rbxl"], {
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
		const run = await runCli(["cloud", "publish", "build/place.rbxl", "--published"], {
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
		const run = await runCli(["cloud", "publish", "build/place.rbxl"], {
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
		const run = await runCli(["cloud", "publish", "build/place.rbxl"]);
		expect(run.code).toBe(1);
		expect(run.err).toContain("build/place.rbxl does not exist");
		expect(run.err).toContain("rojo build -o build/place.rbxl");
		expect(run.calls).toHaveLength(0);
	});
});

describe("probe", () => {
	test("prints the decoded answer", async () => {
		const run = await runCli(["cloud", "probe"], {
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

describe("the names of before 2.0.0-beta.0 are refused, each naming its new one", () => {
	test("a renamed flag, wherever it stands, before the command or after", () => {
		for (const [argv, said] of [
			[["test", "p.rbxl", "--show"], "--show is now --show-windows"],
			[["--show", "test", "p.rbxl"], "--show is now --show-windows"],
			[["test", "p.rbxl", "--keep", "--hold", "5"], "--hold is now --lock-hold"],
			[["studio", "open", "--hold=5"], "--hold is now --lock-hold"],
			[["patch", "p.rbxl", "--original", "o.rbxl"], "--original is now --original-place"],
			[["cloud", "run", "--testing-universe", "1"], "--testing-universe is now --universe-id"],
			[["--testing-place", "2", "cloud", "run"], "--testing-place is now --place-id"],
			[["cloud", "publish", "p.rbxl", "--key", "k"], "--key is now --api-key"],
		] as const) {
			expect(() => parseArgs([...argv])).toThrow(said);
		}
	});

	test("--timeout names the flag for what it meant in each command", () => {
		const run =
			"--run-timeout (how long a run may take; one test's limit is testing.timeout in flamework.config.json)";
		const call = "--call-timeout (how long the call to Studio may take)";
		for (const [argv, now] of [
			[["test", "p.rbxl", "--timeout", "60s"], run],
			// Its value is taken as its value, not as the command.
			[["--timeout", "60s", "test", "p.rbxl"], run],
			[["studio", "run", "--timeout", "60s"], run],
			[["cloud", "run", "--timeout=60s"], run],
			[["cloud", "probe", "--timeout", "60s"], run],
			[["studio", "exec", "--code", "return 1", "--timeout", "5s"], call],
			[["studio", "call", "get_studio_state", "--timeout", "5s"], call],
			[["studio", "open", "--timeout", "30s"], "--connect-timeout <seconds> (how long the window is waited for)"],
			[
				["--timeout", "5s"],
				"--run-timeout (test, studio run, cloud run, cloud probe), --call-timeout (studio exec, studio call) or --connect-timeout (studio open)",
			],
		] as const) {
			expect(() => parseArgs([...argv])).toThrow(`--timeout is now ${now}`);
		}
		// The new ones parse, each where it belongs.
		expect(parseArgs(["test", "p.rbxl", "--run-timeout", "60s"]).flags["run-timeout"]).toBe("60s");
		expect(parseArgs(["studio", "call", "x", "--call-timeout", "5s"]).flags["call-timeout"]).toBe("5s");
		expect(() => parseArgs(["studio", "open", "--run-timeout", "5s"])).toThrow(/not a flag of "studio open"/);
		expect(() => parseArgs(["test", "p.rbxl", "--call-timeout", "5s"])).toThrow(/not a flag of "test"/);
	});

	test("--version <n> is --place-version <n>, and --version alone prints flamework-test's own version", async () => {
		const moved =
			"--version <n> is now --place-version <n>: the place version a cloud run runs; --version alone prints flamework-test's own version";
		expect(() => parseArgs(["cloud", "run", "--version", "4"])).toThrow(moved);
		expect(() => parseArgs(["--version=4", "cloud", "run"])).toThrow(moved);
		expect(() => parseArgs(["cloud", "run", "--version"])).toThrow(
			"--version prints flamework-test's own version, with no command; the place version a cloud run runs is --place-version <n>",
		);

		const version = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as {
			version: string;
		};
		const run = await runCli(["--version"]);
		expect(run.code).toBe(0);
		expect(run.out).toBe(version.version);
		expect(cliVersion()).toBe(version.version);
	});

	test("cloud test is refused, naming test --cloud, and nothing is uploaded", async () => {
		expect(() => parseArgs(["cloud", "test", "p.rbxl"])).toThrow(
			"cloud test was removed: run flamework-test test <file> --cloud, which publishes the file and runs its tests",
		);
		const run = await runCli(["cloud", "test", "dist/place.rbxl"], { files: { "dist/place.rbxl": "binary" } });
		expect(run.code).toBe(2);
		expect(run.err).toContain("error: cloud test was removed");
		expect(run.calls).toHaveLength(0);
	});

	test("a renamed flag exits 2, prints the usage, and opens nothing", async () => {
		const run = await runCli(["test", "place.rbxl", "--show"], { files: { "place.rbxl": "built" } });
		expect(run.code).toBe(2);
		expect(run.err).toContain("error: --show is now --show-windows");
		expect(run.err).toContain("Usage:");
		expect(run.launched).toHaveLength(0);
	});

	test("an old environment variable, from the shell or from .env, stops every command before it does anything", async () => {
		for (const [old, renamed] of Object.entries(RENAMED_VARIABLES)) {
			const shell = await runCli(["cloud", "run"], {
				env: { ...ENV, [old]: "1" },
				responses: happyPath([resultJson()]),
			});
			expect(shell.code).toBe(1);
			expect(shell.err).toContain(
				`error: flamework-test's environment variables were renamed: ${old} is now ${renamed}`,
			);
			expect(shell.err).toContain("nothing was run");
			expect(shell.calls).toHaveLength(0);
		}

		// An empty one too, as `ORIGINAL_PLACE=` turned the original off; and one from .env, for a
		// command that reads no setting at all.
		const empty = await runCli(["cloud", "run"], { env: { ...ENV, ORIGINAL_PLACE: "" } });
		expect(empty.code).toBe(1);
		expect(empty.err).toContain("ORIGINAL_PLACE is now FLAMEWORK_TEST_ORIGINAL_PLACE");
		const dotenv = await runCli(["studio", "list"], { settings: { env: { ROJO_PROJECT: "a.project.json" } } });
		expect(dotenv.code).toBe(1);
		expect(dotenv.err).toContain("ROJO_PROJECT is now FLAMEWORK_TEST_PROJECT");
		expect(dotenv.studioCalls).toHaveLength(0);

		// Several at once are named together.
		const several = await runCli(["test", "place.rbxl"], {
			env: { FAIL_ON_SKIP: "1", KEEP_AWAKE: "1" },
			files: { "place.rbxl": "built" },
		});
		expect(several.err).toContain(
			"FAIL_ON_SKIP is now FLAMEWORK_TEST_FAIL_ON_SKIP; KEEP_AWAKE is now FLAMEWORK_TEST_KEEP_AWAKE",
		);
		expect(several.launched).toHaveLength(0);
	});

	test("the API key's one name is ROBLOX_API_KEY: the TESTING_PLACE_API_KEY alias is gone", async () => {
		const ids = { FLAMEWORK_TEST_UNIVERSE_ID: UNIVERSE, FLAMEWORK_TEST_PLACE_ID: PLACE };
		const alias = await runCli(["cloud", "run"], { env: { ...ids, TESTING_PLACE_API_KEY: SECRET } });
		expect(alias.code).toBe(1);
		expect(alias.err).toContain("TESTING_PLACE_API_KEY is now ROBLOX_API_KEY");
		expect(alias.err).not.toContain(SECRET);
		expect(alias.calls).toHaveLength(0);
	});
});
