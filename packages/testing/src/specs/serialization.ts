import { Flamework, Serialization } from "@flamework/core";
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
