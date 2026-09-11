// Runs Luau snippets inside a real Roblox Studio, one at a time, each in a chosen realm, and
// reports PASS/FAIL per snippet. It exists because the Lune suites run against a stub Roblox: the
// engine defers signals, replicates, streams and starts scripts in an order no stub reproduces, so
// a hypothesis about v2's behaviour is only settled by running it in game.
//
// Everything goes through Roblox's own MCP proxy (see mcp.mjs), so the only thing a run needs is a
// Studio with "MCP server" enabled in its Assistant settings, and its id or name.
//
//   node scripts/studio/luau-tests.mjs --code "return 1 + 1"              one snippet, console realm
//   node scripts/studio/luau-tests.mjs cases/deferred.luau --mode server  one file, server-only
//   node scripts/studio/luau-tests.mjs cases                              every .luau in a folder
//   node scripts/studio/luau-tests.mjs cases/networking.mjs               a JS-declared case list
//   node scripts/studio/luau-tests.mjs cases --studio df44ebbb-...        pick the Studio by id
//
// Realms (`--mode`, or `-- @mode <realm>` in a .luau header, or `mode:` in a .mjs case):
//
//   console | edit  the Edit data model, no session. Fast, no engine loop, no Players.
//   server          Studio's *Run* mode: server scripts live, no client, no player. Started with
//                   RunService:Run(), which the MCP's execution context is allowed to call --
//                   start_stop_play only gives Play Solo. NOTE Run mode uses the *edit* data model:
//                   what a case builds there is still there after the session stops (hence the
//                   sweep below), and RunService:IsClient() is true even though no client exists.
//   client          Play Solo, snippet executed in the Client data model (a server exists too).
//   play-server     Play Solo, snippet executed in the Server data model.
//   both            Play Solo, the same snippet run in Server and in Client, reported separately.
//
// Cases are grouped by the session they need (none -> Run -> Play) so a session is started once per
// group rather than once per case. Within a group each case is sent on its own and fully awaited --
// the MCP call only returns once the snippet has stopped yielding -- so cases never overlap.
//
// Inside a snippet:
//   check(name, condition, detail?)  records a check; any failing check fails the case
//   log(...)                         records a line
//   defer(fn)                        runs fn after the body, in reverse order, even on error;
//                                    an error thrown in one fails the case
//   scratch()                        a Folder in Workspace made on first use and destroyed after
// Anything the snippet returns comes back as the case's value. Yielding is fine (`task.wait`,
// signals, `WaitForChild`); the case's own timeout bounds it.
//
// Cleanup is not left to the case alone: the wrapper notes every direct child of the usual service
// containers and every CollectionService tag before the body runs, and afterwards destroys the
// instances and removes the tags that appeared (reported as `swept`). `--keep-leftovers` turns that
// into a report without the destroying. Play sessions are thrown away wholesale, so the sweep only
// matters for `console` and `server`, which act on the real place.
//
// A case that exceeds its timeout (`--timeout`, `timeout:`, `-- @timeout`, default 30s) is
// cancelled, its cleanup still runs, and the whole run is aborted: a snippet that hung has likely
// left the data model in a state the later cases would only report noise about.
import fs from "fs";
import path from "path";
import { connect } from "./mcp.mjs";

const MODES = {
	console: { session: "none", datamodel: "Edit" },
	edit: { session: "none", datamodel: "Edit" },
	server: { session: "run", datamodel: "Edit" },
	client: { session: "play", datamodel: "Client" },
	"play-server": { session: "play", datamodel: "Server" },
	play: { session: "play", datamodel: "Server" },
	both: { session: "play", datamodel: ["Server", "Client"] },
};
const SESSION_ORDER = ["none", "run", "play"];
const DEFAULT_TIMEOUT = 30;

// Injected before every snippet; the runner subtracts its line count from the line numbers Studio
// reports so an error points at the case's own source. One statement per line keeps that mapping
// honest, which is why the helpers are written flat.
const PRELUDE = `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local __logs, __checks, __deferred, __cleanupErrors = {}, {}, {}, {}
local function log(...) local n = select("#", ...) local parts = table.create(n) for i = 1, n do parts[i] = tostring((select(i, ...))) end table.insert(__logs, table.concat(parts, " ")) end
local function check(name, condition, detail) table.insert(__checks, { name = name, pass = not not condition, detail = detail ~= nil and tostring(detail) or nil }) return not not condition end
local function defer(fn) table.insert(__deferred, fn) end
local __scratch = nil
local function scratch() if not __scratch then __scratch = Instance.new("Folder") __scratch.Name = "__LuauTestScratch" __scratch.Parent = workspace end return __scratch end
local function __safe(v) local t = typeof(v) if v == nil or t == "string" or t == "boolean" then return v end if t == "number" then return (v ~= v or v == math.huge or v == -math.huge) and tostring(v) or v end if t == "table" and pcall(HttpService.JSONEncode, HttpService, v) then return v end return tostring(v) end
local __containers = { workspace, game:GetService("ReplicatedStorage"), game:GetService("ReplicatedFirst"), game:GetService("ServerStorage"), game:GetService("ServerScriptService"), game:GetService("Lighting"), game:GetService("SoundService"), game:GetService("StarterGui"), game:GetService("StarterPack") }
local function __snapshot() local seen = {} for _, container in __containers do for _, child in container:GetChildren() do seen[child] = true end end return seen end
local function __tagSnapshot() local seen = {} for _, tag in CollectionService:GetAllTags() do seen[tag] = true end return seen end
for _, container in __containers do local stale = container:FindFirstChild("__LuauTestScratch") if stale then stale:Destroy() end end
local __before, __beforeTags = __snapshot(), __tagSnapshot()
local __clock = os.clock()
local __state = { done = false }
local __body = function()
`;
const PRELUDE_LINES = PRELUDE.split("\n").length - 1;

// `%TIMEOUT%` is replaced per case. task.spawn runs the body inline until its first yield, so a
// snippet that never yields is finished before the watchdog loop is even reached.
const EPILOGUE = `
end
local __co = task.spawn(function() local ok, value = pcall(__body) __state.done, __state.ok, __state.value = true, ok, value end)
local __deadline = os.clock() + %TIMEOUT%
while not __state.done and os.clock() < __deadline do task.wait(0.05) end
local __timedOut = not __state.done
if __timedOut then pcall(task.cancel, __co) end
local __ms = math.round((os.clock() - __clock) * 1000)
for i = #__deferred, 1, -1 do local ok, err = pcall(__deferred[i]) if not ok then table.insert(__cleanupErrors, tostring(err)) end end
if __scratch then pcall(function() __scratch:Destroy() end) end
local __swept, __left = {}, {}
local __sweep = %SWEEP%
for _, container in __containers do
	for _, child in container:GetChildren() do
		if not __before[child] then
			table.insert(__sweep and __swept or __left, container.Name .. "." .. child.Name)
			if __sweep then pcall(function() child:Destroy() end) end
		end
	end
end
for _, tag in CollectionService:GetAllTags() do
	if not __beforeTags[tag] then
		table.insert(__sweep and __swept or __left, "tag:" .. tag)
		if __sweep then for _, tagged in CollectionService:GetTagged(tag) do pcall(function() CollectionService:RemoveTag(tagged, tag) end) end end
	end
end
local __result = {
	ok = __state.ok == true and not __timedOut,
	timedOut = __timedOut or nil,
	error = (__timedOut and "timed out" or nil) or (__state.ok == false and tostring(__state.value) or nil),
	value = __state.ok == true and __safe(__state.value) or nil,
	logs = __logs,
	checks = __checks,
	swept = __swept,
	leftovers = __left,
	cleanupErrors = __cleanupErrors,
	ms = __ms,
	realm = {
		isServer = RunService:IsServer(),
		isClient = RunService:IsClient(),
		isRunning = RunService:IsRunning(),
		players = #Players:GetPlayers(),
		localPlayer = Players.LocalPlayer ~= nil and Players.LocalPlayer.Name or nil,
	},
}
local __encoded, __text = pcall(HttpService.JSONEncode, HttpService, __result)
if __encoded then return __text end
__result.value = tostring(__result.value)
return HttpService:JSONEncode(__result)`;

export function wrap(code, { timeout = DEFAULT_TIMEOUT, sweep = true } = {}) {
	return PRELUDE + code + EPILOGUE.replace("%TIMEOUT%", String(timeout)).replace("%SWEEP%", sweep ? "true" : "false");
}

/** Reads `-- @mode server` / `-- @timeout 30` / `-- @skip` headers off the top of a .luau file. */
function headers(source) {
	const options = {};
	for (const line of source.split(/\r?\n/)) {
		const match = /^\s*--\s*@(\w+)\s*(.*)$/.exec(line);
		if (!match) {
			if (line.trim() !== "" && !line.trim().startsWith("--")) break;
			continue;
		}
		const [, key, value] = match;
		options[key] =
			key === "timeout"
				? Number(value)
				: key === "skip"
					? true
					: key === "sweep"
						? value.trim() !== "false"
						: value.trim();
	}
	return options;
}

/** Turns a .luau file, a folder of them, or a .mjs case list into `{ name, mode, code }` cases. */
export async function collectCases(target) {
	if (fs.statSync(target).isDirectory()) {
		const entries = fs
			.readdirSync(target)
			.filter((f) => f.endsWith(".luau") || f.endsWith(".cases.mjs"))
			.sort();
		return (await Promise.all(entries.map((f) => collectCases(path.join(target, f))))).flat();
	}
	if (target.endsWith(".mjs") || target.endsWith(".js")) {
		const module = await import(`file://${path.resolve(target).replace(/\\/g, "/")}`);
		const declared = module.cases ?? module.default;
		const list = typeof declared === "function" ? await declared() : declared;
		if (!Array.isArray(list))
			throw new Error(`${target} must export an array of cases, or a function returning one`);
		return list.map((testCase, index) => ({
			name: testCase.name ?? `${path.basename(target)}#${index + 1}`,
			code: testCase.code ?? fs.readFileSync(path.resolve(path.dirname(target), testCase.file), "utf8"),
			mode: testCase.mode,
			timeout: testCase.timeout,
			skip: testCase.skip,
			sweep: testCase.sweep,
		}));
	}
	const source = fs.readFileSync(target, "utf8");
	const options = headers(source);
	return [
		{
			name: options.name ?? path.basename(target, ".luau"),
			code: source,
			mode: options.mode,
			timeout: options.timeout,
			skip: options.skip,
			sweep: options.sweep,
		},
	];
}

/** Console output arrives as the whole log every time; keep only what appeared since the last read. */
function newLines(previous, current) {
	const before = previous.split(/\r?\n/);
	const after = current.split(/\r?\n/);
	let index = 0;
	while (index < before.length && index < after.length && before[index] === after[index]) index++;
	return after.slice(index).filter((line) => line.trim() !== "");
}

function mapLines(text, caseName) {
	return String(text).replace(
		/AssistantCommand:(\d+)/g,
		(_, n) => `${caseName}:${Math.max(1, Number(n) - PRELUDE_LINES)}`,
	);
}

/**
 * Runs the cases against one Studio instance, switching sessions only when the next group needs a
 * different one. Returns one result per case (two for `both`), in the order they ran.
 */
export async function runCases(mcp, studio_id, cases, options = {}) {
	const {
		defaultMode = "console",
		defaultTimeout = DEFAULT_TIMEOUT,
		settleSeconds = 0,
		keepOpen = false,
		keepLeftovers = false,
		onResult,
	} = options;
	const edit = (code, timeoutMs) => mcp.luau(studio_id, "Edit", code, timeoutMs);
	const state = () => mcp.call("get_studio_state", { studio_id }, 30_000);
	const isPlaying = async () => /Current Studio Mode:\s*Play/i.test(await state());
	const isRunning = async () =>
		(await edit("return tostring(game:GetService('RunService'):IsRunning())")).includes("true");

	async function stopEverything() {
		if (await isPlaying()) await mcp.call("start_stop_play", { studio_id, is_start: false }, 120_000);
		if (await isRunning()) await edit("game:GetService('RunService'):Stop()");
	}

	async function enter(session) {
		await stopEverything();
		if (session === "run") {
			// Play Solo is all start_stop_play offers; Run mode (a server with no client) is only
			// reachable through RunService:Run(), which this execution context may call.
			await edit("game:GetService('RunService'):Run()");
			for (let i = 0; i < 40 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 250));
			if (!(await isRunning())) throw new Error("Run mode did not start");
		} else if (session === "play") {
			await mcp.call("start_stop_play", { studio_id, is_start: true }, 180_000);
			for (let i = 0; i < 80; i++) {
				const current = await state();
				if (/Client/.test(current) && /Server/.test(current)) break;
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		if (session !== "none" && settleSeconds > 0) await new Promise((r) => setTimeout(r, settleSeconds * 1000));
	}

	const groups = new Map(SESSION_ORDER.map((session) => [session, []]));
	for (const testCase of cases) {
		const modeName = testCase.mode ?? defaultMode;
		const mode = MODES[modeName];
		if (!mode)
			throw new Error(
				`case '${testCase.name}': unknown mode '${modeName}' (have ${Object.keys(MODES).join(", ")})`,
			);
		groups.get(mode.session).push({ ...testCase, modeName, mode });
	}

	const results = [];
	let consoleText = "";
	let started = false;
	let aborted;
	try {
		for (const session of SESSION_ORDER) {
			const group = groups.get(session);
			if (group.length === 0) continue;
			// After an abort the remaining groups are still walked, so every case that did not run
			// is reported rather than silently missing; no session is started for them.
			if (!aborted) {
				await enter(session);
				started = started || session !== "none";
				consoleText = await mcp.call("get_console_output", { studio_id }, 60_000).catch(() => consoleText);
			}

			for (const testCase of group) {
				if (aborted) {
					results.push({ name: testCase.name, mode: testCase.modeName, aborted: true });
					onResult?.(results[results.length - 1]);
					continue;
				}
				const datamodels = Array.isArray(testCase.mode.datamodel)
					? testCase.mode.datamodel
					: [testCase.mode.datamodel];
				for (const datamodel of datamodels) {
					const label =
						datamodels.length > 1 ? `${testCase.name} [${datamodel.toLowerCase()}]` : testCase.name;
					if (testCase.skip) {
						results.push({ name: label, mode: testCase.modeName, skipped: true });
						onResult?.(results[results.length - 1]);
						continue;
					}
					const timeout = testCase.timeout ?? defaultTimeout;
					const code = wrap(testCase.code, { timeout, sweep: !keepLeftovers && testCase.sweep !== false });
					let parsed;
					try {
						// The snippet watchdogs itself; this bound only catches a Studio that stopped
						// answering, which no later case could survive either.
						const text = await mcp.luau(studio_id, datamodel, code, timeout * 1000 + 20_000);
						const start = text.indexOf("{");
						const end = text.lastIndexOf("}");
						parsed =
							start >= 0 && end > start
								? JSON.parse(text.slice(start, end + 1))
								: { ok: false, error: `no result payload; Studio said: ${text.trim()}` };
					} catch (error) {
						parsed = { ok: false, timedOut: true, error: String(error.message ?? error) };
					}

					const after = await mcp.call("get_console_output", { studio_id }, 60_000).catch(() => consoleText);
					const output = newLines(consoleText, after);
					consoleText = after;

					const checks = parsed.checks ?? [];
					const result = {
						name: label,
						mode: testCase.modeName,
						datamodel,
						// A case that could not clean up after itself is not a pass: the next case
						// would be running against whatever it left.
						pass:
							parsed.ok === true &&
							checks.every((check) => check.pass) &&
							(parsed.cleanupErrors ?? []).length === 0,
						timedOut: parsed.timedOut ?? false,
						error: parsed.error ? mapLines(parsed.error, label) : undefined,
						value: parsed.value,
						checks,
						logs: parsed.logs ?? [],
						output: output.map((line) => mapLines(line, label)),
						swept: parsed.swept ?? [],
						leftovers: parsed.leftovers ?? [],
						cleanupErrors: parsed.cleanupErrors ?? [],
						ms: parsed.ms,
						realm: parsed.realm,
					};
					results.push(result);
					onResult?.(result);
					// A hung snippet leaves the data model in a state later cases would only report
					// noise about, so one timeout ends the run.
					if (result.timedOut) aborted = label;
				}
			}
		}
	} finally {
		if (!keepOpen && started) await stopEverything().catch(() => {});
	}
	if (aborted) results.aborted = aborted;
	return results;
}

/** One-call entry point for other scripts: opens the proxy, runs the cases, closes it. */
export async function runLuauTests({ studio, cases, ...options }) {
	const mcp = await connect();
	try {
		return await runCases(mcp, await mcp.pickStudio(studio), cases, options);
	} finally {
		mcp.close();
	}
}

const VALUE_FLAGS = new Set(["studio", "mode", "only", "wait", "timeout", "code", "name"]);
const BOOL_FLAGS = new Set(["keep-open", "keep-leftovers", "json", "list", "help"]);

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
	const flags = {};
	const targets = [];
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			targets.push(arg);
			continue;
		}
		const key = arg.slice(2);
		if (VALUE_FLAGS.has(key)) flags[key] = argv[++i];
		else if (BOOL_FLAGS.has(key)) flags[key] = true;
		else {
			console.error(`unknown flag ${arg}`);
			process.exit(2);
		}
	}

	if (flags.help || (targets.length === 0 && flags.code === undefined)) {
		console.log(
			[
				"usage: luau-tests.mjs <file.luau | folder | cases.mjs>... [options]",
				"       luau-tests.mjs --code '<luau>' [--mode <realm>]",
				"",
				`  --mode <realm>     default realm: ${Object.keys(MODES).join(" | ")}`,
				"  --studio <id|name> Studio instance; required when several are connected (mcp.mjs --studios)",
				`  --timeout <s>      per-case timeout (default ${DEFAULT_TIMEOUT}); one timeout aborts the run`,
				"  --wait <s>         settle time after a session starts, before the first case",
				"  --only <substring> run only the cases whose name contains this",
				"  --keep-open        leave the session running at the end",
				"  --keep-leftovers   report what a case left behind instead of destroying it",
				"  --list, --json     list the collected cases / print results as JSON",
			].join("\n"),
		);
		process.exit(targets.length === 0 && flags.code === undefined && !flags.help ? 2 : 0);
	}

	const defaultMode = flags.mode ?? "console";
	let cases = flags.code
		? [{ name: flags.name ?? "inline", code: flags.code }]
		: (await Promise.all(targets.map(collectCases))).flat();
	if (flags.only) cases = cases.filter((testCase) => testCase.name.includes(flags.only));
	if (cases.length === 0) {
		console.error("no cases matched");
		process.exit(2);
	}
	if (flags.list) {
		for (const testCase of cases) console.log(`${testCase.mode ?? defaultMode}\t${testCase.name}`);
		process.exit(0);
	}

	const mcp = await connect();
	let results = [];
	try {
		const studio_id = await mcp.pickStudio(flags.studio);
		results = await runCases(mcp, studio_id, cases, {
			defaultMode,
			defaultTimeout: flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT,
			settleSeconds: Number(flags.wait ?? "0"),
			keepOpen: flags["keep-open"] === true,
			keepLeftovers: flags["keep-leftovers"] === true,
			onResult: (result) => {
				if (flags.json) return;
				if (result.skipped) return console.log(`SKIP  [${result.mode}] ${result.name}`);
				if (result.aborted) return console.log(`ABORT [${result.mode}] ${result.name} (run stopped earlier)`);
				console.log(
					`${result.timedOut ? "TIME" : result.pass ? "PASS" : "FAIL"}  [${result.mode}] ${result.name} (${result.ms ?? "?"}ms)`,
				);
				for (const check of result.checks)
					console.log(
						`        ${check.pass ? "ok" : "NOT OK"} ${check.name}${check.detail ? ` -- ${check.detail}` : ""}`,
					);
				for (const line of result.logs) console.log(`        . ${line}`);
				if (result.value !== undefined && result.value !== null)
					console.log(
						`        = ${typeof result.value === "object" ? JSON.stringify(result.value) : result.value}`,
					);
				if (result.error) console.log(`        ! ${result.error}`);
				for (const line of result.output) console.log(`        | ${line}`);
				for (const error of result.cleanupErrors) console.log(`        ! cleanup: ${error}`);
				if (result.swept.length > 0) console.log(`        ~ swept ${result.swept.join(", ")}`);
				if (result.leftovers.length > 0) console.log(`        ~ left behind ${result.leftovers.join(", ")}`);
			},
		});
	} finally {
		mcp.close();
	}

	if (flags.json) console.log(JSON.stringify({ aborted: results.aborted, results }, null, 1));
	const ran = results.filter((result) => !result.skipped && !result.aborted);
	const failures = ran.filter((result) => !result.pass);
	if (!flags.json) {
		if (results.aborted) console.log(`\nrun aborted after '${results.aborted}' timed out`);
		console.log(`${ran.length - failures.length}/${ran.length} passed`);
	}
	process.exit(failures.length === 0 && !results.aborted ? 0 : 1);
}
