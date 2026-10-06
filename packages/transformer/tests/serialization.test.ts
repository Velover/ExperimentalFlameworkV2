import { beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { compileFixture, compileProbe, compileProbes, emitted, transformInProcess } from "./compile";

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile:\n${result.output}`);
	}
});

const source = () => emitted("serialization");

describe("Flamework.createSerializer", () => {
	test("emits plain buffer code with nothing describing the type", () => {
		expect(source()).not.toContain("Serialization");
		// A brand picks the width; a string8 gets a one-byte length prefix that is checked before writing.
		expect(source()).toMatch(/buffer\.writeu16\(buf\w*, o\w*, v\w*\.id\)/);
		expect(source()).toMatch(/if length\w* > 255 then/);
		expect(source()).toMatch(/buffer\.writeu8\(buf\w*, o\w* \+ 2, length\w*\)/);
		expect(source()).toMatch(/buffer\.writestring\(buf\w*, o\w* \+ 3, text\w*\)/);
	});

	test("writes fields in declaration order", () => {
		// `id` is declared first and lands at offset 0; the decoded object lists the fields the same way.
		expect(source()).toMatch(/buffer\.writeu16\(buf\w*, o\w*, v\w*\.id\)\s*local text\w* = v\w*\.name/);
		expect(source()).toMatch(
			/id = id\w*,\s*name = text\w*,\s*tags = array\w*,\s*where = where\w*,\s*mode = literal\w*,\s*maybe = value\w*,\s*kind = "payload",\s*owner = owner\w*,/,
		);
	});

	test("encodes literal unions as an index and constants as nothing", () => {
		expect(source()).toMatch(/local literals\w* = \{ "a", "b", "c" \}/);
		expect(source()).toMatch(/local literalIndex\w* = \{\s*a = 0,\s*b = 1,\s*c = 2,\s*\}/);
		// The constant field is restored from the type, never written.
		expect(source()).toMatch(/kind = "payload",/);
		expect(source()).not.toMatch(/"payload"\)/);
	});

	test("hoists the varint helpers once per file and uses them for counts and lengths", () => {
		expect(source()).toMatch(/local vsize = function\(n\w*\)/);
		expect(source()).toMatch(/local vwrite = function\(buf\w*, o\w*, n\w*\)/);
		expect(source()).toMatch(/local vread = function\(buf\w*, o\w*\)/);
		expect(source().match(/local vsize\w* = function/g)).toHaveLength(1);
		// Reading gives up after five bytes rather than looping on a hostile buffer.
		expect(source()).toMatch(/if scale\w* > 268435456 then\s*error\("malformed payload"\)/);

		expect(source()).toMatch(/o\w* = vwrite\(buf\w*, o\w*, #array\w*\)/);
		expect(source()).toMatch(/local count\w*, o\w* = vread\(buf\w*, o\w*\)/);
		expect(source()).toMatch(/size\w* \+= vsize\(length\w*\) \+ length\w*/);
		expect(source()).not.toMatch(/buffer\.writeu32\(buf\w*, o\w*, #array/);
	});

	test("sends blobs by a u32 index so a nil never shifts the others", () => {
		expect(source()).toMatch(/table\.insert\(blobs\w*, blob\w*\)\s*buffer\.writeu32\(buf\w*, o\w*, #blobs\w*\)/);
		expect(source()).toMatch(/else\s*buffer\.writeu32\(buf\w*, o\w*, 0\)/);
		expect(source()).toMatch(/blobs\w*\[buffer\.readu32\(buf\w*, o\w*\)\]/);
	});

	test("hoists variable-size named types into size, write and read functions that may recurse", () => {
		expect(source()).toMatch(/codec\.s_Payload = function\(v\w*\)/);
		expect(source()).toMatch(/codec\.w_Payload = function\(buf\w*, o\w*, v\w*, blobs\w*\)/);
		expect(source()).toMatch(/codec\.r_Payload = function\(buf\w*, o\w*, blobs\w*\)/);
		expect(source()).toMatch(/size\w* \+= codec\.s_Node\(item\w*\)/);
		expect(source()).toMatch(/o\w* = codec\.w_Node\(buf\w*, o\w*, item\w*\)/);
		expect(source()).toMatch(/local value\w*, o\w* = codec\.r_Node\(buf\w*, o\w*\)/);
		// The top level calls them directly: no position variable of its own.
		expect(source()).toMatch(/codec\.w_Payload\(buf\w*, 0, v\w*, blobs\w*\)/);
	});

	test("keeps every hoisted function in one table, so a file with many of them still loads", () => {
		// Regression: each hoisted type took three locals at the top of the file, and Luau allows 200
		// in a function, the file's main chunk included: past about 66 hoisted types a file compiled
		// but no longer loaded.
		expect(source().match(/^local codec\w* = \{\}$/gm)).toHaveLength(1);
		expect(source()).not.toMatch(/^local [srw]_\w+$/m);
	});

	test("encodes tuples with optional and rest elements", () => {
		// The rest count never goes negative when trailing optional elements are absent.
		expect(source()).toMatch(/local count\w* = math\.max\(#v\w* - 2, 0\)/);
		expect(source()).toMatch(/for i\w* = 3, count\w* \+ 2 do/);
		expect(source()).toMatch(/list\w*\[i\w* \+ 2\] = buffer\.readu8\(buf\w*, o\w*\) ~= 0/);
	});

	test("numbers union members as written and tests objects by a key of their own", () => {
		// `{ Coins } | { Items }`: Coins is tag 0, Items is tag 1, and neither needs a guard.
		expect(source()).toMatch(/if v\w*\.Coins ~= nil then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
		expect(source()).toMatch(/elseif v\w*\.Items ~= nil then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
		expect(source()).toMatch(/if tag\w* == 0 then\s*local Coins\w* = buffer\.readf64/);
		expect(source()).not.toMatch(/t\.interface\(\{\s*Coins/);
		// `number | string` as written: the number first. Primitives are tested with `type`, the fast path.
		expect(source()).toMatch(
			/if type\(v\w*\) == "number" then\s*if [^\n]*then\s*buffer\.writeu8\(buf\w*, o\w*, 2\)[\s\S]*?else\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/,
		);
		expect(source()).toMatch(/elseif type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
	});

	test("nests collections freely and sends classes, `object` and Instance keys as blobs", () => {
		// A class instance is a single blob slot.
		expect(source()).toMatch(/local buf\w* = buffer\.create\(4\)\s*local blobs\w* = \{\}/);
		// Map<Instance, Array<Set<string>>>: the key is a blob, the rest nests.
		expect(source()).toMatch(/local key\w* = blobs\w*\[buffer\.readu32\(buf\w*, o\w*\)\]/);
		expect(source()).toMatch(/map\w*\[key\w*\] = array\w*/);
		expect(source()).toMatch(/set\w*\[text\w*\] = true/);
		// Set<Map<string, number[]>>
		expect(source()).toMatch(/set\w*\[map\w*\] = true/);
	});

	test("tells the members of a union over every family of kind apart without a guard where it can", () => {
		// Instance | Vector3 | { kind: "a" } | { kind: "b" } | number[] | "lit" | 5, numbered as written.
		expect(source()).toMatch(/if typeof\(v\w*\) == "Instance" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
		expect(source()).toMatch(/elseif typeof\(v\w*\) == "Vector3" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
		// Objects next to non-tables are only indexed once the value is known to be a table, and the
		// chain stays flat: no temporaries, since the value is a const by the time the macros see it.
		expect(source()).toMatch(
			/elseif type\(v\w*\) == "table" and v\w*\.kind == "a" then\s*buffer\.writeu8\(buf\w*, o\w*, 2\)/,
		);
		expect(source()).toMatch(/elseif type\(v\w*\) == "table" and v\w*\.kind == "b" then/);
		expect(source()).not.toMatch(/local _v_/);
		expect(source()).not.toMatch(/_condition/);
		// A map key that is a datatype or an array of objects.
		expect(source()).toMatch(/if typeof\(key\w*\) == "Vector3" then/);
	});

	test("refuses hostile counts and trailing bytes", () => {
		expect(source()).toMatch(/if count\w* \* 9 > buffer\.len\(buf\w*\) - o\w* then\s*error\("malformed payload"\)/);
		expect(source()).toMatch(/if count\w* > buffer\.len\(buf\w*\) - o\w* then\s*error\("malformed payload"\)/);
		expect(source()).toMatch(/if o\w* ~= buffer\.len\(buf\w*\) then\s*error\("malformed payload"\)/);
	});

	test("refuses a hostile buffer length before allocating it", () => {
		// Regression: `buffer.create(length)` ran on the announced length and only the `buffer.copy`
		// after it noticed, so a five-byte payload made the decoder allocate a gibibyte first.
		expect(source()).toMatch(
			/if length\w* > buffer\.len\(buf\w*\) - o\w* then\s*error\("malformed payload"\)\s*end\s*local bytes\w* = buffer\.create\(length\w*\)/,
		);
	});

	test("caps counts of zero-size elements per payload, not per collection", () => {
		// Regression: each count of elements that take no bytes was checked against a cap of its
		// own, so nesting multiplied it: a 151-byte `Array<Array<Marker>>` payload built 50 × 65535
		// tables. The counts are tallied across the payload in a variable the file's decoders share,
		// reset where a decode starts, and only a type that holds such a count pays for it.
		expect(source()).toMatch(/local zeros\w* = 0/);
		expect(source()).toMatch(/zeros\w* \+= count\w*\s*if zeros\w* > 65535 then\s*error\("malformed payload"\)/);
		expect(source()).not.toMatch(/if count\w* > 65535 then/);
		expect(source().match(/^\s*zeros\w* = 0$/gm)).toHaveLength(1);
		expect(source()).toMatch(/deserialize = function\(buf\w*\)\s*zeros\w* = 0\s*local o\w* = 0/);
	});

	test("numbers an anonymous union as written where the value is reached, on both sides", () => {
		// Regression: `string | number` and `number | string` are one TypeScript type, and it was
		// numbered by the first spelling a file happened to meet: the receiver, walking the events in
		// declaration order, numbered both `sortA` and `sortB` as `sortA` spells it; the sender, in
		// another file, numbered both as its first call site did, and every message was dropped.
		const decoderFor = (name: string) =>
			new RegExp(
				`${name} = \\(?function\\(buf\\w*\\)\\s*local o\\w* = 0\\s*local tag\\w* = buffer\\.readu8\\(buf\\w*, o\\w*\\)\\s*local value\\w*\\s*o\\w* \\+= 1\\s*if tag\\w* == 0 then\\s*(.*)`,
			);
		expect(source().match(decoderFor("sortA"))?.[1]).toMatch(/^local length\w*, o\w* = vread/);
		expect(source().match(decoderFor("sortB"))?.[1]).toMatch(/^value\w* = buffer\.readf64/);

		const sender = emitted("spelling");
		const sendB = sender.slice(sender.indexOf("local function sendB"), sender.indexOf("local function sendA"));
		const sendA = sender.slice(sender.indexOf("local function sendA"));
		// A whole number gets the tag after the members, 2 either way; any other number the member's own.
		const numberThen = (tag: number) =>
			new RegExp(
				`if type\\(v\\w*\\) == "number" then\\s*if [^\\n]*then\\s*buffer\\.writeu8\\(buf\\w*, o\\w*, 2\\)[\\s\\S]*?else\\s*buffer\\.writeu8\\(buf\\w*, o\\w*, ${tag}\\)`,
			);
		expect(sendB).toMatch(numberThen(0));
		expect(sendB).toMatch(/elseif type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
		expect(sendA).toMatch(/if type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
		expect(sendA).toMatch(numberThen(1));
	});

	test("tests a removal marker before a patch whose fields are all optional, whatever order they are written in", () => {
		// Regression: members were tested in written order, and the patch's guard, which ignores keys it
		// does not declare, accepts any table: `Partial<Crate> | None` wrote every None as an empty
		// patch. None is tested first now, and its tag is still its written index, 1. The patch, the
		// only member left, is only checked to be a table, so it has no guard at all.
		expect(source()).toMatch(
			/codec\.w_PatchOrNone = function\(buf\w*, o\w*, v\w*\)\s*local v\w* = v\w*\s*if v\w*\.__none ~= nil then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)\s*o\w* \+= 1\s*elseif type\(v\w*\) == "table" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*o\w* = codec\.w_Partial\w*\(/,
		);
		expect(source()).not.toMatch(/t\w*\.interface\(\{\s*n = t\w*\.optional\(t\w*\.string\)/);
	});

	test("warns where a union has object members that a value cannot tell apart", () => {
		const output = compileFixture().output.replace(/\x1b\[[0-9;]*m/g, "");
		expect(output).toContain(
			`src/serialization.ts:${locate("ambiguousSerializer")} - the union 'Ambiguous' has members a value cannot tell apart: 'Partial<{ a: number; }>', 'Partial<{ b: string; }>'.`,
		);
		// Once, where the union is first written, though `ambiguousAgainSerializer` writes it too; and
		// only there: a removal marker and a patch are told apart, and so are `{ Coins } | { Items }`.
		expect(output.match(/cannot tell apart/g)).toHaveLength(1);
	});

	test("tries a member whose guard would drop part of another's value after it, a level down too", () => {
		// `Map<string, { x: number }> | Holder`: the map's guard would take a Holder and drop `pos.y`
		// and `pos.z`, while Holder's guard takes no map of `{ x }`. So Holder, written second (tag 1),
		// is tried first, by its guard, and the map is only checked to be a table.
		expect(source()).toMatch(
			/codec\.w_MapOrHolder = function\(buf\w*, o\w*, v\w*\)\s*local v\w* = v\w*\s*if guard\w*\(v\w*\) then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)[\s\S]*?elseif type\(v\w*\) == "table" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/,
		);
	});

	test("gives a branded number member of a union only the numbers that fit its width", () => {
		// Regression: `u16 | number` wrote 70000 as a u16, which arrived as 4464.
		expect(source()).toMatch(
			/if type\(v\w*\) == "number" and \(v\w* >= 0 and v\w* <= 65535 and v\w* % 1 == 0\) then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*buffer\.writeu16/,
		);
	});

	test("hoists a type with no name of its own once it is reached more than once", () => {
		// `string[]` is reached twice in `Lists`: both fields call the same functions.
		expect(source()).toMatch(/codec\.s_stringArray = function/);
		expect(source()).toMatch(
			/o\w* = codec\.w_stringArray\(buf\w*, o\w*, v\w*\.a\)\s*o\w* = codec\.w_stringArray\(buf\w*, o\w*, v\w*\.b\)/,
		);
		// A recursive one, which written out in place never ended, is named after how it is written.
		expect(source()).toMatch(/codec\.w_NodePatch_Node = function/);
		expect(source()).toMatch(/if item\w* ~= nil then\s*o\w* = codec\.w_NodePatch_Node\(buf\w*, o\w*, item\w*\)/);
	});

	test("writes a whole number in a union with `number` as a varint under the tag after the members", () => {
		// `sortOf: number | string`: 1 / n keeps -0 out, which a varint would read back as 0.
		expect(source()).toMatch(
			/size\w* \+= if v\w* < 34359738368 and 1 \/ v\w* > 0 and v\w* % 1 == 0 then vsize\(v\w*\) else 8/,
		);
		expect(source()).toMatch(
			/if v\w* < 34359738368 and 1 \/ v\w* > 0 and v\w* % 1 == 0 then\s*buffer\.writeu8\(buf\w*, o\w*, 2\)\s*o\w* = vwrite\(buf\w*, o\w* \+ 1, v\w*\)\s*else\s*buffer\.writeu8\(buf\w*, o\w*, 0\)\s*buffer\.writef64\(buf\w*, o\w* \+ 1, v\w*\)/,
		);
		expect(source()).toMatch(
			/elseif tag\w* == 2 then\s*local n\w*, o\w* = vread\(buf\w*, o\w*\)\s*value\w* = n\w*/,
		);
		// A plain `number` field is still an f64: `Point` is two of them at fixed offsets.
		expect(source()).not.toMatch(/if v\w*\.x < 34359738368/);
	});

	test("writes the elements after a tuple's rest element after the rest, and reads them back there", () => {
		const serializer = (name: string) => {
			const match = source().match(
				new RegExp(`local ${name} = Flamework\\.createSerializer\\([\\s\\S]*?\\n\\}\\)\\n`),
			);
			if (!match) throw new Error(`no ${name} in the emit`);
			return match[0];
		};

		// `[number, ...string[], boolean]`: the rest count leaves out both, and the boolean is the last value.
		const middle = serializer("restMiddleSerializer");
		expect(middle).toMatch(/local count\w* = math\.max\(#v\w* - 2, 0\)/);
		expect(middle).toMatch(/local _value\w* = v\w*\[count\w* \+ 2\]\s*buffer\.writeu8\(/);
		expect(middle).toMatch(
			/end\s*local arg\w* = buffer\.readu8\(buf\w*, o\w*\) ~= 0\s*list\w*\[count\w* \+ 2\] = arg\w*/,
		);
		expect(middle).not.toMatch(/local _value\w* = v\w*\[2\]/);

		// `[...string[], boolean]`: nothing before the rest.
		const first = serializer("restFirstSerializer");
		expect(first).toMatch(/local count\w* = math\.max\(#v\w* - 1, 0\)/);
		expect(first).toMatch(/local _value\w* = v\w*\[count\w* \+ 1\]/);
		expect(first).toMatch(/list\w*\[count\w* \+ 1\] = arg\w*/);
	});
});

describe("a field keyed by a number", () => {
	// roblox-ts keys `{ 10: v }` and `v[10]` by the number 10, and `{ "10": v }` by the string, though
	// TypeScript names the property "10" either way. 2.0.0-alpha.7 read, wrote and decoded every field
	// by its name as a string (`v["10"]`), so a required one raised, an optional one was dropped, and
	// the decoded table held a key the game never reads.
	const NUMBER_KEYS = `import { Flamework, Serialization } from "@flamework-experimental/core";
export enum Level { Low = 20, High = 21 }
export enum Tier { Bronze = 40, Silver = 41 }
interface Source { 70: string; "71": string; a: string }
export interface Declared { 10: string; "11": string; 1.5: string; 1e21: string; [-2]: string; [Level.High]: string; plain: string }
export const declared = Flamework.createSerializer<Declared>();
export const mapped = Flamework.createSerializer<{ r: Record<30 | 31, string>; m: Record<"" | 50, string>; k: { [K in 60 | 61]: string } }>();
export const partialEnum = Flamework.createSerializer<Partial<Record<Tier, string>>>();
export const derived = Flamework.createSerializer<{ p: Pick<Source, 70 | "71">; o: Omit<Source, "a">; ro: Readonly<Record<80, string>>; pa: Partial<Source> }>();
export const checked = Flamework.createSerializer<{ 90: Serialization.Implicit.u8 }>();
`;

	let compiled: ReturnType<typeof compileProbes> | undefined;
	const luau = () => {
		compiled ??= compileProbes({ numberKeys: NUMBER_KEYS });
		expect(compiled.status).toBe(0);
		return compiled.files.get("numberKeys")!;
	};
	/** The key as Luau spells it, escaped for a pattern: `10`, `1e+21`, `"11"`. */
	const spelled = (key: string) => key.replace(/[.+[\]]/g, "\\$&");
	/** Measured (`#(v[10])`), read for writing (`= v[10]`) and decoded into a table (`[10] = text`). */
	const expectKeyed = (key: string) => {
		const at = spelled(key);
		expect(luau()).toMatch(new RegExp(`#\\(\\w+\\[${at}\\]\\)`));
		expect(luau()).toMatch(new RegExp(`= \\w+\\[${at}\\]\\n`));
		expect(luau()).toMatch(new RegExp(`\\n\\s*\\[${at}\\] = \\w+,`));
	};

	test("is read, written and decoded at that number, whatever the number", () => {
		for (const key of ["10", "1.5", "1e+21", "-2"]) expectKeyed(key);
		// `[Level.High]`: the member's value.
		expectKeyed("21");
	});

	test("written as a string stays a string, and a name stays a name", () => {
		expectKeyed('"11"');
		expect(luau()).toMatch(/#\(\w+\.plain\)/);
		expect(luau()).not.toMatch(/\["(10|1\.5|1e\+21|-2|21)"\]/);
	});

	test("of a mapped type is keyed by the number its key type is", () => {
		// `Record<30 | 31, V>`, `{ [K in 60 | 61]: V }`, `Partial<Record<Tier, V>>`, `Pick`, `Omit`,
		// `Readonly` and `Partial` of a type with a number key.
		for (const key of ["30", "31", "50", "60", "61", "70", "80"]) expectKeyed(key);
		expect(luau()).toMatch(/= \w+\[40\]\n/);
		expect(luau()).toMatch(/\n\s*\[41\] = \w+,/);
		// `Record<"" | 50, V>`'s other key is a string, and `Pick<Source, 70 | "71">`'s is too.
		expectKeyed('""');
		expectKeyed('"71"');
		expect(luau()).not.toMatch(/\["(30|31|40|41|50|60|61|70|80)"\]/);
	});

	test("is named by its number in a width check's message", () => {
		expect(luau()).toMatch(/codec\.checkWidth\("u8", \w+, "value\[90\]"\)/);
	});
});

/** Where the fixture's serialization.ts builds `name`: the line and column of its `createSerializer` call. */
function locate(name: string): string {
	const text = fs.readFileSync(path.join(import.meta.dir, "fixture", "src", "serialization.ts"), "utf8");
	const lines = text.split(/\r?\n/);
	const index = lines.findIndex((line) => line.includes(`export const ${name} =`));
	return `${index + 1}:${lines[index].indexOf("Flamework.createSerializer") + 1}`;
}

describe("networking serialization", () => {
	test("keeps only decoders in the handler metadata", () => {
		expect(source()).not.toContain("encode = function");
		expect(source()).not.toContain("outgoingSerializers");
		expect(source()).toMatch(/incomingSerializers = \{\s*ping = \(?function\(buf\w*\)/);
		expect(source()).toMatch(/outgoingResults = \{\s*echo = \(?function\(buf\w*\)/);
		// `predict` gets the callback's value as it is, so a receiver has no result decoder.
		expect(source()).not.toContain("incomingResults");
	});

	test("packs event arguments at each call site and sends them through the hidden entry point", () => {
		expect(source()).toMatch(
			/local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, value\)\s*server\.pong:_broadcast\(buf\w*\)/,
		);
		expect(source()).toMatch(/server\.pong:_fire\(player, buf\w*\)/);
		// An empty list is bound with the type its context gave it, so a project's `noImplicitAny`
		// accepts the temporary.
		expect(source()).toMatch(/local target\w* = \{\}[\s\S]{0,200}?server\.pong:_fire\(target\w*, buf\w*\)/);
		// The handler's call signature is a send too.
		expect(source()).not.toMatch(/server\.pong\(player/);
		expect(source()).toMatch(/buffer\.writef32\(buf\w*, 16, where\.Z\)\s*client\.ping:_fire\(buf\w*\)/);
	});

	test("wraps the packing in a function when the call has no statement of its own", () => {
		expect(source()).toMatch(
			/client\.pong:connect\(function\(value\w*\)\s*return \(function\(\)[\s\S]*?buffer\.create\(20\)[\s\S]*?return client\.ping:_fire\(buf\w*\)\s*end\)\(\)/,
		);
	});

	test("packs where the call is evaluated, not ahead of the statement, when that would differ", () => {
		// Regression: the packing was hoisted in front of the whole statement, so it ran when the call
		// did not (behind `&&`, in an untaken branch), once for a whole loop instead of per pass, and
		// ahead of a sibling with side effects. Each of these is now an immediately invoked function.
		const body = emitted("placement");
		expect(body).toMatch(
			/holder\.score ~= nil and \(function\(\)\s*local arg\w* = holder\.score[\s\S]*?return server\.pong:_fire\(player, buf\w*\)\s*end\)\(\)/,
		);
		expect(body).toMatch(/if #scores > 0 then \(function\(\)\s*local arg\w* = scores\[1\]/);
		// A narrowed argument is read inside the closure, where the narrowing still holds, so the
		// transformed file type-checks (this was TS18048 when it was read ahead of the statement).
		expect(body).toMatch(/if missing ~= nil then \(function\(\)\s*local arg\w* = missing\.score/);
		expect(body).toMatch(
			/if _condition then\s*\(function\(\)\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, i\)/,
		);
		expect(body).toMatch(
			/table\.insert\(log, "first"\)\s*local ordered = \{ #log, \(function\(\)\s*local arg\w* = `\{#log\}`/,
		);
		// A call that is the whole statement, or the value of a `return` or a declaration, still
		// packs in front of it with no closure.
		expect(source()).toMatch(
			/local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, value\)\s*server\.pong:_broadcast\(buf\w*\)/,
		);
		expect(source()).toMatch(/o\w* \+= length\w*\s*return clientFunctions\.echo:_invoke\(buf\w*\)/);
	});

	test("packs a call through `?.` behind its short-circuit", () => {
		// Regression: `maybe?.pong.fire(...)` was left alone -- the target's type carries `undefined`
		// and the marker was looked for on that -- and sent raw values the peer dropped as malformed.
		// The call is wrapped in a function that returns where the chain would short-circuit, testing
		// the operand ahead of each `?.` so the narrowing the chain gave the arguments still holds.
		const body = emitted("placement");
		expect(body).toMatch(
			/if maybe == nil then\s*return nil\s*end\s*local arg\w* = if maybe == nil then 0 else 1[\s\S]*?return _result\w*:_fire\(player, buf\w*\)/,
		);
		expect(body).toMatch(/if callers == nil then\s*return nil\s*end[\s\S]*?return _result\w*:_invoke\(buf\w*\)/);
		expect(body).toMatch(
			/if receivers == nil then\s*return nil\s*end[\s\S]*?return target\w*:_setCallback\(callback\w*, function\(value\w*\)/,
		);
		// A target that is not a reference is bound first and the local is tested.
		expect(body).toMatch(
			/local target\w* = _target\w*\s*if target\w* == nil then\s*return nil\s*end\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, 2\)\s*return target\w*:_fire\(player, buf\w*\)/,
		);
		expect(body).not.toMatch(/\.pong:fire\(/);
		expect(body).not.toMatch(/\.echo:invoke\(/);
		expect(body).not.toMatch(/\.echo:setCallback\(/);
	});

	test("evaluates the target ahead of the arguments", () => {
		// Regression: the packing read `calls` before `pick()` ran, since the target was only
		// evaluated inside the call after it.
		expect(emitted("placement")).toMatch(
			/local target\w* = pick\(\)\.pong\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, calls\)\s*target\w*:_fire\(player, buf\w*\)/,
		);
		// A plain reference is left where it was: no local, no change to the emit.
		expect(source()).toMatch(/server\.pong:_fire\(player, buf\w*\)/);
	});

	test("packs function requests and registers callbacks with a packer for their results", () => {
		expect(source()).toMatch(/return clientFunctions\.echo:_invoke\(buf\w*\)/);
		// Regression: the packing wrapped the callback, below the middleware, so a value a middleware
		// returned left unpacked and a middleware awaiting the next step saw `[payload, blobs]`. The
		// callback is now registered as it is; the runtime packs what the chain resolves with.
		expect(source()).toMatch(/target\w*:_setCallback\(callback\w*, function\(value\w*\)/);
		expect(source()).not.toMatch(/Networking\.Skip/);
		expect(source()).toMatch(/return \{ buf\w* \}/);
		// Regression: a `Promise<string>` result was guarded with `Promise.is`, which a value that
		// crossed a remote never passes; the guard checks the resolved type.
		expect(source()).toMatch(/outgoing = \{\s*echo = t\.string,/);
	});

	test("sends nothing for a list that carries nothing", () => {
		expect(source()).toMatch(/client\.bump:_fire\(\)/);
		expect(source()).toMatch(/clientFunctions\.nothing:_invoke\(\)/);
		// No decoder for it either: the runtime passes the empty list through.
		expect(source()).not.toMatch(/bump = \(?function/);
		expect(source()).not.toMatch(/nothing = \(?function\(buf/);
		// A void callback's packer returns nothing instead of a packed list.
		expect(source()).toMatch(/target\w*:_setCallback\(callback\w*, function\(value\w*\)\s*return nil\s*end\)/);
	});

	test("leaves raw members exactly as written", () => {
		expect(source()).toMatch(/client\.rawPing:fire\(value\)/);
		expect(source()).toMatch(/server\.tick:broadcast\(value\)/);
		expect(source()).toMatch(/serverFunctions\.rawEcho:setCallback\(function\(player, value\)/);
		expect(source()).not.toMatch(/rawPing = \(?function/);
		expect(source()).not.toMatch(/rawEcho = \(?function\(buf/);
		// RawUnreliable keeps the unreliable channel.
		expect(source()).toMatch(/outgoingUnreliable = \{\s*tick = true/);
	});

	test("writes a boolean from the value itself, so a literal argument still compiles", () => {
		// Regression: this was `value === true`, which TypeScript rejects as a pointless comparison
		// once the packed argument is a literal -- the shape a call site produces.
		expect(source()).toMatch(/buffer\.writeu8\(buf\w*, 0, if false then 1 else 0\)/);
		expect(source()).toMatch(/buffer\.writeu8\(buf\w*, 0, if on then 1 else 0\)/);
		expect(source()).not.toMatch(/== true then 1 else 0/);
	});

	test("lays fixed-size argument lists out at constant offsets", () => {
		expect(source()).toMatch(
			/Vector3\.new\(buffer\.readf32\(buf\w*, 8\), buffer\.readf32\(buf\w*, 12\), buffer\.readf32\(buf\w*, 16\)\)/,
		);
		expect(source()).toMatch(/if buffer\.len\(buf\w*\) ~= 20 then/);
	});
});

describe("generated locals", () => {
	test("does not name a local after a global the generated code itself uses", () => {
		// A field named after its own datatype, in a file that never spells that datatype, used to
		// produce `const CFrame = new CFrame(...)`. Luau reads that as the outer binding and is
		// fine, but the emit is typechecked before it is lowered, and a `const` in its own
		// initializer is an error there. The field has to come from elsewhere: a name the file
		// already uses is renamed for us.
		const result = compileProbe(
			"shadowedLocal",
			`import { Networking } from "@flamework-experimental/networking";
import type { Placement } from "./serialization";

interface ProbeServerEvents {
	noop(): void;
}

interface ProbeClientEvents {
	place(list: Placement[]): void;
}

const probeEvents = Networking.createEvent<ProbeServerEvents, ProbeClientEvents>();
export const probeClient = probeEvents.createClient({});
`,
		);

		expect(result.output).not.toContain("TS7022");
		expect(result.output).not.toContain("TS2448");
		expect(result.status).toBe(0);
	});
});

describe("wire order does not depend on which literals TypeScript created first", () => {
	// TypeScript lists a union's literals, and the keys of a mapped type over a union, in the order it
	// first created each literal type in that compilation. A watcher's rebuild compiles a sender without
	// its receiver, so an order taken from TypeScript let them disagree: "rare" sent as index 0 was read
	// as "common", and Record<"speed" | "power", number> swapped its fields.
	const sender =
		'import { Flamework } from "@flamework-experimental/core";\nexport interface WireOrder { rarity: "common" | "rare" | "epic"; stats: Record<"speed" | "power", number>; picked: Pick<{ speed: number; power: number }, "power" | "speed"> }\nexport const wireOrder = Flamework.createSerializer<WireOrder>();\n';
	// Checked ahead of the sender (it sorts first), it creates "epic" and "power" first.
	const early = 'export const FAVOURITE = "epic";\nexport const FIRST_STAT = "power";\n';
	const tables = (luau: string) => [...luau.matchAll(/local literals\w* = \{[^}]*\}/g)].map((m) => m[0]);
	const fields = (luau: string) => [...luau.matchAll(/buffer\.writef64\([^)]*\.(speed|power)\)/g)].map((m) => m[1]);

	test("a literal union's indices and a mapped type's fields are the same either way", () => {
		const alone = compileProbes({ wireOrderSender: sender });
		const afterEarly = compileProbes({ aaaWireOrderEarly: early, wireOrderSender: sender });
		expect(alone.status).toBe(0);
		expect(afterEarly.status).toBe(0);
		expect(tables(afterEarly.files.get("wireOrderSender")!)).toEqual(tables(alone.files.get("wireOrderSender")!));
		expect(fields(afterEarly.files.get("wireOrderSender")!)).toEqual(fields(alone.files.get("wireOrderSender")!));
	});
});

describe("wire order is a function of the types alone", () => {
	// The literal values and the union members below were put in order by TypeScript's internal type
	// ids before. The ids follow whatever the checker happened to create first in a compilation, which
	// a partial rebuild changes.
	test("numbers a literal union's values by value, and keeps `Partial<T>`'s fields in `T`'s order", () => {
		const result = compileProbes({
			canonicalOrder: `import { Flamework } from "@flamework-experimental/core";
export enum Mode { Single = "single", Double = "double" }
interface Zoo { zebra: number; aardvark: string }
export interface Ordered {
	animal: "zebra" | "aardvark";
	amount: 300 | -5 | 12.5;
	material: Enum.Material.Wood | Enum.Material.Plastic;
	mode: Mode;
	patch: Partial<Zoo>;
}
export const ordered = Flamework.createSerializer<Ordered>();
`,
		});
		expect(result.status).toBe(0);
		const luau = result.files.get("canonicalOrder")!;

		// Numbers by size, then strings by code units, Roblox enum items by name. A TypeScript enum keeps
		// the order it declares its members in, as 2.0.0-alpha.7 did: see the next describe.
		expect(luau).toMatch(/local literals\w* = \{ "aardvark", "zebra" \}/);
		expect(luau).toMatch(/local literals\w* = \{ -5, 12\.5, 300 \}/);
		expect(luau).toMatch(/local literals\w* = \{ Enum\.Material\.Plastic, Enum\.Material\.Wood \}/);
		expect(luau).toMatch(/local literals\w* = \{ "single", "double" \}/);
		// `Partial<Zoo>` makes its fields as `Zoo` lists them, as declared: see "a mapped type's fields".
		expect(luau.indexOf(".zebra")).toBeGreaterThan(-1);
		expect(luau.indexOf(".zebra")).toBeLessThan(luau.indexOf(".aardvark"));
		expect(luau).toMatch(/zebra = \w+,\s*aardvark = \w+,/);
	});

	/** Makes `program`'s checker create the declared type of the interface `name` before anything else in `file`. */
	function createFirst(program: ts.Program, file: ts.SourceFile, name: string) {
		const checker = program.getTypeChecker();
		const declaration = file.statements.find(
			(statement): statement is ts.InterfaceDeclaration =>
				ts.isInterfaceDeclaration(statement) && statement.name.text === name,
		)!;
		checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)!);
	}

	test("numbers the members of a union no spelling orders by their types, whichever TypeScript created first", async () => {
		// `Box<Alpha | Beta>` reaches its union through `value: T`, where nothing spells it out.
		const source = `import { Flamework } from "@flamework-experimental/core";
export interface Alpha { alpha: number }
export interface Beta { beta: string }
interface Box<T> { value: T }
export const boxed = Flamework.createSerializer<Box<Alpha | Beta>>();
`;
		await transformInProcess({ unspelledUnion: source }, (fixture) => {
			const emit = (first: string) => {
				const program = fixture.program();
				const file = fixture.file(program, "unspelledUnion");
				createFirst(program, file, first);
				const { printed, diagnostics } = fixture.pass(program, [file]);
				expect(diagnostics).toEqual([]);
				return printed[0];
			};

			const betaFirst = emit("Beta");
			expect(betaFirst).toBe(emit("Alpha"));
			// By name: Alpha is 0, Beta 1.
			expect(betaFirst).toMatch(/\.alpha !== undefined\) \{\s*buffer\w*\.writeu8\(buf\w*, o\w*, 0\)/);
		});
	}, 120_000);

	test("numbers a union written inside another as that union is written", async () => {
		// `Pair` is a member of `Choice`; its own members go in its written order, Beta first.
		const source = `import { Flamework } from "@flamework-experimental/core";
export interface Alpha { alpha: number }
export interface Beta { beta: string }
export interface Gamma { gamma: boolean }
type Pair = Beta | Alpha;
type Choice = Pair | Gamma;
export const chosen = Flamework.createSerializer<Choice>();
`;
		await transformInProcess({ nestedUnion: source }, (fixture) => {
			const emit = (first: string) => {
				const program = fixture.program();
				const file = fixture.file(program, "nestedUnion");
				createFirst(program, file, first);
				const { printed, diagnostics } = fixture.pass(program, [file]);
				expect(diagnostics).toEqual([]);
				return printed[0];
			};

			const alphaFirst = emit("Alpha");
			expect(alphaFirst).toBe(emit("Beta"));
			expect(alphaFirst).toMatch(/\.beta !== undefined\) \{\s*buffer\w*\.writeu8\(buf\w*, o\w*, 0\)/);
			expect(alphaFirst).toMatch(/\.alpha !== undefined\) \{\s*buffer\w*\.writeu8\(buf\w*, o\w*, 1\)/);
		});
	}, 120_000);

	test("refuses a union whose members only TypeScript's type ids would put in an order", () => {
		// Two interfaces of one name, reached through a generic: nothing but the ids tells them apart.
		const result = compileProbes({
			sameNameA: "export interface Same { a: number }\n",
			sameNameB: "export interface Same { b: string }\n",
			sameNameUnion: `import { Flamework } from "@flamework-experimental/core";
import type { Same as SameA } from "./sameNameA";
import type { Same as SameB } from "./sameNameB";
interface Box<T> { value: T }
export const tied = Flamework.createSerializer<Box<SameA | SameB>>();
`,
		});
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(
			"has two members, 'Same' and 'Same', that nothing but TypeScript's internal type ids would put in an order",
		);
		expect(result.output).toContain("Declare an alias for the union");
	});
});

describe("a TypeScript enum's members keep their declaration order", () => {
	// TypeScript creates an enum's member types together, in declaration order, so the order its
	// values came in was already the types' own, and 2.0.0-alpha.7 numbered an enum that way: a buffer
	// stored with one still reads the same. Values from several enums, or from an enum and plain
	// literals, came in the order the checker created those types, which a partial rebuild changes.
	const layout = `import { Flamework } from "@flamework-experimental/core";
export enum Rarity { Common = "common", Rare = "rare", Epic = "epic" }
export enum Level { High = 30, Low = 10, Mid = 20 }
export interface EnumLayout { rarity: Rarity; level: Level; subset: Rarity.Epic | Rarity.Rare }
export const enumLayout = Flamework.createSerializer<EnumLayout>();
`;
	const mixed = `import { Flamework } from "@flamework-experimental/core";
import { Alpha } from "./enumOrderAlpha";
import { Beta } from "./enumOrderBeta";
export interface TwoEnums { both: Alpha | Beta; mixed: "zeta" | 7 | Beta.Y | Alpha.Q | "alpha" }
export const twoEnums = Flamework.createSerializer<TwoEnums>();
`;
	const sources = {
		enumOrderAlpha: "export enum Alpha { Q = 2, P = 1 }\n",
		enumOrderBeta: 'export enum Beta { Y = "y", X = "x" }\n',
		enumOrderLayout: layout,
		enumOrderMixed: mixed,
	};
	// Checked ahead of the others (it sorts first, after the files it imports), it makes the checker
	// create Beta's members before Alpha's, and asks for a later member of Rarity first.
	const early = `import { Beta } from "./enumOrderBeta";
import { Rarity } from "./enumOrderLayout";
export const FAVOURITE = Rarity.Epic;
export const FIRST_BETA = Beta.X;
`;
	const tables = (luau: string) => [...luau.matchAll(/local literals\w* = (\{[^}]*\})/g)].map((match) => match[1]);

	let alone: ReturnType<typeof compileProbes> | undefined;
	const compiledAlone = () => (alone ??= compileProbes(sources));

	test("numbers a string enum, a numeric one and some of an enum's members as declared, as 2.0.0-alpha.7 did", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);
		// Not sorted: "epic" before "rare", 10 before 30. The subset is written Epic first.
		expect(tables(result.files.get("enumOrderLayout")!)).toEqual([
			'{ "common", "rare", "epic" }',
			"{ 30, 10, 20 }",
			'{ "rare", "epic" }',
		]);
	});

	test("numbers them the same whichever enum or member TypeScript created first", () => {
		const afterEarly = compileProbes({ aaaEnumOrderEarly: early, ...sources });
		expect(afterEarly.status).toBe(0);
		for (const name of ["enumOrderLayout", "enumOrderMixed"]) {
			expect(tables(afterEarly.files.get(name)!)).toEqual(tables(compiledAlone().files.get(name)!));
		}
	});

	test("puts plain literals first, sorted, then each enum's members as declared, the enums by name", () => {
		// Alpha before Beta by name, though the second union writes Beta first; 7, "alpha" and "zeta"
		// ahead of both.
		expect(tables(compiledAlone().files.get("enumOrderMixed")!)).toEqual([
			'{ 2, 1, "y", "x" }',
			'{ 7, "alpha", "zeta", 2, "y" }',
		]);
	});
});

/** The keys of each table the decoders build, in order: `{ zebra = ..., [30] = ... }` is "zebra,30". */
function tableKeys(luau: string): string[] {
	return [...luau.matchAll(/= \{\n((?:\t+\S+ = [^\n{]+,\n)+)\t*\}/g)].map((table) =>
		[...table[1].matchAll(/^\t+\[?"?(\w+)"?\]? = /gm)].map((key) => key[1]).join(","),
	);
}

/**
 * What each union decoder of `luau` reads under its tags, in tag order, one entry per decoder: a
 * blob, a literal index, a boolean, an array, a string, a number, an object read in place by its
 * first field, as that field's name (`alpha` for `Alpha`, though it reads a number too), the whole
 * number a plain `number` member's own tag carries as a varint, or something else.
 */
function tagKinds(luau: string): string[] {
	const decoders = new Map<string, string[]>();
	const lines = luau.split("\n");
	for (let i = 0; i < lines.length - 1; i++) {
		const branch = /^\s*(?:if|elseif) (tag\w*) == \d+ then$/.exec(lines[i]);
		if (!branch) continue;
		const next = lines[i + 1];
		const field = /^\s*local (\w+?)(?:_\d+)? = buffer\w*\.read\w+\(/.exec(next);
		const kind = /blobs/.test(next)
			? "blob"
			: /literals/.test(next)
				? "literals"
				: /~= 0$/.test(next)
					? "boolean"
					: /^\s*local n\w*, o\w* = vread\(/.test(next)
						? "varint"
						: /^\s*local count\w*, o\w* = vread\(/.test(next)
							? "array"
							: /vread|readstring/.test(next)
								? "string"
								: field
									? field[1]
									: /readf64/.test(next)
										? "number"
										: "other";
		const kinds = decoders.get(branch[1]) ?? [];
		decoders.set(branch[1], [...kinds, kind]);
	}

	return [...decoders.values()].map((kinds) => kinds.join(","));
}

describe("a mapped type's fields keep TypeScript's order where it follows from the types", () => {
	// A homomorphic mapped type, `{ [P in keyof T]: ... }` (`Partial`, `Readonly`, `Required`, the
	// project's own), makes its properties in the order `T` lists its own, which follows from `T`'s
	// declaration, and 2.0.0-alpha.7 sent them that way: a buffer stored with it, of a
	// `Partial<PlayerData>` say, reads the same. So does a `Record` over a TypeScript enum, whose
	// members TypeScript creates together, as declared. A mapped type over a union of other keys
	// (`Record<"speed" | "power", V>`, `Pick`, `Omit`) made them in the order the checker happened to
	// create the key literals in: those go by their keys, sorted.
	const sources = {
		mappedOrderTypes: `export interface Zoo { zebra: number; aardvark: string; mole: boolean }
export interface Extra { extra: number }
export enum Rarity { Common = "common", Rare = "rare", Epic = "epic" }
export enum Level { High = 30, Low = 10, Mid = 20 }
`,
		mappedOrderKept: `import { Flamework } from "@flamework-experimental/core";
import type { Zoo, Extra } from "./mappedOrderTypes";
import { Rarity, Level } from "./mappedOrderTypes";
type Patch<T> = { readonly [P in keyof T]?: T[P] };
export interface Kept {
	partial: Partial<Zoo>;
	readonlyZoo: Readonly<Zoo>;
	required: Required<Patch<Zoo>>;
	byRarity: Record<Rarity, number>;
	byLevel: Partial<Record<Level, string>>;
	both: Partial<Zoo & Extra>;
}
export const kept = Flamework.createSerializer<Kept>();
`,
		mappedOrderSorted: `import { Flamework } from "@flamework-experimental/core";
import type { Zoo, Extra } from "./mappedOrderTypes";
export interface Inherits extends Record<"kk" | "dd", number> { own: string }
export interface Sorted {
	record: Record<"speed" | "power", number>;
	picked: Pick<Zoo, "zebra" | "aardvark">;
	omitted: Omit<Zoo, "aardvark">;
	numbered: Record<10 | 2 | 1, string>;
	withRecord: Extra & Record<"qq" | "cc", number>;
	inherits: Inherits;
}
export const sorted = Flamework.createSerializer<Sorted>();
`,
	};
	// Checked ahead of the others (it sorts first, after the file it imports), it creates the key
	// literals in another order and asks for the enums' last members first. `Inherits` is declared
	// with `Sorted`, which is checked after this file, so that "dd" can come before "kk"; the file this
	// one imports is always checked first. Laid out in TypeScript's order, as 2.0.0-alpha.7 did, every
	// mapped type of `Sorted` comes out in another order after this file.
	const early = `import { Rarity, Level } from "./mappedOrderTypes";
export const LAST_RARITY = Rarity.Epic;
export const LAST_LEVEL = Level.Mid;
export const NAMES = ["mole", "aardvark", "power", "cc", "dd", "kk", "extra", 1, 2] as const;
`;

	let alone: ReturnType<typeof compileProbes> | undefined;
	const compiledAlone = () => (alone ??= compileProbes(sources));

	test("keeps the order of the type a homomorphic mapped type maps, and of a Record over an enum, as 2.0.0-alpha.7 did", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);
		const keys = tableKeys(result.files.get("mappedOrderKept")!);

		// Every table with Zoo's fields lists them as Zoo declares them, `Extra`'s after them.
		const zoo = keys.filter((list) => list.includes("zebra"));
		expect(zoo.length).toBeGreaterThanOrEqual(4);
		for (const list of zoo) expect(["zebra,aardvark,mole", "zebra,aardvark,mole,extra"]).toContain(list);
		expect(zoo).toContain("zebra,aardvark,mole,extra");
		// As the enums declare their members: not sorted.
		expect(keys).toContain("common,rare,epic");
		expect(keys).toContain("30,10,20");
	});

	test("sorts the keys of a mapped type over other keys, and keeps what an intersection or an interface adds around them", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);
		const keys = tableKeys(result.files.get("mappedOrderSorted")!);

		expect(keys).toContain("power,speed");
		expect(keys).toContain("aardvark,zebra");
		expect(keys).toContain("mole,zebra");
		// Numbers by size, not as text.
		expect(keys).toContain("1,2,10");
		// `Extra`'s field, then the Record's, sorted; the interface's own field, then the inherited ones.
		expect(keys).toContain("extra,cc,qq");
		expect(keys).toContain("own,dd,kk");
	});

	test("lays each of them out the same whichever key literal or enum member TypeScript created first", () => {
		const afterEarly = compileProbes({ aaaMappedOrderEarly: early, ...sources });
		expect(afterEarly.status).toBe(0);
		for (const name of ["mappedOrderKept", "mappedOrderSorted"]) {
			expect(afterEarly.files.get(name)).toBe(compiledAlone().files.get(name)!);
		}
	});
});

describe("a union no spelling orders keeps 2.0.0-alpha.7's groups", () => {
	// 2.0.0-alpha.7 numbered such a union's members as `alternativesOf` lists them: `boolean`, then the
	// other types, then whole Roblox enums, then the literal values, which never depended on type ids.
	// Among the types, the built-in ones (`string`, `number`, `object`) came first, in the order
	// TypeScript creates them when its checker starts, before any other type; only the order of the
	// rest among themselves followed what the checker happened to create first. Among the literal
	// values, `true` and `false`, created with the checker too, came first. A TypeScript enum's
	// computed member is a type of its own, created with the enum's other members, as declared: so a
	// whole enum put its computed members ahead of its values, and one written in a union went by its
	// declaration order.
	const sources = {
		groupOrderTypes: `export interface Alpha { alpha: number }
export interface Box<T> { value: T }
export interface Item { item: string }
export interface None { __none: "__none" }
export enum Computed { A = 4, B = A * 2, C = "abc".size(), D = 1 }
export enum Late { Z = "z".size(), A = 1, Y = "yy".size(), B = 2 }
`,
		groupOrder: `import { Flamework } from "@flamework-experimental/core";
import type { Alpha, Box } from "./groupOrderTypes";
import { Computed, Late } from "./groupOrderTypes";
export interface Grouped {
	computed: Computed;
	late: Late;
	writtenComputed: Computed | string;
	writtenLate: Late | string;
	booleanFirst: Box<Alpha | boolean>;
	typeFirst: Box<Alpha | "x" | "y">;
}
export const grouped = Flamework.createSerializer<Grouped>();
`,
		groupOrderBuiltIns: `import { Flamework } from "@flamework-experimental/core";
import type { Box, Item, None } from "./groupOrderTypes";
export interface BuiltIns {
	stringNumber: Box<string | number>;
	itemNumber: Box<Item | number>;
	noneNumber: Box<None | number>;
	noneString: Box<None | string>;
	objectString: Box<object | string>;
	trueFirst: "b" | true;
	falseFirst: Box<"b" | false>;
	mixed: "b" | true | 3;
}
export const builtIns = Flamework.createSerializer<BuiltIns>();
`,
	};
	const early = `import { Computed, Late } from "./groupOrderTypes";
import type { Item, None } from "./groupOrderTypes";
export const LAST = Computed.D;
export const LATE = Late.Y;
export const VALUES = ["y", "x", "b", 1, 2, 3] as const;
export const NONE: None = { __none: "__none" };
export const ITEM: Item = { item: "x" };
`;

	let alone: ReturnType<typeof compileProbes> | undefined;
	const compiledAlone = () => (alone ??= compileProbes(sources));

	test("numbers an enum's computed members as 2.0.0-alpha.7 did, and `boolean` and other types ahead of literal values", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);
		const kinds = tagKinds(result.files.get("groupOrder")!);

		// `Computed` alone: its computed member C (a blob), then its values; `Late`: Z, Y, then its values.
		expect(kinds).toContain("blob,literals");
		expect(kinds).toContain("blob,blob,literals");
		expect(kinds).not.toContain("literals,blob");
		// Written in a union, as declared: `Computed`'s values (from A) before C; Late's Z, values (from A), Y.
		expect(kinds).toContain("literals,blob,string");
		expect(kinds).toContain("blob,literals,blob,string");
		// `boolean` first, and `Alpha` (read by its field, `alpha`) before the literal values.
		expect(kinds).toContain("boolean,alpha");
		expect(kinds).toContain("alpha,literals");
	});

	test("numbers the built-in types ahead of the other types, in the order TypeScript creates them, as 2.0.0-alpha.7 did", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);

		// `string` 0 and `number` 1, its whole numbers 2; `number` ahead of `Item` and `None`; `string`
		// ahead of `None` and of `object`, a blob.
		expect(tagKinds(result.files.get("groupOrderBuiltIns")!).sort()).toEqual(
			[
				"string,number,varint",
				"number,other,varint",
				"number,other,varint",
				"string,other",
				"string,blob",
			].sort(),
		);
	});

	test("numbers `true` and `false` ahead of the other literal values, as 2.0.0-alpha.7 did", () => {
		const result = compiledAlone();
		expect(result.status).toBe(0);
		const luau = result.files.get("groupOrderBuiltIns")!;

		// `true` or `false` first, then the numbers, then the strings.
		expect(luau).toMatch(/local literals\w* = \{ true, "b" \}/);
		expect(luau).toMatch(/local literals\w* = \{ false, "b" \}/);
		expect(luau).toMatch(/local literals\w* = \{ true, 3, "b" \}/);
	});

	test("numbers them the same whichever member TypeScript created first", () => {
		const afterEarly = compileProbes({ aaaGroupOrderEarly: early, ...sources });
		expect(afterEarly.status).toBe(0);
		for (const name of ["groupOrder", "groupOrderBuiltIns"]) {
			expect(afterEarly.files.get(name)).toBe(compiledAlone().files.get(name)!);
		}
	});
});

describe("orders TypeScript's checker fixed for every build keep 2.0.0-alpha.7's layout", () => {
	// 2.0.0-alpha.7 numbered these by type ids that came out the same in every build. The checker
	// creates `false`, `true`, `""` and `0` when it starts, ahead of every literal a program writes,
	// then the names `typeof` returns (`"string"`, `"number"`, ... `"function"`), and `1` before `-1`,
	// which it gets by checking `1`; Roblox enum items were added after every other value. A type
	// made from another (`Item[]`, `Box<Item>`) can only be created after it. And the
	// parts of a written member that no spelling orders came at their types' places, where `boolean`
	// is `false`'s, after `string` and `number`; so did the built-in parts of a member written as an
	// alias of a union or in parentheses, ahead of the others, whatever order it wrote them in.
	const sources = {
		layoutKeptTypes: `export interface Box<T> { value: T }
export interface Alpha { alpha: number }
export interface Item { item: string }
export interface Zed { zed: boolean }
export interface Prims { n: number; s: string; b: boolean }
export interface Settings { volume: number; muted: boolean; name: string }
export interface Zoo { zebra: number; aardvark: string; mole: boolean }
export interface Holder { empty: ""; count: number; alpha: Alpha }
export interface KindHolder { kind: "number"; item: Item }
export enum Rarity { Common = "common", Rare = "rare", Epic = "epic" }
export type Id = number | string;
export type Prim = boolean | number | string;
export type ItemOrNumber = Item | "number";
`,
		layoutKeptLiterals: `import { Flamework } from "@flamework-experimental/core";
import { Rarity } from "./layoutKeptTypes";
export interface KeptLiterals {
	emptyOrFive: "" | 5;
	zeroOrMinusFive: -5 | 0;
	trueEmptyOrFive: true | "" | 5;
	signs: 1 | -1;
	aroundZero: -1 | 0 | 1;
	twos: -2 | 2 | 0;
	rare: Rarity.Rare | Enum.KeyCode.W;
	rarity: Rarity | Enum.KeyCode.W;
	signKeys: Record<1 | -1, string>;
	emptyKeys: Record<"" | 5, string>;
}
export const keptLiterals = Flamework.createSerializer<KeptLiterals>();
`,
		layoutKeptTypeofNames: `import { Flamework } from "@flamework-experimental/core";
import type { Alpha, ItemOrNumber, KindHolder } from "./layoutKeptTypes";
export interface KeptTypeofNames {
	kind: "number" | "string";
	three: "boolean" | "number" | "string";
	target: "npc" | "object" | "player";
	oneOrString: 1 | "string";
	byKind: Record<"number" | "string", number>;
	itemOrNumber: ItemOrNumber | Alpha;
	held: KindHolder[keyof KindHolder] | Alpha;
}
export const keptTypeofNames = Flamework.createSerializer<KeptTypeofNames>();
`,
		layoutKeptMade: `import { Flamework } from "@flamework-experimental/core";
import type { Box, Item, Zed } from "./layoutKeptTypes";
export const itemOrList = Flamework.createSerializer<Box<Item | Item[]>>();
export const zedOrList = Flamework.createSerializer<Box<Zed | Zed[]>>();
export const itemOrBox = Flamework.createSerializer<Box<Item | Box<Item>>>();
`,
		layoutKeptMembers: `import { Flamework } from "@flamework-experimental/core";
import type { Alpha, Holder, Item, Prims, Settings, Zoo } from "./layoutKeptTypes";
export interface KeptMembers {
	prim: Prims[keyof Prims] | undefined;
	setting: Settings[keyof Settings] | undefined;
	zoo: Zoo[keyof Zoo] | Alpha;
	excluded: Exclude<string | boolean | number | undefined, undefined> | Alpha;
	nonNullable: NonNullable<boolean | number | undefined> | Alpha;
	held: Holder[keyof Holder] | Item;
}
export const keptMembers = Flamework.createSerializer<KeptMembers>();
`,
		layoutKeptAliases: `import { Flamework } from "@flamework-experimental/core";
import type { Alpha, Id, Prim } from "./layoutKeptTypes";
export interface KeptAliases {
	id: Id | Alpha;
	prim: Prim | Prim[];
	parenthesized: (number | string) | Alpha;
}
export const keptAliases = Flamework.createSerializer<KeptAliases>();
`,
	};
	// Checked ahead of the others (it sorts first, after the file it imports), it creates the values,
	// the types made from others and `Alpha` before the files that use them do, in another order.
	const early = `import { Rarity } from "./layoutKeptTypes";
import type { Alpha, Box, Id, Item, Prim, Zed } from "./layoutKeptTypes";
export const EPIC = Rarity.Epic;
export const VALUES = [5, -2, 2, -1, 1, -5, "rare", "common", "player", "npc"] as const;
export const KEYS = [Enum.KeyCode.A, Enum.KeyCode.W] as const;
export const ITEMS: Item[] = [];
export const ZEDS: Zed[] = [];
export const BOXED: Box<Item> = { value: { item: "x" } };
export const ALPHA: Alpha = { alpha: 1 };
export const PRIMS: Prim[] = ["x", 1, true];
export const IDS: Array<Id | Alpha> = [];
`;
	const tables = (luau: string) => [...luau.matchAll(/local literals\w* = (\{[^}]*\})/g)].map((match) => match[1]);
	/** What each union decoder reads first under its tag 0. */
	const firstReads = (luau: string) => [...luau.matchAll(/if tag\w* == 0 then\n\s*(.*)/g)].map((match) => match[1]);

	let alone: ReturnType<typeof compileProbes> | undefined;
	const compiledAlone = () => (alone ??= compileProbes(sources));
	let afterEarly: ReturnType<typeof compileProbes> | undefined;
	const compiledAfterEarly = () => (afterEarly ??= compileProbes({ aaaLayoutKeptEarly: early, ...sources }));
	const compiled = (name: string) => {
		const [first, second] = [compiledAlone(), compiledAfterEarly()];
		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		// The same whichever value or type TypeScript created first.
		expect(second.files.get(name)).toBe(first.files.get(name)!);
		return first.files.get(name)!;
	};

	test('numbers `false`, `true`, `""` and `0` first, a number before its negative and Roblox enum items last', () => {
		const luau = compiled("layoutKeptLiterals");
		expect(tables(luau).sort()).toEqual(
			[
				'{ "", 5 }',
				"{ 0, -5 }",
				'{ true, "", 5 }',
				"{ 1, -1 }",
				"{ 0, 1, -1 }",
				"{ 0, 2, -2 }",
				'{ "rare", Enum.KeyCode.W }',
				'{ "common", "rare", "epic", Enum.KeyCode.W }',
			].sort(),
		);
		// A mapped type's keys go the same way, a number key decoded as the number.
		expect(luau).toMatch(/\[1\] = text\w*,\s*\[-1\] = text\w*,/);
		expect(luau).toMatch(/\[""\] = text\w*,\s*\[5\] = text\w*,/);
	});

	test("numbers the names `typeof` returns ahead of the other literals, in the order the checker creates them", () => {
		const luau = compiled("layoutKeptTypeofNames");
		// `"string"`, `"number"`, `"bigint"`, `"boolean"`, `"symbol"`, `"undefined"`, `"object"`,
		// `"function"`, after `0` and ahead of every other value, `1` included.
		expect(tables(luau)).toEqual([
			'{ "string", "number" }',
			'{ "string", "number", "boolean" }',
			'{ "object", "npc", "player" }',
			'{ "string", 1 }',
		]);
		// The Record's fields: `string`, then `number`.
		expect(luau).toMatch(/\.string\)\n\s*buffer\w*\.writef64\([^)]*\.number\)/);
		// In a member written as an alias (`Item | "number"`) and in one nothing writes out
		// (`KindHolder[keyof KindHolder]`), `"number"` goes first, at its place, as a built-in type does:
		// it is 0, then `Item`, then `Alpha`.
		const reads = firstReads(luau);
		expect(reads.length).toBe(2);
		for (const read of reads) expect(read).toMatch(/^value\w* = "number"$/);
	});

	test("numbers a type ahead of the types made from it in a union nothing writes out", () => {
		// `Item` (or `Zed`) is 0 in each: an array of it, or `Box<Item>`, is 1.
		const reads = firstReads(compiled("layoutKeptMade"));
		expect(reads.length).toBe(3);
		for (const read of reads) expect(read).toMatch(/codec\.r_Item\(|^local zed = /);
	});

	test("numbers the parts of a written member at their types' places, `boolean` after `string` and `number`", () => {
		const luau = compiled("layoutKeptMembers");
		// `string` 0, `number` 1, `boolean` 2, then `Alpha` (read by its field, `alpha`), then the whole
		// numbers' tag. `Holder`'s: `number`, then `""` (which reads nothing), then `Alpha`, then `Item`.
		expect(tagKinds(luau).sort()).toEqual(
			[
				"string,number,boolean,varint",
				"string,number,boolean,varint",
				"string,number,boolean,alpha,varint",
				"string,number,boolean,alpha,varint",
				"number,boolean,alpha,varint",
				"number,other,alpha,other,varint",
			].sort(),
		);
		expect(luau).toMatch(/tag\w* == 1 then\n\s*value\w* = ""\n/);
	});

	test("numbers the built-in parts of a member written as an alias or in parentheses first, as 2.0.0-alpha.7 did", () => {
		const luau = compiled("layoutKeptAliases");
		// `Id | Alpha` and `(number | string) | Alpha`: `string` 0 and `number` 1, though both write
		// `number` first, then `Alpha` (read by its field, `alpha`), then the whole numbers' tag.
		// `Prim | Prim[]`: `string`, `number`, `boolean`, then the array; `Prim` alone keeps its own
		// written order.
		expect(tagKinds(luau).sort()).toEqual(
			[
				"boolean,number,string,varint",
				"string,number,alpha,varint",
				"string,number,alpha,varint",
				"string,number,boolean,array,varint",
			].sort(),
		);
	});
});
