import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileFixtureFresh, compileProbes, type CompileResult } from "./compile";

/*
 * What the serializer's generated code does at a call site that is not its own: the values keep the
 * types the caller declared them with, the caller's declarations are in scope around the code, and the
 * names it gives its locals come from types declared anywhere in the project. These shapes are the
 * ones an outside project ran into with the published packages; the types live in a file of their own,
 * as a game's shared module would, because a name the calling file already uses is renamed for us.
 */

/**
 * Field names no generated local can have: JavaScript's reserved words and strict mode's, Luau's
 * keywords, the globals roblox-ts reserves, a leading digit, nothing at all, a space.
 */
const RESERVED_NAMES = [
	"arguments",
	"eval",
	"class",
	"let",
	"static",
	"yield",
	"await",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"enum",
	"function",
	"delete",
	"typeof",
	"end",
	"local",
	"then",
	"nil",
	"repeat",
	"until",
	"elseif",
	"not",
	"and",
	"or",
	"self",
	"type",
	"game",
	"string",
	"table",
	"1st",
	"",
	"two words",
];

/** Each a one-element tuple next to a string, so it is read back into a local named after its field. */
function RESERVED_FIELDS() {
	return RESERVED_NAMES.map((name) => `\t${JSON.stringify(name)}: [value: number];`).join("\n");
}

/** A game's shared module: the types and the networks, declared where the call sites cannot rename them. */
const SHARED = `import { Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

export type GridCoord = readonly [x: Serialization.i16, y: Serialization.i16, z: Serialization.i16];
/** The mutable twin, which writes exactly the same bytes. */
export type MutableCoord = [x: Serialization.i16, y: Serialization.i16, z: Serialization.i16];

export interface Placement {
	origin: GridCoord;
	rotation: number;
	name: string;
	templateId: number;
}

export interface MutablePlacement {
	origin: MutableCoord;
	rotation: number;
	name: string;
	templateId: number;
}

interface CoordEvents {
	place(origin: GridCoord, rotation: number): void;
	placeNested(data: Placement): void;
	placeRest(...origins: GridCoord[]): void;
	placeOpt(origin: GridCoord | undefined): void;
	placeOr(origin: GridCoord | string): void;
	indexSig(value: { [k: string]: number }): void;
	serializedPlace: Networking.Serialized<(origin: GridCoord) => void>;
}

interface MutableCoordEvents {
	place(origin: MutableCoord, rotation: number): void;
	placeNested(data: MutablePlacement): void;
	placeRest(...origins: MutableCoord[]): void;
	placeOpt(origin: MutableCoord | undefined): void;
	placeOr(origin: MutableCoord | string): void;
	indexSig(value: Map<string, number>): void;
	serializedPlace: Networking.Serialized<(origin: MutableCoord) => void>;
}

interface CoordFunctions {
	ask(origin: GridCoord): GridCoord;
}

interface MutableCoordFunctions {
	ask(origin: MutableCoord): MutableCoord;
}

export const CoordNetwork = Networking.createEvent<CoordEvents, {}>();
export const MutableCoordNetwork = Networking.createEvent<MutableCoordEvents, {}>();
export const CoordFunctionNetwork = Networking.createFunction<CoordFunctions, {}>();
export const MutableCoordFunctionNetwork = Networking.createFunction<MutableCoordFunctions, {}>();

/** A library's action type (Reflex broadcasts one with an \`arguments\` tuple), and every name a local cannot take. */
export interface Action {
	name: string;
	arguments: [value: number];
}

export interface Reserved {
	name: string;
${RESERVED_FIELDS()}
}

export type SerializedData = { buffer: buffer; blobs: defined[] };

interface EcsEvents {
	SendReliable(data: SerializedData): void;
}

interface ActionEvents {
	dispatch(action: Action): void;
	reserved(data: Reserved): void;
}

export const EcsNetwork = Networking.createEvent<{}, EcsEvents>();
export const ActionNetwork = Networking.createEvent<ActionEvents, {}>();
`;

/** A caller of the shared module, with its arguments typed `Coord` (readonly or not). */
function coordCaller(network: string, functions: string, coord: string, placement: string, index: string) {
	return `import { ${network}, ${functions}, ${coord}, ${placement} } from "./genShared";

const client = ${network}.createClient({});
const functions = ${functions}.createClient({});

export function place(origin: ${coord}, data: ${placement}, list: ${coord}[], value: ${index}) {
	client.place.fire(origin, 0);
	client.placeNested.fire(data);
	client.placeNested.fire({ origin, rotation: 1, name: "a", templateId: 2 });
	client.placeRest.fire(origin, origin);
	client.placeRest.fire(...list);
	client.placeOpt.fire(origin);
	client.placeOr.fire(origin);
	client.indexSig.fire(value);
	client.serializedPlace.fire(origin);
	return functions.ask.invoke(origin);
}
`;
}

/** The ECS replication loop an outside project sends with, exactly: its locals are named \`buffer\`. */
const ECS = `import { EcsNetwork } from "./genShared";

type Packet = LuaTuple<[Player, buffer, defined[] | undefined]>;
declare const replicator: { collect_updates(): IterableFunction<Packet>; get_full(player: Player): LuaTuple<[buffer, defined[] | undefined]> };

export function replicate() {
	const server = EcsNetwork.createServer({});
	for (const [player, buffer, blobs] of replicator.collect_updates()) {
		server.SendReliable.fire(player, { buffer, blobs: blobs ?? [] });
	}
}
`;

/** Types of the project's own named like the ones the generated code once named: no longer in its way. */
const OWN_TYPES = `import { Networking } from "@flamework-experimental/networking";

type Record = { id: number };
type Callback = () => void;
type Array = { length: number };

interface Item {
	name: string;
	count: number;
}

interface OwnEvents {
	send(item: Item, other: Item): void;
}

const client = Networking.createEvent<OwnEvents, {}>().createClient({});

export function send(item: Item, record: Record, callback: Callback, array: Array) {
	client.send.fire(item, item);
	return [record, callback, array];
}
`;

/** A local named \`warn\` hides it from the call site only: the check helper that calls it is at the top of the file. */
const LOCAL_WARN = `import { Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

interface WarnEvents {
	send(value: Serialization.Implicit.u16): void;
}

const client = Networking.createEvent<WarnEvents, {}>().createClient({});

export function send(value: number, warn: (message: string) => void) {
	client.send.fire(value);
	warn("sent");
}
`;

const RESERVED = `import { Flamework } from "@flamework-experimental/core";
import { ActionNetwork, Action, Reserved } from "./genShared";

const client = ActionNetwork.createClient({});

export function dispatch(action: Action, data: Reserved) {
	client.dispatch.fire(action);
	client.reserved.fire(data);
}

export const actionSerializer = Flamework.createSerializer<Action>();
export const reservedSerializer = Flamework.createSerializer<Reserved>();
`;

/** A type of the project's named \`Map\`, in a module of its own, where it hides nothing. */
const DEDUP_TYPES = `export interface Map {
	x: number;
}

export interface Holder {
	a: Map;
	b: Map;
	c: Map;
}
`;

/** A guard deduplicated into a local named after the type, which here is \`Map\`: it must not hide the global. */
const DEDUP = `import { Flamework } from "@flamework-experimental/core";
import { Holder } from "./genDedupTypes";

export const holderGuard = Flamework.createGuard<Holder>();
export const lookup = new Map<string, number>();
`;

/** Arrays with a hole, and the element types that can and cannot write one. */
const HOLES = `import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

interface HoleEvents {
	blobs(values: defined[]): void;
	numbers(values: Serialization.u16[]): void;
	names(values: string[]): void;
	optional(values: Array<Serialization.u16 | undefined>): void;
	anything(values: unknown[]): void;
	tagged(entry: [string, ...number[]]): void;
}

const client = Networking.createEvent<HoleEvents, {}>().createClient({});

export function send(
	values: defined[],
	numbers: Serialization.u16[],
	names: string[],
	optional: Array<Serialization.u16 | undefined>,
	anything: unknown[],
	entry: [string, ...number[]],
) {
	client.blobs.fire(values);
	client.numbers.fire(numbers);
	client.names.fire(names);
	client.optional.fire(optional);
	client.anything.fire(anything);
	client.tagged.fire(entry);
}

export const namesSerializer = Flamework.createSerializer<string[]>();
`;

/** Array rest parameters: \`Parameters<F>\` is an array there, not a tuple. */
const REST = `import { Networking } from "@flamework-experimental/networking";

interface RestEvents {
	many(...values: number[]): void;
	names(...values: string[]): void;
	serializedMany: Networking.Serialized<(...values: number[]) => void>;
}

interface RestFunctions {
	sum(...values: number[]): number;
}

const events = Networking.createEvent<RestEvents, {}>();
const functions = Networking.createFunction<RestFunctions, {}>();
const client = events.createClient({});
const clientFunctions = functions.createClient({});

export function send(values: number[]) {
	client.many.fire();
	client.many.fire(1);
	client.many.fire(1, 2, 3);
	client.many.fire(...values);
	client.names.fire("a", "b");
	client.serializedMany.fire(4, 5);
	return clientFunctions.sum.invoke(1, 2, 3);
}

export function receive() {
	events.createServer({}).many.connect((player, ...values) => print(player, values.size()));
	functions.createServer({}).sum.setCallback((player, ...values) => values.size());
}
`;

/**
 * Sends from catch clauses whose variable hides `error` or `math`, which the code packed there calls:
 * a hole's refusal, a literal's, the decoder's, an `f32`'s check, a union's `f32` test and a tuple's
 * rest count. roblox-ts refuses a local or a parameter with either name, so only a `catch` hides them.
 * The last one hides `assert` as well.
 */
const CATCH = `import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

interface CatchEvents {
	report(message: string, lines: string[]): void;
	numbers(values: number[]): void;
	blobs(values: defined[]): void;
	pick(value: "a" | "b"): void;
	measure(value: Serialization.Implicit.f32, either: Serialization.f32 | string): void;
	headed(entry: [string, ...number[]]): void;
	flags(values: Serialization.u8[]): void;
}

const client = Networking.createEvent<CatchEvents, {}>().createClient({});

export let serialized: unknown;

export function report(work: () => void, n: number, either: Serialization.f32 | string) {
	try {
		work();
	} catch (error) {
		client.report.fire(tostring(error), ["line 1", "line 2"]);
		client.numbers.fire([1, 2, 3]);
		client.blobs.fire([1, "a"]);
		client.pick.fire("b");
		serialized = Flamework.createSerializer<boolean[]>().serialize([true]);
	}
	try {
		work();
	} catch (math) {
		client.measure.fire(n, either);
		client.headed.fire(["x", 1, tostring(math).size()]);
	}
}

export function nested(work: () => void) {
	try {
		work();
	} catch (error) {
		try {
			work();
		} catch (assert) {
			client.flags.fire([tostring(error).size(), tostring(assert).size()] as Serialization.u8[]);
		}
	}
}
`;

/**
 * The global `Map` under its own name, which a project may declare: the generated code names the global
 * through `globalThis` where a declaration hides it, at the call site and in a guard at the top of the
 * file alike. Its twin declares nothing, and the two compile to the same Luau.
 */
const MAP_ALIAS = `import { Networking } from "@flamework-experimental/networking";

type Map<K, V> = globalThis.Map<K, V>;

interface AliasEvents {
	map(value: Map<string, number>): void;
	tuple(value: [string, ...number[]] | [number, ...string[]]): void;
}

const client = Networking.createEvent<AliasEvents, {}>().createClient({});

export function send(value: Map<string, number>, tuple: [string, ...number[]] | [number, ...string[]]) {
	client.map.fire(value);
	client.tuple.fire(tuple);
}
`;

/** Types of a function's own named after the global types the code at its call sites names, and unlike them. */
const LOCAL_TYPES = `import { Networking } from "@flamework-experimental/networking";

interface LocalEvents {
	send(value: globalThis.Map<string, number>, blobs: defined[], bytes: buffer): void;
}

const client = Networking.createEvent<LocalEvents, {}>().createClient({});

export function send(value: globalThis.Map<string, number>, blobs: globalThis.defined[], bytes: globalThis.buffer) {
	interface Map {
		mine: true;
	}
	type defined = "mine";
	type buffer = "mine";
	client.send.fire(value, blobs, bytes);
	const own: [Map?, defined?, buffer?] = [];
	return own;
}
`;

/** A module-level `interface Map` unlike the global, next to a send of the global one. */
const MAP_INTERFACE = `import { Networking } from "@flamework-experimental/networking";
interface Map { name: string }
interface E { send(value: globalThis.Map<string, number>): void }
const client = Networking.createEvent<E, {}>().createClient({});
export function send(value: globalThis.Map<string, number>, map: Map) {
	client.send.fire(value);
	return map;
}
`;

/** Declarations that hide a global the generated code needs, each where it cannot be worked around. */
const HIDDEN: Record<string, string> = {
	genHideArray: `import { Networking } from "@flamework-experimental/networking";
interface E { send(value: defined[]): void }
const client = Networking.createEvent<E, {}>().createClient({});
export function send(values: defined[]) {
	const Array = 1;
	client.send.fire(values);
	return Array;
}
`,
	genHideTypeIs: `import { Networking } from "@flamework-experimental/networking";
interface E { send(value: string | number): void }
const client = Networking.createEvent<E, {}>().createClient({});
export function send(value: string | number, typeIs: (v: unknown) => boolean) {
	client.send.fire(value);
	return typeIs(value);
}
`,
	genHideModuleBuffer: `import { Networking } from "@flamework-experimental/networking";
interface E { send(value: string): void }
const client = Networking.createEvent<E, {}>().createClient({});
const buffer = 5;
export function send(value: string) {
	client.send.fire(value);
	return buffer;
}
`,
	genHideEnum: `import { Networking } from "@flamework-experimental/networking";
interface E { send(value: Enum.Material | string): void }
const client = Networking.createEvent<E, {}>().createClient({});
export function send(value: Enum.Material | string) {
	const Enum = 3;
	client.send.fire(value);
	return Enum;
}
`,
	genHideModuleWarn: `import { Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
interface E { send(value: Serialization.Implicit.u16): void }
const client = Networking.createEvent<E, {}>().createClient({});
function warn(message: string) {
	print(message);
}
export function send(value: number) {
	client.send.fire(value);
	warn("sent");
}
`,
};

let built: CompileResult;
let refused: CompileResult;

beforeAll(() => {
	// `warn` mode, so the check helper calls \`warn\` and a declaration of it can be in the way.
	const warnMode = { FLAMEWORK_FIXTURE_CHECKS_MODE: "warn" };
	built = compileProbes(
		{
			genShared: SHARED,
			genCoords: coordCaller(
				"CoordNetwork",
				"CoordFunctionNetwork",
				"GridCoord",
				"Placement",
				"{ [k: string]: number }",
			),
			genMutableCoords: coordCaller(
				"MutableCoordNetwork",
				"MutableCoordFunctionNetwork",
				"MutableCoord",
				"MutablePlacement",
				"Map<string, number>",
			),
			genEcs: ECS,
			genOwnTypes: OWN_TYPES,
			genLocalWarn: LOCAL_WARN,
			genReserved: RESERVED,
			genDedupTypes: DEDUP_TYPES,
			genDedup: DEDUP,
			genHoles: HOLES,
			genRest: REST,
			genCatch: CATCH,
			genMapAlias: MAP_ALIAS,
			genMapTwin: MAP_ALIAS.replace("type Map<K, V> = globalThis.Map<K, V>;\n\n", ""),
			genLocalTypes: LOCAL_TYPES,
			genMapInterface: MAP_INTERFACE,
		},
		warnMode,
	);
	refused = compileProbes({ genShared: SHARED, ...HIDDEN }, warnMode);
}, 600_000);

afterAll(() => {
	// What later tests read from disk is the ordinary build again.
	compileFixtureFresh();
}, 600_000);

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

function probe(name: string): string {
	const emit = built.files.get(name);
	if (emit === undefined) throw new Error(`no emit for ${name}:\n${plain(built.output)}`);
	return emit;
}

/** A top-level function of an emit. */
function functionBody(emit: string, name: string): string {
	const match = emit.match(new RegExp(`local function ${name}\\([^)]*\\)\\n[\\s\\S]*?\\nend\\n`));
	if (!match) throw new Error(`no function '${name}' in the emit`);
	return match[0];
}

describe("the probes", () => {
	test("compile, with no type error in the generated code", () => {
		expect(plain(built.output)).not.toContain("error TS");
		expect(built.status).toBe(0);
	});
});

describe("values that keep their caller's type", () => {
	test("pack a readonly tuple, an index signature and a readonly field exactly as their mutable twins", () => {
		// TS2352 before: `(origin as Array<unknown>)[0]`, a readonly tuple cast straight to a mutable array.
		const readonly = probe("genCoords");
		const mutable = probe("genMutableCoords")
			.replace(/MutableCoordFunctionNetwork/g, "CoordFunctionNetwork")
			.replace(/MutableCoordNetwork/g, "CoordNetwork")
			.replace(/_MutablePlacement\b/g, "_Placement");
		expect(readonly).toBe(mutable);

		const place = functionBody(readonly, "place");
		expect(place).toMatch(/buffer\.writei16\(buf\w*, 0, origin\[1\]\)/);
		expect(place).toMatch(/codec\.w_Placement\(/);
		expect(place).toMatch(/serializedPlace:_fire\(/);
		expect(place).toMatch(/functions\.ask:_invoke\(/);
	});
});

describe("globals the caller's declarations hide", () => {
	test("reach `buffer` through a module-level alias when the call site's own local hides it", () => {
		const ecs = probe("genEcs");
		expect(ecs).toMatch(/^local (buffer_\d+) = buffer$/m);
		const alias = ecs.match(/^local (buffer_\d+) = buffer$/m)![1];
		expect(functionBody(ecs, "replicate")).toContain(`${alias}.create(`);
		expect(ecs.indexOf(`local ${alias} = buffer`)).toBeLessThan(ecs.indexOf("local function replicate"));
		// The loop's own `buffer` is still what goes into the payload.
		expect(functionBody(ecs, "replicate")).toMatch(/buffer = buffer,/);
	});

	test("leave names the generated code no longer spells alone: a project's own Record, Callback and Array", () => {
		expect(built.files.has("genOwnTypes")).toBe(true);
	});

	test("look for a hoisted helper's globals where it lands: a local `warn` does not hide the helper's", () => {
		const emit = probe("genLocalWarn");
		expect(emit).toMatch(/codec\.checkWidth = function[\s\S]*?\twarn\(message\w*\)/);
	});

	test("reach `error` and `math` where a catch clause's variable hides them", () => {
		// A packed array sent from `catch (error)` was refused before: its hole check calls `error`.
		const emit = probe("genCatch");
		const caughtError = emit.slice(emit.indexOf("function(error)"), emit.indexOf("function(math)"));
		const caughtMath = emit.slice(emit.indexOf("function(math)"), emit.indexOf("local function nested"));
		// Nothing in either clause calls the caught value.
		expect(caughtError).not.toMatch(/(^|[^\w.])error\(/m);
		expect(caughtMath).not.toMatch(/(^|[^\w.])math\./m);

		// `error` raises through `assert`, which gives the same message from the same line and needs no
		// local of the file's own: a file at Luau's 200 locals that loaded before still does. roblox-ts
		// moves a message with a value in it into a temporary first, inside the branch that raises.
		const hole = (where: string) =>
			new RegExp(
				`if item\\w* == nil then\\s*local (_arg\\w*) = \`\\[Flamework\\] the array has no value at ${where}\\[\\{i\\w* - 1\\}\\]\`\\s*assert\\(false, \\1\\)\\s*end`,
			);
		expect(caughtError).toMatch(hole("'report' \\[1\\]"));
		expect(caughtError).toMatch(hole("'numbers' \\[0\\]"));
		expect(caughtError).toContain('assert(false, "value is not one of the literals its type allows")');
		expect(caughtError).toContain('assert(false, "malformed payload")');

		// `math` goes through a module-level alias, declared ahead of the function.
		const mathAlias = emit.match(/^local (math_\d+) = math$/m)?.[1];
		expect(mathAlias).toBeDefined();
		expect(emit.indexOf(`local ${mathAlias} = math`)).toBeLessThan(emit.indexOf("local function report"));
		expect(caughtMath).toMatch(
			new RegExp(
				`if ${mathAlias}\\.abs\\(n\\) > 3\\.4028234663852886e\\+38 and ${mathAlias}\\.abs\\(n\\) < ${mathAlias}\\.huge then`,
			),
		);
		expect(caughtMath).toContain(`${mathAlias}.max(`);
		// A `catch (assert)` inside the `catch (error)`: `error` goes through an alias too.
		const errorAlias = emit.match(/^local (error_\d+) = error$/m)?.[1];
		expect(errorAlias).toBeDefined();
		const nested = functionBody(emit, "nested");
		expect(nested).toContain(`${errorAlias}(\`[Flamework] the array has no value at 'flags' [0][{`);
		expect(nested).not.toMatch(/(^|[^\w.])(error|assert)\(/m);

		// The hoisted code is in the module's scope, where nothing hides them.
		expect(emit).toMatch(/\n\t\tn\w* = math\.floor\(/);
		// The alias is only made where a declaration hides the global.
		expect(probe("genHoles")).not.toMatch(/^local (error|math)_\d+ = /m);
	});

	test("name a global type through `globalThis` where a declaration hides it, so the Luau is the same", () => {
		// `type Map<K, V> = globalThis.Map<K, V>` was refused before, and compiled before that.
		// Each file's network has an id of its own.
		const ids = (emit: string) => emit.replace(/createEvent\("[\w-]+"\)/, "createEvent(<id>)");
		expect(ids(probe("genMapAlias"))).toBe(ids(probe("genMapTwin")));
		expect(probe("genMapAlias")).toMatch(/local guard\w* = /);
		expect(functionBody(probe("genLocalTypes"), "send")).toMatch(/client\.send:_fire\(/);
		expect(functionBody(probe("genMapInterface"), "send")).toMatch(/client\.send:_fire\(/);
	});

	test("refuse the ones that cannot be reached another way, naming the global and the declaration", () => {
		expect(refused.status).not.toBe(0);
		const output = plain(refused.output);
		const message = (name: string, line: number) =>
			`Flamework's generated code here uses the global '${name}', which the declaration of '${name}' on line ${line} hides. Rename that declaration.`;

		expect(output).toContain(`genHideArray.ts:6:2 - error TS @flamework-experimental/core: ${message("Array", 5)}`);
		expect(output).toContain(
			`genHideTypeIs.ts:5:2 - error TS @flamework-experimental/core: ${message("typeIs", 4)}`,
		);
		// A module-level \`buffer\` hides the global from the alias too.
		expect(output).toContain(
			`genHideModuleBuffer.ts:6:2 - error TS @flamework-experimental/core: ${message("buffer", 4)}`,
		);
		expect(output).toContain(`genHideEnum.ts:6:2 - error TS @flamework-experimental/core: ${message("Enum", 5)}`);
		// The check helper at the top of the file calls `warn` (mode warn), which a module-level function hides.
		expect(output).toContain(
			`genHideModuleWarn.ts:9:2 - error TS @flamework-experimental/core: ${message("warn", 5)}`,
		);
	});
});

describe("locals named after the project's types", () => {
	test("take a name a local can have, whatever the field or type is called", () => {
		// \`const arguments = [value_18] as Array<unknown>\` before: TS1215, from a library's action type.
		const action = probe("genReserved");
		expect(action).toMatch(/local v_arguments = \{ [\w.(), ]+ \}/);
		expect(action).not.toMatch(/local arguments\b/);

		for (const name of RESERVED_NAMES) {
			// A name that only needs its characters replaced keeps the rest: `two words` is `two_words`.
			const replaced = name.replace(/\W/g, "_");
			const local = name === "two words" ? replaced : `v_${replaced}`;
			expect(`${name}: ${new RegExp(`local ${local}(_\\d+)? = \\{`).test(action)}`).toBe(`${name}: true`);
		}
	});

	test("give a deduplicated guard a local that hides no global", () => {
		const dedup = probe("genDedup");
		expect(dedup).toMatch(/local v_Map\w* = t\.interface\(\{/);
		expect(dedup).not.toMatch(/local Map\b/);
	});
});

describe("arrays with a hole", () => {
	test("are written by index up to the count the size pass counted", () => {
		const send = functionBody(probe("genHoles"), "send");
		expect(send).not.toMatch(/for _, /);
		// A hole where the element type takes nil is written as one, by its presence byte.
		expect(send).toMatch(
			/o\w* = vwrite\(buf\w*, o\w*, #optional\)\s*for i\w* = 1, #optional do\s*local item\w* = optional\[i\w*\]\s*buffer\.writeu8\(buf\w*, o\w*, if item\w* ~= nil then 1 else 0\)/,
		);
		expect(send).toMatch(/for i\w* = 1, #anything do\s*local item\w* = anything\[i\w*\]\s*if item\w* ~= nil then/);
	});

	test("raise where the element type takes no nil, in the pass that reaches the elements first", () => {
		const send = functionBody(probe("genHoles"), "send");
		// Fixed-size elements: the writes.
		expect(send).toMatch(
			/for i(\w*) = 1, #values do\s*local item\w* = values\[i\1\]\s*if item\w* == nil then\s*error\(`\[Flamework\] the array has no value at 'blobs' \[0\]\[\{i\1 - 1\}\]`\)/,
		);
		expect(send).toContain("error(`[Flamework] the array has no value at 'numbers' [0][{");
		// Variable-size elements: the size pass, before any length is taken of a nil.
		expect(send).toMatch(
			/local n\w* = #names\s*local size\w* = vsize\(n\w*\)\s*for i(\w*) = 1, n\w* do\s*local item\w* = names\[i\1\]\s*if item\w* == nil then\s*error\(`\[Flamework\] the array has no value at 'names' \[0\]\[\{i\1 - 1\}\]`\)/,
		);
		expect(send.match(/has no value at 'names'/g)).toHaveLength(1);
		// A tuple's rest element.
		expect(send).toContain("error(`[Flamework] the tuple has no value at 'tagged' [0][{");
		// Where nil is a value, there is nothing to refuse.
		expect(send).not.toContain("'optional' [0][");
		expect(send).not.toContain("'anything' [0][");

		// `string[]`, reached a second time by the serializer, has code of its own, which starts from its name.
		expect(probe("genHoles")).toContain("error(`[Flamework] the array has no value at (string[])[{");
	});
});

describe("array rest parameters", () => {
	test("pack any number of arguments, known or spread, as the list's rest", () => {
		const send = functionBody(probe("genRest"), "send");
		// None, one and three arguments: the count is a constant byte.
		expect(send).toMatch(
			/local buf\w* = buffer\.create\(1\)\s*buffer\.writeu8\(buf\w*, 0, 0\)\s*client\.many:_fire/,
		);
		expect(send).toMatch(
			/local buf\w* = buffer\.create\(9\)\s*buffer\.writeu8\(buf\w*, 0, 1\)\s*buffer\.writef64\(buf\w*, 1, 1\)\s*client\.many:_fire/,
		);
		expect(send).toMatch(/buffer\.create\(25\)\s*buffer\.writeu8\(buf\w*, 0, 3\)/);
		// A spread: counted where it is sent.
		expect(send).toMatch(
			/local count\w* = #args\w*\s*local buf\w* = buffer\.create\(vsize\(count\w*\) \+ count\w* \* 8\)/,
		);
		expect(send).toMatch(/client\.serializedMany:_fire\(/);
		expect(send).toMatch(/clientFunctions\.sum:_invoke\(/);
	});

	test("read back into the list the receiver spreads, which the guards check element by element", () => {
		const emit = probe("genRest");
		expect(emit).toMatch(
			/many = \(function\(buf\w*\)\s*local o\w* = 0\s*local count\w*, o\w* = vread\(buf\w*, o\w*\)/,
		);
		expect(emit).toMatch(/local list\w* = \{\}\s*for i(\w*) = 1, count\w* do\s*list\w*\[i\1\] = buffer\.readf64/);
		expect(emit).toMatch(/many = \{ \{\}, t\.number \}/);
	});
});
