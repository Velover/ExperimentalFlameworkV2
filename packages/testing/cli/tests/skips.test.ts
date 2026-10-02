import { describe, expect, test } from "bun:test";
import { basename } from "node:path";

import { ENV, happyPath, json, OTHER_STUDIO, resultJson, runCli, TESTING_STUDIO } from "./harness.ts";
import type { StudioEntry } from "../src/studio.ts";

const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";

const PROJECT = (properties: Record<string, unknown>) =>
	JSON.stringify({
		tree: {
			$className: "DataModel",
			ServerScriptService: { TS: { $path: "out/server" } },
			Workspace: { $className: "Workspace", $properties: properties },
		},
	});

/**
 * What a runner with skips returns: one test passed and one skipped with `reason`, or, with
 * `skips: 0`, two passes.
 */
function skipping(realm: "server" | "client", options: { skips?: number; reason?: string; project?: string } = {}) {
	const skips = options.skips ?? 1;
	const reason = options.reason ?? `only under the streaming project, on the ${realm}`;
	return JSON.stringify({
		ok: true,
		realm,
		...(options.project !== undefined ? { project: options.project } : {}),
		passed: 2 - skips,
		failed: 0,
		skipped: skips,
		durationMs: 9,
		sections: [
			{
				name: "projects",
				passed: 2 - skips,
				failed: 0,
				skipped: skips,
				tests: [
					{ name: "the place carries a name", ok: true, status: "passed", durationMs: 1 },
					skips > 0
						? {
								name: "StreamingEnabled follows the project",
								ok: true,
								status: "skipped",
								skipReason: reason,
								durationMs: 0,
							}
						: { name: "StreamingEnabled follows the project", ok: true, status: "passed", durationMs: 2 },
				],
			},
		],
		unknown: [],
	});
}

/** A Studio that lists every file the CLI launches, by name, and answers each realm from `results[file][realm]`. */
function studioThatOpens(results: Record<string, Record<string, string>>) {
	let mode = "Edit";
	let current = "";
	const listed: StudioEntry[] = [OTHER_STUDIO];
	return {
		fake: {
			studios: listed,
			answers: {
				get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
				start_stop_play: (args: Record<string, unknown>) => {
					mode = args.is_start ? "Play" : "Edit";
					return args.is_start ? "Game Started" : "Game Stopped";
				},
				execute_luau: (args: Record<string, unknown>) => {
					const answer = results[current]?.[args.datamodel_type as string];
					if (answer === undefined)
						throw new Error(`no result for ${current} ${String(args.datamodel_type)}`);
					return answer;
				},
				get_console_output: "",
			},
		},
		onLaunch: (command: string[]) => {
			current = basename(command[1]!);
			listed.push({ id: `studio-${current}-${listed.length}`, name: current });
		},
	};
}

/** `test place.rbxl` against a Studio whose realms answer `server` and `client`. */
async function testRun(
	argv: string[],
	answers: { server: string; client: string },
	options: Parameters<typeof runCli>[1] = {},
) {
	const studio = studioThatOpens({ "place.rbxl": { Server: answers.server, Client: answers.client } });
	return await runCli(["test", "place.rbxl", ...argv], {
		files: { "place.rbxl": "built" },
		studio: studio.fake,
		onLaunch: studio.onLaunch,
		...options,
	});
}

describe("skips in a Studio run", () => {
	test("each realm lists its skips with their reasons, the counts include them, and the run passes", async () => {
		const run = await testRun([], { server: skipping("server"), client: skipping("client") });

		expect(run.code).toBe(0);
		expect(run.out).toContain("PASS projects  1 passed, 0 failed, 1 skipped");
		expect(run.out).toContain(
			"       - StreamingEnabled follows the project (skipped): only under the streaming project, on the server",
		);
		expect(run.out).toContain(
			"       - StreamingEnabled follows the project (skipped): only under the streaming project, on the client",
		);
		expect(run.out).toContain("1 passed, 0 failed, 1 skipped in 9ms (server)");
		expect(run.out).toContain("1 passed, 0 failed, 1 skipped in 9ms (client)");
		expect(run.out).not.toContain("--fail-on-skip");
	});

	test("--fail-on-skip fails a run in which anything skipped, in either realm, and passes one where nothing did", async () => {
		const failed = await testRun(["--fail-on-skip"], {
			server: skipping("server", { skips: 0 }),
			client: skipping("client"),
		});
		expect(failed.code).toBe(1);
		expect(failed.out).toContain("1 skipped, which fails the run under --fail-on-skip");
		// The other realm still ran, and the window is closed as ever.
		expect(failed.out).toContain("2 passed, 0 failed, 0 skipped in 9ms (server)");
		expect(failed.closedWindows).toEqual(["place.rbxl"]);

		const passed = await testRun(["--fail-on-skip"], {
			server: skipping("server", { skips: 0 }),
			client: skipping("client", { skips: 0 }),
		});
		expect(passed.code).toBe(0);
		expect(passed.out).not.toContain("which fails the run");
	});

	test("--fail-on-skip judges each realm of several the same way, beside a filter entry only one realm has", async () => {
		const clientMiss = JSON.parse(skipping("client")) as Record<string, unknown>;
		clientMiss.ok = false;
		clientMiss.unknown = ["coin"];
		const run = await testRun(["--sections", "projects,coin", "--fail-on-skip"], {
			server: skipping("server", { skips: 0 }),
			client: JSON.stringify(clientMiss),
		});

		// The miss alone would pass (the server has coin, say): the client's skip is what fails it.
		expect(run.code).toBe(1);
		expect(run.out).toContain("not among the client's sections: coin");
		expect(run.out).toContain("1 skipped, which fails the run under --fail-on-skip");
	});

	test("FAIL_ON_SKIP and testing.failOnSkip turn it on; the flag wins over both, and the variable over the config", async () => {
		const answers = { server: skipping("server"), client: skipping("client", { skips: 0 }) };

		expect((await testRun([], answers, { env: { FAIL_ON_SKIP: "1" } })).code).toBe(1);
		expect((await testRun([], answers, { settings: { failOnSkip: true } })).code).toBe(1);
		// From .env, which the settings carry.
		expect((await testRun([], answers, { env: {}, settings: { env: { FAIL_ON_SKIP: "true" } } })).code).toBe(1);
		// The variable over the config, the flag over both.
		expect(
			(await testRun([], answers, { env: { FAIL_ON_SKIP: "off" }, settings: { failOnSkip: true } })).code,
		).toBe(0);
		expect((await testRun(["--fail-on-skip=false"], answers, { env: { FAIL_ON_SKIP: "yes" } })).code).toBe(0);
		// Empty is off, as an empty ROJO_PROJECT is none.
		expect((await testRun([], answers, { env: { FAIL_ON_SKIP: "" }, settings: { failOnSkip: true } })).code).toBe(
			0,
		);
	});

	test("a FAIL_ON_SKIP that is neither true nor false is refused before Studio opens", async () => {
		const run = await testRun(
			[],
			{ server: skipping("server"), client: skipping("client") },
			{ env: { FAIL_ON_SKIP: "sometimes" } },
		);
		expect(run.code).toBe(2);
		expect(run.err).toContain('FAIL_ON_SKIP must be true or false (or 1 or 0), got "sometimes"');
		expect(run.launched).toHaveLength(0);
	});

	test("--fail-on-skip against a place built before skips passes, and says it had nothing to go on", async () => {
		const run = await testRun(["--fail-on-skip"], {
			server: JSON.stringify(resultJson()),
			client: JSON.stringify(resultJson({ realm: "client" })),
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain(
			"note: this place's runner predates skips (2.0.0-alpha.5 or earlier) and reports none",
		);
		expect(run.out).toContain("2 passed, 0 failed, 0 skipped in 12ms (client)");
	});

	test("--json prints the result as the place gave it, statuses and reasons included, and --fail-on-skip still decides the exit", async () => {
		const run = await testRun(["--json", "--realm", "client", "--fail-on-skip"], {
			server: skipping("server"),
			client: skipping("client", { reason: "RenderStepped doesn't fire: the display may be asleep" }),
		});

		expect(run.code).toBe(1);
		const printed = JSON.parse(run.out.slice(run.out.indexOf("{"), run.out.lastIndexOf("}") + 1));
		expect(printed.skipped).toBe(1);
		expect(printed.sections[0].tests[1]).toEqual({
			name: "StreamingEnabled follows the project",
			ok: true,
			status: "skipped",
			skipReason: "RenderStepped doesn't fire: the display may be asleep",
			durationMs: 0,
		});
		expect(run.out).not.toContain("(skipped):");
	});

	test("--list marks a test registered with test.skip, and never fails under --fail-on-skip", async () => {
		const listing = JSON.stringify({
			ok: true,
			realm: "server",
			listed: true,
			passed: 0,
			failed: 0,
			skipped: 0,
			durationMs: 0,
			sections: [
				{
					name: "economy",
					passed: 0,
					failed: 0,
					skipped: 0,
					tests: [
						{ name: "buys", ok: true, status: "passed", durationMs: 0 },
						{
							name: "refunds",
							ok: true,
							status: "skipped",
							skipReason: "marked with test.skip",
							durationMs: 0,
						},
					],
				},
			],
			unknown: [],
		});
		const run = await testRun(["--list", "--realm", "server", "--fail-on-skip"], {
			server: listing,
			client: listing,
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("  economy/buys\n");
		expect(run.out).toContain("  economy/refunds  (skipped: marked with test.skip)");
		expect(run.out).toContain("1 sections, 2 tests (1 marked with test.skip)");
		expect(run.out).not.toContain("passed");
	});

	test("under several projects the closing line counts each project's skips", async () => {
		const projectsRun = async (argv: string[]) => {
			const studio = studioThatOpens({
				"place.default.rbxl": {
					Server: skipping("server", { project: "default" }),
					Client: skipping("client", { project: "default" }),
				},
				"place.streaming.rbxl": {
					Server: skipping("server", { skips: 0, project: "streaming" }),
					Client: skipping("client", { skips: 0, project: "streaming" }),
				},
			});
			return await runCli(
				["test", "place.rbxl", "--project", "default.project.json,tests/streaming.project.json", ...argv],
				{
					files: {
						"place.rbxl": "built",
						"default.project.json": PROJECT({}),
						"tests/streaming.project.json": PROJECT({ StreamingEnabled: true }),
						"place.default.rbxl": "made",
						"place.streaming.rbxl": "made",
					},
					studio: studio.fake,
					onLaunch: studio.onLaunch,
				},
			);
		};

		const run = await projectsRun([]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("projects: default passed (2 skipped), streaming passed");

		const strict = await projectsRun(["--fail-on-skip"]);
		expect(strict.code).toBe(1);
		expect(strict.out).toContain("projects: default FAILED (2 skipped), streaming passed");
	});

	test("studio run lists skips, and --fail-on-skip fails it", async () => {
		const studio = {
			studios: [TESTING_STUDIO],
			answers: { get_studio_state: PLAYING, execute_luau: skipping("server") },
		};
		const run = await runCli(["studio", "run"], { studio });
		expect(run.code).toBe(0);
		expect(run.out).toContain("- StreamingEnabled follows the project (skipped): only under the streaming project");

		const strict = await runCli(["studio", "run", "--fail-on-skip"], { studio });
		expect(strict.code).toBe(1);
		expect(strict.out).toContain("1 skipped, which fails the run under --fail-on-skip");
	});
});

describe("skips in a cloud run", () => {
	test("cloud run lists the server's skips; --fail-on-skip, FAIL_ON_SKIP and testing.failOnSkip fail it", async () => {
		const run = await runCli(["cloud", "run"], { responses: happyPath([skipping("server")]) });
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			"       - StreamingEnabled follows the project (skipped): only under the streaming project, on the server",
		);
		expect(run.out).toContain("1 passed, 0 failed, 1 skipped in 9ms (server)");

		const flagged = await runCli(["cloud", "run", "--fail-on-skip"], {
			responses: happyPath([skipping("server")]),
		});
		expect(flagged.code).toBe(1);
		expect(flagged.out.trimEnd().endsWith("FAIL")).toBe(true);

		const variable = await runCli(["cloud", "run"], {
			responses: happyPath([skipping("server")]),
			env: { ...ENV, FAIL_ON_SKIP: "true" },
		});
		expect(variable.code).toBe(1);

		const configured = await runCli(["cloud", "run"], {
			responses: happyPath([skipping("server")]),
			settings: { failOnSkip: true },
		});
		expect(configured.code).toBe(1);
	});

	test("test --cloud fails on a skip under --fail-on-skip, and --code ignores the setting", async () => {
		const run = await runCli(["test", "place.rbxl", "--cloud", "--fail-on-skip"], {
			responses: [json({ versionNumber: 9 }), ...happyPath([skipping("server")])],
			files: { "place.rbxl": "built" },
		});
		expect(run.code).toBe(1);
		expect(run.out).toContain("1 skipped, which fails the run under --fail-on-skip");

		// Raw Luau has no tests to skip: a misspelt variable does not stand in its way.
		const raw = await runCli(["cloud", "run", "--code", "return 1"], {
			responses: happyPath(["1"]),
			env: { ...ENV, FAIL_ON_SKIP: "maybe" },
		});
		expect(raw.code).toBe(0);
	});

	test("the flag belongs to the commands that report tests", async () => {
		expect((await runCli(["cloud", "publish", "place.rbxl", "--fail-on-skip"])).code).toBe(2);
		expect((await runCli(["studio", "exec", "--code", "return 1", "--fail-on-skip"])).code).toBe(2);
	});
});

describe("the hang report", () => {
	/** A test run whose client never answers, with Studio's output reading `output`. */
	async function hangingClient(output: string[]) {
		const studio = studioThatOpens({ "place.rbxl": { Server: skipping("server") } });
		const answers = studio.fake.answers as Record<string, unknown>;
		answers.execute_luau = (args: Record<string, unknown>) => {
			if (args.datamodel_type === "Client") throw new Error("execute_luau timed out after 1000ms");
			return skipping("server");
		};
		answers.get_console_output = () => output.join("\n");
		return await runCli(["test", "place.rbxl", "--timeout", "1s"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});
	}

	test("names the last test that reported, whose name has spaces, and a SKIP line counts as reporting", async () => {
		const run = await hangingClient([
			"[FWTEST] client client/the client module ignited: PASS (2ms)",
			"[FWTEST] client client/onRender fires on the client: SKIP (2003ms): RenderStepped doesn't fire: the display may be asleep",
			"[FWTEST] server projects/StreamingEnabled follows the project: PASS (1ms)",
		]);

		expect(run.code).toBe(1);
		expect(run.err).toContain("the client's run did not finish within 1s");
		expect(run.err).toContain("last test that reported: client/onRender fires on the client (SKIP)");
	});

	test("a FAIL's message that reads like a status does not move the name, and the battletest's own lines are not a test's", async () => {
		const run = await hangingClient([
			"[FWTEST] client networking/a round trip: FAIL (30001ms): expected: PASS (1ms), got nothing",
			// FwTest's check lines carry a detail, not a duration: they are not the runner's.
			"[FWTEST] client lifecycle: onRender fires on the client: FAIL (renders=0 after 15.0s)",
			"[FWTEST] client SUMMARY: 3 passed, 1 failed, 1 skipped (12ms)",
		]);

		expect(run.err).toContain("last test that reported: networking/a round trip (FAIL)");
	});
});
