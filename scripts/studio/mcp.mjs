// Drives Roblox Studio through Roblox's own MCP proxy (StudioMCP.exe) over stdio JSON-RPC, so the
// Studio battletest can run from a terminal or another script without an MCP-aware client.
//
//   node scripts/studio/mcp.mjs --studios                       list connected Studio instances
//   node scripts/studio/mcp.mjs --tools                         list the proxy's tools
//   node scripts/studio/mcp.mjs <tool> '<json arguments>'       call one tool
//   node scripts/studio/mcp.mjs --luau <Edit|Client|Server> <file.luau> [studio name]
//
// The proxy joins a hub that the Studio plugin is connected to; that takes a moment, so calls are
// retried until Studio answers. Requires Studio with "MCP server" enabled in its Assistant settings.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export function findStudioMcp() {
	const fromEnv = process.env.STUDIO_MCP_EXE;
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
	const versions = path.join(
		process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
		"Roblox",
		"Versions",
	);
	const candidates = fs.existsSync(versions)
		? fs
				.readdirSync(versions)
				.map((v) => path.join(versions, v, "StudioMCP.exe"))
				.filter((p) => fs.existsSync(p))
				.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
		: [];
	if (candidates.length === 0) throw new Error(`StudioMCP.exe not found under ${versions}; set STUDIO_MCP_EXE`);
	return candidates[0];
}

/** One proxy process with the JSON-RPC handshake done. Call `close()` when finished. */
export async function connect() {
	const child = spawn(findStudioMcp(), [], { stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "";
	let nextId = 0;
	const pending = new Map();
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			try {
				const message = JSON.parse(line);
				if (message.id !== undefined && pending.has(message.id)) {
					pending.get(message.id)(message);
					pending.delete(message.id);
				}
			} catch {
				// Not JSON: the proxy occasionally logs to stdout.
			}
		}
	});
	child.stderr.on("data", () => {});

	const request = (method, params, timeoutMs = 60_000) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});

	await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "flamework-studio-tests", version: "1" },
	});
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

	/** Calls a tool and returns its text content; throws on an error result. */
	async function call(name, args = {}, timeoutMs) {
		const response = await request("tools/call", { name, arguments: args }, timeoutMs);
		if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
		const text = (response.result?.content ?? [])
			.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
			.join("\n");
		if (response.result?.isError) throw new Error(`${name}: ${text}`);
		return text;
	}

	/** Lists Studio instances, retrying while the proxy is still joining the hub. */
	async function studios(attempts = 20) {
		for (let i = 0; i < attempts; i++) {
			try {
				return JSON.parse(await call("list_roblox_studios", {}, 15_000)).studios;
			} catch (error) {
				if (i === attempts - 1) throw error;
				await new Promise((r) => setTimeout(r, 500));
			}
		}
	}

	async function studioId(name) {
		const list = await studios();
		const match = list.find((s) => s.name === name || s.name.startsWith(`${name} `) || s.id === name);
		if (!match)
			throw new Error(`no Studio named '${name}'; connected: ${list.map((s) => s.name).join(", ") || "none"}`);
		return match.id;
	}

	/**
	 * The Studio to drive: the one named, or the only one connected. With several connected and
	 * no name given this refuses rather than guessing, since a Play or Run session in the wrong
	 * window would act on someone's real place.
	 */
	async function pickStudio(name) {
		if (name !== undefined) return studioId(name);
		const list = await studios();
		if (list.length === 1) return list[0].id;
		throw new Error(
			list.length === 0
				? "no Studio is connected; enable 'MCP server' in Studio's Assistant settings"
				: `several Studios are connected, pass --studio <name|id>: ${list.map((s) => s.name).join(", ")}`,
		);
	}

	return {
		call,
		studios,
		studioId,
		pickStudio,
		tools: async () => (await request("tools/list", {})).result.tools,
		luau: (studio_id, datamodel_type, code, timeoutMs) =>
			call("execute_luau", { studio_id, datamodel_type, code }, timeoutMs),
		close: () => child.kill(),
	};
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
	const [mode, a, b, c] = process.argv.slice(2);
	const mcp = await connect();
	try {
		if (mode === "--studios") console.log(JSON.stringify(await mcp.studios(), null, 1));
		else if (mode === "--tools")
			console.log(
				(await mcp.tools()).map((t) => `${t.name}(${(t.inputSchema.required ?? []).join(", ")})`).join("\n"),
			);
		else if (mode === "--luau") console.log(await mcp.luau(await mcp.pickStudio(c), a, fs.readFileSync(b, "utf8")));
		else if (mode) console.log(await mcp.call(mode, JSON.parse(a ?? "{}")));
		else console.log("usage: mcp.mjs --studios | --tools | --luau <DM> <file> [studio] | <tool> [json]");
	} finally {
		mcp.close();
	}
}
