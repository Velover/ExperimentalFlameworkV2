// Runs the Studio battletest: starts a play session in the given Studio instance, collects the
// `[FWTEST]` lines the template's test providers print, stops the session and exits non-zero on
// any failure. See docs/testing/studio.md for the setup this expects.
//
//   node scripts/studio/run-studio-tests.mjs [--studio Place1] [--streaming on|off|keep] [--wait 30]
//
// `--streaming` flips Workspace.StreamingEnabled in the Edit data model before the run and restores
// the previous value afterwards, so both halves of the streaming matrix can be run unattended.
import { connect } from "./mcp.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const studioName = option("studio", "Place1");
const streaming = option("streaming", "keep");
const waitSeconds = Number(option("wait", "30"));

const mcp = await connect();
const studio_id = await mcp.studioId(studioName);
const edit = (code) => mcp.luau(studio_id, "Edit", code);

let previousStreaming;
let started = false;
let exitCode = 1;

try {
	const state = await mcp.call("get_studio_state", { studio_id });
	if (/Current Studio Mode: Play/.test(state)) {
		console.log("stopping a play session that was still running");
		await mcp.call("start_stop_play", { studio_id, is_start: false }, 90_000);
	}

	if (streaming !== "keep") {
		previousStreaming = (await edit("return tostring(workspace.StreamingEnabled)")).trim() === "true";
		await edit(`workspace.StreamingEnabled = ${streaming === "on"}`);
		console.log(`StreamingEnabled set to ${streaming === "on"} (was ${previousStreaming})`);
	}

	console.log(`starting play in '${studioName}' and waiting ${waitSeconds}s for the test providers`);
	await mcp.call("start_stop_play", { studio_id, is_start: true }, 120_000);
	started = true;
	await new Promise((r) => setTimeout(r, waitSeconds * 1000));

	const output = await mcp.call("get_console_output", { studio_id }, 60_000);
	const lines = output.split(/\r?\n/);
	const results = lines.filter((line) => line.includes("[FWTEST]"));
	const others = lines.filter((line) => line.trim() !== "" && !line.includes("[FWTEST]"));

	for (const line of results) console.log(line);
	if (others.length > 0) {
		console.log("\nother console output:");
		for (const line of others) console.log("  " + line);
	}

	const failures = results.filter((line) => /: FAIL/.test(line));
	const summaries = ["server", "client"].filter((realm) =>
		results.some((line) => line.includes(`] ${realm} SUMMARY:`)),
	);
	const missing = ["server", "client"].filter((realm) => !summaries.includes(realm));

	console.log("");
	if (missing.length > 0) {
		console.log(`no SUMMARY line from: ${missing.join(", ")} -- ignition stalled or the run needs a longer --wait`);
	}
	console.log(`${failures.length} failing check(s), summaries from: ${summaries.join(", ") || "none"}`);
	exitCode = failures.length === 0 && missing.length === 0 ? 0 : 1;
} finally {
	if (started) await mcp.call("start_stop_play", { studio_id, is_start: false }, 90_000).catch(() => {});
	if (previousStreaming !== undefined) {
		await edit(`workspace.StreamingEnabled = ${previousStreaming}`).catch(() => {});
		console.log(`StreamingEnabled restored to ${previousStreaming}`);
	}
	mcp.close();
}

process.exit(exitCode);
