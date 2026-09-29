import { Networking } from "@flamework-experimental/networking";

/*
 * Members that opt into serialization one by one, whatever the project's `networking.serialization`
 * says. The fixture builds with the switch on; the tests build it again with
 * FLAMEWORK_FIXTURE_SERIALIZATION=false and compare.
 */

interface Item {
	id: number;
	name: string;
	count: number;
}

interface ServerEvents {
	plainPing(value: number): void;
	serializedPing: Networking.SerializedReliable<(value: number) => void>;
	/** An Instance travels next to the buffer, in the blob list. */
	serializedPlace: Networking.SerializedReliable<(items: Item[], where: Instance) => void>;
	/** Carries nothing, so it sends nothing. */
	serializedBump: Networking.SerializedReliable<() => void>;
	rawPing: Networking.RawReliable<(value: number) => void>;

	/** Unreliable: the alias and both nesting orders. */
	serializedMove: Networking.SerializedUnreliable<(value: number) => void>;
	unreliableSerialized: Networking.Unreliable<Networking.Serialized<(value: number) => void>>;
	serializedUnreliable: Networking.SerializedReliable<Networking.Unreliable<(value: number) => void>>;

	/** Second members packed like `plainPing`, `serializedPing` and `rawPing`, for targets that may be either. */
	plainPingToo(value: number): void;
	serializedPingToo: Networking.SerializedReliable<(value: number) => void>;
	rawPingToo: Networking.RawReliable<(value: number) => void>;

	/** An argument list with an element after its rest. */
	restList(...args: [number, ...string[], boolean]): void;
}

interface ClientEvents {
	serializedPong: Networking.SerializedReliable<(items: Item[]) => void>;
}

interface ServerFunctions {
	plainLookup(id: number): string;
	serializedLookup: Networking.Serialized<(ids: number[]) => Item[]>;
	serializedNothing: Networking.Serialized<() => void>;
	serializedLookupToo: Networking.Serialized<(ids: number[]) => Item[]>;
}

interface ClientFunctions {
	serializedAsk: Networking.Serialized<(question: string) => Item[]>;
}

export const modeEvents = Networking.createEvent<ServerEvents, ClientEvents>();
export const modeFunctions = Networking.createFunction<ServerFunctions, ClientFunctions>();
export const modeServer = modeEvents.createServer({});
export const modeClient = modeEvents.createClient({});
export const modeServerFunctions = modeFunctions.createServer({});
export const modeClientFunctions = modeFunctions.createClient({});

export function plainSend(value: number) {
	modeClient.plainPing.fire(value);
}

export function serializedSend(value: number) {
	modeClient.serializedPing.fire(value);
}

export function serializedPlaceSend(items: Item[], where: Instance) {
	modeClient.serializedPlace.fire(items, where);
}

export function serializedBumpSend() {
	modeClient.serializedBump.fire();
}

export function rawSend(value: number) {
	modeClient.rawPing.fire(value);
}

export function unreliableSends(value: number) {
	modeClient.serializedMove.fire(value);
	modeClient.unreliableSerialized.fire(value);
	modeClient.serializedUnreliable.fire(value);
}

export function serverSends(player: Player, items: Item[]) {
	modeServer.serializedPong.fire(player, items);
	modeServer.serializedPong.broadcast(items);
	modeServer.serializedPong.except(player, items);
}

export function lookups(id: number, ids: number[]) {
	modeClientFunctions.plainLookup.invoke(id);
	modeClientFunctions.serializedNothing.invoke();
	return modeClientFunctions.serializedLookup.invoke(ids);
}

export function ask(player: Player) {
	return modeServerFunctions.serializedAsk.invoke(player, "what?");
}

modeServerFunctions.plainLookup.setCallback((player, id) => `${id}`);
modeServerFunctions.serializedLookup.setCallback((player, ids) => ids.map((id) => ({ id, name: "sword", count: 1 })));
modeServerFunctions.serializedNothing.setCallback(() => {});
modeClientFunctions.serializedAsk.setCallback((question) => [{ id: 1, name: question, count: 2 }]);

/*
 * Targets that may be either of two members packed the same way: each call packs, or is left alone,
 * as a call on one of them would be. Members packed differently are refused (networkModes.test.ts).
 */
export function eitherSend(flag: boolean, value: number) {
	(flag ? modeClient.serializedPing : modeClient.serializedPingToo).fire(value);
	(flag ? modeClient.plainPing : modeClient.plainPingToo).fire(value);
	(flag ? modeClient.rawPing : modeClient.rawPingToo).fire(value);
}

export function eitherLookup(flag: boolean, ids: number[]) {
	return (flag ? modeClientFunctions.serializedLookup : modeClientFunctions.serializedLookupToo).invoke(ids);
}

export function eitherCallback(flag: boolean) {
	(flag ? modeServerFunctions.serializedLookup : modeServerFunctions.serializedLookupToo).setCallback((player, ids) =>
		ids.map((id) => ({ id, name: "shield", count: 2 })),
	);
}

export function restListSend(value: number) {
	modeClient.restList.fire(value, "a", "b", true);
}
