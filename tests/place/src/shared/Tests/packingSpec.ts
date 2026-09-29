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
export type PackingRequest = "invokeClient" | "hostile";

export interface PackingServerEvents {
	serializedUp: Networking.SerializedReliable<(items: PackedItem[], where: Instance) => void>;
	serializedUpUnreliable: Networking.SerializedUnreliable<(value: number) => void>;
	serializedStepUp: Networking.Unreliable<Networking.Serialized<(items: PackedItem[]) => void>>;
	serializedBumpUp: Networking.SerializedReliable<() => void>;
	packingAsk(request: PackingRequest): void;
}

export interface PackingClientEvents {
	serializedDown: Networking.SerializedReliable<(items: PackedItem[], where: Instance) => void>;
	serializedDownUnreliable: Networking.Serialized<Networking.Unreliable<(value: number) => void>>;
	serializedStepDown: Networking.SerializedUnreliable<(items: PackedItem[]) => void>;

	/** The server's answer to `serializedBumpUp`: how many arguments the message carried on the wire. */
	serializedBumped(argumentsOnWire: number): void;

	/** The server's answer to `invokeClient`: what the client's serialized functions returned, or why they failed. */
	askedClient(items: string, text: string): void;

	/** What the server's `onBadRequest` reported for the packing events, as `name#index:reason`. */
	packingRejected(entries: string[]): void;
}

export interface PackingServerFunctions {
	serializedLookup: Networking.Serialized<(ids: number[], where: Instance) => [PackedItem[], Instance]>;
	serializedNothing: Networking.Serialized<() => void>;
}

export interface PackingClientFunctions {
	serializedAsk: Networking.Serialized<(question: string) => PackedItem[]>;
	serializedEcho: Networking.Serialized<(text: string) => string>;
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

type PackingRemote = RemoteEvent;

function isRemote(instance: Instance): instance is PackingRemote {
	return instance.IsA("RemoteEvent") || instance.IsA("UnreliableRemoteEvent");
}

/**
 * The published remote with this id in the packing events' folder, found by the one id only this
 * network declares. `undefined` where nothing is published (a Luau execution task).
 */
export function findPackingRemote(id: string): PackingRemote | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (isRemote(descendant) && descendant.GetAttribute("id") === "serializedBumpUp") {
			for (const child of descendant.Parent!.GetChildren()) {
				if (isRemote(child) && child.GetAttribute("id") === id) return child;
			}
		}
	}
}
