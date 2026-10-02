import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

/*
 * The encodings the type-check specs run (`serialization.checks.types`). This file is compiled with
 * the specs, under their own config (type checks off), and again by each project in
 * packages/specs/variants, through `widthChecks/codecs.ts`, which hands it out as `types`: the
 * `types`, `typesWarn` and `typesServer` variants turn the checks on. The sends and callbacks are
 * written here rather than in the specs, since a call site is packed by the build it is compiled in.
 * Nothing here may depend on which build it is: the specs tell them apart.
 */

/** A fixed-size type: written where it is reached. */
export interface Point {
	x: number;
	y: number;
}

/** A named type whose size varies, reached from `Entity`: shared code of its own. */
export interface Owner {
	label: string;
}

/** A named type whose size varies: its code is shared, and its paths start where it is sent. */
export interface Entity {
	id: number;
	name: string;
	tags: string[];
	pos: Point;
	spot?: Vector3;
	flag: boolean;
	owner: Owner;
}

/** Every member a table, told apart by `kind`. */
export type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number; label: string };

export const number = Flamework.createSerializer<number>();
export const u8 = Flamework.createSerializer<Serialization.Implicit.u8>();
export const varint = Flamework.createSerializer<Serialization.varint>();
export const text = Flamework.createSerializer<string>();
export const string8 = Flamework.createSerializer<Serialization.string8>();
export const boolean = Flamework.createSerializer<boolean>();
export const bytes = Flamework.createSerializer<buffer>();
export const literals = Flamework.createSerializer<"a" | "b" | "c">();
export const circle = Flamework.createSerializer<{
	kind: "circle";
	r: number;
}>();
export const vector = Flamework.createSerializer<Vector3>();
export const frame = Flamework.createSerializer<CFrame>();
export const instance = Flamework.createSerializer<Instance>();
export const anything = Flamework.createSerializer<unknown>();
export const list = Flamework.createSerializer<number[]>();
export const names = Flamework.createSerializer<string[]>();
export const set = Flamework.createSerializer<Set<string>>();
export const map = Flamework.createSerializer<Map<string, number>>();
export const maybe = Flamework.createSerializer<number | undefined>();
export const either = Flamework.createSerializer<number | string>();
export const pair = Flamework.createSerializer<[number, string]>();
export const fixedPair = Flamework.createSerializer<[number, boolean]>();
export const point = Flamework.createSerializer<Point>();
export const points = Flamework.createSerializer<Point[]>();
export const entity = Flamework.createSerializer<Entity>();
export const shape = Flamework.createSerializer<Shape>();
/** Enum items as literal types: one alone, a union of them, and a union of them with a number. */
export const plastic = Flamework.createSerializer<Enum.Material.Plastic>();
export const plasticOrWood = Flamework.createSerializer<Enum.Material.Plastic | Enum.Material.Wood>();
export const plasticOrNumber = Flamework.createSerializer<Enum.Material.Plastic | Enum.Material.Wood | number>();

interface TypeEvents {
	typeMove: Networking.SerializedReliable<(id: number, entity: Entity, flag: boolean) => void>;
	typeMany: Networking.SerializedReliable<(label: string, ...values: number[]) => void>;
}

interface TypeFunctions {
	typeAsk: Networking.Serialized<(id: number) => Point>;
}

export const TypeEventsNetwork = Networking.createEvent<TypeEvents, TypeEvents>();
export const TypeFunctionsNetwork = Networking.createFunction<TypeFunctions, TypeFunctions>();

type ServerEvents = ReturnType<typeof TypeEventsNetwork.createServer>;
type ClientEvents = ReturnType<typeof TypeEventsNetwork.createClient>;
type ServerFunctions = ReturnType<typeof TypeFunctionsNetwork.createServer>;
type ClientFunctions = ReturnType<typeof TypeFunctionsNetwork.createClient>;

/** A realm's handlers: the server's or the client's, whichever the spec runs as. */
export interface Events {
	server?: ServerEvents;
	client?: ClientEvents;
}

export interface Functions {
	server?: ServerFunctions;
	client?: ClientFunctions;
}

export function fireMove(events: Events, player: Player, id: number, entity: Entity, flag: boolean) {
	if (events.server !== undefined) events.server.typeMove.fire(player, id, entity, flag);
	else events.client!.typeMove.fire(id, entity, flag);
}

/** Three rest arguments, each one packed in its own place. */
export function fireThree(events: Events, player: Player, label: string, a: number, b: number, c: number) {
	if (events.server !== undefined) events.server.typeMany.fire(player, label, a, b, c);
	else events.client!.typeMany.fire(label, a, b, c);
}

/** Arguments spread into the rest parameter: packed from the list the call gathers. */
export function fireSpread(events: Events, player: Player, label: string, values: number[]) {
	if (events.server !== undefined) events.server.typeMany.fire(player, label, ...values);
	else events.client!.typeMany.fire(label, ...values);
}

export function invokeAsk(functions: Functions, player: Player, id: number) {
	if (functions.server !== undefined) return functions.server.typeAsk.invoke(player, id);
	return functions.client!.typeAsk.invoke(id);
}

/** Answers with whatever `answer` gives: the result is packed in the callback written here. */
export function answerAsk(functions: Functions, answer: (id: number) => Point) {
	if (functions.server !== undefined) functions.server.typeAsk.setCallback((_player, id) => answer(id));
	else functions.client!.typeAsk.setCallback((id) => answer(id));
}
