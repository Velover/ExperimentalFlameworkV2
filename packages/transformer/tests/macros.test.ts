import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, emitted, normalize } from "./compile";

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

		expect(source).toContain('injectionId = "$f:nested@Target"');
		expect(source).not.toContain("Flamework.id()");
	});

	test("transforms macros nested in array literals", () => {
		expect(normalize(emitted("nested"))).toContain(
			'local nestedInArray = { "$f:nested@Target", "$f:nested@Target" }',
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
		expect(emitted("nested")).toContain("$f:nested@Target");
	});
});
