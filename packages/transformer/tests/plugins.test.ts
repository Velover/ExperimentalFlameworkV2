import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, emitted, normalize } from "./compile";

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile:\n${result.output}`);
	}
});

describe("plugin macro types", () => {
	test("reflects object fields, including optionality and readonly", () => {
		const source = normalize(emitted("plugins"));

		expect(source).toContain('name = "fxcoins", kind = "number", optional = false, readonly = false');
		expect(source).toContain('name = "fxuserId", kind = "number", optional = false, readonly = true');
		expect(source).toContain('name = "fxnickname", kind = "union(string|undefined)", optional = true');
		expect(source).toContain('name = "fxpets", kind = "array<string>"');
	});

	test("passes plugin options through from tsconfig", () => {
		// The fixture configures `{ "prefix": "fx" }`, which the plugin prepends to every field name.
		expect(emitted("plugins")).toContain('"fxcoins"');
		expect(emitted("plugins")).not.toContain('"coins"');
	});

	test("discriminates literal kinds", () => {
		const source = emitted("plugins");

		// Regression: the host used to ignore `isLiteral`'s argument, so `isLiteral("string")`
		// returned true for a number literal and the first branch always won.
		expect(source).toContain('describe("string:hello")');
		expect(source).toContain('describe("number:42")');
		expect(source).toContain('describe("boolean:true")');
	});

	test("reflects unions, tuples and arrays", () => {
		const source = emitted("plugins");

		expect(source).toContain('describe("union(number|string)")');
		expect(source).toContain('describe("tuple[string,number]")');
		expect(source).toContain('describe("array<boolean>")');
	});

	test("hoists a non-trivial result and reuses it across call sites", () => {
		const source = emitted("plugins");

		// Both `fieldInfo<PlayerSave>()` call sites must share one hoisted constant rather than
		// emitting the whole table twice.
		const hoisted = source.match(/local fieldInfo_\d+ = \{/g) ?? [];
		expect(hoisted).toHaveLength(1);

		const uses = source.match(/fieldInfo\(fieldInfo_\d+\)/g) ?? [];
		expect(uses).toHaveLength(2);
	});

	test("does not hoist trivially duplicable results", () => {
		// `describe` returns a bare string, which is cheaper to inline than to bind.
		expect(emitted("plugins")).not.toMatch(/local describe_\d+ =/);
	});
});
