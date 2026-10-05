import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseArgs } from "../src/cli.ts";
import { SNIPPET_SANDBOX_HINT } from "../src/studio.ts";
import {
	FAKE_TOOLS,
	FIXTURE_CWD,
	OTHER_STUDIO,
	TESTING_STUDIO,
	fakeMachine,
	fromFlat,
	runCli,
	type FakeMachine,
	type FakeStudio,
} from "./harness.ts";

const THIS_PROJECT = resolve(FIXTURE_CWD);
const OWN = { id: "own-1", name: "place.rbxl" };
/** What `screen_capture` answers is a JPEG (`image/jpeg`, measured 2026-10-05). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** What Studio raised for a `require` in a sandboxed snippet, and what it raises for one of something that is not a ModuleScript. */
const REFUSED_REQUIRE =
	"AssistantCommand:1: The current thread cannot call 'require' (lacking capability LoadUnownedAsset)";
const BAD_REQUIRE = "AssistantCommand:1: Attempted to call require with invalid argument(s).";

/** A machine where this project's flamework-test has `place.rbxl` open in Studio PID 4001 as `own-1`. */
function withOwnWindow(): FakeMachine {
	const machine = fakeMachine();
	const now = machine.time.now;
	const file = join(THIS_PROJECT, "place.rbxl");
	machine.windows.push({ pid: 4001, title: `${file} - Roblox Studio`, startedWith: file, startedAt: now });
	const owner = fromFlat({
		token: "own-token",
		cliPid: 8001,
		cliName: "bun",
		cliStartedAt: new Date(now).toISOString(),
		studioPid: 4001,
		studioStartedAt: new Date(now).toISOString(),
		mcpId: "own-1",
		project: THIS_PROJECT,
		command: "studio open",
		place: file,
		placeFile: file,
		since: new Date(now).toISOString(),
		lastActivity: new Date(now).toISOString(),
		expires: new Date(now + 15 * 60_000).toISOString(),
		holdMinutes: 15,
		kept: true,
	});
	machine.lock.owner = owner;
	return machine;
}

function studio(answers: FakeStudio["answers"] = {}): FakeStudio {
	return { studios: [OTHER_STUDIO, OWN, TESTING_STUDIO], answers };
}

describe("parsing the tool commands", () => {
	test("studio tools takes a tool's name, studio call a name and one JSON object", () => {
		expect(parseArgs(["studio", "tools"])).toEqual({ command: "studio tools", flags: {} });
		expect(parseArgs(["studio", "tools", "execute_luau", "--json"])).toEqual({
			command: "studio tools",
			flags: { tool: "execute_luau", json: true },
		});
		expect(() => parseArgs(["studio", "tools", "a", "b"])).toThrow("unexpected argument: b");
		expect(parseArgs(["studio", "call", "execute_luau", '{"code":"return 1"}', "--studio", "own-1"])).toEqual({
			command: "studio call",
			flags: { tool: "execute_luau", arguments: '{"code":"return 1"}', studio: "own-1" },
		});
		expect(() => parseArgs(["studio", "call", "execute_luau", "{", "}"])).toThrow(
			"unexpected argument: }; the tool's arguments are one JSON object",
		);
		expect(() => parseArgs(["studio", "call", "x", "--force"])).toThrow('--force is not a flag of "studio call"');
		expect(parseArgs(["studio", "unlock", "--force"]).flags.force).toBe(true);
	});

	test("a call without a tool is bad usage, and studio call <tool> --help describes the tool", async () => {
		const none = await runCli(["studio", "call"]);
		expect(none.code).toBe(2);
		expect(none.err).toContain("studio call needs the tool's name");

		const help = await runCli(["studio", "call", "execute_luau", "--help"], { studio: studio() });
		expect(help.code).toBe(0);
		expect(help.out).toContain("execute_luau\n\nExecutes Luau code in Roblox Studio.");
		expect(help.out).toContain('"datamodel_type"');
		expect(help.studioCalls).toEqual([]);
	});
});

describe("studio tools", () => {
	test("lists the tools the proxy offers, by name and the first line of each description", async () => {
		const run = await runCli(["studio", "tools"], { studio: studio() });
		expect(run.code).toBe(0);
		const lines = run.out.split("\n");
		expect(lines[0]).toBe(
			"list_roblox_studios  Lists the connected Roblox Studio instances so a call can be directed at one.",
		);
		expect(lines).toContain("execute_luau         Executes Luau code in Roblox Studio.");
		expect(run.out).toContain("`flamework-test studio tools <name>` prints one tool's description and arguments");
		// Read live: whatever the proxy says today.
		const changed = await runCli(["studio", "tools"], {
			studio: { tools: [{ name: "new_tool", description: "Does something new." }] },
		});
		expect(changed.out.split("\n")[0]).toBe("new_tool  Does something new.");

		const json = await runCli(["studio", "tools", "--json"], { studio: studio() });
		expect(JSON.parse(json.out)).toEqual(FAKE_TOOLS);
	});

	test("with a name, that tool's whole description and its arguments, and an unknown name lists the others", async () => {
		const run = await runCli(["studio", "tools", "screen_capture"], { studio: studio() });
		expect(run.code).toBe(0);
		expect(run.out).toContain("screen_capture\n\nCapture current edit-time screen, return the image data.");
		expect(run.out).toContain("arguments (JSON schema):");
		expect(run.out).toContain('"capture_id"');
		expect(run.out).toContain("studio_id is filled in from --studio <id>");
		const plain = await runCli(["studio", "tools", "list_roblox_studios"], { studio: studio() });
		expect(plain.out).not.toContain("studio_id is filled in");
		const json = await runCli(["studio", "tools", "screen_capture", "--json"], { studio: studio() });
		expect(JSON.parse(json.out)).toEqual(FAKE_TOOLS[3]);

		const unknown = await runCli(["studio", "tools", "fly"], { studio: studio() });
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain('error: the MCP proxy has no tool named "fly"');
		expect(unknown.err).toContain("it has: list_roblox_studios, execute_luau, get_studio_state, screen_capture");
	});
});

describe("studio call", () => {
	test("fills in studio_id from --studio, prints the text, and --json prints the raw answer", async () => {
		const machine = withOwnWindow();
		const run = await runCli(["studio", "call", "get_studio_state", "--studio", "own-1"], {
			machine,
			studio: studio({ get_studio_state: "- Current Studio Mode: Edit" }),
		});
		expect(run.code).toBe(0);
		expect(run.studioCalls).toEqual([{ name: "get_studio_state", args: { studio_id: "own-1" } }]);
		expect(run.out).toBe("- Current Studio Mode: Edit");

		// No --studio: this project's window.
		const json = await runCli(
			["studio", "call", "execute_luau", '{"code":"return 1","datamodel_type":"Edit"}', "--json"],
			{
				machine,
				studio: studio({ execute_luau: { content: [{ type: "text", text: "1" }], structured: true } }),
			},
		);
		expect(json.code).toBe(0);
		expect(json.studioCalls[0]!.args).toEqual({ code: "return 1", datamodel_type: "Edit", studio_id: "own-1" });
		expect(JSON.parse(json.out)).toEqual({ content: [{ type: "text", text: "1" }], structured: true });
	});

	test("writes an image answer to a file, printing its path, under --out or the temp folder", async () => {
		const machine = withOwnWindow();
		const answer = {
			content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" },
				{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
			],
		};
		const out = await runCli(
			["studio", "call", "screen_capture", '{"capture_id":"ScreenCapture_1"}', "--out", "shots"],
			{
				machine,
				studio: studio({ screen_capture: answer }),
			},
		);
		expect(out.code).toBe(0);
		const [text, path, second] = out.out.split("\n");
		expect(text).toBe("captured");
		expect(path!.replaceAll("\\", "/")).toStartWith(`${THIS_PROJECT.replaceAll("\\", "/")}/shots/screen_capture-`);
		// Named by the type the tool gives: a JPEG is a .jpg.
		expect(path).toEndWith("-1.jpg");
		expect([...out.binaries[path!.replaceAll("\\", "/")]!]).toEqual([...JPEG]);
		expect(second).toEndWith("-2.png");

		const temp = await runCli(["studio", "call", "screen_capture", '{"capture_id":"ScreenCapture_1"}'], {
			machine,
			studio: studio({ screen_capture: answer }),
		});
		const written = temp.out.split("\n")[1]!.replaceAll("\\", "/");
		expect(written).toStartWith(`${join(tmpdir(), "flamework-test", "captures").replaceAll("\\", "/")}/`);
	});

	test("a tool's error exits 1 with its message, without the Assistant's own locations; a sandbox refusal is explained", async () => {
		const machine = withOwnWindow();
		const failing = (text: string) =>
			studio({ execute_luau: { content: [{ type: "text", text }], isError: true } });
		const run = await runCli(["studio", "call", "execute_luau", '{"code":"error(1)","datamodel_type":"Edit"}'], {
			machine,
			studio: failing(
				"sabuiltin_Assistant.rbxm.Assistant.Tools.ExecuteLuauTool:66: AssistantCommand:1: the snippet failed",
			),
		});
		expect(run.code).toBe(1);
		expect(run.err).toBe("error: execute_luau failed: the snippet failed");

		// The hint only under a refusal of the sandbox's: Studio need not run MCP code sandboxed, and
		// an error that only names require is no such refusal.
		const sandboxed = await runCli(
			["studio", "call", "execute_luau", '{"code":"return require(x)","datamodel_type":"Edit"}'],
			{ machine, studio: failing(REFUSED_REQUIRE) },
		);
		expect(sandboxed.err).toBe(
			`error: execute_luau failed: The current thread cannot call 'require' (lacking capability LoadUnownedAsset)\n${SNIPPET_SANDBOX_HINT}`,
		);
		const notSandboxed = await runCli(
			["studio", "call", "execute_luau", '{"code":"return require(workspace)","datamodel_type":"Edit"}'],
			{ machine, studio: failing(BAD_REQUIRE) },
		);
		expect(notSandboxed.err).toBe(
			"error: execute_luau failed: Attempted to call require with invalid argument(s).",
		);
		// studio exec says the same.
		const exec = await runCli(["studio", "exec", "--code", "return require(x)"], {
			machine,
			studio: studio({
				execute_luau: () => {
					throw new Error(`execute_luau: ${REFUSED_REQUIRE}`);
				},
			}),
		});
		expect(exec.err).toContain(SNIPPET_SANDBOX_HINT);
		const execPlain = await runCli(["studio", "exec", "--code", "return require(workspace)"], {
			machine,
			studio: studio({
				execute_luau: () => {
					throw new Error(`execute_luau: ${BAD_REQUIRE}`);
				},
			}),
		});
		expect(execPlain.err).toBe(
			"error: the Luau failed in Edit: Attempted to call require with invalid argument(s).",
		);

		// The raw answer under --json, and still a failure.
		const json = await runCli(["studio", "call", "execute_luau", "--json"], { machine, studio: failing("bad") });
		expect(json.code).toBe(1);
		expect(JSON.parse(json.out).isError).toBe(true);

		// The proxy failing outright.
		const broken = await runCli(["studio", "call", "get_studio_state"], {
			machine,
			studio: studio({
				get_studio_state: () => {
					throw new Error("get_studio_state: Unable to reach Roblox Studio");
				},
			}),
		});
		expect(broken.code).toBe(1);
		expect(broken.err).toContain("error: get_studio_state failed: Unable to reach Roblox Studio");
	});

	test("a tool that takes no window is called as it is, with no window to refuse", async () => {
		const run = await runCli(["studio", "call", "list_roblox_studios"], {
			studio: studio({ list_roblox_studios: '{"studios":[]}' }),
		});
		expect(run.code).toBe(0);
		expect(run.studioCalls).toEqual([{ name: "list_roblox_studios", args: {} }]);
		expect(run.out).toBe('{"studios":[]}');
	});

	test("arguments come from a file too, once; JSON that does not parse points at --args-file", async () => {
		const machine = withOwnWindow();
		const fromFile = await runCli(["studio", "call", "execute_luau", "--args-file", "args.json"], {
			machine,
			files: { "args.json": '{ "code": "return \\"hi\\"", "datamodel_type": "Edit" }' },
			studio: studio({ execute_luau: "hi" }),
		});
		expect(fromFile.code).toBe(0);
		expect(fromFile.studioCalls[0]!.args).toEqual({
			code: 'return "hi"',
			datamodel_type: "Edit",
			studio_id: "own-1",
		});

		const twice = await runCli(["studio", "call", "execute_luau", "{}", "--args-file", "args.json"], {
			files: { "args.json": "{}" },
		});
		expect(twice.code).toBe(2);
		expect(twice.err).toContain("the tool's arguments were given twice");

		// What Windows PowerShell leaves of '{"code":"return 1"}' on a native command line.
		const stripped = await runCli(["studio", "call", "execute_luau", "{code:return 1}"], { studio: studio() });
		expect(stripped.code).toBe(2);
		expect(stripped.err).toContain("the arguments must be a JSON object, and did not parse");
		expect(stripped.err).toContain("put the JSON in a file and pass --args-file <file>");

		const list = await runCli(["studio", "call", "execute_luau", "[1]"], { studio: studio() });
		expect(list.code).toBe(2);
		expect(list.err).toContain('the arguments must be a JSON object, like {"code": "return 1"}');

		const clash = await runCli(["studio", "call", "get_studio_state", '{"studio_id":"a"}', "--studio", "b"], {
			studio: studio(),
		});
		expect(clash.code).toBe(2);
		expect(clash.err).toContain('studio_id is given twice, and differently: --studio b and "studio_id": "a"');
	});

	test("a studio_id in the arguments is the window, and is refused like --studio when it is not this project's", async () => {
		const run = await runCli(["studio", "call", "get_studio_state", '{"studio_id":"studio-2"}'], {
			studio: studio({ get_studio_state: "x" }),
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain(
			'refusing to call get_studio_state in the Studio window "Other Place  (placeId: 123456789012345)" (studio-2)',
		);
		expect(run.studioCalls).toEqual([]);

		const allowed = await runCli(
			["studio", "call", "get_studio_state", '{"studio_id":"studio-2"}', "--any-window"],
			{
				studio: studio({ get_studio_state: "x" }),
			},
		);
		expect(allowed.code).toBe(0);
		expect(allowed.studioCalls[0]!.args.studio_id).toBe("studio-2");
	});
});

describe("studio list", () => {
	test("names every window on the proxy, which flamework-test opened and for which project, under the lock", async () => {
		const machine = withOwnWindow();
		const run = await runCli(["studio", "list"], { machine, studio: studio() });
		expect(run.code).toBe(0);
		const lines = run.out.split("\n");
		expect(lines[0]).toStartWith(`Studio lock: held by flamework-test for ${THIS_PROJECT} (studio open on `);
		expect(lines).toContain(
			"studio-2  Other Place  (placeId: 123456789012345)  [not opened by flamework-test for any project (the user's, an older flamework-test's, or opened by hand)]",
		);
		expect(lines).toContain(
			"own-1  place.rbxl  [opened by flamework-test for this project; holds the Studio lock]",
		);

		// Another project's window, as that project sees it, and as JSON.
		const json = await runCli(["studio", "list", "--json"], { machine, cwd: "D:\\other", studio: studio() });
		const parsed = JSON.parse(json.out);
		expect(parsed.lock).toMatchObject({
			project: THIS_PROJECT,
			windows: [{ studio_id: "own-1", studioPid: 4001 }],
		});
		expect(parsed.studios).toContainEqual({
			studio_id: "own-1",
			name: "place.rbxl",
			openedByFlameworkTest: true,
			project: THIS_PROJECT,
			thisProject: false,
			holdsLock: true,
		});
		expect(parsed.studios).toContainEqual({
			studio_id: "studio-1",
			name: TESTING_STUDIO.name,
			openedByFlameworkTest: false,
			project: null,
			thisProject: false,
			holdsLock: false,
		});
		expect(parsed.studioProcesses).toEqual([
			{ pid: 4001, title: expect.stringContaining("place.rbxl - Roblox Studio") },
		]);

		const free = await runCli(["studio", "list"], { studio: { studios: [TESTING_STUDIO] } });
		expect(free.out.split("\n")[0]).toBe("Studio lock: free");
	});
});

describe("studio call of a tool whose arguments have no studio_id (V2)", () => {
	const tools = [
		...FAKE_TOOLS,
		{ name: "act_on_window", description: "acts on a window", inputSchema: { type: "object", properties: {} } },
	];
	const answers = { act_on_window: "acted", list_roblox_studios: '{"studios":[]}', get_studio_state: "x" };

	test("a studio_id of the user's window in its arguments is refused like --studio, and nothing is sent (V2a)", async () => {
		const run = await runCli(["studio", "call", "act_on_window", '{"studio_id":"studio-2"}'], {
			studio: { ...studio(answers), tools },
		});
		expect(run.code).toBe(1);
		expect(run.studioCalls).toEqual([]);
		expect(run.err).toContain(
			'refusing to call act_on_window in the Studio window "Other Place  (placeId: 123456789012345)" (studio-2): flamework-test did not open it for this project',
		);
		// Not silently: the tool's arguments list no studio_id, and the CLI says it sends one anyway.
		expect(run.err).toContain("note: act_on_window lists no studio_id argument");
	});

	test("with no window named, a tool not known to act on none is refused unless --any-window (V2b)", async () => {
		const run = await runCli(["studio", "call", "act_on_window"], { studio: { ...studio(answers), tools } });
		expect(run.code).toBe(1);
		expect(run.studioCalls).toEqual([]);
		expect(run.err).toContain(
			"error: refusing to call act_on_window: it takes no studio_id (`flamework-test studio tools act_on_window` shows its arguments), so which Studio window it acts on cannot be told, and it may be a window the user has open",
		);
		expect(run.err).toContain("pass --any-window to call it anyway, but only once the user has said so");

		const allowed = await runCli(["studio", "call", "act_on_window", "--any-window"], {
			studio: { ...studio(answers), tools },
		});
		expect(allowed.code).toBe(0);
		expect(allowed.studioCalls).toEqual([{ name: "act_on_window", args: {} }]);
	});

	test("--studio with a windowless tool is not ignored: the window is found and refused as any other", async () => {
		const refused = await runCli(["studio", "call", "list_roblox_studios", "--studio", "studio-2"], {
			studio: studio(answers),
		});
		expect(refused.code).toBe(1);
		expect(refused.studioCalls).toEqual([]);
		expect(refused.err).toContain("refusing to call list_roblox_studios in the Studio window");

		const machine = withOwnWindow();
		const own = await runCli(["studio", "call", "list_roblox_studios", "--studio", "own-1"], {
			machine,
			studio: studio(answers),
		});
		expect(own.code).toBe(0);
		expect(own.studioCalls).toEqual([{ name: "list_roblox_studios", args: { studio_id: "own-1" } }]);
		expect(own.err).toContain("note: list_roblox_studios lists no studio_id argument");
	});

	test("list_roblox_studios from a proxy still joining the hub is tried again, as listing the windows is", async () => {
		let tries = 0;
		const joining = await runCli(["studio", "call", "list_roblox_studios"], {
			studio: studio({
				list_roblox_studios: () => {
					tries += 1;
					if (tries < 4) throw new Error("list_roblox_studios: not connected to the hub yet");
					return '{"studios":[]}';
				},
			}),
		});
		expect(joining.code).toBe(0);
		expect(tries).toBe(4);
		expect(joining.out).toBe('{"studios":[]}');

		let failures = 0;
		const never = await runCli(["studio", "call", "list_roblox_studios"], {
			studio: studio({
				list_roblox_studios: () => {
					failures += 1;
					return { content: [{ type: "text", text: "no hub" }], isError: true };
				},
			}),
		});
		expect(never.code).toBe(1);
		expect(failures).toBe(20);
		expect(never.err).toBe("error: list_roblox_studios failed: no hub");

		// A tool that acts on a window is not tried again: it may have done something the first time.
		let calls = 0;
		const once = await runCli(["studio", "call", "get_studio_state"], {
			machine: withOwnWindow(),
			studio: studio({
				get_studio_state: () => {
					calls += 1;
					throw new Error("get_studio_state: busy");
				},
			}),
		});
		expect(once.code).toBe(1);
		expect(calls).toBe(1);
	});

	test("a JSON-RPC error is stripped of the tool's name and the Assistant's locations too", async () => {
		const run = await runCli(["studio", "call", "execute_luau", '{"code":"error(1)","datamodel_type":"Edit"}'], {
			machine: withOwnWindow(),
			studio: studio({
				execute_luau: () => {
					throw new Error(
						"execute_luau: sabuiltin_Assistant.rbxm.Assistant.Tools.ExecuteLuauTool:66: AssistantCommand:1: the snippet failed",
					);
				},
			}),
		});
		expect(run.code).toBe(1);
		expect(run.err).toBe("error: execute_luau failed: the snippet failed");

		const sandboxed = await runCli(
			["studio", "call", "execute_luau", '{"code":"return require(x)","datamodel_type":"Edit"}'],
			{
				machine: withOwnWindow(),
				studio: studio({
					execute_luau: () => {
						throw new Error(`execute_luau: ${REFUSED_REQUIRE}`);
					},
				}),
			},
		);
		expect(sandboxed.err).toContain(SNIPPET_SANDBOX_HINT);
	});
});
