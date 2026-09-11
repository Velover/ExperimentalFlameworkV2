import { describe, expect, test } from "bun:test";

import { formatList, formatSummary, parseRunResult, ResultParseError, type RunResult } from "../src/results.ts";

const PASSING: RunResult = {
	ok: true,
	realm: "server",
	passed: 3,
	failed: 0,
	durationMs: 42,
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
		{
			name: "shop",
			passed: 1,
			failed: 0,
			tests: [{ name: "opens", ok: true }],
		},
	],
	unknown: [],
};

const FAILING: RunResult = {
	ok: false,
	realm: "server",
	passed: 1,
	failed: 1,
	durationMs: 17,
	sections: [
		{
			name: "economy",
			passed: 1,
			failed: 1,
			tests: [
				{ name: "buys", ok: true },
				{
					name: "refunds",
					ok: false,
					error: "expected 5, got 4",
					durationMs: 3,
				},
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
		expect(lines).toContain("PASS economy  2 passed, 0 failed");
		expect(lines.at(-1)).toBe("PASS");
		expect(lines).toContain("3 passed, 0 failed in 42ms (server)");
	});

	test("failures name the test and its error", () => {
		const lines = formatSummary(FAILING);
		const text = lines.join("\n");
		expect(text).toContain("FAIL economy  1 passed, 1 failed");
		expect(text).toContain("x refunds (3ms)");
		expect(text).toContain("expected 5, got 4");
		// passing tests are not listed
		expect(text).not.toContain("x buys");
		expect(lines.at(-1)).toBe("FAIL");
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
	});
});
