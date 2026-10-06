import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	compileFixture,
	compileFixtureFresh,
	compileFixtureWithEnv,
	compileProbe,
	compileProbes,
	emitted,
	normalize,
} from "./compile";

/*
 * `Networking.Serialized*` opts one member into packing whatever the project's
 * `networking.serialization` says. The fixture builds with the switch on; `networkModes.ts` is built
 * again here with it off, and both emits are compared.
 */

let off: Map<string, string>;

beforeAll(() => {
	const result = compileFixtureWithEnv({ FLAMEWORK_FIXTURE_SERIALIZATION: "false" });
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile with serialization off:\n${result.output}`);
	}
	off = result.files;

	// What later tests read from disk is the ordinary build again.
	const fresh = compileFixtureFresh();
	if (fresh.status !== 0) {
		throw new Error(`fixture failed to compile:\n${fresh.output}`);
	}
});

afterAll(() => {
	compileFixture();
});

const on = () => emitted("networkModes");
const offSource = (name = "networkModes") => {
	const file = off.get(name);
	if (file === undefined) throw new Error(`the switch-off build did not emit '${name}'`);
	return file;
};

/** A top-level function of the emit, with generated names' numeric suffixes dropped, so two builds compare. */
function functionBody(source: string, name: string): string {
	const match = source.match(new RegExp(`local function ${name}\\([^)]*\\)\\n[\\s\\S]*?\\nend\\n`));
	if (!match) throw new Error(`no function '${name}' in the emit`);
	return stripSuffixes(match[0]);
}

/** A member's decoder in one metadata table, as `name = (function(...) ... end),`. */
function decoder(source: string, table: string, name: string, occurrence = 0): string | undefined {
	const tables = [...source.matchAll(new RegExp(`${table} = \\{\\n([\\s\\S]*?)\\n\\t\\},`, "g"))];
	const body = tables[occurrence]?.[1];
	if (body === undefined) return undefined;
	const match = body.match(new RegExp(`\\t\\t${name} = \\(function[\\s\\S]*?\\n\\t\\tend\\),`));
	return match ? stripSuffixes(match[0]) : undefined;
}

/** A callback registration with its result packer, from `local target = <handler>.<name>` to its `end)`. */
function callbackRegistration(source: string, name: string): string {
	const match = source.match(
		new RegExp(`local target\\w* = \\w+\\.${name}\\n[\\s\\S]*?:_setCallback\\([\\s\\S]*?\\nend\\)\\n`),
	);
	if (!match) throw new Error(`no callback registration for '${name}' in the emit`);
	return stripSuffixes(match[0]);
}

function stripSuffixes(text: string): string {
	return text.replace(/\b([A-Za-z]\w*?)_\d+\b/g, "$1");
}

describe("marker detection", () => {
	test("packs a serialized member", () => {
		expect(on()).toMatch(
			/local function serializedSend\(value\)\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, value\)\s*modeClient\.serializedPing:_fire\(buf\w*\)/,
		);
		expect(decoder(on(), "incomingSerializers", "serializedPing")).toMatch(/function\(buf\)\s*local value/);
	});

	test("sends the blob list of a serialized member next to its buffer", () => {
		expect(functionBody(on(), "serializedPlaceSend")).toMatch(/modeClient\.serializedPlace:_fire\(buf, blobs\)/);
		expect(decoder(on(), "incomingSerializers", "serializedPlace")).toMatch(/function\(buf, blobs\)/);
	});

	test("treats every spelling of an unreliable serialized event alike", () => {
		const sends = functionBody(on(), "unreliableSends");
		for (const name of ["serializedMove", "unreliableSerialized", "serializedUnreliable"]) {
			expect(sends).toMatch(new RegExp(`writef64\\(buf, 0, value\\)\\s*modeClient\\.${name}:_fire\\(buf\\)`));
			// The same decoder as the reliable `serializedPing`, under its own name.
			const body = (member: string) => decoder(on(), "incomingSerializers", member)?.replace(/^\t\t\w+ = /, "");
			expect(body(name)).toBeDefined();
			expect(body(name)).toBe(body("serializedPing"));
		}

		// All three are unreliable, in both handlers' metadata.
		for (const table of ["incomingUnreliable", "outgoingUnreliable"]) {
			const block = on().match(new RegExp(`${table} = \\{\\n([^}]*)\\}`))?.[1] ?? "";
			for (const name of ["serializedMove", "unreliableSerialized", "serializedUnreliable"]) {
				expect(block).toContain(`${name} = true`);
			}
		}
		expect(on()).not.toMatch(/(plainPing|serializedPing|serializedPlace) = true/);
	});

	test("packs a serialized function's request, and its callback's result after the middleware", () => {
		expect(functionBody(on(), "lookups")).toMatch(/return modeClientFunctions\.serializedLookup:_invoke\(buf\)/);
		expect(functionBody(on(), "ask")).toMatch(/return modeServerFunctions\.serializedAsk:_invoke\(player, buf\)/);
		expect(callbackRegistration(on(), "serializedLookup")).toMatch(
			/:_setCallback\(callback, function\(value\)[\s\S]*?return \{ buf \}\s*end\)/,
		);
		expect(decoder(on(), "outgoingResults", "serializedAsk")).toMatch(/function\(buf\)/);
		expect(decoder(on(), "outgoingResults", "serializedLookup", 1)).toMatch(/function\(buf\)/);
	});

	test("sends nothing for a serialized member whose list carries nothing", () => {
		expect(functionBody(on(), "serializedBumpSend")).toMatch(/modeClient\.serializedBump:_fire\(\)/);
		expect(functionBody(on(), "lookups")).toMatch(/modeClientFunctions\.serializedNothing:_invoke\(\)/);
		expect(on()).not.toMatch(/serializedBump = \(function/);
		expect(callbackRegistration(on(), "serializedNothing")).toMatch(
			/:_setCallback\(callback, function\(value\)\s*return nil\s*end\)/,
		);
	});
});

describe("networking.serialization on and off", () => {
	test("leaves a plain member unpacked with the switch off, and packs it with the switch on", () => {
		expect(functionBody(offSource(), "plainSend")).toMatch(/modeClient\.plainPing:fire\(value\)/);
		expect(offSource()).not.toMatch(/plainPing = \(function/);
		expect(offSource()).toMatch(/modeClientFunctions\.plainLookup:invoke\(id\)/);
		expect(offSource()).toMatch(/modeServerFunctions\.plainLookup:setCallback\(function\(player, id\)/);
		// Members of the older fixture are all plain.
		expect(offSource("serialization")).toMatch(/server\.pong:broadcast\(value\)/);
		expect(offSource("serialization")).not.toContain("_fire(");

		expect(functionBody(on(), "plainSend")).toMatch(/modeClient\.plainPing:_fire\(buf\)/);
		expect(decoder(on(), "incomingSerializers", "plainPing")).toBeDefined();
	});

	test("packs serialized members the same way with the switch off", () => {
		for (const name of [
			"serializedSend",
			"serializedPlaceSend",
			"serializedBumpSend",
			"unreliableSends",
			"serverSends",
			"ask",
		]) {
			expect(functionBody(offSource(), name)).toBe(functionBody(on(), name));
		}
		for (const name of ["serializedLookup", "serializedNothing", "serializedAsk"]) {
			expect(callbackRegistration(offSource(), name)).toBe(callbackRegistration(on(), name));
		}

		const decoders: Array<[table: string, name: string, occurrence: number]> = [
			["incomingSerializers", "serializedPing", 0],
			["incomingSerializers", "serializedPlace", 0],
			["incomingSerializers", "serializedMove", 0],
			["incomingSerializers", "unreliableSerialized", 0],
			["incomingSerializers", "serializedUnreliable", 0],
			["incomingSerializers", "serializedPong", 1],
			["incomingSerializers", "serializedLookup", 2],
			["incomingSerializers", "serializedAsk", 3],
			["outgoingResults", "serializedAsk", 0],
			["outgoingResults", "serializedLookup", 1],
		];
		for (const [table, name, occurrence] of decoders) {
			const whenOn = decoder(on(), table, name, occurrence);
			expect(whenOn).toBeDefined();
			expect(decoder(offSource(), table, name, occurrence)).toBe(whenOn);
		}
	});

	test("leaves a raw member exactly as written either way", () => {
		expect(functionBody(on(), "rawSend")).toBe(functionBody(offSource(), "rawSend"));
		expect(functionBody(on(), "rawSend")).toMatch(/modeClient\.rawPing:fire\(value\)/);
		expect(on()).not.toMatch(/rawPing = \(function/);
		expect(offSource()).not.toMatch(/rawPing = \(function/);
	});

	test("emits nothing but buffer code: no compression anywhere", () => {
		for (const files of [compileFixture().files, off]) {
			for (const [name, source] of files) {
				expect(`${name}: ${/EncodingService|CompressBuffer|DecompressBuffer/.test(source)}`).toBe(
					`${name}: false`,
				);
			}
		}
	});
});

describe("conflicting markers", () => {
	const probe = (members: string, uses = "export const server = events.createServer({});") =>
		compileProbe(
			"conflictingMarkers",
			`import { Networking } from "@flamework-experimental/networking";

interface ProbeServerEvents {
	${members}
}

interface ProbeFunctions {
	fine(value: number): number;
}

const events = Networking.createEvent<ProbeServerEvents, {}>();
export const functions = Networking.createFunction<ProbeFunctions, {}>();
${uses}
`,
		);

	test("refuses Raw with Serialized", () => {
		const result = probe("both: Networking.RawReliable<Networking.SerializedReliable<(value: number) => void>>;");
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("The networking member 'both' is declared both Raw and Serialized");
		expect(result.output).toContain("Keep one of the two markers.");
	});

	test("refuses Serialized with Raw, in either order and through Unreliable", () => {
		const result = probe(
			"both: Networking.Unreliable<Networking.Serialized<Networking.Raw<(value: number) => void>>>;",
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("The networking member 'both' is declared both Raw and Serialized");
	});

	test("refuses a conflicting member that the handler only sends", () => {
		// The client only sends `both`; its metadata still passes every member through the check.
		const result = probe(
			"both: Networking.RawUnreliable<Networking.Serialized<(value: number) => void>>;",
			"export const client = events.createClient({});",
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("declared both Raw and Serialized");
	});

	test("refuses a conflicting function member", () => {
		const result = compileProbe(
			"conflictingFunction",
			`import { Networking } from "@flamework-experimental/networking";

interface ProbeFunctions {
	both: Networking.Raw<Networking.Serialized<(value: number) => number>>;
}

const functions = Networking.createFunction<{}, ProbeFunctions>();
export const server = functions.createServer({});
`,
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("The networking member 'both' is declared both Raw and Serialized");
	});
});

describe("guards of tuples with a rest element", () => {
	test("take the fixed elements, then any number of rest ones, instead of one more element", () => {
		const source = normalize(emitted("guards"));
		expect(source).not.toMatch(/restTupleGuard = Flamework\.createGuard\(t\.strictArray/);
		expect(source).toMatch(
			/local restTupleGuard = Flamework\.createGuard\(\(function\(element, rest\) return function\(value\)/,
		);
		expect(source).toMatch(/for index = 2, size do if not rest\(list\[index\]\) then return false end end/);
		// Optional elements before the rest may be nil; elements after it are read from the end.
		expect(source).toMatch(/end\)\(t\.number, t\.optional\(t\.string\), t\.boolean\)\)/);
		expect(source).toMatch(/if not last\w*\(list\w*\[size\w*\]\) then return false end/);
		expect(source).toMatch(/if size\w* < 2 then return false end/);
		// A tuple without a rest element keeps `t.strictArray`.
		expect(source).toContain(
			"local fixedTupleGuard = Flamework.createGuard(t.strictArray(t.number, t.optional(t.string)))",
		);
	});
});

/*
 * A call whose target may be one of several members: a helper that returns a member by name, or a
 * conditional. TypeScript keeps each member apart in the union when they are packed differently
 * (`_flamework_packing`), and the transformer packs the call only when every one of them is packed,
 * the same way.
 */
describe("targets that may be several members", () => {
	const header = `import { Networking } from "@flamework-experimental/networking";

interface ProbeServerEvents {
	plainPing(value: number): void;
	serializedPing: Networking.SerializedReliable<(value: number) => void>;
	rawPing: Networking.RawReliable<(value: number) => void>;
	wide(value: number | string): void;
}

interface ProbeClientEvents {
	plainPong(value: number): void;
	serializedPong: Networking.SerializedReliable<(value: number) => void>;
}

interface ProbeFunctions {
	plainFn(v: number): number;
	serializedFn: Networking.Serialized<(v: number) => number>;
	serializedText: Networking.Serialized<(v: number) => string>;
	rawFn: Networking.Raw<(v: number) => number>;
}

const events = Networking.createEvent<ProbeServerEvents, ProbeClientEvents>();
const functions = Networking.createFunction<ProbeFunctions, {}>();
export const client = events.createClient({});
export const server = events.createServer({});
export const clientFunctions = functions.createClient({});
export const serverFunctions = functions.createServer({});
`;

	/** A helper that returns a member by name, as guide 06 describes, and a call through it. */
	const byName = (members: [string, string], call: string) => `${header}
function member(name: "a" | "b") {
	switch (name) {
		case "a":
			return ${members[0]};
		case "b":
			return ${members[1]};
	}
}

export function run(name: "a" | "b") {
	return member(name).${call};
}
`;

	/** The same with a conditional. */
	const either = (members: [string, string], call: string) => `${header}
export function run(flag: boolean) {
	return (flag ? ${members[0]} : ${members[1]}).${call};
}
`;

	const off = { FLAMEWORK_FIXTURE_SERIALIZATION: "false" };
	const mixed = /The call '(.+?)' may reach networking members that are packed differently: (.+)\./g;

	/** Every "packed differently" error of a build, as `call -> what differs`. */
	function refusals(output: string): Map<string, string> {
		const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
		return new Map([...plain.matchAll(mixed)].map((match) => [match[1], match[2]]));
	}

	const SERIALIZED = "Serialized members are packed into a buffer";
	const PLAIN_OFF = "plain members are sent as they are, as networking.serialization is off";
	const PLAIN_ON = "plain members are packed, as networking.serialization is on";
	const RAW = "Raw members are sent as they are";

	test("refuses Serialized with plain members when the switch is off, and Raw with either", () => {
		const result = compileProbes(
			{
				mixEventByName: byName(["client.serializedPing", "client.plainPing"], "fire(1)"),
				mixEventEither: either(["client.serializedPing", "client.plainPing"], "fire(1)"),
				mixServerEvent: either(["server.serializedPong", "server.plainPong"], "broadcast(1)"),
				mixFunction: byName(["clientFunctions.serializedFn", "clientFunctions.plainFn"], "invoke(1)"),
				mixCallback: byName(
					["serverFunctions.serializedFn", "serverFunctions.plainFn"],
					"setCallback((player, v) => v + 1)",
				),
				mixRawEvent: either(["client.serializedPing", "client.rawPing"], "fire(1)"),
				mixRawFunction: either(["clientFunctions.serializedFn", "clientFunctions.rawFn"], "invoke(1)"),
				mixRawCallback: either(
					["serverFunctions.serializedFn", "serverFunctions.rawFn"],
					"setCallback((player, v) => v + 1)",
				),
			},
			off,
		);

		expect(result.status).not.toBe(0);
		const refused = refusals(result.output);
		expect(refused.get("member(name).fire(...)")).toBe(`${SERIALIZED}; ${PLAIN_OFF}`);
		expect(refused.get("(flag ? client.serializedPing : client.plainPing).fire(...)")).toBe(
			`${SERIALIZED}; ${PLAIN_OFF}`,
		);
		expect(refused.get("(flag ? server.serializedPong : server.plainPong).broadcast(...)")).toBe(
			`${SERIALIZED}; ${PLAIN_OFF}`,
		);
		expect(refused.get("member(name).invoke(...)")).toBe(`${SERIALIZED}; ${PLAIN_OFF}`);
		expect(refused.get("member(name).setCallback(...)")).toBe(`${SERIALIZED}; ${PLAIN_OFF}`);
		expect(refused.get("(flag ? client.serializedPing : client.rawPing).fire(...)")).toBe(`${SERIALIZED}; ${RAW}`);
		expect(refused.get("(flag ? clientFunctions.serializedFn : clientFunctions.rawFn).invoke(...)")).toBe(
			`${SERIALIZED}; ${RAW}`,
		);
		expect(refused.get("(flag ? serverFunctions.serializedFn : serverFunctions.rawFn).setCallback(...)")).toBe(
			`${SERIALIZED}; ${RAW}`,
		);
		expect(refused.size).toBe(8);

		const plain = result.output.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("One call site packs for all of them or for none, so some would drop what it sends");
		expect(plain).toContain("so the callers of some would reject what the callback returns");
		expect(plain).toContain("Make the call where the member's own type is known");
	});

	test("refuses Raw with plain or Serialized members when the switch is on, and lists that differ", () => {
		const result = compileProbes({
			mixPlainRaw: either(["client.plainPing", "client.rawPing"], "fire(1)"),
			mixSerializedRaw: byName(["client.serializedPing", "client.rawPing"], "fire(1)"),
			mixPlainRawCallback: either(
				["serverFunctions.plainFn", "serverFunctions.rawFn"],
				"setCallback((player, v) => v + 1)",
			),
			mixLists: either(["client.plainPing", "client.wide"], "fire(1)"),
			mixResults: either(
				["serverFunctions.serializedFn", "serverFunctions.serializedText"],
				"setCallback((player, v) => v as never)",
			),
		});

		expect(result.status).not.toBe(0);
		const refused = refusals(result.output);
		expect(refused.get("(flag ? client.plainPing : client.rawPing).fire(...)")).toBe(`${PLAIN_ON}; ${RAW}`);
		expect(refused.get("member(name).fire(...)")).toBe(`${SERIALIZED}; ${RAW}`);
		expect(refused.get("(flag ? serverFunctions.plainFn : serverFunctions.rawFn).setCallback(...)")).toBe(
			`${PLAIN_ON}; ${RAW}`,
		);
		expect(refused.get("(flag ? client.plainPing : client.wide).fire(...)")).toBe(
			"their argument lists are not laid out and checked alike ('ProbeServerEvents.plainPing(value: number): void' and 'ProbeServerEvents.wide(value: number | string): void')",
		);
		expect(
			refused.get("(flag ? serverFunctions.serializedFn : serverFunctions.serializedText).setCallback(...)"),
		).toBe(
			"their results are not laid out and checked alike ('ProbeFunctions.serializedFn(v: number): number' and 'ProbeFunctions.serializedText(v: number): string')",
		);
		expect(refused.size).toBe(5);
	});

	test("packs Serialized with plain members when the switch is on", () => {
		const result = compileProbes({
			packedEvent: byName(["client.serializedPing", "client.plainPing"], "fire(1)"),
			packedFunction: either(["clientFunctions.serializedFn", "clientFunctions.plainFn"], "invoke(1)"),
			packedCallback: either(
				["serverFunctions.serializedFn", "serverFunctions.plainFn"],
				"setCallback((player, v) => v + 1)",
			),
		});

		expect(result.status).toBe(0);
		expect(result.files.get("packedEvent")).toMatch(
			/local target\w* = member\(name\)\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, 1\)\s*return target\w*:_fire\(buf\w*\)/,
		);
		expect(result.files.get("packedFunction")).toMatch(/return target\w*:_invoke\(buf\w*\)/);
		expect(result.files.get("packedCallback")).toMatch(
			/target\w*:_setCallback\(callback\w*, function\(value\w*\)\s*local buf\w* = buffer\.create\(8\)\s*buffer\.writef64\(buf\w*, 0, value\w*\)\s*return \{ buf\w* \}/,
		);
	});

	test("leaves plain with Raw members unpacked when the switch is off", () => {
		const result = compileProbes(
			{
				unpackedEvent: either(["client.plainPing", "client.rawPing"], "fire(1)"),
				unpackedCallback: byName(
					["serverFunctions.plainFn", "serverFunctions.rawFn"],
					"setCallback((player, v) => v + 1)",
				),
			},
			off,
		);

		expect(result.status).toBe(0);
		expect(result.files.get("unpackedEvent")).toMatch(
			/return \(if flag then client\.plainPing else client\.rawPing\):fire\(1\)/,
		);
		expect(result.files.get("unpackedCallback")).toMatch(
			/return member\(name\):setCallback\(function\(player, v\)/,
		);
		for (const file of result.files.values()) expect(file).not.toContain("_fire(");
	});

	test("packs members packed the same way as one of them would be, in both builds", () => {
		for (const source of [on(), offSource()]) {
			const sends = functionBody(source, "eitherSend");
			expect(sends).toMatch(
				/local target = \(if flag then modeClient\.serializedPing else modeClient\.serializedPingToo\)\s*local buf = buffer\.create\(8\)\s*buffer\.writef64\(buf, 0, value\)\s*target:_fire\(buf\)/,
			);
			expect(sends).toMatch(/\(if flag then modeClient\.rawPing else modeClient\.rawPingToo\):fire\(value\)/);
			expect(functionBody(source, "eitherLookup")).toMatch(/return target:_invoke\(buf\)/);
			expect(functionBody(source, "eitherCallback")).toMatch(/target:_setCallback\(callback, function\(value\)/);
		}

		// Two plain members pack with the switch and are left alone without it.
		expect(functionBody(on(), "eitherSend")).toMatch(
			/\(if flag then modeClient\.plainPing else modeClient\.plainPingToo\)\s*local buf = buffer\.create\(8\)/,
		);
		expect(functionBody(offSource(), "eitherSend")).toMatch(
			/\(if flag then modeClient\.plainPing else modeClient\.plainPingToo\):fire\(value\)/,
		);
	});
});

/**
 * Members a call's target may be, all packed, can lay out one TypeScript type differently: a union's
 * members are numbered as each declaration spells them, and each member's receiver (for a callback,
 * each caller) decodes with its own declaration's layout. One call site packs one way, so the call is
 * refused unless every member's layout is the same, whatever their types; then any member's packing
 * suits all of them. A Serialized member and a plain one stay apart in a union (`_flamework_packing`).
 */
describe("targets whose members lay their values out differently", () => {
	const header = `import { Networking } from "@flamework-experimental/networking";

interface LayoutServerEvents {
	textFirst(value: string | number): void;
	numberFirst: Networking.SerializedReliable<(value: number | string) => void>;
	textFirstToo: Networking.SerializedReliable<(value: string | number) => void>;
}

interface LayoutFunctions {
	textFirst(): string | number;
	numberFirst: Networking.Serialized<() => number | string>;
	meters(): number & { readonly unit?: "meters" };
	seconds: Networking.Serialized<() => number & { readonly unit?: "seconds" }>;
}

const events = Networking.createEvent<LayoutServerEvents, {}>();
const functions = Networking.createFunction<LayoutFunctions, {}>();
export const client = events.createClient({});
export const server = events.createServer({});
export const serverFunctions = functions.createServer({});
`;

	const either = (members: [string, string], call: string) => `${header}
export function run(flag: boolean) {
	return (flag ? ${members[0]} : ${members[1]}).${call};
}
`;

	const plainOutput = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");
	const refusals = (output: string) =>
		new Map(
			[
				...plainOutput(output).matchAll(
					/The call '(.+?)' may reach networking members that are packed differently: (.+)\./g,
				),
			].map((match) => [match[1], match[2]]),
		);

	test("refuses members whose argument lists or results are not laid out and checked alike, naming them", () => {
		const result = compileProbes({
			layoutEvent: either(["client.textFirst", "client.numberFirst"], 'fire("x")'),
			layoutCallback: either(
				["serverFunctions.textFirst", "serverFunctions.numberFirst"],
				"setCallback(() => 1)",
			),
		});

		expect(result.status).not.toBe(0);
		const refused = refusals(result.output);
		expect(refused.get("(flag ? client.textFirst : client.numberFirst).fire(...)")).toBe(
			"their argument lists are not laid out and checked alike ('LayoutServerEvents.numberFirst(value: number | string): void' and 'LayoutServerEvents.textFirst(value: string | number): void')",
		);
		expect(refused.get("(flag ? serverFunctions.textFirst : serverFunctions.numberFirst).setCallback(...)")).toBe(
			"their results are not laid out and checked alike ('LayoutFunctions.numberFirst(): number | string' and 'LayoutFunctions.textFirst(): string | number')",
		);
		expect(refused.size).toBe(2);
		expect(plainOutput(result.output)).toContain("so the receiver of the other would read what it sends wrong");
		expect(plainOutput(result.output)).toContain("so the callers of the other would read them wrong");
	});

	test("packs members laid out and checked alike as one of them would, whatever their types", () => {
		const result = compileProbes({
			alikeEvent: either(["client.textFirst", "client.textFirstToo"], 'fire("x")'),
			// Results that are not assignable either way, but both a plain f64. (TypeScript cannot call
			// `fire` on a union of senders whose argument types differ, so results show it.)
			alikeBranded: either(
				["serverFunctions.meters", "serverFunctions.seconds"],
				"setCallback(() => 5 as never)",
			),
		});

		expect(result.status).toBe(0);
		expect(stripSuffixes(result.files.get("alikeEvent")!)).toMatch(
			/if type\(v\) == "string" then\s*buffer\.writeu8\(buf, o, 0\)[\s\S]*return target:_fire\(buf\)/,
		);
		expect(stripSuffixes(result.files.get("alikeBranded")!)).toMatch(
			/target:_setCallback\(callback, function\(value\)\s*local buf = buffer\.create\(8\)\s*buffer\.writef64\(buf, 0, value\)/,
		);
	});

	test("packs a call on one member with that member's own layout, as before", () => {
		const result = compileProbes({
			layoutDirect: `${header}
export function sendTextFirst() {
	client.textFirst.fire("x");
}

export function sendNumberFirst() {
	client.numberFirst.fire("x");
}
`,
		});

		expect(result.status).toBe(0);
		// `textFirst` numbers the string 0 and `numberFirst` 1, as each declares it.
		const luau = result.files.get("layoutDirect")!;
		expect(functionBody(luau, "sendTextFirst")).toMatch(
			/type\(v\) == "string" then\s*buffer\.writeu8\(buf, o, 0\)/,
		);
		expect(functionBody(luau, "sendNumberFirst")).toMatch(
			/type\(v\) == "string" then\s*buffer\.writeu8\(buf, o, 1\)/,
		);
	});
});

/*
 * Members whose types are one to TypeScript -- a union spelled two ways, an object type's fields
 * written in two orders -- that lay their values out differently. A conditional, a helper's inferred
 * return type or a variable inferred from one used to keep only one of them, and the call was packed
 * as that one (a variable annotated as the union of both was already checked). Each sender and
 * function receiver carries its member's name, after its namespaces' names (`_flamework_member`),
 * so the members stay apart and the call is checked like any other.
 */
describe("targets whose members only their names tell apart", () => {
	const header = `import { Networking } from "@flamework-experimental/networking";

interface MergeServerEvents {
	textFirst(value: string | number): void;
	numberFirst(value: number | string): void;
	textFirstToo(value: string | number): void;
	fieldsPQ(value: { p: number; q: string }): void;
	fieldsQP(value: { q: string; p: number }): void;
	items: {
		textFirst(value: string | number): void;
		numberFirst(value: number | string): void;
		fieldsQP(value: { q: string; p: number }): void;
	};
}

interface MergeClientEvents {
	textFirst(value: string | number): void;
	numberFirst(value: number | string): void;
	textFirstToo(value: string | number): void;
}

interface MergeFunctions {
	textFirst(value: string | number): number;
	numberFirst(value: number | string): number;
	textFirstToo(value: string | number): number;
	resultTextFirst(): string | number;
	resultNumberFirst(): number | string;
	resultTextFirstToo(): string | number;
}

const events = Networking.createEvent<MergeServerEvents, MergeClientEvents>();
const functions = Networking.createFunction<MergeFunctions, {}>();
export const client = events.createClient({});
export const server = events.createServer({});
export const clientFunctions = functions.createClient({});
export const serverFunctions = functions.createServer({});
`;

	/** Two members a call's target may be, and the call (`fire(1)`). */
	interface Case {
		members: [string, string];
		call: string;
	}

	/**
	 * The ways a call's target may be either member, by the suffix of the probe's name: each gives the
	 * probe's source and the call as a refusal names it.
	 */
	const forms: Record<string, (members: [string, string], call: string) => [source: string, named: string]> = {
		Either: ([a, b], call) => [
			`${header}
export function run(flag: boolean) {
	return (flag ? ${a} : ${b}).${call};
}
`,
			`(flag ? ${a} : ${b}).${call.split("(")[0]}(...)`,
		],
		ByName: ([a, b], call) => [
			`${header}
function member(name: "a" | "b") {
	switch (name) {
		case "a":
			return ${a};
		case "b":
			return ${b};
	}
}

export function run(name: "a" | "b") {
	return member(name).${call};
}
`,
			`member(name).${call.split("(")[0]}(...)`,
		],
		Variable: ([a, b], call) => [
			`${header}
export function run(flag: boolean) {
	let target: typeof ${a} | typeof ${b} = ${a};
	if (flag) target = ${b};
	return target.${call};
}
`,
			`target.${call.split("(")[0]}(...)`,
		],
	};

	/** One probe per form for each case, named `<case><form>`. */
	function probes(cases: Record<string, Case>): Record<string, string> {
		const sources: Record<string, string> = {};
		for (const [name, { members, call }] of Object.entries(cases)) {
			for (const [form, make] of Object.entries(forms)) sources[`${name}${form}`] = make(members, call)[0];
		}
		return sources;
	}

	/** Every "packed differently" error of a build, by the probe it is in, as `[call, what differs]`. */
	function refusalsByProbe(output: string): Map<string, [string, string]> {
		const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
		const pattern =
			/src\/(\w+)\.ts:\d+:\d+ - error TS @flamework-experimental\/transformer: The call '(.+?)' may reach networking members that are packed differently: (.+)\./g;
		return new Map(
			[...plain.matchAll(pattern)].map((match) => [match[1], [match[2], match[3]] as [string, string]]),
		);
	}

	const lists = (a: string, b: string) =>
		`their argument lists are not laid out and checked alike ('${a}' and '${b}')`;

	test("refuses a conditional, a helper or a variable over members laid out differently", () => {
		const cases: Record<string, Case & { what: string }> = {
			mergeUnion: {
				members: ["client.textFirst", "client.numberFirst"],
				call: "fire(1)",
				what: lists(
					"MergeServerEvents.numberFirst(value: number | string): void",
					"MergeServerEvents.textFirst(value: string | number): void",
				),
			},
			mergeFields: {
				members: ["client.fieldsPQ", "client.fieldsQP"],
				call: 'fire({ p: 1, q: "x" })',
				what: lists(
					"MergeServerEvents.fieldsPQ(value: { p: number; q: string }): void",
					"MergeServerEvents.fieldsQP(value: { q: string; p: number }): void",
				),
			},
			// A namespace written inline has no interface name to give.
			mergeNamespace: {
				members: ["client.items.textFirst", "client.items.numberFirst"],
				call: "fire(1)",
				what: lists("numberFirst(value: number | string): void", "textFirst(value: string | number): void"),
			},
			mergeAcross: {
				members: ["client.fieldsPQ", "client.items.fieldsQP"],
				call: 'fire({ p: 1, q: "x" })',
				what: lists(
					"MergeServerEvents.fieldsPQ(value: { p: number; q: string }): void",
					"fieldsQP(value: { q: string; p: number }): void",
				),
			},
			mergeServer: {
				members: ["server.textFirst", "server.numberFirst"],
				call: "broadcast(1)",
				what: lists(
					"MergeClientEvents.numberFirst(value: number | string): void",
					"MergeClientEvents.textFirst(value: string | number): void",
				),
			},
			mergeInvoke: {
				members: ["clientFunctions.textFirst", "clientFunctions.numberFirst"],
				call: "invoke(1)",
				what: lists(
					"MergeFunctions.numberFirst(value: number | string): number",
					"MergeFunctions.textFirst(value: string | number): number",
				),
			},
			mergeCallback: {
				members: ["serverFunctions.resultTextFirst", "serverFunctions.resultNumberFirst"],
				call: "setCallback(() => 1)",
				what: "their results are not laid out and checked alike ('MergeFunctions.resultNumberFirst(): number | string' and 'MergeFunctions.resultTextFirst(): string | number')",
			},
		};

		const result = compileProbes(probes(cases));
		expect(result.status).not.toBe(0);
		// TypeScript took every probe: the refusals are the transformer's.
		expect(result.output.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/error TS\d+/);

		const refused = refusalsByProbe(result.output);
		for (const [name, { members, call, what }] of Object.entries(cases)) {
			for (const [form, make] of Object.entries(forms)) {
				const probe = `${name}${form}`;
				expect([probe, ...(refused.get(probe) ?? ["not refused"])]).toEqual([
					probe,
					make(members, call)[1],
					what,
				]);
			}
		}
		expect(refused.size).toBe(Object.keys(cases).length * Object.keys(forms).length);
	});

	test("packs a conditional, a helper or a variable over members laid out alike, as one of them", () => {
		const cases: Record<string, Case> = {
			alikeUnion: { members: ["client.textFirst", "client.textFirstToo"], call: "fire(1)" },
			alikeAcross: { members: ["client.textFirst", "client.items.textFirst"], call: "fire(1)" },
			alikeServer: { members: ["server.textFirst", "server.textFirstToo"], call: "broadcast(1)" },
			alikeInvoke: { members: ["clientFunctions.textFirst", "clientFunctions.textFirstToo"], call: "invoke(1)" },
			alikeCallback: {
				members: ["serverFunctions.resultTextFirst", "serverFunctions.resultTextFirstToo"],
				call: "setCallback(() => 1)",
			},
			// A callback packs only the result, which both declare `number`.
			alikeResults: {
				members: ["serverFunctions.textFirst", "serverFunctions.numberFirst"],
				call: "setCallback(() => 1)",
			},
		};

		const result = compileProbes(probes(cases));
		expect(result.status).toBe(0);
		expect(result.files.size).toBe(Object.keys(cases).length * Object.keys(forms).length);

		// The string is numbered 0, as every one of them declares it.
		const textFirst = /if type\(v\) == "string" then\s*buffer\.writeu8\(buf, o, 0\)/;
		for (const form of Object.keys(forms)) {
			const emit = (name: string) => stripSuffixes(result.files.get(`${name}${form}`)!);
			for (const name of ["alikeUnion", "alikeAcross"]) {
				expect(emit(name)).toMatch(new RegExp(`${textFirst.source}[\\s\\S]*return target:_fire\\(buf\\)`));
			}
			expect(emit("alikeServer")).toMatch(
				new RegExp(`${textFirst.source}[\\s\\S]*return target:_broadcast\\(buf\\)`),
			);
			expect(emit("alikeInvoke")).toMatch(
				new RegExp(`${textFirst.source}[\\s\\S]*return target:_invoke\\(buf\\)`),
			);
			expect(emit("alikeCallback")).toMatch(
				new RegExp(`target:_setCallback\\(callback, function\\(value\\)[\\s\\S]*?${textFirst.source}`),
			);
			expect(emit("alikeResults")).toMatch(
				/target:_setCallback\(callback, function\(value\)\s*local buf = buffer\.create\(8\)\s*buffer\.writef64\(buf, 0, value\)/,
			);
		}
	});

	test("packs a call on one member with that member's own layout, namespaces included", () => {
		const result = compileProbes({
			mergeDirect: `${header}
export function sendNumberFirst() {
	client.numberFirst.fire("x");
}

export function sendNestedNumberFirst() {
	client.items.numberFirst.fire("x");
}

export function sendFieldsPQ() {
	client.fieldsPQ.fire({ p: 1, q: "x" });
}

export function sendNestedFieldsQP() {
	client.items.fieldsQP.fire({ p: 1, q: "x" });
}
`,
		});

		expect(result.status).toBe(0);
		const luau = result.files.get("mergeDirect")!;
		expect(functionBody(luau, "sendNumberFirst")).toMatch(
			/type\(v\) == "string" then\s*buffer\.writeu8\(buf, o, 1\)/,
		);
		expect(functionBody(luau, "sendNestedNumberFirst")).toBe(
			functionBody(luau, "sendNumberFirst")
				.replace("sendNumberFirst", "sendNestedNumberFirst")
				.replace("client.numberFirst", "client.items.numberFirst"),
		);
		// `p` first for one, `q` first for the other, as each declares them. Both object types are
		// repeated in the file, so each send calls a shared writer of its own.
		const packing = (send: string) => {
			const writer = luau.match(
				new RegExp(`local function ${send}\\(\\)\\n(?:(?!\\nend\\n)[\\s\\S])*?codec\\.(w_\\w+)\\(`),
			)?.[1];
			return writer && luau.match(new RegExp(`codec\\.${writer} = function[\\s\\S]*?\\nend\\n`))?.[0];
		};
		expect(packing("sendFieldsPQ")).toMatch(/writef64[\s\S]*writestring/);
		expect(packing("sendNestedFieldsQP")).toMatch(/writestring[\s\S]*writef64/);
	});
});

describe("argument lists with elements after their rest", () => {
	test("guard the elements after the rest on their own, in both builds", () => {
		for (const source of [on(), offSource()]) {
			expect(source).toContain("restList = { { t.number }, t.string, { t.boolean } },");
		}
	});

	test("pack the elements after the rest after it", () => {
		// The rest count is 2, then "a" and "b", then the boolean.
		expect(functionBody(on(), "restListSend")).toMatch(
			/buffer\.writeu8\(buf, o \+ 8, 2\)[\s\S]*buffer\.writestring\(buf, o, text\)[\s\S]*buffer\.writestring\(buf, o, text\)\s*o \+= length\s*buffer\.writeu8\(buf, o, if true then 1 else 0\)\s*modeClient\.restList:_fire\(buf\)/,
		);
		expect(decoder(on(), "incomingSerializers", "restList")).toMatch(
			/local arg = buffer\.readu8\(buf, o\) ~= 0\s*list\[count \+ 2\] = arg/,
		);
		expect(functionBody(offSource(), "restListSend")).toMatch(/modeClient\.restList:fire\(value, "a", "b", true\)/);
	});
});

/*
 * A name declared in both directions: the server's `both`, which the client invokes and the server
 * answers, and the client's `both`, which the server invokes and the client answers. Its handler
 * member is a sender and a receiver at once, `Sender<the other direction's declaration> &
 * Receiver<its own>`. Each side's `setCallback` packs its result as its own declaration lays it out,
 * which is what the other side's `invoke` decodes it with, and each side's sends pack as the
 * declaration they go to. Whether a call packs at all follows that declaration's markers alone.
 */
describe("names declared in both directions", () => {
	const header = `import { Networking } from "@flamework-experimental/networking";

interface BothServerFunctions {
	both(): string | number;
	count(value: number): number;
	same(): string | number;
	other(): number | string;
	items: { both(): string | number };
}

interface BothClientFunctions {
	both(): number | string;
	count(value: number): string;
	items: { both(): number | string };
}

interface BothServerEvents {
	both(value: string | number): void;
}

interface BothClientEvents {
	both(value: number | string): void;
}

const functions = Networking.createFunction<BothServerFunctions, BothClientFunctions>();
const events = Networking.createEvent<BothServerEvents, BothClientEvents>();
export const serverFunctions = functions.createServer({});
export const clientFunctions = functions.createClient({});
export const server = events.createServer({});
export const client = events.createClient({});
`;

	let built: string | undefined;
	/** The probe's emit, built once for the tests that share it. */
	function bothDirections(): string {
		if (built !== undefined) return built;

		const result = compileProbes({
			bothDirections: `${header}
export function serverAnswers() {
	serverFunctions.both.setCallback(() => 1);
}

export function clientAnswers() {
	clientFunctions.both.setCallback(() => 1);
}

export function serverAsks(player: Player) {
	return serverFunctions.both.invoke(player);
}

export function clientAsks() {
	return clientFunctions.both.invoke();
}

export function serverCounts() {
	serverFunctions.count.setCallback((player, value) => value);
}

export function clientCounts() {
	clientFunctions.count.setCallback((value) => tostring(value));
}

export function serverAnswersNested() {
	serverFunctions.items.both.setCallback(() => 1);
}

export function clientAnswersNested() {
	clientFunctions.items.both.setCallback(() => 1);
}

export function serverFires(player: Player) {
	server.both.fire(player, "x");
}

export function clientFires() {
	client.both.fire("x");
}
`,
		});
		if (result.status !== 0) throw new Error(`the probe failed to compile:\n${result.output}`);
		built = result.files.get("bothDirections")!;
		return built;
	}

	/**
	 * A handler's decoder for `name` in one of its metadata tables, at `depth` tabs: 1 at the top,
	 * 3 in a namespace. `undefined` when the table has none for it.
	 */
	function handlerDecoder(source: string, handler: string, table: string, name: string, depth = 1) {
		const metadata = source.match(
			new RegExp(`local ${handler} = \\w+:create\\w+\\(\\{\\}, \\{\\n[\\s\\S]*?\\n\\}\\)\\n`),
		)?.[0];
		const tabs = "\\t".repeat(depth);
		const body = metadata?.match(new RegExp(`\\n${tabs}${table} = \\{\\n([\\s\\S]*?)\\n${tabs}\\},`))?.[1];
		const entry = body?.match(new RegExp(`(?:^|\\n)${tabs}\\t${name} = \\(function[\\s\\S]*?\\n${tabs}\\tend\\),`));
		return entry ? stripSuffixes(entry[0]) : undefined;
	}

	/** The tag a union's packing or decoding gives a string, as text. */
	function stringTag(code: string | undefined): string | undefined {
		return (
			code?.match(/type\(v\w*\) == "string" then\s*buffer\.writeu8\(buf\w*, o\w*, (\d+)\)/)?.[1] ??
			code?.match(/tag\w* == (\d+) then\s*local length\w*, o\w* = vread/)?.[1]
		);
	}

	test("each side's callback packs its result as its own declaration does, as the other side's invoke decodes it", () => {
		const luau = bothDirections();

		// The server's `both` is `string | number`, so the string is 0; the client's is `number | string`.
		expect(stringTag(functionBody(luau, "serverAnswers"))).toBe("0");
		expect(stringTag(handlerDecoder(luau, "clientFunctions", "outgoingResults", "both"))).toBe("0");
		expect(stringTag(functionBody(luau, "clientAnswers"))).toBe("1");
		expect(stringTag(handlerDecoder(luau, "serverFunctions", "outgoingResults", "both"))).toBe("1");

		expect(functionBody(luau, "serverAsks")).toMatch(/return serverFunctions\.both:_invoke\(player\)/);
		expect(functionBody(luau, "clientAsks")).toMatch(/return clientFunctions\.both:_invoke\(\)/);
	});

	test("each side's callback packs its own result type when the two declare different ones", () => {
		const luau = bothDirections();

		// The server's `count` answers a number, the client's a string.
		expect(functionBody(luau, "serverCounts")).toMatch(
			/:_setCallback\(callback, function\(value\)\s*local buf = buffer\.create\(8\)\s*buffer\.writef64\(buf, 0, value\)\s*return \{ buf \}/,
		);
		expect(handlerDecoder(luau, "clientFunctions", "outgoingResults", "count")).toMatch(
			/buffer\.readf64\(buf, 0\)/,
		);
		expect(functionBody(luau, "clientCounts")).toMatch(
			/:_setCallback\(callback, function\(value\)\s*local length = #value[\s\S]*buffer\.writestring\(buf, o, value\)/,
		);
		expect(handlerDecoder(luau, "serverFunctions", "outgoingResults", "count")).toMatch(/buffer\.readstring/);
	});

	test("each side's callback packs its own result inside a namespace", () => {
		const luau = bothDirections();

		expect(stringTag(functionBody(luau, "serverAnswersNested"))).toBe("0");
		expect(stringTag(handlerDecoder(luau, "clientFunctions", "outgoingResults", "both", 3))).toBe("0");
		expect(stringTag(functionBody(luau, "clientAnswersNested"))).toBe("1");
		expect(stringTag(handlerDecoder(luau, "serverFunctions", "outgoingResults", "both", 3))).toBe("1");
	});

	test("each side's event packs as the declaration it is sent to, as the other side decodes it", () => {
		const luau = bothDirections();

		// The server sends the client's `both` (`number | string`), the client the server's.
		expect(stringTag(functionBody(luau, "serverFires"))).toBe("1");
		expect(stringTag(handlerDecoder(luau, "client", "incomingSerializers", "both"))).toBe("1");
		expect(stringTag(functionBody(luau, "clientFires"))).toBe("0");
		expect(stringTag(handlerDecoder(luau, "server", "incomingSerializers", "both"))).toBe("0");
	});

	test("a callback through a union checks the receiver's own result against the others", () => {
		// The server's `both` and `same` are both `string | number`: packed together, the string 0.
		const alike = compileProbes({
			bothAlike: `${header}
export function run(flag: boolean) {
	(flag ? serverFunctions.both : serverFunctions.same).setCallback(() => 1);
}
`,
		});
		expect(alike.status).toBe(0);
		expect(stringTag(alike.files.get("bothAlike"))).toBe("0");

		// The server's `other` is `number | string`, as the client's `both` is, which the call must not read.
		const result = compileProbes({
			bothRefused: `${header}
export function run(flag: boolean) {
	(flag ? serverFunctions.both : serverFunctions.other).setCallback(() => 1);
}
`,
		});
		expect(result.status).not.toBe(0);
		expect(result.output.replace(/\x1b\[[0-9;]*m/g, "")).toContain(
			"The call '(flag ? serverFunctions.both : serverFunctions.other).setCallback(...)' may reach networking members that are packed differently: their results are not laid out and checked alike ('BothServerFunctions.both(): string | number' and 'BothServerFunctions.other(): number | string').",
		);
	});

	describe("declared differently in each direction", () => {
		const modes = `import { Networking } from "@flamework-experimental/networking";

interface ModeServerFunctions {
	mixed: Networking.Serialized<(value: number) => number>;
	rawOne: Networking.Raw<(value: number) => number>;
}

interface ModeClientFunctions {
	mixed(value: number): number;
	rawOne(value: number): number;
}

const functions = Networking.createFunction<ModeServerFunctions, ModeClientFunctions>();
export const serverFunctions = functions.createServer({});
export const clientFunctions = functions.createClient({});

export function serverAnswersMixed() {
	serverFunctions.mixed.setCallback((player, value) => value);
}

export function clientAnswersMixed() {
	clientFunctions.mixed.setCallback((value) => value);
}

export function serverAsksMixed(player: Player) {
	return serverFunctions.mixed.invoke(player, 1);
}

export function clientAsksMixed() {
	return clientFunctions.mixed.invoke(1);
}

export function serverAnswersRaw() {
	serverFunctions.rawOne.setCallback((player, value) => value);
}

export function clientAnswersRaw() {
	clientFunctions.rawOne.setCallback((value) => value);
}

export function serverAsksRaw(player: Player) {
	return serverFunctions.rawOne.invoke(player, 1);
}

export function clientAsksRaw() {
	return clientFunctions.rawOne.invoke(1);
}
`;

		test("packs only the side declared Serialized when the switch is off", () => {
			const result = compileProbes({ bothModes: modes }, { FLAMEWORK_FIXTURE_SERIALIZATION: "false" });
			expect(result.status).toBe(0);
			const luau = result.files.get("bothModes")!;

			// The server's `mixed` is Serialized: the client's requests and the server's results pack.
			expect(functionBody(luau, "clientAsksMixed")).toMatch(/return clientFunctions\.mixed:_invoke\(buf\)/);
			expect(functionBody(luau, "serverAnswersMixed")).toMatch(
				/target:_setCallback\(callback, function\(value\)\s*local buf = buffer\.create\(8\)/,
			);
			expect(handlerDecoder(luau, "serverFunctions", "incomingSerializers", "mixed")).toBeDefined();
			expect(handlerDecoder(luau, "clientFunctions", "outgoingResults", "mixed")).toBeDefined();

			// The client's is plain: the server's requests and the client's results travel as they are.
			expect(functionBody(luau, "serverAsksMixed")).toMatch(/return serverFunctions\.mixed:invoke\(player, 1\)/);
			expect(functionBody(luau, "clientAnswersMixed")).toMatch(
				/clientFunctions\.mixed:setCallback\(function\(value\)/,
			);
			expect(handlerDecoder(luau, "clientFunctions", "incomingSerializers", "mixed")).toBeUndefined();
			expect(handlerDecoder(luau, "serverFunctions", "outgoingResults", "mixed")).toBeUndefined();
		});

		test("leaves the side declared Raw as written when the switch is on", () => {
			const result = compileProbes({ bothModes: modes });
			expect(result.status).toBe(0);
			const luau = result.files.get("bothModes")!;

			// The server's `rawOne` is Raw: the client's requests and the server's results go as they are.
			expect(functionBody(luau, "clientAsksRaw")).toMatch(/return clientFunctions\.rawOne:invoke\(1\)/);
			expect(functionBody(luau, "serverAnswersRaw")).toMatch(
				/serverFunctions\.rawOne:setCallback\(function\(player, value\)/,
			);
			expect(handlerDecoder(luau, "serverFunctions", "incomingSerializers", "rawOne")).toBeUndefined();
			expect(handlerDecoder(luau, "clientFunctions", "outgoingResults", "rawOne")).toBeUndefined();

			// The client's is plain, packed with the switch on.
			expect(functionBody(luau, "serverAsksRaw")).toMatch(
				/return serverFunctions\.rawOne:_invoke\(player, buf\)/,
			);
			expect(functionBody(luau, "clientAnswersRaw")).toMatch(
				/target:_setCallback\(callback, function\(value\)\s*local buf = buffer\.create\(8\)/,
			);
			expect(handlerDecoder(luau, "clientFunctions", "incomingSerializers", "rawOne")).toBeDefined();
			expect(handlerDecoder(luau, "serverFunctions", "outgoingResults", "rawOne")).toBeDefined();
		});
	});

	// Networking 2.0.0-alpha.3 and earlier: a sender carries `_flamework_send` but no declared member
	// (`_flamework_fn`), which senders gained in 2.0.0-alpha.4; a function receiver carried one already.
	// Picking the side's own declaration must not leave such a sender unpacked, or its peer, which
	// decodes it, drops every message. The handler types are networking 2.0.0-alpha.3's, as published
	// (`out/events/types.d.ts`, `out/functions/types.d.ts`), with their documentation left out.
	test("packs a sender that carries no declared member, as networking 2.0.0-alpha.3 made them", () => {
		const result = compileProbes({
			oldSenders: `interface ServerSender<I extends unknown[]> {
	(player: Player | Player[], ...args: I): void;
	fire(players: Player | Player[], ...args: I): void;
	except(players: Player | Player[], ...args: I): void;
	broadcast(...args: I): void;
	readonly _flamework_send?: I;
	_fire(players: Player | Player[], payload?: buffer, blobs?: Array<defined>): void;
	_except(players: Player | Player[], payload?: buffer, blobs?: Array<defined>): void;
	_broadcast(payload?: buffer, blobs?: Array<defined>): void;
}

interface ClientFunctionSender<I extends unknown[], O> {
	(...args: I): Promise<O>;
	invoke(...args: I): Promise<O>;
	invokeWithTimeout(timeout: number, ...args: I): Promise<O>;
	readonly _flamework_send?: I;
	_invoke(payload?: buffer, blobs?: Array<defined>): Promise<O>;
	_invokeWithTimeout(timeout: number, payload?: buffer, blobs?: Array<defined>): Promise<O>;
}

interface ClientFunctionReceiver<I extends unknown[], O, F = unknown> {
	setCallback(callback: (...args: I) => O | Promise<O>): void;
	predict(...args: I): Promise<O>;
	readonly _flamework_receive?: I;
	readonly _flamework_fn?: F;
	_setCallback(callback: (...args: never[]) => unknown, pack: (value: unknown) => unknown): void;
}

// The client's handler member for a name declared in both directions: the server's both(value: string): number,
// which the client invokes, and the client's own both(value: number): string, which it answers.
type Both = ClientFunctionSender<[value: string], number> &
	ClientFunctionReceiver<[value: number], string, (value: number) => string>;

export function serverFires(sender: ServerSender<[value: number]>, player: Player) {
	sender.fire(player, 1);
}

export function clientInvokes(sender: ClientFunctionSender<[value: string], number>) {
	return sender.invoke("x");
}

export function bothInvokes(member: Both) {
	return member.invoke("x");
}

export function bothAnswers(member: Both) {
	member.setCallback((value) => tostring(value));
}
`,
		});
		expect(result.status).toBe(0);
		const luau = result.files.get("oldSenders")!;

		expect(functionBody(luau, "serverFires")).toMatch(
			/buffer\.writef64\(buf, 0, 1\)\s*sender:_fire\(player, buf\)/,
		);
		expect(functionBody(luau, "clientInvokes")).toMatch(
			/local text = "x"[\s\S]*buffer\.writestring\(buf, o, text\)[\s\S]*return sender:_invoke\(buf\)/,
		);
		// The sender packs the list it declares, the string, not the receiver's number.
		expect(functionBody(luau, "bothInvokes")).toMatch(
			/local text = "x"[\s\S]*buffer\.writestring\(buf, o, text\)[\s\S]*return member:_invoke\(buf\)/,
		);
		// The receiver carries its own declaration, as it did then: its string result is packed.
		expect(functionBody(luau, "bothAnswers")).toMatch(
			/member:_setCallback\(callback, function\(value\)\s*local length = #value[\s\S]*buffer\.writestring\(buf, o, value\)/,
		);
	});
});
