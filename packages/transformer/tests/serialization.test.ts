import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixture, emitted } from "./compile";

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
		expect(source()).toMatch(/local s_Payload\w*\s*local w_Payload\w*\s*local r_Payload\w*/);
		expect(source()).toMatch(/size\w* \+= s_Node\w*\(item\w*\)/);
		expect(source()).toMatch(/o\w* = w_Node\w*\(buf\w*, o\w*, item\w*\)/);
		expect(source()).toMatch(/local value\w*, o\w* = r_Node\w*\(buf\w*, o\w*\)/);
		// The top level calls them directly: no position variable of its own.
		expect(source()).toMatch(/w_Payload\w*\(buf\w*, 0, v\w*, blobs\w*\)/);
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
		expect(source()).toMatch(/if type\(v\w*\) == "number" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
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
});

describe("networking serialization", () => {
	test("keeps only decoders in the handler metadata", () => {
		expect(source()).not.toContain("encode = function");
		expect(source()).not.toContain("outgoingSerializers");
		expect(source()).toMatch(/incomingSerializers = \{\s*ping = \(?function\(buf\w*\)/);
		expect(source()).toMatch(/incomingResults = \{\s*echo = \(?function\(buf\w*\)/);
	});

	test("packs event arguments at each call site and sends them through the hidden entry point", () => {
		expect(source()).toMatch(
			/local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, value\)\s*server\.pong:_broadcast\(buf\w*\)/,
		);
		expect(source()).toMatch(/server\.pong:_fire\(player, buf\w*\)/);
		// The handler's call signature is a send too.
		expect(source()).not.toMatch(/server\.pong\(player/);
		expect(source()).toMatch(/buffer\.writef32\(buf\w*, 16, where\.Z\)\s*client\.ping:_fire\(buf\w*\)/);
	});

	test("wraps the packing in a function when the call has no statement of its own", () => {
		expect(source()).toMatch(
			/client\.pong:connect\(function\(value\w*\)\s*return \(function\(\)[\s\S]*?buffer\.create\(20\)[\s\S]*?return client\.ping:_fire\(buf\w*\)\s*end\)\(\)/,
		);
	});

	test("packs function requests and wraps callbacks so results leave packed", () => {
		expect(source()).toMatch(/return clientFunctions\.echo:_invoke\(buf\w*\)/);
		expect(source()).toMatch(/target\w*:_setCallback\(function\(lead\w*, arg\w*\)/);
		expect(source()).toMatch(
			/if TS\.Promise\.is\(result\w*\) then\s*return result\w*:andThen\(function\(value\w*\)/,
		);
		expect(source()).toMatch(/if result\w* == Networking\.Skip then\s*return result\w*/);
		expect(source()).toMatch(/return \{ buf\w* \}/);
	});

	test("sends nothing for a list that carries nothing", () => {
		expect(source()).toMatch(/client\.bump:_fire\(\)/);
		expect(source()).toMatch(/clientFunctions\.nothing:_invoke\(\)/);
		// No decoder for it either: the runtime passes the empty list through.
		expect(source()).not.toMatch(/bump = \(?function/);
		expect(source()).not.toMatch(/nothing = \(?function\(buf/);
		// A void callback's wrapper returns nothing instead of a packed list.
		expect(source()).toMatch(
			/target\w*:_setCallback\(function\(lead\w*\)\s*local result\w* = callback\w*\(lead\w*\)/,
		);
		expect(source()).toMatch(/if result\w* == Networking\.Skip then\s*return result\w*\s*end\s*return nil/);
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

	test("lays fixed-size argument lists out at constant offsets", () => {
		expect(source()).toMatch(
			/Vector3\.new\(buffer\.readf32\(buf\w*, 8\), buffer\.readf32\(buf\w*, 12\), buffer\.readf32\(buf\w*, 16\)\)/,
		);
		expect(source()).toMatch(/if buffer\.len\(buf\w*\) ~= 20 then/);
	});
});
