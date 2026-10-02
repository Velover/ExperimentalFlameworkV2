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

/**
 * What became of a test. A skipped test is not a failure: it leaves the run's `ok` alone, and is
 * counted apart from the passes.
 */
export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
	name: string;

	/**
	 * Whether the test did not fail: true when it passed and when it was skipped. `status` tells
	 * the two apart; `ok` stays for what reads it alone, such as a `flamework-test` from before
	 * skips, which then sees a skip as it saw one before skips had a status, as no failure.
	 */
	ok: boolean;

	/**
	 * What became of the test. In a listing nothing ran: a test marked with `test.skip` reads
	 * `"skipped"`, with its reason, and every other test `"passed"`.
	 */
	status: TestStatus;

	/** The failure: the raised message with a traceback, a timeout, or a cleanup that raised. */
	error?: string;

	/**
	 * Why the test was skipped, when `status` is `"skipped"`: what was passed to `skip()`, or
	 * `"marked with test.skip"`.
	 */
	skipReason?: string;

	durationMs: number;
}

export interface SectionResult {
	name: string;
	/** Tests that passed. A skipped test is counted in `skipped`, not here. */
	passed: number;
	failed: number;
	skipped: number;
	tests: TestResult[];
}

/** JSON-safe, so it can travel through a RemoteFunction or be encoded for an Open Cloud task. */
export interface RunResult {
	/** No test failed and every filter entry matched something. A skipped test does not change it. */
	ok: boolean;
	realm: Realm;
	/** The project the place was made under, `getProject()`; absent when it was not made by `flamework-test`. */
	project?: string;
	/** Set when `list` was asked for: nothing ran, and every count is 0. */
	listed?: boolean;
	/** Tests that passed. A skipped test is counted in `skipped`, not here. */
	passed: number;
	failed: number;
	skipped: number;
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

	/** Where the test is: `skip()` is refused once its cleanup has started. */
	phase: "setup" | "body" | "cleanup";

	/**
	 * The reason of the first `skip()` call. The runner reads the skip from here rather than from
	 * the error that reaches it, so a pcall in the test that catches that error does not undo it.
	 */
	skipReason?: string;
}

/** What `skip()` raises to stop the test: a table, so that no ordinary error can pass for it. */
interface SkipSignal {
	readonly reason: string;
}

const SKIP_SIGNAL: LuaMetatable<SkipSignal> = {
	// What a test that catches the error with pcall and prints it sees.
	__tostring: (signal) => `the test was skipped: ${signal.reason}`,
};

function isSkipSignal(value: unknown): value is SkipSignal {
	return typeIs(value, "table") && getmetatable(value) === SKIP_SIGNAL;
}

let activeTest: ActiveTest | undefined;
let running = false;

export function getRealm(): Realm {
	return RunService.IsServer() ? "server" : "client";
}

/**
 * The attribute `flamework-test` sets on Workspace when it makes the place: the name of the Rojo
 * project the place follows, `deferred` for `tests/deferred.project.json`.
 */
export const PROJECT_ATTRIBUTE = "FlameworkTestProject";

/**
 * Which Rojo project this place was made under, when `flamework-test` made it: the name of the
 * project file, `default` for `default.project.json`. A run under several projects (`--project`
 * repeated) runs every test under each, and this is how a test tells them apart, to assert what
 * that project's Workspace properties change (`SignalBehavior`, streaming) or to `skip()` under
 * the others. `undefined` in a place that was not patched: a build opened by hand, or run as it
 * is.
 */
export function getProject(): string | undefined {
	const value = Workspace.GetAttribute(PROJECT_ATTRIBUTE);
	return typeIs(value, "string") ? value : undefined;
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

/**
 * Stops the running test and reports it as skipped, with `reason`: for what rules a test out only
 * at run time, such as the realm, the project (`getProject()`), or a display that is asleep. Call
 * it from the test's body or from a `beforeEach`; skipped from a `beforeEach`, neither the later
 * `beforeEach` hooks nor the test's body run. The test's `defer` callbacks and the section's
 * `afterEach` hooks still run after a skip, and one that raises fails the test. A skip is not a
 * failure: the run stays ok.
 *
 * Call it only from the test's own flow: its body, a `beforeEach`, or what they call and wait for.
 * The runner knows only which test is running, not which test a thread belongs to, so a thread
 * that outlives its test (a `task.spawn`, `task.delay` or connection left running) and calls
 * `skip()` later marks whichever test is running then, which hides that test's own failure.
 *
 * It stops the test by raising an error that the runner tells apart from any other: a table, whose
 * `tostring` reads `the test was skipped: <reason>`. A `pcall` in the test around the call (or
 * `expectThrows`, `expectNoThrow`, a Promise) catches that error like any other, and the test goes
 * on running past it; but the runner has recorded the skip already, so the test is still reported
 * as skipped, with the first `skip()`'s reason, whatever the rest of its body does: an error it
 * raises afterwards, or a timeout, is not reported. Called outside any pcall, on the test's own
 * thread, it keeps the code after it from running; called from a thread the test started, it
 * stops only that thread.
 *
 * Called while no test is running, it raises at the caller. Called from a `defer` callback or an
 * `afterEach`, it raises a plain error there, which fails the test.
 */
export function skip(reason: string): never {
	const context = activeTest;
	if (context === undefined) {
		error("skip() can only be called while a test is running, from its body or a beforeEach", 2);
	}

	if (context.phase === "cleanup") {
		error(
			"skip() can only be called from a test's body or a beforeEach, not from a defer callback or an afterEach: the test has already run",
			2,
		);
	}

	const text = typeIs(reason, "string") ? reason : tostring(reason);
	if (context.skipReason === undefined) {
		context.skipReason = text;
	}

	error(setmetatable({ reason: text }, SKIP_SIGNAL));
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

/** The handler of every xpcall here: a message with its traceback, or a skip's signal as it is. */
function traceback(err: unknown) {
	if (isSkipSignal(err)) {
		return err;
	}

	return debug.traceback(tostring(err), 2);
}

function runOne(section: Section, definition: TestDefinition, timeout: number, realm: Realm): TestResult {
	const label = `[FWTEST] ${realm} ${section.name}/${definition.name}`;

	// Marked with test.skip: nothing of it runs, the section's hooks included.
	if (definition.skip !== undefined) {
		print(`${label}: SKIP (0ms): ${definition.skip}`);
		return { name: definition.name, ok: true, status: "skipped", skipReason: definition.skip, durationMs: 0 };
	}

	const started = os.clock();
	const context: ActiveTest = { deferred: [], phase: "setup" };
	activeTest = context;

	const failures = new Array<string>();

	// A skip stops the hooks and the body: whether or not its error got this far, it is recorded
	// on the context, and what was raised after it is not the test's failure.
	for (const hook of section.beforeEach) {
		const [ok, err] = xpcall(hook, traceback);
		if (context.skipReason !== undefined) {
			break;
		}

		if (!ok) {
			failures.push(`beforeEach raised: ${err}`);
			break;
		}
	}

	if (failures.isEmpty() && context.skipReason === undefined) {
		context.phase = "body";
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
		}

		// Past a skip, the body went on only because a pcall in it caught the skip's error: what
		// it did then -- raise, overrun -- is not the test's failure.
		if (context.skipReason === undefined) {
			if (!state.done) {
				failures.push(`timed out after ${timeout} seconds`);
			} else if (state.error !== undefined) {
				failures.push(state.error);
			}
		}
	}

	// Cleanup is not optional: every registered callback runs, in reverse, and the scratch folder
	// goes, whatever the body did, a skip included. A cleanup that raises is a failure of its own,
	// since the next test would run against whatever it left, and so fails a skipped test too.
	context.phase = "cleanup";
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
	const skipReason = context.skipReason;
	if (!failures.isEmpty()) {
		if (skipReason !== undefined) {
			failures.unshift(`skipped (${skipReason}), but its cleanup failed:`);
		}

		const message = failures.join("\n");
		warn(`${label}: FAIL (${durationMs}ms): ${message}`);
		return { name: definition.name, ok: false, status: "failed", error: message, durationMs };
	}

	if (skipReason !== undefined) {
		print(`${label}: SKIP (${durationMs}ms): ${skipReason}`);
		return { name: definition.name, ok: true, status: "skipped", skipReason, durationMs };
	}

	print(`${label}: PASS (${durationMs}ms)`);
	return { name: definition.name, ok: true, status: "passed", durationMs };
}

/**
 * Runs the selected tests, one after another, each on its own thread with `config.timeout`, and
 * returns the result. Prints one `[FWTEST]` line per test (`PASS`, `FAIL` with the failure, or
 * `SKIP` with the reason) and a summary, so a console or a task
 * log reads the same as the returned table.
 */
export function runTests(filter: TestFilter, options: RunOptions | undefined, config: RunnerConfig): RunResult {
	if (running) {
		error("a test run is already in progress; wait for it to finish", 2);
	}

	const realm = getRealm();
	const project = getProject();
	const selection = selectTests(filter);

	if (options?.list === true) {
		return {
			ok: selection.unknown.isEmpty(),
			realm,
			project,
			listed: true,
			passed: 0,
			failed: 0,
			skipped: 0,
			durationMs: 0,
			sections: selection.sections.map(({ section, tests }) => ({
				name: section.name,
				passed: 0,
				failed: 0,
				skipped: 0,
				tests: tests.map((definition): TestResult => {
					if (definition.skip !== undefined) {
						return {
							name: definition.name,
							ok: true,
							status: "skipped",
							skipReason: definition.skip,
							durationMs: 0,
						};
					}

					return { name: definition.name, ok: true, status: "passed", durationMs: 0 };
				}),
			})),
			unknown: selection.unknown,
		};
	}

	running = true;
	const started = os.clock();
	const sections = new Array<SectionResult>();
	let passed = 0;
	let failed = 0;
	let skipped = 0;

	try {
		for (const { section, tests } of selection.sections) {
			const result: SectionResult = { name: section.name, passed: 0, failed: 0, skipped: 0, tests: [] };
			for (const definition of tests) {
				const outcome = runOne(section, definition, config.timeout, realm);
				result.tests.push(outcome);
				if (outcome.status === "passed") {
					result.passed++;
				} else if (outcome.status === "skipped") {
					result.skipped++;
				} else {
					result.failed++;
				}
			}

			passed += result.passed;
			failed += result.failed;
			skipped += result.skipped;
			sections.push(result);
		}
	} finally {
		running = false;
		activeTest = undefined;
	}

	const durationMs = math.round((os.clock() - started) * 1000);
	const ok = failed === 0 && selection.unknown.isEmpty();
	const note = selection.unknown.isEmpty() ? "" : `, unknown: ${selection.unknown.join(", ")}`;
	const summary = `[FWTEST] ${realm} SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped (${durationMs}ms)${note}`;
	if (ok) {
		print(summary);
	} else {
		warn(summary);
	}

	return { ok, realm, project, passed, failed, skipped, durationMs, sections, unknown: selection.unknown };
}
