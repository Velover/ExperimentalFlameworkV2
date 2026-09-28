import { Flamework, Serialization } from "@flamework-experimental/core";
import { expectEqual, expectTrue, suite } from "../testkit";

/*
 * `Flamework.createSerializer<T>()` builds encode and decode code from the type at compile time:
 * plain buffer reads and writes, with nothing describing the type left in the output. These specs
 * exercise every kind of type the generator understands and the ways a hostile payload can be malformed.
 */

interface Point {
	x: number;
	y: number;
}

type Mode = "idle" | "walk" | "run";

enum Team {
	Red,
	Blue,
}

interface Payload {
	id: Serialization.u16;
	name: Serialization.string8;
	health: number;
	alive: boolean;
	tags: string[];
	scores: Map<string, number>;
	friends: Set<number>;
	where: Point;
	mode: Mode;
	team: Team;
	nickname?: string;
	kind: "payload";
}

interface Compact {
	a: Serialization.u8;
	b: Serialization.i16;
	c: Serialization.f32;
	d: Serialization.string8;
	kind: "compact";
}

interface Node {
	value: number;
	children: Node[];
}

type Shape = { kind: "circle"; radius: number } | { kind: "rect"; w: number; h: number };

interface WithBlobs {
	target: Instance;
	anything: unknown;
	label: string;
}

interface Datatypes {
	position: Vector3;
	look: CFrame;
	tint: Color3;
	size: UDim2;
	area: Rect;
	brick: BrickColor;
}

/** Fields are written in the order they are declared, not alphabetically. */
interface Ordered {
	second: Serialization.u8;
	first: Serialization.u16;
}

/** Members are numbered as written: Coins is 0 and Items is 1. */
type Wallet = { Coins: number } | { Items: string[] };

/** Nested collections with Instances as keys, sets of maps, arrays of tuples: nothing here is special. */
interface Nested {
	byPart: Map<Instance, Array<Set<string>>>;
	pairs: Array<[Serialization.varint, string?]>;
	groups: Set<Map<string, number[]>>;
	tag: `${string}-id`;
}

class Thing {
	constructor(public value: number) {}
}

/**
 * A member that carries no payload of its own, only its tag. `@rbxts/charm-sync` builds exactly
 * this: the patch for a `ReadonlySet<T>` is `ReadonlyMap<T, true | None>`, so every synced set
 * meets a union in which no member writes a byte past the tag.
 */
interface None {
	readonly __none: "__none";
}

/** The two-member object union, where the tag is again the whole payload. */
type Flag = { readonly a: 1 } | { readonly b: 2 };

/** The same union as a field of a struct that sits inside a collection, next to a sized field. */
interface Slot {
	readonly u: true | None;
	readonly n: number;
}

/** And at the top level, in front of a field whose size is not fixed. */
interface Header {
	readonly v: true | None;
	readonly s: string;
}

const NONE: None = { __none: "__none" };

/**
 * What charm-sync sends to patch an object: every field optional. Its guard accepts any table, the
 * removal marker included, so which member a value is written as must not depend on which of the
 * two is written first.
 */
interface Crate {
	readonly n: string;
	readonly t: number;
	readonly s?: boolean;
}

type NoneThenPatch = None | Partial<Crate>;
type PatchThenNone = Partial<Crate> | None;

/** A list next to a patch, which would otherwise take the list and write none of it. */
type ListThenPatch = string[] | Partial<Crate>;
type PatchThenList = Partial<Crate> | string[];

/** A map next to an object it can hold: the map keeps every key, the object only its own. */
type ScoresThenPoint = ReadonlyMap<string, number> | Point;
type PointThenScores = Point | ReadonlyMap<string, number>;

/** An object whose fields include another's: the wider one keeps a value's extra field. */
interface Narrow {
	readonly a: number;
}

interface Wide {
	readonly a: number;
	readonly b?: string;
}

type NarrowThenWide = Narrow | Wide;
type WideThenNarrow = Wide | Narrow;

/** An object next to a patch that declares more than it: the object's guard would drop `b`. */
type NarrowThenPatch = Narrow | Partial<Wide>;
type PatchThenNarrow = Partial<Wide> | Narrow;

/**
 * Shapes that differ a level down. A guard only checks the keys an object declares, at every depth:
 * the map's guard takes a `Holder` and drops `y` and `z` from it, and so does `Flat`'s guard.
 */
interface Holder {
	readonly pos: { readonly x: number; readonly y: number; readonly z: number };
}

type HolderThenMap = Holder | ReadonlyMap<string, { readonly x: number }>;
type MapThenHolder = ReadonlyMap<string, { readonly x: number }> | Holder;

interface Flat {
	readonly pos: { readonly x: number; readonly y: number };
	readonly label?: string;
}

type FlatThenHolder = Flat | Holder;
type HolderThenFlat = Holder | Flat;

/** A branded width next to a plain number: the width only takes what fits it. */
type NarrowNumber = Serialization.u16 | number;

/**
 * A recursive type with no name of its own: a conditional type's instance, the way charm-sync-style
 * patch types are built. Written out in place, it never ended; it is hoisted like a named one.
 */
type NodePatch<T> = T extends object ? { [K in keyof T]?: NodePatch<T[K]> } : T;

/** One unnamed type reached from several places, which share its functions. */
interface Lists {
	readonly a: string[];
	readonly b: string[];
	readonly byName: ReadonlyMap<string, string[]>;
}

/** An element that takes no bytes at all: a collection of these is nothing but its count. */
interface Marker {
	readonly type: "marker";
}

/** One union over every family of kind: a blob, a datatype, discriminated objects, an array and literals. */
type Mixed = Instance | Vector3 | { kind: "a"; v: number } | { kind: "b"; s: string } | number[] | "lit" | 5;

/** The stranger shapes: keys that are datatypes or arrays, tuples as values and members, buffers. */
interface Bizarre {
	weird: Map<Vector3 | Array<{ id: number }>, Set<CFrame | string>>;
	matrix: Array<Array<Map<Serialization.u8, [Vector3, ...string[]]>>>;
	variants: Mixed[];
	unknownInside: Array<Map<string, unknown>>;
	setOfTuples: Set<[number, string]>;
	bytes: buffer;
	colors: Array<Color3 | BrickColor>;
	ro: ReadonlyMap<string, ReadonlyArray<ReadonlySet<number>>>;
}

const payloadSerializer = Flamework.createSerializer<Payload>();
const compactSerializer = Flamework.createSerializer<Compact>();
const modeSerializer = Flamework.createSerializer<Mode>();
const tupleSerializer = Flamework.createSerializer<[number, string?, ...boolean[]]>();
const shapeSerializer = Flamework.createSerializer<Shape>();
const mixedSerializer = Flamework.createSerializer<Point | string>();
const nodeSerializer = Flamework.createSerializer<Node>();
const blobSerializer = Flamework.createSerializer<WithBlobs>();
const datatypeSerializer = Flamework.createSerializer<Datatypes>();
const listSerializer = Flamework.createSerializer<number[]>();
const orderedSerializer = Flamework.createSerializer<Ordered>();
const walletSerializer = Flamework.createSerializer<Wallet>();
const nestedSerializer = Flamework.createSerializer<Nested>();
const thingSerializer = Flamework.createSerializer<Thing>();
const varintSerializer = Flamework.createSerializer<Serialization.varint>();
const bizarreSerializer = Flamework.createSerializer<Bizarre>();
const noneMapSerializer = Flamework.createSerializer<ReadonlyMap<string, true | None>>();
const noneArraySerializer = Flamework.createSerializer<Array<true | None>>();
const flagMapSerializer = Flamework.createSerializer<ReadonlyMap<string, Flag>>();
const slotMapSerializer = Flamework.createSerializer<ReadonlyMap<string, Slot>>();
const headerSerializer = Flamework.createSerializer<Header>();
const bytesSerializer = Flamework.createSerializer<buffer>();
const markersSerializer = Flamework.createSerializer<Array<Array<Marker>>>();
const noneThenPatchSerializer = Flamework.createSerializer<NoneThenPatch>();
const patchThenNoneSerializer = Flamework.createSerializer<PatchThenNone>();
const noneThenPatchMapSerializer = Flamework.createSerializer<ReadonlyMap<string, None | Partial<Crate>>>();
const patchThenNoneMapSerializer = Flamework.createSerializer<ReadonlyMap<string, Partial<Crate> | None>>();
const listThenPatchSerializer = Flamework.createSerializer<ListThenPatch>();
const patchThenListSerializer = Flamework.createSerializer<PatchThenList>();
const scoresThenPointSerializer = Flamework.createSerializer<ScoresThenPoint>();
const pointThenScoresSerializer = Flamework.createSerializer<PointThenScores>();
const narrowThenWideSerializer = Flamework.createSerializer<NarrowThenWide>();
const wideThenNarrowSerializer = Flamework.createSerializer<WideThenNarrow>();
const narrowThenPatchSerializer = Flamework.createSerializer<NarrowThenPatch>();
const patchThenNarrowSerializer = Flamework.createSerializer<PatchThenNarrow>();
const holderThenMapSerializer = Flamework.createSerializer<HolderThenMap>();
const mapThenHolderSerializer = Flamework.createSerializer<MapThenHolder>();
const flatThenHolderSerializer = Flamework.createSerializer<FlatThenHolder>();
const holderThenFlatSerializer = Flamework.createSerializer<HolderThenFlat>();
const narrowNumberSerializer = Flamework.createSerializer<NarrowNumber>();
const textOrNumberSerializer = Flamework.createSerializer<string | number>();
const indexMapSerializer = Flamework.createSerializer<ReadonlyMap<string | number, string>>();
const plainNumberSerializer = Flamework.createSerializer<number>();
const nodePatchSerializer = Flamework.createSerializer<NodePatch<Node>>();
const listsSerializer = Flamework.createSerializer<Lists>();

/** Whether decoding raises, which is how a malformed payload is reported. */
function rejects(run: () => unknown): boolean {
	const [ok] = pcall(run);
	return !ok;
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
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

function roundTrip<T>(serializer: Serialization.Serializer<T>, value: T): T {
	const [payload, blobs] = serializer.serialize(value);
	return serializer.deserialize(payload, blobs);
}

export = suite("serialization", [
	[
		"round-trips objects with primitives, collections, literals, enums and optionals",
		() => {
			const value: Payload = {
				id: 7 as Serialization.u16,
				name: "seven" as Serialization.string8,
				health: 99.5,
				alive: true,
				tags: ["a", "b", "c"],
				scores: new Map([
					["alpha", 1],
					["beta", 2],
				]),
				friends: new Set([3, 5, 8]),
				where: { x: 1.5, y: -2 },
				mode: "walk",
				team: Team.Blue,
				kind: "payload",
			};

			const [payload, blobs] = payloadSerializer.serialize(value);
			expectEqual(blobs, undefined, "blob list for a buffer-only type");
			expectTrue(deepEquals(payloadSerializer.deserialize(payload), value), "decoded value equals the original");

			const withNickname = roundTrip(payloadSerializer, { ...value, nickname: "nick" });
			expectEqual(withNickname.nickname, "nick", "optional present");
			expectEqual(roundTrip(payloadSerializer, value).nickname, undefined, "optional absent");
		},
	],
	[
		"encodes branded widths, literal unions and constants compactly",
		() => {
			const [payload] = compactSerializer.serialize({
				a: 200 as Serialization.u8,
				b: -300 as Serialization.i16,
				c: 1.5 as Serialization.f32,
				d: "hi" as Serialization.string8,
				kind: "compact",
			});
			// u8 + i16 + f32 + (u8 length + 2 bytes) + nothing for the constant
			expectEqual(buffer.len(payload), 1 + 2 + 4 + 3, "byte length");

			const decoded = compactSerializer.deserialize(payload);
			expectEqual(decoded.a, 200, "u8");
			expectEqual(decoded.b, -300, "i16");
			expectEqual(decoded.kind, "compact", "constant restored without bytes");

			const [mode] = modeSerializer.serialize("run");
			expectEqual(buffer.len(mode), 1, "a three-member literal union is one byte");
			expectEqual(modeSerializer.deserialize(mode), "run", "literal decoded");
		},
	],
	[
		"round-trips tuples with optional and rest elements",
		() => {
			expectTrue(
				deepEquals(roundTrip(tupleSerializer, [1, "a", true, false]), [1, "a", true, false]),
				"full tuple",
			);
			expectTrue(deepEquals(roundTrip(tupleSerializer, [2]), [2]), "optional and rest omitted");
		},
	],
	[
		"picks a union member with its guard and encodes the member's index",
		() => {
			expectTrue(
				deepEquals(roundTrip(shapeSerializer, { kind: "circle", radius: 3 }), { kind: "circle", radius: 3 }),
				"circle",
			);
			expectTrue(
				deepEquals(roundTrip(shapeSerializer, { kind: "rect", w: 1, h: 2 }), { kind: "rect", w: 1, h: 2 }),
				"rect",
			);
			expectEqual(roundTrip(mixedSerializer, "text"), "text", "primitive member");
			expectTrue(deepEquals(roundTrip(mixedSerializer, { x: 1, y: 2 }), { x: 1, y: 2 }), "object member");
		},
	],
	[
		"shares the code of a type with no name that is reached more than once, recursive ones included",
		() => {
			const patch: NodePatch<Node> = {
				value: 1,
				children: [{ value: 2, children: [] }, { children: [{ value: 4 }] }],
			};
			expectTrue(deepEquals(roundTrip(nodePatchSerializer, patch), patch), "recursive patch");
			expectTrue(deepEquals(roundTrip(nodePatchSerializer, {}), {}), "empty patch");

			const lists: Lists = {
				a: ["x"],
				b: [],
				byName: new Map([["k", ["y", "z"]]]),
			};
			const [payload] = listsSerializer.serialize(lists);
			// Each list is a count and its strings; the map adds its count and the key.
			expectEqual(buffer.len(payload), 1 + 2 + 1 + (1 + 2 + (1 + 2 + 2)), "the bytes are unchanged");
			expectTrue(deepEquals(listsSerializer.deserialize(payload), lists), "lists");
		},
	],
	[
		"handles recursive types through hoisted functions",
		() => {
			const tree: Node = {
				value: 1,
				children: [
					{ value: 2, children: [{ value: 3, children: [] }] },
					{ value: 4, children: [] },
				],
			};
			expectTrue(deepEquals(roundTrip(nodeSerializer, tree), tree), "tree");
		},
	],
	[
		"sends Instances and unknown values alongside the buffer as blobs",
		() => {
			const target = new Instance("Folder");
			const anything = { nested: true };
			const [payload, blobs] = blobSerializer.serialize({ target, anything, label: "x" });

			expectEqual(blobs?.size(), 2, "blob count");
			const decoded = blobSerializer.deserialize(payload, blobs);
			expectEqual(decoded.target, target, "instance reference");
			expectEqual(decoded.anything, anything, "unknown reference");
			expectEqual(decoded.label, "x", "buffer field");
		},
	],
	[
		"rejects malformed payloads instead of decoding garbage",
		() => {
			const [payload, blobs] = blobSerializer.serialize({
				target: new Instance("Folder"),
				anything: 1,
				label: "abc",
			});

			const truncated = buffer.create(buffer.len(payload) - 1);
			buffer.copy(truncated, 0, payload, 0, buffer.len(truncated));
			expectTrue(
				rejects(() => blobSerializer.deserialize(truncated, blobs)),
				"truncated buffer",
			);

			const padded = buffer.create(buffer.len(payload) + 1);
			buffer.copy(padded, 0, payload);
			expectTrue(
				rejects(() => blobSerializer.deserialize(padded, blobs)),
				"trailing bytes",
			);

			// A blob index that points past the list decodes as nil, which the guards downstream reject.
			expectEqual(blobSerializer.deserialize(payload, []).target, undefined, "blob index out of range");
			expectTrue(
				rejects(() => blobSerializer.deserialize("nope" as never, blobs)),
				"not a buffer",
			);

			const badTag = buffer.create(1);
			buffer.writeu8(badTag, 0, 9);
			expectTrue(
				rejects(() => shapeSerializer.deserialize(badTag)),
				"union tag out of range",
			);
			expectTrue(
				rejects(() => modeSerializer.deserialize(badTag)),
				"literal index out of range",
			);

			// A count that announces more elements than the buffer could hold must not drive an allocation.
			const hostileCount = buffer.create(5);
			[0xff, 0xff, 0xff, 0xff, 0x0f].forEach((byte, i) => buffer.writeu8(hostileCount, i, byte));
			expectTrue(
				rejects(() => listSerializer.deserialize(hostileCount)),
				"hostile element count",
			);

			// A buffer length is checked the same way, before `buffer.create` gets to allocate it: this
			// five-byte payload announces 2^30 bytes, which once cost a gibibyte of heap per message.
			const hostileLength = buffer.create(5);
			[0x80, 0x80, 0x80, 0x80, 0x04].forEach((byte, i) => buffer.writeu8(hostileLength, i, byte));
			const heapBefore = gcinfo();
			expectTrue(
				rejects(() => bytesSerializer.deserialize(hostileLength)),
				"hostile buffer length",
			);
			expectTrue(gcinfo() - heapBefore < 1024, "refused before allocating the announced length");

			// Counts of elements that take no bytes cannot be checked against what is left, so they are
			// capped at 65535 per payload in all. Regression: the cap was per collection, so nesting
			// multiplied it and a 151-byte `Array<Array<Marker>>` payload built 50 × 65535 tables.
			// Two inner arrays announcing 32768 markers each go one past the cap; 32767 each fit.
			const twoInner = (inner: number) => {
				const payload = buffer.create(7);
				buffer.writeu8(payload, 0, 2);
				for (const at of [1, 4]) {
					buffer.writeu8(payload, at, (inner % 128) + 128);
					buffer.writeu8(payload, at + 1, (math.floor(inner / 128) % 128) + 128);
					buffer.writeu8(payload, at + 2, math.floor(inner / 16384));
				}
				return payload;
			};
			expectTrue(
				rejects(() => markersSerializer.deserialize(twoInner(32768))),
				"zero-size counts past the payload's cap",
			);
			const markers = markersSerializer.deserialize(twoInner(32767));
			expectEqual(markers.size(), 2, "zero-size counts within the payload's cap");
			expectEqual(markers[1].size(), 32767, "second inner count");
			expectEqual(markers[1][32766].type, "marker", "zero-size element");
			// The tally starts over with each payload: the next one is not charged for the last.
			expectEqual(markersSerializer.deserialize(twoInner(32767))[0].size(), 32767, "tally reset per payload");

			// A varint that never ends is refused after five bytes rather than read forever.
			const endless = buffer.create(8);
			for (let i = 0; i < 8; i++) buffer.writeu8(endless, i, 0xff);
			expectTrue(
				rejects(() => listSerializer.deserialize(endless)),
				"endless varint",
			);
		},
	],
	[
		"writes fields in declaration order and counts with varints",
		() => {
			const [ordered] = orderedSerializer.serialize({
				second: 1 as Serialization.u8,
				first: 2 as Serialization.u16,
			});
			expectEqual(buffer.readu8(ordered, 0), 1, "first byte is the first declared field");
			expectEqual(buffer.readu16(ordered, 1), 2, "second declared field follows");

			const [short] = listSerializer.serialize([1, 2, 3]);
			expectEqual(buffer.len(short), 1 + 3 * 8, "one length byte below 128 elements");
			const long = new Array<number>();
			for (let i = 0; i < 200; i++) long.push(i);
			const [longPayload] = listSerializer.serialize(long);
			expectEqual(buffer.len(longPayload), 2 + 200 * 8, "two length bytes from 128 elements");
			expectTrue(deepEquals(listSerializer.deserialize(longPayload), long), "long list decoded");

			const [small] = varintSerializer.serialize(5 as Serialization.varint);
			expectEqual(buffer.len(small), 1, "varint below 128");
			const [big] = varintSerializer.serialize(300 as Serialization.varint);
			expectEqual(buffer.len(big), 2, "varint below 16384");
			expectEqual(varintSerializer.deserialize(big), 300, "varint decoded");
			expectEqual(roundTrip(varintSerializer, (2 ** 31) as Serialization.varint), 2 ** 31, "large varint");

			// Blob slots are four bytes each: two blobs, then a one-byte length and one byte of text.
			const [withBlobs] = blobSerializer.serialize({ target: new Instance("Folder"), anything: 1, label: "x" });
			expectEqual(buffer.len(withBlobs), 4 + 4 + 1 + 1, "blob indices are u32");
		},
	],
	[
		"numbers union members in the order they are written",
		() => {
			const [coins] = walletSerializer.serialize({ Coins: 5 });
			const [items] = walletSerializer.serialize({ Items: ["a"] });
			expectEqual(buffer.readu8(coins, 0), 0, "first written member is tag 0");
			expectEqual(buffer.readu8(items, 0), 1, "second written member is tag 1");
			expectTrue(deepEquals(roundTrip(walletSerializer, { Items: ["a", "b"] }), { Items: ["a", "b"] }), "items");
			expectTrue(deepEquals(roundTrip(walletSerializer, { Coins: 7 }), { Coins: 7 }), "coins");

			// `Point | string` as written: the object first, then the string.
			const [text] = mixedSerializer.serialize("text");
			expectEqual(buffer.readu8(text, 0), 1, "string is the second member");
		},
	],
	[
		"round-trips nested collections with Instances as keys and sends class instances as blobs",
		() => {
			const first = new Instance("Folder");
			const second = new Instance("Part");
			const value: Nested = {
				byPart: new Map<Instance, Array<Set<string>>>([
					[first, [new Set(["a", "b"]), new Set<string>()]],
					[second, []],
				]),
				pairs: [
					[1 as Serialization.varint, "one"],
					[200 as Serialization.varint, undefined],
				],
				groups: new Set([new Map([["x", [1, 2]]]), new Map<string, number[]>()]),
				tag: "abc-id",
			};

			const [payload, blobs] = nestedSerializer.serialize(value);
			expectEqual(blobs?.size(), 2, "one blob per Instance key");
			const decoded = nestedSerializer.deserialize(payload, blobs);
			expectTrue(deepEquals(decoded.byPart, value.byPart), "map keyed by Instances");
			expectEqual(decoded.byPart.get(second)?.size(), 0, "empty array under an Instance key");
			expectTrue(deepEquals(decoded.pairs, value.pairs), "array of tuples");
			expectEqual(decoded.pairs[1][0], 200, "varint tuple element");
			expectEqual(decoded.pairs[1][1], undefined, "absent optional tuple element");
			expectEqual(decoded.tag, "abc-id", "template literal string");

			// A set of tables cannot be compared by identity: its members are checked by content.
			expectEqual(decoded.groups.size(), 2, "set of maps");
			let filled = false;
			let empty = false;
			for (const group of decoded.groups) {
				if (group.size() === 0) empty = true;
				else if (deepEquals(group.get("x"), [1, 2])) filled = true;
			}
			expectTrue(filled && empty, "set members decoded by content");

			const thing = new Thing(3);
			const [thingPayload, thingBlobs] = thingSerializer.serialize(thing);
			expectEqual(buffer.len(thingPayload), 4, "a class instance is one blob slot");
			expectEqual(thingSerializer.deserialize(thingPayload, thingBlobs), thing, "same instance back");
		},
	],
	[
		"round-trips bizarre keys, a seven-way union, tuples as members, buffers and readonly collections",
		() => {
			const part = new Instance("Folder");
			const value: Bizarre = {
				weird: new Map<Vector3 | Array<{ id: number }>, Set<CFrame | string>>([
					[new Vector3(1, 2, 3), new Set<CFrame | string>([new CFrame(1, 2, 3), "s"])],
					[[{ id: 9 }], new Set<CFrame | string>(["only"])],
				]),
				matrix: [
					[
						new Map<Serialization.u8, [Vector3, ...string[]]>([
							[3 as Serialization.u8, [Vector3.one, "x", "y"]],
						]),
					],
					[],
				],
				variants: [part, new Vector3(1, 1, 1), { kind: "a", v: 1 }, { kind: "b", s: "s" }, [1, 2], "lit", 5],
				unknownInside: [new Map<string, unknown>([["k", { deep: 1 }]])],
				setOfTuples: new Set<[number, string]>([[1, "a"]]),
				bytes: buffer.fromstring("hello"),
				colors: [new Color3(1, 0, 0), new BrickColor(1004)],
				ro: new Map([["r", [new Set([1, 2])]]]),
			};

			const [payload, blobs] = bizarreSerializer.serialize(value);
			expectEqual(blobs?.size(), 2, "the Instance and the unknown travel as blobs");
			const back = bizarreSerializer.deserialize(payload, blobs);

			expectEqual(back.weird.size(), 2, "map with mixed keys");
			let vectorKey = false;
			let arrayKey = false;
			for (const [key, set] of back.weird) {
				if (typeIs(key, "Vector3")) {
					let frame = false;
					for (const member of set) {
						if (typeIs(member, "CFrame") && member === new CFrame(1, 2, 3)) frame = true;
					}
					vectorKey = key === new Vector3(1, 2, 3) && set.size() === 2 && frame && set.has("s");
				} else {
					arrayKey = key.size() === 1 && key[0].id === 9 && set.size() === 1 && set.has("only");
				}
			}
			expectTrue(vectorKey, "Vector3 key with a set of a CFrame and a string");
			expectTrue(arrayKey, "array-of-objects key");

			const cell = back.matrix[0][0].get(3 as Serialization.u8);
			expectTrue(
				cell !== undefined && cell[0] === Vector3.one && cell[1] === "x" && cell[2] === "y",
				"tuple with rest inside a map",
			);
			expectEqual(back.matrix[1].size(), 0, "empty inner array");

			const v = back.variants;
			expectEqual(v.size(), 7, "every union member");
			expectEqual(v[0], part, "Instance member");
			expectEqual(v[1], new Vector3(1, 1, 1), "Vector3 member");
			expectEqual((v[2] as { kind: string; v: number }).v, 1, "object member a");
			expectEqual((v[3] as { s: string }).s, "s", "object member b");
			expectEqual((v[4] as number[])[1], 2, "array member");
			expectEqual(v[5], "lit", "string literal member");
			expectEqual(v[6], 5, "number literal member");
			// Tags follow the written order: Instance 0 ... 5 is the literal group.
			const [variant] = Flamework.createSerializer<Mixed>().serialize("lit");
			expectEqual(buffer.readu8(variant, 0), 5, "literal group is the sixth member as written");

			expectEqual(
				(back.unknownInside[0].get("k") as { deep: number }).deep,
				1,
				"unknown inside a map inside an array",
			);
			let tuple = false;
			for (const [n, s] of back.setOfTuples) tuple = n === 1 && s === "a";
			expectTrue(tuple, "tuple as a set member");
			expectEqual(buffer.tostring(back.bytes), "hello", "buffer field");
			expectEqual(back.colors[0], new Color3(1, 0, 0), "Color3 member");
			const brick = back.colors[1];
			expectTrue(typeIs(brick, "BrickColor") && brick.Number === 1004, "BrickColor member");
			expectEqual(back.ro.get("r")?.[0].has(2), true, "readonly collections");
		},
	],
	[
		// A union whose members all carry nothing has a fixed size of one byte: the tag. Inside a
		// collection the member wrote that byte and moved the position itself, and the enclosing
		// element layout then moved past the union a second time -- so a struct field after it was
		// written one byte too far along, and every element overran what the size pass had
		// budgeted. One entry left the buffer a byte short and only `deserialize` noticed; two
		// entries ran off the end inside `serialize`. Every synced `Set` in `@rbxts/charm-sync`
		// travels as one of these.
		"round-trips a union whose members carry no payload, in every container",
		() => {
			const single = new Map<string, true | None>([["a", true]]);
			expectTrue(deepEquals(roundTrip(noneMapSerializer, single), single), "one map entry");

			const many = new Map<string, true | None>([
				["a", true],
				["b", NONE],
				["c", true],
			]);
			const [mapPayload] = noneMapSerializer.serialize(many);
			// A varint count, then per entry a varint length, one byte of name and one tag byte.
			expectEqual(buffer.len(mapPayload), 1 + 3 * 3, "map payload length");
			expectTrue(deepEquals(noneMapSerializer.deserialize(mapPayload), many), "three map entries");

			const list: Array<true | None> = [true, NONE, true, NONE];
			const [listPayload] = noneArraySerializer.serialize(list);
			expectEqual(buffer.len(listPayload), 1 + 4, "array payload length");
			expectTrue(deepEquals(noneArraySerializer.deserialize(listPayload), list), "array elements");

			const flags = new Map<string, Flag>([
				["x", { a: 1 }],
				["y", { b: 2 }],
			]);
			expectTrue(deepEquals(roundTrip(flagMapSerializer, flags), flags), "two-member object union");

			// The union is a field here, so a mis-advance also lands the number at the wrong offset.
			const slots = new Map<string, Slot>([
				["p", { u: true, n: 1.5 }],
				["q", { u: NONE, n: -2 }],
			]);
			const back = roundTrip(slotMapSerializer, slots);
			expectEqual(back.get("p")?.n, 1.5, "sized field after a payload-free union");
			expectEqual(back.get("q")?.n, -2, "sized field after the other member");
			expectTrue(deepEquals(back, slots), "struct inside a map");

			// The same at the top level, where the string that follows makes the layout variable.
			const header: Header = { v: NONE, s: "tail" };
			expectTrue(deepEquals(roundTrip(headerSerializer, header), header), "union before a string");
		},
	],
	[
		// Regression: members were tested in the order they were written, and a patch whose fields
		// are all optional has only a guard that ignores keys it does not declare, so it accepted
		// any table. Written first, it took every removal marker after it: `Partial<Crate> | None`
		// wrote a None as an empty patch, and the receiver kept the crate.
		"tells a removal marker from a patch whose fields are all optional, in either written order",
		() => {
			const values: Array<None | Partial<Crate>> = [NONE, { n: "reef", t: 5, s: true }, { s: false }, {}];
			for (const [name, serializer] of [
				["None first", noneThenPatchSerializer],
				["patch first", patchThenNoneSerializer],
			] as const) {
				for (const value of values) {
					expectTrue(deepEquals(roundTrip(serializer, value), value), `${name}: round trip`);
				}

				// A patch is the only member left once None is ruled out, so it only has to be a table;
				// anything else is still refused where it is sent.
				expectTrue(
					rejects(() => serializer.serialize("text" as never)),
					`${name}: a string is refused`,
				);
			}

			// The tag is still the member's position as written.
			expectEqual(buffer.readu8(noneThenPatchSerializer.serialize(NONE)[0], 0), 0, "None written first");
			expectEqual(buffer.readu8(patchThenNoneSerializer.serialize(NONE)[0], 0), 1, "None written second");
			expectEqual(buffer.len(patchThenNoneSerializer.serialize(NONE)[0]), 1, "a None is only its tag");

			const entries = new Map<string, None | Partial<Crate>>([
				["picked", NONE],
				["surfaced", { s: true }],
				["placed", { n: "reef", t: 7 }],
				["unchanged", {}],
			]);
			for (const [name, serializer] of [
				["None first", noneThenPatchMapSerializer],
				["patch first", patchThenNoneMapSerializer],
			] as const) {
				expectTrue(deepEquals(roundTrip(serializer, entries), entries), `${name}: map of patches`);
			}
		},
	],
	[
		"tests the members that keep a whole value before the ones that keep only their own fields",
		() => {
			// A list next to a patch whose fields are all optional: the list is tested first.
			for (const [name, serializer] of [
				["list first", listThenPatchSerializer],
				["patch first", patchThenListSerializer],
			] as const) {
				const list = ["a", "b"];
				expectTrue(deepEquals(roundTrip(serializer, list), list), `${name}: list`);
				expectTrue(deepEquals(roundTrip(serializer, { n: "x" }), { n: "x" }), `${name}: patch`);
			}

			// A map next to an object it can hold: the map keeps every key of a value it accepts.
			for (const [name, serializer] of [
				["map first", scoresThenPointSerializer],
				["object first", pointThenScoresSerializer],
			] as const) {
				const scores = new Map([
					["x", 1],
					["y", 2],
					["z", 3],
				]);
				expectTrue(deepEquals(roundTrip(serializer, scores), scores), `${name}: map with the object's keys`);
				expectTrue(deepEquals(roundTrip(serializer, { x: 4, y: 5 }), { x: 4, y: 5 }), `${name}: object`);
			}

			// An object whose fields include another's: the wider one is tested first.
			for (const [name, serializer] of [
				["narrow first", narrowThenWideSerializer],
				["wide first", wideThenNarrowSerializer],
			] as const) {
				expectTrue(deepEquals(roundTrip(serializer, { a: 1, b: "x" }), { a: 1, b: "x" }), `${name}: wide`);
				expectTrue(deepEquals(roundTrip(serializer, { a: 2 }), { a: 2 }), `${name}: narrow`);
			}

			// An object with a required field next to a patch that declares more: the patch goes first.
			for (const [name, serializer] of [
				["object first", narrowThenPatchSerializer],
				["patch first", patchThenNarrowSerializer],
			] as const) {
				expectTrue(deepEquals(roundTrip(serializer, { a: 1, b: "x" }), { a: 1, b: "x" }), `${name}: patch`);
				expectTrue(deepEquals(roundTrip(serializer, { a: 2 }), { a: 2 }), `${name}: object`);
			}
		},
	],
	[
		// Regression: a guard checks only the keys an object declares, at every depth, so a map of
		// `{ x }` took a `{ pos: { x, y, z } }` and wrote it without `y` and `z`, and so did an object
		// whose `pos` is `{ x, y }`. The members are compared a level down too now.
		"tries a member that would drop part of another's value after it, however deep the part is",
		() => {
			const holder: Holder = { pos: { x: 1, y: 2, z: 3 } };
			for (const [name, serializer] of [
				["object first", holderThenMapSerializer],
				["map first", mapThenHolderSerializer],
			] as const) {
				expectTrue(deepEquals(roundTrip(serializer, holder), holder), `${name}: object`);
				const map = new Map([["k", { x: 5 }]]);
				expectTrue(deepEquals(roundTrip(serializer, map), map), `${name}: map`);
			}

			for (const [name, serializer] of [
				["flat first", flatThenHolderSerializer],
				["deep first", holderThenFlatSerializer],
			] as const) {
				expectTrue(deepEquals(roundTrip(serializer, holder), holder), `${name}: deep`);
				const flat: Flat = { pos: { x: 1, y: 2 }, label: "l" };
				expectTrue(deepEquals(roundTrip(serializer, flat), flat), `${name}: flat`);
			}
		},
	],
	[
		// Regression: `u16 | number` wrote 70000 as a u16, which arrived as 4464.
		"gives a branded number member only the numbers that fit its width",
		() => {
			const cases: Array<[value: number, bytes: number]> = [
				[3, 3],
				[65535, 3],
				[65536, 4],
				[70000, 4],
				[2.5, 9],
				[-1, 9],
			];
			for (const [value, bytes] of cases) {
				const [payload] = narrowNumberSerializer.serialize(value as NarrowNumber);
				expectEqual(buffer.len(payload), bytes, `${value}: bytes`);
				expectEqual(narrowNumberSerializer.deserialize(payload), value, `${value}: round trip`);
			}
			expectEqual(
				buffer.readu8(narrowNumberSerializer.serialize(3 as NarrowNumber)[0], 0),
				0,
				"a u16 is the u16",
			);
		},
	],
	[
		// A number in a union with `number` used to be its tag and an f64, nine bytes even for an
		// array index sent as a `string | number` map key, which is how charm-sync sends array
		// changes. A whole number a varint holds now has a tag of its own, after the members.
		"writes whole numbers in a union with `number` as a varint under a tag of their own",
		() => {
			const cases: Array<[value: number, bytes: number]> = [
				[0, 2],
				[1, 2],
				[127, 2],
				[128, 3],
				[2 ** 31, 6],
				[2 ** 35 - 1, 6],
				[2 ** 35, 9],
				[2 ** 53, 9],
				[-1, 9],
				[0.5, 9],
				[-0, 9],
				[0 / 0, 9],
				[math.huge, 9],
				[-math.huge, 9],
			];
			for (const [value, bytes] of cases) {
				const [payload] = textOrNumberSerializer.serialize(value);
				expectEqual(buffer.len(payload), bytes, `${value}: bytes`);
				const back = textOrNumberSerializer.deserialize(payload) as number;
				const same = value !== value ? back !== back : back === value && 1 / back === 1 / value;
				expectTrue(same, `${value}: round trip, -0 keeping its sign`);
			}

			expectEqual(buffer.readu8(textOrNumberSerializer.serialize(3)[0], 0), 2, "a whole number's own tag");
			expectEqual(buffer.readu8(textOrNumberSerializer.serialize(0.5)[0], 0), 1, "any other number's tag");
			expectEqual(buffer.readu8(textOrNumberSerializer.serialize("s")[0], 0), 0, "the string's tag");
			expectEqual(textOrNumberSerializer.deserialize(textOrNumberSerializer.serialize("s")[0]), "s", "string");

			const keys = new Map<string | number, string>([
				[0, "a"],
				[1, "b"],
				[127, "c"],
				[128, "d"],
				[2 ** 31, "e"],
				[2 ** 53, "f"],
				[-1, "g"],
				[0.5, "h"],
				[math.huge, "i"],
				[-math.huge, "j"],
				["name", "k"],
			]);
			expectTrue(deepEquals(roundTrip(indexMapSerializer, keys), keys), "as map keys");
			for (const [key] of roundTrip(indexMapSerializer, new Map<string | number, string>([[-0, "z"]]))) {
				expectEqual(1 / (key as number), -math.huge, "-0 as a map key");
			}

			// Three array indices: a count, then per entry a one-byte tag, a one-byte varint and a
			// two-byte string, where each key was a tag and an f64 before.
			const indices = new Map<string | number, string>([
				[1, "a"],
				[2, "b"],
				[3, "c"],
			]);
			expectEqual(buffer.len(indexMapSerializer.serialize(indices)[0]), 1 + 3 * (2 + 2), "array indices as keys");

			expectEqual(buffer.len(plainNumberSerializer.serialize(3)[0]), 8, "a plain number stays an f64");
		},
	],
	[
		"round-trips Roblox datatypes",
		() => {
			const value: Datatypes = {
				position: new Vector3(1, 2, 3),
				look: new CFrame(1, 2, 3),
				tint: new Color3(0.25, 0.5, 1),
				size: new UDim2(0.5, 10, 1, -20),
				area: new Rect(0, 0, 100, 50),
				brick: new BrickColor(1004),
			};

			const decoded = roundTrip(datatypeSerializer, value);
			expectEqual(decoded.position, value.position, "Vector3");
			expectEqual(decoded.look, value.look, "CFrame");
			expectEqual(decoded.tint, value.tint, "Color3");
			expectEqual(decoded.size, value.size, "UDim2");
			expectEqual(decoded.area, value.area, "Rect");
			expectEqual(decoded.brick.Number, 1004, "BrickColor");
		},
	],
]);
