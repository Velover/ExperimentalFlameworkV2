import { Flamework, OnStart, Provider, Serialization } from "@flamework-experimental/core";
import {
	defineTests,
	expectArrayEqual,
	expectEqual,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { Workspace } from "@rbxts/services";

interface Point {
	x: number;
	y: number;
}

type Mode = "idle" | "walk" | "run";

interface Payload {
	id: Serialization.u16;
	name: Serialization.string8;
	health: number;
	alive: boolean;
	tags: string[];
	scores: Map<string, number>;
	where: Point;
	mode: Mode;
	nickname?: string;
}

interface WithBlobs {
	target: Instance;
	anything: unknown;
	label: string;
}

interface Datatypes {
	position: Vector3;
	look: CFrame;
	tint: Color3;
}

/** An element that takes no bytes at all: a collection of these is nothing but its count. */
interface Marker {
	readonly type: "marker";
}

const payloadSerializer = Flamework.createSerializer<Payload>();
const blobSerializer = Flamework.createSerializer<WithBlobs>();
const datatypeSerializer = Flamework.createSerializer<Datatypes>();
const bytesSerializer = Flamework.createSerializer<buffer>();
const markersSerializer = Flamework.createSerializer<Array<Array<Marker>>>();

/** A payload of two inner arrays, each announcing `inner` markers as a three-byte varint. */
function twoInner(inner: number) {
	const payload = buffer.create(7);
	buffer.writeu8(payload, 0, 2);
	for (const at of [1, 4]) {
		buffer.writeu8(payload, at, (inner % 128) + 128);
		buffer.writeu8(payload, at + 1, (math.floor(inner / 128) % 128) + 128);
		buffer.writeu8(payload, at + 2, math.floor(inner / 16384));
	}
	return payload;
}

function samplePayload(): Payload {
	return {
		id: 4242 as Serialization.u16,
		name: "sword" as Serialization.string8,
		health: 87.5,
		alive: true,
		tags: ["sharp", "rare"],
		scores: new Map([
			["alice", 3],
			["bob", 9],
		]),
		where: { x: 1.5, y: -2.25 },
		mode: "walk",
	};
}

/**
 * The generated serializers against the engine's own `buffer` and datatypes. The Lune suite runs
 * the same generated code, but on Lune's buffer implementation and its stand-in Vector3 and CFrame;
 * this is the proof that what the transformer emits reads and writes correctly in Roblox itself.
 */
@Provider({ activeIn: ["testing"] })
export class SerializationTests implements OnStart {
	onStart() {
		defineTests("serialization", () => {
			test("a payload survives a round trip through a real buffer", () => {
				const value = samplePayload();
				const [payload, blobs] = payloadSerializer.serialize(value);

				expectTrue(typeIs(payload, "buffer"), "the payload is a buffer");
				expectTrue(buffer.len(payload) > 0, "with bytes in it");
				expectEqual(blobs, undefined, "a buffer-only type carries no blob list");

				const back = payloadSerializer.deserialize(payload, blobs);
				expectEqual(back.id, value.id, "id");
				expectEqual(back.name, value.name, "name");
				expectEqual(back.health, value.health, "health");
				expectEqual(back.alive, value.alive, "alive");
				expectArrayEqual(back.tags, value.tags, "tags");
				expectEqual(back.scores.get("bob"), 9, "a map entry");
				expectEqual(back.where.x, 1.5, "a nested field");
				expectEqual(back.mode, "walk", "a union member");
				expectEqual(back.nickname, undefined, "an absent optional");
			});

			test("an optional field carries its value when it is there", () => {
				const [payload, blobs] = payloadSerializer.serialize({ ...samplePayload(), nickname: "ace" });
				expectEqual(payloadSerializer.deserialize(payload, blobs).nickname, "ace", "nickname");
			});

			test("an Instance travels as a blob rather than in the buffer", () => {
				const part = new Instance("Part");
				part.Name = "FwSerializedTarget";
				part.Parent = Workspace;

				try {
					const [payload, blobs] = blobSerializer.serialize({
						target: part,
						anything: "whatever",
						label: "blobs",
					});

					expectTrue(blobs !== undefined && blobs.size() >= 1, "the instance went into the blob list");
					const back = blobSerializer.deserialize(payload, blobs);
					expectEqual(back.target, part, "the same instance came back");
					expectEqual(back.label, "blobs", "the string beside it");
				} finally {
					part.Destroy();
				}
			});

			test("Roblox datatypes round trip through their own fields", () => {
				const value: Datatypes = {
					position: new Vector3(1, 2, 3),
					look: new CFrame(4, 5, 6),
					tint: Color3.fromRGB(10, 20, 30),
				};

				const [payload, blobs] = datatypeSerializer.serialize(value);
				const back = datatypeSerializer.deserialize(payload, blobs);

				expectTrue(back.position === value.position, `Vector3, got ${tostring(back.position)}`);
				expectTrue(
					back.look.Position === value.look.Position,
					`CFrame position, got ${tostring(back.look.Position)}`,
				);
				expectTrue(
					math.abs(back.tint.R - value.tint.R) < 0.01 && math.abs(back.tint.B - value.tint.B) < 0.01,
					"Color3",
				);
			});

			test("a literal union costs one byte, not a string", () => {
				const [mode] = Flamework.createSerializer<Mode>().serialize("run");
				expectEqual(buffer.len(mode), 1, "one byte for a three-member union");
			});

			test("a truncated payload is refused rather than read past its end", () => {
				const [payload, blobs] = payloadSerializer.serialize(samplePayload());

				const short = buffer.create(math.max(1, buffer.len(payload) - 4));
				buffer.copy(short, 0, payload, 0, buffer.len(short));
				expectThrows(() => payloadSerializer.deserialize(short, blobs), "a truncated buffer");
			});

			test("a hostile buffer length is refused before the engine allocates it", () => {
				// A buffer length is checked against what is left, before `buffer.create` gets to
				// allocate it: this five-byte payload announces 2^30 bytes, which once cost a
				// gibibyte of heap per message. The heap is read either side, in kilobytes.
				const hostileLength = buffer.create(5);
				[0x80, 0x80, 0x80, 0x80, 0x04].forEach((byte, i) => buffer.writeu8(hostileLength, i, byte));

				const heapBefore = collectgarbage("count");
				expectThrows(() => bytesSerializer.deserialize(hostileLength), "hostile buffer length");
				expectTrue(
					collectgarbage("count") - heapBefore < 1024,
					"refused before allocating the announced length",
				);
			});

			test("counts of elements that take no bytes are capped per payload, not per collection", () => {
				// Such counts cannot be checked against what is left, so they are capped at 65535
				// per payload in all. Regression: the cap was per collection, so nesting multiplied
				// it and a 151-byte `Array<Array<Marker>>` payload built 50 x 65535 tables. Two
				// inner arrays announcing 32768 markers each go one past the cap; 32767 each fit.
				expectThrows(
					() => markersSerializer.deserialize(twoInner(32768)),
					"zero-size counts past the payload's cap",
				);

				const markers = markersSerializer.deserialize(twoInner(32767));
				expectEqual(markers.size(), 2, "zero-size counts within the payload's cap");
				expectEqual(markers[1].size(), 32767, "second inner count");
				expectEqual(markers[1][32766].type, "marker", "zero-size element");

				// The tally starts over with each payload: the next one is not charged for the last.
				expectEqual(markersSerializer.deserialize(twoInner(32767))[0].size(), 32767, "tally reset per payload");
			});
		});
	}
}
