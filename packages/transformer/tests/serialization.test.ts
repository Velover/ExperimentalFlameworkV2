import { beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { compileFixture, compileProbe, emitted } from "./compile";

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
