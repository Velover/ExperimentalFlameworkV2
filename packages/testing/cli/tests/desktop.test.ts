import { describe, expect, test } from "bun:test";

import {
	commandLineOf,
	desktopWindows,
	hiddenTitles,
	launchOnDesktop,
	quoteArgument,
	startupInfo,
	STARTF_USESHOWWINDOW,
	STARTUPINFOW_SIZE,
	SW_SHOWNOACTIVATE,
} from "../src/desktop.ts";
import { listStudioWindows, runCloseScript } from "../src/studio.ts";

describe("launching on the hidden desktop", () => {
	test("arguments are quoted as the C runtime reads them back", () => {
		expect(quoteArgument("plain")).toBe("plain");
		expect(quoteArgument("C:\\no\\space\\")).toBe("C:\\no\\space\\");
		expect(quoteArgument("")).toBe('""');
		expect(quoteArgument("C:\\My Places\\place.rbxl")).toBe('"C:\\My Places\\place.rbxl"');
		expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""');
		// Backslashes are doubled only before a quote, the closing one included.
		expect(quoteArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
		expect(quoteArgument('a\\"b c')).toBe('"a\\\\\\"b c"');
		expect(quoteArgument("tab\there")).toBe('"tab\there"');
		expect(
			commandLineOf(["C:\\Program Files\\Roblox\\RobloxStudioBeta.exe", "-task", "EditPlace", "-placeId", "1"]),
		).toBe('"C:\\Program Files\\Roblox\\RobloxStudioBeta.exe" -task EditPlace -placeId 1');
	});

	test("STARTUPINFOW is laid out as 64-bit Windows reads it: size, desktop, flags and show command, the rest zero", () => {
		const info = startupInfo(0x123456789a, SW_SHOWNOACTIVATE);
		expect(info.length).toBe(STARTUPINFOW_SIZE);
		expect(info.readUInt32LE(0)).toBe(104);
		expect(info.readBigUInt64LE(16)).toBe(0x123456789an);
		expect(info.readUInt32LE(60)).toBe(STARTF_USESHOWWINDOW);
		expect(info.readUInt16LE(64)).toBe(4);
		const rest = Buffer.from(info);
		rest.fill(0, 0, 4);
		rest.fill(0, 16, 24);
		rest.fill(0, 60, 66);
		expect(rest.every((byte) => byte === 0)).toBe(true);
	});
});

// For real, on PowerShell windows these tests start themselves on a desktop of their own (never
// Studio, never the flamework-test desktop): what the user's desktop sees of them, and what a close
// by file does to them.
describe.skipIf(process.platform !== "win32")("a window on a hidden desktop, for real", () => {
	const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	/** CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP: PowerShell is a console program, which a detached launch ends at once. */
	const CONSOLELESS = 0x08000000 | 0x200;
	const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
	/** A PowerShell showing a window titled `title`, with `file` on its command line after a comment mark. */
	const form = (desktop: string, title: string, file: string) =>
		launchOnDesktop(
			[
				powershell,
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = ${quoted(title)}; [System.Windows.Forms.Application]::Run($f) #`,
				file,
			],
			desktop,
			CONSOLELESS,
		);
	const running = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	test("a desktop no run has made has no windows", () => {
		expect(desktopWindows(`flamework-test-none-${process.pid}-${Date.now()}`)).toEqual([]);
	});

	test("opens there, shows its title only to a look at that desktop, and a close by its file ends it unasked", async () => {
		const desktop = `flamework-test-spec-${process.pid}`;
		const file = `C:\\fwhidden-${process.pid}-${Date.now()}\\Bob's place.rbxl`;
		const title = `${file} - Roblox Studio`;
		// One titled with the file, one still "loading": only its command line names the file.
		const titled = form(desktop, title, file);
		const loading = form(desktop, "Roblox Studio", file);
		try {
			let titles = new Map<number, string>();
			for (let waited = 0; waited < 30_000 && !(titles.has(titled) && titles.has(loading)); waited += 250) {
				await Bun.sleep(250);
				titles = hiddenTitles(desktop);
			}
			expect(titles.get(titled)).toBe(title);
			expect(titles.get(loading)).toBe("Roblox Studio");
			// Nothing of them on the user's desktop.
			expect(desktopWindows("Default").filter((window) => [titled, loading].includes(window.pid))).toEqual([]);

			// The user's desktop reads no title for either; with the hidden desktop's titles, each is listed hidden.
			const blind = await listStudioWindows("powershell", () => new Map());
			expect(blind.filter((window) => [titled, loading].includes(window.pid))).toEqual([
				...[titled, loading].sort((a, b) => a - b).map((pid) => ({ pid, title: "" })),
			]);
			const seen = await listStudioWindows("powershell", () => hiddenTitles(desktop));
			expect(seen.filter((window) => window.pid === titled)).toEqual([{ pid: titled, title, hidden: true }]);
			expect(seen.filter((window) => window.pid === loading)).toEqual([
				{ pid: loading, title: "Roblox Studio", hidden: true },
			]);

			// By its file: one by its title from that desktop, one by its command line; neither is asked.
			const closed = await runCloseScript({ file }, "powershell", hiddenTitles(desktop));
			expect(closed.sort((a, b) => a.pid - b.pid)).toEqual(
				[
					{ pid: titled, title, outcome: "ended" as const },
					{ pid: loading, title: "Roblox Studio", outcome: "ended" as const },
				].sort((a, b) => a.pid - b.pid),
			);
			expect(running(titled)).toBe(false);
			expect(running(loading)).toBe(false);
		} finally {
			for (const pid of [titled, loading]) if (running(pid)) process.kill(pid);
		}
	}, 90_000);
});
