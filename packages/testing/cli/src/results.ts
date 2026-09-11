/**
 * The shape `@flamework-experimental/testing`'s cloud runner returns (as a JSON
 * string in `output.results[0]`), plus parsing and human formatting for it.
 */

export interface TestResult {
	name: string;
	ok: boolean;
	error?: string;
	durationMs?: number;
}

export interface SectionResult {
	name: string;
	passed: number;
	failed: number;
	tests: TestResult[];
}

export interface RunResult {
	ok: boolean;
	realm: "server" | "client";
	passed: number;
	failed: number;
	durationMs: number;
	sections: SectionResult[];
	/** Requested names that matched nothing. Non-empty means `ok` is false. */
	unknown: string[];
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

	return {
		ok: value.ok,
		realm: value.realm === "client" ? "client" : "server",
		passed: numberOr(value.passed, 0),
		failed: numberOr(value.failed, 0),
		durationMs: numberOr(value.durationMs, 0),
		sections,
		unknown,
	};
}

function normalizeSection(entry: unknown): SectionResult {
	const section = (entry ?? {}) as Record<string, unknown>;
	const tests: TestResult[] = Array.isArray(section.tests)
		? section.tests.map((test) => {
				const value = (test ?? {}) as Record<string, unknown>;
				return {
					name: String(value.name ?? "<unnamed>"),
					ok: value.ok === true,
					...(value.error === undefined ? {} : { error: String(value.error) }),
					...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
				};
			})
		: [];
	return {
		name: String(section.name ?? "<unnamed>"),
		passed: numberOr(section.passed, 0),
		failed: numberOr(section.failed, 0),
		tests,
	};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function duration(ms: number | undefined): string {
	return ms === undefined ? "" : ` (${Math.round(ms)}ms)`;
}

/** The per-section / per-failure summary printed after a run. */
export function formatSummary(result: RunResult): string[] {
	const lines: string[] = [];

	for (const section of result.sections) {
		const status = section.failed > 0 ? "FAIL" : "PASS";
		lines.push(`${status} ${section.name}  ${section.passed} passed, ${section.failed} failed`);
		for (const test of section.tests) {
			if (test.ok) continue;
			lines.push(`       x ${test.name}${duration(test.durationMs)}`);
			for (const line of (test.error ?? "<no error message>").split("\n")) {
				lines.push(`         ${line}`);
			}
		}
	}

	if (result.unknown.length > 0) {
		lines.push(`MISS matched nothing: ${result.unknown.join(", ")}`);
	}

	if (result.sections.length === 0 && result.unknown.length === 0) {
		lines.push("no sections ran");
	}

	lines.push("");
	lines.push(
		`${result.passed} passed, ${result.failed} failed in ${Math.round(result.durationMs)}ms (${result.realm})`,
	);
	lines.push(result.ok ? "PASS" : "FAIL");
	return lines;
}

/** What `--list` prints: every section with its test names. */
export function formatList(result: RunResult): string[] {
	const lines: string[] = [];
	let count = 0;
	for (const section of result.sections) {
		lines.push(section.name);
		for (const test of section.tests) {
			lines.push(`  ${section.name}/${test.name}`);
			count += 1;
		}
	}
	if (result.unknown.length > 0) {
		lines.push(`MISS matched nothing: ${result.unknown.join(", ")}`);
	}
	lines.push("");
	lines.push(`${result.sections.length} sections, ${count} tests`);
	return lines;
}
