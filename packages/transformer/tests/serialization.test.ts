import { beforeAll, describe, expect, test } from "bun:test";
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
		expect(sendB).toMatch(/if type\(v\w*\) == "number" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
		expect(sendB).toMatch(/elseif type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
		expect(sendA).toMatch(/if type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, 0\)/);
		expect(sendA).toMatch(/elseif type\(v\w*\) == "number" then\s*buffer\.writeu8\(buf\w*, o\w*, 1\)/);
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
			/if receivers == nil then\s*return nil\s*end[\s\S]*?return target\w*:_setCallback\(function\(lead\w*, arg\w*\)/,
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
