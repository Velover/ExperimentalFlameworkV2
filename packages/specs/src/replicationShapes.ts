import { Networking } from "@flamework-experimental/networking";
import { Serialization } from "@flamework-experimental/core";
import { GridCoord, Placement, Reserved, SerializedData, describeReserved, reservedOf } from "./generatedCode/shared";

/*
 * Cross-realm round trips of the shapes whose generated code once failed to compile, or wrote the
 * wrong thing: a caller's readonly tuple, an index signature, an ECS replication payload sent from a
 * loop whose locals are named `buffer`, fields named after words no local can take, arrays with a
 * hole, and array rest parameters. Loaded by both graphs of `tests/runtime/replication.luau`, like
 * `replication.ts`. The plain members are packed with networking.serialization on and sent as they
 * are with it off; the `Serialized` ones are packed either way.
 */

interface ShapeServerEvents {
	place(origin: GridCoord, rotation: number): void;
	placeNested(data: Placement): void;
	placeRest(...origins: GridCoord[]): void;
	placeOpt(origin: GridCoord | undefined): void;
	placeOr(origin: GridCoord | string): void;
	indexSig(value: { [k: string]: number }): void;
	serializedPlace: Networking.Serialized<(origin: GridCoord, data: Placement) => void>;

	reserved(data: Reserved): void;
	serializedReserved: Networking.Serialized<(data: Reserved) => void>;

	serializedHoles: Networking.Serialized<(values: Array<Serialization.u16 | undefined>, anything: unknown[]) => void>;

	many(...values: number[]): void;
	manyNames(...names: string[]): void;
	serializedMany: Networking.Serialized<(...values: number[]) => void>;
}

interface ShapeClientEvents {
	SendReliable(data: SerializedData): void;
	serializedSendReliable: Networking.Serialized<(data: SerializedData) => void>;
}

interface ShapeServerFunctions {
	ask(origin: GridCoord): GridCoord;
	sum(...values: number[]): number;
	serializedSum: Networking.Serialized<(...values: number[]) => number>;
}

const ShapeEvents = Networking.createEvent<ShapeServerEvents, ShapeClientEvents>();
const ShapeFunctions = Networking.createFunction<ShapeServerFunctions, {}>();

/** Whatever this graph has received, drained by the runner between cases. */
const log = new Array<string>();

// A request the receiving side turned down: `-1` for a payload it could not read, else the argument's index.
ShapeEvents.registerHandler("onBadRequest", (_player, data) =>
	log.push(`bad:${data.networkInfo.name}:${data.argIndex}`),
);

function coordText(coord: GridCoord | undefined) {
	return coord === undefined ? "none" : `${coord[0]},${coord[1]},${coord[2]}`;
}

function placementText(data: Placement) {
	return `${coordText(data.origin)}|${data.rotation}|${data.name}|${data.templateId}`;
}

/** A list's entries by index up to `size`, nil where it has none: `1,nil,3`. */
function entries(list: unknown[], size: number) {
	const parts = new Array<string>();
	for (const i of $range(0, size - 1)) parts.push(tostring(list[i]));
	return parts.join(",");
}

/** The keys and values of a record, sorted: `a=1,b=2`. */
function recordText(value: { [k: string]: number }) {
	const parts = new Array<string>();
	for (const [key, entry] of pairs(value)) parts.push(`${key}=${entry}`);
	parts.sort();
	return parts.join(",");
}

export function setupServer() {
	const events = ShapeEvents.createServer({});
	events.place.connect((_player, origin, rotation) => log.push(`place:${coordText(origin)}:${rotation}`));
	events.placeNested.connect((_player, data) => log.push(`placeNested:${placementText(data)}`));
	events.placeRest.connect((_player, ...origins) => log.push(`placeRest:${origins.map(coordText).join(";")}`));
	events.placeOpt.connect((_player, origin) => log.push(`placeOpt:${coordText(origin)}`));
	events.placeOr.connect((_player, origin) =>
		log.push(`placeOr:${typeIs(origin, "string") ? origin : coordText(origin)}`),
	);
	events.indexSig.connect((_player, value) => log.push(`indexSig:${recordText(value)}`));
	events.serializedPlace.connect((_player, origin, data) =>
		log.push(`serializedPlace:${coordText(origin)}:${placementText(data)}`),
	);
	events.reserved.connect((_player, data) => log.push(`reserved:${describeReserved(data)}`));
	events.serializedReserved.connect((_player, data) => log.push(`serializedReserved:${describeReserved(data)}`));
	events.serializedHoles.connect((_player, values, anything) =>
		log.push(`serializedHoles:${entries(values, 3)}|${entries(anything, 3)}`),
	);
	events.many.connect((_player, ...values) => log.push(`many:${values.size()}:${values.join(",")}`));
	events.manyNames.connect((_player, ...names) => log.push(`manyNames:${names.size()}:${names.join(",")}`));
	events.serializedMany.connect((_player, ...values) =>
		log.push(`serializedMany:${values.size()}:${values.join(",")}`),
	);

	const functions = ShapeFunctions.createServer({});
	functions.ask.setCallback((_player, origin) => [origin[0] + 1, origin[1] + 1, origin[2] + 1] as never);
	functions.sum.setCallback((_player, ...values) => values.reduce((total, value) => total + value, 0));
	functions.serializedSum.setCallback((_player, ...values) =>
		values.reduce((total, value) => total + value, values.size() * 1000),
	);
}

export function setupClient() {
	const events = ShapeEvents.createClient({});
	events.SendReliable.connect((data) =>
		log.push(`SendReliable:${buffer.tostring(data.buffer)}:${data.blobs.size()}`),
	);
	events.serializedSendReliable.connect((data) =>
		log.push(`serializedSendReliable:${buffer.tostring(data.buffer)}:${data.blobs.size()}`),
	);

	ShapeFunctions.createClient({});
}

/** The client's sends of a readonly tuple, a readonly field and an index signature, as their own values. */
export function firePlacements(origin: GridCoord, list: GridCoord[], value: { [k: string]: number }) {
	const events = ShapeEvents.createClient({});
	const data: Placement = { origin, rotation: 90, name: "wall", templateId: 7 };
	events.place.fire(origin, 45);
	events.placeNested.fire(data);
	events.placeNested.fire({ origin, rotation: 180, name: "door", templateId: 8 });
	events.placeRest.fire(origin, origin);
	events.placeRest.fire(...list);
	events.placeOpt.fire(origin);
	events.placeOpt.fire(undefined);
	events.placeOr.fire(origin);
	events.placeOr.fire("named");
	events.indexSig.fire(value);
	events.serializedPlace.fire(origin, data);
}

export function invokeAsk(origin: GridCoord) {
	return ShapeFunctions.createClient({}).ask.invoke(origin).then(coordText);
}

export function fireReserved(base: number) {
	const events = ShapeEvents.createClient({});
	events.reserved.fire(reservedOf(base));
	events.serializedReserved.fire(reservedOf(base + 100));
}

/** Expected on the server for `fireReserved(base)`. */
export function reservedText(base: number) {
	return [
		`reserved:${describeReserved(reservedOf(base))}`,
		`serializedReserved:${describeReserved(reservedOf(base + 100))}`,
	];
}

/**
 * Arrays with a hole where nil is a value. The payload is written whole, the hole in its place, where
 * before the count said three and two values followed; the receiving guard then turns a list with a
 * gap down, as it does one sent unpacked (`t.array` takes none).
 */
export function fireHoles() {
	const values = [1, undefined, 3] as Array<Serialization.u16 | undefined>;
	ShapeEvents.createClient({}).serializedHoles.fire(values, ["a", undefined, 3]);
}

/** The same lists without a hole: they arrive. */
export function fireWholeLists() {
	const values = [1, 2, 3] as Array<Serialization.u16 | undefined>;
	ShapeEvents.createClient({}).serializedHoles.fire(values, ["a", "b", 3]);
}

/** A hole the element type has no value for: what sending it raised, or "none". */
export function fireRefusedHole() {
	const values = [1, undefined, 3] as unknown as number[];
	const [ok, err] = pcall(() => ShapeEvents.createClient({}).serializedMany.fire(...values));
	return ok ? "none" : tostring(err);
}

/** Array rest parameters with none, one and several arguments, known and spread. */
export function fireMany(values: number[]) {
	const events = ShapeEvents.createClient({});
	events.many.fire();
	events.many.fire(1);
	events.many.fire(1, 2, 3);
	events.many.fire(...values);
	events.manyNames.fire("a", "b");
	events.serializedMany.fire();
	events.serializedMany.fire(4);
	events.serializedMany.fire(...values);
}

export function invokeSums(values: number[]) {
	const functions = ShapeFunctions.createClient({});
	return Promise.all([
		functions.sum.invoke(),
		functions.sum.invoke(5),
		functions.sum.invoke(1, 2, 3),
		functions.sum.invoke(...values),
		functions.serializedSum.invoke(),
		functions.serializedSum.invoke(...values),
	]).then((results) => results.join(","));
}

type Packet = [Player, buffer, defined[] | undefined];

/** A stand-in for an ECS replicator's update iterator, with its tuple-returning API. */
function collectUpdates(packets: Packet[]) {
	let index = 0;
	return (() => {
		const packet = packets[index++];
		if (packet === undefined) return undefined as never;
		return $tuple(packet[0], packet[1], packet[2]);
	}) as IterableFunction<LuaTuple<Packet>>;
}

/** An outside project's replication loop, exactly: its locals are named `buffer`. */
export function replicate(player: Player, blob: Instance) {
	const events = ShapeEvents.createServer({});
	const updates: Packet[] = [
		[player, buffer.fromstring("reliable"), [blob]],
		[player, buffer.fromstring("empty"), undefined],
	];
	for (const [player, buffer, blobs] of collectUpdates(updates)) {
		events.SendReliable.fire(player, { buffer, blobs: blobs ?? [] });
		events.serializedSendReliable.fire(player, { buffer, blobs: blobs ?? [] });
	}
}

/** Returns everything received since the last call and clears the log. */
export function drain() {
	const entries = [...log];
	log.clear();

	return entries;
}
