import { RunService, Workspace } from "@rbxts/services";
import { getSections, type Section, type TestDefinition } from "./registry";

export type Realm = "server" | "client";

/**
 * Which tests to run: nothing for every section, `"economy"` for one section, `"economy/buys"`
 * for one test, or a list of those.
 */
export type TestFilter = string | readonly string[] | undefined;

export interface RunOptions {
	/** Report the selected sections and tests without running anything. */
	list?: boolean;
}

export interface TestResult {
	name: string;
	ok: boolean;
	/** The failure: the raised message with a traceback, a timeout, or a cleanup that raised. */
	error?: string;
	durationMs: number;
}

export interface SectionResult {
	name: string;
	passed: number;
	failed: number;
	tests: TestResult[];
}

/** JSON-safe, so it can travel through a RemoteFunction or be encoded for an Open Cloud task. */
export interface RunResult {
	/** No test failed and every filter entry matched something. */
	ok: boolean;
	realm: Realm;
	/** Set when `list` was asked for: nothing ran. */
	listed?: boolean;
	passed: number;
	failed: number;
	durationMs: number;
	sections: SectionResult[];
	/** Filter entries that named no section or test. Any makes `ok` false. */
	unknown: string[];
}

export interface RunnerConfig {
	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout: number;
}

/** The default `testing.timeout`. */
export const DEFAULT_TIMEOUT = 30;

const SCRATCH_NAME = "FlameworkTestScratch";

interface ActiveTest {
	deferred: Array<() => void>;
	scratch?: Folder;
}

let activeTest: ActiveTest | undefined;
let running = false;

export function getRealm(): Realm {
	return RunService.IsServer() ? "server" : "client";
}

/**
 * Registers cleanup for the running test: a connection to disconnect, an instance to destroy, a
 * state to restore. Deferred callbacks run in reverse order once the test is over, whether it
 * passed, failed or timed out, and one that raises fails the test.
 */
export function defer(callback: () => void) {
	if (activeTest === undefined) {
		error("defer() can only be called while a test is running", 2);
	}

	activeTest.deferred.push(callback);
}

/**
 * A Folder in Workspace for whatever the running test needs to build, created on first use and
 * destroyed with everything in it once the test is over.
 */
export function scratch(): Folder {
	if (activeTest === undefined) {
		error("scratch() can only be called while a test is running", 2);
	}

	if (activeTest.scratch === undefined) {
		const folder = new Instance("Folder");
		folder.Name = SCRATCH_NAME;
		folder.Parent = Workspace;
		activeTest.scratch = folder;
	}

	return activeTest.scratch;
}

interface Selected {
	section: Section;
	tests: TestDefinition[];
}

interface Selection {
	sections: Selected[];
	unknown: string[];
}

function selectTests(filter: TestFilter): Selection {
	const all = getSections();
	if (filter === undefined) {
		return { sections: all.map((section) => ({ section, tests: [...section.tests] })), unknown: [] };
	}

	if (!typeIs(filter, "string") && !typeIs(filter, "table")) {
		error(`a filter is a section name, a 'section/test' name or a list of those, got ${typeOf(filter)}`, 3);
	}

	const entries: readonly string[] = typeIs(filter, "string") ? [filter] : filter;
	const picked = new Map<Section, TestDefinition[] | "all">();
	const unknown = new Array<string>();

	for (const entry of entries) {
		if (!typeIs(entry, "string")) {
			error(`a filter entry must be a string, got ${typeOf(entry)}`, 3);
		}

		const [slash] = entry.find("/", 1, true);
		const sectionName = slash !== undefined ? entry.sub(1, slash - 1) : entry;
		const testName = slash !== undefined ? entry.sub(slash + 1) : undefined;

		const section = all.find((candidate) => candidate.name === sectionName);
		if (section === undefined) {
			unknown.push(entry);
			continue;
		}

		if (testName === undefined) {
			picked.set(section, "all");
			continue;
		}

		const found = section.tests.find((candidate) => candidate.name === testName);
		if (found === undefined) {
			unknown.push(entry);
			continue;
		}

		const existing = picked.get(section);
		if (existing === "all") {
			continue;
		} else if (existing === undefined) {
			picked.set(section, [found]);
		} else if (!existing.includes(found)) {
			existing.push(found);
		}
	}

	const sections = new Array<Selected>();
	for (const section of all) {
		const choice = picked.get(section);
		if (choice !== undefined) {
			sections.push({ section, tests: choice === "all" ? [...section.tests] : choice });
		}
	}

	return { sections, unknown };
}

function traceback(err: unknown) {
	return debug.traceback(tostring(err), 2);
}

function runOne(section: Section, definition: TestDefinition, timeout: number, realm: Realm): TestResult {
	const started = os.clock();
	const context: ActiveTest = { deferred: [] };
	activeTest = context;

	const failures = new Array<string>();

	for (const hook of section.beforeEach) {
		const [ok, err] = xpcall(hook, traceback);
		if (!ok) {
			failures.push(`beforeEach raised: ${err}`);
			break;
		}
	}

	if (failures.isEmpty()) {
		const state = { done: false, error: undefined as string | undefined };

		// On its own thread so that a body which yields can be abandoned when it overruns; task.spawn
		// runs it inline until its first yield, so a body that never yields is done before the loop.
		const thread = task.spawn(() => {
			const [ok, err] = xpcall(() => {
				const value = definition.body();
				if (Promise.is(value)) {
					const [status, result] = (value as Promise<unknown>).awaitStatus();
					if (status !== Promise.Status.Resolved) {
						error(tostring(result), 0);
					}
				}
			}, traceback);

			if (!ok) {
				state.error = tostring(err);
			}

			state.done = true;
		});

		const deadline = os.clock() + timeout;
		while (!state.done && os.clock() < deadline) {
			task.wait();
		}

		if (!state.done) {
			pcall(() => task.cancel(thread));
			failures.push(`timed out after ${timeout} seconds`);
		} else if (state.error !== undefined) {
			failures.push(state.error);
		}
	}

	// Cleanup is not optional: every registered callback runs, in reverse, and the scratch folder
	// goes, whatever the body did. A cleanup that raises is a failure of its own, since the next
	// test would run against whatever it left.
	for (let i = context.deferred.size() - 1; i >= 0; i--) {
		const [ok, err] = xpcall(context.deferred[i], traceback);
		if (!ok) {
			failures.push(`cleanup raised: ${err}`);
		}
	}

	if (context.scratch !== undefined) {
		const folder = context.scratch;
		pcall(() => folder.Destroy());
	}

	for (const hook of section.afterEach) {
		const [ok, err] = xpcall(hook, traceback);
		if (!ok) {
			failures.push(`afterEach raised: ${err}`);
		}
	}

	activeTest = undefined;

	const durationMs = math.round((os.clock() - started) * 1000);
	const label = `[FWTEST] ${realm} ${section.name}/${definition.name}`;
	if (failures.isEmpty()) {
		print(`${label}: PASS (${durationMs}ms)`);
		return { name: definition.name, ok: true, durationMs };
	}

	const message = failures.join("\n");
	warn(`${label}: FAIL (${durationMs}ms): ${message}`);
	return { name: definition.name, ok: false, error: message, durationMs };
}

/**
 * Runs the selected tests, one after another, each on its own thread with `config.timeout`, and
 * returns the result. Prints one `[FWTEST]` line per test and a summary, so a console or a task
 * log reads the same as the returned table.
 */
export function runTests(filter: TestFilter, options: RunOptions | undefined, config: RunnerConfig): RunResult {
	if (running) {
		error("a test run is already in progress; wait for it to finish", 2);
	}

	const realm = getRealm();
	const selection = selectTests(filter);

	if (options?.list === true) {
		return {
			ok: selection.unknown.isEmpty(),
			realm,
			listed: true,
			passed: 0,
			failed: 0,
			durationMs: 0,
			sections: selection.sections.map(({ section, tests }) => ({
				name: section.name,
				passed: 0,
				failed: 0,
				tests: tests.map((definition) => ({ name: definition.name, ok: true, durationMs: 0 })),
			})),
			unknown: selection.unknown,
		};
	}

	running = true;
	const started = os.clock();
	const sections = new Array<SectionResult>();
	let passed = 0;
	let failed = 0;

	try {
		for (const { section, tests } of selection.sections) {
			const result: SectionResult = { name: section.name, passed: 0, failed: 0, tests: [] };
			for (const definition of tests) {
				const outcome = runOne(section, definition, config.timeout, realm);
				result.tests.push(outcome);
				if (outcome.ok) {
					result.passed++;
				} else {
					result.failed++;
				}
			}

			passed += result.passed;
			failed += result.failed;
			sections.push(result);
		}
	} finally {
		running = false;
		activeTest = undefined;
	}

	const durationMs = math.round((os.clock() - started) * 1000);
	const ok = failed === 0 && selection.unknown.isEmpty();
	const note = selection.unknown.isEmpty() ? "" : `, unknown: ${selection.unknown.join(", ")}`;
	const summary = `[FWTEST] ${realm} SUMMARY: ${passed} passed, ${failed} failed (${durationMs}ms)${note}`;
	if (ok) {
		print(summary);
	} else {
		warn(summary);
	}

	return { ok, realm, passed, failed, durationMs, sections, unknown: selection.unknown };
}
