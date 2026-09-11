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
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One entry of `list_roblox_studios`: the id every other call takes, and a name carrying the place id. */
export interface StudioEntry {
	id: string;
	name: string;
}

export type DataModelType = "Edit" | "Client" | "Server";

/** A connected proxy. Call `close()` when finished, it holds a child process. */
export interface StudioClient {
	/** Calls one MCP tool and returns its text content; throws on an error result. */
	call: (name: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<string>;
	/** Lists the connected Studio windows, retrying while the proxy is still joining the hub. */
	studios: () => Promise<StudioEntry[]>;
	close: () => void;
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
 */
export function renderStudioRun(filter: string, options: string): string {
	return [
		'local host = workspace:WaitForChild("FlameworkTests", 30)',
		'if not host then error("Workspace.FlameworkTests did not appear within 30 seconds: is the testing scope active in this build, and is TestingPlugin included?") end',
		`return game:GetService("HttpService"):JSONEncode(host:Invoke(${filter}, ${options}))`,
	].join("\n");
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

// ----------------------------------------------------------------- the proxy

interface Pending {
	resolve: (message: JsonRpcResponse) => void;
}

interface JsonRpcResponse {
	id?: number;
	result?: {
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
		tools?: unknown[];
	};
	error?: unknown;
}

/** Spawns the proxy, does the MCP handshake and returns a client over it. */
export async function connectStudio(exe: string): Promise<StudioClient> {
	const child: ChildProcess = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
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

	const call: StudioClient["call"] = async (name, args = {}, timeoutMs) => {
		const response = await request("tools/call", { name, arguments: args }, timeoutMs);
		if (response.error !== undefined) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
		const text = (response.result?.content ?? [])
			.map((entry) => (entry.type === "text" ? (entry.text ?? "") : JSON.stringify(entry)))
			.join("\n");
		if (response.result?.isError) throw new Error(`${name}: ${text}`);
		return text;
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

	return {
		call,
		studios,
		close: () => {
			child.kill();
		},
	};
}
