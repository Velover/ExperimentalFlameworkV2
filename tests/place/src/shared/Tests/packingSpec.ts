import { Networking } from "@flamework-experimental/networking";
import { ReplicatedStorage } from "@rbxts/services";

/**
 * Members that opt into packing one by one (`Serialized`), for the `packing` sections. They are
 * packed whatever the place's `networking.serialization` says, so the sections hold in a build with
 * the switch either way. The client sends and the server answers; `packingAsk` has the server invoke
 * the client's functions so the client can watch it.
 */

export interface PackedItem {
	id: number;
	name: string;
	count: number;
}

/** What a client may ask the server to do, each answering a case of the client's section. */
export type PackingRequest = "invokeClient" | "hostile" | "maybeDown" | "maybeInvokeClient";

export interface PackingServerEvents {
	serializedUp: Networking.SerializedReliable<(items: PackedItem[], where: Instance) => void>;
	serializedUpUnreliable: Networking.SerializedUnreliable<(value: number) => void>;
	serializedStepUp: Networking.Unreliable<Networking.Serialized<(items: PackedItem[]) => void>>;
	serializedBumpUp: Networking.SerializedReliable<() => void>;

	/**
	 * Can carry an Instance or leave it out. The blob list goes on the wire only when it holds
	 * something, so a message without one is the buffer alone.
	 */
	serializedMaybeUp: Networking.SerializedReliable<(label: string, where?: Instance) => void>;
	packingAsk(request: PackingRequest): void;
}

export interface PackingClientEvents {
	serializedDown: Networking.SerializedReliable<(items: PackedItem[], where: Instance) => void>;
	serializedDownUnreliable: Networking.Serialized<Networking.Unreliable<(value: number) => void>>;
	serializedStepDown: Networking.SerializedUnreliable<(items: PackedItem[]) => void>;

	/** `serializedMaybeUp` the other way: sent with `fire`, `broadcast` and `except` when asked (`maybeDown`). */
	serializedMaybeDown: Networking.SerializedReliable<(label: string, where?: Instance) => void>;

	/** The server's answer to `serializedBumpUp`: how many arguments the message carried on the wire. */
	serializedBumped(argumentsOnWire: number): void;

	/** The server's answer to `invokeClient`: what the client's serialized functions returned, or why they failed. */
	askedClient(items: string, text: string): void;

	/** What the server's `onBadRequest` reported for the packing events, as `name#index:reason`. */
	packingRejected(entries: string[]): void;

	/**
	 * What the server made of a `serializedMaybeUp` message, a `serializedFind` request or a
	 * `serializedFindClient` result, as `kind:label@where:argumentsOnWire`: what it decoded, and how
	 * many arguments the remote delivered, read off the remote itself.
	 */
	packingHeard(entry: string): void;
}

export interface PackingServerFunctions {
	serializedLookup: Networking.Serialized<(ids: number[], where: Instance) => [PackedItem[], Instance]>;
	serializedNothing: Networking.Serialized<() => void>;

	/** A request and a result that can each carry an Instance or leave it out; the result is `where`. */
	serializedFind: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
}

export interface PackingClientFunctions {
	serializedAsk: Networking.Serialized<(question: string) => PackedItem[]>;
	serializedEcho: Networking.Serialized<(text: string) => string>;

	/** `serializedFind` the other way: the server invokes it when asked (`maybeInvokeClient`). */
	serializedFindClient: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
}

export const PackingEvents = Networking.createEvent<PackingServerEvents, PackingClientEvents>();
export const PackingFunctions = Networking.createFunction<PackingServerFunctions, PackingClientFunctions>();

export function makeItems(count: number, name: string): PackedItem[] {
	const items = new Array<PackedItem>();
	for (const id of $range(1, count)) items.push({ id, name, count: id * 2 });
	return items;
}

/** `name:size:lastId:lastCount`, and `@where` when an Instance came with them. */
export function describeItems(items: PackedItem[], where?: Instance): string {
	const last = items[items.size() - 1];
	const tail = last !== undefined ? `${last.id}:${last.count}` : "none";
	return `${items[0]?.name ?? "none"}:${items.size()}:${tail}${where !== undefined ? `@${where.Name}` : ""}`;
}

/** `label@where`, `where` being `none` when no Instance came. */
export function describeWhere(label: string, where?: Instance): string {
	return `${label}@${where !== undefined ? where.Name : "none"}`;
}

type PackingRemote = RemoteEvent;

function isRemote(instance: Instance): instance is PackingRemote {
	return instance.IsA("RemoteEvent") || instance.IsA("UnreliableRemoteEvent");
}

/**
 * The published remote with this id in the packing events' folder, found by the one id only this
 * network declares. `undefined` where nothing is published (a Luau execution task).
 */
export function findPackingRemote(id: string): PackingRemote | undefined {
	return findBeside("serializedBumpUp", id);
}

/**
 * The published remote of a packing function, which lives in a folder of its own: `$name` for one
 * the server answers (requests up, results down), `@name` for one the client answers.
 */
export function findPackingFunctionRemote(id: string): PackingRemote | undefined {
	return findBeside("$serializedNothing", id);
}

/** The remote with id `id` in the folder that holds the remote with id `marker`. */
function findBeside(marker: string, id: string): PackingRemote | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (isRemote(descendant) && descendant.GetAttribute("id") === marker) {
			for (const child of descendant.Parent!.GetChildren()) {
				if (isRemote(child) && child.GetAttribute("id") === id) return child;
			}
		}
	}
}
