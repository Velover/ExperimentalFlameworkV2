import { describe, expect, test } from "bun:test";

import {
	formatList,
	formatSummary,
	parseRunResult,
	resultPassed,
	ResultParseError,
	skipFailureNote,
	type RunResult,
} from "../src/results.ts";

const PASSING: RunResult = {
	ok: true,
	realm: "server",
	passed: 3,
	failed: 0,
	skipped: 0,
	reportsSkips: true,
	durationMs: 42,
	sections: [
		{
			name: "economy",
			passed: 2,
			failed: 0,
			skipped: 0,
			tests: [
				{ name: "buys", ok: true, status: "passed", durationMs: 1 },
				{ name: "sells", ok: true, status: "passed", durationMs: 2 },
			],
		},
		{
			name: "shop",
			passed: 1,
			failed: 0,
			skipped: 0,
			tests: [{ name: "opens", ok: true, status: "passed" }],
		},
	],
	unknown: [],
};

const FAILING: RunResult = {
	ok: false,
	realm: "server",
	passed: 1,
	failed: 1,
	skipped: 0,
	reportsSkips: true,
	durationMs: 17,
	sections: [
		{
			name: "economy",
			passed: 1,
			failed: 1,
			skipped: 0,
			tests: [
				{ name: "buys", ok: true, status: "passed" },
				{
					name: "refunds",
					ok: false,
					status: "failed",
					error: "expected 5, got 4",
					durationMs: 3,
				},
			],
		},
	],
	unknown: [],
};

/** A run where two tests skipped, one with a reason over two lines, beside a failure. */
const SKIPPING: RunResult = {
	ok: false,
	realm: "client",
	project: "streaming",
	passed: 1,
	failed: 1,
	skipped: 2,
	reportsSkips: true,
	durationMs: 30,
	sections: [
		{
			name: "client",
			passed: 1,
			failed: 1,
			skipped: 2,
			tests: [
				{ name: "onTick fires", ok: true, status: "passed", durationMs: 1 },
				{
					name: "onRender fires on the client",
					ok: true,
					status: "skipped",
					skipReason: "RenderStepped doesn't fire: the display may be asleep",
					durationMs: 2003,
				},
				{ name: "a round trip", ok: false, status: "failed", error: "timed out after 30 seconds" },
				{
					name: "far parts",
					ok: true,
					status: "skipped",
					skipReason: "only under the streaming project\nthis place: default",
					durationMs: 0,
				},
			],
		},
	],
	unknown: [],
};

/** What a runner from before skips (2.0.0-alpha.5 or earlier) returns: no status, no skipped count. */
const OLD_RUNNER = {
	ok: true,
	realm: "server",
	passed: 2,
	failed: 0,
	durationMs: 5,
	sections: [
		{
			name: "economy",
			passed: 2,
			failed: 0,
			tests: [
				{ name: "buys", ok: true, durationMs: 1 },
				{ name: "sells", ok: true, durationMs: 2 },
			],
		},
	],
	unknown: [],
};

describe("parseRunResult", () => {
	test("decodes the runner's JSON string", () => {
		const result = parseRunResult([JSON.stringify(PASSING)]);
		expect(result).toEqual(PASSING);
	});

	test("keeps each test's status and a skip's reason, and the skipped counts", () => {
		const result = parseRunResult([JSON.stringify(SKIPPING)]);
		expect(result).toEqual(SKIPPING);
		expect(result.sections[0]!.tests.map((test) => test.status)).toEqual([
			"passed",
			"skipped",
			"failed",
			"skipped",
		]);
	});

	test("a runner from before skips: each status is read off ok, nothing is skipped, and it says it counts no skips", () => {
		const result = parseRunResult([
			JSON.stringify({
				...OLD_RUNNER,
				ok: false,
				failed: 1,
				sections: [{ ...OLD_RUNNER.sections[0], tests: [{ name: "buys", ok: false, error: "no" }] }],
			}),
		]);
		expect(result.reportsSkips).toBe(false);
		expect(result.skipped).toBe(0);
		expect(result.sections[0]!.skipped).toBe(0);
		expect(result.sections[0]!.tests[0]).toEqual({ name: "buys", ok: false, status: "failed", error: "no" });
		expect(parseRunResult([JSON.stringify(OLD_RUNNER)]).sections[0]!.tests[0]!.status).toBe("passed");
	});

	test("a skipped count left out is counted from the tests' statuses, and a status it does not know is read off ok", () => {
		const result = parseRunResult([
			JSON.stringify({
				ok: true,
				sections: [
					{
						name: "s",
						tests: [
							{ name: "a", ok: true, status: "skipped", skipReason: "why" },
							{ name: "b", ok: true, status: "pending" },
							{ name: "c", ok: true, status: "skipped" },
						],
					},
				],
			}),
		]);
		expect(result.sections[0]!.skipped).toBe(2);
		expect(result.skipped).toBe(2);
		expect(result.reportsSkips).toBe(false);
		expect(result.sections[0]!.tests.map((test) => test.status)).toEqual(["skipped", "passed", "skipped"]);
		expect(result.sections[0]!.tests[2]!.skipReason).toBe("no reason given");
	});

	test("keeps unknown names and the ok=false they imply", () => {
		const result = parseRunResult([JSON.stringify({ ...PASSING, ok: false, unknown: ["nope", "also/nope"] })]);
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(["nope", "also/nope"]);
	});

	test("tolerates missing optional fields", () => {
		const result = parseRunResult(['{"ok":true}']);
		expect(result).toEqual({
			ok: true,
			realm: "server",
			passed: 0,
			failed: 0,
			skipped: 0,
			reportsSkips: false,
			durationMs: 0,
			sections: [],
			unknown: [],
		});
	});

	test("keeps the client realm", () => {
		expect(parseRunResult(['{"ok":true,"realm":"client"}']).realm).toBe("client");
	});

	test("no returned values is an error", () => {
		expect(() => parseRunResult([])).toThrow(ResultParseError);
		expect(() => parseRunResult(undefined)).toThrow(/returned no values/);
	});

	test("a non-JSON result is an error", () => {
		expect(() => parseRunResult(["nil"])).toThrow(/not JSON/);
	});

	test("a JSON value without ok is an error", () => {
		expect(() => parseRunResult(['{"passed":1}'])).toThrow(/no boolean "ok"/);
		expect(() => parseRunResult(["[1,2]"])).toThrow(/no boolean "ok"/);
		expect(() => parseRunResult(["null"])).toThrow(/not an object/);
	});
});

describe("formatSummary", () => {
	test("a green run ends in PASS", () => {
		const lines = formatSummary(PASSING);
		expect(lines).toContain("PASS economy  2 passed, 0 failed, 0 skipped");
		expect(lines.at(-1)).toBe("PASS");
		expect(lines).toContain("3 passed, 0 failed, 0 skipped in 42ms (server)");
	});

	test("failures name the test and its error", () => {
		const lines = formatSummary(FAILING);
		const text = lines.join("\n");
		expect(text).toContain("FAIL economy  1 passed, 1 failed, 0 skipped");
		expect(text).toContain("x refunds (3ms)");
		expect(text).toContain("expected 5, got 4");
		// passing tests are not listed
		expect(text).not.toContain("x buys");
		expect(lines.at(-1)).toBe("FAIL");
	});

	test("each skip is listed with its reason, in the order the tests ran, and the counts include them", () => {
		const lines = formatSummary({ ...SKIPPING, ok: true, failed: 0, sections: [passingSkips()] });
		expect(lines).toEqual([
			"PASS client  1 passed, 0 failed, 2 skipped",
			"       - onRender fires on the client (skipped): RenderStepped doesn't fire: the display may be asleep",
			"       - far parts (skipped): only under the streaming project",
			"         this place: default",
			"",
			"1 passed, 0 failed, 2 skipped in 30ms (client, project streaming)",
			"PASS",
		]);
	});

	test("skips and failures are listed together, and a skip never fails the run by itself", () => {
		const text = formatSummary(SKIPPING).join("\n");
		expect(text).toContain("FAIL client  1 passed, 1 failed, 2 skipped");
		expect(text.indexOf("- onRender fires")).toBeLessThan(text.indexOf("x a round trip"));
		expect(text.indexOf("x a round trip")).toBeLessThan(text.indexOf("- far parts"));
		expect(text).not.toContain("onTick fires");

		const skipsOnly = { ...SKIPPING, ok: true, failed: 0, sections: [passingSkips()] };
		expect(resultPassed(skipsOnly)).toBe(true);
	});

	test("--fail-on-skip fails a run with a skip, says why, and passes one without", () => {
		const skipsOnly = { ...SKIPPING, ok: true, failed: 0, sections: [passingSkips()] };
		const lines = formatSummary(skipsOnly, { failOnSkip: true });
		expect(lines.slice(-2)).toEqual(["2 skipped, which fails the run under --fail-on-skip", "FAIL"]);
		expect(resultPassed(skipsOnly, { failOnSkip: true })).toBe(false);
		// One realm of several is judged the same way.
		expect(resultPassed(skipsOnly, { realmOfSeveral: true, missed: [], failOnSkip: true })).toBe(false);
		expect(resultPassed(skipsOnly, { realmOfSeveral: true, missed: [] })).toBe(true);

		expect(formatSummary(PASSING, { failOnSkip: true }).slice(-2)).toEqual([
			"3 passed, 0 failed, 0 skipped in 42ms (server)",
			"PASS",
		]);
		expect(resultPassed(PASSING, { failOnSkip: true })).toBe(true);
	});

	test("--fail-on-skip heads a section with a skip FAIL, and leaves the others and a run without it alone", () => {
		const skipsOnly = { ...SKIPPING, ok: true, failed: 0, sections: [passingSkips(), PASSING.sections[1]!] };
		const headers = (options?: { failOnSkip?: boolean }) =>
			formatSummary(skipsOnly, options).filter((line) => /^(PASS|FAIL) \S/.test(line));

		expect(headers({ failOnSkip: true })).toEqual([
			"FAIL client  1 passed, 0 failed, 2 skipped",
			"PASS shop  1 passed, 0 failed, 0 skipped",
		]);
		expect(headers()).toEqual([
			"PASS client  1 passed, 0 failed, 2 skipped",
			"PASS shop  1 passed, 0 failed, 0 skipped",
		]);
		expect(headers({ failOnSkip: false })).toEqual(headers());
	});

	test("the note --json prints on stderr names the skips that fail the run, and only under --fail-on-skip", () => {
		const skipsOnly = { ...SKIPPING, ok: true, failed: 0, sections: [passingSkips()] };
		expect(skipFailureNote(skipsOnly, { failOnSkip: true })).toBe(
			`2 skipped on the client, which fails the run under --fail-on-skip (the JSON's "ok" does not count skips)`,
		);
		expect(skipFailureNote(skipsOnly)).toBeUndefined();
		expect(skipFailureNote(PASSING, { failOnSkip: true })).toBeUndefined();
		expect(skipFailureNote(parseRunResult([JSON.stringify(OLD_RUNNER)]), { failOnSkip: true })).toBeUndefined();
	});

	test("--fail-on-skip with a runner from before skips passes, and says it had nothing to go on", () => {
		const old = parseRunResult([JSON.stringify(OLD_RUNNER)]);
		const lines = formatSummary(old, { failOnSkip: true });
		expect(lines.at(-1)).toBe("PASS");
		expect(lines.join("\n")).toContain(
			"note: this place's runner predates skips (2.0.0-alpha.5 or earlier) and reports none, so --fail-on-skip has nothing to fail on",
		);
		expect(formatSummary(old).join("\n")).not.toContain("predates skips");
	});

	test("unknown names get their own line", () => {
		const text = formatSummary({
			...PASSING,
			ok: false,
			unknown: ["ghost"],
		}).join("\n");
		expect(text).toContain("matched nothing: ghost");
	});

	test("an empty run says so", () => {
		const text = formatSummary({
			ok: true,
			realm: "server",
			passed: 0,
			failed: 0,
			skipped: 0,
			reportsSkips: true,
			durationMs: 0,
			sections: [],
			unknown: [],
		}).join("\n");
		expect(text).toContain("no sections ran");
	});
});

describe("formatList", () => {
	test("lists every section and test", () => {
		const text = formatList(PASSING).join("\n");
		expect(text).toContain("economy");
		expect(text).toContain("  economy/buys");
		expect(text).toContain("  shop/opens");
		expect(text).toContain("2 sections, 3 tests");
		expect(text).not.toContain("passed");
	});

	test("a test marked with test.skip is marked, with its reason; the rest show no outcome", () => {
		const listed = parseRunResult([
			JSON.stringify({
				ok: true,
				realm: "server",
				listed: true,
				passed: 0,
				failed: 0,
				skipped: 0,
				durationMs: 0,
				sections: [
					{
						name: "economy",
						passed: 0,
						failed: 0,
						skipped: 0,
						tests: [
							{ name: "buys", ok: true, status: "passed", durationMs: 0 },
							{
								name: "refunds later",
								ok: true,
								status: "skipped",
								skipReason: "marked with test.skip",
								durationMs: 0,
							},
						],
					},
				],
				unknown: [],
			}),
		]);
		expect(formatList(listed)).toEqual([
			"economy",
			"  economy/buys",
			"  economy/refunds later  (skipped: marked with test.skip)",
			"",
			"1 sections, 2 tests (1 marked with test.skip)",
		]);
		// A listing runs nothing, so a test marked to skip never fails it, even under --fail-on-skip.
		expect(resultPassed(listed, { failOnSkip: true })).toBe(true);
	});
});

/** SKIPPING's section without its failure. */
function passingSkips() {
	const section = SKIPPING.sections[0]!;
	return { ...section, failed: 0, tests: section.tests.filter((test) => test.status !== "failed") };
}
