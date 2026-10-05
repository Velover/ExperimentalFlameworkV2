/**
 * Roblox Studio on this machine: launching it on the testing place, finding the window that has
 * that place open, and driving it through Roblox's own MCP proxy (StudioMCP.exe) over stdio.
 *
 * The proxy is what an AI client would connect to; nothing here needs one. It speaks JSON-RPC on
 * its stdin and stdout and joins a hub the Studio plugin is connected to, so with "MCP server"
 * enabled in Studio's Assistant settings a terminal can execute Luau, start and stop a play
 * session and read Studio's state exactly as an assistant would.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hiddenTitles } from "./desktop.ts";
import type { ProcessInfo } from "./lock.ts";

/** One entry of `list_roblox_studios`: the id every other call takes, and a name carrying the place id. */
export interface StudioEntry {
	id: string;
	name: string;
}

export type DataModelType = "Edit" | "Client" | "Server";

/** One tool the proxy offers, as `tools/list` describes it. */
export interface ToolInfo {
	name: string;
	description?: string;
	inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

/** One piece of a tool's answer: text, or an image (base64 `data` and its `mimeType`), or other kinds. */
export interface ToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

/** A tool's whole answer, as the proxy gives it. */
export interface ToolResult {
	content?: ToolContent[];
	isError?: boolean;
	[key: string]: unknown;
}

/** A connected proxy. Call `close()` when finished, and wait for it: it holds a child process. */
export interface StudioClient {
	/** Calls one MCP tool and returns its text content; throws on an error result. */
	call: (name: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<string>;
	/**
	 * Calls one MCP tool and returns its whole answer, an error result included (`isError`); throws
	 * only when the proxy answers with a JSON-RPC error, or not at all.
	 */
	callRaw: (name: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
	/** The tools the proxy offers, read live (`tools/list`), so they are what this Studio has. */
	tools: () => Promise<ToolInfo[]>;
	/** Lists the connected Studio windows, retrying while the proxy is still joining the hub. */
	studios: () => Promise<StudioEntry[]>;
	/** Ends the proxy: its stdin first, which lets it leave the hub in order, then its process. */
	close: () => void | Promise<void>;
	/** The proxy's process, when known. */
	pid?: number;
}

// --------------------------------------------------------------- executables

function versionsDirectory(env: Record<string, string | undefined>): string {
	return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Roblox", "Versions");
}

/** The newest copy of `name` under the Studio versions folder, or the path an override names. */
function findUnderVersions(
	name: string,
	override: string | undefined,
	env: Record<string, string | undefined>,
): string | undefined {
	if (override !== undefined && existsSync(override)) return override;

	const versions = versionsDirectory(env);
	if (!existsSync(versions)) return undefined;

	const candidates = readdirSync(versions)
		.map((version) => join(versions, version, name))
		.filter((candidate) => existsSync(candidate))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return candidates[0];
}

/** `StudioMCP.exe`, or `STUDIO_MCP_EXE`. */
export function findStudioMcp(env: Record<string, string | undefined> = process.env): string | undefined {
	return findUnderVersions("StudioMCP.exe", env.STUDIO_MCP_EXE, env);
}

/** `RobloxStudioBeta.exe`, or `ROBLOX_STUDIO_EXE`. */
export function findStudioExe(env: Record<string, string | undefined> = process.env): string | undefined {
	return findUnderVersions("RobloxStudioBeta.exe", env.ROBLOX_STUDIO_EXE, env);
}

// ------------------------------------------------------------- pure helpers

/** The Studio window that has this place open, going by the place id the proxy puts in the name. */
export function findStudioForPlace(studios: readonly StudioEntry[], placeId: string): StudioEntry | undefined {
	return studios.find((studio) => studio.name.includes(`(placeId: ${placeId})`));
}

/** The place's name as Studio shows it, from `"TestingExperience (placeId: 123)"`; a local file is listed by its file name alone. */
export function placeNameOf(studioName: string): string {
	return studioName.replace(/\s*\(placeId: \d+\)\s*$/, "").trim();
}

/** A window with a local place file open, which the proxy lists by file name and no place id. */
export function isLocalFileWindow(studio: StudioEntry): boolean {
	return /\.rbxlx?$/i.test(studio.name) && !/\(placeId: \d+\)/.test(studio.name);
}

/**
 * The window to drive. A target names it by id, full name, or the name before the place id; with
 * none, the window with the testing place open; failing that, the only local-file window, which
 * is what `studio open <file>` leaves. Two local files open is ambiguous and matches nothing.
 */
export function findStudio(
	studios: readonly StudioEntry[],
	placeId: string | undefined,
	target?: string,
): StudioEntry | undefined {
	if (target !== undefined) {
		return studios.find(
			(studio) => studio.id === target || studio.name === target || placeNameOf(studio.name) === target,
		);
	}
	if (placeId !== undefined) {
		const byPlace = findStudioForPlace(studios, placeId);
		if (byPlace !== undefined) return byPlace;
	}
	const local = studios.filter(isLocalFileWindow);
	return local.length === 1 ? local[0] : undefined;
}

/** What a play session's state answer looks like when Studio is playing. */
export function isPlaying(state: string): boolean {
	return /Current Studio Mode:\s*Play/i.test(state);
}

/** The arguments that open a place from the cloud in a fresh Studio window. */
export function studioOpenArguments(target: { placeId: string; universeId: string } | { file: string }): string[] {
	if ("file" in target) return [target.file];
	return ["-task", "EditPlace", "-placeId", target.placeId, "-universeId", target.universeId];
}

/**
 * The Luau that invokes the in-place test host and hands its result back as JSON, since
 * `execute_luau` returns text and a Lua table would arrive as `table: 0x...`.
 *
 * Studio may run it sandboxed (it did from 2026-10-01; on 2026-10-05 it did not), and a sandboxed
 * thread may only invoke a bindable that is Sandboxed itself (see the host's
 * `openToSandboxedCallers`). A host from 2.0.0-alpha.5 or earlier does not mark its bindable, so the
 * snippet marks it before the invoke, for as long as Studio lets sandboxed code set the property; a
 * place built since needs nothing of it, sandboxed or not.
 */
export function renderStudioRun(filter: string, options: string): string {
	return [
		'local host = workspace:WaitForChild("FlameworkTests", 30)',
		'if not host then error("Workspace.FlameworkTests did not appear within 30 seconds: is the testing scope active in this build, and is TestingPlugin included?") end',
		"pcall(function() host.Sandboxed = true end)",
		`return game:GetService("HttpService"):JSONEncode(host:Invoke(${filter}, ${options}))`,
	].join("\n");
}

/** What Studio raises when a sandboxed thread invokes a bindable that is not Sandboxed. */
export function isSandboxRefusal(message: string): boolean {
	return /additional values? for the Capabilities property|Sandboxed property set to false/i.test(message);
}

/**
 * What Studio raises when sandboxed code does what its capabilities do not allow: the refusals of
 * {@link isSandboxRefusal}, and a call "lacking capability". Not every error that names `require`:
 * outside the sandbox, `require` of something that is not a ModuleScript fails too.
 */
export function isCapabilityRefusal(message: string): boolean {
	return isSandboxRefusal(message) || /lacking capability/i.test(message);
}

/**
 * The line a run adds under a realm's failure that {@link isSandboxRefusal}: the place's test host
 * predates sandboxed MCP code, and Studio no longer lets the snippet mark it itself.
 */
export const SANDBOX_HINT =
	"Studio ran the run's Luau sandboxed (it may run MCP code so; it did from 2026-10-01), and sandboxed code may only invoke a Sandboxed bindable, which the test host in this place does not make: rebuild the place with this version of @flamework-experimental/testing (any release after 2.0.0-alpha.5)";

/**
 * The line `studio exec` and `studio call execute_luau` add under an error that
 * {@link isCapabilityRefusal}: Studio ran the snippet sandboxed.
 */
export const SNIPPET_SANDBOX_HINT =
	"Studio ran this Luau sandboxed (it may run MCP code so; it did from 2026-10-01): there, require of the place's modules, _G, shared and DataStore are refused; reach the game through a Sandboxed bindable, as the test host does";

/**
 * The message of a failed call, without what Studio's Assistant wraps an `execute_luau` error in:
 * the tool's name, then the `sabuiltin_Assistant…ExecuteLuauTool:66:` and `…CommandExecution:54:`
 * locations of its own code and `AssistantCommand:2:`, the line of the snippet, before the message
 * the snippet raised. Anything else is left as it is.
 */
export function luauErrorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return toolErrorMessage(text.replace(/^execute_luau:\s*/, ""));
}

/**
 * A tool's error text without the locations of the Studio Assistant's own code in front of it, and
 * without the tool's name the client puts before a JSON-RPC error (`execute_luau: `), which comes
 * first when `tool` is given.
 */
export function toolErrorMessage(text: string, tool?: string): string {
	const named = tool !== undefined && text.startsWith(`${tool}:`) ? text.slice(tool.length + 1).trimStart() : text;
	return named.replace(/^(?:sabuiltin_\S*?:\d+:\s*|AssistantCommand:\d+:\s*)+/, "");
}

/** A tool answer's text pieces, one per line; anything else (an image) as its JSON. */
export function textOf(result: ToolResult): string {
	return (result.content ?? [])
		.map((entry) => (entry.type === "text" ? (entry.text ?? "") : JSON.stringify(entry)))
		.join("\n");
}

/** Tidies what `execute_luau` returns: the proxy wraps a returned string in quotes. */
export function unquoteLuauResult(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

// --------------------------------------------------------------- closing

/**
 * Which Studio windows a close may touch.
 *
 * - `pid` and `file`: the process a run started on that file, and only while its title or the
 *   command line it was started with names that file, so a PID Windows has since reused is never
 *   touched. Other windows titled with the file are reported `untouched`. For a window opened on
 *   the testing place from the cloud, `file` is the place id, which its command line names
 *   (`-placeId <id>`) as a word of its own.
 * - `file` alone: every window whose title shows that very file (Studio titles a local file's window
 *   with its full path). By the title only: a window started on the file and since saved elsewhere
 *   or published shows its new name and is left alone, and so is one whose title has changed. A
 *   window on the hidden desktop (see desktop.ts) also by its command line, since only flamework-test
 *   opens windows there and nobody can be using one.
 * - `title`: the window titled exactly so, or whose title is a path ending in it. Several are
 *   ambiguous, and all of them are left `untouched`.
 */
export type CloseTarget = { pid: number; file: string } | { file: string } | { title: string };

/** What became of one Studio window a close matched. */
export interface ClosedWindow {
	pid: number;
	/** Its title when the close found it. */
	title: string;
	/**
	 * `closed`: it exited when asked. `forced`: it did not (a save prompt, usually) and its process
	 * was ended. `ended`: its process was ended without asking, as a run's own window is (see
	 * {@link closeWindowScript}). `open`: it is still running after that; `error` says why, when
	 * Windows said. `untouched`: it matched, but is not certainly the window meant, so it was left alone.
	 */
	outcome: "closed" | "forced" | "ended" | "open" | "untouched";
	error?: string;
}

/** The line the close script's answer is on, whatever else PowerShell printed. */
const CLOSE_MARKER = "FWCLOSE ";

/**
 * A string as a PowerShell expression that yields it exactly. PowerShell ends a quoted string at
 * ‘ ’ ‚ ‛ as well as at ', so a path is never spliced into the script as text: it travels as the
 * base64 of its UTF-8, which has no character PowerShell reads as syntax.
 */
function powershellString(value: string): string {
	return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`;
}

/**
 * The PowerShell that closes the windows a target matches and reports each as JSON. It asks first
 * (`CloseMainWindow`), waits up to ten seconds, then ends the process, and then checks the process
 * is really gone: a window is only reported closed once it is. `processName` is for the tests,
 * which close processes of their own; the CLI only ever closes Roblox Studio.
 *
 * `hidden` is the windows on the hidden desktop, by PID, with their titles (see
 * {@link hiddenTitles}): PowerShell on the user's desktop reads an empty `MainWindowTitle` for each,
 * so the script reads the title from here. Such a window is never asked: `CloseMainWindow` reaches
 * only the windows of the script's own desktop, and a save prompt on the hidden one would be seen by
 * nobody. It is ended, as a run's own window is.
 *
 * The process a run started (a `pid` target) is ended without asking. Asking never closes it: Studio
 * marks a place file it opens from disk as changed the moment it loads it, before any play session
 * or Luau, so the ask only raises "Save changes to place.rbxl?" and the close waited out its ten
 * seconds on every run (measured 2026-09-28). Nothing a run makes is kept, and the prompt's buttons
 * are not reachable from outside the window, so the wait bought nothing.
 */
export function closeWindowScript(
	target: CloseTarget,
	processName = "RobloxStudioBeta",
	hidden: ReadonlyMap<number, string> = new Map(),
): string {
	const pid = "pid" in target ? target.pid : 0;
	const file = "file" in target ? target.file : "";
	const title = "title" in target ? target.title : "";
	const hiddenLines = [...hidden]
		.map(([id, shown]) => `$hidden[${Math.trunc(id)}] = ${powershellString(shown)}`)
		.join("\n");
	return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$name = ${powershellString(processName)}
$wantPid = ${Math.trunc(pid)}
$file = ${powershellString(file)}
$title = ${powershellString(title)}
# What a title shows, without Studio's own " - Roblox Studio" (whose spacing varies); and an
# ordinal comparison, ignoring case only, as the file system does: -ieq compares by culture and
# would take "Straße" for "Strasse".
function Shown([string]$t) { return ($t -replace '\\s+-\\s+Roblox Studio$', '') }
function Same([string]$a, [string]$b) { return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase) }
# The windows on flamework-test's hidden desktop, by process, and their titles, which this script,
# on the user's desktop, cannot read itself.
$hidden = @{}
${hiddenLines}
function TitleOf($p) { $t = [string]$p.MainWindowTitle; if ($t -eq '' -and $hidden.ContainsKey([int]$p.Id)) { $t = $hidden[[int]$p.Id] }; return $t }
$lines = @{}
Get-CimInstance Win32_Process -Filter ("Name='" + $name + ".exe'") -ErrorAction SilentlyContinue | ForEach-Object { $lines[[int]$_.ProcessId] = [string]$_.CommandLine }
function HasFile($p, [bool]$started) {
	if ($file -eq '') { return $false }
	if (Same (Shown (TitleOf $p)) $file) { return $true }
	if (-not $started) { return $false }
	$line = $lines[[int]$p.Id]
	if (-not $line) { return $false }
	return [regex]::IsMatch($line, '(^|[\\s"])' + [regex]::Escape($file) + '($|[\\s"])', [System.Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant')
}
function Gone($p) {
	try { $p.Refresh(); if ($p.HasExited) { return $true } } catch { }
	return -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)
}
function Report($p, [string]$seen, [string]$outcome, [string]$err) {
	return [pscustomobject]@{ pid = [int]$p.Id; title = $seen; outcome = $outcome; error = $err }
}
function CloseOne($p, [bool]$ask) {
	$seen = TitleOf $p
	if ($hidden.ContainsKey([int]$p.Id)) { $ask = $false }
	$asked = $false
	if ($ask) { try { $asked = $p.CloseMainWindow() } catch { } }
	if ($asked) { for ($i = 0; $i -lt 20; $i++) { if (Gone $p) { break }; Start-Sleep -Milliseconds 500 } }
	if (Gone $p) { return Report $p $seen 'closed' '' }
	$err = ''
	try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { $err = $_.Exception.Message }
	for ($i = 0; $i -lt 30; $i++) { if (Gone $p) { break }; Start-Sleep -Milliseconds 500 }
	if (Gone $p) { return Report $p $seen $(if ($ask) { 'forced' } else { 'ended' }) $err }
	return Report $p $seen 'open' $err
}
$procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
$act = @()
$leave = @()
if ($wantPid -gt 0) {
	$act = @($procs | Where-Object { $_.Id -eq $wantPid -and (HasFile $_ $true) })
	$leave = @($procs | Where-Object { $_.Id -ne $wantPid -and (HasFile $_ $false) })
} elseif ($file -ne '') {
	$act = @($procs | Where-Object { HasFile $_ ($hidden.ContainsKey([int]$_.Id)) })
} else {
	$want = Shown $title
	$act = @($procs | Where-Object { $t = Shown (TitleOf $_); (Same $t $want) -or $t.EndsWith('\\' + $want, [System.StringComparison]::OrdinalIgnoreCase) })
	if ($act.Count -gt 1) { $leave = $act; $act = @() }
}
$out = @()
foreach ($p in $act) { $out += CloseOne $p ($wantPid -le 0) }
foreach ($p in $leave) { $out += Report $p (TitleOf $p) 'untouched' '' }
${powershellString(CLOSE_MARKER)} + (ConvertTo-Json -InputObject @($out) -Compress)
`;
}

/** Reads the close script's answer; throws when there is none, since then nothing is known about the windows. */
export function parseClosedWindows(stdout: string): ClosedWindow[] {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((entry) => entry.startsWith(CLOSE_MARKER));
	if (line === undefined) throw new Error("the close script gave no answer");
	const parsed = JSON.parse(line.slice(CLOSE_MARKER.length)) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`the close script answered ${line}`);
	return parsed.map((entry: { pid: number; title: string; outcome: ClosedWindow["outcome"]; error?: string }) => ({
		pid: entry.pid,
		title: entry.title ?? "",
		outcome: entry.outcome,
		...(entry.error ? { error: entry.error } : {}),
	}));
}

/**
 * Runs a script in Windows PowerShell, hidden, and resolves with what it printed. It never blocks
 * this process meanwhile, so a Ctrl+C that comes during a close is heard when it comes, not once
 * the close is done.
 */
async function runPowerShell(
	script: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; error?: Error }> {
	// Encoded, so no quote or path in the script depends on how the command line is quoted.
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
	try {
		// Hidden, and no stdio inherited: a console of its own, which a Ctrl+C in the terminal does not reach.
		child = Bun.spawn({
			cmd: ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
	} catch (error) {
		return { stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
	}
	let error: Error | undefined;
	const timer = setTimeout(() => {
		error = new Error(`PowerShell did not finish within ${timeoutMs / 1000}s`);
		child.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		await child.exited;
		return { stdout, stderr, ...(error ? { error } : {}) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Runs the close script in Windows PowerShell and returns what became of each window it matched;
 * the windows on the hidden desktop are looked at first, for their titles.
 */
export async function runCloseScript(
	target: CloseTarget,
	processName?: string,
	hidden: ReadonlyMap<number, string> = hiddenTitles(),
): Promise<ClosedWindow[]> {
	const result = await runPowerShell(closeWindowScript(target, processName, hidden), 90_000);
	try {
		return parseClosedWindows(result.stdout);
	} catch (error) {
		const why = result.error?.message ?? result.stderr.trim();
		throw new Error(
			`could not tell whether the Studio window closed (${error instanceof Error ? error.message : String(error)})${why ? `: ${why}` : ""}`,
		);
	}
}

/** A Roblox Studio process and the title of its window. */
export interface StudioWindow {
	pid: number;
	title: string;
	/** Its window is on the hidden desktop, where nobody sees it (see desktop.ts). */
	hidden?: boolean;
}

/**
 * Every Roblox Studio process on this machine, with its window's title; read-only. A window on the
 * hidden desktop is read from that desktop, since PowerShell on the user's desktop sees no title
 * for it, and is marked `hidden`.
 */
export async function listStudioWindows(
	processName = "RobloxStudioBeta",
	hidden: () => ReadonlyMap<number, string> = hiddenTitles,
): Promise<StudioWindow[]> {
	const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = @(Get-Process -Name ${powershellString(processName)} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.Id; title = [string]$_.MainWindowTitle } })
${powershellString(CLOSE_MARKER)} + (ConvertTo-Json -InputObject @($out) -Compress)
`;
	const result = await runPowerShell(script, 60_000);
	const line = result.stdout
		.split(/\r?\n/)
		.reverse()
		.find((entry) => entry.startsWith(CLOSE_MARKER));
	if (line === undefined) {
		throw new Error(
			`could not list the Studio windows${result.error ? `: ${result.error.message}` : result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
		);
	}
	const titles = hidden();
	return (JSON.parse(line.slice(CLOSE_MARKER.length)) as StudioWindow[]).map((window) => ({
		pid: window.pid,
		title: window.title || (titles.get(window.pid) ?? ""),
		...(titles.has(window.pid) ? { hidden: true } : {}),
	}));
}

/**
 * Looks processes up by PID: the name Windows gives each (`RobloxStudioBeta`, `bun`) and when it
 * started, which together tell a process from another that has since been given its PID. A PID
 * missing from the answer runs nothing. Read-only. Anywhere but Windows only whether it runs is known.
 */
export async function probeProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
	const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
	const found = new Map<number, ProcessInfo>();
	if (wanted.length === 0) return found;
	if (process.platform !== "win32") {
		for (const pid of wanted) if (isRunning(pid)) found.set(pid, {});
		return found;
	}

	const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = @()
foreach ($id in @(${wanted.join(", ")})) {
	$p = Get-Process -Id $id -ErrorAction SilentlyContinue
	if ($p) {
		$started = $null
		try { $started = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { }
		$out += [pscustomobject]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; started = $started }
	}
}
${powershellString(CLOSE_MARKER)} + (ConvertTo-Json -InputObject @($out) -Compress)
`;
	const result = await runPowerShell(script, 60_000);
	const line = result.stdout
		.split(/\r?\n/)
		.reverse()
		.find((entry) => entry.startsWith(CLOSE_MARKER));
	if (line === undefined) {
		throw new Error(
			`could not look up the processes ${wanted.join(", ")}${result.error ? `: ${result.error.message}` : result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
		);
	}
	for (const entry of JSON.parse(line.slice(CLOSE_MARKER.length)) as Array<{
		pid: number;
		name: string;
		started: number | null;
	}>) {
		found.set(entry.pid, {
			name: entry.name,
			...(typeof entry.started === "number" ? { startedAt: entry.started } : {}),
		});
	}
	return found;
}

/**
 * Whether a Studio window's title shows a local file of this name: Studio titles such a window
 * `<full path> - Roblox Studio`, and the proxy lists it by the file name alone.
 */
export function titleShowsFile(title: string, name: string): boolean {
	const shown = title.replace(/\s+-\s+Roblox Studio$/, "").toLowerCase();
	const wanted = name.toLowerCase();
	return shown === wanted || shown.endsWith(`\\${wanted}`) || shown.endsWith(`/${wanted}`);
}

// ------------------------------------------------------- claiming a window name

/** Whether a process is running; signal 0 only asks. */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Claims a window name on this machine while a run opens a window of that name and waits for the
 * proxy to list it, and resolves with the release. The proxy names a local file's window by its
 * file name alone and says nothing of the process behind it, so two runs of same-named files
 * waiting at once would each take the first new entry, which is only one of their windows. Under a
 * claim, a second run looks at the proxy only once the first run's window is listed, and so finds
 * its own. A claim is a file in `dir` holding the claimant's PID; one whose process has ended is
 * taken over, and a wait longer than `timeoutMs` is refused, naming the holder.
 *
 * The holder is judged by its PID alone, not by its name and start time as the Studio lock's are. No
 * older CLI reads these claims (2.0.0-alpha.6 kept its own in the temp folder), so the format is
 * free to change; it is left because a claim lives only while a window registers, seconds, and is
 * removed with it, so one is left only by a process killed in that moment, and a PID Windows gives
 * another process before the next claimant looks costs a wait that ends naming the file to delete.
 */
export async function claimWindowName(
	name: string,
	options: {
		dir: string;
		timeoutMs: number;
		sleep: (ms: number) => Promise<void>;
		/** Called once when the name is held by another run, with that run's PID. */
		onWait: (holder: number) => void;
		isAlive?: (pid: number) => boolean;
	},
): Promise<() => void> {
	const alive = options.isAlive ?? isRunning;
	// Named by a hash: the name itself can be too long for a file name once escaped, or not allowed in one.
	const path = join(
		options.dir,
		`${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 32)}.claim`,
	);
	mkdirSync(options.dir, { recursive: true });

	let waited = 0;
	let told = false;
	for (;;) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx" });
			return () => rmSync(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		let holder = Number.NaN;
		try {
			holder = Number(readFileSync(path, "utf8"));
		} catch {
			// Released between the two calls: try again at once.
			continue;
		}
		// A holder that has gone, or a file too new to hold its PID yet (retried below), is not a claim.
		if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
			rmSync(path, { force: true });
			continue;
		}
		if (waited >= options.timeoutMs) {
			throw new Error(
				`another flamework-test run (PID ${holder}) has been opening a ${name} window for ${Math.round(waited / 1000)}s; if it is gone, delete ${path}`,
			);
		}
		if (!told && Number.isInteger(holder) && holder > 0) {
			told = true;
			options.onWait(holder);
		}
		await options.sleep(1000);
		waited += 1000;
	}
}

// ----------------------------------------------------------------- the proxy

/**
 * How long a proxy is given to exit once its stdin has ended, before its process is ended. The MCP
 * stdio transport ends a server by closing its stdin, then waiting, then ending the process; the
 * proxy is a Rust rmcp server reading its stdin (`AsyncRwTransport<RoleServer, Stdin, Stdout>`), whose
 * service stops when that stream ends. Ending it at once would give it no chance to leave the hub
 * that other clients' proxies share (the first proxy is the hub; later ones join it). Not measured
 * against a live proxy: if it does not exit in this time, it is ended as before.
 */
export const PROXY_CLOSE_GRACE_MS = 2000;

interface Pending {
	resolve: (message: JsonRpcResponse) => void;
}

interface JsonRpcResponse {
	id?: number;
	result?: ToolResult & { tools?: ToolInfo[] };
	error?: { code?: number; message?: string } | unknown;
}

/** The message of a JSON-RPC error, which is an object with a `message` when the proxy follows the spec. */
function rpcErrorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
		return (error as { message: string }).message;
	}
	return JSON.stringify(error);
}

/** Spawns the proxy (`args`: for the tests, which stand a script in for it), does the MCP handshake and returns a client over it. */
export async function connectStudio(exe: string, args: string[] = []): Promise<StudioClient> {
	// Hidden, which with no stdio inherited gives it a console of its own: a Ctrl+C in the terminal
	// does not reach it, so it is still there for an interrupted run to stop its play session with.
	// It exits when this process does, its stdin closing.
	const child: ChildProcess = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	// A request written after the proxy has gone (a retry an interruption left running) is dropped.
	child.stdin?.on("error", () => {});
	let buffer = "";
	let nextId = 0;
	const pending = new Map<number, Pending>();

	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length === 0) continue;
			try {
				const message = JSON.parse(line) as JsonRpcResponse;
				if (message.id !== undefined && pending.has(message.id)) {
					pending.get(message.id)!.resolve(message);
					pending.delete(message.id);
				}
			} catch {
				// Not JSON: the proxy occasionally logs to stdout.
			}
		}
	});
	child.stderr?.on("data", () => {});

	const request = (method: string, params: unknown, timeoutMs = 60_000): Promise<JsonRpcResponse> =>
		new Promise((resolvePromise, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolvePromise(message);
				},
			});
			child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});

	await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "flamework-test", version: "1" },
	});
	child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

	const callRaw: StudioClient["callRaw"] = async (name, args = {}, timeoutMs) => {
		const response = await request("tools/call", { name, arguments: args }, timeoutMs);
		if (response.error !== undefined) throw new Error(`${name}: ${rpcErrorMessage(response.error)}`);
		return response.result ?? {};
	};

	const call: StudioClient["call"] = async (name, args = {}, timeoutMs) => {
		const result = await callRaw(name, args, timeoutMs);
		const text = textOf(result);
		if (result.isError) throw new Error(`${name}: ${text}`);
		return text;
	};

	const tools: StudioClient["tools"] = async () => {
		const response = await request("tools/list", {}, 30_000);
		if (response.error !== undefined) throw new Error(`tools/list: ${rpcErrorMessage(response.error)}`);
		return response.result?.tools ?? [];
	};

	const studios: StudioClient["studios"] = async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				const parsed = JSON.parse(await call("list_roblox_studios", {}, 15_000)) as {
					studios?: Array<{ id: string; name: string | null }>;
				};
				// A window still loading its place is listed with no name yet.
				return (parsed.studios ?? []).map((entry) => ({ id: entry.id, name: entry.name ?? "" }));
			} catch (error) {
				lastError = error;
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};

	const exited = new Promise<void>((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) resolveExit();
		// Typed without its EventEmitter side here, which it has.
		(child as unknown as EventEmitter).once("exit", () => resolveExit());
	});
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> =>
		(closing ??= (async () => {
			try {
				child.stdin?.end();
			} catch {
				// Gone already.
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const graceful = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolveWait) => {
					timer = setTimeout(() => resolveWait(false), PROXY_CLOSE_GRACE_MS);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			if (!graceful) child.kill();
		})());

	return {
		call,
		callRaw,
		tools,
		studios,
		close,
		...(child.pid !== undefined ? { pid: child.pid } : {}),
	};
}
