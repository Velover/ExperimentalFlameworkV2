import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, compileFixtureFresh, compileFixtureWithEnv, compileProbes, emitted } from "./compile";

/*
 * `Serialization.Implicit` widths (an optional brand) and the checks generated where values are
 * written (`serialization.checks`). The fixture builds with the defaults -- implicit widths checked,
 * raising, in both realms -- and `widthChecks.ts` is built again here under the other settings.
 */

/** What each width is written with, as the strict twin writes it. */
const WRITES: Record<string, RegExp> = {
	U8: /buffer\.writeu8\(buf\w*, 0, v\w*\)/,
	I8: /buffer\.writei8\(buf\w*, 0, v\w*\)/,
	U16: /buffer\.writeu16\(buf\w*, 0, v\w*\)/,
	I16: /buffer\.writei16\(buf\w*, 0, v\w*\)/,
	U32: /buffer\.writeu32\(buf\w*, 0, v\w*\)/,
	I32: /buffer\.writei32\(buf\w*, 0, v\w*\)/,
	F32: /buffer\.writef32\(buf\w*, 0, v\w*\)/,
	F64: /buffer\.writef64\(buf\w*, 0, v\w*\)/,
	Varint: /o\w* = vwrite\(buf\w*, o\w*, v\w*\)/,
	String8: /buffer\.writeu8\(buf\w*, o\w*, length\w*\)/,
	String16: /buffer\.writeu16\(buf\w*, o\w*, length\w*\)/,
	String32: /buffer\.writeu32\(buf\w*, o\w*, length\w*\)/,
	Buffer16: /buffer\.writeu16\(buf\w*, o\w*, length\w*\)/,
	Buffer32: /buffer\.writeu32\(buf\w*, o\w*, length\w*\)/,
};

/** The widths that can refuse a value, and so get a check. */
const CHECKED = ["U8", "I8", "U16", "I16", "U32", "I32", "F32", "Varint", "String8", "String16", "Buffer16"];

const variants: Record<"allWarnServer" | "none" | "clientObfuscated", Map<string, string>> = {} as never;

beforeAll(() => {
	const builds = {
		allWarnServer: {
			FLAMEWORK_FIXTURE_CHECKS: "all",
			FLAMEWORK_FIXTURE_CHECKS_MODE: "warn",
			FLAMEWORK_FIXTURE_CHECKS_SIDE: "server",
		},
		none: { FLAMEWORK_FIXTURE_CHECKS: "none" },
		clientObfuscated: { FLAMEWORK_FIXTURE_CHECKS_SIDE: "client", FLAMEWORK_FIXTURE_OBFUSCATE: "true" },
	};
	for (const [name, env] of Object.entries(builds)) {
		const result = compileFixtureWithEnv(env);
		if (result.status !== 0) throw new Error(`fixture failed to compile with ${name}:\n${result.output}`);
		variants[name as keyof typeof variants] = result.files;
	}

	// What later tests read from disk is the ordinary build again.
	const fresh = compileFixtureFresh();
	if (fresh.status !== 0) throw new Error(`fixture failed to compile:\n${fresh.output}`);
}, 600_000);

afterAll(() => {
	compileFixture();
});

const source = () => emitted("widthChecks");
const variant = (name: keyof typeof variants, file = "widthChecks") => {
	const emit = variants[name].get(file);
	if (emit === undefined) throw new Error(`the ${name} build did not emit '${file}'`);
	return emit;
};

/** `local <name> = Flamework.createSerializer({ ... })` in an emit. */
function serializer(emit: string, name: string): string {
	const match = emit.match(new RegExp(`local ${name} = Flamework\\.createSerializer\\([\\s\\S]*?\\n\\}\\)\\n`));
	if (!match) throw new Error(`no ${name} in the emit`);
	return match[0];
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

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

/** An emit without its checks and with generated names' numeric suffixes dropped, so two widths compare. */
function withoutChecks(block: string, name: string): string {
	return block
		.replace(`local ${name} =`, "local NAME =")
		.replace(/\n\t*if not \([^\n]*\) then\n\t*codec\.checkWidth\([^\n]*\)\n\t*end/g, "")
		.replace(/\n\t*if math\.abs\([^\n]* then\n\t*codec\.checkWidth\([^\n]*\)\n\t*end/g, "")
		.replace(/\n\t*codec\.checkWidth\([^\n]*\)/g, "")
		.replace(/(\w)_\d+\b/g, "$1");
}

describe("implicit widths", () => {
	test("are recognised for every width and written exactly as their strict twins", () => {
		for (const width of Object.keys(WRITES)) {
			const implicit = serializer(source(), `implicit${width}`);
			const strict = serializer(source(), `strict${width}`);
			expect(`${width}: ${WRITES[width].test(implicit)}`).toBe(`${width}: true`);
			expect(withoutChecks(implicit, `implicit${width}`)).toBe(withoutChecks(strict, `strict${width}`));
		}
		// Before, an optional brand's `"u16" | undefined` was no literal, and the value went out as an f64.
		expect(serializer(source(), "implicitU16")).not.toContain("writef64");
	});

	test("check the widths that can refuse a value, and only those, leaving strict ones alone by default", () => {
		for (const width of Object.keys(WRITES)) {
			const checked = serializer(source(), `implicit${width}`).includes("checkWidth(");
			expect(`${width}: ${checked}`).toBe(`${width}: ${CHECKED.includes(width)}`);
			expect(`${width}: ${serializer(source(), `strict${width}`).includes("checkWidth(")}`).toBe(
				`${width}: false`,
			);
		}
	});

	test("count a brand of the project's own as implicit when its property is optional", () => {
		// On a property of its own, or on `__brand` as the strict widths have it.
		for (const name of ["ownU16", "sharedU16"]) {
			const own = serializer(source(), name);
			expect(own).toMatch(/buffer\.writeu16\(buf\w*, 0, v\w*\)/);
			expect(own).toMatch(/codec\.checkWidth\("u16", v\w*, "value"\)/);
		}
	});
});

describe("mixing widths", () => {
	test("goes as implicitMixing.ts says, which the fixture's build checks", () => {
		// Each `Expect` and `Refused` there is a type that does not compile when it does not hold:
		// implicit widths mix with each other and take strict ones, implicit into strict is refused.
		const result = compileFixture();
		expect(result.status).toBe(0);
		expect(plain(result.output)).not.toContain("implicitMixing");
		expect(emitted("implicitMixing")).toMatch(/\nreturn nil\n?$/);
	});

	test("keeps both members of a union of two implicit widths, and packs what a call declares", () => {
		const write = hoisted(source(), "w", "Mixed");
		expect(write).toMatch(
			/if type\(v\w*\) == "number" and \(v\w* >= 0 and v\w* <= 255 and v\w* % 1 == 0\) then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*buffer\.writeu8\(buf\w*, o\w* \+ 1, v\w*\)/,
		);
		expect(write).toMatch(
			/elseif type\(v\w*\) == "number" and \(v\w* >= 0 and v\w* <= 65535 and v\w* % 1 == 0\) then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)\s*buffer\.writeu16\(buf\w*, o\w* \+ 1, v\w*\)/,
		);
		expect(write).toMatch(/codec\.checkWidth\("u8 \| u16", v\w*, where\w*\)/);

		// `[small, big]` and `flag ? big : small` are inferred; what is written is what `mix` declares.
		const send = functionBody(source(), "sendMixed");
		expect(send).toMatch(/codec\.w_Mixed\(buf\w*, o\w*, item\w*, "'mix' \[0\]\[\]"\)/);
		expect(send).toMatch(
			/local (arg\w*) = if flag then big else small\n[\s\S]*\n\tif not \(\1 >= 0 and \1 <= 255 and \1 % 1 == 0\) then\n\t\tcodec\.checkWidth\("u8", \1, "'mix' \[1\]"\)\n\tend\n\tbuffer\.writeu8\(buf\w*, o\w*, \1\)/,
		);
	});

	test("takes the same width named twice as that width, strict when a brand is required", () => {
		const strict = serializer(source(), "sameWidthStrict");
		expect(strict).toMatch(/buffer\.writeu16\(buf\w*, 0, v\w*\)/);
		expect(strict).not.toContain("checkWidth");
		expect(serializer(source(), "sameWidthImplicit")).toMatch(
			/codec\.checkWidth\("u16", v\w*, "value"\)\s*end\s*buffer\.writeu16\(buf\w*, 0, v\w*\)/,
		);
	});

	test("writes a strict value and an implicit one inferred together as the implicit twin", () => {
		// `[strict, held]` is an `Implicit.u8[]` and `flag ? strict : held` an `Implicit.u8`, not a union of
		// the two, whose tag ahead of every value would double what is sent.
		const body = functionBody(source(), "inferredTogether");
		expect(body).not.toContain("union's members");
		// The array's code is shared, and writes each value as a checked u8.
		const list = body.match(/codec\.w_(\w+)\(buf\w*, 0, v\w*, "value"\)/);
		expect(list).not.toBeNull();
		const write = hoisted(source(), "w", list![1]);
		expect(write).not.toContain("union's members");
		expect(write).toMatch(
			/codec\.checkWidth\("u8", item\w*, where\w* \.\. "\[\]"\)\s*end\s*buffer\.writeu8\(buf\w*, o\w*, item\w*\)\s*o\w* \+= 1/,
		);
		// The single value is one byte, checked.
		expect(body).toMatch(
			/local buf\w* = buffer\.create\(1\)\s*if not \(v\w* >= 0 and v\w* <= 255 and v\w* % 1 == 0\) then\s*codec\.checkWidth\("u8", v\w*, "value"\)\s*end\s*buffer\.writeu8\(buf\w*, 0, v\w*\)/,
		);
	});

	test("refuses a type that names two different widths, naming it", () => {
		const header = `import { Flamework, Serialization } from "@flamework-experimental/core";\n`;
		const result = compileProbes({
			// TypeScript prints this one as `never`: its two required brands conflict.
			twoWidthsNever: `${header}export const n = Flamework.createSerializer<Serialization.u8 & Serialization.u16>();
`,
			// Two errors in one file: each is reported with only its own chain.
			twoWidthsTwice: `${header}export const p = Flamework.createSerializer<{ p: Serialization.Implicit.u8 & Serialization.Implicit.u16 }>();
export const q = Flamework.createSerializer<{ q: string; r: Serialization.Implicit.i8 & Serialization.Implicit.u32 }>();
`,
			twoWidthsStrict: `${header}type StrictAndImplicit = Serialization.u16 & Serialization.Implicit.u8;
export const a = Flamework.createSerializer<StrictAndImplicit>();
`,
			twoWidthsImplicit: `${header}type TwoImplicit = Serialization.Implicit.u8 & Serialization.Implicit.u16;
export const b = Flamework.createSerializer<{ id: TwoImplicit }>();
`,
			twoWidthsOwn: `${header}type OwnAndImplicit = number & { readonly __brand?: "u16" } & Serialization.Implicit.u8;
export const c = Flamework.createSerializer<OwnAndImplicit>();
`,
			twoWidthsString: `${header}type TwoStrings = Serialization.Implicit.string8 & Serialization.string16;
export const d = Flamework.createSerializer<TwoStrings>();
`,
			twoWidthsBuffer: `${header}type TwoBuffers = Serialization.buffer16 & Serialization.Implicit.buffer32;
export const e = Flamework.createSerializer<TwoBuffers>();
`,
		});

		const output = plain(result.output);
		expect(result.status).not.toBe(0);
		expect(output).toContain(
			"Flamework cannot serialize this type: 'StrictAndImplicit' names two widths, u16 and u8; a value is written at one width, so keep one of them.",
		);
		expect(output).toContain("'TwoImplicit' names two widths, u8 and u16");
		expect(output).toContain("Reached through: { id: TwoImplicit; } > TwoImplicit");
		expect(output).toContain("'OwnAndImplicit' names two widths, u16 and u8");
		expect(output).toContain("'TwoStrings' names two widths, string8 and string16");
		expect(output).toContain("'TwoBuffers' names two widths, buffer16 and buffer32");

		// Named as written, not as TypeScript prints it.
		expect(output).toContain("'Serialization.u8 & Serialization.u16' names two widths, u8 and u16");
		expect(output).not.toContain("'never'");
		expect(output).toContain(
			"'Serialization.Implicit.u8 & Serialization.Implicit.u16' names two widths, u8 and u16",
		);
		expect(output).toContain(
			"'Serialization.Implicit.i8 & Serialization.Implicit.u32' names two widths, i8 and u32",
		);
		// The second error's chain starts from its own value, not from where the first one stopped.
		const chains = output.match(/^Reached through: .*$/gm) ?? [];
		const second = chains.find((chain) =>
			chain.endsWith("> Serialization.Implicit.i8 & Serialization.Implicit.u32"),
		);
		expect(second).toMatch(
			/^Reached through: \{ q: string; r: [^>]* \}; \} > Serialization\.Implicit\.i8 & Serialization\.Implicit\.u32$/,
		);
		expect(second).not.toContain("p:");
	});
});

describe("the check code", () => {
	test("is one helper per file, defined ahead of everything that calls it, that builds the message and raises", () => {
		expect(source().match(/^codec\.checkWidth = function/gm)).toHaveLength(1);
		expect(source()).toMatch(
			/\ncodec\.checkWidth = function\(width\w*, value\w*, where\w*, (unit\w*)\)\n\tif \1 == nil then\n\t\t\1 = ""\n\tend\n\tlocal message\w* = `\[Flamework\] \{width\w*\} cannot hold \{value\w*\}\{\1\}, at \{where\w*\}`\n\terror\(message\w*, 2\)\nend/,
		);
		expect(source().indexOf("codec.checkWidth = function")).toBeLessThan(source().indexOf("codec.checkWidth("));
		// Kept in the file's table of hoisted functions, the one local the file has for them all: Luau
		// allows 200 locals in a function, the file's main chunk included.
		expect(source()).not.toMatch(/^local checkWidth/m);
		expect(source().match(/^local codec\w* = /gm)).toHaveLength(1);
		expect(source().indexOf("local codec = {}")).toBeLessThan(source().indexOf("codec.checkWidth = function"));
		// Both realms: nothing asks which one it is.
		expect(source()).not.toContain("RunService");
	});

	test("tests a value where it is written and calls the helper only when the test fails", () => {
		expect(serializer(source(), "implicitU16")).toMatch(
			/if not \(v\w* >= 0 and v\w* <= 65535 and v\w* % 1 == 0\) then\s*codec\.checkWidth\("u16", v\w*, "value"\)\s*end\s*buffer\.writeu16\(buf\w*, 0, v\w*\)/,
		);
		expect(serializer(source(), "implicitI32")).toMatch(
			/if not \(v\w* >= -2147483648 and v\w* <= 2147483647 and v\w* % 1 == 0\) then\s*codec\.checkWidth\("i32"/,
		);
		expect(serializer(source(), "implicitVarint")).toMatch(
			/if not \(v\w* >= 0 and v\w* <= 34359738367 and v\w* % 1 == 0\) then\s*codec\.checkWidth\("varint", v\w*, "value"\)\s*end\s*o\w* = vwrite/,
		);
		// NaN and the infinities pass an f32's test; a finite number past its range does not.
		expect(serializer(source(), "implicitF32")).toMatch(
			/if math\.abs\(v\w*\) > 3\.4028234663852886e\+38 and math\.abs\(v\w*\) < math\.huge then\s*codec\.checkWidth\("f32", v\w*, "value"\)\s*end/,
		);
		// A length past its prefix: the check first, then the refusal a string8 has always had.
		expect(serializer(source(), "implicitString8")).toMatch(
			/if length\w* > 255 then\s*codec\.checkWidth\("string8", length\w*, "value", " bytes"\)\s*error\("string is longer than its u8 length prefix allows"\)\s*end/,
		);
		expect(serializer(source(), "implicitString16")).toMatch(
			/if length\w* > 65535 then\s*codec\.checkWidth\("string16"/,
		);
		expect(serializer(source(), "implicitBuffer16")).toMatch(
			/if length\w* > 65535 then\s*codec\.checkWidth\("buffer16", length\w*, "value", " bytes"\)\s*error\("buffer is longer than its u16 length prefix allows"\)/,
		);
	});

	test("says where the value is: the member and argument at a call site, a callback's result", () => {
		const move = functionBody(source(), "sendMove");
		expect(move).toMatch(/codec\.checkWidth\("u16", id, "'move' \[0\]"\)/);
		expect(move).toMatch(
			/local n\w* = arg\w*\.x\s*if not \(n\w* >= -32768[^\n]*\) then\s*codec\.checkWidth\("i16", n\w*, "'move' \[1\]\.x"\)/,
		);
		expect(functionBody(source(), "askFor")).toMatch(/codec\.checkWidth\("u8", id, "'ask' \[0\]"\)/);
		expect(source()).toMatch(
			/_setCallback\(callback\w*, function\(value\w*\)[\s\S]*?codec\.checkWidth\("u16", value\w*, "'ask' result"\)/,
		);
	});

	test("reads a value once, into a local in a block of its own, so checked writes add no locals to a function", () => {
		// Luau allows 200 locals in a function. A local per checked write, left in the function's own
		// scope, ran a function that fires 40 times or a struct of 250 fields past it.
		const move = functionBody(source(), "sendMove");
		expect(move).toMatch(
			/\n\tdo\n\t\tlocal (n\w*) = arg\w*\.x\n\t\tif not \(\1 >= -32768 and \1 <= 32767 and \1 % 1 == 0\) then\n\t\t\tcodec\.checkWidth\("i16", \1, "'move' \[1\]\.x"\)\n\t\tend\n\t\tbuffer\.writei16\(buf\w*, 2, \1\)\n\tend\n/,
		);
		expect(move).not.toMatch(/\n\tlocal n\w* =/);
		// A plain name needs no local of its own: it is tested and written as it is.
		expect(move).toMatch(/\n\tif not \(id >= 0 and id <= 65535 and id % 1 == 0\) then/);
		const entity = hoisted(source(), "w", "Entity");
		expect(entity).toMatch(/\n\tdo\n\t\tlocal n\w* = v\w*\.id\n/);
		expect(entity).toMatch(/\n\tdo\n\t\tlocal n\w* = object\w*\.x\n/);
	});

	test("judges a literal when it builds: one that fits needs nothing, one that does not calls the check as it is", () => {
		const literals = functionBody(source(), "sendLiterals");
		expect(literals).toMatch(/buffer\.writeu16\(buf\w*, 0, 3\)/);
		expect(literals).not.toMatch(/codec\.checkWidth\("u16", 3,/);
		expect(literals).toMatch(
			/\n\tcodec\.checkWidth\("u16", 70000, "'move' \[0\]"\)\n\tbuffer\.writeu16\(buf\w*, 0, 70000\)/,
		);
	});

	test("passes where a value is to a named type's shared writer, which joins its own path to it", () => {
		const write = hoisted(source(), "w", "Entity");
		expect(write).toMatch(/^codec\.w_Entity = function\(buf\w*, o\w*, v\w*, where\w*\)/);
		expect(write).toMatch(/codec\.checkWidth\("u16", n\w*, where\w* \.\. "\.id"\)/);
		expect(write).toMatch(/codec\.checkWidth\("string8", length\w*, where\w* \.\. "\.name", " bytes"\)/);
		expect(write).toMatch(/codec\.checkWidth\("u8", item\w*, where\w* \.\. "\.tags\[\]"\)/);
		expect(write).toMatch(/codec\.checkWidth\("i8", key\w*, where\w* \.\. "\.scores<key>"\)/);
		expect(write).toMatch(/codec\.checkWidth\("buffer16", length\w*, where\w* \.\. "\.scores<value>", " bytes"\)/);
		expect(write).toMatch(/codec\.checkWidth\("i16", n\w*, where\w* \.\. "\.pos\.x"\)/);
		// The strict field is written as it always was.
		expect(write.match(/codec\.checkWidth\(/g)).toHaveLength(6);
		expect(serializer(source(), "entitySerializer")).toMatch(/codec\.w_Entity\(buf\w*, 0, v\w*, "Entity"\)/);
		// Reading needs no check, and the size pass none either.
		expect(hoisted(source(), "r", "Entity")).not.toContain("checkWidth");
		expect(hoisted(source(), "s", "Entity")).not.toContain("checkWidth");
	});

	test("writes a number no member of a union takes through the check, as the first checked member", () => {
		const write = hoisted(source(), "w", "Pick");
		// A member with a range takes only what fits it, so its write needs no check of its own.
		expect(write).toMatch(
			/if type\(v\w*\) == "number" and \(v\w* >= 0 and v\w* <= 255 and v\w* % 1 == 0\) then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*buffer\.writeu8\(buf\w*, o\w* \+ 1, v\w*\)/,
		);
		expect(write).toMatch(
			/elseif type\(v\w*\) == "number" and codec\.checkWidth\("u8 \| u16", v\w*, where\w*\) then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*buffer\.writeu8\(buf\w*, o\w* \+ 1, v\w*\)\s*o\w* \+= 2\s*else\s*error\("value matches none of the union's members"\)/,
		);
		expect(write.match(/codec\.checkWidth\(/g)).toHaveLength(1);
		// The size pass leaves room for it.
		expect(hoisted(source(), "s", "Pick")).toMatch(/elseif type\(v\w*\) == "number" then\s*size\w* \+= 1\s*end/);
		// With a plain `number`, every number has a member: nothing to check.
		expect(serializer(source(), "orNumberSerializer")).not.toContain("checkWidth");
	});

	test("names a strict width and its implicit twin once in the fallback's message", () => {
		const write = hoisted(source(), "w", "Twins");
		expect(write).toMatch(/elseif type\(v\w*\) == "number" and codec\.checkWidth\("u16", v\w*, where\w*\) then/);
		expect(write).not.toContain("u16 | u16");
	});

	test("gives a shared writer no `where` when nothing it writes itself is checked", () => {
		// The width member of `Implicit.u16 | number` only takes what its test found in range, and a
		// number that fits no member is the `number`'s: the writer checks nothing.
		expect(hoisted(source(), "w", "OrNumber")).toMatch(/^codec\.w_OrNumber = function\(buf\w*, o\w*, v\w*\)\n/);
		expect(source()).toMatch(/codec\.w_OrNumber\(buf\w*, 0, v\w*\)\n/);
	});
});

describe("serialization.checks", () => {
	test("category all checks strict widths too", () => {
		const all = variant("allWarnServer");
		for (const width of CHECKED) {
			expect(`${width}: ${serializer(all, `strict${width}`).includes("checkWidth(")}`).toBe(`${width}: true`);
		}
		expect(serializer(all, "strictU16")).toMatch(/codec\.checkWidth\("u16", v\w*, "value"\)/);
		expect(hoisted(all, "w", "Entity").match(/codec\.checkWidth\(/g)).toHaveLength(7);
	});

	test("category none generates nothing, and an implicit width compiles exactly as its strict twin", () => {
		const none = variant("none");
		expect(none).not.toContain("checkWidth");
		for (const width of Object.keys(WRITES)) {
			const implicit = serializer(none, `implicit${width}`).replace(`local implicit${width} =`, "local NAME =");
			const strict = serializer(none, `strict${width}`).replace(`local strict${width} =`, "local NAME =");
			expect(implicit.replace(/(\w)_\d+\b/g, "$1")).toBe(strict.replace(/(\w)_\d+\b/g, "$1"));
		}
		// A string8 past its prefix is still refused, as a strict one is.
		expect(serializer(none, "implicitString8")).toMatch(
			/if length\w* > 255 then\s*error\("string is longer than its u8 length prefix allows"\)\s*end/,
		);
		// A number no member of the union takes raises as it always has.
		expect(hoisted(none, "w", "Pick")).toMatch(/else\s*error\("value matches none of the union's members"\)/);
		expect(hoisted(none, "w", "Pick")).not.toMatch(/elseif type\(v\w*\) == "number" then/);
	});

	test("mode warn warns and returns true, so the value is written as it is", () => {
		const helper = variant("allWarnServer").match(/\ncodec\.checkWidth = function[\s\S]*?\nend\n/)![0];
		expect(helper).toMatch(/\twarn\(message\)\n\treturn true\nend/);
		expect(helper).not.toContain("error(");
	});

	test("side asks the realm in the helper, so a shared module checks only where it runs in that realm", () => {
		const server = variant("allWarnServer").match(/\ncodec\.checkWidth = function[\s\S]*?\nend\n/)![0];
		expect(server).toMatch(/if not game:GetService\("RunService"\):IsServer\(\) then\s*return false\s*end/);
		const client = variant("clientObfuscated").match(/\ncodec\.checkWidth = function[\s\S]*?\nend\n/)![0];
		expect(client).toMatch(/if not game:GetService\("RunService"\):IsClient\(\) then\s*return false\s*end/);
		expect(client).toMatch(/error\(message, 2\)/);
		// Asked only once a value has failed: the writes themselves never ask.
		expect(variant("allWarnServer").match(/RunService/g)).toHaveLength(1);
	});

	test("under obfuscation, a call site's message leaves the member's name out", () => {
		const obfuscated = variant("clientObfuscated");
		expect(obfuscated).toMatch(/codec\.checkWidth\("u16", id, "\[0\]"\)/);
		expect(obfuscated).toMatch(/codec\.checkWidth\("i16", n\w*, "\[1\]\.x"\)/);
		expect(obfuscated).not.toContain("'move'");
		expect(obfuscated).not.toContain("'ask'");
	});
});

describe("default output", () => {
	test("a file without an implicit width compiles exactly as it does with the checks off", () => {
		// The fixture's other files use strict widths, unions, hoisted types and call sites of every
		// kind; the default checks add nothing to any of them.
		const none = variants.none;
		const defaults = compileFixture().files;
		expect(defaults.size).toBeGreaterThan(10);
		for (const [file, emit] of defaults) {
			if (file === "widthChecks") continue;
			expect(`${file}: ${emit.includes("checkWidth")}`).toBe(`${file}: false`);
			expect(`${file}: ${emit === none.get(file)}`).toBe(`${file}: true`);
		}
	});
});
