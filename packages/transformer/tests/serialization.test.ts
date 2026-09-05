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
		expect(source()).toMatch(/buffer\.writeu8\(buf\w*, o\w* \+ 1, length\w*\)/);
		expect(source()).toMatch(/buffer\.writestring\(buf\w*, o\w* \+ 2, text\w*\)/);
	});

	test("encodes literal unions as an index and constants as nothing", () => {
		expect(source()).toMatch(/local literals\w* = \{ "a", "b", "c" \}/);
		expect(source()).toMatch(/local literalIndex\w* = \{\s*a = 0,\s*b = 1,\s*c = 2,\s*\}/);
		// The constant field is restored from the type, never written.
		expect(source()).toMatch(/kind = "payload",/);
		expect(source()).not.toMatch(/"payload"\)/);
	});

	test("sends blobs by index so a nil never shifts the others", () => {
		expect(source()).toMatch(/table\.insert\(blobs\w*, blob\w*\)\s*buffer\.writeu16\(buf\w*, o\w*, #blobs\w*\)/);
		expect(source()).toMatch(/else\s*buffer\.writeu16\(buf\w*, o\w*, 0\)/);
		expect(source()).toMatch(/blobs\w*\[buffer\.readu16\(buf\w*, o\w*\)\]/);
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

	test("refuses hostile counts and trailing bytes", () => {
		expect(source()).toMatch(/if count\w* \* 4 > buffer\.len\(buf\w*\) - o\w* then\s*error\("malformed payload"\)/);
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

	test("lays fixed-size argument lists out at constant offsets", () => {
		expect(source()).toMatch(
			/Vector3\.new\(buffer\.readf32\(buf\w*, 8\), buffer\.readf32\(buf\w*, 12\), buffer\.readf32\(buf\w*, 16\)\)/,
		);
		expect(source()).toMatch(/if buffer\.len\(buf\w*\) ~= 20 then/);
	});
});
