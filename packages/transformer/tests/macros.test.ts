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

	// A macro call written directly as an argument of another macro call, rather than inside an
	// object or array there: the outer macro visited only the argument's children, so the inner
	// call reached the output as a call to a function that does not exist at runtime.
	const ID = '"fw:nestedMacros@Economy"';

	test("transforms a core macro that is an argument of a core macro", () => {
		// The reported case: `Dependency<Economy>(undefined, Flamework.id<Economy>())`.
		expect(normalize(emitted("nestedMacros"))).toContain(`return Dependency(nil, ${ID})`);
	});

	test("transforms a user macro that is an argument of a core macro", () => {
		const source = normalize(emitted("nestedMacros"));
		expect(source).toContain(`return Dependency(nil, idOf(${ID}))`);
		// A core macro rewritten to its runtime implementation takes the same path.
		expect(source).toContain(`return Flamework._implements(value, typedId(${ID}))`);
	});

	test("transforms a core macro that is an argument of a user macro", () => {
		expect(normalize(emitted("nestedMacros"))).toContain(`local coreInUser = tagged(${ID}, ${ID})`);
	});

	test("transforms a user macro that is an argument of a networking macro", () => {
		expect(normalize(emitted("nestedMacros"))).toMatch(
			/local namedEvents = Networking\.createEvent\(eventName\("[0-9a-f-]{36}"\)\)/,
		);
	});

	test("transforms macros nested two and three levels deep", () => {
		const source = normalize(emitted("nestedMacros"));
		expect(source).toContain(`return Dependency(nil, tagged(${ID}, ${ID}))`);
		expect(source).toContain(`local threeLevels = tagged(tagged(tagged(idOf(${ID}), ${ID}), ${ID}), ${ID})`);
	});

	test("leaves no call to a macro without its generated arguments", () => {
		const source = normalize(emitted("nestedMacros"));
		expect(source).not.toContain("Flamework.id(");
		expect(source).not.toMatch(/\b(idOf|typedId|eventName)\(\)/);
		expect(source).not.toMatch(/\btagged\("[^"]*"\)/);
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
			`import { Flamework } from "@flamework-experimental/core";

export const value: string = Flamework.env("FLAMEWORK_FIXTURE_SCOPES");
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("TS2322");
	});

	test("rejects a fallback that is not a string literal", () => {
		const result = compileProbe(
			"envFallback",
			`import { Flamework } from "@flamework-experimental/core";

declare const computed: string;
export const value = Flamework.env("FLAMEWORK_FIXTURE_SCOPES", computed);
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("expects the fallback as a string literal");
	});
});

describe("requireModules", () => {
	// core exports it as a free function, a macro through its `@metadata macro` tag in core's
	// declarations, as a game compiled against the published package sees it.
	test("is given the folder's Rojo path, at a module's top level and in a provider", () => {
		const source = normalize(emitted("requireModules"));

		expect(source).toContain('local requiredAtLoad = requireModules("src/glob", { "out", "glob" })');
		expect(source).toContain('requireModules("src/glob/target", { "out", "glob", "target" })');
	});

	test("fails the build on a path the Rojo project does not map, and says why", () => {
		const result = compileProbe(
			"requireModulesUnmapped",
			`import { requireModules } from "@flamework-experimental/core";

requireModules("elsewhere/commands");
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Could not find Rojo data for 'elsewhere/commands'");
		expect(result.output).toContain(
			"It compiles to 'elsewhere/commands', and no $path in your Rojo project covers that",
		);
	});

	test("fails the build on a path that is not a string literal", () => {
		const result = compileProbe(
			"requireModulesComputed",
			`import { requireModules } from "@flamework-experimental/core";

declare const folder: string;
requireModules(folder);
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Path is invalid, expected string literal and got: string");
	});
});
