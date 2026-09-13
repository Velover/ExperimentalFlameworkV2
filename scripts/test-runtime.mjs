import { spawn, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The single-realm suites, once per realm. A realm's module graph caches decisions made at require
 * time, so each one needs a fresh graph and therefore a fresh process.
 *
 * The replication run builds two graphs inside one process instead, and covers the traffic between
 * them that neither single-realm run can see.
 */
const RUNS = [
	["tests/runtime/main.luau", "Server"],
	["tests/runtime/main.luau", "Client"],
	["tests/runtime/replication.luau"],
];

/**
 * How long one run may take before it is killed and reported, with the last case it printed. The
 * runner times every case out on its own (30s each), so this only ever fires on a hang the runner
 * cannot see -- a process that will not exit, a harness that stalls between cases.
 */
const RUN_TIMEOUT_MS = Number(process.env.FLAMEWORK_RUNTIME_TIMEOUT_MS) || 10 * 60 * 1000;

/** The last line a run printed that names a case, so a hang can be placed. */
function lastCaseLine(output) {
	const lines = output.split(/\r?\n/).filter((line) => /^\s+(pass|FAIL|HANG)\s+/.test(line));
	return lines.length > 0 ? lines[lines.length - 1].trim() : undefined;
}

function killTree(child) {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		child.kill("SIGKILL");
	}
}

function run(script, args) {
	return new Promise((resolve) => {
		const child = spawn("lune", ["run", script, ...args], { cwd: root, shell: true });
		let output = "";
		let timedOut = false;

		const remember = (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stdout.write(text);
		};
		child.stdout.on("data", remember);
		child.stderr.on("data", remember);

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, RUN_TIMEOUT_MS);

		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ error });
		});

		child.on("close", (status) => {
			clearTimeout(timer);

			if (timedOut) {
				const last = lastCaseLine(output);
				console.error(
					`\x1b[31m[test]\x1b[0m lune run ${script} ${args.join(" ")} did not finish within ${RUN_TIMEOUT_MS / 1000}s and was killed.`,
				);
				console.error(
					last === undefined
						? "\x1b[31m[test]\x1b[0m it printed no case at all"
						: /\d+ passed, \d+ failed/.test(output)
							? `\x1b[31m[test]\x1b[0m it had printed its summary: the process would not exit. Last case: ${last}`
							: `\x1b[31m[test]\x1b[0m last case it reported: ${last} -- the case after it is hanging`,
				);
				resolve({ status: 1 });
				return;
			}

			resolve({ status });
		});
	});
}

let failed = false;

for (const [script, ...args] of RUNS) {
	const result = await run(script, args);

	if (result.error) {
		console.error(
			"\x1b[31m[test]\x1b[0m could not run lune. Install it from https://lune-org.github.io/docs and make sure it is on PATH.",
		);
		process.exit(1);
	}

	if (result.status !== 0) {
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
