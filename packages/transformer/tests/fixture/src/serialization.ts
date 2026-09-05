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

export const payloadSerializer = Flamework.createSerializer<Payload>();
export const nodeSerializer = Flamework.createSerializer<Node>();
export const pairSerializer = Flamework.createSerializer<[number, string?, ...boolean[]]>();

interface ServerEvents {
	ping(value: number, where: Vector3): void;
}

interface ClientEvents {
	pong(value: number): void;
}

interface ServerFunctions {
	echo(value: string): Promise<string>;
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

// An expression-bodied arrow has no statement of its own to put the packing in front of.
client.pong.connect((value) => client.ping.fire(value, Vector3.zero));

serverFunctions.echo.setCallback((player, value) => Promise.resolve(`${value}!`));
