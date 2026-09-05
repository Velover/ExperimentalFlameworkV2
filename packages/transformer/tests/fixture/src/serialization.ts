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
