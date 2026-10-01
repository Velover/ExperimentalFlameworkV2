import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import * as codecs from "../widthChecks/codecs";
import { expectDefined, expectEqual, expectTrue, suite } from "../testkit";

/*
 * `Serialization.Implicit` widths and the checks on what is written (`serialization.checks`). These
 * specs are built with the specs' own config, which leaves the section out: implicit widths are
 * checked, a value that does not fit raises, in both realms. The other configurations come from
 * packages/specs/variants, which build `widthChecks/codecs.ts` again under a config of their own.
 * The events are `Serialized` members, so everything here holds whatever networking.serialization
 * says.
 */

type Codecs = typeof codecs;

declare const __harness: {
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
	warnings: () => string[];
	clearWarnings: () => void;
	checkVariant: (name: "warn" | "none" | "server" | "client") => Codecs;
};

interface Inbound {
	Fire(this: unknown, ...args: unknown[]): void;
}

interface Everything {
	u8: Serialization.Implicit.u8;
	i8: Serialization.Implicit.i8;
	u16: Serialization.Implicit.u16;
	i16: Serialization.Implicit.i16;
	u32: Serialization.Implicit.u32;
	i32: Serialization.Implicit.i32;
	f32: Serialization.Implicit.f32;
	f64: Serialization.Implicit.f64;
	varint: Serialization.Implicit.varint;
	string8: Serialization.Implicit.string8;
	string16: Serialization.Implicit.string16;
	string32: Serialization.Implicit.string32;
	buffer16: Serialization.Implicit.buffer16;
	buffer32: Serialization.Implicit.buffer32;
	nested: { inner: { id: Serialization.Implicit.u16 } };
	list: Serialization.Implicit.i16[];
	byId: Map<Serialization.Implicit.u8, Serialization.Implicit.string8>;
	set: Set<Serialization.Implicit.u32>;
	tuple: [Serialization.Implicit.i8, ...Serialization.Implicit.varint[]];
	maybe?: Serialization.Implicit.f32;
	pick: Serialization.Implicit.u16 | string;
	pickNumber: Serialization.Implicit.u16 | number;
}

/** Declared in both directions, so one spec body covers both realms. */
interface WidthEvents {
	widthArgs: Networking.SerializedReliable<
		(
			id: Serialization.Implicit.u16,
			delta: Serialization.Implicit.i8,
			label: Serialization.Implicit.string8,
		) => void
	>;
	widthNested: Networking.SerializedReliable<
		(entry: { pos: { x: Serialization.Implicit.i16 } }, list: Serialization.Implicit.u8[]) => void
	>;
	widthEvery: Networking.SerializedReliable<
		(
			u8: Serialization.Implicit.u8,
			i8: Serialization.Implicit.i8,
			u16: Serialization.Implicit.u16,
			i16: Serialization.Implicit.i16,
			u32: Serialization.Implicit.u32,
			i32: Serialization.Implicit.i32,
			f32: Serialization.Implicit.f32,
			f64: Serialization.Implicit.f64,
			varint: Serialization.Implicit.varint,
			string8: Serialization.Implicit.string8,
			string16: Serialization.Implicit.string16,
			string32: Serialization.Implicit.string32,
			buffer16: Serialization.Implicit.buffer16,
			buffer32: Serialization.Implicit.buffer32,
		) => void
	>;
	widthUnion: Networking.SerializedReliable<(pick: Serialization.Implicit.u16 | string) => void>;
}

interface WidthFunctions {
	widthAsk: Networking.Serialized<(id: Serialization.Implicit.u8) => Serialization.Implicit.u16>;
}

const WidthEventsNetwork = Networking.createEvent<WidthEvents, WidthEvents>();
const WidthFunctionsNetwork = Networking.createFunction<WidthFunctions, WidthFunctions>();

type ServerEvents = ReturnType<typeof WidthEventsNetwork.createServer>;
type ClientEvents = ReturnType<typeof WidthEventsNetwork.createClient>;
type ServerFunctions = ReturnType<typeof WidthFunctionsNetwork.createServer>;
type ClientFunctions = ReturnType<typeof WidthFunctionsNetwork.createClient>;

const isServer = RunService.IsServer();
const requester = __harness.newPlayer("Widths") as Player;

let events: { server?: ServerEvents; client?: ClientEvents } | undefined;
let functions: { server?: ServerFunctions; client?: ClientFunctions } | undefined;

/** The realm's handlers. Remotes are the server's to create, so a client spec primes them first. */
function handlers() {
	if (events !== undefined && functions !== undefined) return { events, functions };

	if (isServer) {
		events = { server: WidthEventsNetwork.createServer({}) };
		functions = { server: WidthFunctionsNetwork.createServer({}) };
	} else {
		__harness.asRealm("Server", () => {
			WidthEventsNetwork.createServer({});
			WidthFunctionsNetwork.createServer({});
			__harness.flush();
		});
		events = { client: WidthEventsNetwork.createClient({}) };
		functions = { client: WidthFunctionsNetwork.createClient({}) };
	}

	__harness.flush();
	return { events, functions };
}

function remote(name: string) {
	return expectDefined(__harness.findRemote(name), `${name} remote`);
}

/** Delivers a message as the other realm would, adding the sender on the server. */
function deliver(channel: Instance, ...args: unknown[]) {
	const signals = channel as unknown as { OnServerEvent: Inbound; OnClientEvent: Inbound };
	if (isServer) {
		signals.OnServerEvent.Fire(requester, ...args);
	} else {
		signals.OnClientEvent.Fire(...args);
	}
}

/** What a call raised, or `undefined` when it did not. */
function raised(run: () => unknown): string | undefined {
	const [ok, err] = pcall(run);
	return ok ? undefined : tostring(err);
}

function contains(text: string | undefined, part: string) {
	return text !== undefined && text.find(part, 1, true)[0] !== undefined;
}

/** Raises with a message containing `message`. */
function expectRaises(run: () => unknown, message: string, what: string) {
	const err = raised(run);
	expectTrue(contains(err, message), `${what}: expected an error with "${message}", got ${err ?? "none"}`);
}

/** Raises nothing. */
function expectWrites(run: () => unknown, what: string) {
	expectEqual(raised(run), undefined, `${what}: error`);
}

/** Warned exactly once since the last clear, with a line containing `message`. */
function expectWarned(message: string, what: string) {
	const lines = __harness.warnings().filter((line) => contains(line, message));
	expectEqual(lines.size(), 1, `${what}: warnings with "${message}" (all: ${__harness.warnings().join(" | ")})`);
}

function expectNoWarnings(what: string) {
	expectEqual(__harness.warnings().size(), 0, `${what}: warnings (${__harness.warnings().join(" | ")})`);
}

function roundTrip<T>(serializer: Serialization.Serializer<T>, value: T): T {
	const [payload, blobs] = serializer.serialize(value);
	return serializer.deserialize(payload, blobs);
}

/** A serializer of any type, for comparing two serializers' output. */
type AnySerializer = {
	serialize: (value: never) => LuaTuple<[buffer, Array<defined> | undefined]>;
	deserialize: (payload: buffer) => unknown;
};

/** Compares tables, maps, sets and buffers by content. */
function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeIs(a, "buffer") && typeIs(b, "buffer")) return buffer.tostring(a) === buffer.tostring(b);
	if (!typeIs(a, "table") || !typeIs(b, "table")) return false;

	const left = a as Map<unknown, unknown>;
	const right = b as Map<unknown, unknown>;
	for (const [key, value] of left) {
		if (!deepEquals(value, right.get(key))) return false;
	}
	for (const [key] of right) {
		if (left.get(key) === undefined) return false;
	}
	return true;
}

function filled(size: number, byte = 7) {
	const bytes = buffer.create(size);
	buffer.fill(bytes, 0, byte);
	return bytes;
}

const implicit = {
	u8: Flamework.createSerializer<Serialization.Implicit.u8>(),
	i8: Flamework.createSerializer<Serialization.Implicit.i8>(),
	u16: Flamework.createSerializer<Serialization.Implicit.u16>(),
	i16: Flamework.createSerializer<Serialization.Implicit.i16>(),
	u32: Flamework.createSerializer<Serialization.Implicit.u32>(),
	i32: Flamework.createSerializer<Serialization.Implicit.i32>(),
	f32: Flamework.createSerializer<Serialization.Implicit.f32>(),
	f64: Flamework.createSerializer<Serialization.Implicit.f64>(),
	varint: Flamework.createSerializer<Serialization.Implicit.varint>(),
	string8: Flamework.createSerializer<Serialization.Implicit.string8>(),
	string16: Flamework.createSerializer<Serialization.Implicit.string16>(),
	string32: Flamework.createSerializer<Serialization.Implicit.string32>(),
	buffer16: Flamework.createSerializer<Serialization.Implicit.buffer16>(),
	buffer32: Flamework.createSerializer<Serialization.Implicit.buffer32>(),
};

const strict = {
	u8: Flamework.createSerializer<Serialization.u8>(),
	i8: Flamework.createSerializer<Serialization.i8>(),
	u16: Flamework.createSerializer<Serialization.u16>(),
	i16: Flamework.createSerializer<Serialization.i16>(),
	u32: Flamework.createSerializer<Serialization.u32>(),
	i32: Flamework.createSerializer<Serialization.i32>(),
	f32: Flamework.createSerializer<Serialization.f32>(),
	f64: Flamework.createSerializer<Serialization.f64>(),
	varint: Flamework.createSerializer<Serialization.varint>(),
	string8: Flamework.createSerializer<Serialization.string8>(),
	string16: Flamework.createSerializer<Serialization.string16>(),
	string32: Flamework.createSerializer<Serialization.string32>(),
	buffer16: Flamework.createSerializer<Serialization.buffer16>(),
	buffer32: Flamework.createSerializer<Serialization.buffer32>(),
};

const everything = Flamework.createSerializer<Everything>();

/** An `Everything` at the edges of its widths. */
function edges(): Everything {
	return {
		u8: 255,
		i8: -128,
		u16: 65535,
		i16: -32768,
		u32: 4294967295,
		i32: -2147483648,
		f32: 1.5,
		f64: 0.1,
		varint: 34359738367,
		string8: "a".rep(255),
		string16: "b".rep(65535),
		string32: "c".rep(70000),
		buffer16: filled(65535),
		buffer32: filled(70000),
		nested: { inner: { id: 65535 } },
		list: [-32768, 0, 32767],
		byId: new Map([
			[0, "zero"],
			[255, "d".rep(255)],
		]),
		set: new Set([0, 4294967295]),
		tuple: [127, 0, 34359738367],
		maybe: -2.5,
		pick: 65535,
		pickNumber: 70000,
	};
}

/** Every width's edges, one past them, and a fraction: `[name, fits, fails]`. */
const INTEGER_EDGES: Array<[keyof typeof implicit, number[], number[]]> = [
	["u8", [0, 255], [-1, 256, 2.5]],
	["i8", [-128, 127], [-129, 128, 2.5]],
	["u16", [0, 65535], [-1, 65536, 2.5]],
	["i16", [-32768, 32767], [-32769, 32768, 2.5]],
	["u32", [0, 4294967295], [-1, 4294967296, 2.5]],
	["i32", [-2147483648, 2147483647], [-2147483649, 2147483648, 2.5]],
	["varint", [0, 34359738367], [-1, 34359738368, 2.5]],
];

export = suite("width checks", [
	[
		"writes an implicit width exactly as its strict twin, and reads it back",
		() => {
			const same = (name: string, a: AnySerializer, b: AnySerializer, value: unknown) => {
				const [left] = a.serialize(value as never);
				const [right] = b.serialize(value as never);
				expectEqual(buffer.tostring(left), buffer.tostring(right), `${name}: the same bytes`);
				expectTrue(deepEquals(a.deserialize(left), value), `${name}: read back`);
			};

			same("u8", implicit.u8, strict.u8, 255);
			same("i8", implicit.i8, strict.i8, -128);
			same("u16", implicit.u16, strict.u16, 65535);
			same("i16", implicit.i16, strict.i16, -32768);
			same("u32", implicit.u32, strict.u32, 4294967295);
			same("i32", implicit.i32, strict.i32, -2147483648);
			same("f32", implicit.f32, strict.f32, 1.5);
			same("f64", implicit.f64, strict.f64, 0.1);
			same("varint", implicit.varint, strict.varint, 34359738367);
			same("string8", implicit.string8, strict.string8, "a".rep(255));
			same("string16", implicit.string16, strict.string16, "b".rep(300));
			same("string32", implicit.string32, strict.string32, "c".rep(70000));
			same("buffer16", implicit.buffer16, strict.buffer16, filled(300));
			same("buffer32", implicit.buffer32, strict.buffer32, filled(70000));

			// The length prefixes and widths themselves: 1 + 255, 2 + 300, 4 + 70000 bytes.
			expectEqual(buffer.len(implicit.string8.serialize("a".rep(255))[0]), 256, "string8 bytes");
			expectEqual(buffer.len(implicit.string16.serialize("b".rep(300))[0]), 302, "string16 bytes");
			expectEqual(buffer.len(implicit.buffer32.serialize(filled(70000))[0]), 70004, "buffer32 bytes");
			expectEqual(buffer.len(implicit.u16.serialize(1)[0]), 2, "u16 bytes");
		},
	],
	[
		"round-trips implicit widths as fields, nested, in collections, tuples, optionals and unions",
		() => {
			const value = edges();
			expectTrue(deepEquals(roundTrip(everything, value), value), "every width at its edges");

			const small: Everything = {
				...value,
				string8: "",
				string16: "",
				string32: "",
				buffer16: buffer.create(0),
				buffer32: buffer.create(0),
				maybe: undefined,
				pick: "text",
				tuple: [-128],
				byId: new Map(),
				set: new Set(),
			};
			expectTrue(deepEquals(roundTrip(everything, small), small), "empty strings, buffers and collections");
			expectEqual(roundTrip(everything, value).pickNumber, 70000, "a u16 | number sends 70000 as the number");
		},
	],
	[
		"takes every value an integer width or a varint holds and raises on the rest, naming width, value and path",
		() => {
			for (const [name, fits, fails] of INTEGER_EDGES) {
				const serializer = implicit[name] as unknown as Serialization.Serializer<number>;
				for (const n of fits) {
					expectEqual(roundTrip(serializer, n), n, `${name} ${n}`);
				}
				for (const n of fails) {
					expectRaises(
						() => serializer.serialize(n),
						`[Flamework] ${name} cannot hold ${tostring(n)}, at value`,
						`${name} ${n}`,
					);
				}
				// NaN prints as "nan" or "-nan", depending on how it was made.
				const nan = raised(() => serializer.serialize(0 / 0));
				expectTrue(
					contains(nan, `[Flamework] ${name} cannot hold `) && contains(nan, "nan"),
					`${name} NaN: ${nan}`,
				);
			}
		},
	],
	[
		"refuses a finite f32 past its range, and writes NaN and the infinities as they are",
		() => {
			const f32 = implicit.f32;
			expectEqual(roundTrip(f32, 3.4028234663852886e38), 3.4028234663852886e38, "the largest f32");
			expectEqual(roundTrip(f32, -3.4028234663852886e38), -3.4028234663852886e38, "the smallest f32");
			expectEqual(roundTrip(f32, math.huge), math.huge, "infinity");
			expectEqual(roundTrip(f32, -math.huge), -math.huge, "minus infinity");
			const nan = roundTrip(f32, 0 / 0);
			expectTrue(nan !== nan, "NaN");
			expectRaises(() => f32.serialize(1e39), "[Flamework] f32 cannot hold 1e+39, at value", "1e39");
			expectRaises(() => f32.serialize(-1e39), "[Flamework] f32 cannot hold -1e+39, at value", "-1e39");
			expectEqual(roundTrip(implicit.f64, 1e300), 1e300, "an f64 holds anything");
		},
	],
	[
		"checks a string's or a buffer's byte length against its prefix, and nothing past string32 and buffer32",
		() => {
			expectEqual(roundTrip(implicit.string8, "a".rep(255)), "a".rep(255), "255 bytes");
			expectRaises(
				() => implicit.string8.serialize("a".rep(256)),
				"[Flamework] string8 cannot hold 256 bytes, at value",
				"256 bytes",
			);
			// Bytes, not characters: 128 two-byte characters are 256 bytes.
			expectRaises(
				() => implicit.string8.serialize("é".rep(128)),
				"[Flamework] string8 cannot hold 256 bytes",
				"256 bytes of two-byte characters",
			);
			expectEqual(roundTrip(implicit.string16, "b".rep(65535)).size(), 65535, "65535 bytes");
			expectRaises(
				() => implicit.string16.serialize("b".rep(65536)),
				"[Flamework] string16 cannot hold 65536 bytes, at value",
				"65536 bytes",
			);
			expectEqual(buffer.len(roundTrip(implicit.buffer16, filled(65535))), 65535, "a 65535-byte buffer");
			expectRaises(
				() => implicit.buffer16.serialize(filled(65536)),
				"[Flamework] buffer16 cannot hold 65536 bytes, at value",
				"a 65536-byte buffer",
			);
			expectEqual(roundTrip(implicit.string32, "c".rep(70000)).size(), 70000, "string32");
			expectEqual(buffer.len(roundTrip(implicit.buffer32, filled(70000))), 70000, "buffer32");
		},
	],
	[
		"names the field, element, key and value that did not fit",
		() => {
			const bad = (patch: Partial<Everything>) => () => everything.serialize({ ...edges(), ...patch });
			expectRaises(bad({ u16: 70000 }), "u16 cannot hold 70000, at Everything.u16", "field");
			expectRaises(
				bad({ nested: { inner: { id: -1 } } }),
				"u16 cannot hold -1, at Everything.nested.inner.id",
				"nested",
			);
			expectRaises(bad({ list: [1, 40000] }), "i16 cannot hold 40000, at Everything.list[]", "array element");
			expectRaises(
				bad({ byId: new Map([[300, "x"]]) }),
				"u8 cannot hold 300, at Everything.byId<key>",
				"map key",
			);
			expectRaises(
				bad({ byId: new Map([[1, "x".rep(256)]]) }),
				"string8 cannot hold 256 bytes, at Everything.byId<value>",
				"map value",
			);
			expectRaises(bad({ set: new Set([-1]) }), "u32 cannot hold -1, at Everything.set[]", "set element");
			expectRaises(bad({ tuple: [128] }), "i8 cannot hold 128, at Everything.tuple[0]", "tuple element");
			expectRaises(bad({ tuple: [0, -5] }), "varint cannot hold -5, at Everything.tuple[]", "rest element");
			expectRaises(bad({ maybe: 1e39 }), "f32 cannot hold 1e+39, at Everything.maybe", "optional");
			expectRaises(bad({ pick: 65536 }), "u16 cannot hold 65536, at Everything.pick", "union member");
		},
	],
	[
		"leaves a strict width unchecked by default, so a number that does not fit wraps",
		() => {
			expectEqual(roundTrip(strict.u16, 70000 as Serialization.u16), 4464, "70000 as a u16");
			expectEqual(roundTrip(strict.u16, -1 as Serialization.u16), 65535, "-1 as a u16");
			expectEqual(roundTrip(strict.u16, 2.7 as Serialization.u16), 2, "2.7 as a u16");
			expectEqual(roundTrip(strict.i8, 200 as Serialization.i8), -56, "200 as an i8");
			// A string past its length prefix is refused either way, as it always was.
			expectRaises(
				() => strict.string8.serialize("a".rep(256) as Serialization.string8),
				"string is longer than its u8 length prefix allows",
				"a strict string8",
			);
			expectTrue(
				!contains(
					raised(() => strict.string8.serialize("a".rep(256) as Serialization.string8)),
					"[Flamework]",
				),
				"a strict string8 is refused without the check's message",
			);
		},
	],
	[
		"fails a number that fits no member of a union with the check, and sends 70000 in `u16 | number` as the number",
		() => {
			expectEqual(roundTrip(codecs.either, 7), 7, "a u16");
			expectEqual(roundTrip(codecs.either, "seven"), "seven", "a string");
			expectRaises(() => codecs.either.serialize(70000), "[Flamework] u16 cannot hold 70000, at value", "70000");
			expectRaises(() => codecs.either.serialize(-1), "[Flamework] u16 cannot hold -1, at value", "-1");
			expectEqual(roundTrip(codecs.orNumber, 70000), 70000, "u16 | number");
			expectEqual(roundTrip(codecs.orNumber, 2.5), 2.5, "u16 | number, a fraction");
			expectEqual(buffer.len(codecs.orNumber.serialize(7)[0]), 3, "a u16 that fits is still the u16");
		},
	],
	[
		"checks every argument where a call site packs it, names the member, and sends nothing when one fails",
		() => {
			const { events } = handlers();
			const args = remote("widthArgs");
			const nested = remote("widthNested");
			__harness.clearSent(args);
			__harness.clearSent(nested);

			const fire = (id: number, delta: number, label: string) => () => {
				if (events.server !== undefined) events.server.widthArgs.fire(requester, id, delta, label);
				else events.client!.widthArgs.fire(id, delta, label);
			};
			expectRaises(
				fire(70000, 0, "x"),
				"[Flamework] u16 cannot hold 70000, at 'widthArgs' [0]",
				"first argument",
			);
			expectRaises(fire(1, -129, "x"), "[Flamework] i8 cannot hold -129, at 'widthArgs' [1]", "second argument");
			expectRaises(
				fire(1, 0, "x".rep(300)),
				"[Flamework] string8 cannot hold 300 bytes, at 'widthArgs' [2]",
				"third argument",
			);
			// A literal is judged when the call is built: one that does not fit calls the check as it is.
			expectRaises(
				() => {
					if (events.server !== undefined) events.server.widthArgs.fire(requester, 65536, 0, "x");
					else events.client!.widthArgs.fire(65536, 0, "x");
				},
				"[Flamework] u16 cannot hold 65536, at 'widthArgs' [0]",
				"a literal argument",
			);
			expectEqual(__harness.sent(args).size(), 0, "nothing sent");

			const fireNested = (x: number, list: number[]) => () => {
				if (events.server !== undefined) events.server.widthNested.fire(requester, { pos: { x } }, list);
				else events.client!.widthNested.fire({ pos: { x } }, list);
			};
			expectRaises(
				fireNested(40000, []),
				"[Flamework] i16 cannot hold 40000, at 'widthNested' [0].pos.x",
				"nested",
			);
			expectRaises(fireNested(1, [1, 256]), "[Flamework] u8 cannot hold 256, at 'widthNested' [1][]", "element");
			expectEqual(__harness.sent(nested).size(), 0, "nothing sent");

			expectWrites(fire(65535, -128, "x".rep(255)), "values at their edges");
			expectEqual(__harness.sent(args).size(), 1, "sent once they fit");
		},
	],
	[
		"round-trips every implicit width as an event argument",
		() => {
			const { events } = handlers();
			const channel = remote("widthEvery");
			__harness.clearSent(channel);
			const received = new Array<unknown[]>();
			if (events.server !== undefined)
				events.server.widthEvery.connect((_player, ...values) => received.push(values));
			else events.client!.widthEvery.connect((...values) => received.push(values));
			__harness.flush();

			const s8 = "a".rep(255);
			const s16 = "b".rep(300);
			const s32 = "c".rep(70000);
			const b16 = filled(300, 1);
			const b32 = filled(70000, 2);
			if (events.server !== undefined) {
				events.server.widthEvery.fire(
					requester,
					255,
					-128,
					65535,
					-32768,
					4294967295,
					-2147483648,
					1.5,
					0.1,
					34359738367,
					s8,
					s16,
					s32,
					b16,
					b32,
				);
			} else {
				events.client!.widthEvery.fire(
					255,
					-128,
					65535,
					-32768,
					4294967295,
					-2147483648,
					1.5,
					0.1,
					34359738367,
					s8,
					s16,
					s32,
					b16,
					b32,
				);
			}

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "messages");
			expectTrue(typeIs(sent[0].args[0], "buffer"), "packed");
			deliver(channel, ...sent[0].args);

			expectEqual(received.size(), 1, "delivered past the decoder and the guards");
			const expected: defined[] = [
				255,
				-128,
				65535,
				-32768,
				4294967295,
				-2147483648,
				1.5,
				0.1,
				34359738367,
				s8,
				s16,
				s32,
				b16,
				b32,
			];
			expected.forEach((value, index) => {
				expectTrue(deepEquals(received[0][index], value), `argument ${index}`);
			});
		},
	],
	[
		"round-trips a union argument, and fails a number no member takes",
		() => {
			const { events } = handlers();
			const channel = remote("widthUnion");
			__harness.clearSent(channel);
			const received = new Array<defined>();
			if (events.server !== undefined) events.server.widthUnion.connect((_player, pick) => received.push(pick));
			else events.client!.widthUnion.connect((pick) => received.push(pick));
			__harness.flush();

			const fire = (pick: number | string) => () => {
				if (events.server !== undefined) events.server.widthUnion.fire(requester, pick);
				else events.client!.widthUnion.fire(pick);
			};
			expectRaises(fire(65536), "[Flamework] u16 cannot hold 65536, at 'widthUnion' [0]", "65536");
			expectEqual(__harness.sent(channel).size(), 0, "nothing sent");

			expectWrites(fire(65535), "a u16");
			expectWrites(fire("text"), "a string");
			for (const message of __harness.sent(channel)) deliver(channel, ...message.args);
			expectEqual(received.size(), 2, "delivered");
			expectEqual(received[0], 65535, "the u16");
			expectEqual(received[1], "text", "the string");
		},
	],
	[
		"checks a request where it is invoked and a result where the callback's value is packed",
		() => {
			const { functions } = handlers();
			const send = expectDefined(__harness.findRemoteById(`${isServer ? "@" : "$"}widthAsk`), "request channel");
			__harness.clearSent(send);
			expectRaises(
				() => {
					if (functions.server !== undefined) functions.server.widthAsk.invoke(requester, 256);
					else functions.client!.widthAsk.invoke(256);
				},
				"[Flamework] u8 cannot hold 256, at 'widthAsk' [0]",
				"the request",
			);
			expectEqual(__harness.sent(send).size(), 0, "no request sent");

			if (functions.server !== undefined) functions.server.widthAsk.setCallback((_player, id) => id * 1000);
			else functions.client!.widthAsk.setCallback((id) => id * 1000);

			const receive = expectDefined(
				__harness.findRemoteById(`${isServer ? "$" : "@"}widthAsk`),
				"receive channel",
			);
			const request = Flamework.createSerializer<[Serialization.Implicit.u8]>();
			const result = Flamework.createSerializer<[Serialization.Implicit.u16]>();

			__harness.clearSent(receive);
			deliver(receive, 1, request.serialize([65])[0]);
			const answered = __harness.sent(receive);
			expectEqual(answered.size(), 1, "responses");
			expectEqual(answered[0].args[1], true, "a result that fits");
			expectEqual(result.deserialize(answered[0].args[2] as buffer)[0], 65000, "the packed result");

			__harness.clearSent(receive);
			__harness.clearWarnings();
			deliver(receive, 2, request.serialize([70])[0]);
			const refused = __harness.sent(receive);
			expectEqual(refused.size(), 1, "responses");
			expectEqual(refused[0].args[0], 2, "request id");
			expectEqual(refused[0].args[1], false, "answered as a failure, with no result");
			expectEqual(refused[0].args.size(), 2, "no packed result");
			expectWarned("[Flamework] u16 cannot hold 70000, at 'widthAsk' result", "the result");
			__harness.clearWarnings();
		},
	],
	[
		"`warn` (category all): warns and writes the value as it is, strict widths included",
		() => {
			const v = __harness.checkVariant("warn");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.u16, 70000), 4464, "70000 as a u16 wraps");
			expectWarned("[Flamework] u16 cannot hold 70000, at value", "implicit u16");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.strictU16, 70000 as Serialization.u16), 4464, "a strict u16 too");
			expectWarned("[Flamework] u16 cannot hold 70000, at value", "strict u16");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.i8, 200), -56, "200 as an i8");
			expectEqual(roundTrip(v.i8, -129), 127, "-129 as an i8");
			expectEqual(roundTrip(v.u16, -1), 65535, "-1 as a u16");
			expectEqual(roundTrip(v.u16, 2.7), 2, "2.7 as a u16");
			expectEqual(roundTrip(v.varint, 2.5), 2, "2.5 as a varint");
			expectEqual(roundTrip(v.f32, 1e39), math.huge, "1e39 as an f32");
			expectEqual(__harness.warnings().size(), 6, `one warning each (${__harness.warnings().join(" | ")})`);
			__harness.clearWarnings();

			const tagged = roundTrip(v.tagged, { id: 65536, label: "t" });
			expectEqual(tagged.id, 0, "65536 in a field");
			expectWarned("[Flamework] u16 cannot hold 65536, at Tagged.id", "the field's path");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.either, 70000), 4464, "a number no member takes is written as the u16");
			expectWarned("[Flamework] u16 cannot hold 70000, at value", "the union");
			__harness.clearWarnings();
			expectEqual(roundTrip(v.orNumber, 70000), 70000, "u16 | number takes it as the number");
			expectNoWarnings("u16 | number");

			// A string past its length prefix cannot be written: warned about, then refused as always.
			expectRaises(
				() => v.string8.serialize("a".rep(256)),
				"string is longer than its u8 length prefix allows",
				"string8",
			);
			expectWarned("[Flamework] string8 cannot hold 256 bytes, at value", "string8");
			__harness.clearWarnings();
			expectRaises(
				() => v.buffer16.serialize(filled(65536)),
				"buffer is longer than its u16 length prefix allows",
				"buffer16",
			);
			expectWarned("[Flamework] buffer16 cannot hold 65536 bytes, at value", "buffer16");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.u16, 65535), 65535, "a value that fits");
			expectNoWarnings("values that fit");
		},
	],
	[
		"`none`: checks nothing, so an implicit width wraps as a strict one does",
		() => {
			const v = __harness.checkVariant("none");
			__harness.clearWarnings();
			expectEqual(roundTrip(v.u16, 70000), 4464, "70000 as a u16");
			expectEqual(roundTrip(v.i8, 200), -56, "200 as an i8");
			expectEqual(roundTrip(v.tagged, { id: 65536, label: "t" }).id, 0, "65536 in a field");
			expectEqual(roundTrip(v.f32, 1e39), math.huge, "1e39 as an f32");
			expectRaises(() => v.either.serialize(70000), "value matches none of the union's members", "the union");
			expectRaises(
				() => v.string8.serialize("a".rep(256)),
				"string is longer than its u8 length prefix allows",
				"string8",
			);
			expectTrue(
				!contains(
					raised(() => v.string8.serialize("a".rep(256))),
					"[Flamework]",
				),
				"refused without a check's message",
			);
			expectNoWarnings("none");
		},
	],
	[
		"`side`: checks the writes of the realm it names, in a module both realms run",
		() => {
			const server = __harness.checkVariant("server");
			const client = __harness.checkVariant("client");
			__harness.clearWarnings();

			// Both: the specs' own build.
			expectRaises(() => codecs.u16.serialize(70000), "[Flamework] u16 cannot hold 70000, at value", "both");

			if (isServer) {
				expectRaises(
					() => server.u16.serialize(70000),
					"[Flamework] u16 cannot hold 70000, at value",
					"server, on the server",
				);
				expectRaises(
					() => server.either.serialize(70000),
					"[Flamework] u16 cannot hold 70000, at value",
					"a union, on the server",
				);
				expectEqual(roundTrip(client.u16, 70000), 4464, "client, on the server: unchecked");
				expectRaises(
					() => client.either.serialize(70000),
					"value matches none of the union's members",
					"a union, unchecked",
				);
				expectNoWarnings("client, on the server");
			} else {
				expectEqual(roundTrip(server.u16, 70000), 4464, "server, on the client: unchecked");
				expectRaises(
					() => server.either.serialize(70000),
					"value matches none of the union's members",
					"a union, unchecked",
				);
				expectEqual(roundTrip(client.u16, 70000), 4464, "client, on the client: warned and written");
				expectWarned("[Flamework] u16 cannot hold 70000, at value", "client, on the client");
				__harness.clearWarnings();
				expectEqual(roundTrip(client.either, 70000), 4464, "a union, warned and written");
				expectWarned("[Flamework] u16 cannot hold 70000, at value", "a union, on the client");
				__harness.clearWarnings();
			}

			// A strict width is checked in neither: the category is the default.
			expectEqual(roundTrip(server.strictU16, 70000 as Serialization.u16), 4464, "strict, server variant");
			expectEqual(roundTrip(client.strictU16, 70000 as Serialization.u16), 4464, "strict, client variant");
			expectNoWarnings("strict widths");
		},
	],
]);
