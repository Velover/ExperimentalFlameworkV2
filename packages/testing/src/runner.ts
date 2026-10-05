import { RunService, Workspace } from "@rbxts/services";
import { getSections, type Section, type TestContext, type TestDefinition } from "./registry";

export type Realm = "server" | "client";

/**
 * Which tests to run: nothing for every section, `"economy"` for one section, `"economy/buys"`
 * for one test, or a list of those.
 */
export type TestFilter = string | readonly string[] | undefined;

export interface RunOptions {
	/** Report the selected sections and tests without running anything. */
	list?: boolean;

	/**
	 * The most concurrent tests that run at once in this run, a whole number, 1 or more: overrides
	 * `testing.concurrency`. With 1, every test runs alone, one after another. A runner from before
	 * concurrent tests ignores it.
	 */
	concurrency?: number;
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

	/**
	 * Set on a concurrent test, one registered with `test.concurrent` or in a section defined with
	 * `{ concurrent: true }`, which may have run alongside others: its `durationMs` then counts the
	 * time they took as well. Absent on a plain test, and from a runner before concurrent tests.
	 */
	concurrent?: boolean;

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
	/**
	 * The most concurrent tests the run let run at once (in a listing, would have): `RunOptions`'
	 * `concurrency`, else `testing.concurrency`. Absent from a runner before concurrent tests.
	 */
	concurrency: number;
}

export interface RunnerConfig {
	/** Seconds a single test may take before it is cancelled and counted as failed. */
	timeout: number;

	/** The most concurrent tests that run at once; {@link DEFAULT_CONCURRENCY} when left out. */
	concurrency?: number;
}

/** The default `testing.timeout`. */
export const DEFAULT_TIMEOUT = 30;

/**
 * The default `testing.concurrency`. Concurrent tests are opt-in, so this only bounds the ones
 * marked so: enough for tests that mostly wait to overlap their waits, few enough that the frames
 * they share stay short and a test that measures time is not starved by many others.
 */
export const DEFAULT_CONCURRENCY = 4;

const SCRATCH_NAME = "FlameworkTestScratch";

interface ActiveTest {
	readonly name: string;
	readonly section: string;
	readonly concurrent: boolean;

	deferred: Array<() => void>;
	scratch?: Folder;

	/**
	 * Where the test is: `skip()` is refused once its cleanup has started, and its context's
	 * functions once it is done.
	 */
	phase: "setup" | "body" | "cleanup" | "done";

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

/** The plain test that is running, alone, which `defer`, `scratch` and `skip` act on. */
let exclusiveTest: ActiveTest | undefined;

/**
 * How many concurrent tests are running. While any is, `defer`, `scratch` and `skip` raise: the
 * runner cannot tell which test the calling thread belongs to (Luau has no way to find the thread
 * that started another), so only the test's context can name it.
 */
let concurrentRunning = 0;

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
 * The test `defer`, `scratch` or `skip` acts on: the plain test that is running. Raises at their
 * caller (level 3 from here) while concurrent tests run, and while nothing runs.
 */
function globalTarget(name: string, idle: string): ActiveTest {
	if (concurrentRunning > 0) {
		error(
			`${name}() cannot tell which test called it while concurrent tests are running: call t.${name}() on the context the test receives, as in test.concurrent("...", (t) => t.${name}(...)); its beforeEach and afterEach hooks receive it too`,
			3,
		);
	}

	if (exclusiveTest === undefined) {
		error(idle, 3);
	}

	return exclusiveTest;
}

/**
 * What `t.defer`, `t.scratch` and `t.skip` raise once their test is over: at their caller, level 4
 * from here (this, `deferOn` or the like, the context's function).
 */
function refuseFinished(test: ActiveTest, name: string): never {
	error(
		`${name} was called after the test '${test.section}/${test.name}' had finished, from a thread that outlived it`,
		4,
	);
}

function deferOn(test: ActiveTest, callback: () => void, name: string) {
	if (test.phase === "done") {
		refuseFinished(test, name);
	}

	test.deferred.push(callback);
}

function scratchOf(test: ActiveTest, name: string): Folder {
	if (test.phase === "done") {
		refuseFinished(test, name);
	}

	if (test.scratch === undefined) {
		const folder = new Instance("Folder");
		folder.Name = SCRATCH_NAME;
		folder.Parent = Workspace;
		test.scratch = folder;
	}

	return test.scratch;
}

function skipOn(test: ActiveTest, reason: string, name: string): never {
	if (test.phase === "done") {
		refuseFinished(test, name);
	}

	if (test.phase === "cleanup") {
		error(
			`${name} can only be called from a test's body or a beforeEach, not from a defer callback or an afterEach: the test has already run`,
			3,
		);
	}

	const text = typeIs(reason, "string") ? reason : tostring(reason);
	if (test.skipReason === undefined) {
		test.skipReason = text;
	}

	error(setmetatable({ reason: text }, SKIP_SIGNAL));
}

/** The context a test's body and hooks receive: its own `defer`, `scratch` and `skip`. */
function createContext(test: ActiveTest): TestContext {
	return {
		name: test.name,
		section: test.section,
		concurrent: test.concurrent,
		defer: (callback) => deferOn(test, callback, "t.defer()"),
		scratch: () => scratchOf(test, "t.scratch()"),
		skip: (reason) => skipOn(test, reason, "t.skip()"),
	};
}

/**
 * Registers cleanup for the running test: a connection to disconnect, an instance to destroy, a
 * state to restore. Deferred callbacks run in reverse order once the test is over, whether it
 * passed, failed or timed out, and one that raises fails the test.
 *
 * In a plain test only: while concurrent tests run it raises, and they use `t.defer`, on the
 * context they receive, instead.
 */
export function defer(callback: () => void) {
	deferOn(globalTarget("defer", "defer() can only be called while a test is running"), callback, "defer()");
}

/**
 * A Folder in Workspace for whatever the running test needs to build, created on first use and
 * destroyed with everything in it once the test is over.
 *
 * In a plain test only: while concurrent tests run it raises, and they use `t.scratch`, on the
 * context they receive, which gives each test its own folder.
 */
export function scratch(): Folder {
	return scratchOf(globalTarget("scratch", "scratch() can only be called while a test is running"), "scratch()");
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
 * `t.skip`, on the context the test receives, is bound to its test and has no such trap.
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
 * `afterEach`, it raises a plain error there, which fails the test. While concurrent tests run it
 * raises a plain error, which fails the test that called it: they use `t.skip`.
 */
export function skip(reason: string): never {
	return skipOn(
		globalTarget("skip", "skip() can only be called while a test is running, from its body or a beforeEach"),
		reason,
		"skip()",
	);
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

/** A result, marked as a concurrent test's when it is one. */
function kindOf(result: TestResult, definition: TestDefinition): TestResult {
	if (definition.concurrent === true) {
		result.concurrent = true;
	}

	return result;
}

function runOne(section: Section, definition: TestDefinition, timeout: number, realm: Realm): TestResult {
	const label = `[FWTEST] ${realm} ${section.name}/${definition.name}`;

	// Marked with test.skip: nothing of it runs, the section's hooks included.
	if (definition.skip !== undefined) {
		print(`${label}: SKIP (0ms): ${definition.skip}`);
		return kindOf(
			{ name: definition.name, ok: true, status: "skipped", skipReason: definition.skip, durationMs: 0 },
			definition,
		);
	}

	const started = os.clock();
	const concurrent = definition.concurrent === true;
	const context: ActiveTest = {
		name: definition.name,
		section: section.name,
		concurrent,
		deferred: [],
		phase: "setup",
	};
	const t = createContext(context);

	// A plain test runs alone, so the functions act on it; while a concurrent one runs, they raise.
	if (concurrent) {
		concurrentRunning++;
	} else {
		exclusiveTest = context;
	}

	const failures = new Array<string>();

	// A skip stops the hooks and the body: whether or not its error got this far, it is recorded
	// on the context, and what was raised after it is not the test's failure.
	for (const hook of section.beforeEach) {
		const [ok, err] = xpcall(() => hook(t), traceback);
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
				const value = definition.body(t);
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
		const [ok, err] = xpcall(() => hook(t), traceback);
		if (!ok) {
			failures.push(`afterEach raised: ${err}`);
		}
	}

	context.phase = "done";
	if (concurrent) {
		concurrentRunning--;
	} else {
		exclusiveTest = undefined;
	}

	const durationMs = math.round((os.clock() - started) * 1000);
	const skipReason = context.skipReason;
	if (!failures.isEmpty()) {
		if (skipReason !== undefined) {
			failures.unshift(`skipped (${skipReason}), but its cleanup failed:`);
		}

		const message = failures.join("\n");
		warn(`${label}: FAIL (${durationMs}ms): ${message}`);
		return kindOf({ name: definition.name, ok: false, status: "failed", error: message, durationMs }, definition);
	}

	if (skipReason !== undefined) {
		print(`${label}: SKIP (${durationMs}ms): ${skipReason}`);
		return kindOf({ name: definition.name, ok: true, status: "skipped", skipReason, durationMs }, definition);
	}

	print(`${label}: PASS (${durationMs}ms)`);
	return kindOf({ name: definition.name, ok: true, status: "passed", durationMs }, definition);
}

/**
 * Whether a test may run alongside its neighbours: a concurrent one, or one marked with
 * `test.skip`, which runs nothing and so holds nothing up.
 */
function runsAlongside(definition: TestDefinition) {
	return definition.concurrent === true || definition.skip !== undefined;
}

/**
 * Runs `tests[first..last]`, consecutive tests that run alongside each other, at most `limit` at a
 * time, and returns once all of them have finished. Each worker takes the next test in order, so
 * they start in the order of `tests`, and the next starts as soon as one ends. Each test
 * keeps its own timeout, so one that overruns holds up only its own worker, until it times out.
 */
function runTogether(
	section: Section,
	tests: readonly TestDefinition[],
	first: number,
	last: number,
	outcomes: TestResult[],
	timeout: number,
	limit: number,
	realm: Realm,
) {
	let cursor = first;
	let working = 0;

	const work = () => {
		while (cursor <= last) {
			const index = cursor;
			cursor++;

			const definition = tests[index];
			const [ok, outcome] = pcall(() => runOne(section, definition, timeout, realm));
			// runOne catches whatever the test raises; should the runner itself raise, the test fails
			// rather than leaving the run waiting for a worker that is gone.
			outcomes[index] = ok
				? outcome
				: kindOf(
						{
							name: definition.name,
							ok: false,
							status: "failed",
							error: `the test runner raised: ${outcome}`,
							durationMs: 0,
						},
						definition,
					);
		}

		working--;
	};

	const workers = math.min(limit, last - first + 1);
	for (let i = 0; i < workers; i++) {
		working++;
		task.spawn(work);
	}

	while (working > 0) {
		task.wait();
	}
}

/**
 * Runs a section's selected tests and returns their results in the order they started. A plain test
 * runs alone: it waits for every test before it and the tests after it wait for it. Consecutive
 * concurrent tests run together, up to `limit` at once.
 */
function runSection(
	section: Section,
	tests: readonly TestDefinition[],
	timeout: number,
	limit: number,
	realm: Realm,
): TestResult[] {
	const outcomes = new Array<TestResult>();
	let index = 0;
	while (index < tests.size()) {
		if (!runsAlongside(tests[index])) {
			outcomes[index] = runOne(section, tests[index], timeout, realm);
			index++;
			continue;
		}

		let last = index;
		while (last + 1 < tests.size() && runsAlongside(tests[last + 1])) {
			last++;
		}

		runTogether(section, tests, index, last, outcomes, timeout, limit, realm);
		index = last + 1;
	}

	return outcomes;
}

/** The run's limit on concurrent tests: the run's option, else the config's, else the default. */
function concurrencyOf(options: RunOptions | undefined, config: RunnerConfig): number {
	const value = options?.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;
	if (!typeIs(value, "number") || value < 1 || value % 1 !== 0) {
		error(`concurrency must be a whole number, 1 or more, got ${tostring(value)}`, 3);
	}

	return value;
}

/**
 * Runs the selected tests, each on its own thread with `config.timeout`, and returns the result.
 * Sections run one after another, and so do the plain tests in them; consecutive concurrent tests
 * run together, up to `concurrency` at once (`options`, else `config`). Prints one `[FWTEST]` line
 * per test as it ends (`PASS`, `FAIL` with the failure, or `SKIP` with the reason) and a summary,
 * so a console or a task log reads the same as the returned table, which lists every section and
 * test in the order they started (declaration order, or the filter's), however they finished.
 */
export function runTests(filter: TestFilter, options: RunOptions | undefined, config: RunnerConfig): RunResult {
	if (running) {
		error("a test run is already in progress; wait for it to finish", 2);
	}

	const realm = getRealm();
	const project = getProject();
	const concurrency = concurrencyOf(options, config);
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
						return kindOf(
							{
								name: definition.name,
								ok: true,
								status: "skipped",
								skipReason: definition.skip,
								durationMs: 0,
							},
							definition,
						);
					}

					return kindOf({ name: definition.name, ok: true, status: "passed", durationMs: 0 }, definition);
				}),
			})),
			unknown: selection.unknown,
			concurrency,
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
			const outcomes = runSection(section, tests, config.timeout, concurrency, realm);
			const result: SectionResult = { name: section.name, passed: 0, failed: 0, skipped: 0, tests: outcomes };
			for (const outcome of outcomes) {
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
		exclusiveTest = undefined;
		concurrentRunning = 0;
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

	return {
		ok,
		realm,
		project,
		passed,
		failed,
		skipped,
		durationMs,
		sections,
		unknown: selection.unknown,
		concurrency,
	};
}
