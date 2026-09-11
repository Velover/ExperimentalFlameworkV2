import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, compileProbe, emitted, normalize } from "./compile";

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile:\n${result.output}`);
	}
});

describe("nested macros", () => {
	test("transforms a macro nested inside another macro's arguments", () => {
		// Regression: when every parameter of the outer macro was passed explicitly,
		// `highestParameterIndex` stayed -1 and the argument loop never ran, so nested macros were
		// emitted as raw calls to a `declare`d function and blew up at runtime.
		const source = normalize(emitted("nested"));

		expect(source).toContain('injectionId = "fw:nested@Target"');
		expect(source).not.toContain("Flamework.id()");
	});

	test("transforms macros nested in array literals", () => {
		expect(normalize(emitted("nested"))).toContain(
			'local nestedInArray = { "fw:nested@Target", "fw:nested@Target" }',
		);
	});
});

describe("guard generation", () => {
	test("emits primitive guards", () => {
		expect(emitted("guards")).toContain("Flamework.createGuard(t.string)");
	});

	test("emits interface guards with optional members", () => {
		const source = normalize(emitted("guards"));
		expect(source).toContain("t.interface({ a = t.number, b = t.optional(t.string), })");
	});

	test("emits union and array guards", () => {
		const source = emitted("guards");
		expect(source).toContain("t.union(t.string, t.number)");
		expect(source).toContain("t.array(t.string)");
	});

	test("emits Roblox datatype guards by alias", () => {
		expect(emitted("guards")).toContain("t.CFrame");
	});
});

describe("identifier generation", () => {
	test("uses the configured hash prefix", () => {
		expect(emitted("nested")).toContain("fw:nested@Target");
	});
});

describe("Flamework.env", () => {
	test("inlines a variable from .env, a fallback for one that is not set, and nil for one with neither", () => {
		// `FLAMEWORK_FIXTURE_SCOPES` is in the fixture's .env; the other two are not. The fixture
		// file also pins the types: `string | undefined` without a fallback, `string` with one.
		const source = normalize(emitted("env"));

		expect(source).toContain('local scopes = "fixture, demo"');
		expect(source).toContain('local channel = "dev"');
		expect(source).toMatch(/local missing = nil/);
		expect(source).not.toContain("Flamework.env");
	});

	test("types the result as a plain string only when a fallback is given", () => {
		const result = compileProbe(
			"envType",
			`import { Flamework } from "@flamework/core";

export const value: string = Flamework.env("FLAMEWORK_FIXTURE_SCOPES");
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("TS2322");
	});

	test("rejects a fallback that is not a string literal", () => {
		const result = compileProbe(
			"envFallback",
			`import { Flamework } from "@flamework/core";

declare const computed: string;
export const value = Flamework.env("FLAMEWORK_FIXTURE_SCOPES", computed);
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("expects the fallback as a string literal");
	});
});
