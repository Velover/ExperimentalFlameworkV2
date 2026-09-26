import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { ReplicatedStorage } from "@rbxts/services";

/**
 * The events of the Lune `networking` suite, declared for a place. The Lune harness recorded what
 * a remote sent and injected what it received; here the other realm is real, so each event either
 * side sends is answered by the other, and a few `ask` requests let the client have the server
 * send something so the client can watch it arrive.
 */

/** What a client may ask the server to send it, each answering a case of the suite. */
export type SpecRequest = "broadcast" | "list" | "except" | "tick" | "raw" | "malformed";

export interface SpecServerEvents {
	setScore(score: number): void;
	rename(name: string): void;

	/** Carries nothing, so with serialization on it sends no payload at all. */
	bump(): void;

	/** A nested namespace, which gets its own remote named after the path to it. */
	stats: { report(value: number): void };

	/** Asks the server to send `value` back the way `request` names. */
	ask(request: SpecRequest, value: number): void;

	/**
	 * One anonymous union spelled two ways. TypeScript keeps a single type for both, and each side
	 * has to number its members as written where the value is reached, or the tags disagree on the
	 * wire. The server's handlers meet `sortA` first, walking the events as declared; the client's
	 * `networking` section sends on `sortB` first, as a file of its own.
	 */
	sortA(value: string | number): void;
	sortB(value: number | string): void;
}

export interface SpecClientEvents {
	scoreChanged(score: number): void;

	/** Declared unreliable, so it gets an `UnreliableRemoteEvent` on a separate channel. */
	tick: Networking.Unreliable<(value: number) => void>;

	/** Declared raw: its arguments travel as they are whether or not the project serializes. */
	raw: Networking.RawReliable<(value: number) => void>;

	stats: { report(value: number): void };

	/** The server's answer to `rename`: the name, and how many renames it has accepted so far. */
	renamed(name: string, accepted: number): void;

	/** The server's answer to `bump`: how many it has accepted, and how many arguments the last one carried on the wire. */
	bumped(accepted: number, argumentsOnWire: number): void;

	/** The server's answer to `sortA` and `sortB`: which event, and the value as it decoded it. */
	sorted(entry: string): void;
}

export const SpecEvents = Networking.createEvent<SpecServerEvents, SpecClientEvents>();

/**
 * The decoder for an argument list when the project enables `networking.serialization`, and
 * `undefined` otherwise, so these specs run in either mode and describe what the remote really
 * carries. Encoding lives at call sites only, so the specs pack simulated traffic with a serializer
 * for the same tuple type, which produces the same bytes.
 * @metadata macro
 */
function wireDecoder<T extends unknown[]>(
	meta?: Modding.Intrinsic<"network-decoder", [T], Serialization.Decoder<T> | undefined>,
): Serialization.Decoder<T> | undefined {
	return meta;
}

export interface Wire<T extends unknown[]> {
	decode: Serialization.Decoder<T> | undefined;
	pack: Serialization.Serializer<T>;
}

export const wire = {
	number: { decode: wireDecoder<[number]>(), pack: Flamework.createSerializer<[number]>() },
	text: { decode: wireDecoder<[string]>(), pack: Flamework.createSerializer<[string]>() },
};

/** Whether the project serializes, which is what decides what a remote carries. */
export const SERIALIZED = wire.number.decode !== undefined;

/** The arguments a message carried, decoded when they went out serialized. */
export function carried<T extends unknown[]>(wire: Wire<T>, args: unknown[]): T {
	if (wire.decode === undefined) return args as T;
	return wire.decode(args[0] as buffer, (args[1] ?? []) as Array<defined>);
}

/** Arguments as the other realm would put them on the wire. */
export function onWire<T extends unknown[]>(wire: Wire<T>, ...args: T): unknown[] {
	if (wire.decode === undefined) return args;
	const [payload, blobs] = wire.pack.serialize(args);
	return blobs ? [payload, blobs] : [payload];
}

/** Both remote classes fire and listen alike, so an unreliable one is handled through the reliable type. */
type SpecRemote = RemoteEvent;

function isRemote(instance: Instance): instance is SpecRemote {
	return instance.IsA("RemoteEvent") || instance.IsA("UnreliableRemoteEvent");
}

/**
 * The folder Flamework published this suite's remotes into, found by the one remote whose id only
 * this suite declares. `undefined` where nothing is published: a Luau execution task never runs
 * the place, and `createRemoteInstance` keeps its remotes unparented there.
 */
export function specNamespace(): Folder | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (isRemote(descendant) && descendant.GetAttribute("id") === "setScore") {
			return descendant.Parent as Folder;
		}
	}
}

/** The published remote with this id, by the `id` attribute Flamework looks remotes up by. */
export function findSpecRemote(id: string): SpecRemote | undefined {
	const namespace = specNamespace();
	if (namespace === undefined) return undefined;

	for (const child of namespace.GetChildren()) {
		if (isRemote(child) && child.GetAttribute("id") === id) {
			return child;
		}
	}
}
