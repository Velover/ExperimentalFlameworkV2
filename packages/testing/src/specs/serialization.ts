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
			const hostileCount = buffer.create(4);
			buffer.writeu32(hostileCount, 0, 0xffffffff);
			expectTrue(
				rejects(() => listSerializer.deserialize(hostileCount)),
				"hostile element count",
			);
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
