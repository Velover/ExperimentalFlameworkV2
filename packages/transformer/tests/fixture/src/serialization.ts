import { Flamework, Serialization } from "@flamework/core";
import { Networking } from "@flamework/networking";

interface Point {
	x: number;
	y: number;
}

interface Payload {
	id: Serialization.u16;
	name: Serialization.string8;
	tags: string[];
	where: Point;
	mode: "a" | "b" | "c";
	maybe?: number;
	kind: "payload";
	owner: Instance;
}

interface Node {
	value: number;
	children: Node[];
}

/** Members are numbered as written: Coins is 0 and Items is 1, whatever order TypeScript lists them in. */
type Wallet = { Coins: number } | { Items: string[] };

/** One union over every family of kind: a blob, a datatype, discriminated objects, an array and literals. */
type Mixed = Instance | Vector3 | { kind: "a"; v: number } | { kind: "b"; s: string } | number[] | "lit" | 5;

/** Nested collections with Instances as keys, sets of maps, arrays of tuples: nothing here is special. */
interface Crazy {
	byPart: Map<Instance, Array<Set<string>>>;
	pairs: Array<[Serialization.varint, string?]>;
	groups: Set<Map<string, number[]>>;
	tag: `${string}-id`;
	sortOf: number | string;
	anything: object;
	weird: Map<Vector3 | Array<{ id: number }>, Set<CFrame | string>>;
	matrix: Array<Array<Map<Serialization.u8, [Vector3, ...string[]]>>>;
	enums: Map<Enum.Material, Array<Enum.KeyCode | undefined>>;
	variants: Mixed[];
	unknownInside: Array<Map<string, unknown>>;
	setOfTuples: Set<[number, string]>;
	bytes: buffer;
	colors: Array<Color3 | BrickColor>;
	ro: ReadonlyMap<string, ReadonlyArray<ReadonlySet<number>>>;
}

class Thing {
	value = 1;
}

/**
 * A field named after its own datatype. Imported by a probe rather than used here: the local the
 * decoder declares for it only clashes when the file it lands in never spells `CFrame` itself.
 */
export interface Placement {
	readonly OwnerUserId: number;
	readonly CFrame: CFrame;
	readonly Surfaced: boolean;
}

export const payloadSerializer = Flamework.createSerializer<Payload>();
export const nodeSerializer = Flamework.createSerializer<Node>();
export const pairSerializer = Flamework.createSerializer<[number, string?, ...boolean[]]>();
export const walletSerializer = Flamework.createSerializer<Wallet>();
export const crazySerializer = Flamework.createSerializer<Crazy>();
export const thingSerializer = Flamework.createSerializer<Thing>();

interface ServerEvents {
	ping(value: number, where: Vector3): void;
	/** Carries nothing, so it sends nothing. */
	bump(): void;
	/** Fired with a literal, which is what packing at the call site has to survive. */
	toggle(on: boolean): void;
	/** Declared raw: its arguments travel as they are. */
	rawPing: Networking.RawReliable<(value: number) => void>;
}

interface ClientEvents {
	pong(value: number): void;
	tick: Networking.RawUnreliable<(value: number) => void>;
}

interface ServerFunctions {
	echo(value: string): Promise<string>;
	rawEcho: Networking.Raw<(value: string) => string>;
	nothing(): void;
}

export const events = Networking.createEvent<ServerEvents, ClientEvents>();
export const functions = Networking.createFunction<ServerFunctions, {}>();
export const server = events.createServer({});
export const serverFunctions = functions.createServer({});
export const client = events.createClient({});
export const clientFunctions = functions.createClient({});

// Call sites: with serialization on, each of these packs its arguments inline.
export function broadcastPong(value: number) {
	server.pong.broadcast(value);
}

export function firePong(player: Player, value: number) {
	server.pong.fire(player, value);
	server.pong(player, value + 1);
}

export function ping(where: Vector3) {
	client.ping.fire(1, where);
}

export function echo(value: string) {
	return clientFunctions.echo.invoke(value);
}

// An empty list sends no payload; a raw event is left exactly as written.
export function bump() {
	client.bump.fire();
}

// Regression: a boolean packed at the call site was written as `value === true`, which TypeScript
// rejects as a pointless comparison once the argument is a literal.
export function toggle(on: boolean) {
	client.toggle.fire(false);
	client.toggle.fire(true);
	client.toggle.fire(on);
}

export function raw(value: number) {
	client.rawPing.fire(value);
	server.tick.broadcast(value);
}

export function nothing() {
	return clientFunctions.nothing.invoke();
}

// An expression-bodied arrow has no statement of its own to put the packing in front of.
client.pong.connect((value) => client.ping.fire(value, Vector3.zero));

serverFunctions.echo.setCallback((player, value) => Promise.resolve(`${value}!`));
serverFunctions.rawEcho.setCallback((player, value) => `${value}!`);
serverFunctions.nothing.setCallback(() => {});
