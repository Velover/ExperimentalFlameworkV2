/**
 * The shape `@flamework-experimental/testing`'s cloud runner returns (as a JSON
 * string in `output.results[0]`), plus parsing and human formatting for it.
 */

/** What became of a test: a skip is not a failure, and is counted apart from the passes. */
export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
	name: string;
	/** Whether the test did not fail: true for a pass and for a skip. */
	ok: boolean;
	/**
	 * What became of it. A runner from before skips (2.0.0-alpha.5 or earlier) sends no status,
	 * and it is read off `ok`: passed or failed.
	 */
	status: TestStatus;
	error?: string;
	/** Why it was skipped, when it was: what was passed to `skip()`, or `"marked with test.skip"`. */
	skipReason?: string;
	/**
	 * Set on a concurrent test (`test.concurrent`, or a section defined with `{ concurrent: true }`),
	 * which may have run alongside others. Absent on a plain test, and from a runner before
	 * concurrent tests.
	 */
	concurrent?: boolean;
	durationMs?: number;
}

export interface SectionResult {
	name: string;
	/** Tests that passed; a skipped test is counted in `skipped`. */
	passed: number;
	failed: number;
	skipped: number;
	tests: TestResult[];
}

export interface RunResult {
	ok: boolean;
	realm: "server" | "client";
	/** The project the place was made under, read off Workspace's attribute; absent when the place was not patched. */
	project?: string;
	/** Tests that passed; a skipped test is counted in `skipped`. */
	passed: number;
	failed: number;
	skipped: number;
	/**
	 * Whether the place's runner counts skips: false for a runner from before skips, whose results
	 * have no `skipped` count, so that `--fail-on-skip` can say it had nothing to go on.
	 */
	reportsSkips: boolean;
	durationMs: number;
	sections: SectionResult[];
	/** Requested names that matched nothing. Non-empty means `ok` is false. */
	unknown: string[];
	/**
	 * The most concurrent tests the run let run at once (`--concurrency`, else the place's
	 * `testing.concurrency`). Absent from a runner before concurrent tests, which runs every test
	 * alone.
	 */
	concurrency?: number;
}

export class ResultParseError extends Error {
	readonly raw: string | undefined;
	constructor(message: string, raw?: string) {
		super(message);
		this.name = "ResultParseError";
		this.raw = raw;
	}
}

function truncate(value: string, max = 400): string {
	return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * Parses `output.results` from a COMPLETE task into a {@link RunResult}.
 * The runner returns one value - a JSON string - so we read `results[0]`.
 *
 * A result from a runner before skips has no status, no reason and no `skipped` count: each test's
 * status is read off its `ok`, and every skipped count is 0.
 */
export function parseRunResult(results: string[] | undefined): RunResult {
	const raw = results?.[0];
	if (raw === undefined) {
		throw new ResultParseError("the task returned no values - the shim did not return the runner's result");
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new ResultParseError(`the task result was not JSON: ${truncate(raw)}`, raw);
	}

	if (typeof decoded !== "object" || decoded === null) {
		throw new ResultParseError(`the task result was not an object: ${truncate(raw)}`, raw);
	}

	const value = decoded as Record<string, unknown>;
	if (typeof value.ok !== "boolean") {
		throw new ResultParseError(`the task result has no boolean "ok": ${truncate(raw)}`, raw);
	}

	const sections: SectionResult[] = Array.isArray(value.sections)
		? value.sections.map((entry) => normalizeSection(entry))
		: [];
	const unknown: string[] = Array.isArray(value.unknown) ? value.unknown.map((name) => String(name)) : [];
	const reportsSkips = isCount(value.skipped);

	return {
		ok: value.ok,
		realm: value.realm === "client" ? "client" : "server",
		...(typeof value.project === "string" ? { project: value.project } : {}),
		passed: numberOr(value.passed, 0),
		failed: numberOr(value.failed, 0),
		skipped: numberOr(
			value.skipped,
			sections.reduce((sum, section) => sum + section.skipped, 0),
		),
		reportsSkips,
		durationMs: numberOr(value.durationMs, 0),
		sections,
		unknown,
		...(isCount(value.concurrency) ? { concurrency: value.concurrency } : {}),
	};
}

const STATUSES: readonly string[] = ["passed", "failed", "skipped"];

function normalizeTest(test: unknown): TestResult {
	const value = (test ?? {}) as Record<string, unknown>;
	const ok = value.ok === true;
	const status: TestStatus =
		typeof value.status === "string" && STATUSES.includes(value.status)
			? (value.status as TestStatus)
			: ok
				? "passed"
				: "failed";
	return {
		name: String(value.name ?? "<unnamed>"),
		ok,
		status,
		...(value.error === undefined ? {} : { error: String(value.error) }),
		...(status === "skipped"
			? { skipReason: value.skipReason === undefined ? "no reason given" : String(value.skipReason) }
			: {}),
		...(value.concurrent === true ? { concurrent: true } : {}),
		...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
	};
}

function normalizeSection(entry: unknown): SectionResult {
	const section = (entry ?? {}) as Record<string, unknown>;
	const tests: TestResult[] = Array.isArray(section.tests) ? section.tests.map(normalizeTest) : [];
	return {
		name: String(section.name ?? "<unnamed>"),
		passed: numberOr(section.passed, 0),
		failed: numberOr(section.failed, 0),
		skipped: numberOr(section.skipped, tests.filter((test) => test.status === "skipped").length),
		tests,
	};
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function numberOr(value: unknown, fallback: number): number {
	return isCount(value) ? value : fallback;
}

function duration(ms: number | undefined): string {
	return ms === undefined ? "" : ` (${Math.round(ms)}ms)`;
}

/**
 * How a realm's result is judged. When it is one of several realms run with the same filter
 * (`realmOfSeveral`), a filter entry only the other realm has is not a miss, so it does not fail
 * this one; an entry no realm has (`missed`, see {@link missedEverywhere}) fails every realm it
 * was given to. With `failOnSkip` (`--fail-on-skip`), a skipped test fails the realm too.
 */
export interface Judgement {
	realmOfSeveral?: boolean;
	/** The filter entries that no realm matched, when `realmOfSeveral`. */
	missed?: readonly string[];
	/** A skipped test fails the run: `--fail-on-skip`, `FAIL_ON_SKIP` or `testing.failOnSkip`. */
	failOnSkip?: boolean;
}

/**
 * Whether a result passes: every test, and every filter entry naming something, in this realm
 * alone or, of several, in any of them; and, under `failOnSkip`, no test skipped. A result from a
 * runner before skips counts none, and passes `failOnSkip`: such a runner had no way to skip.
 */
export function resultPassed(result: RunResult, options?: Judgement): boolean {
	if (options?.failOnSkip === true && result.skipped > 0) return false;
	if (options?.realmOfSeveral !== true) return result.ok;
	return result.failed === 0 && !result.unknown.some((entry) => options.missed?.includes(entry) === true);
}

/** The filter entries none of the realms' results matched, in the order the first result lists them. */
export function missedEverywhere(results: readonly RunResult[]): string[] {
	const [first, ...others] = results;
	if (first === undefined) return [];
	return first.unknown.filter((entry) => others.every((other) => other.unknown.includes(entry)));
}

/** The line that lists a result's unmatched filter entries. */
function missLine(result: RunResult, options?: Judgement): string {
	return options?.realmOfSeveral === true
		? `not among the ${result.realm}'s sections: ${result.unknown.join(", ")}`
		: `MISS matched nothing: ${result.unknown.join(", ")}`;
}

/** A failure's message or a skip's reason under its test's line, one indented line per line of it. */
function detailLines(text: string): string[] {
	return text.split("\n").map((line) => `         ${line}`);
}

/**
 * The per-section summary printed after a run: each section's counts, then each of its failures
 * with its message and each of its skips with its reason, in the result's order, the order the
 * tests started, however concurrent tests ended. A section heads
 * `FAIL` when a test in it failed, or, under `failOnSkip`, when one skipped.
 */
export function formatSummary(result: RunResult, options?: Judgement): string[] {
	const lines: string[] = [];

	for (const section of result.sections) {
		const failing = section.failed > 0 || (options?.failOnSkip === true && section.skipped > 0);
		const status = failing ? "FAIL" : "PASS";
		lines.push(
			`${status} ${section.name}  ${section.passed} passed, ${section.failed} failed, ${section.skipped} skipped`,
		);
		for (const test of section.tests) {
			if (test.status === "failed") {
				lines.push(`       x ${test.name}${duration(test.durationMs)}`);
				lines.push(...detailLines(test.error ?? "<no error message>"));
			} else if (test.status === "skipped") {
				// The reason is read off the result, not off the place's SKIP line, so one that runs
				// over several lines arrives whole: its first line beside the name, the rest below.
				const [first = "", ...rest] = (test.skipReason ?? "no reason given").split("\n");
				lines.push(`       - ${test.name} (skipped): ${first}`);
				if (rest.length > 0) lines.push(...detailLines(rest.join("\n")));
			}
		}
	}

	if (result.unknown.length > 0) {
		lines.push(missLine(result, options));
	}

	if (result.sections.length === 0 && result.unknown.length === 0) {
		lines.push("no sections ran");
	}

	lines.push("");
	const where = result.project === undefined ? result.realm : `${result.realm}, project ${result.project}`;
	lines.push(
		`${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped in ${Math.round(result.durationMs)}ms (${where})`,
	);
	if (options?.failOnSkip === true) {
		if (result.skipped > 0) {
			lines.push(`${result.skipped} skipped, which fails the run under --fail-on-skip`);
		} else if (!result.reportsSkips) {
			lines.push(
				"note: this place's runner predates skips (2.0.0-alpha.5 or earlier) and reports none, so --fail-on-skip has nothing to fail on",
			);
		}
	}
	lines.push(resultPassed(result, options) ? "PASS" : "FAIL");
	return lines;
}

/**
 * What `--json` adds on stderr when the skips in `result` fail the run under `failOnSkip`: the
 * JSON is the place's own, whose `ok` no skip makes false. Nothing when they do not fail it.
 */
export function skipFailureNote(result: RunResult, options?: Judgement): string | undefined {
	if (options?.failOnSkip !== true || result.skipped === 0) return undefined;
	return `${result.skipped} skipped on the ${result.realm}, which fails the run under --fail-on-skip (the JSON's "ok" does not count skips)`;
}

/**
 * What `--list` prints: every section with its test names. Nothing ran, so no test has an outcome;
 * one registered with `test.skip` is marked, with its reason, as it would be skipped, and a
 * concurrent one is marked as such.
 */
export function formatList(result: RunResult, options?: Judgement): string[] {
	const lines: string[] = [];
	let count = 0;
	let marked = 0;
	let concurrent = 0;
	for (const section of result.sections) {
		lines.push(section.name);
		for (const test of section.tests) {
			const notes: string[] = [];
			if (test.concurrent === true) {
				notes.push("concurrent");
				concurrent += 1;
			}
			if (test.status === "skipped") {
				notes.push(`skipped: ${(test.skipReason ?? "no reason given").split("\n")[0]}`);
				marked += 1;
			}
			lines.push(`  ${section.name}/${test.name}${notes.length > 0 ? `  (${notes.join("; ")})` : ""}`);
			count += 1;
		}
	}
	if (result.unknown.length > 0) {
		lines.push(missLine(result, options));
	}
	lines.push("");
	const totals: string[] = [];
	if (marked > 0) totals.push(`${marked} marked with test.skip`);
	if (concurrent > 0) {
		const limit = result.concurrency === undefined ? "" : `, up to ${result.concurrency} at once`;
		totals.push(`${concurrent} concurrent${limit}`);
	}
	lines.push(
		`${result.sections.length} sections, ${count} tests${totals.length > 0 ? ` (${totals.join(", ")})` : ""}`,
	);
	return lines;
}

/**
 * What a run that asked for `--concurrency` adds when the place's runner predates concurrent tests
 * (its result has no `concurrency`): the runner ignored the option. Nothing otherwise. A `listing`
 * (`--list`) ran nothing, so its note says how the runner runs tests rather than how it ran them.
 */
export function concurrencyNote(result: RunResult, asked: number | undefined, listing = false): string | undefined {
	if (asked === undefined || result.concurrency !== undefined) return undefined;
	const how = listing ? "it runs every test alone" : "it ran every test alone";
	return `note: the ${result.realm}'s runner predates concurrent tests and ignored --concurrency: ${how}`;
}
