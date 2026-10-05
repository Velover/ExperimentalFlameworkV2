import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { parseArgs } from "../src/cli.ts";
import {
	claimWindowName,
	closeWindowScript,
	connectStudio,
	findStudio,
	findStudioForPlace,
	isLocalFileWindow,
	isPlaying,
	isSandboxRefusal,
	parseClosedWindows,
	luauErrorMessage,
	placeNameOf,
	PROXY_CLOSE_GRACE_MS,
	renderStudioRun,
	runCloseScript,
	SANDBOX_HINT,
	studioOpenArguments,
	toolErrorMessage,
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
		expect(placeNameOf(OTHER_STUDIO.name)).toBe("Other Place");
	});

	test("a local file's window is told apart, and findStudio prefers a target, then the place, then a lone local file", () => {
		expect(isLocalFileWindow(LOCAL_STUDIO)).toBe(true);
		expect(isLocalFileWindow(TESTING_STUDIO)).toBe(false);

		const all = [OTHER_STUDIO, TESTING_STUDIO, LOCAL_STUDIO];
		expect(findStudio(all, PLACE)).toBe(TESTING_STUDIO);
		expect(findStudio(all, PLACE, "studio-3")).toBe(LOCAL_STUDIO);
		expect(findStudio(all, PLACE, "Other Place")).toBe(OTHER_STUDIO);
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

	test("the run snippet marks the host Sandboxed before invoking it, and uses nothing a sandboxed thread lacks", () => {
		const lines = renderStudioRun("nil", "{}").split("\n");
		// Studio may run the snippet sandboxed; a host from 2.0.0-alpha.5 or earlier does not mark its
		// bindable itself. In a pcall: once Studio refuses that too, the invoke says why.
		const mark = lines.indexOf("pcall(function() host.Sandboxed = true end)");
		const invoke = lines.findIndex((line) => line.includes("host:Invoke(nil, {})"));
		expect(mark).toBeGreaterThan(lines.findIndex((line) => line.includes("WaitForChild")));
		expect(invoke).toBeGreaterThan(mark);
		// No require, _G, shared or DataStore: a sandboxed thread has none of them.
		expect(lines.join("\n")).not.toMatch(/\brequire\b|\b_G\b|\bshared\b|DataStore/);
	});

	test("Studio's refusal of a sandboxed invoke is told from other errors", () => {
		expect(
			isSandboxRefusal(
				"The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has additional values for the Capabilities property: LoadUnownedAsset (and 3 more)",
			),
		).toBe(true);
		expect(
			isSandboxRefusal(
				"The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has an additional value for the Capabilities property: LoadUnownedAsset",
			),
		).toBe(true);
		expect(
			isSandboxRefusal(
				"The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has the Sandboxed property set to false but the calling thread is sandboxed",
			),
		).toBe(true);
		expect(isSandboxRefusal("Workspace.FlameworkTests did not appear within 30 seconds")).toBe(false);
		expect(isSandboxRefusal("Script that implemented this callback has been destroyed")).toBe(false);
		expect(SANDBOX_HINT).toContain("rebuild the place");
		expect(SANDBOX_HINT).toContain("after 2.0.0-alpha.5");
		expect(SANDBOX_HINT).not.toContain("\n");
	});

	test("a quoted answer from the proxy is unwrapped", () => {
		expect(unquoteLuauResult('"{\\"ok\\":true}"')).toBe('{"ok":true}');
		expect(unquoteLuauResult("2")).toBe("2");
	});

	test("an execute_luau error loses the Assistant's own locations, and keeps the snippet's message", () => {
		const assistant =
			"execute_luau: sabuiltin_Assistant.rbxm.Assistant.Packages._Index.AssistantUI.AssistantUI.Tools.ExecuteLuauTool:66: sabuiltin_Assistant.rbxm.Assistant.Packages._Index.AssistantUI.AssistantUI.Util.CommandExecution:54: ";
		expect(luauErrorMessage(new Error(`${assistant}AssistantCommand:2: host missing`))).toBe("host missing");
		expect(
			luauErrorMessage(new Error(`${assistant}Script that implemented this callback has been destroyed`)),
		).toBe("Script that implemented this callback has been destroyed");
		// A location of the game's own is part of its message.
		expect(luauErrorMessage(new Error(`${assistant}ServerScriptService.TS.main:4: boom`))).toBe(
			"ServerScriptService.TS.main:4: boom",
		);
		expect(luauErrorMessage("list_roblox_studios timed out after 15000ms")).toBe(
			"list_roblox_studios timed out after 15000ms",
		);
	});

	test("a tool's error loses the tool's name a JSON-RPC error carries first, then the Assistant's locations", () => {
		expect(toolErrorMessage("screen_capture: AssistantCommand:1: no viewport", "screen_capture")).toBe(
			"no viewport",
		);
		expect(toolErrorMessage("sabuiltin_X.Tool:66: AssistantCommand:2: boom", "execute_luau")).toBe("boom");
		// Another tool's name is part of the message.
		expect(toolErrorMessage("get_studio_state: busy", "execute_luau")).toBe("get_studio_state: busy");
	});
});

/** A stand-in for StudioMCP.exe: answers the MCP handshake, then ends when its stdin does, or never (`stubborn`). */
const STAND_IN = `
const stubborn = process.argv[2] === "stubborn";
const marker = process.argv[3];
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		const message = JSON.parse(line);
		if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
	}
});
process.stdin.on("end", () => {
	require("node:fs").writeFileSync(marker, "stdin ended");
	if (stubborn) setInterval(() => {}, 1000);
	else process.exit(0);
});
`;

describe("closing the MCP proxy", () => {
	const running = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	test("its stdin is ended first, and a proxy that exits then is let go of without being ended", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fwproxy-"));
		try {
			const script = join(dir, "proxy.cjs");
			writeFileSync(script, STAND_IN);
			const marker = join(dir, "ended");
			const client = await connectStudio(process.execPath, [script, "polite", marker]);
			const started = Date.now();
			await client.close();
			expect(Date.now() - started).toBeLessThan(PROXY_CLOSE_GRACE_MS);
			expect(existsSync(marker)).toBe(true);
			expect(running(client.pid!)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	test("one that does not exit once its stdin has ended is ended after the grace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fwproxy-"));
		try {
			const script = join(dir, "proxy.cjs");
			writeFileSync(script, STAND_IN);
			const marker = join(dir, "ended");
			const client = await connectStudio(process.execPath, [script, "stubborn", marker]);
			const started = Date.now();
			await Promise.all([client.close(), client.close()]);
			expect(Date.now() - started).toBeGreaterThanOrEqual(PROXY_CLOSE_GRACE_MS - 50);
			expect(existsSync(marker)).toBe(true);
			// Ended: give Windows a moment to take it down.
			for (let attempt = 0; attempt < 50 && running(client.pid!); attempt += 1) await Bun.sleep(100);
			expect(running(client.pid!)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("closing a window", () => {
	test("the script matches by PID, by the exact file or by title, never by a wildcard, and reports each window", () => {
		const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
		const file = "C:\\Bob\u2019s it's\\place.rbxl";
		const byPid = closeWindowScript({ pid: 4242, file });
		// Values travel as base64, never as text PowerShell could read as a quote.
		expect(byPid).toContain(`FromBase64String('${base64("RobloxStudioBeta")}')`);
		expect(byPid).toContain(
			`$file = ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64(file)}')))`,
		);
		expect(byPid).not.toContain("Bob");
		expect(byPid).toContain("$wantPid = 4242");
		expect(byPid).not.toContain("-like");
		// The run's own process may be confirmed by the command line it was started with; any other
		// window only by its title.
		expect(byPid).toContain("$_.Id -eq $wantPid -and (HasFile $_ $true)");
		// A run's own window is ended without asking: Studio answers the ask with a save prompt for
		// every place file it opened. Any other window is asked first.
		expect(byPid).toContain("CloseOne $p ($wantPid -le 0)");
		expect(byPid).toContain("if ($ask) { try { $asked = $p.CloseMainWindow() } catch { } }");
		expect(byPid).toContain("$(if ($ask) { 'forced' } else { 'ended' })");
		expect(byPid).toContain("$_.Id -ne $wantPid -and (HasFile $_ $false)");
		expect(byPid).toContain("$act = @($procs | Where-Object { HasFile $_ $false })");
		// A failed Stop-Process is caught and reported, and a window is only reported gone once it is.
		expect(byPid).toContain("Stop-Process -Id $p.Id -Force -ErrorAction Stop");
		expect(byPid).toContain("return Report $p $seen 'open' $err");
		expect(closeWindowScript({ file: "C:\\x\\place.rbxl" })).toContain("$wantPid = 0");
		expect(closeWindowScript({ title: "Place1 - Roblox Studio" })).toContain(base64("Place1 - Roblox Studio"));
	});

	test("the answer is read off its marked line, and no answer is an error rather than nothing closed", () => {
		const stdout = [
			"WARNING: something PowerShell said",
			'FWCLOSE [{"pid":30020,"title":"C:\\\\p\\\\place.rbxl - Roblox Studio","outcome":"open","error":"Access is denied"},{"pid":1,"title":"","outcome":"forced","error":""}]',
		].join("\r\n");
		expect(parseClosedWindows(stdout)).toEqual([
			{ pid: 30020, title: "C:\\p\\place.rbxl - Roblox Studio", outcome: "open", error: "Access is denied" },
			{ pid: 1, title: "", outcome: "forced" },
		]);
		expect(parseClosedWindows("FWCLOSE []")).toEqual([]);
		expect(() => parseClosedWindows("")).toThrow(/no answer/);
		expect(() => parseClosedWindows("forced")).toThrow(/no answer/);
	});
});

// The script run for real, on processes these tests start themselves (never Studio). They have no
// window and so no title: only the PID close, which may go by the command line, matches them.
describe.skipIf(process.platform !== "win32")("the close script, on real processes", () => {
	const processName = basename(process.execPath).replace(/\.exe$/i, "");
	const spawnIdle = (file: string) =>
		Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)", file], {
			stdout: "ignore",
			stderr: "ignore",
		});
	const exits = (child: ReturnType<typeof spawnIdle>) =>
		Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);

	test("any quote in a path or title is taken literally, and nothing in one runs", async () => {
		const files = [
			"C:\\Bob\u2019s Projects\\place.rbxl",
			"C:\\\u2018quoted\u2019\\place.rbxl",
			"C:\\a\u201Ab\u201Bc\\place.rbxl",
			"C:\\it's \u201Cq\u201D\\place.rbxl",
		];
		for (const file of files) expect(await runCloseScript({ file }, "fwclose-no-such-process")).toEqual([]);

		// Were the value spliced in as text, this would print an answer of its own and stop the script.
		const injected = 'C:\\a\u2019+$([Console]::WriteLine("FWCLOSE [{}]"); exit)+\u2019b\\place.rbxl';
		expect(await runCloseScript({ file: injected }, "fwclose-no-such-process")).toEqual([]);
		expect(await runCloseScript({ title: `${injected} - Roblox Studio` }, "fwclose-no-such-process")).toEqual([]);
	}, 60_000);

	test("titles are compared as the file system compares paths: ordinally, ignoring case only", () => {
		// The script's own comparison, run on pairs of a title and a file: only the spacing of
		// Studio's " - Roblox Studio" is forgiven, never a letter that a culture takes for others.
		const script = closeWindowScript({ file: "C:\\unused.rbxl" }, "fwclose-no-such-process");
		const functions = script.slice(0, script.indexOf("$procs = @(Get-Process"));
		const cases: Array<[string, string, boolean]> = [
			["E:\\Projects\\Place.RBXL - Roblox Studio", "e:\\projects\\place.rbxl", true],
			["C:\\x\\place.rbxl  -  Roblox Studio", "C:\\x\\place.rbxl", true],
			["C:\\Stra\u00DFe\\place.rbxl - Roblox Studio", "C:\\Strasse\\place.rbxl", false],
			["C:\\sp  x\\place.rbxl - Roblox Studio", "C:\\sp x\\place.rbxl", false],
			["C:\\a\u00A0b\\place.rbxl - Roblox Studio", "C:\\a b\\place.rbxl", false],
			["C:\\a\u3000b\\place.rbxl - Roblox Studio", "C:\\a b\\place.rbxl", false],
			["C:\\\u00E6ther\\place.rbxl - Roblox Studio", "C:\\aether\\place.rbxl", false],
			["C:\\\uFB01le\\place.rbxl - Roblox Studio", "C:\\file\\place.rbxl", false],
			["C:\\pro\u00ADject\\place.rbxl - Roblox Studio", "C:\\project\\place.rbxl", false],
			["C:\\caf\u00E9\\place.rbxl - Roblox Studio", "C:\\cafe\u0301\\place.rbxl", false],
		];
		const json = Buffer.from(JSON.stringify(cases.map(([title, file]) => ({ title, file }))), "utf8").toString(
			"base64",
		);
		const probe = `${functions}
$cases = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${json}')) | ConvertFrom-Json
'FWCMP ' + (ConvertTo-Json -InputObject @($cases | ForEach-Object { [bool](Same (Shown $_.title) $_.file) }) -Compress)
`;
		const result = Bun.spawnSync([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(probe, "utf16le").toString("base64"),
		]);
		const line = result.stdout
			.toString()
			.split(/\r?\n/)
			.find((entry) => entry.startsWith("FWCMP "));
		expect(JSON.parse(line!.slice("FWCMP ".length))).toEqual(cases.map(([, , same]) => same));
	}, 60_000);

	test("closes the process it was given, only while it has the file, checks it is gone, and leaves the rest", async () => {
		const file = `C:\\fwclose-${process.pid}-${Date.now()}\\Bob\u2019s it's place.rbxl`;
		const own = spawnIdle(file);
		const other = spawnIdle(file);
		const similar = spawnIdle(`${file}.bak`);
		try {
			await Bun.sleep(300);
			expect(await runCloseScript({ pid: own.pid, file: "C:\\nowhere\\place.rbxl" }, processName)).toEqual([]);
			// Started on "<file>.bak": the file's name is only part of it.
			expect(await runCloseScript({ pid: similar.pid, file }, processName)).toEqual([]);

			// The process given, by the file on its command line: a run's own process is ended without asking.
			const closed = await runCloseScript({ pid: own.pid, file }, processName);
			expect(closed).toEqual([{ pid: own.pid, title: "", outcome: "ended" }]);
			expect(await exits(own)).toBe(true);
			expect(other.exitCode).toBeNull();

			// A process this close was not given is matched by its title only, and these have none.
			expect(await runCloseScript({ file }, processName)).toEqual([]);
			expect(other.exitCode).toBeNull();
			expect(similar.exitCode).toBeNull();
		} finally {
			for (const child of [own, other, similar]) child.kill();
		}
	}, 60_000);
});

describe("claiming a window name", () => {
	const dirOf = () => mkdtempSync(join(tmpdir(), "fwclaim-"));
	const quick = { timeoutMs: 60_000, sleep: async () => {} };

	test("a second claim waits for the first to be released, and hears who holds it", async () => {
		const dir = dirOf();
		try {
			const first = await claimWindowName("Place.RBXL", { dir, ...quick, onWait: () => {} });
			const heard: number[] = [];
			let sleeps = 0;
			const second = await claimWindowName("place.rbxl", {
				dir,
				timeoutMs: 60_000,
				// The first run's window is listed after a while, and it lets go.
				sleep: async () => {
					sleeps += 1;
					if (sleeps === 3) first();
				},
				onWait: (holder) => heard.push(holder),
			});
			expect(sleeps).toBe(3);
			expect(heard).toEqual([process.pid]);
			second();
			expect(readdirSync(dir)).toEqual([]);
			// Other names are never held up.
			(await claimWindowName("other.rbxl", { dir, ...quick, onWait: () => {} }))();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a claim whose run has gone is taken over, and a live one held too long is refused", async () => {
		const dir = dirOf();
		try {
			// A claim left by a run that has gone (this one, as far as `isAlive` says) is taken over.
			await claimWindowName("place.rbxl", { dir, ...quick, onWait: () => {} });
			const taken = await claimWindowName("place.rbxl", {
				dir,
				...quick,
				onWait: () => {},
				isAlive: (pid) => pid !== process.pid,
			});
			taken();
			expect(readdirSync(dir)).toEqual([]);

			await claimWindowName("place.rbxl", { dir, ...quick, onWait: () => {} });
			await expect(
				claimWindowName("place.rbxl", {
					dir,
					timeoutMs: 3000,
					sleep: async () => {},
					onWait: () => {},
					isAlive: () => true,
				}),
			).rejects.toThrow(
				`another flamework-test run (PID ${process.pid}) has been opening a place.rbxl window for 3s`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("any window name can be claimed, however long or wherever its letters are from", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fwclaim-"));
	try {
		for (const name of [
			"\u0442".repeat(41) + ".rbxl",
			"\u65E5".repeat(28) + ".rbxl",
			"a".repeat(245) + ".rbxl",
			"a:b*?.rbxl",
		]) {
			(await claimWindowName(name, { dir, timeoutMs: 1000, sleep: async () => {}, onWait: () => {} }))();
		}
		expect(readdirSync(dir)).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
		expect(unlisted.err).toContain("Studio started (PID 4001) but the testing place");
		expect(unlisted.err).toContain("never showed up");
		// Written for an agent: what is off, and who turns it on.
		expect(unlisted.err).toContain(
			'Studio\'s "MCP server" setting is probably off, and a window with it off is never listed: ask the user to enable "MCP server" in Studio\'s Assistant settings, then run this again',
		);
		// A window nothing can drive would hold the Studio lock for nobody: it is closed again, by its
		// process and the place id on its command line, and the lock is free.
		expect(unlisted.err).toContain("the window this run opened is closed again");
		expect(unlisted.closeTargets).toEqual([`pid 4001 ${PLACE}`]);
		expect(unlisted.windows).toHaveLength(0);
		expect(unlisted.machine.lock.owner).toBeUndefined();

		const listed: StudioEntry[] = [OTHER_STUDIO];
		const connected = await runCli(["studio", "open"], {
			studio: { studios: listed },
			onLaunch: () => listed.push(TESTING_STUDIO),
		});
		expect(connected.code).toBe(0);
		expect(connected.out).toContain("connected: TestingExperience");
		expect(connected.out).toContain("studio_id=studio-1 pid=4001");
	});

	test("open never takes a window listed before it launched Studio for its own, whatever its name", async () => {
		// The user has the testing place open already: a second window of it is this command's.
		const listed: StudioEntry[] = [TESTING_STUDIO];
		const fresh = { id: "studio-fresh", name: TESTING_STUDIO.name };
		const run = await runCli(["studio", "open"], {
			studio: { studios: listed },
			onLaunch: () => listed.push(fresh),
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain("studio_id=studio-fresh pid=4001");
		expect(run.machine.lock.owner?.mcpId).toBe("studio-fresh");

		// Only the old one: never this command's.
		const old = await runCli(["studio", "open"], { studio: { studios: [TESTING_STUDIO] } });
		expect(old.code).toBe(1);
		expect(old.err).toContain("never showed up");
	});

	test("open with a file opens that file and waits for a window named after it", async () => {
		const listed: StudioEntry[] = [OTHER_STUDIO];
		const run = await runCli(["studio", "open", "place.patched.rbxl"], {
			files: { "place.patched.rbxl": "x" },
			studio: { studios: listed },
			onLaunch: () => listed.push(LOCAL_STUDIO),
		});
		expect(run.code).toBe(0);
		expect(run.launched[0]![1]!.replaceAll("\\", "/")).toEndWith("place.patched.rbxl");
		expect(run.out).toContain("connected: place.patched.rbxl");
		expect(run.out).toContain("studio_id=studio-3 pid=4001");

		const unlisted = await runCli(["studio", "open", "place.patched.rbxl"], {
			files: { "place.patched.rbxl": "x" },
			studio: { studios: [OTHER_STUDIO] },
		});
		expect(unlisted.code).toBe(1);
		expect(unlisted.err).toContain("place.patched.rbxl never showed up");
		expect(unlisted.closedWindows).toEqual(["place.patched.rbxl"]);
	});

	test("with no testing-place window, the only local-file window is used, and --studio names any window", async () => {
		const local = await runCli(["studio", "status"], {
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(local.code).toBe(0);
		expect(local.studioCalls[0]!.args.studio_id).toBe("studio-3");

		const named = await runCli(["studio", "status", "--studio", "Other Place"], {
			studio: { studios: [OTHER_STUDIO, TESTING_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(named.studioCalls[0]!.args.studio_id).toBe("studio-2");

		const missing = await runCli(["studio", "status", "--studio", "Nope"], {
			studio: { studios: [OTHER_STUDIO] },
		});
		expect(missing.code).toBe(1);
		expect(missing.err).toContain('no Studio window is named "Nope"');
		expect(missing.err).toContain("Other Place");
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
		const play = await runCli(["studio", "play", "--any-window"], {
			studio: { studios: [TESTING_STUDIO], answers: { start_stop_play: "Game Started" } },
		});
		expect(play.code).toBe(0);
		expect(play.studioCalls[0]).toEqual({
			name: "start_stop_play",
			args: { studio_id: "studio-1", is_start: true },
		});

		const stop = await runCli(["studio", "stop", "--any-window"], {
			studio: { studios: [TESTING_STUDIO], answers: { start_stop_play: "Game Stopped" } },
		});
		expect(stop.studioCalls[0]!.args.is_start).toBe(false);

		const place1 = { pid: 3001, title: "Place1 - Roblox Studio" };
		const close = await runCli(["studio", "close", "--any-window"], {
			studio: { studios: [TESTING_STUDIO] },
			windows: [{ pid: 3000, title: "TestingExperience - Roblox Studio" }, place1],
		});
		expect(close.code).toBe(0);
		expect(close.closeTargets).toEqual(["title TestingExperience - Roblox Studio"]);
		expect(close.closedWindows).toEqual(["TestingExperience"]);
		expect(close.out).toContain("closed TestingExperience (PID 3000)");
		expect(close.windows).toEqual([place1]);

		const gone = await runCli(["studio", "close", "--any-window"], {
			studio: { studios: [TESTING_STUDIO] },
			windows: [place1],
		});
		expect(gone.code).toBe(1);
		expect(gone.err).toContain('no window titled "TestingExperience - Roblox Studio" was found to close');
	});

	test("close checks the window is gone, and says so when it is not or when the title is ambiguous", async () => {
		const forced = await runCli(["studio", "close", "--any-window"], {
			studio: { studios: [TESTING_STUDIO] },
			windows: [{ pid: 3000, title: "TestingExperience - Roblox Studio" }],
			closeOutcome: "forced",
		});
		expect(forced.code).toBe(0);
		expect(forced.out).toContain(
			"closed TestingExperience (PID 3000) by ending its process: it did not close when asked",
		);

		const open = await runCli(["studio", "close", "--any-window"], {
			studio: { studios: [TESTING_STUDIO] },
			windows: [{ pid: 3000, title: "TestingExperience - Roblox Studio" }],
			closeOutcome: "open",
		});
		expect(open.code).toBe(1);
		expect(open.out).not.toContain("closed");
		expect(open.err).toContain(
			'TestingExperience is still open (PID 3000, "TestingExperience - Roblox Studio"): it did not close when asked, and ending its process failed: Access is denied',
		);

		// A local file is listed by name and titled by path: two such paths are two candidates, and neither is closed.
		const twins = [
			{ pid: 3000, title: "C:\\a\\place.patched.rbxl - Roblox Studio", startedWith: "C:\\a\\place.patched.rbxl" },
			{ pid: 3001, title: "D:\\b\\place.patched.rbxl - Roblox Studio", startedWith: "D:\\b\\place.patched.rbxl" },
		];
		const ambiguous = await runCli(["studio", "close", "--any-window"], {
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO] },
			windows: [...twins],
		});
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.err).toContain(
			'2 windows are titled like "place.patched.rbxl - Roblox Studio", so none was closed',
		);
		expect(ambiguous.err).toContain("PID 3000");
		expect(ambiguous.err).toContain("PID 3001");
		expect(ambiguous.windows).toEqual(twins);
	});

	test("exec runs Luau in the chosen data model", async () => {
		const run = await runCli(["studio", "exec", "--code", "return 1 + 1", "--realm", "server", "--any-window"], {
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

	test("a window named with --studio, or the only local file, needs no testing place configured", async () => {
		const exec = await runCli(["studio", "exec", "--code", "return 1", "--studio", "Other Place", "--any-window"], {
			env: {},
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO], answers: { execute_luau: "1" } },
		});
		expect(exec.code).toBe(0);
		expect(exec.studioCalls[0]!.args.studio_id).toBe("studio-2");

		const close = await runCli(["studio", "close", "--studio", "place.patched.rbxl", "--any-window"], {
			env: {},
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO] },
			windows: [{ pid: 3000, title: "C:\\a\\place.patched.rbxl - Roblox Studio" }],
		});
		expect(close.code).toBe(0);
		expect(close.closedWindows).toEqual(["place.patched.rbxl"]);

		const local = await runCli(["studio", "status"], {
			env: {},
			studio: { studios: [OTHER_STUDIO, LOCAL_STUDIO], answers: { get_studio_state: EDITING } },
		});
		expect(local.code).toBe(0);
		expect(local.studioCalls[0]!.args.studio_id).toBe("studio-3");

		const none = await runCli(["studio", "status"], { env: {}, studio: { studios: [OTHER_STUDIO] } });
		expect(none.code).toBe(1);
		expect(none.err).toContain(
			"no single Studio window has a local place file open, and no testing place is configured",
		);
		expect(none.err).not.toContain("no testing universe");
	});

	test("exec reports the snippet's error without the Assistant's wrapping", async () => {
		const run = await runCli(["studio", "exec", "--code", "error('nope')", "--any-window"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: {
					execute_luau: () => {
						throw new Error(
							"execute_luau: sabuiltin_Assistant.rbxm.Assistant.Tools.ExecuteLuauTool:66: AssistantCommand:1: nope",
						);
					},
				},
			},
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("error: the Luau failed in Edit: nope");
	});

	test("run starts a play session when there is none, runs the tests, prints the summary and stops it", async () => {
		let mode = "Edit";
		const run = await runCli(["studio", "run", "--sections", "economy", "--any-window"], {
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
		const found = await runCli(["studio", "run", "--realm", "client", "--any-window"], {
			studio: {
				studios: [TESTING_STUDIO],
				answers: { get_studio_state: PLAYING, execute_luau: JSON.stringify(resultJson({ realm: "client" })) },
			},
		});
		expect(found.code).toBe(0);
		expect(found.studioCalls.map((call) => call.name)).toEqual(["get_studio_state", "execute_luau"]);
		expect(found.studioCalls[1]!.args.datamodel_type).toBe("Client");

		let mode = "Edit";
		const kept = await runCli(["studio", "run", "--keep", "--any-window"], {
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
		const run = await runCli(["studio", "run", "--any-window"], {
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
