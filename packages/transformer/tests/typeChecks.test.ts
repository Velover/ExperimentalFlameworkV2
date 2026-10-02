import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import {
	compileFixture,
	compileFixtureFresh,
	compileFixtureWithEnv,
	compileProbes,
	type CompileResult,
} from "./compile";

/*
 * Type checks (`serialization.checks.types`): every value written is tested to be of its kind first.
 * The fixture builds with them off, and `typeChecks.ts` (one serializer per kind, call sites of every
 * kind) is built again here with them on, and with them on under the other settings. Probe files
 * the fixture cannot hold are built here as well (`PROBES`), with the checks off and on: types at
 * Luau's limit of 200 locals, unions an enum item tells apart or that warn, which the fixture's
 * count of union warnings would see, and a GroupInfo in a union, which the transformer before this
 * could not compile; and one with `strictNullChecks` off (`NOSNC`).
 */

const FIXTURE = path.resolve(import.meta.dir, "fixture");
const RBXTSC = path.resolve(import.meta.dir, "../../../node_modules/roblox-ts/out/CLI/cli.js");
const NOSNC_CONFIG = "tsconfig.nosnc-probe.json";

const cframes = Array.from({ length: 16 }, (_, i) => `c${i}: CFrame;`).join(" ");
const measured = Array.from(
	{ length: 10 },
	(_, i) => `o${i}?: string; u${i}: number | string; s${i}: string; t${i}: { s: string }; b${i}: buffer;`,
).join(" ");
const elements = [...new Array<string>(16).fill("CFrame"), "Vector3", "Vector3", "Vector3", "string"].join(", ");

const PROBES: Record<string, string> = {
	// Without the checks, `w_TcBrinkW` holds 200 locals at once (3 parameters, 12 per CFrame, one per
	// Vector3, 2 for the string), and so does `w_TcBrinkT`. `TcMeasured` has fields of every kind
	// whose size varies, measured with locals.
	zzTcBrink: `import { Flamework } from "@flamework-experimental/core";
export interface TcBrinkW { ${cframes} v0: Vector3; v1: Vector3; v2: Vector3; label: string; }
export const tcBrinkW = Flamework.createSerializer<TcBrinkW>();
export interface TcMeasured { ${measured} }
export const tcMeasured = Flamework.createSerializer<TcMeasured>();
export type TcBrinkT = [${elements}];
export const tcBrinkT = Flamework.createSerializer<TcBrinkT>();
`,
	zzTcEnums: `import { Flamework } from "@flamework-experimental/core";
/** Told apart by an enum item, which their guards compare. */
export const tcByKey = Flamework.createSerializer<{ key: Enum.KeyCode.A; a?: number } | { key: Enum.KeyCode.B; b?: number }>();
/** The same, with a field only the second has. */
export const tcReordered = Flamework.createSerializer<{ k: Enum.KeyCode.A; x: number } | { k: Enum.KeyCode.B; x: number; y?: string }>();
/** Members no value tells apart, next to an enum item, in a union without an alias. */
export const tcNamed = Flamework.createSerializer<Enum.KeyCode.A | Partial<{ a: number }> | Partial<{ b: string }>>();
`,
	zzTcGroup: `import { Flamework } from "@flamework-experimental/core";
export const tcGroupOrNumber = Flamework.createSerializer<GroupInfo | number>();
`,
};

const NOSNC: Record<string, string> = {
	zzTcNosnc: `import { Networking } from "@flamework-experimental/networking";
interface TcNosncEvents {
	tcNosnc(flag: boolean, label: string): void;
}
export const tcNosncClient = Networking.createEvent<TcNosncEvents, {}>().createClient({});
export function tcSendNil() {
	tcNosncClient.tcNosnc.fire(undefined, "x");
}
export function tcSendTrue() {
	tcNosncClient.tcNosnc.fire(true, "x");
}
`,
};

// What a run killed halfway leaves behind.
fs.rmSync(path.join(FIXTURE, NOSNC_CONFIG), { force: true });
for (const name of [...Object.keys(PROBES), ...Object.keys(NOSNC)]) {
	fs.rmSync(path.join(FIXTURE, "src", `${name}.ts`), { force: true });
}

/**
 * `compileProbes` through a tsconfig that is the fixture's own with `strictNullChecks` off, which a
 * project may have: TypeScript then takes an `undefined` for any type. The tsconfig and the files are
 * removed again afterwards.
 */
function compileWithoutStrictNullChecks(sources: Record<string, string>, env: Record<string, string>): CompileResult {
	const config = path.join(FIXTURE, NOSNC_CONFIG);
	fs.writeFileSync(
		config,
		JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { strictNullChecks: false } }),
	);
	const names = Object.keys(sources);
	for (const name of names) {
		fs.rmSync(path.join(FIXTURE, "out", `${name}.luau`), { force: true });
		fs.writeFileSync(path.join(FIXTURE, "src", `${name}.ts`), sources[name]);
	}

	try {
		const result = spawnSync("node", [RBXTSC, "-p", NOSNC_CONFIG], {
			cwd: FIXTURE,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		const files = new Map<string, string>();
		for (const name of names) {
			const emitted = path.join(FIXTURE, "out", `${name}.luau`);
			if (fs.existsSync(emitted)) files.set(name, fs.readFileSync(emitted, "utf8"));
		}

		return { files, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status ?? 1 };
	} finally {
		fs.rmSync(config, { force: true });
		for (const name of names) {
			fs.rmSync(path.join(FIXTURE, "src", `${name}.ts`), { force: true });
			fs.rmSync(path.join(FIXTURE, "out", `${name}.luau`), { force: true });
		}
	}
}

const variants: Record<"on" | "warnServerNone", Map<string, string>> = {} as never;
const probes: Record<"off" | "on" | "nosnc", CompileResult> = {} as never;

beforeAll(() => {
	const builds = {
		on: { FLAMEWORK_FIXTURE_CHECKS_TYPES: "true" },
		// Width checks off, type checks on: they do not depend on `category`.
		warnServerNone: {
			FLAMEWORK_FIXTURE_CHECKS_TYPES: "true",
			FLAMEWORK_FIXTURE_CHECKS: "none",
			FLAMEWORK_FIXTURE_CHECKS_MODE: "warn",
			FLAMEWORK_FIXTURE_CHECKS_SIDE: "server",
		},
	};
	for (const [name, env] of Object.entries(builds)) {
		const result = compileFixtureWithEnv(env);
		if (result.status !== 0) throw new Error(`fixture failed to compile with ${name}:\n${result.output}`);
		variants[name as keyof typeof variants] = result.files;
	}

	probes.off = compileProbes(PROBES);
	probes.on = compileProbes(PROBES, { FLAMEWORK_FIXTURE_CHECKS_TYPES: "true" });
	probes.nosnc = compileWithoutStrictNullChecks(NOSNC, { FLAMEWORK_FIXTURE_CHECKS_TYPES: "true" });
	for (const [name, result] of Object.entries(probes)) {
		if (result.status !== 0) throw new Error(`the probes failed to compile (${name}):\n${result.output}`);
	}

	// What later tests read from disk is the ordinary build again.
	const fresh = compileFixtureFresh();
	if (fresh.status !== 0) throw new Error(`fixture failed to compile:\n${fresh.output}`);
}, 900_000);

afterAll(() => {
	compileFixture();
});

const variant = (name: keyof typeof variants, file = "typeChecks") => {
	const emit = variants[name].get(file);
	if (emit === undefined) throw new Error(`the ${name} build did not emit '${file}'`);
	return emit;
};
const on = (file?: string) => variant("on", file);

/** `local <name> = Flamework.createSerializer({ ... })` in an emit. */
function serializer(emit: string, name: string): string {
	const match = emit.match(new RegExp(`local ${name} = Flamework\\.createSerializer\\([\\s\\S]*?\\n\\}\\)\\n`));
	if (!match) throw new Error(`no ${name} in the emit`);
	return match[0];
}

/** The `serialize` half of a serializer. */
function serialize(emit: string, name: string): string {
	const whole = serializer(emit, name);
	return whole.slice(0, whole.indexOf("deserialize = function"));
}

/** A hoisted function, `codec.<role>_<name> = function(...) ... end`. */
function hoisted(emit: string, role: string, name: string): string {
	const match = emit.match(new RegExp(`codec\\.${role}_${name} = function\\([^)]*\\)\\n[\\s\\S]*?\\nend\\n`));
	if (!match) throw new Error(`no codec.${role}_${name} in the emit`);
	return match[0];
}

/** A top-level function of the emit. */
function functionBody(emit: string, name: string): string {
	const match = emit.match(new RegExp(`local function ${name}\\([^)]*\\)\\n[\\s\\S]*?\\nend\\n`));
	if (!match) throw new Error(`no function '${name}' in the emit`);
	return match[0];
}

/** `if not (<test>) then codec.checkType(<expected>, <value>, <where>) end`, as a pattern. */
function check(test: string, expected: string, value: string, where: string, show = false): RegExp {
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`if not \\(${test}\\) then\\s*codec\\.checkType\\(${escape(JSON.stringify(expected))}, ${value}, ${escape(where)}${show ? ", true" : ""}\\)\\s*end`,
	);
}

/** A probe file's emit from one of the probe builds. */
function probe(build: keyof typeof probes, file: string): string {
	const emit = probes[build].files.get(file);
	if (emit === undefined) throw new Error(`the ${build} probes did not emit '${file}'`);
	return emit;
}

/** A probe build's output without its colours. */
const probeOutput = (build: keyof typeof probes) => probes[build].output.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The most locals a generated function holds at once, its parameters included, which Luau limits to
 * 200: roblox-ts writes a statement per line, and `do`, `if` and the loops open a scope `end` closes.
 */
function peakLocals(fn: string): number {
	const [header, ...body] = fn.trimEnd().split("\n");
	const parameters = header.match(/function\(([^)]*)\)/)![1].split(",");
	const scopes = [parameters.filter((name) => name.trim() !== "").length];
	let peak = scopes[0];
	for (const raw of body) {
		const line = raw.trim();
		const loop = line.match(/^for (.+?) (?:=|in) .* do$/);
		if (line === "end") scopes.pop();
		else if (line === "else" || /^elseif .* then$/.test(line)) scopes[scopes.length - 1] = 0;
		else if (loop) scopes.push(loop[1].split(",").length);
		else if (line === "do" || /^(if|while) .* (then|do)$/.test(line)) scopes.push(0);
		else {
			const names = line.match(/^local ([\w, ]+?)(?: =|$)/);
			if (names) scopes[scopes.length - 1] += names[1].split(",").length;
		}
		const live = scopes.reduce((total, count) => total + count, 0);
		peak = Math.max(peak, live);
	}
	return peak;
}

describe("with the type checks off (the default)", () => {
	test("nothing is generated, in any file", () => {
		const defaults = compileFixture();
		expect(defaults.status).toBe(0);
		for (const [file, emit] of defaults.files) {
			expect(`${file}: ${emit.includes("checkType")}`).toBe(`${file}: false`);
		}
		expect(serialize(defaults.files.get("typeChecks")!, "tcNumber")).toMatch(
			/serialize = function\((v\w*)\)\s*local (buf\w*) = buffer\.create\(8\)\s*buffer\.writef64\(\2, 0, \1\)\s*return \2\s*end/,
		);
	});
});

describe("each kind", () => {
	test("a number of any width is tested to be a number before it is written", () => {
		expect(serialize(on(), "tcNumber")).toMatch(
			/do\s*local (n\w*) = v\w*\s*if not \(type\(\1\) == "number"\) then\s*codec\.checkType\("number", \1, "value"\)\s*end\s*buffer\.writef64\(buf\w*, 0, \1\)\s*end/,
		);
		expect(serialize(on(), "tcU16")).toMatch(check(`type\\(n\\w*\\) == "number"`, "number", "n\\w*", `"value"`));
		expect(serialize(on(), "tcU16")).toMatch(/buffer\.writeu16\(buf\w*, 0, n\w*\)/);
		expect(serialize(on(), "tcF32")).toMatch(/buffer\.writef32\(buf\w*, 0, n\w*\)/);
		expect(serialize(on(), "tcF32")).toMatch(check(`type\\(n\\w*\\) == "number"`, "number", "n\\w*", `"value"`));
	});

	test("a value whose size varies is tested where it is measured, ahead of reading it", () => {
		const varint = serialize(on(), "tcVarint");
		expect(varint).toMatch(
			/serialize = function\((v\w*)\)\s*do\s*local (v\w*) = \1\s*if not \(type\(\2\) == "number"\) then\s*codec\.checkType\("number", \2, "value"\)\s*end\s*end\s*local buf\w* = buffer\.create\(vsize\(\1\)\)/,
		);
		const text = serialize(on(), "tcString");
		expect(text).toMatch(
			/do\s*local (v\w*) = (v\w*)\s*if not \(type\(\1\) == "string"\) then\s*codec\.checkType\("string", \1, "value"\)\s*end\s*end\s*local length\w* = #\2/,
		);
		expect(text.match(/checkType/g)).toHaveLength(1);
		expect(serialize(on(), "tcString8")).toMatch(
			check(`type\\(v\\w*\\) == "string"`, "string", "v\\w*", `"value"`),
		);
		expect(serialize(on(), "tcBuffer")).toMatch(
			/do\s*local (v\w*) = (v\w*)\s*if not \(type\(\1\) == "buffer"\) then\s*codec\.checkType\("buffer", \1, "value"\)\s*end\s*end\s*local length\w* = buffer\.len\(\2\)/,
		);
	});

	test("a boolean is tested in a block of its own with its write", () => {
		expect(serialize(on(), "tcBoolean")).toMatch(
			/do\s*local (v\w*) = v\w*\s*if not \(type\(\1\) == "boolean"\) then\s*codec\.checkType\("boolean", \1, "value"\)\s*end\s*buffer\.writeu8\(buf\w*, 0, if \1 ~= 0 and [^\n]* then 1 else 0\)\s*end/,
		);
	});

	test("a literal union names its members, and the value, where nothing matched", () => {
		expect(serialize(on(), "tcLiterals")).toMatch(
			/if (index\w*) == nil then\s*codec\.checkType\('\\"a\\" \| \\"b\\" \| \\"c\\"', v\w*, "value", true\)\s*error\("value is not one of the literals its type allows"\)\s*end/,
		);
		expect(serialize(on(), "tcConstant")).toMatch(
			/if (v\w*)\.kind ~= "circle" then\s*codec\.checkType\('\\"circle\\"', \1\.kind, "value\.kind", true\)\s*end/,
		);
	});

	test("an enum is tested to be an item of its own enum", () => {
		expect(serialize(on(), "tcEnum")).toMatch(
			/do\s*local (v\w*) = (v\w*)\s*if not \(typeof\(\1\) == "EnumItem" and \1\.EnumType == Enum\.Material\) then\s*codec\.checkType\("Enum\.Material", \1, "value", true\)\s*end\s*end\s*buffer\.writeu16\(buf\w*, 0, \2\.Value\)/,
		);
	});

	test("a datatype is tested with typeof, and an Instance once it is not nil", () => {
		expect(serialize(on(), "tcVector3")).toMatch(
			check(`typeof\\(v\\w*\\) == "Vector3"`, "Vector3", "v\\w*", `"value"`),
		);
		expect(serialize(on(), "tcCFrame")).toMatch(
			check(`typeof\\(v\\w*\\) == "CFrame"`, "CFrame", "v\\w*", `"value"`),
		);
		expect(serialize(on(), "tcCFrame")).toMatch(/:GetComponents\(\)/);
		expect(serialize(on(), "tcInstance")).toMatch(
			/if (blob\w*) ~= nil then\s*if not \(typeof\(\1\) == "Instance"\) then\s*codec\.checkType\("Instance", \1, "value"\)\s*end\s*table\.insert\(blobs\w*, \1\)/,
		);
		// Anything goes into an `unknown`.
		expect(serialize(on(), "tcUnknown")).not.toContain("checkType");
		// Another of the engine's types is tested when `typeof` names it, a table the Roblox API declares is not.
		expect(serialize(on(), "tcFont")).toMatch(
			/if (blob\w*) ~= nil then\s*if not \(typeof\(\1\) == "Font"\) then\s*codec\.checkType\("Font", \1, "value"\)/,
		);
		expect(serialize(on(), "tcGroupInfo")).not.toContain("checkType");
	});

	test("a collection is tested to be a table, and each value in it where it is first read", () => {
		const array = serialize(on(), "tcArray");
		expect(array).toMatch(check(`type\\(v\\w*\\) == "table"`, "table", "v\\w*", `"value"`));
		// Fixed-size elements are not read to measure them: tested where they are written.
		expect(array).toMatch(
			/for (i\w*) = 1, #(v\w*) do\s*local (item\w*) = \2\[\1\]\s*if \3 == nil then\s*error\([^\n]*\)\s*end\s*if not \(type\(\3\) == "number"\) then\s*codec\.checkType\("number", \3, "value\[\]"\)/,
		);
		// Strings are measured, so tested in that loop, and only there.
		const strings = serialize(on(), "tcStrings");
		expect(strings).toMatch(check(`type\\(item\\w*\\) == "string"`, "string", "item\\w*", `"value[]"`));
		expect(strings.match(/checkType\("string"/g)).toHaveLength(1);
		const set = serialize(on(), "tcSet");
		expect(set).toMatch(check(`type\\(v\\w*\\) == "table"`, "table", "v\\w*", `"value"`));
		expect(set).toMatch(check(`type\\(item\\w*\\) == "string"`, "string", "item\\w*", `"value[]"`));
		const map = serialize(on(), "tcMap");
		expect(map).toMatch(check(`type\\(key\\w*\\) == "string"`, "string", "key\\w*", `"value<key>"`));
		expect(map).toMatch(/codec\.checkType\("number", \w+, "value<value>"\)/);
	});

	test("an optional takes nil and tests anything else", () => {
		expect(serialize(on(), "tcOptional")).toMatch(
			/if (v\w*) ~= nil then[\s\S]*if not \(type\(\w+\) == "number"\) then\s*codec\.checkType\("number", \w+, "value"\)/,
		);
	});

	test("a union names its members where no member takes a value, and tests no member's own kind again", () => {
		const union = serialize(on(), "tcUnion");
		// Measured first, so the size pass's chain names it.
		expect(union).toMatch(/else\s*codec\.checkType\("number \| string", v\w*, "value"\)\s*end/);
		expect(union.match(/checkType/g)).toHaveLength(1);
		expect(union).toMatch(/else\s*error\("value matches none of the union's members"\)/);

		// A union of a fixed size is first read where it is written: tested there, a table first.
		const fixed = serialize(on(), "tcFixedUnion");
		expect(fixed).toMatch(check(`type\\(v\\w*\\) == "table"`, "Fixed", "v\\w*", `"Fixed"`));
		expect(fixed).toMatch(
			/else\s*codec\.checkType\("Fixed", v\w*, "Fixed"\)\s*error\("value matches none of the union's members"\)/,
		);
		// A member's fields are still tested.
		expect(fixed).toMatch(/codec\.checkType\("number", \w+, "Fixed\.v"\)/);

		// Keyed members: the table test goes ahead of the key reads.
		const keyed = hoisted(on(), "s", "Purse");
		expect(keyed).toMatch(/^codec\.s_Purse = function\(v\w*, where\w*\)/);
		expect(keyed).toMatch(
			/if not \(type\(v\w*\) == "table"\) then\s*codec\.checkType\("Purse", v\w*, where\w*\)\s*end/,
		);
		expect(keyed.indexOf("checkType")).toBeLessThan(keyed.indexOf(".Coins ~= nil"));
	});

	test("a tuple and an object are tested to be tables, where they are first read", () => {
		expect(serialize(on(), "tcTuple")).toMatch(check(`type\\(v\\w*\\) == "table"`, "table", "v\\w*", `"value"`));
		expect(serialize(on(), "tcTuple")).toMatch(/codec\.checkType\("string", \w+(\[2\])?, "value\[1\]"\)/);
		const fixed = serialize(on(), "tcFixedTuple");
		expect(fixed).toMatch(check(`type\\(v\\w*\\) == "table"`, "table", "v\\w*", `"value"`));
		expect(fixed).toMatch(/codec\.checkType\("boolean", \w+, "value\[1\]"\)/);
		const object = serialize(on(), "tcObject");
		expect(object).toMatch(check(`type\\(v\\w*\\) == "table"`, "table", "v\\w*", `"value"`));
		expect(object).toMatch(/codec\.checkType\("number", \w+, "value\.x"\)/);
		expect(object).toMatch(/codec\.checkType\("number", \w+, "value\.y"\)/);
	});

	test("a width is tested to be a number before its range", () => {
		// widthChecks.ts has the implicit widths; with type checks on, their type is tested first.
		const implicit = serialize(on("widthChecks"), "implicitU8");
		expect(implicit).toMatch(
			/if not \(type\((n\w*)\) == "number"\) then\s*codec\.checkType\("number", \1, "value"\)\s*end\s*if not \(\1 >= 0 and \1 <= 255 and \1 % 1 == 0\) then\s*codec\.checkWidth\("u8", \1, "value"\)/,
		);
		// At a call site as well.
		expect(functionBody(on("widthChecks"), "sendMove")).toMatch(
			/codec\.checkType\("number", (\w+), "'move' \[0\]"\)\s*end\s*if not \(\1 >= 0 and \1 <= 65535 and \1 % 1 == 0\) then\s*codec\.checkWidth\("u16", \1, "'move' \[0\]"\)/,
		);
	});
});

describe("shared code", () => {
	test("a named type's size and write functions take where the value is, and test from it", () => {
		const size = hoisted(on(), "s", "TcEntity");
		expect(size).toMatch(/^codec\.s_TcEntity = function\(v\w*, (where\w*)\)/);
		expect(size).toMatch(/codec\.checkType\("table", \w+, where\w*\)/);
		expect(size).toMatch(/codec\.checkType\("string", \w+, where\w* \.\. "\.name"\)/);
		// A named type inside starts from the outer type's name, which joins no strings.
		expect(size).toMatch(/codec\.s_TcOwner\(\w+\.owner, "TcEntity\.owner"\)/);
		const write = hoisted(on(), "w", "TcEntity");
		expect(write).toMatch(/^codec\.w_TcEntity = function\(buf\w*, o\w*, v\w*, where\w*\)/);
		expect(write).toMatch(/codec\.checkType\("number", \w+, where\w* \.\. "\.id"\)/);
		expect(write).toMatch(/codec\.checkType\("boolean", \w+, where\w* \.\. "\.flag"\)/);
		// Reading tests nothing.
		expect(hoisted(on(), "r", "TcEntity")).not.toContain("checkType");
		expect(serialize(on(), "tcEntity")).toMatch(/codec\.s_TcEntity\(v\w*, "TcEntity"\)/);
		expect(serialize(on(), "tcEntity")).toMatch(/codec\.w_TcEntity\(buf\w*, 0, v\w*, "TcEntity"\)/);
	});
});

describe("call sites", () => {
	test("test every argument with the member and the argument in the path", () => {
		const move = functionBody(on(), "tcSendMove");
		expect(move).toMatch(/codec\.checkType\("number", \w+, "'tcMove' \[0\]"\)/);
		expect(move).toMatch(/codec\.s_TcEntity\(entity, "'tcMove' \[1\]"\)/);
		expect(move).toMatch(/codec\.w_TcEntity\(buf\w*, o\w* \+ 8, entity, "'tcMove' \[1\]"\)/);
		expect(move).toMatch(/codec\.checkType\("boolean", \w+, "'tcMove' \[2\]"\)/);
	});

	test("judge a literal when building: one of the right type needs no test", () => {
		const literals = functionBody(on(), "tcSendLiterals");
		expect(literals).not.toMatch(/checkType\("number"/);
		expect(literals).not.toMatch(/checkType\("boolean"/);
		expect(literals).toMatch(/buffer\.writef64\(buf\w*, o\w*, 3\)/);
		expect(literals).toMatch(/buffer\.writeu8\(buf\w*, o\w*, if true then 1 else 0\)/);
	});

	test("test rest arguments in their places, and spread ones as the list's", () => {
		const many = functionBody(on(), "tcSendMany");
		expect(many).toMatch(/codec\.checkType\("string", \w+, "'tcMany' \[0\]"\)/);
		expect(many).toMatch(/codec\.checkType\("number", \w+, "'tcMany' \[1\]"\)/);
		expect(many).toMatch(/codec\.checkType\("number", \w+, "'tcMany' \[2\]"\)/);
		const spread = functionBody(on(), "tcSendSpread");
		expect(spread).toMatch(/codec\.checkType\("string", \w+(\[1\])?, "'tcMany' \[0\]"\)/);
		expect(spread).toMatch(/codec\.checkType\("number", \w+, "'tcMany' \[\]"\)/);
		// The argument list itself is the call's own.
		expect(spread).not.toMatch(/checkType\("table"/);
	});

	test("test a request and a callback's result", () => {
		expect(functionBody(on(), "tcAskFor")).toMatch(/codec\.checkType\("number", \w+, "'tcAsk' \[0\]"\)/);
		expect(on()).toMatch(
			/_setCallback\(callback\w*, function\(value\w*\)[\s\S]*?codec\.checkType\("table", \w+, "'tcAsk' result"\)[\s\S]*?codec\.checkType\("number", \w+, "'tcAsk' result\.x"\)/,
		);
	});
});

describe("Luau's limit of 200 locals in a function", () => {
	test("a type at the limit without the checks holds far fewer with them: each field's write in a block of its own", () => {
		for (const name of ["TcBrinkW", "TcBrinkT"]) {
			const off = peakLocals(hoisted(probe("off", "zzTcBrink"), "w", name));
			const on = peakLocals(hoisted(probe("on", "zzTcBrink"), "w", name));
			// `where` would have made it 201, which Luau refuses to load.
			expect(`${name}: ${off}`).toBe(`${name}: 200`);
			expect(on).toBeLessThan(off);
		}
		// A CFrame's twelve components go out of scope with its block, its test inside it.
		expect(hoisted(probe("on", "zzTcBrink"), "w", "TcBrinkW")).toMatch(
			/\n\tdo\n\t\tdo\n\t\t\tlocal (v\w*) = v\w*\.c0\n[\s\S]*?\n\t\tend\n\t\tlocal c0\w*, [^\n]*\(v\w*\.c0\):GetComponents\(\)\n[\s\S]*?\n\tend\n/,
		);
	});

	test("the size pass is left as it is: a type's read holds at least as many locals as its measuring with `where`", () => {
		const emit = probe("on", "zzTcBrink");
		expect(hoisted(emit, "s", "TcMeasured")).toMatch(/^codec\.s_TcMeasured = function\(v\w*, where\w*\)/);
		expect(peakLocals(hoisted(emit, "s", "TcMeasured"))).toBeLessThanOrEqual(
			peakLocals(hoisted(probe("off", "zzTcBrink"), "r", "TcMeasured")),
		);
	});
});

describe("enum items", () => {
	test("a check's message names an item as the item, alone, among items and in a union", () => {
		expect(serialize(on(), "tcEnumItem")).toMatch(
			/if (v\w*) ~= Enum\.Material\.Plastic then\s*codec\.checkType\("Enum\.Material\.Plastic", \1, "value", true\)\s*end/,
		);
		expect(serialize(on(), "tcEnumItems")).toMatch(
			/if index\w* == nil then\s*codec\.checkType\("Enum\.Material\.Plastic \| Enum\.Material\.Wood", v\w*, "value", true\)/,
		);
		expect(serialize(on(), "tcEnumItemsOrNumber")).toMatch(
			/else\s*codec\.checkType\("Enum\.Material\.Plastic \| Enum\.Material\.Wood \| number", v\w*, "value"\)\s*end/,
		);
		// Every item used to print as its syntax kind, `#212`.
		expect(on()).not.toMatch(/checkType\(["'][^"'\n]*#\d/);
	});

	test("the union warning names an item as the item", () => {
		expect(probeOutput("off")).toMatch(
			/src\/zzTcEnums\.ts:\d+:\d+ - the union 'Enum\.KeyCode\.A \| Partial<\{ a: number; \}> \| Partial<\{ b: string; \}>' has members a value cannot tell apart/,
		);
		expect(probeOutput("off")).not.toContain("#212");
	});

	test("members an item tells apart are neither warned about nor tried out of their written order", () => {
		// Any two items were the same literal to `primitiveFit`: `tcByKey` was warned about, and
		// `tcReordered`'s second member was tried first, with the first only checked to be a table.
		expect(probeOutput("off").match(/zzTcEnums\.ts:\d+:\d+ - [^\n]*cannot tell apart/g)).toHaveLength(1);
		expect(serialize(probe("off", "zzTcEnums"), "tcReordered")).toMatch(
			/if guard\w*\(v\w*\) then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)[\s\S]*?elseif type\(v\w*\) == "table" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/,
		);
	});
});

describe("a struct the Roblox API declares, in a union", () => {
	test("is a member that takes anything, tried last, with the checks off and on: no typeof names it", () => {
		// It used to be tested with `typeIs(v, "GroupInfo")`, which roblox-ts refuses (TS2345).
		for (const build of ["off", "on"] as const) {
			const emit = serialize(probe(build, "zzTcGroup"), "tcGroupOrNumber");
			expect(emit).not.toMatch(/typeof\([^)]*\) == "GroupInfo"/);
			expect(emit).toMatch(
				/elseif true then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*if (v\w*) ~= nil then\s*table\.insert\(blobs\w*, \1\)/,
			);
		}
	});
});

describe("a boolean literal", () => {
	test("`undefined`, where strictNullChecks is off, calls the helper as any value of the wrong type does", () => {
		const sendNil = functionBody(probe("nosnc", "zzTcNosnc"), "tcSendNil");
		expect(sendNil).toMatch(
			/\n\tcodec\.checkType\("boolean", nil, "'tcNosnc' \[0\]"\)\n\tbuffer\.writeu8\(buf\w*, o\w*, if nil then 1 else 0\)/,
		);
		// `true` needs no test.
		const literal = functionBody(probe("nosnc", "zzTcNosnc"), "tcSendTrue");
		expect(literal).not.toContain('checkType("boolean"');
		expect(literal).toMatch(/buffer\.writeu8\(buf\w*, o\w*, if true then 1 else 0\)/);
	});
});

describe("the helper", () => {
	test("is defined once per file, builds the message and raises", () => {
		expect(on().match(/^codec\.checkType = function/gm)).toHaveLength(1);
		expect(on()).toMatch(
			/\ncodec\.checkType = function\((expected\w*), (value\w*), (where\w*), (show\w*)\)\n\tlocal (_value\w*) = \2\n\tlocal (got\w*) = typeof\(\5\)\n\tif \4 then\n\t\tif \6 == "string" then\n\t\t\t\6 = `"\{\2\}"`\n\t\telseif \6 == "number" or \6 == "boolean" or \6 == "EnumItem" then\n\t\t\t\6 = `\{\2\}`\n\t\tend\n\tend\n\tlocal (message\w*) = `\[Flamework\] \{\1\} expected, got \{\6\}, at \{\3\}`\n\terror\(\7, 2\)\nend/,
		);
		expect(on().indexOf("codec.checkType = function")).toBeLessThan(on().indexOf("codec.checkType("));
		expect(on()).not.toContain("RunService");
	});

	test("under warn, warns about a boolean and lets it through, and raises for the rest", () => {
		const helper = variant("warnServerNone").match(/\ncodec\.checkType = function[\s\S]*?\nend\n/)![0];
		expect(helper).toMatch(
			/if expected == "boolean" then\s*warn\(message\w*\)\s*return true\s*end\s*error\(message\w*, 2\)/,
		);
	});

	test("under a side, asks the realm first and returns false outside it", () => {
		const helper = variant("warnServerNone").match(/\ncodec\.checkType = function[\s\S]*?\nend\n/)![0];
		expect(helper).toMatch(
			/^\ncodec\.checkType = function\([^)]*\)\n\tif not game:GetService\("RunService"\):IsServer\(\) then\s*return false\s*end/,
		);
	});

	test("type checks do not depend on category: with none, the widths are unchecked and the types tested", () => {
		const none = variant("warnServerNone", "widthChecks");
		expect(none).not.toContain("checkWidth");
		expect(serialize(none, "implicitU8")).toMatch(
			check(`type\\(n\\w*\\) == "number"`, "number", "n\\w*", `"value"`),
		);
		expect(serialize(variant("warnServerNone"), "tcBoolean")).toMatch(/codec\.checkType\("boolean"/);
	});
});
