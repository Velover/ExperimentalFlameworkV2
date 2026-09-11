import { describe, expect, test } from "bun:test";

import { escapeLuauString, parseSections, renderFilter, renderOptions, renderShim } from "../src/luau.ts";

const SHIM = ["local cloud = nil", "return require(cloud).run(__FILTER__, __OPTIONS__)"].join("\n");

describe("filter literals", () => {
	test("no sections means nil (every section)", () => {
		expect(renderFilter(undefined)).toBe("nil");
		expect(renderFilter([])).toBe("nil");
	});

	test("one section is a string literal", () => {
		expect(renderFilter(["economy"])).toBe('"economy"');
	});

	test("one test is a string literal with the slash intact", () => {
		expect(renderFilter(["economy/buys"])).toBe('"economy/buys"');
	});

	test("several names become a table", () => {
		expect(renderFilter(["economy", "shop/buys"])).toBe('{ "economy", "shop/buys" }');
	});
});

describe("escaping", () => {
	test("quotes and backslashes", () => {
		expect(escapeLuauString('say "hi"')).toBe('"say \\"hi\\""');
		expect(escapeLuauString("back\\slash")).toBe('"back\\\\slash"');
	});

	test("newlines, returns and tabs", () => {
		expect(escapeLuauString("a\nb\r\tc")).toBe('"a\\nb\\r\\tc"');
	});

	test("other control characters become decimal escapes", () => {
		const nul = String.fromCharCode(0);
		const unitSeparator = String.fromCharCode(31);
		expect(escapeLuauString(`a${nul}b${unitSeparator}c`)).toBe('"a\\0b\\31c"');
	});

	test("a hostile section name cannot break out of the literal", () => {
		const rendered = renderFilter(['", os.exit()) --']);
		expect(rendered).toBe('"\\", os.exit()) --"');
		// one opening and one closing quote; everything between is escaped
		expect(rendered.match(/(?<!\\)"/g)).toHaveLength(2);
	});
});

describe("option literals", () => {
	test("nothing means nil", () => {
		expect(renderOptions(undefined)).toBe("nil");
		expect(renderOptions({})).toBe("nil");
		expect(renderOptions({ list: false })).toBe("nil");
	});

	test("--list becomes { list = true }", () => {
		expect(renderOptions({ list: true })).toBe("{ list = true }");
	});
});

describe("parseSections", () => {
	test("undefined stays undefined", () => {
		expect(parseSections(undefined)).toBeUndefined();
	});

	test("splits, trims and drops empties", () => {
		expect(parseSections(" economy , shop/buys ,")).toEqual(["economy", "shop/buys"]);
	});

	test("a comma-only value is no filter at all", () => {
		expect(parseSections(" , ")).toBeUndefined();
	});
});

describe("renderShim", () => {
	test("substitutes both placeholders", () => {
		expect(renderShim(SHIM, ["economy"], { list: true })).toContain(
			'require(cloud).run("economy", { list = true })',
		);
	});

	test("the default shim asks for everything", () => {
		expect(renderShim(SHIM, undefined)).toContain("require(cloud).run(nil, nil)");
	});

	test("no placeholder survives", () => {
		const rendered = renderShim(SHIM, ["a", "b"], { list: false });
		expect(rendered).not.toContain("__FILTER__");
		expect(rendered).not.toContain("__OPTIONS__");
	});
});

test("the shipped shim still has both placeholders and the guard", async () => {
	const template = await Bun.file(new URL("../tasks/run-tests.luau", import.meta.url)).text();
	expect(template).toContain("__FILTER__");
	expect(template).toContain("__OPTIONS__");
	expect(template).toContain("@flamework-experimental");
	expect(renderShim(template, ["economy"])).toContain('.run("economy", nil)');
});
