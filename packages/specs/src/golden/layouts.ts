import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";

/*
 * The fixture of the golden layouts spec (`specs/goldenLayouts.ts`): a wide set of types, each with
 * sample values, and a few networking members with argument lists to send. The bytes every sample is
 * written as are pinned in packages/specs/golden, because games store `Flamework.createSerializer`
 * buffers: a layout may only change on purpose. A case or a sample added here is a golden line to
 * add (bun run test:runtime --update-golden); a case or a sample changed changes its line.
 *
 * Every case has a versioned twin, the same type's `Flamework.createSerializer<T>({ version: 1 })`,
 * written next to it with the type argument copied as written: it writes the header and then the
 * case's own bytes, and pins the type's layout hash in packages/specs/golden/hashes.txt. A few cases
 * at the end are versioned themselves, to pin a header's bytes in full.
 *
 * Maps and sets hold at most one entry: the order a table iterates in is the runtime's, not the
 * layout's. Floats are values an f32 holds exactly where they go into one (NaN, the infinities and
 * -0 among them), so a golden reads back as the very sample, which the spec compares bit for bit.
 */

// --- the types ------------------------------------------------------------------------------------

/** A brand of one's own: any property, the width's literal. */
type Brand16 = number & { readonly kind: "u16" };
/** An optional brand of one's own counts as implicit. */
type LooseByte = number & { readonly mine?: "u8" };

interface Point {
	x: number;
	y: number;
}

interface Profile {
	id: Serialization.u16;
	name: Serialization.string8;
	where: Point;
	tags: string[];
	nickname?: string;
	alive: boolean;
	kind: "profile";
}

interface Optionals {
	a?: Serialization.u8;
	b?: string;
	c: boolean;
	d?: Point;
}

interface Alpha {
	alpha: number;
}

interface Beta {
	beta: string;
}

interface Gamma {
	gamma: boolean;
}

interface Zed {
	zed: boolean;
}

interface Item {
	item: string;
}

interface Box<T> {
	value: T;
}

interface Node {
	value: number;
	children: Node[];
}

interface Chain {
	value: Serialization.u8;
	next?: Chain;
}

/** A recursive type with no name of its own, as charm-sync builds its patches. */
type NodePatch<T> = T extends object ? { [K in keyof T]?: NodePatch<T[K]> } : T;

/** An element that takes no bytes: a collection of these is its count alone. */
interface Marker {
	readonly type: "marker";
}

interface None {
	readonly __none: "__none";
}

interface Crate {
	readonly n: string;
	readonly t: number;
	readonly s?: boolean;
}

type Wallet = { Coins: number } | { Items: string[] };
type Shape = { kind: "circle"; radius: number } | { kind: "rect"; w: number; h: number };
type Mixed = Instance | Vector3 | { kind: "a"; v: number } | { kind: "b"; s: string } | number[] | "lit" | 5;

type Coins = { coins: number };
type Gems = { gems: Serialization.u16 };
type Reward = Coins | Gems;
type Rewards = Reward[] | Reward;

/** Members written as another union: an alias's own written order. */
type Pair = Beta | Alpha;
type Choice = Pair | Gamma;
type Id = number | string;
type Prim = boolean | number | string;
type ItemOrNumber = Item | "number";

interface Prims {
	n: number;
	s: string;
	b: boolean;
}

interface Zoo {
	zebra: number;
	aardvark: string;
	mole: boolean;
}

interface Holder {
	empty: "";
	count: number;
	alpha: Alpha;
}

interface KindHolder {
	kind: "number";
	item: Item;
}

interface Extra {
	extra: number;
}

type Patch<T> = { readonly [P in keyof T]?: T[P] };

interface Inherits extends Record<"kk" | "dd", number> {
	own: string;
}

enum Rarity {
	Common = "common",
	Rare = "rare",
	Epic = "epic",
}

enum Level {
	High = 30,
	Low = 10,
	Mid = 20,
}

enum Team {
	Red,
	Blue,
}

enum Heterogeneous {
	One = 1,
	Text = "text",
}

/** Two enums whose members meet plain literals: the enums go by name, Alpha's ahead of Beta's. */
enum EnumAlpha {
	Q = 2,
	P = 1,
}

enum EnumBeta {
	Y = "y",
	X = "x",
}

/** Computed members are types of their own, sent as blobs: C here, Z and Y in `Late`. */
enum Computed {
	A = 4,
	B = A * 2,
	C = "abc".size(),
	D = 1,
}

enum Late {
	Z = "zzzz".size(),
	A = 1,
	Y = "yyyyyyy".size(),
	B = 2,
}

/** Some of an enum's members, a computed one among them, written in another order than declared. */
type Out = Computed.D | Computed.C;

class Thing {
	constructor(public value: number) {}
}

// --- sample values --------------------------------------------------------------------------------

/** A quiet NaN with fixed bits, so that the bytes do not depend on how a platform makes `0 / 0`. */
const NAN = (() => {
	const bits = buffer.create(8);
	buffer.writeu32(bits, 4, 0x7ff80000);
	return buffer.readf64(bits, 0);
})();
const NEGATIVE_ZERO = -1 / math.huge;
const F32_MAX = 3.4028234663852886e38;
const F32_SMALLEST = 1.401298464324817e-45;

const FOLDER = new Instance("Folder");
FOLDER.Name = "GoldenFolder";
const PART = new Instance("Part");
PART.Name = "GoldenPart";
const TABLE_BLOB = { nested: true };
const THING = new Thing(7);
const NONE: None = { __none: "__none" };

function bytes(...values: number[]): buffer {
	const result = buffer.create(values.size());
	values.forEach((value, index) => buffer.writeu8(result, index, value));
	return result;
}

/** `count` bytes, 0, 1, 2 and on, wrapping at 256: past 127 a count takes two bytes of varint. */
function counting(count: number): Serialization.u8[] {
	const result = new Array<Serialization.u8>();
	for (const index of $range(0, count - 1)) result.push((index % 256) as Serialization.u8);
	return result;
}

function countingBuffer(count: number): buffer {
	const result = buffer.create(count);
	counting(count).forEach((value, index) => buffer.writeu8(result, index, value));
	return result;
}

/** Whole numbers, each labelled as itself. */
function whole<T extends number>(...values: number[]): Array<[string, T]> {
	return values.map((value): [string, T] => [tostring(value), value as T]);
}

function node(value: number, children: Node[] = []): Node {
	return { value, children };
}

// --- the cases ------------------------------------------------------------------------------------

export interface SerializerCase {
	/** The type as written, which with a sample's label names a golden line. */
	readonly type: string;
	readonly serializer: Serialization.Serializer<unknown>;
	/**
	 * The same type's serializer with `{ version: 1 }`, which pins the type's layout hash; absent for
	 * a case whose own serializer is versioned.
	 */
	readonly versioned?: Serialization.Serializer<unknown>;
	readonly samples: ReadonlyArray<readonly [label: string, value: unknown]>;
}

function golden<T>(
	written: string,
	serializer: Serialization.Serializer<T>,
	versioned: Serialization.Serializer<T>,
	samples: Array<[string, NoInfer<T>]>,
): SerializerCase {
	return {
		type: written,
		serializer: serializer as unknown as Serialization.Serializer<unknown>,
		versioned: versioned as unknown as Serialization.Serializer<unknown>,
		samples,
	};
}

/** A case whose own serializer is versioned: its golden bytes start with the header. */
function versionedGolden<T>(
	written: string,
	serializer: Serialization.Serializer<T>,
	samples: Array<[string, NoInfer<T>]>,
): SerializerCase {
	return { type: written, serializer: serializer as unknown as Serialization.Serializer<unknown>, samples };
}

const fullZoo: Zoo = { zebra: 1, aardvark: "a", mole: true };

// Numbers at every width, the bounds of each.
function numberCases(): SerializerCase[] {
	return [
		golden(
			"Serialization.u8",
			Flamework.createSerializer<Serialization.u8>(),
			Flamework.createSerializer<Serialization.u8>({ version: 1 }),
			whole(0, 1, 127, 128, 255),
		),
		golden(
			"Serialization.i8",
			Flamework.createSerializer<Serialization.i8>(),
			Flamework.createSerializer<Serialization.i8>({ version: 1 }),
			whole(-128, -1, 0, 127),
		),
		golden(
			"Serialization.u16",
			Flamework.createSerializer<Serialization.u16>(),
			Flamework.createSerializer<Serialization.u16>({ version: 1 }),
			whole(0, 255, 256, 65535),
		),
		golden(
			"Serialization.i16",
			Flamework.createSerializer<Serialization.i16>(),
			Flamework.createSerializer<Serialization.i16>({ version: 1 }),
			whole(-32768, -1, 0, 32767),
		),
		golden(
			"Serialization.u32",
			Flamework.createSerializer<Serialization.u32>(),
			Flamework.createSerializer<Serialization.u32>({ version: 1 }),
			whole(0, 65536, 4294967295),
		),
		golden(
			"Serialization.i32",
			Flamework.createSerializer<Serialization.i32>(),
			Flamework.createSerializer<Serialization.i32>({ version: 1 }),
			whole(-2147483648, -1, 0, 2147483647),
		),
		golden(
			"Serialization.f32",
			Flamework.createSerializer<Serialization.f32>(),
			Flamework.createSerializer<Serialization.f32>({ version: 1 }),
			[
				["0", 0 as Serialization.f32],
				["-0", NEGATIVE_ZERO as Serialization.f32],
				["1.5", 1.5 as Serialization.f32],
				["-2.25", -2.25 as Serialization.f32],
				["f32 max", F32_MAX as Serialization.f32],
				["-f32 max", -F32_MAX as Serialization.f32],
				["smallest f32", F32_SMALLEST as Serialization.f32],
				["inf", math.huge as Serialization.f32],
				["-inf", -math.huge as Serialization.f32],
				["NaN", NAN as Serialization.f32],
			],
		),
		golden(
			"Serialization.f64",
			Flamework.createSerializer<Serialization.f64>(),
			Flamework.createSerializer<Serialization.f64>({ version: 1 }),
			[
				["0", 0 as Serialization.f64],
				["-0", NEGATIVE_ZERO as Serialization.f64],
				["0.1", 0.1 as Serialization.f64],
				["f64 max", 1.7976931348623157e308 as Serialization.f64],
				["smallest f64", 5e-324 as Serialization.f64],
				["inf", math.huge as Serialization.f64],
				["-inf", -math.huge as Serialization.f64],
				["NaN", NAN as Serialization.f64],
			],
		),
		golden(
			"Serialization.varint",
			Flamework.createSerializer<Serialization.varint>(),
			Flamework.createSerializer<Serialization.varint>({ version: 1 }),
			whole(0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 34359738367),
		),
		golden("number", Flamework.createSerializer<number>(), Flamework.createSerializer<number>({ version: 1 }), [
			["0", 0],
			["-1", -1],
			["0.1", 0.1],
			["2^53", 9007199254740992],
			["inf", math.huge],
			["NaN", NAN],
		]),
		golden(
			"Serialization.Implicit.u8",
			Flamework.createSerializer<Serialization.Implicit.u8>(),
			Flamework.createSerializer<Serialization.Implicit.u8>({ version: 1 }),
			whole(0, 255),
		),
		golden(
			"Serialization.Implicit.i8",
			Flamework.createSerializer<Serialization.Implicit.i8>(),
			Flamework.createSerializer<Serialization.Implicit.i8>({ version: 1 }),
			whole(-128, 127),
		),
		golden(
			"Serialization.Implicit.u16",
			Flamework.createSerializer<Serialization.Implicit.u16>(),
			Flamework.createSerializer<Serialization.Implicit.u16>({ version: 1 }),
			whole(0, 65535),
		),
		golden(
			"Serialization.Implicit.i16",
			Flamework.createSerializer<Serialization.Implicit.i16>(),
			Flamework.createSerializer<Serialization.Implicit.i16>({ version: 1 }),
			whole(-32768, 32767),
		),
		golden(
			"Serialization.Implicit.u32",
			Flamework.createSerializer<Serialization.Implicit.u32>(),
			Flamework.createSerializer<Serialization.Implicit.u32>({ version: 1 }),
			whole(0, 4294967295),
		),
		golden(
			"Serialization.Implicit.i32",
			Flamework.createSerializer<Serialization.Implicit.i32>(),
			Flamework.createSerializer<Serialization.Implicit.i32>({ version: 1 }),
			whole(-2147483648, 2147483647),
		),
		golden(
			"Serialization.Implicit.f32",
			Flamework.createSerializer<Serialization.Implicit.f32>(),
			Flamework.createSerializer<Serialization.Implicit.f32>({ version: 1 }),
			[
				["-0", NEGATIVE_ZERO],
				["1.5", 1.5],
				["f32 max", F32_MAX],
				["inf", math.huge],
			],
		),
		golden(
			"Serialization.Implicit.f64",
			Flamework.createSerializer<Serialization.Implicit.f64>(),
			Flamework.createSerializer<Serialization.Implicit.f64>({ version: 1 }),
			[["0.1", 0.1]],
		),
		golden(
			"Serialization.Implicit.varint",
			Flamework.createSerializer<Serialization.Implicit.varint>(),
			Flamework.createSerializer<Serialization.Implicit.varint>({ version: 1 }),
			whole(0, 128, 34359738367),
		),
		golden(
			'number & { readonly kind: "u16" }',
			Flamework.createSerializer<Brand16>(),
			Flamework.createSerializer<Brand16>({ version: 1 }),
			whole(0, 65535),
		),
		golden(
			'number & { readonly mine?: "u8" }',
			Flamework.createSerializer<LooseByte>(),
			Flamework.createSerializer<LooseByte>({ version: 1 }),
			whole(0, 255),
		),
	];
}

// Strings, buffers and booleans.
function textCases(): SerializerCase[] {
	return [
		golden("string", Flamework.createSerializer<string>(), Flamework.createSerializer<string>({ version: 1 }), [
			['""', ""],
			['"a"', "a"],
			['"héllo"', "héllo"],
			['"a" x 127', "a".rep(127)],
			['"a" x 128', "a".rep(128)],
		]),
		golden(
			"Serialization.string8",
			Flamework.createSerializer<Serialization.string8>(),
			Flamework.createSerializer<Serialization.string8>({ version: 1 }),
			[
				['""', "" as Serialization.string8],
				['"hi"', "hi" as Serialization.string8],
				['"x" x 255', "x".rep(255) as Serialization.string8],
			],
		),
		golden(
			"Serialization.string16",
			Flamework.createSerializer<Serialization.string16>(),
			Flamework.createSerializer<Serialization.string16>({ version: 1 }),
			[
				['""', "" as Serialization.string16],
				['"hi"', "hi" as Serialization.string16],
			],
		),
		golden(
			"Serialization.string32",
			Flamework.createSerializer<Serialization.string32>(),
			Flamework.createSerializer<Serialization.string32>({ version: 1 }),
			[
				['""', "" as Serialization.string32],
				['"hi"', "hi" as Serialization.string32],
			],
		),
		golden(
			"Serialization.Implicit.string8",
			Flamework.createSerializer<Serialization.Implicit.string8>(),
			Flamework.createSerializer<Serialization.Implicit.string8>({ version: 1 }),
			[['"hi"', "hi"]],
		),
		golden(
			"Serialization.Implicit.string16",
			Flamework.createSerializer<Serialization.Implicit.string16>(),
			Flamework.createSerializer<Serialization.Implicit.string16>({ version: 1 }),
			[['"hi"', "hi"]],
		),
		golden(
			"Serialization.Implicit.string32",
			Flamework.createSerializer<Serialization.Implicit.string32>(),
			Flamework.createSerializer<Serialization.Implicit.string32>({ version: 1 }),
			[['"hi"', "hi"]],
		),
		golden(
			"`${string}-id`",
			Flamework.createSerializer<`${string}-id`>(),
			Flamework.createSerializer<`${string}-id`>({ version: 1 }),
			[['"player-id"', "player-id"]],
		),
		golden("buffer", Flamework.createSerializer<buffer>(), Flamework.createSerializer<buffer>({ version: 1 }), [
			["empty", buffer.create(0)],
			["01 02 03", bytes(1, 2, 3)],
			["128 bytes", countingBuffer(128)],
		]),
		golden(
			"Serialization.buffer16",
			Flamework.createSerializer<Serialization.buffer16>(),
			Flamework.createSerializer<Serialization.buffer16>({ version: 1 }),
			[
				["empty", buffer.create(0) as Serialization.buffer16],
				["ff", bytes(0xff) as Serialization.buffer16],
			],
		),
		golden(
			"Serialization.buffer32",
			Flamework.createSerializer<Serialization.buffer32>(),
			Flamework.createSerializer<Serialization.buffer32>({ version: 1 }),
			[["00 01", bytes(0, 1) as Serialization.buffer32]],
		),
		golden(
			"Serialization.Implicit.buffer16",
			Flamework.createSerializer<Serialization.Implicit.buffer16>(),
			Flamework.createSerializer<Serialization.Implicit.buffer16>({ version: 1 }),
			[["07", bytes(7)]],
		),
		golden(
			"Serialization.Implicit.buffer32",
			Flamework.createSerializer<Serialization.Implicit.buffer32>(),
			Flamework.createSerializer<Serialization.Implicit.buffer32>({ version: 1 }),
			[["08", bytes(8)]],
		),
		golden("boolean", Flamework.createSerializer<boolean>(), Flamework.createSerializer<boolean>({ version: 1 }), [
			["false", false],
			["true", true],
		]),
		golden(
			'"payload"',
			Flamework.createSerializer<"payload">(),
			Flamework.createSerializer<"payload">({ version: 1 }),
			[['"payload"', "payload"]],
		),
		golden("5", Flamework.createSerializer<5>(), Flamework.createSerializer<5>({ version: 1 }), [["5", 5]]),
	];
}

// Objects, optional fields, intersections and recursive types.
function objectCases(): SerializerCase[] {
	return [
		golden("Profile", Flamework.createSerializer<Profile>(), Flamework.createSerializer<Profile>({ version: 1 }), [
			[
				"without nickname",
				{
					id: 7 as Serialization.u16,
					name: "seven" as Serialization.string8,
					where: { x: 1.5, y: -2 },
					tags: [],
					alive: true,
					kind: "profile",
				},
			],
			[
				"with nickname",
				{
					id: 65535 as Serialization.u16,
					name: "" as Serialization.string8,
					where: { x: 0.25, y: -8 },
					tags: ["a", "bc"],
					nickname: "nick",
					alive: false,
					kind: "profile",
				},
			],
		]),
		golden(
			"Optionals",
			Flamework.createSerializer<Optionals>(),
			Flamework.createSerializer<Optionals>({ version: 1 }),
			[
				["none", { c: false }],
				["all", { a: 9 as Serialization.u8, b: "b", c: true, d: { x: 1, y: 2 } }],
			],
		),
		golden(
			"Alpha & Beta",
			Flamework.createSerializer<Alpha & Beta>(),
			Flamework.createSerializer<Alpha & Beta>({ version: 1 }),
			[["both", { alpha: 1, beta: "b" }]],
		),
		golden(
			"Point & { z: Serialization.i8 }",
			Flamework.createSerializer<Point & { z: Serialization.i8 }>(),
			Flamework.createSerializer<Point & { z: Serialization.i8 }>({ version: 1 }),
			[["x y z", { x: 1, y: 2, z: -3 as Serialization.i8 }]],
		),
		golden("Node", Flamework.createSerializer<Node>(), Flamework.createSerializer<Node>({ version: 1 }), [
			["leaf", node(1)],
			["tree", node(1, [node(2, [node(3)]), node(4)])],
		]),
		golden("Chain", Flamework.createSerializer<Chain>(), Flamework.createSerializer<Chain>({ version: 1 }), [
			["one", { value: 1 as Serialization.u8 }],
			[
				"three",
				{
					value: 1 as Serialization.u8,
					next: { value: 2 as Serialization.u8, next: { value: 3 as Serialization.u8 } },
				},
			],
		]),
		golden(
			"NodePatch<Node>",
			Flamework.createSerializer<NodePatch<Node>>(),
			Flamework.createSerializer<NodePatch<Node>>({ version: 1 }),
			[
				["empty", {}],
				["nested", { value: 1, children: [{ value: 2, children: [] }, { children: [{ value: 4 }] }] }],
			],
		),
		golden(
			"Thing (a class)",
			Flamework.createSerializer<Thing>(),
			Flamework.createSerializer<Thing>({ version: 1 }),
			[["instance", THING]],
		),
	];
}

// Arrays, tuples, maps and sets.
function collectionCases(): SerializerCase[] {
	return [
		golden(
			"number[]",
			Flamework.createSerializer<number[]>(),
			Flamework.createSerializer<number[]>({ version: 1 }),
			[
				["empty", []],
				["1, 2.5", [1, 2.5]],
			],
		),
		golden(
			"string[]",
			Flamework.createSerializer<string[]>(),
			Flamework.createSerializer<string[]>({ version: 1 }),
			[['"", "a"', ["", "a"]]],
		),
		golden(
			"Serialization.u8[]",
			Flamework.createSerializer<Serialization.u8[]>(),
			Flamework.createSerializer<Serialization.u8[]>({ version: 1 }),
			[
				["0, 255", [0 as Serialization.u8, 255 as Serialization.u8]],
				["128 elements", counting(128)],
				["300 elements", counting(300)],
			],
		),
		golden(
			"Array<Array<Marker>>",
			Flamework.createSerializer<Array<Array<Marker>>>(),
			Flamework.createSerializer<Array<Array<Marker>>>({ version: 1 }),
			[
				["empty", []],
				["[], [m, m]", [[], [{ type: "marker" }, { type: "marker" }]]],
			],
		),
		golden("[]", Flamework.createSerializer<[]>(), Flamework.createSerializer<[]>({ version: 1 }), [["empty", []]]),
		golden(
			"[Serialization.u8, Serialization.u8]",
			Flamework.createSerializer<[Serialization.u8, Serialization.u8]>(),
			Flamework.createSerializer<[Serialization.u8, Serialization.u8]>({ version: 1 }),
			[["1, 2", [1 as Serialization.u8, 2 as Serialization.u8]]],
		),
		golden(
			"[number, string?, ...boolean[]]",
			Flamework.createSerializer<[number, string?, ...boolean[]]>(),
			Flamework.createSerializer<[number, string?, ...boolean[]]>({ version: 1 }),
			[
				["1", [1]],
				['1, "a"', [1, "a"]],
				['1, "a", true, false', [1, "a", true, false]],
			],
		),
		golden(
			"[number, ...string[], boolean]",
			Flamework.createSerializer<[number, ...string[], boolean]>(),
			Flamework.createSerializer<[number, ...string[], boolean]>({ version: 1 }),
			[
				["1, true", [1, true]],
				['1, "a", "b", false', [1, "a", "b", false]],
			],
		),
		golden(
			"[...string[], boolean]",
			Flamework.createSerializer<[...string[], boolean]>(),
			Flamework.createSerializer<[...string[], boolean]>({ version: 1 }),
			[
				["true", [true]],
				['"x", false', ["x", false]],
			],
		),
		golden(
			"Map<string, number>",
			Flamework.createSerializer<Map<string, number>>(),
			Flamework.createSerializer<Map<string, number>>({ version: 1 }),
			[
				["empty", new Map()],
				['"a" -> 1', new Map([["a", 1]])],
			],
		),
		golden(
			"Set<number>",
			Flamework.createSerializer<Set<number>>(),
			Flamework.createSerializer<Set<number>>({ version: 1 }),
			[
				["empty", new Set()],
				["3", new Set([3])],
			],
		),
		golden(
			"Map<Serialization.u8, Set<string>>",
			Flamework.createSerializer<Map<Serialization.u8, Set<string>>>(),
			Flamework.createSerializer<Map<Serialization.u8, Set<string>>>({ version: 1 }),
			[['1 -> { "a" }', new Map([[1 as Serialization.u8, new Set(["a"])]])]],
		),
		golden(
			"ReadonlyMap<string, true | None>",
			Flamework.createSerializer<ReadonlyMap<string, true | None>>(),
			Flamework.createSerializer<ReadonlyMap<string, true | None>>({ version: 1 }),
			[
				['"k" -> true', new Map([["k", true as true | None]])],
				['"k" -> None', new Map([["k", NONE as true | None]])],
			],
		),
		golden(
			"Map<Instance, string>",
			Flamework.createSerializer<Map<Instance, string>>(),
			Flamework.createSerializer<Map<Instance, string>>({ version: 1 }),
			[['Folder -> "x"', new Map([[FOLDER as Instance, "x"]])]],
		),
		// An index signature is a map.
		golden(
			"{ [id: string]: number }",
			Flamework.createSerializer<{ [id: string]: number }>(),
			Flamework.createSerializer<{ [id: string]: number }>({ version: 1 }),
			[['"a" -> 1.5', { a: 1.5 }]],
		),
		golden(
			"Record<string, Serialization.u8>",
			Flamework.createSerializer<Record<string, Serialization.u8>>(),
			Flamework.createSerializer<Record<string, Serialization.u8>>({ version: 1 }),
			[['"k" -> 9', { k: 9 as Serialization.u8 }]],
		),
		golden(
			"{ [n: number]: string }",
			Flamework.createSerializer<{ [n: number]: string }>(),
			Flamework.createSerializer<{ [n: number]: string }>({ version: 1 }),
			[['5 -> "five"', { [5]: "five" }]],
		),
		// An element type that takes nil writes a hole as one. `#` counts the list: a table built as
		// `{ 1, nil }` counts 1, so a trailing `undefined` is not sent.
		golden(
			"Array<number | undefined>",
			Flamework.createSerializer<Array<number | undefined>>(),
			Flamework.createSerializer<Array<number | undefined>>({ version: 1 }),
			[
				["1, undefined, 3 (a hole)", [1, undefined, 3]],
				["undefined, 2 (a hole first)", [undefined, 2]],
				["1, undefined (trailing)", [1, undefined]],
			],
		),
	];
}

// Unions written out where the value is reached, numbered as written.
function writtenUnionCases(): SerializerCase[] {
	return [
		golden(
			"number | string",
			Flamework.createSerializer<number | string>(),
			Flamework.createSerializer<number | string>({ version: 1 }),
			[
				["3 (whole)", 3],
				["1.5", 1.5],
				["-1", -1],
				["2^35", 34359738368],
				['"x"', "x"],
				["-0 (not whole)", NEGATIVE_ZERO],
			],
		),
		golden(
			"string | number",
			Flamework.createSerializer<string | number>(),
			Flamework.createSerializer<string | number>({ version: 1 }),
			[
				['"x"', "x"],
				["3 (whole)", 3],
				["1.5", 1.5],
			],
		),
		golden(
			"Serialization.u16 | number",
			Flamework.createSerializer<Serialization.u16 | number>(),
			Flamework.createSerializer<Serialization.u16 | number>({ version: 1 }),
			[
				["7", 7],
				["70000", 70000],
				["1.5", 1.5],
			],
		),
		golden(
			"Point | string",
			Flamework.createSerializer<Point | string>(),
			Flamework.createSerializer<Point | string>({ version: 1 }),
			[
				["point", { x: 1, y: 2 }],
				['"p"', "p"],
			],
		),
		golden("Wallet", Flamework.createSerializer<Wallet>(), Flamework.createSerializer<Wallet>({ version: 1 }), [
			["Coins", { Coins: 5 }],
			["Items", { Items: ["a"] }],
		]),
		golden("Shape", Flamework.createSerializer<Shape>(), Flamework.createSerializer<Shape>({ version: 1 }), [
			["circle", { kind: "circle", radius: 3 }],
			["rect", { kind: "rect", w: 1, h: 2 }],
		]),
		golden("Mixed", Flamework.createSerializer<Mixed>(), Flamework.createSerializer<Mixed>({ version: 1 }), [
			["Folder", FOLDER],
			["Vector3", new Vector3(1, 2, 3)],
			['kind "a"', { kind: "a", v: 1 }],
			['kind "b"', { kind: "b", s: "s" }],
			["[1, 2]", [1, 2]],
			['"lit"', "lit"],
			["5", 5],
		]),
		golden(
			"true | None",
			Flamework.createSerializer<true | None>(),
			Flamework.createSerializer<true | None>({ version: 1 }),
			[
				["true", true],
				["None", NONE],
			],
		),
		golden(
			"Partial<Crate> | None",
			Flamework.createSerializer<Partial<Crate> | None>(),
			Flamework.createSerializer<Partial<Crate> | None>({ version: 1 }),
			[
				["empty patch", {}],
				["patch", { n: "n", s: false }],
				["None", NONE],
			],
		),
		golden(
			"{ reward?: Reward }",
			Flamework.createSerializer<{ reward?: Reward }>(),
			Flamework.createSerializer<{ reward?: Reward }>({ version: 1 }),
			[
				["none", {}],
				["coins", { reward: { coins: 1 } }],
				["gems", { reward: { gems: 2 as Serialization.u16 } }],
			],
		),
	];
}

// Unions nothing writes out where the value is reached: a generic's type argument.
function unwrittenUnionCases(): SerializerCase[] {
	return [
		golden(
			"Box<Alpha | Beta>",
			Flamework.createSerializer<Box<Alpha | Beta>>(),
			Flamework.createSerializer<Box<Alpha | Beta>>({ version: 1 }),
			[
				["Alpha", { value: { alpha: 1 } }],
				["Beta", { value: { beta: "b" } }],
			],
		),
		golden(
			"Box<string | number>",
			Flamework.createSerializer<Box<string | number>>(),
			Flamework.createSerializer<Box<string | number>>({ version: 1 }),
			[
				['"s"', { value: "s" }],
				["1.5", { value: 1.5 }],
				["2 (whole)", { value: 2 }],
			],
		),
		golden(
			"Box<Item | number>",
			Flamework.createSerializer<Box<Item | number>>(),
			Flamework.createSerializer<Box<Item | number>>({ version: 1 }),
			[
				["Item", { value: { item: "i" } }],
				["1.5", { value: 1.5 }],
			],
		),
		golden(
			"Box<Item | Item[]>",
			Flamework.createSerializer<Box<Item | Item[]>>(),
			Flamework.createSerializer<Box<Item | Item[]>>({ version: 1 }),
			[
				["Item", { value: { item: "i" } }],
				["Item[]", { value: [{ item: "i" }] }],
			],
		),
		golden(
			"Box<Zed | Alpha[]>",
			Flamework.createSerializer<Box<Zed | Alpha[]>>(),
			Flamework.createSerializer<Box<Zed | Alpha[]>>({ version: 1 }),
			[
				["Zed", { value: { zed: true } }],
				["Alpha[]", { value: [{ alpha: 1 }] }],
			],
		),
		golden(
			"Box<Alpha | boolean>",
			Flamework.createSerializer<Box<Alpha | boolean>>(),
			Flamework.createSerializer<Box<Alpha | boolean>>({ version: 1 }),
			[
				["true", { value: true }],
				["Alpha", { value: { alpha: 1 } }],
				["false", { value: false }],
			],
		),
		golden(
			'Box<Alpha | "x" | "y">',
			Flamework.createSerializer<Box<Alpha | "x" | "y">>(),
			Flamework.createSerializer<Box<Alpha | "x" | "y">>({ version: 1 }),
			[
				["Alpha", { value: { alpha: 1 } }],
				['"x"', { value: "x" }],
				['"y"', { value: "y" }],
			],
		),
		golden(
			'Box<{ kind: "move"; to: number } | { kind: "chat"; text: string }>',
			Flamework.createSerializer<Box<{ kind: "move"; to: number } | { kind: "chat"; text: string }>>(),
			Flamework.createSerializer<Box<{ kind: "move"; to: number } | { kind: "chat"; text: string }>>({
				version: 1,
			}),
			[
				["move", { value: { kind: "move", to: 1 } }],
				["chat", { value: { kind: "chat", text: "t" } }],
			],
		),
		golden(
			"Box<Alpha | any[]>",
			Flamework.createSerializer<Box<Alpha | any[]>>(),
			Flamework.createSerializer<Box<Alpha | any[]>>({ version: 1 }),
			[
				["Alpha", { value: { alpha: 1 } }],
				["[]", { value: [] }],
			],
		),
		golden(
			"Box<Enum.Material | Enum.KeyCode>",
			Flamework.createSerializer<Box<Enum.Material | Enum.KeyCode>>(),
			Flamework.createSerializer<Box<Enum.Material | Enum.KeyCode>>({ version: 1 }),
			[
				["Material.Wood", { value: Enum.Material.Wood }],
				["KeyCode.W", { value: Enum.KeyCode.W }],
			],
		),
	];
}

// Members written as another union.
function memberUnionCases(): SerializerCase[] {
	return [
		golden(
			"Choice (Pair | Gamma, Pair = Beta | Alpha)",
			Flamework.createSerializer<Choice>(),
			Flamework.createSerializer<Choice>({ version: 1 }),
			[
				["Beta", { beta: "b" }],
				["Alpha", { alpha: 1 }],
				["Gamma", { gamma: true }],
			],
		),
		golden(
			"Id | Alpha (Id = number | string)",
			Flamework.createSerializer<Id | Alpha>(),
			Flamework.createSerializer<Id | Alpha>({ version: 1 }),
			[
				['"s"', "s"],
				["1.5", 1.5],
				["Alpha", { alpha: 1 }],
				["2 (whole)", 2],
			],
		),
		golden(
			"(number | string) | Alpha",
			Flamework.createSerializer<(number | string) | Alpha>(),
			Flamework.createSerializer<(number | string) | Alpha>({ version: 1 }),
			[
				['"s"', "s"],
				["1.5", 1.5],
				["Alpha", { alpha: 1 }],
			],
		),
		golden(
			"Prim | Prim[]",
			Flamework.createSerializer<Prim | Prim[]>(),
			Flamework.createSerializer<Prim | Prim[]>({ version: 1 }),
			[
				["true", true],
				["1.5", 1.5],
				['"s"', "s"],
				['[1.5, "s", false]', [1.5, "s", false]],
			],
		),
		golden(
			"ItemOrNumber | Alpha",
			Flamework.createSerializer<ItemOrNumber | Alpha>(),
			Flamework.createSerializer<ItemOrNumber | Alpha>({ version: 1 }),
			[
				['"number"', "number"],
				["Item", { item: "i" }],
				["Alpha", { alpha: 1 }],
			],
		),
		golden(
			"{ rewards: Rewards | undefined }",
			Flamework.createSerializer<{ rewards: Rewards | undefined }>(),
			Flamework.createSerializer<{ rewards: Rewards | undefined }>({ version: 1 }),
			[
				["undefined", { rewards: undefined }],
				["Reward[]", { rewards: [{ coins: 1 }] }],
				["Coins", { rewards: { coins: 2 } }],
				["Gems", { rewards: { gems: 3 as Serialization.u16 } }],
			],
		),
		golden(
			"Out | Beta (Out = Computed.D | Computed.C)",
			Flamework.createSerializer<Out | Beta>(),
			Flamework.createSerializer<Out | Beta>({ version: 1 }),
			[
				["Computed.D", Computed.D as Out],
				["Computed.C", Computed.C as Out],
				["Beta", { beta: "b" }],
			],
		),
	];
}

// `X[keyof X]`: a union nothing writes out, as a member.
function indexedUnionCases(): SerializerCase[] {
	return [
		golden(
			"Prims[keyof Prims] | undefined",
			Flamework.createSerializer<Prims[keyof Prims] | undefined>(),
			Flamework.createSerializer<Prims[keyof Prims] | undefined>({ version: 1 }),
			[
				["undefined", undefined],
				['"s"', "s"],
				["1.5", 1.5],
				["false", false],
				["2 (whole)", 2],
			],
		),
		golden(
			"Zoo[keyof Zoo] | Alpha",
			Flamework.createSerializer<Zoo[keyof Zoo] | Alpha>(),
			Flamework.createSerializer<Zoo[keyof Zoo] | Alpha>({ version: 1 }),
			[
				['"s"', "s"],
				["Alpha", { alpha: 1 }],
				["true", true],
				["1.5", 1.5],
				["2 (whole)", 2],
			],
		),
		golden(
			"Holder[keyof Holder] | Item",
			Flamework.createSerializer<Holder[keyof Holder] | Item>(),
			Flamework.createSerializer<Holder[keyof Holder] | Item>({ version: 1 }),
			[
				["1.5", 1.5],
				['""', ""],
				["Alpha", { alpha: 1 }],
				["Item", { item: "i" }],
			],
		),
		golden(
			"KindHolder[keyof KindHolder] | Alpha",
			Flamework.createSerializer<KindHolder[keyof KindHolder] | Alpha>(),
			Flamework.createSerializer<KindHolder[keyof KindHolder] | Alpha>({ version: 1 }),
			[
				['"number"', "number"],
				["Item", { item: "i" }],
				["Alpha", { alpha: 1 }],
			],
		),
	];
}

// Literal unions: `false`, `true`, `""`, `0` and the names `typeof` returns first, then numbers by
// size (each ahead of its negative), strings, TypeScript enum members, Roblox enum items.
function literalCases(): SerializerCase[] {
	return [
		golden(
			'"b" | true',
			Flamework.createSerializer<"b" | true>(),
			Flamework.createSerializer<"b" | true>({ version: 1 }),
			[
				["true", true],
				['"b"', "b"],
			],
		),
		golden(
			'false | "b"',
			Flamework.createSerializer<false | "b">(),
			Flamework.createSerializer<false | "b">({ version: 1 }),
			[
				["false", false],
				['"b"', "b"],
			],
		),
		golden(
			'true | "" | 5',
			Flamework.createSerializer<true | "" | 5>(),
			Flamework.createSerializer<true | "" | 5>({ version: 1 }),
			[
				["true", true],
				['""', ""],
				["5", 5],
			],
		),
		golden("-5 | 0", Flamework.createSerializer<-5 | 0>(), Flamework.createSerializer<-5 | 0>({ version: 1 }), [
			["0", 0],
			["-5", -5],
		]),
		golden("1 | -1", Flamework.createSerializer<1 | -1>(), Flamework.createSerializer<1 | -1>({ version: 1 }), [
			["1", 1],
			["-1", -1],
		]),
		golden(
			"-2 | 2 | 0",
			Flamework.createSerializer<-2 | 2 | 0>(),
			Flamework.createSerializer<-2 | 2 | 0>({ version: 1 }),
			[
				["0", 0],
				["2", 2],
				["-2", -2],
			],
		),
		golden(
			"300 | -5 | 12.5",
			Flamework.createSerializer<300 | -5 | 12.5>(),
			Flamework.createSerializer<300 | -5 | 12.5>({ version: 1 }),
			[
				["-5", -5],
				["12.5", 12.5],
				["300", 300],
			],
		),
		golden(
			'"zebra" | "aardvark"',
			Flamework.createSerializer<"zebra" | "aardvark">(),
			Flamework.createSerializer<"zebra" | "aardvark">({ version: 1 }),
			[
				['"aardvark"', "aardvark"],
				['"zebra"', "zebra"],
			],
		),
		golden(
			'"boolean" | "number" | "string"',
			Flamework.createSerializer<"boolean" | "number" | "string">(),
			Flamework.createSerializer<"boolean" | "number" | "string">({ version: 1 }),
			[
				['"string"', "string"],
				['"number"', "number"],
				['"boolean"', "boolean"],
			],
		),
		golden(
			'"npc" | "object" | "player"',
			Flamework.createSerializer<"npc" | "object" | "player">(),
			Flamework.createSerializer<"npc" | "object" | "player">({ version: 1 }),
			[
				['"object"', "object"],
				['"npc"', "npc"],
				['"player"', "player"],
			],
		),
		golden(
			'1 | "string"',
			Flamework.createSerializer<1 | "string">(),
			Flamework.createSerializer<1 | "string">({ version: 1 }),
			[
				['"string"', "string"],
				["1", 1],
			],
		),
		golden(
			"Enum.Material.Wood | Enum.Material.Plastic",
			Flamework.createSerializer<Enum.Material.Wood | Enum.Material.Plastic>(),
			Flamework.createSerializer<Enum.Material.Wood | Enum.Material.Plastic>({ version: 1 }),
			[
				["Plastic", Enum.Material.Plastic],
				["Wood", Enum.Material.Wood],
			],
		),
		golden(
			"Rarity.Rare | Enum.KeyCode.W",
			Flamework.createSerializer<Rarity.Rare | Enum.KeyCode.W>(),
			Flamework.createSerializer<Rarity.Rare | Enum.KeyCode.W>({ version: 1 }),
			[
				["Rarity.Rare", Rarity.Rare],
				["KeyCode.W", Enum.KeyCode.W],
			],
		),
		golden(
			"Rarity | Enum.KeyCode.W",
			Flamework.createSerializer<Rarity | Enum.KeyCode.W>(),
			Flamework.createSerializer<Rarity | Enum.KeyCode.W>({ version: 1 }),
			[
				["Rarity.Common", Rarity.Common],
				["Rarity.Epic", Rarity.Epic],
				["KeyCode.W", Enum.KeyCode.W],
				["Rarity.Rare", Rarity.Rare],
			],
		),
		golden(
			'"zeta" | 7 | EnumBeta.Y | EnumAlpha.Q | "alpha"',
			Flamework.createSerializer<"zeta" | 7 | EnumBeta.Y | EnumAlpha.Q | "alpha">(),
			Flamework.createSerializer<"zeta" | 7 | EnumBeta.Y | EnumAlpha.Q | "alpha">({ version: 1 }),
			[
				["7", 7],
				['"alpha"', "alpha"],
				['"zeta"', "zeta"],
				["EnumAlpha.Q", EnumAlpha.Q],
				["EnumBeta.Y", EnumBeta.Y],
			],
		),
		golden(
			'every rule: "zeta" | 7 | EnumBeta.X | Enum.KeyCode.W | false | 0 | "" | "number" | -7 | 300 | 12.5 | "function"',
			Flamework.createSerializer<
				"zeta" | 7 | EnumBeta.X | Enum.KeyCode.W | false | 0 | "" | "number" | -7 | 300 | 12.5 | "function"
			>(),
			Flamework.createSerializer<
				"zeta" | 7 | EnumBeta.X | Enum.KeyCode.W | false | 0 | "" | "number" | -7 | 300 | 12.5 | "function"
			>({ version: 1 }),
			[
				["false", false],
				['""', ""],
				["0", 0],
				['"number"', "number"],
				['"function"', "function"],
				["7", 7],
				["-7", -7],
				["12.5", 12.5],
				["300", 300],
				['"zeta"', "zeta"],
				["EnumBeta.X", EnumBeta.X],
				["KeyCode.W", Enum.KeyCode.W],
			],
		),
	];
}

// TypeScript enums: string, numeric, implicit, mixed, computed, several, and some members.
function enumCases(): SerializerCase[] {
	return [
		golden(
			"Rarity (string enum)",
			Flamework.createSerializer<Rarity>(),
			Flamework.createSerializer<Rarity>({ version: 1 }),
			[
				["Common", Rarity.Common],
				["Rare", Rarity.Rare],
				["Epic", Rarity.Epic],
			],
		),
		golden(
			"Level (numeric enum)",
			Flamework.createSerializer<Level>(),
			Flamework.createSerializer<Level>({ version: 1 }),
			[
				["High", Level.High],
				["Low", Level.Low],
				["Mid", Level.Mid],
			],
		),
		golden(
			"Team (implicit values)",
			Flamework.createSerializer<Team>(),
			Flamework.createSerializer<Team>({ version: 1 }),
			[
				["Red", Team.Red],
				["Blue", Team.Blue],
			],
		),
		golden(
			"Heterogeneous",
			Flamework.createSerializer<Heterogeneous>(),
			Flamework.createSerializer<Heterogeneous>({ version: 1 }),
			[
				["One", Heterogeneous.One],
				["Text", Heterogeneous.Text],
			],
		),
		golden(
			"Computed",
			Flamework.createSerializer<Computed>(),
			Flamework.createSerializer<Computed>({ version: 1 }),
			[
				["A", Computed.A],
				["B", Computed.B],
				["C (computed)", Computed.C],
				["D", Computed.D],
			],
		),
		golden("Late", Flamework.createSerializer<Late>(), Flamework.createSerializer<Late>({ version: 1 }), [
			["Z (computed)", Late.Z],
			["A", Late.A],
			["Y (computed)", Late.Y],
			["B", Late.B],
		]),
		golden(
			"Computed | string",
			Flamework.createSerializer<Computed | string>(),
			Flamework.createSerializer<Computed | string>({ version: 1 }),
			[
				["A", Computed.A],
				["C (computed)", Computed.C],
				['"s"', "s"],
			],
		),
		golden(
			"EnumAlpha | EnumBeta",
			Flamework.createSerializer<EnumAlpha | EnumBeta>(),
			Flamework.createSerializer<EnumAlpha | EnumBeta>({ version: 1 }),
			[
				["EnumAlpha.Q", EnumAlpha.Q],
				["EnumAlpha.P", EnumAlpha.P],
				["EnumBeta.Y", EnumBeta.Y],
				["EnumBeta.X", EnumBeta.X],
			],
		),
		golden(
			"Rarity.Epic | Rarity.Rare",
			Flamework.createSerializer<Rarity.Epic | Rarity.Rare>(),
			Flamework.createSerializer<Rarity.Epic | Rarity.Rare>({ version: 1 }),
			[
				["Rare", Rarity.Rare],
				["Epic", Rarity.Epic],
			],
		),
	];
}

// Roblox enums: an item as its `Value`, a u16.
function robloxEnumCases(): SerializerCase[] {
	return [
		golden(
			"Enum.Material",
			Flamework.createSerializer<Enum.Material>(),
			Flamework.createSerializer<Enum.Material>({ version: 1 }),
			[
				["Plastic", Enum.Material.Plastic],
				["Wood", Enum.Material.Wood],
			],
		),
		golden(
			"Enum.KeyCode",
			Flamework.createSerializer<Enum.KeyCode>(),
			Flamework.createSerializer<Enum.KeyCode>({ version: 1 }),
			[["W", Enum.KeyCode.W]],
		),
		golden(
			"Enum.Material | Enum.KeyCode",
			Flamework.createSerializer<Enum.Material | Enum.KeyCode>(),
			Flamework.createSerializer<Enum.Material | Enum.KeyCode>({ version: 1 }),
			[
				["Material.Wood", Enum.Material.Wood],
				["KeyCode.W", Enum.KeyCode.W],
			],
		),
		golden(
			"Enum.Material | string",
			Flamework.createSerializer<Enum.Material | string>(),
			Flamework.createSerializer<Enum.Material | string>({ version: 1 }),
			[
				["Material.Plastic", Enum.Material.Plastic],
				['"s"', "s"],
			],
		),
	];
}

// Mapped types: a homomorphic one keeps its type's order, the others go by their keys, sorted.
function mappedCases(): SerializerCase[] {
	return [
		golden(
			"Partial<Zoo>",
			Flamework.createSerializer<Partial<Zoo>>(),
			Flamework.createSerializer<Partial<Zoo>>({ version: 1 }),
			[
				["empty", {}],
				["full", fullZoo],
			],
		),
		golden(
			"Readonly<Zoo>",
			Flamework.createSerializer<Readonly<Zoo>>(),
			Flamework.createSerializer<Readonly<Zoo>>({ version: 1 }),
			[["full", fullZoo]],
		),
		golden(
			"Required<Patch<Zoo>>",
			Flamework.createSerializer<Required<Patch<Zoo>>>(),
			Flamework.createSerializer<Required<Patch<Zoo>>>({ version: 1 }),
			[["full", fullZoo]],
		),
		golden(
			"{ [P in keyof Zoo]: Zoo[P] }",
			Flamework.createSerializer<{ [P in keyof Zoo]: Zoo[P] }>(),
			Flamework.createSerializer<{ [P in keyof Zoo]: Zoo[P] }>({ version: 1 }),
			[["full", fullZoo]],
		),
		golden(
			"Partial<Zoo & Extra>",
			Flamework.createSerializer<Partial<Zoo & Extra>>(),
			Flamework.createSerializer<Partial<Zoo & Extra>>({ version: 1 }),
			[["full", { ...fullZoo, extra: 2 }]],
		),
		golden(
			"Record<Rarity, number>",
			Flamework.createSerializer<Record<Rarity, number>>(),
			Flamework.createSerializer<Record<Rarity, number>>({ version: 1 }),
			[["1, 2, 3", { [Rarity.Common]: 1, [Rarity.Rare]: 2, [Rarity.Epic]: 3 }]],
		),
		golden(
			"Partial<Record<Level, string>>",
			Flamework.createSerializer<Partial<Record<Level, string>>>(),
			Flamework.createSerializer<Partial<Record<Level, string>>>({ version: 1 }),
			[
				["empty", {}],
				["High", { [Level.High]: "h" }],
			],
		),
		golden(
			'Record<"speed" | "power", number>',
			Flamework.createSerializer<Record<"speed" | "power", number>>(),
			Flamework.createSerializer<Record<"speed" | "power", number>>({ version: 1 }),
			[["1, 2", { speed: 1, power: 2 }]],
		),
		golden(
			'{ [K in "b" | "a"]: boolean }',
			Flamework.createSerializer<{ [K in "b" | "a"]: boolean }>(),
			Flamework.createSerializer<{ [K in "b" | "a"]: boolean }>({ version: 1 }),
			[["b true", { b: true, a: false }]],
		),
		golden(
			'Pick<Zoo, "zebra" | "aardvark">',
			Flamework.createSerializer<Pick<Zoo, "zebra" | "aardvark">>(),
			Flamework.createSerializer<Pick<Zoo, "zebra" | "aardvark">>({ version: 1 }),
			[["picked", { zebra: 1, aardvark: "a" }]],
		),
		golden(
			'Omit<Zoo, "aardvark">',
			Flamework.createSerializer<Omit<Zoo, "aardvark">>(),
			Flamework.createSerializer<Omit<Zoo, "aardvark">>({ version: 1 }),
			[["rest", { zebra: 1, mole: true }]],
		),
		golden(
			"Record<10 | 2 | 1, string>",
			Flamework.createSerializer<Record<10 | 2 | 1, string>>(),
			Flamework.createSerializer<Record<10 | 2 | 1, string>>({ version: 1 }),
			[["a, b, c", { 10: "a", 2: "b", 1: "c" }]],
		),
		golden(
			"Record<1 | -1, string>",
			Flamework.createSerializer<Record<1 | -1, string>>(),
			Flamework.createSerializer<Record<1 | -1, string>>({ version: 1 }),
			[["p, n", { 1: "p", [-1]: "n" }]],
		),
		golden(
			'Record<"" | 5, string>',
			Flamework.createSerializer<Record<"" | 5, string>>(),
			Flamework.createSerializer<Record<"" | 5, string>>({ version: 1 }),
			[["e, f", { [""]: "e", 5: "f" }]],
		),
		golden(
			'Record<"number" | "string", number>',
			Flamework.createSerializer<Record<"number" | "string", number>>(),
			Flamework.createSerializer<Record<"number" | "string", number>>({ version: 1 }),
			[["1, 2", { number: 1, string: 2 }]],
		),
		golden(
			'Extra & Record<"qq" | "cc", number>',
			Flamework.createSerializer<Extra & Record<"qq" | "cc", number>>(),
			Flamework.createSerializer<Extra & Record<"qq" | "cc", number>>({ version: 1 }),
			[["1, 2, 3", { extra: 1, qq: 2, cc: 3 }]],
		),
		golden(
			'Inherits (extends Record<"kk" | "dd", number>)',
			Flamework.createSerializer<Inherits>(),
			Flamework.createSerializer<Inherits>({ version: 1 }),
			[["o, 1, 2", { own: "o", kk: 1, dd: 2 }]],
		),
	];
}

// Roblox datatypes with a layout of their own, NaN, the infinities and -0 inside the float ones.
function datatypeCases(): SerializerCase[] {
	return [
		golden("Vector3", Flamework.createSerializer<Vector3>(), Flamework.createSerializer<Vector3>({ version: 1 }), [
			["zero", Vector3.zero],
			["1.5, -2, 1e10", new Vector3(1.5, -2, 1e10)],
			["NaN, inf, -inf", new Vector3(NAN, math.huge, -math.huge)],
			["-0, 0, -0", new Vector3(NEGATIVE_ZERO, 0, NEGATIVE_ZERO)],
		]),
		golden("Vector2", Flamework.createSerializer<Vector2>(), Flamework.createSerializer<Vector2>({ version: 1 }), [
			["0.5, -0.25", new Vector2(0.5, -0.25)],
		]),
		golden(
			"Vector3int16",
			Flamework.createSerializer<Vector3int16>(),
			Flamework.createSerializer<Vector3int16>({ version: 1 }),
			[["min, 0, max", new Vector3int16(-32768, 0, 32767)]],
		),
		golden(
			"Vector2int16",
			Flamework.createSerializer<Vector2int16>(),
			Flamework.createSerializer<Vector2int16>({ version: 1 }),
			[["-1, 1", new Vector2int16(-1, 1)]],
		),
		golden("Color3", Flamework.createSerializer<Color3>(), Flamework.createSerializer<Color3>({ version: 1 }), [
			["black", new Color3(0, 0, 0)],
			["fromRGB(255, 128, 0)", Color3.fromRGB(255, 128, 0)],
			["NaN, inf, -0", new Color3(NAN, math.huge, NEGATIVE_ZERO)],
			["-inf, -0, 0", new Color3(-math.huge, NEGATIVE_ZERO, 0)],
		]),
		golden("UDim", Flamework.createSerializer<UDim>(), Flamework.createSerializer<UDim>({ version: 1 }), [
			["0.25, -5", new UDim(0.25, -5)],
		]),
		golden("UDim2", Flamework.createSerializer<UDim2>(), Flamework.createSerializer<UDim2>({ version: 1 }), [
			["0.5, 10, 1, -20", new UDim2(0.5, 10, 1, -20)],
			["scales NaN and -0", new UDim2(NAN, 1, NEGATIVE_ZERO, 2)],
			["scales inf and -inf", new UDim2(math.huge, 3, -math.huge, 4)],
		]),
		golden(
			"NumberRange",
			Flamework.createSerializer<NumberRange>(),
			Flamework.createSerializer<NumberRange>({ version: 1 }),
			[["1, 2", new NumberRange(1, 2)]],
		),
		golden("Rect", Flamework.createSerializer<Rect>(), Flamework.createSerializer<Rect>({ version: 1 }), [
			["0, 1, 2, 3", new Rect(0, 1, 2, 3)],
		]),
		golden(
			"BrickColor",
			Flamework.createSerializer<BrickColor>(),
			Flamework.createSerializer<BrickColor>({ version: 1 }),
			[["21", new BrickColor(21)]],
		),
		golden("CFrame", Flamework.createSerializer<CFrame>(), Flamework.createSerializer<CFrame>({ version: 1 }), [
			["identity", CFrame.identity],
			["1, 2, 3 turned about Y", new CFrame(1, 2, 3, 0, 0, 1, 0, 1, 0, -1, 0, 0)],
			["at NaN, inf, -0", new CFrame(NAN, math.huge, NEGATIVE_ZERO)],
			["at -inf, -0, 0", new CFrame(-math.huge, NEGATIVE_ZERO, 0)],
		]),
		golden(
			"Vector3 | CFrame",
			Flamework.createSerializer<Vector3 | CFrame>(),
			Flamework.createSerializer<Vector3 | CFrame>({ version: 1 }),
			[
				["Vector3", new Vector3(1, 2, 3)],
				["CFrame", new CFrame(4, 5, 6)],
			],
		),
	];
}

// Values that travel as blobs: Instances, `unknown`, `object`, classes.
function blobCases(): SerializerCase[] {
	return [
		golden(
			"Instance",
			Flamework.createSerializer<Instance>(),
			Flamework.createSerializer<Instance>({ version: 1 }),
			[["Folder", FOLDER]],
		),
		golden("Part", Flamework.createSerializer<Part>(), Flamework.createSerializer<Part>({ version: 1 }), [
			["Part", PART as Part],
		]),
		golden(
			"Instance | undefined",
			Flamework.createSerializer<Instance | undefined>(),
			Flamework.createSerializer<Instance | undefined>({ version: 1 }),
			[
				["Folder", FOLDER],
				["undefined", undefined],
			],
		),
		golden(
			"Instance[]",
			Flamework.createSerializer<Instance[]>(),
			Flamework.createSerializer<Instance[]>({ version: 1 }),
			[["Folder, Part", [FOLDER, PART]]],
		),
		golden("unknown", Flamework.createSerializer<unknown>(), Flamework.createSerializer<unknown>({ version: 1 }), [
			["1", 1],
			['"x"', "x"],
			["true", true],
			["a table", TABLE_BLOB],
			["undefined", undefined],
		]),
		golden("object", Flamework.createSerializer<object>(), Flamework.createSerializer<object>({ version: 1 }), [
			["a table", TABLE_BLOB],
		]),
		golden(
			"{ target: Instance; anything: unknown; label: string }",
			Flamework.createSerializer<{ target: Instance; anything: unknown; label: string }>(),
			Flamework.createSerializer<{ target: Instance; anything: unknown; label: string }>({ version: 1 }),
			[
				["filled", { target: PART, anything: TABLE_BLOB, label: "l" }],
				["nil anything", { target: FOLDER, anything: undefined, label: "" }],
			],
		),
	];
}

// Versioned serializers: the version, the layout hash, then the bytes the type's own case writes.
function versionedCases(): SerializerCase[] {
	return [
		versionedGolden(
			"Serialization.u8 { version: 0 }",
			Flamework.createSerializer<Serialization.u8>({ version: 0 }),
			whole(0, 255),
		),
		versionedGolden("Profile { version: 3 }", Flamework.createSerializer<Profile>({ version: 3 }), [
			[
				"with nickname",
				{
					id: 65535 as Serialization.u16,
					name: "" as Serialization.string8,
					where: { x: 0.25, y: -8 },
					tags: ["a", "bc"],
					nickname: "nick",
					alive: false,
					kind: "profile",
				},
			],
		]),
		versionedGolden("string[] { version: 255 }", Flamework.createSerializer<string[]>({ version: 255 }), [
			['"", "a"', ["", "a"]],
		]),
		// Nothing to write: the header alone.
		versionedGolden("[] { version: 1 }", Flamework.createSerializer<[]>({ version: 1 }), [["empty", []]]),
		versionedGolden(
			"{ target: Instance; anything: unknown; label: string } { version: 7 }",
			Flamework.createSerializer<{ target: Instance; anything: unknown; label: string }>({ version: 7 }),
			[["filled", { target: PART, anything: TABLE_BLOB, label: "l" }]],
		),
	];
}

/**
 * Built by function, a group each: Luau allows a function 200 locals, and roblox-ts takes one
 * for each element ahead of one that needs statements of its own (a `Map` built from entries).
 */
export const serializerCases: SerializerCase[] = [
	...numberCases(),
	...textCases(),
	...objectCases(),
	...collectionCases(),
	...writtenUnionCases(),
	...unwrittenUnionCases(),
	...memberUnionCases(),
	...indexedUnionCases(),
	...literalCases(),
	...enumCases(),
	...robloxEnumCases(),
	...mappedCases(),
	...datatypeCases(),
	...blobCases(),
	...versionedCases(),
];

// --- networking -----------------------------------------------------------------------------------

interface Stack {
	id: Serialization.u16;
	name: string;
	count: Serialization.u8;
}

/** Declared the same in both directions, so each realm sends and receives every member. */
interface GoldenEvents {
	goldenMove: Networking.SerializedReliable<
		(position: Vector3, speed: Serialization.u8, mode: "walk" | "run") => void
	>;
	goldenChat: Networking.SerializedReliable<(text: string, target?: Instance) => void>;
	goldenInventory: Networking.SerializedReliable<(stacks: Stack[], counts: Map<string, number>) => void>;
	goldenPing: Networking.SerializedReliable<() => void>;
	goldenRest: Networking.SerializedReliable<(...args: [number, ...string[]]) => void>;
	goldenTick: Networking.SerializedUnreliable<(frame: Serialization.u32, value: number | string) => void>;
	/** A plain member: packed only with networking.serialization on. */
	goldenPlain(position: Vector3, speed: Serialization.u8, mode: "walk" | "run"): void;
	/** A raw member: never packed. */
	goldenRaw: Networking.RawReliable<(value: number, text: string) => void>;
}

interface GoldenFunctions {
	goldenLookup: Networking.Serialized<(ids: number[]) => Stack[]>;
	goldenFind: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
	/** A plain member: packed only with networking.serialization on. */
	goldenPlainLookup(ids: number[]): Stack[];
}

const GoldenNetwork = Networking.createEvent<GoldenEvents, GoldenEvents>();
const GoldenCalls = Networking.createFunction<GoldenFunctions, GoldenFunctions>();

interface Recorded {
	kind: string;
	player?: Instance;
	args: Array<unknown> & { readonly n: number };
}

declare const __harness: {
	sent: (remote: Instance) => Array<Recorded>;
	clearSent: (remote: Instance) => void;
	findRemote: (name: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

/**
 * A plain member's decoder, `undefined` when the project leaves `networking.serialization` off.
 * @metadata macro
 */
function wireDecoder<T extends unknown[]>(
	meta?: Modding.Intrinsic<"network-decoder", [T], Serialization.Decoder<T> | undefined>,
): Serialization.Decoder<T> | undefined {
	return meta;
}

/** Whether plain members are packed in this build. */
export const plainPacked = wireDecoder<[number]>() !== undefined;

const isServer = RunService.IsServer();

type ServerEvents = ReturnType<typeof GoldenNetwork.createServer>;
type ClientEvents = ReturnType<typeof GoldenNetwork.createClient>;
type ServerCalls = ReturnType<typeof GoldenCalls.createServer>;
type ClientCalls = ReturnType<typeof GoldenCalls.createClient>;

interface Handlers {
	player: Player;
	server?: { events: ServerEvents; calls: ServerCalls };
	client?: { events: ClientEvents; calls: ClientCalls };
}

let handlers: Handlers | undefined;

/** What each member's handler or callback was last handed. */
const received = new Map<string, unknown[]>();
/** What each function's callback answers. */
const answers = new Map<string, unknown>();

function record(member: string) {
	return (...args: unknown[]) => {
		received.set(member, args);
	};
}

function answer(member: string) {
	return (...args: unknown[]) => {
		received.set(member, args);
		return answers.get(member);
	};
}

/** This realm's handlers, made on first use. Remotes are the server's to create, so a client primes them first. */
function realm(): Handlers {
	if (handlers !== undefined) return handlers;

	const player = __harness.newPlayer("GoldenPacker") as Player;
	// A request delivered on its own is answered with these, which pack.
	answers.set("goldenLookup", []);
	answers.set("goldenPlainLookup", []);
	if (isServer) {
		const events = GoldenNetwork.createServer({});
		const calls = GoldenCalls.createServer({});
		events.goldenMove.connect((_player, ...args) => record("goldenMove")(...args));
		events.goldenChat.connect((_player, ...args) => record("goldenChat")(...args));
		events.goldenInventory.connect((_player, ...args) => record("goldenInventory")(...args));
		events.goldenPing.connect((_player, ...args) => record("goldenPing")(...args));
		events.goldenRest.connect((_player, ...args) => record("goldenRest")(...args));
		events.goldenTick.connect((_player, ...args) => record("goldenTick")(...args));
		events.goldenPlain.connect((_player, ...args) => record("goldenPlain")(...args));
		calls.goldenLookup.setCallback((_player, ids) => answer("goldenLookup")(ids) as Stack[]);
		calls.goldenFind.setCallback(
			(_player, label, where) => answer("goldenFind")(label, where) as Instance | undefined,
		);
		calls.goldenPlainLookup.setCallback((_player, ids) => answer("goldenPlainLookup")(ids) as Stack[]);
		handlers = { player, server: { events, calls } };
	} else {
		__harness.asRealm("Server", () => {
			GoldenNetwork.createServer({});
			GoldenCalls.createServer({});
			__harness.flush();
		});
		const events = GoldenNetwork.createClient({});
		const calls = GoldenCalls.createClient({});
		events.goldenMove.connect((...args) => record("goldenMove")(...args));
		events.goldenChat.connect((...args) => record("goldenChat")(...args));
		events.goldenInventory.connect((...args) => record("goldenInventory")(...args));
		events.goldenPing.connect((...args) => record("goldenPing")(...args));
		events.goldenRest.connect((...args) => record("goldenRest")(...args));
		events.goldenTick.connect((...args) => record("goldenTick")(...args));
		events.goldenPlain.connect((...args) => record("goldenPlain")(...args));
		calls.goldenLookup.setCallback((ids) => answer("goldenLookup")(ids) as Stack[]);
		calls.goldenFind.setCallback((label, where) => answer("goldenFind")(label, where) as Instance | undefined);
		calls.goldenPlainLookup.setCallback((ids) => answer("goldenPlainLookup")(ids) as Stack[]);
		handlers = { player, client: { events, calls } };
	}

	__harness.flush();
	return handlers;
}

function remote(name: string): Instance {
	const found = __harness.findRemote(name) ?? __harness.findRemoteById(name);
	if (found === undefined) throw `no remote '${name}'`;
	return found;
}

/** A function's two channels: this realm sends its requests on one and answers the other's on the other. */
function channels(member: string) {
	return {
		send: remote(`${isServer ? "@" : "$"}${member}`),
		receive: remote(`${isServer ? "$" : "@"}${member}`),
	};
}

/** The arguments the remote carried in its last message, from the `from`th on (1-based). */
function lastSent(channel: Instance, from = 1): unknown[] {
	const messages = __harness.sent(channel);
	if (messages.size() === 0) throw `nothing was sent on ${channel.Name}`;
	const { args } = messages[messages.size() - 1];
	const result = new Array<unknown>();
	for (const index of $range(from, args.n)) result[index - from] = args[index - 1];
	return result;
}

/** Delivers a message as the other realm would, adding the sender on the server. */
function deliver(channel: Instance, args: unknown[]) {
	const signals = channel as unknown as {
		OnServerEvent: { Fire(this: unknown, ...args: unknown[]): void };
		OnClientEvent: { Fire(this: unknown, ...args: unknown[]): void };
	};
	if (isServer) signals.OnServerEvent.Fire(realm().player, ...args);
	else signals.OnClientEvent.Fire(...args);
}

/** What an event's receiver was handed for a delivered message. */
function receiveEvent(member: string, channel: string, args: unknown[]): unknown[] {
	received.delete(member);
	deliver(remote(channel), args);
	const got = received.get(member);
	if (got === undefined) throw `${member}'s handler was not called`;
	return got;
}

export interface NetworkCase {
	/** The member and what is sent, which name a golden line. */
	readonly member: string;
	readonly label: string;
	/** A plain member's, which is packed only with networking.serialization on. */
	readonly plain?: boolean;
	/** Sends the sample and returns what the remote carried: past a function's request id and status. */
	readonly send: () => unknown[];
	/** Delivers that as the other realm would and returns what the receiving end was handed. */
	readonly receive?: (args: unknown[]) => unknown[];
	/** What `receive` must give back. */
	readonly expected: unknown[];
}

/** An event's argument list, sent through `fire` (the server's to its player). */
function event(
	member: string,
	label: string,
	channel: string,
	expected: unknown[],
	fire: (realm: Handlers) => void,
	plain = false,
): NetworkCase {
	return {
		member,
		label,
		plain,
		expected,
		send: () => {
			const handlers = realm();
			__harness.clearSent(remote(channel));
			fire(handlers);
			return lastSent(remote(channel));
		},
		receive: (args) => receiveEvent(member, channel, args),
	};
}

type Invoke = (handlers: Handlers) => Promise<unknown>;

/** A function's request: what `invoke` sends, and what the callback is handed for it. */
function request(member: string, label: string, expected: unknown[], invoke: Invoke, plain = false): NetworkCase {
	return {
		member: `${member} request`,
		label,
		plain,
		expected,
		send: () => {
			const handlers = realm();
			const { send } = channels(member);
			__harness.clearSent(send);
			const pending = invoke(handlers);
			const args = lastSent(send, 2);
			pending.cancel();
			return args;
		},
		receive: (args) => {
			realm();
			received.delete(member);
			deliver(channels(member).receive, [1, ...args]);
			const got = received.get(member);
			if (got === undefined) throw `${member}'s callback was not called`;
			return got;
		},
	};
}

/** A function's result: what the callback's answer is sent as, and what `invoke` resolves with for it. */
function result(member: string, label: string, value: unknown, invoke: Invoke, plain = false): NetworkCase {
	return {
		member: `${member} result`,
		label,
		plain,
		expected: [value],
		send: () => {
			const handlers = realm();
			const { send, receive } = channels(member);
			// A request as this realm packs it, answered by the callback as the other realm would be.
			__harness.clearSent(send);
			invoke(handlers).cancel();
			const requestArgs = lastSent(send, 2);
			answers.set(member, value);
			__harness.clearSent(receive);
			deliver(receive, [1, ...requestArgs]);
			const answered = lastSent(receive);
			if (answered[1] !== true) throw `${member}'s callback failed: ${tostring(answered[2])}`;
			return lastSent(receive, 3);
		},
		receive: (args) => {
			const handlers = realm();
			const { send } = channels(member);
			__harness.clearSent(send);
			const pending = invoke(handlers);
			const id = lastSent(send)[0];
			deliver(send, [id, true, ...args]);
			const [ok, resolved] = pending.timeout(1).await();
			if (!ok) throw `${member}'s invoke did not resolve: ${tostring(resolved)}`;
			return [resolved];
		},
	};
}

const STACKS: Stack[] = [
	{ id: 1 as Serialization.u16, name: "sword", count: 1 as Serialization.u8 },
	{ id: 65535 as Serialization.u16, name: "", count: 255 as Serialization.u8 },
];

export const networkCases: NetworkCase[] = [
	event("goldenMove", "1, 2, 3 at 16, walking", "goldenMove", [new Vector3(1, 2, 3), 16, "walk"], (h) =>
		h.server
			? h.server.events.goldenMove.fire(h.player, new Vector3(1, 2, 3), 16 as Serialization.u8, "walk")
			: h.client!.events.goldenMove.fire(new Vector3(1, 2, 3), 16 as Serialization.u8, "walk"),
	),
	event("goldenMove", "zero at 255, running", "goldenMove", [Vector3.zero, 255, "run"], (h) =>
		h.server
			? h.server.events.goldenMove.fire(h.player, Vector3.zero, 255 as Serialization.u8, "run")
			: h.client!.events.goldenMove.fire(Vector3.zero, 255 as Serialization.u8, "run"),
	),
	event("goldenChat", '"hi", no target', "goldenChat", ["hi"], (h) =>
		h.server ? h.server.events.goldenChat.fire(h.player, "hi") : h.client!.events.goldenChat.fire("hi"),
	),
	event("goldenChat", '"", Folder', "goldenChat", ["", FOLDER], (h) =>
		h.server ? h.server.events.goldenChat.fire(h.player, "", FOLDER) : h.client!.events.goldenChat.fire("", FOLDER),
	),
	event("goldenInventory", "empty", "goldenInventory", [[], new Map()], (h) =>
		h.server
			? h.server.events.goldenInventory.fire(h.player, [], new Map())
			: h.client!.events.goldenInventory.fire([], new Map()),
	),
	event("goldenInventory", 'two stacks, "gold" -> 3', "goldenInventory", [STACKS, new Map([["gold", 3]])], (h) =>
		h.server
			? h.server.events.goldenInventory.fire(h.player, STACKS, new Map([["gold", 3]]))
			: h.client!.events.goldenInventory.fire(STACKS, new Map([["gold", 3]])),
	),
	event("goldenPing", "no arguments", "goldenPing", [], (h) =>
		h.server ? h.server.events.goldenPing.fire(h.player) : h.client!.events.goldenPing.fire(),
	),
	event("goldenRest", "1", "goldenRest", [1], (h) =>
		h.server ? h.server.events.goldenRest.fire(h.player, 1) : h.client!.events.goldenRest.fire(1),
	),
	event("goldenRest", '2, "a", "b"', "goldenRest", [2, "a", "b"], (h) =>
		h.server
			? h.server.events.goldenRest.fire(h.player, 2, "a", "b")
			: h.client!.events.goldenRest.fire(2, "a", "b"),
	),
	event("goldenTick", '4294967295, "x"', "unreliable:goldenTick", [4294967295, "x"], (h) =>
		h.server
			? h.server.events.goldenTick.fire(h.player, 4294967295 as Serialization.u32, "x")
			: h.client!.events.goldenTick.fire(4294967295 as Serialization.u32, "x"),
	),
	event("goldenTick", "0, 7 (whole)", "unreliable:goldenTick", [0, 7], (h) =>
		h.server
			? h.server.events.goldenTick.fire(h.player, 0 as Serialization.u32, 7)
			: h.client!.events.goldenTick.fire(0 as Serialization.u32, 7),
	),
	event(
		"goldenPlain",
		"1, 2, 3 at 16, walking",
		"goldenPlain",
		[new Vector3(1, 2, 3), 16, "walk"],
		(h) =>
			h.server
				? h.server.events.goldenPlain.fire(h.player, new Vector3(1, 2, 3), 16 as Serialization.u8, "walk")
				: h.client!.events.goldenPlain.fire(new Vector3(1, 2, 3), 16 as Serialization.u8, "walk"),
		true,
	),
	{
		member: "goldenRaw",
		label: '7, "seven"',
		expected: [7, "seven"],
		send: () => {
			const h = realm();
			__harness.clearSent(remote("goldenRaw"));
			if (h.server) h.server.events.goldenRaw.fire(h.player, 7, "seven");
			else h.client!.events.goldenRaw.fire(7, "seven");
			return lastSent(remote("goldenRaw"));
		},
	},
	request("goldenLookup", "[1, 2, 3]", [[1, 2, 3]], (h) =>
		h.server
			? h.server.calls.goldenLookup.invoke(h.player, [1, 2, 3])
			: h.client!.calls.goldenLookup.invoke([1, 2, 3]),
	),
	result("goldenLookup", "two stacks", STACKS, (h) =>
		h.server ? h.server.calls.goldenLookup.invoke(h.player, [1]) : h.client!.calls.goldenLookup.invoke([1]),
	),
	result("goldenLookup", "no stacks", [], (h) =>
		h.server ? h.server.calls.goldenLookup.invoke(h.player, []) : h.client!.calls.goldenLookup.invoke([]),
	),
	request("goldenFind", '"a", no place', ["a"], (h) =>
		h.server ? h.server.calls.goldenFind.invoke(h.player, "a") : h.client!.calls.goldenFind.invoke("a"),
	),
	request("goldenFind", '"b", Part', ["b", PART], (h) =>
		h.server ? h.server.calls.goldenFind.invoke(h.player, "b", PART) : h.client!.calls.goldenFind.invoke("b", PART),
	),
	result("goldenFind", "Folder", FOLDER, (h) =>
		h.server ? h.server.calls.goldenFind.invoke(h.player, "c") : h.client!.calls.goldenFind.invoke("c"),
	),
	result("goldenFind", "undefined", undefined, (h) =>
		h.server ? h.server.calls.goldenFind.invoke(h.player, "d") : h.client!.calls.goldenFind.invoke("d"),
	),
	request(
		"goldenPlainLookup",
		"[1, 2, 3]",
		[[1, 2, 3]],
		(h) =>
			h.server
				? h.server.calls.goldenPlainLookup.invoke(h.player, [1, 2, 3])
				: h.client!.calls.goldenPlainLookup.invoke([1, 2, 3]),
		true,
	),
	result(
		"goldenPlainLookup",
		"two stacks",
		STACKS,
		(h) =>
			h.server
				? h.server.calls.goldenPlainLookup.invoke(h.player, [1])
				: h.client!.calls.goldenPlainLookup.invoke([1]),
		true,
	),
];
