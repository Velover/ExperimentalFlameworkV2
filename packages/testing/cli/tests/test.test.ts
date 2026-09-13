import { describe, expect, test } from "bun:test";

import { OTHER_STUDIO, PLACE, TESTING_STUDIO, happyPath, json, resultJson, runCli } from "./harness.ts";
import type { StudioEntry } from "../src/studio.ts";

/** The window a freshly opened local file gets: listed by file name, no place id. */
const BUILT_STUDIO: StudioEntry = { id: "studio-4", name: "place.rbxl" };
const PATCHED_STUDIO: StudioEntry = { id: "studio-5", name: "place.patched.rbxl" };

const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";

const PROJECT = JSON.stringify({
	tree: { $className: "DataModel", ServerScriptService: { TS: { $path: "out/server" } } },
});

/** A Studio that lists the window once it has been launched, and plays when told to. */
function studioThatOpens(window: StudioEntry, results: Record<string, string>) {
	let launched = false;
	let mode = "Edit";
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
				execute_luau: (args: Record<string, unknown>) => results[args.datamodel_type as string]!,
			},
		},
		/** The harness calls this when the CLI launches Studio; the window shows up on the next listing. */
		onLaunch: () => {
			if (!launched) {
				launched = true;
				listed.push(window);
			}
		},
	};
}

describe("test", () => {
	test("opens the build in Studio, runs both realms in one play session, reports each, and closes it", async () => {
		const studio = studioThatOpens(BUILT_STUDIO, {
			Server: JSON.stringify(resultJson()),
			Client: JSON.stringify(resultJson({ realm: "client", passed: 1, sections: [] })),
		});
		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		expect(run.code).toBe(0);
		expect(run.launched).toHaveLength(1);
		expect(run.launched[0]![1]!.replaceAll("\\", "/")).toEndWith("/place.rbxl");
		expect(run.out).toContain("connected: place.rbxl");

		const calls = run.studioCalls.map((call) => call.name);
		expect(calls).toEqual([
			"get_studio_state",
			"start_stop_play",
			"get_studio_state",
			"execute_luau",
			"execute_luau",
			"start_stop_play",
		]);
		expect(run.studioCalls[3]!.args.datamodel_type).toBe("Server");
		expect(run.studioCalls[4]!.args.datamodel_type).toBe("Client");
		expect(run.out).toContain("2 passed, 0 failed in 12ms (server)");
		expect(run.out).toContain("1 passed, 0 failed in 12ms (client)");
		expect(run.out).toContain("play session stopped");
		expect(run.closedWindows).toEqual(["place.rbxl - Roblox Studio"]);
		expect(run.out).toContain("closed place.rbxl");
		const forced = await runCli(["studio", "close"], {
			studio: { studios: [TESTING_STUDIO] },
			closeOutcome: "forced",
		});
		expect(forced.out).toContain("closed TestingExperience, which asked before going");
		// Nothing touched the cloud.
		expect(run.calls).toHaveLength(0);
	});

	test("a failing realm fails the run, the other realm still runs, and --keep leaves Studio open", async () => {
		const studio = studioThatOpens(BUILT_STUDIO, {
			Server: JSON.stringify(
				resultJson({
					ok: false,
					passed: 1,
					failed: 1,
					sections: [
						{
							name: "economy",
							passed: 1,
							failed: 1,
							tests: [
								{ name: "buys", ok: true, durationMs: 1 },
								{ name: "sells", ok: false, error: "the shop was empty", durationMs: 2 },
							],
						},
					],
				}),
			),
			Client: JSON.stringify(resultJson({ realm: "client" })),
		});
		const run = await runCli(["test", "place.rbxl", "--keep"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		expect(run.code).toBe(1);
		expect(run.out).toContain("the shop was empty");
		expect(run.out).toContain("2 passed, 0 failed in 12ms (client)");
		expect(run.studioCalls.filter((call) => call.name === "execute_luau")).toHaveLength(2);
		// --keep: the session stays and so does the window.
		expect(run.studioCalls.filter((call) => call.name === "start_stop_play")).toHaveLength(1);
		expect(run.closedWindows).toHaveLength(0);
		expect(run.out).toContain("Studio left open (--keep)");
	});

	test("--realm picks one realm, and --sections reaches the host", async () => {
		const studio = studioThatOpens(BUILT_STUDIO, { Client: JSON.stringify(resultJson({ realm: "client" })) });
		const run = await runCli(["test", "place.rbxl", "--realm", "client", "--sections", "ui"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		expect(run.code).toBe(0);
		const execs = run.studioCalls.filter((call) => call.name === "execute_luau");
		expect(execs).toHaveLength(1);
		expect(execs[0]!.args.datamodel_type).toBe("Client");
		expect(execs[0]!.args.code).toContain('host:Invoke("ui", nil)');

		const bad = await runCli(["test", "place.rbxl", "--realm", "edit"], { files: { "place.rbxl": "built" } });
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("--realm must be server, client or both");
	});

	test("a window left over from an earlier build of the same file is closed before the fresh one opens", async () => {
		const studio = studioThatOpens(BUILT_STUDIO, {
			Server: JSON.stringify(resultJson()),
			Client: JSON.stringify(resultJson({ realm: "client" })),
		});
		// The stale window is listed from the start, under the same name.
		studio.fake.studios.push({ id: "studio-old", name: "place.rbxl" });

		const run = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("already open in Studio, from an earlier build; closing it");
		expect(run.closedWindows).toEqual(["place.rbxl - Roblox Studio", "place.rbxl - Roblox Studio"]);
		expect(run.launched).toHaveLength(1);
	});

	test("with an original place the patched file is what opens, and lune is checked first", async () => {
		const studio = studioThatOpens(PATCHED_STUDIO, {
			Server: JSON.stringify(resultJson()),
			Client: JSON.stringify(resultJson({ realm: "client" })),
		});
		const run = await runCli(["test", "place.rbxl", "--original", "original.rbxl"], {
			files: {
				"place.rbxl": "built",
				"original.rbxl": "orig",
				"default.project.json": PROJECT,
				"place.patched.rbxl": "patched",
			},
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		expect(run.code).toBe(0);
		expect(run.spawned[0]).toEqual(["lune", "--version"]);
		expect(run.spawned[1]![1]).toBe("run");
		expect(run.launched[0]![1]!.replaceAll("\\", "/")).toEndWith("/place.patched.rbxl");
		expect(run.out).toContain("connected: place.patched.rbxl");
		expect(run.closedWindows).toEqual(["place.patched.rbxl - Roblox Studio"]);

		const noLune = await runCli(["test", "place.rbxl", "--original", "original.rbxl"], {
			files: { "place.rbxl": "built", "original.rbxl": "orig", "default.project.json": PROJECT },
			spawnCode: 1,
		});
		expect(noLune.code).toBe(1);
		expect(noLune.err).toContain("lune is needed");
		expect(noLune.launched).toHaveLength(0);
	});

	test("without Studio installed it says so and points at the cloud; a window that never connects is reported", async () => {
		const missing = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studioExe: undefined,
		});
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("RobloxStudioBeta.exe was not found");
		expect(missing.err).toContain("flamework-test test <file> --cloud");

		const silent = await runCli(["test", "place.rbxl"], {
			files: { "place.rbxl": "built" },
			studio: { studios: [OTHER_STUDIO] },
		});
		expect(silent.code).toBe(1);
		expect(silent.launched).toHaveLength(1);
		expect(silent.err).toContain("place.rbxl never showed up");
	});

	test("a missing build is caught before Studio is touched", async () => {
		const run = await runCli(["test", "place.rbxl"]);
		expect(run.code).toBe(1);
		expect(run.err).toContain("place.rbxl does not exist");
		expect(run.launched).toHaveLength(0);
		expect(run.studioCalls).toHaveLength(0);
	});

	test("--cloud is the cloud test, with its own flags", async () => {
		const run = await runCli(["test", "dist/place.rbxl", "--cloud", "--sections", "economy"], {
			files: { "dist/place.rbxl": "x" },
			responses: [json({ versionNumber: 4 }), ...happyPath([resultJson()])],
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain("published version 4");
		expect(run.out).toContain("2 passed, 0 failed");
		expect(run.launched).toHaveLength(0);
		expect(run.calls).toHaveLength(4);

		const published = await runCli(["test", "dist/place.rbxl", "--published"], {
			files: { "dist/place.rbxl": "x" },
		});
		expect(published.code).toBe(2);
		expect(published.err).toContain("--published is for the cloud");
	});

	test("a cloud run checks for testing.entry before publishing, when the config file was found", async () => {
		const run = await runCli(["cloud", "test", "dist/place.rbxl"], {
			files: { "dist/place.rbxl": "x" },
			settings: { configPath: "/game/flamework.config.json" },
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain('a cloud run needs "testing": { "entry": "src/server/main" }');
		expect(run.err).toContain("Studio needs no entry");
		expect(run.calls).toHaveLength(0);

		const withEntry = await runCli(["cloud", "test", "dist/place.rbxl"], {
			files: { "dist/place.rbxl": "x" },
			settings: { configPath: "/game/flamework.config.json", testingEntry: "src/server/main" },
			responses: [json({ versionNumber: 4 }), ...happyPath([resultJson()])],
		});
		expect(withEntry.code).toBe(0);

		// A raw script ignites nothing, so it needs no entry.
		const raw = await runCli(["cloud", "run", "--code", "return 1"], {
			settings: { configPath: "/game/flamework.config.json" },
			responses: happyPath(["1"]),
		});
		expect(raw.code).toBe(0);
	});

	test("the local test and the studio run find the testing place the same way", async () => {
		// `studio run` still drives the cloud place's window, found by its place id.
		const run = await runCli(["studio", "run", "--realm", "both"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					get_studio_state: PLAYING,
					execute_luau: (args) =>
						JSON.stringify(resultJson({ realm: (args.datamodel_type as string).toLowerCase() })),
				},
			},
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain(`running the server's tests in TestingExperience`);
		expect(run.out).toContain(`running the client's tests in TestingExperience`);
		expect(run.studioCalls.filter((call) => call.name === "execute_luau")).toHaveLength(2);
		expect(run.out).not.toContain(PLACE);
	});
	test("names the last test that reported when a realm's run does not answer in time", async () => {
		const studio = studioThatOpens(BUILT_STUDIO, { Server: JSON.stringify(resultJson()), Client: "" });
		const answers = studio.fake.answers as Record<string, unknown>;
		answers.execute_luau = (args: Record<string, unknown>) => {
			if (args.datamodel_type === "Client") throw new Error("execute_luau timed out after 1000ms");
			return JSON.stringify(resultJson());
		};
		answers.get_console_output = () =>
			[
				"[FWTEST] client economy/buys: PASS (2ms)",
				"[FWTEST] client economy/sells: PASS (1ms)",
				"[FWTEST] server economy/later: PASS (1ms)",
			].join("\n");

		const run = await runCli(["test", "place.rbxl", "--timeout", "1s"], {
			files: { "place.rbxl": "built" },
			studio: studio.fake,
			onLaunch: studio.onLaunch,
		});

		// Every test times itself out, so a realm that never answers is placed by the last test
		// that reported in Studio's output; the server's result still prints, and the session is
		// still stopped and the window closed.
		expect(run.code).toBe(1);
		expect(run.err).toContain("the client's run did not finish within 1s");
		expect(run.err).toContain("last test that reported: economy/sells (PASS)");
		expect(run.out).toContain("play session stopped");
	});
});
