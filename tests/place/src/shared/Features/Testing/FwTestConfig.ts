import { Serialization } from "@flamework-experimental/core";

/** Registered as a function provider by each entry point, so every resolution gets a fresh object. */
export interface FwTestConfig {
	realm: "server" | "client";
	stamp: number;
}

export const FW_TEST_FOLDER = "FwTestParts";
export const FW_TEST_TAG = "FwTestPart";
export const FW_TEST_STREAM_TAG = "FwTestStreamPart";
export const FW_TEST_LINK_TAG = "FwTestLinkModel";
export const FW_TEST_STREAM_LINK_TAG = "FwTestStreamLink";

/**
 * The part a streamed link attribute names, and the two places the server puts it.
 *
 * The far position is beyond the streaming radius whatever the place is set to -- the radii are not
 * scriptable, so the test cannot narrow them itself -- which is what makes the client's wait for it
 * a real one.
 */
export const FW_TEST_LINK_FAR = "LinkStreamTarget";
export const FW_TEST_LINK_FAR_POSITION = new Vector3(6000, 10, 5900);
export const FW_TEST_LINK_NEAR_POSITION = new Vector3(0, 10, -25);

/**
 * A Model the server parks far outside any streaming radius, tagged for a client component that
 * uses the default (contextual) streaming mode. With streaming on the client has no such model
 * until its character goes there, which is what the client's `streaming` section does; with it off
 * the model replicates at once. Its own corner of the map, so nothing else streams in with it.
 */
export const FW_TEST_STREAM_MODEL_TAG = "FwTestStreamModel";
export const FW_TEST_STREAM_MODEL = "StreamFarModel";
export const FW_TEST_STREAM_MODEL_POSITION = new Vector3(-6000, 10, -6000);

/**
 * A payload that exercises every kind of type the static serializer handles: datatypes, nested
 * objects, arrays, maps, optionals, literal unions and an Instance that has to travel as a blob.
 */
export interface FwRichPayload {
	position: Vector3;
	look: CFrame;
	tint: Color3;
	tags: string[];
	scores: Map<string, number>;
	nested: { depth: number; label: string };
	mode: "idle" | "walk" | "run";
	maybe?: number;
	part: Instance;
}

/**
 * Everything the serializer has to nest: Instances as map keys, sets of maps of arrays, tuples with
 * varints and optionals inside arrays, unions numbered as written, template-literal strings, `unknown`
 * and an optional Instance deep inside an object. The server echoes it with one change per collection.
 */
export interface FwCrazyPayload {
	byPart: Map<Instance, Array<Set<string>>>;
	pairs: Array<[Serialization.varint, string?]>;
	groups: Set<Map<string, number[]>>;
	wallet: { Coins: number } | { Items: string[] };
	sortOf: number | string;
	tag: `${string}-id`;
	anything: unknown;
	deep: { a: { b: Array<{ c: Vector3; d?: Instance }> } };
	/** Keys that are a datatype or an array of objects, values that are sets mixing a datatype and strings. */
	weird: Map<Vector3 | Array<{ id: number }>, Set<CFrame | string>>;
	/** Nested arrays of maps with a branded key and a tuple value. */
	matrix: Array<Array<Map<Serialization.u8, [Vector3, string]>>>;
	/** Roblox enums as keys and as optional elements. */
	enums: Map<Enum.Material, Array<Enum.KeyCode | undefined>>;
	variants: FwMixed[];
	unknownInside: Array<Map<string, unknown>>;
	setOfTuples: Set<[number, string]>;
	bytes: buffer;
	colors: Array<Color3 | BrickColor>;
	ro: ReadonlyMap<string, ReadonlyArray<ReadonlySet<number>>>;
}

/** One union over every family of kind: a blob, a datatype, discriminated objects, an array and literals. */
export type FwMixed = Instance | Vector3 | { kind: "a"; v: number } | { kind: "b"; s: string } | number[] | "lit" | 5;

/** Parts placed far outside the default streaming radius, so they only replicate with streaming off. */
export const FW_TEST_FAR_COUNT = 3;
