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
	test("attaches encode and decode functions to event metadata when the project enables it", () => {
		expect(source()).toContain("incomingSerializers = {");
		expect(source()).toContain("outgoingSerializers = {");
		expect(source()).toMatch(/ping = \{\s*encode = function\(args\w*\)/);
	});

	test("lays fixed-size argument lists out at constant offsets", () => {
		expect(source()).toMatch(/local buf\w* = buffer\.create\(20\)\s*buffer\.writef64\(buf\w*, 0, args\w*\[1\]\)/);
		expect(source()).toMatch(/buffer\.writef32\(buf\w*, 16, vector3\w*\.Z\)/);
		expect(source()).toMatch(
			/Vector3\.new\(buffer\.readf32\(buf\w*, 8\), buffer\.readf32\(buf\w*, 12\), buffer\.readf32\(buf\w*, 16\)\)/,
		);
		expect(source()).toMatch(/if buffer\.len\(buf\w*\) ~= 20 then/);
	});

	test("unwraps Promise return types for function result codecs", () => {
		expect(source()).toContain("incomingResults = {");
		expect(source()).toMatch(
			/incomingResults = \{\s*echo = \{\s*encode = function\(args\w*\)\s*local buf\w* = buffer\.create\(#\(args\w*\[1\]\) \+ 4\)/,
		);
	});
});
