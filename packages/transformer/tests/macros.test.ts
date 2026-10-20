import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, compileProbe, compileProbes, emitted, normalize } from "./compile";

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

describe("guards of recursive types", () => {
	// Each of these stopped the build with "Maximum call stack size exceeded" in 2.0.0-alpha.8: the guard
	// builder wrote a recursive type out in place, inside itself, without end. Its guard is now kept in
	// a local of a function called once, and the place that reaches the type again calls the local
	// through a function that counts how deep the check has gone and remembers what the local said of
	// each table.
	const source = () => normalize(emitted("recursiveGuards"));

	/**
	 * The call of `local` where its type is reached again: `function(value) if depth >= 1000 ... end`.
	 * Its groups are numbered after the `before` groups of the pattern it goes in. The memo in the
	 * middle is spelled out once, in the first test.
	 */
	const callAfter = (local: string, before: number) => {
		const group = (n: number) => `\\${n + before}`;
		return String.raw`function\((value_\d+)\) if (depth\w*) >= 1000 then return false end local (results\w*) .*? ${group(2)} \+= 1 local (result\w*) = ${local}\(${group(1)}\) ${group(2)} -= 1 if ${group(3)} ~= nil then .*? end return ${group(4)} end`;
	};

	/**
	 * The function the guard `local` is called through, and the end of the function it is wrapped in.
	 * Its groups are numbered after the `before` groups of the pattern it goes in.
	 */
	const entryOf = (local: string, before: number) => {
		const group = (n: number) => `\\${n + before}`;
		return String.raw`return function\((value_\d+)\) local (outerDepth\w*) = (depth\w*) local (outerMemo\w*) = (memo\w*) ${group(5)} = \{\} local (ok\w*), (result\w*) = pcall\(${local}, ${group(1)}\) ${group(3)} = ${group(2)} ${group(5)} = ${group(4)} if not ${group(6)} then error\(${group(7)}, 0\) end return ${group(7)} end end\)\(\)`;
	};

	test("keep a recursive type's guard in a local that it calls through a depth count and a memo", () => {
		const text = source();
		const start = text.indexOf("local treeGuard = ");
		const tree = text.slice(start, text.indexOf("local aliasTreeGuard = "));
		// The local, the count, and the memo of each table it checked, kept by the local: a table checked
		// again (by another member of a union, or held twice) gets what the local said of it.
		expect(tree).toMatch(
			new RegExp(
				String.raw`^local treeGuard = Flamework\.createGuard\(\(function\(\) local (depth\w*) = 0 local (memo\w*) local (Tree_\d+) \3 = t\.interface\(\{ value = t\.number, kids = t\.array\(` +
					String.raw`function\((value_\d+)\) if \1 >= 1000 then return false end local (results\w*) local (_value\w*) = \4 if type\(\6\) == "table" then ` +
					String.raw`local (_memo\w*) = \2 local (_tree\w*) = \3 \5 = \7\[\8\] if \5 == nil then \5 = \{\} local (_memo\w*) = \2 local (_tree\w*) = \3 local (_results\w*) = \5 \9\[\10\] = \11 ` +
					String.raw`else local (_results\w*) = \5 local (_value\w*) = \4 local (known\w*) = \12\[\13\] if \14 ~= nil then return \14 end end end ` +
					String.raw`\1 \+= 1 local (result\w*) = \3\(\4\) \1 -= 1 if \5 ~= nil then local (_results\w*) = \5 local (_value\w*) = \4 \16\[\17\] = \15 end return \15 end\), \}\) ` +
					// Each check gets a memo of its own, and the count and the memo are put back afterwards,
					// even when the check raised.
					String.raw`return function\((value_\d+)\) local (outerDepth\w*) = \1 local (outerMemo\w*) = \2 \2 = \{\} local (ok\w*), (result\w*) = pcall\(\3, \18\) \1 = \19 \2 = \20 if not \21 then error\(\22, 0\) end return \22 end end\)\(\)\) $`,
			),
		);
	});

	test("reach a recursive type through an alias, a union, a map, an optional and an array", () => {
		const text = source();
		const after = (prefix: string, suffix = "") => new RegExp(prefix + callAfter(String.raw`\1`, 1) + suffix);

		expect(text).toMatch(
			after(
				String.raw`local (AliasTree_\d+) \1 = t\.interface\(\{ value = t\.number, kids = t\.array\(`,
				String.raw`\)`,
			),
		);
		expect(text).toMatch(
			after(
				String.raw`local (Json_\d+) \1 = t\.unionList\(\{ t\.boolean, t\.string, t\.number, t\.array\(`,
				String.raw`\), t\.map\(t\.string, function`,
			),
		);
		expect(text).toMatch(
			after(
				String.raw`local (Menu_\d+) \1 = t\.interface\(\{ label = t\.string, items = t\.map\(t\.string, `,
				String.raw`\)`,
			),
		);
		expect(text).toMatch(
			after(
				String.raw`local (Chain_\d+) \1 = t\.interface\(\{ value = t\.number, next = t\.optional\(`,
				String.raw`\)`,
			),
		);
		// `Tree[]` is what the elements' `kids` reach again.
		expect(text).toMatch(
			after(String.raw`local (TreeArray\w*) \1 = t\.array\(t\.interface\(\{ value = t\.number, kids = `, ","),
		);
	});

	test("keep two types that reach each other in the local of the one reached again", () => {
		expect(source()).toMatch(
			new RegExp(
				String.raw`local parentGuard = Flamework\.createGuard\(\(function\(\) local depth\w* = 0 local memo\w* local (Parent_\d+) \1 = t\.interface\(\{ name = t\.string, child = t\.optional\(t\.interface\(\{ age = t\.number, parent = ` +
					callAfter(String.raw`\1`, 1) +
					String.raw`, \}\)\), \}\) ` +
					entryOf(String.raw`\1`, 5),
			),
		);
	});

	test("declare a recursive type's guard once past the dedup limit, inside the guard, with one count", () => {
		const text = source();
		// `Tree` three times: declared once, in a function of its own, but inside the guard's function,
		// after the count and the memo every recursive guard in it shares, so that the limit is the
		// guard's and nothing is added to the locals around the guard.
		expect(text).not.toMatch(/^local Tree_\d+ = /m);
		expect(text).toMatch(
			new RegExp(
				String.raw`local orchardGuard = Flamework\.createGuard\(\(function\(\) local (depth\w*) = 0 local (memo\w*) ` +
					String.raw`local (Tree_\d+) = \(function\(\) local (Tree_\d+) \4 = t\.interface\(\{ value = t\.number, kids = t\.array\(function\((value_\d+)\) if \1 >= 1000 then return false end .*? return \4 end\)\(\) ` +
					String.raw`local (Chain_\d+) \6 = t\.interface\(.*?\1 >= 1000.*?\) local (guard\w*) = t\.interface\(\{ a = \3, b = \3, c = \3, chain = \6, \}\) ` +
					String.raw`return function\((value_\d+)\) local outerDepth\w* = \1 `,
			),
		);
	});

	test("leave a deduplicated guard in place where it calls a type still being built around it", () => {
		const text = source();
		// `Leaf` calls `Grove`, which is still being built where `Leaf` is first reached: it cannot be
		// declared outside `Grove`'s function, so it is written out there, and declared once afterwards.
		expect(text).toMatch(
			new RegExp(
				String.raw`local (Grove_\d+) \1 = t\.intersection\(t\.instanceIsA\("Folder"\), t\.children\(\{ Inner = t\.intersection\(t\.instanceIsA\("Folder"\), t\.children\(\{ leaf = t\.interface\(\{ grove = t\.optional\(` +
					callAfter(String.raw`\1`, 1) +
					String.raw`\), \}\),`,
			),
		);
		expect(text).toMatch(
			/local (Leaf_\d+) = t\.interface\(\{ grove = t\.optional\((Grove_\d+)\), \}\) local (guard\w*) = t\.interface\(\{ grove = \2, a = \1, b = \1, c = \1, \}\) return function\(value_\d+\) local outerDepth\w* = depth\w* /,
		);
	});

	test("guard a component's instance attribute whose type may hold itself as a child", () => {
		expect(source()).toMatch(
			new RegExp(
				String.raw`guard = \(function\(\) local depth\w* = 0 local memo\w* local (Branch_\d+) \1 = t\.intersection\(t\.instanceIsA\("Folder"\), t\.children\(\{ Twig = t\.optional\(` +
					callAfter(String.raw`\1`, 1) +
					String.raw`\), \}\)\) ` +
					entryOf(String.raw`\1`, 5),
			),
		);
	});

	test("refuse a component whose instance tree holds itself again as a required child", () => {
		const result = compileProbe(
			"recursiveInstanceTree",
			`import { BaseComponent, Component } from "@flamework-experimental/components";

interface Branch extends Folder {
	Twig: Branch;
}

@Component({ tag: "RecursiveInstanceTree" })
export class RecursiveInstanceTree extends BaseComponent<{}, Branch> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).not.toContain("Maximum call stack size exceeded");
		expect(result.output).toContain(
			"Child 'Twig' of the instance tree of 'RecursiveInstanceTree' has the type of the tree around it, 'Branch'",
		);
	});

	test("refuse a type that makes a new type of itself as it nests, rather than overflowing", () => {
		const result = compileProbe(
			"expandingGuard",
			`import { Flamework } from "@flamework-experimental/core";

interface Box<T> {
	value: T;
	inner?: Box<Box<T>>;
}

export const boxGuard = Flamework.createGuard<Box<number>>();
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).not.toContain("Maximum call stack size exceeded");
		expect(result.output).toContain("Flamework cannot generate a guard for a type nested over 500 types deep");
	});

	test("refuse a type that makes two new types of itself as it nests, in bounded time and memory", () => {
		// The dedup heuristic, which looks the type over before the guard is built, stopped going down
		// at 500 types but went on across, through 2^n types: rbxtsc ran out of a 4 GB heap after 30
		// seconds, with no location. It now gives up at once, and the guard builder says where.
		const start = performance.now();
		const result = compileProbe(
			"expandingTwiceGuard",
			`import { Flamework } from "@flamework-experimental/core";

interface Box2<T> {
	a?: Box2<Box2<T>>;
	b?: Box2<[T]>;
}

export const box2Guard = Flamework.createGuard<Box2<number>>();
`,
			{ heapMb: 1024, timeoutMs: 90_000 },
		);
		const seconds = (performance.now() - start) / 1000;

		expect(result.output).not.toContain("heap out of memory");
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("Flamework cannot generate a guard for a type nested over 500 types deep");
		expect(result.output.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/src[\\/]expandingTwiceGuard\.ts:8:\d+ - error/);
		// The whole fixture compiles in this time; the probe adds next to nothing to it.
		expect(seconds).toBeLessThan(60);
	});

	test("build a guard of more fields side by side than types may nest", () => {
		const source = normalize(emitted("recursiveGuards"));
		expect(source).toMatch(/local wideGuard = Flamework\.createGuard\(t\.interface\(\{ f000 = t\.number, /);
		expect(source).toContain("f599 = t.number, })");
	});
});

describe("a property keyed by a number", () => {
	// roblox-ts keys `{ 10: v }` and `v[10]` by the number 10, and `{ "10": v }` by the string, though
	// TypeScript names the property "10" either way. 2.0.0-alpha.7 keyed every guard and every user
	// macro's table by the name as a string, so `t.interface` checked `value["10"]`: a required field
	// was refused and an optional one never checked.
	const NUMBER_KEYS = `import { Flamework, Modding } from "@flamework-experimental/core";
import { BaseComponent, Component } from "@flamework-experimental/components";
export enum Tier { Bronze = 40, Silver = 41 }
export interface Target { value: number }
export const keyed = Flamework.createGuard<{ 10: string; "11": number; [-1]?: boolean }>();
export const byTier = Flamework.createGuard<Partial<Record<Tier, string>>>();

/** @metadata macro */
export function keyedIds<T>(ids?: Modding.Emit<{ 10: Modding.Target.Id<T>; "11": Modding.Target.Id<T> }>) {
	return ids!;
}
export const ids = keyedIds<Target>();

@Component({ tag: "NumberKeyGuards" })
export class NumberKeyComponent extends BaseComponent<{ 10: number }> {}
`;

	let compiled: ReturnType<typeof compileProbes> | undefined;
	const luau = () => {
		compiled ??= compileProbes({ numberKeyGuards: NUMBER_KEYS });
		expect(compiled.status).toBe(0);
		return normalize(compiled.files.get("numberKeyGuards")!);
	};

	test("is checked by a guard at that number, and one written as a string at the string", () => {
		expect(luau()).toContain('t.interface({ [10] = t.string, ["11"] = t.number, [-1] = t.optional(t.boolean), })');
		// A mapped type over a numeric enum.
		expect(luau()).toContain("t.interface({ [40] = t.optional(t.string), [41] = t.optional(t.string), })");
	});

	test("is keyed by that number in a user macro's table", () => {
		const id = '"fw:numberKeyGuards@Target"';
		expect(luau()).toContain(`local ids = keyedIds({ [10] = ${id}, ["11"] = ${id}, })`);
	});

	test("names a component's attribute by a string, as the engine does", () => {
		expect(luau()).toContain('attributes = { ["10"] = t.number, }');
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
