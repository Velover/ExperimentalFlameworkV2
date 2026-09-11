import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/cli.ts";
import {
	findStudio,
	findStudioForPlace,
	isLocalFileWindow,
	isPlaying,
	placeNameOf,
	renderStudioRun,
	studioOpenArguments,
	unquoteLuauResult,
} from "../src/studio.ts";
import { OTHER_STUDIO, PLACE, TESTING_STUDIO, UNIVERSE, resultJson, runCli } from "./harness.ts";
import type { StudioEntry } from "../src/studio.ts";

/** What the proxy lists for a window that has a local place file open: the file name, no place id. */
const LOCAL_STUDIO: StudioEntry = { id: "studio-3", name: "place.patched.rbxl" };

const PLAYING = "- Current Studio Mode: Play\n- Available DataModels: Client, Server";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit";

describe("studio helpers", () => {
	test("the window is found by the place id in its name, and the place name is what is left", () => {
		expect(findStudioForPlace([OTHER_STUDIO, TESTING_STUDIO], PLACE)).toBe(TESTING_STUDIO);
		expect(findStudioForPlace([OTHER_STUDIO], PLACE)).toBeUndefined();
		// A place id that is a prefix of another must not match it.
		expect(findStudioForPlace([{ id: "x", name: "Other (placeId: 1089731514552860)" }], PLACE)).toBeUndefined();
		expect(placeNameOf(TESTING_STUDIO.name)).toBe("TestingExperience");
		expect(placeNameOf(OTHER_STUDIO.name)).toBe("Dive In");
	});

	test("a local file's window is told apart, and findStudio prefers a target, then the place, then a lone local file", () => {
		expect(isLocalFileWindow(LOCAL_STUDIO)).toBe(true);
		expect(isLocalFileWindow(TESTING_STUDIO)).toBe(false);

		const all = [OTHER_STUDIO, TESTING_STUDIO, LOCAL_STUDIO];
		expect(findStudio(all, PLACE)).toBe(TESTING_STUDIO);
		expect(findStudio(all, PLACE, "studio-3")).toBe(LOCAL_STUDIO);
		expect(findStudio(all, PLACE, "Dive In")).toBe(OTHER_STUDIO);
		expect(findStudio([OTHER_STUDIO, LOCAL_STUDIO], PLACE)).toBe(LOCAL_STUDIO);
		expect(findStudio([OTHER_STUDIO, LOCAL_STUDIO, { id: "x", name: "other.rbxl" }], PLACE)).toBeUndefined();
		expect(findStudio([OTHER_STUDIO], PLACE)).toBeUndefined();
	});

	test("the state answer says whether a session is playing", () => {
		expect(isPlaying(PLAYING)).toBe(true);
		expect(isPlaying(EDITING)).toBe(false);
	});

	test("open arguments name the cloud place or the file", () => {
		expect(studioOpenArguments({ placeId: "2", universeId: "1" })).toEqual([
			"-task",
			"EditPlace",
			"-placeId",
			"2",
			"-universeId",
			"1",
		]);
		expect(studioOpenArguments({ file: "C:/x/place.rbxl" })).toEqual(["C:/x/place.rbxl"]);
	});

	test("the run snippet invokes the host with the filter and hands JSON back", () => {
		const code = renderStudioRun('"economy"', "{ list = true }");
		expect(code).toContain('WaitForChild("FlameworkTests", 30)');
		expect(code).toContain('host:Invoke("economy", { list = true })');
		expect(code).toContain("JSONEncode");
	});

	test("a quoted answer from the proxy is unwrapped", () => {
		expect(unquoteLuauResult('"{\\"ok\\":true}"')).toBe('{"ok":true}');
		expect(unquoteLuauResult("2")).toBe("2");
	});
});

describe("studio commands", () => {
	test("open launches Studio on the testing place and waits for the proxy to list it", async () => {
		const unlisted = await runCli(["studio", "open"], { studio: { studios: [OTHER_STUDIO] } });
		expect(unlisted.code).toBe(1);
		expect(unlisted.launched[0]).toEqual([
			"C:/Roblox/RobloxStudioBeta.exe",
			"-task",
			"EditPlace",
			"-placeId",
			PLACE,
			"-universeId",
			UNIVERSE,
		]);
		expect(unlisted.err).toContain("never showed up");
		expect(unlisted.err).toContain("MCP server");

		const connected = await runCli(["studio", "open"], { studio: { studios: [OTHER_STUDIO, TESTING_STUDIO] } });
		expect(connected.code).toBe(0);
		expect(connected.out).toContain("connected: TestingExperience");
	});

	test("open with a file opens that file and waits for a window named after it", async () => {
		const run = await runCli(["studio", "open", "place.patched.rbxl"], {
			files: { "place.patched.rbxl": "x" },
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO] },
		});
		expect(run.code).toBe(0);
		expect(run.launched[0]![1]!.replaceAll("\\", "/")).toEndWith("place.patched.rbxl");
		expect(run.out).toContain("connected: place.patched.rbxl");

		const unlisted = await runCli(["studio", "open", "place.patched.rbxl"], {
			files: { "place.patched.rbxl": "x" },
			studio: { studios: [OTHER_STUDIO] },
		});
		expect(unlisted.code).toBe(1);
		expect(unlisted.err).toContain("place.patched.rbxl never showed up");
	});

	test("with no testing-place window, the only local-file window is used, and --studio names any window", async () => {
		const local = await runCli(["studio", "status"], {
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(local.code).toBe(0);
		expect(local.studioCalls[0]!.args.studio_id).toBe("studio-3");

		const named = await runCli(["studio", "status", "--studio", "Dive In"], {
			studio: { studios: [OTHER_STUDIO, TESTING_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(named.studioCalls[0]!.args.studio_id).toBe("studio-2");

		const missing = await runCli(["studio", "status", "--studio", "Nope"], {
			studio: { studios: [OTHER_STUDIO] },
		});
		expect(missing.code).toBe(1);
		expect(missing.err).toContain('no Studio window is named "Nope"');
		expect(missing.err).toContain("Dive In");
	});

	test("open without Studio installed says so", async () => {
		const run = await runCli(["studio", "open"], { studioExe: undefined });
		expect(run.code).toBe(1);
		expect(run.err).toContain("RobloxStudioBeta.exe was not found");
	});

	test("commands find the window by the testing place id, and say when there is none", async () => {
		const status = await runCli(["studio", "status"], {
			studio: { studios: [OTHER_STUDIO, TESTING_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(status.code).toBe(0);
		expect(status.out).toContain("TestingExperience");
		expect(status.out).toContain("Current Studio Mode: Edit");
		expect(status.studioCalls[0]).toEqual({ name: "get_studio_state", args: { studio_id: "studio-1" } });

		const none = await runCli(["studio", "status"], { studio: { studios: [OTHER_STUDIO] } });
		expect(none.code).toBe(1);
		expect(none.err).toContain(`no Studio window has the testing place ${PLACE} open`);
		expect(none.err).toContain("MCP server");
	});

	test("play and stop drive the session, and close shuts the window by its place name", async () => {
		const play = await runCli(["studio", "play"], {
			studio: { studios: [TESTING_STUDIO], answers: { start_stop_play: "Game Started" } },
		});
		expect(play.code).toBe(0);
		expect(play.studioCalls[0]).toEqual({
			name: "start_stop_play",
			args: { studio_id: "studio-1", is_start: true },
		});

		const stop = await runCli(["studio", "stop"], {
			studio: { studios: [TESTING_STUDIO], answers: { start_stop_play: "Game Stopped" } },
		});
		expect(stop.studioCalls[0]!.args.is_start).toBe(false);

		const close = await runCli(["studio", "close"], { studio: { studios: [TESTING_STUDIO] } });
		expect(close.code).toBe(0);
		expect(close.closedWindows).toEqual(["TestingExperience - Roblox Studio"]);
		expect(close.out).toContain("closed TestingExperience");

		const gone = await runCli(["studio", "close"], { studio: { studios: [TESTING_STUDIO] }, closeOutcome: "none" });
		expect(gone.code).toBe(1);
	});

	test("exec runs Luau in the chosen data model", async () => {
		const run = await runCli(["studio", "exec", "--code", "return 1 + 1", "--realm", "server"], {
			studio: { studios: [TESTING_STUDIO], answers: { execute_luau: "2" } },
		});
		expect(run.code).toBe(0);
		expect(run.out).toBe("2");
		expect(run.studioCalls[0]).toEqual({
			name: "execute_luau",
			args: { studio_id: "studio-1", datamodel_type: "Server", code: "return 1 + 1" },
		});

		const nothing = await runCli(["studio", "exec"], { studio: { studios: [TESTING_STUDIO] } });
		expect(nothing.code).toBe(2);
	});

	test("run starts a play session when there is none, runs the tests, prints the summary and stops it", async () => {
		let mode = "Edit";
		const run = await runCli(["studio", "run", "--sections", "economy"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
					start_stop_play: (args) => {
						mode = args.is_start ? "Play" : "Edit";
						return args.is_start ? "Game Started" : "Game Stopped";
					},
					// The proxy hands a returned string back quoted.
					execute_luau: () => JSON.stringify(resultJson()),
				},
			},
		});

		expect(run.code).toBe(0);
		expect(run.studioCalls.map((call) => call.name)).toEqual([
			"get_studio_state",
			"start_stop_play",
			"get_studio_state",
			"execute_luau",
			"start_stop_play",
		]);
		const exec = run.studioCalls[3]!.args;
		expect(exec.datamodel_type).toBe("Server");
		expect(exec.code).toContain('host:Invoke("economy", nil)');
		expect(run.out).toContain("2 passed, 0 failed");
		expect(run.out).toContain("play session stopped");
		expect(run.studioCalls[4]!.args.is_start).toBe(false);
	});

	test("run leaves a session it found running, and --keep leaves one it started", async () => {
		const found = await runCli(["studio", "run", "--realm", "client"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: { get_studio_state: PLAYING, execute_luau: JSON.stringify(resultJson({ realm: "client" })) },
			},
		});
		expect(found.code).toBe(0);
		expect(found.studioCalls.map((call) => call.name)).toEqual(["get_studio_state", "execute_luau"]);
		expect(found.studioCalls[1]!.args.datamodel_type).toBe("Client");

		let mode = "Edit";
		const kept = await runCli(["studio", "run", "--keep"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					get_studio_state: () => (mode === "Play" ? PLAYING : EDITING),
					start_stop_play: (args) => {
						mode = args.is_start ? "Play" : "Edit";
						return "ok";
					},
					execute_luau: JSON.stringify(resultJson()),
				},
			},
		});
		expect(kept.code).toBe(0);
		expect(kept.studioCalls.filter((call) => call.name === "start_stop_play")).toHaveLength(1);
	});

	test("run reports a failing suite with exit 1, and --realm edit is refused", async () => {
		const run = await runCli(["studio", "run"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					get_studio_state: PLAYING,
					execute_luau: JSON.stringify(
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
				},
			},
		});
		expect(run.code).toBe(1);
		expect(run.out).toContain("the shop was empty");

		const edit = await runCli(["studio", "run", "--realm", "edit"], { studio: { studios: [TESTING_STUDIO] } });
		expect(edit.code).toBe(2);
	});

	test("studio needs a subcommand, an unknown one is refused, and flags are per command", () => {
		expect(() => parseArgs(["studio"])).toThrow(/needs a subcommand/);
		expect(() => parseArgs(["studio", "fly"])).toThrow(/unknown command: studio fly/);
		expect(parseArgs(["studio", "open", "x.rbxl"])).toEqual({ command: "studio open", flags: { file: "x.rbxl" } });
		expect(() => parseArgs(["studio", "run", "x.rbxl"])).toThrow(/unexpected argument/);
		expect(() => parseArgs(["studio", "run", "--original", "o.rbxl"])).toThrow(/not a flag/);
		expect(parseArgs(["patch", "p.rbxl", "--original", "o.rbxl", "--out", "t.rbxl"]).flags).toEqual({
			file: "p.rbxl",
			original: "o.rbxl",
			out: "t.rbxl",
		});
	});
});
