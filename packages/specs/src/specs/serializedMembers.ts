import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking, NetworkingFunctionError } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import { expectDefined, expectEqual, expectRejects, expectResolves, expectTrue, suite } from "../testkit";

/*
 * Members that opt into packing one by one (`Networking.Serialized*`). Nothing here depends on the
 * project's `networking.serialization`: a serialized member is packed either way, so these specs hold
 * in both builds. The round trips between two realms are in `replication.ts`; these cover one realm's
 * half, with the other simulated.
 */

interface Item {
	id: number;
	name: string;
	count: number;
}

/** Declared in both directions, so one spec body covers both realms. */
interface Bidirectional {
	serializedItems: Networking.SerializedReliable<(items: Item[]) => void>;
	serializedPlace: Networking.SerializedReliable<(items: Item[], where: Instance) => void>;
	serializedBump: Networking.SerializedReliable<() => void>;
	serializedMove: Networking.SerializedUnreliable<(items: Item[]) => void>;

	/** A guard that the decoded values have to pass, and middleware that records what it is given. */
	serializedPart: Networking.SerializedReliable<(part: Part, label: string) => void>;

	/** A plain member whose argument is a tuple with a rest element. */
	tagged(entry: [number, ...string[]]): void;

	/** Tuples with a rest element last, first or in the middle: as the one argument, and as the list. */
	restLast(entry: [number, ...string[]]): void;
	restFirst(entry: [...string[], boolean]): void;
	restMiddle(entry: [number, ...string[], boolean]): void;
	restLastArgs(...args: [number, ...string[]]): void;
	restFirstArgs(...args: [...string[], boolean]): void;
	restMiddleArgs(...args: [number, ...string[], boolean]): void;
	serializedRestMiddleArgs: Networking.SerializedReliable<(...args: [number, ...string[], boolean]) => void>;
}

interface BidirectionalFunctions {
	serializedLookup: Networking.Serialized<(ids: number[]) => Item[]>;
}

const GlobalEvents = Networking.createEvent<Bidirectional, Bidirectional>();
const GlobalFunctions = Networking.createFunction<BidirectionalFunctions, BidirectionalFunctions>();

declare const __harness: {
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

interface Inbound {
	Fire(this: unknown, ...args: unknown[]): void;
}

const isServer = RunService.IsServer();
const requester = __harness.newPlayer("Packer") as Player;

/** What the middleware on `serializedPart` was handed. */
const middlewareSaw = new Array<defined>();
const recordPart: Networking.EventMiddleware<[part: Part, label: string]> = (processNext) => {
	return (player, part, label) => {
		middlewareSaw.push(part, label);
		return processNext(player, part, label);
	};
};

/** Wraps what `serializedLookup` returns, so a result is seen to be packed after the middleware. */
const renameResult: Networking.FunctionMiddleware<[ids: number[]], Item[]> = (processNext) => {
	return (player, ids) => {
		const result = processNext(player, ids);
		if (!typeIs(result, "table") || result === Networking.Skip) return result;
		return (result as Item[]).map((item) => ({ ...item, name: `${item.name}/middleware` }));
	};
};

const badRequests = new Array<{ argIndex: number; argValue: unknown }>();
GlobalEvents.registerHandler("onBadRequest", (_player, data) => badRequests.push(data));

const badResponses = new Array<defined>();
GlobalFunctions.registerHandler("onBadResponse", (_player, data) => badResponses.push(data.value as defined));

type ServerEvents = ReturnType<typeof GlobalEvents.createServer>;
type ClientEvents = ReturnType<typeof GlobalEvents.createClient>;
type ServerFunctions = ReturnType<typeof GlobalFunctions.createServer>;
type ClientFunctions = ReturnType<typeof GlobalFunctions.createClient>;

let events: { server?: ServerEvents; client?: ClientEvents } | undefined;
let functions: { server?: ServerFunctions; client?: ClientFunctions } | undefined;

/** The realm's handlers. Remotes are the server's to create, so a client spec primes them first. */
function handlers() {
	if (events !== undefined && functions !== undefined) return { events, functions };

	if (isServer) {
		events = { server: GlobalEvents.createServer({ middleware: { serializedPart: [recordPart] } }) };
		functions = { server: GlobalFunctions.createServer({ middleware: { serializedLookup: [renameResult] } }) };
	} else {
		__harness.asRealm("Server", () => {
			GlobalEvents.createServer({});
			GlobalFunctions.createServer({});
			__harness.flush();
		});
		events = { client: GlobalEvents.createClient({ middleware: { serializedPart: [recordPart] } }) };
		functions = { client: GlobalFunctions.createClient({ middleware: { serializedLookup: [renameResult] } }) };
	}

	__harness.flush();
	return { events, functions };
}

function remote(name: string) {
	return expectDefined(__harness.findRemote(name), `${name} remote`);
}

function remoteById(id: string) {
	return expectDefined(__harness.findRemoteById(id), `remote ${id}`);
}

/** Delivers a message as the other realm would, adding the sender on the server. */
function deliver(channel: Instance, ...args: unknown[]) {
	const signals = channel as unknown as { OnServerEvent: Inbound; OnClientEvent: Inbound };
	if (isServer) {
		signals.OnServerEvent.Fire(requester, ...args);
	} else {
		signals.OnClientEvent.Fire(...args);
	}
}

const itemsCodec = Flamework.createSerializer<[Item[]]>();
const itemsWhereCodec = Flamework.createSerializer<[Item[], Instance]>();
const partCodec = Flamework.createSerializer<[Part, string]>();
const idsCodec = Flamework.createSerializer<[number[]]>();

/**
 * The encoding a plain member uses: `undefined` when the project leaves `networking.serialization`
 * off, which is how a spec tells the two builds apart.
 * @metadata macro
 */
function wireDecoder<T extends unknown[]>(
	meta?: Modding.Intrinsic<"network-decoder", [T], Serialization.Decoder<T> | undefined>,
): Serialization.Decoder<T> | undefined {
	return meta;
}

/** `restMiddleArgs`'s encoding, or `undefined` without networking.serialization. */
const restMiddleWire =
	wireDecoder<[number, ...string[], boolean]>() !== undefined
		? { pack: Flamework.createSerializer<[number, ...string[], boolean]>() }
		: undefined;

const taggedWire = {
	decode: wireDecoder<[[number, ...string[]]]>(),
	pack: Flamework.createSerializer<[[number, ...string[]]]>(),
};

/** A list of values as one line, for comparing what arrived with what was sent. */
function show(name: string, values: ReadonlyArray<unknown>) {
	const parts = new Array<string>();
	for (const value of values) parts.push(tostring(value));
	return `${name}:${parts.join(",")}`;
}

function makeItems(count: number, name = "sword") {
	const items = new Array<Item>();
	for (const id of $range(1, count)) items.push({ id, name, count: id % 7 });
	return items;
}

export = suite("networking serialized members", [
	[
		"packs a serialized member into a buffer, whatever networking.serialization says",
		() => {
			const { events } = handlers();
			const channel = remote("serializedItems");
			__harness.clearSent(channel);

			if (events.server !== undefined) events.server.serializedItems.fire(requester, makeItems(3));
			else events.client!.serializedItems.fire(makeItems(3));

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "messages");
			expectTrue(typeIs(sent[0].args[0], "buffer"), "a buffer on the wire");
			const [items] = itemsCodec.deserialize(sent[0].args[0] as buffer);
			expectEqual(items.size(), 3, "items");
			expectEqual(items[2].id, 3, "last item");
		},
	],
	[
		"sends an Instance next to the buffer, in the blob list",
		() => {
			const { events } = handlers();
			const channel = remote("serializedPlace");
			__harness.clearSent(channel);

			const where = new Instance("Folder");
			where.Name = "Where";
			if (events.server !== undefined) events.server.serializedPlace.fire(requester, makeItems(1), where);
			else events.client!.serializedPlace.fire(makeItems(1), where);

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "messages");
			const blobs = sent[0].args[1] as Array<defined>;
			expectEqual(blobs.size(), 1, "blobs next to the buffer");
			expectEqual(blobs[0], where, "the Instance");

			const [items, blob] = itemsWhereCodec.deserialize(sent[0].args[0] as buffer, blobs);
			expectEqual(items[0].name, "sword", "decoded");
			expectEqual(blob, where, "blob slot");
		},
	],
	[
		"sends nothing for a serialized member without arguments, and accepts it bare",
		() => {
			const { events } = handlers();
			const channel = remote("serializedBump");
			__harness.clearSent(channel);

			let received = 0;
			if (events.server !== undefined) {
				events.server.serializedBump.connect(() => received++);
				events.server.serializedBump.fire(requester);
			} else {
				events.client!.serializedBump.connect(() => received++);
				events.client!.serializedBump.fire();
			}
			__harness.flush();

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "messages");
			expectEqual(sent[0].args.size(), 0, "arguments on the wire");

			deliver(channel);
			expectEqual(received, 1, "bare message accepted");
		},
	],
	[
		"puts a serialized unreliable member on an UnreliableRemoteEvent, packed",
		() => {
			const { events } = handlers();
			const channel = expectDefined(__harness.findRemoteById("unreliable:serializedMove"), "unreliable channel");
			expectEqual(channel.ClassName, "UnreliableRemoteEvent", "remote class");
			__harness.clearSent(channel);

			if (events.server !== undefined) events.server.serializedMove.broadcast(makeItems(2));
			else events.client!.serializedMove.fire(makeItems(2));

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "messages");
			expectEqual(itemsCodec.deserialize(sent[0].args[0] as buffer)[0].size(), 2, "packed items");
		},
	],
	[
		"decodes before the guards, the middleware and the handlers",
		() => {
			const { events } = handlers();
			const channel = remote("serializedPart");
			const received = new Array<defined>();
			if (events.server !== undefined)
				events.server.serializedPart.connect((_player, part, label) => received.push(part, label));
			else events.client!.serializedPart.connect((part, label) => received.push(part, label));
			__harness.flush();
			middlewareSaw.clear();
			badRequests.clear();

			const part = new Instance("Part");
			const [payload, blobs] = partCodec.serialize([part, "hello"]);
			deliver(channel, payload, blobs);

			expectEqual(middlewareSaw.size(), 2, "values the middleware saw");
			expectEqual(middlewareSaw[0], part, "the Instance, from the blob list");
			expectEqual(middlewareSaw[1], "hello", "the decoded string");
			expectEqual(received[1], "hello", "the handler's value");

			// A Folder where a Part is declared decodes fine and then fails the guard, ahead of the middleware.
			const [wrong, wrongBlobs] = partCodec.serialize([new Instance("Folder") as never, "folder"]);
			deliver(channel, wrong, wrongBlobs);
			expectEqual(middlewareSaw.size(), 2, "the middleware never saw the rejected message");
			expectEqual(badRequests.size(), 1, "onBadRequest events");
			expectEqual(badRequests[0].argIndex, 0, "the guard's argument index");
		},
	],
	[
		"drops a payload that cannot be decoded, through the malformed path",
		() => {
			const { events } = handlers();
			const channel = remote("serializedItems");
			const received = new Array<Item[]>();
			if (events.server !== undefined)
				events.server.serializedItems.connect((_player, items) => received.push(items));
			else events.client!.serializedItems.connect((items) => received.push(items));
			__harness.flush();
			badRequests.clear();

			// Plain values where a buffer is expected, and a buffer cut short.
			deliver(channel, makeItems(2));
			const [payload] = itemsCodec.serialize([makeItems(2)]);
			const cut = buffer.create(buffer.len(payload) - 3);
			buffer.copy(cut, 0, payload, 0, buffer.len(cut));
			deliver(channel, cut);

			expectEqual(received.size(), 0, "messages accepted");
			expectEqual(badRequests.size(), 2, "reported as malformed");
			expectEqual(badRequests[0].argIndex, -1, "no argument index");
			expectEqual(badRequests[1].argIndex, -1, "no argument index for the cut buffer");
		},
	],
	[
		"packs a serialized function's request, and its result after the middleware",
		() => {
			const { functions } = handlers();
			if (functions.server !== undefined)
				functions.server.serializedLookup.setCallback((_player, ids) => makeItems(ids.size()));
			else functions.client!.serializedLookup.setCallback((ids) => makeItems(ids.size()));

			// The receive channel answers on itself.
			const receive = remoteById(`${isServer ? "$" : "@"}serializedLookup`);
			__harness.clearSent(receive);
			const [ids] = idsCodec.serialize([[1, 2, 3]]);
			deliver(receive, 5, ids);

			const response = __harness.sent(receive);
			expectEqual(response.size(), 1, "responses");
			expectEqual(response[0].args[0], 5, "request id");
			expectEqual(response[0].args[1], true, "process result");
			const [items] = itemsCodec.deserialize(response[0].args[2] as buffer);
			expectEqual(items.size(), 3, "result items");
			expectEqual(items[0].name, "sword/middleware", "the middleware's result, packed");

			// The request this realm sends is packed too, and the result it gets back decoded.
			const send = remoteById(`${isServer ? "@" : "$"}serializedLookup`);
			__harness.clearSent(send);
			const request =
				functions.server !== undefined
					? functions.server.serializedLookup.invoke(requester, [4, 5])
					: functions.client!.serializedLookup.invoke([4, 5]);
			const sent = __harness.sent(send);
			expectEqual(sent.size(), 1, "requests");
			expectEqual(idsCodec.deserialize(sent[0].args[1] as buffer)[0][1], 5, "the packed request");

			deliver(send, sent[0].args[0], true, itemsCodec.serialize([makeItems(2)])[0]);
			expectEqual(expectResolves(request).size(), 2, "the decoded result");
		},
	],
	[
		"rejects with InvalidResult a serialized result that cannot be decoded",
		() => {
			const { functions } = handlers();
			badResponses.clear();
			const send = remoteById(`${isServer ? "@" : "$"}serializedLookup`);
			__harness.clearSent(send);

			const request =
				functions.server !== undefined
					? functions.server.serializedLookup.invoke(requester, [1])
					: functions.client!.serializedLookup.invoke([1]);
			deliver(send, __harness.sent(send)[0].args[0], true, "not a buffer");

			expectEqual(expectRejects(request, "malformed result"), NetworkingFunctionError.InvalidResult, "rejection");
			expectEqual(badResponses.size(), 1, "onBadResponse events");
		},
	],
	[
		"accepts a tuple argument with a rest element of any length",
		() => {
			const { events } = handlers();
			const channel = remote("tagged");
			const received = new Array<[number, ...string[]]>();
			if (events.server !== undefined) events.server.tagged.connect((_player, entry) => received.push(entry));
			else events.client!.tagged.connect((entry) => received.push(entry));
			__harness.flush();
			badRequests.clear();

			const onWire = (entry: [number, ...string[]]) => {
				if (taggedWire.decode === undefined) return [entry];
				const [payload] = taggedWire.pack.serialize([entry]);
				return [payload];
			};

			deliver(channel, ...onWire([1]));
			deliver(channel, ...onWire([2, "a", "b"]));
			if (taggedWire.decode === undefined) {
				// Unpacked, values the type does not allow reach the guard.
				deliver(channel, [3, 4]);
				deliver(channel, ["a"]);
			}

			expectEqual(received.size(), 2, "entries accepted");
			expectEqual(received[0].size(), 1, "the fixed element alone");
			expectEqual(received[1][2], "b", "the rest elements");
			expectEqual(badRequests.size(), taggedWire.decode === undefined ? 2 : 0, "entries rejected");
		},
	],
	[
		"round-trips tuples with a rest element anywhere, as an argument and as the argument list",
		() => {
			const { events } = handlers();
			const seen = new Array<string>();
			if (events.server !== undefined) {
				const server = events.server;
				server.restLast.connect((_player, entry) => seen.push(show("restLast", entry)));
				server.restFirst.connect((_player, entry) => seen.push(show("restFirst", entry)));
				server.restMiddle.connect((_player, entry) => seen.push(show("restMiddle", entry)));
				server.restLastArgs.connect((_player, ...args) => seen.push(show("restLastArgs", args)));
				server.restFirstArgs.connect((_player, ...args) => seen.push(show("restFirstArgs", args)));
				server.restMiddleArgs.connect((_player, ...args) => seen.push(show("restMiddleArgs", args)));
				server.serializedRestMiddleArgs.connect((_player, ...args) => seen.push(show("serialized", args)));
			} else {
				const client = events.client!;
				client.restLast.connect((entry) => seen.push(show("restLast", entry)));
				client.restFirst.connect((entry) => seen.push(show("restFirst", entry)));
				client.restMiddle.connect((entry) => seen.push(show("restMiddle", entry)));
				client.restLastArgs.connect((...args) => seen.push(show("restLastArgs", args)));
				client.restFirstArgs.connect((...args) => seen.push(show("restFirstArgs", args)));
				client.restMiddleArgs.connect((...args) => seen.push(show("restMiddleArgs", args)));
				client.serializedRestMiddleArgs.connect((...args) => seen.push(show("serialized", args)));
			}
			__harness.flush();
			badRequests.clear();

			// What the member sends goes back in as the other realm would deliver it.
			const bounce = (name: string, send: () => void) => {
				const channel = remote(name);
				__harness.clearSent(channel);
				send();
				const sent = __harness.sent(channel);
				expectEqual(sent.size(), 1, `${name}: messages`);
				deliver(channel, ...sent[0].args);
				return sent[0].args;
			};

			let wire: Array<unknown>;
			if (events.server !== undefined) {
				const server = events.server;
				bounce("restLast", () => server.restLast.fire(requester, [1]));
				bounce("restLast", () => server.restLast.fire(requester, [1, "a", "b"]));
				bounce("restFirst", () => server.restFirst.fire(requester, [true]));
				bounce("restFirst", () => server.restFirst.fire(requester, ["a", "b", false]));
				bounce("restMiddle", () => server.restMiddle.fire(requester, [1, true]));
				bounce("restMiddle", () => server.restMiddle.fire(requester, [1, "a", "b", false]));
				bounce("restLastArgs", () => server.restLastArgs.fire(requester, 1));
				bounce("restLastArgs", () => server.restLastArgs.fire(requester, 1, "a", "b"));
				bounce("restFirstArgs", () => server.restFirstArgs.fire(requester, true));
				bounce("restFirstArgs", () => server.restFirstArgs.fire(requester, "a", "b", false));
				bounce("restMiddleArgs", () => server.restMiddleArgs.fire(requester, 1, true));
				bounce("restMiddleArgs", () => server.restMiddleArgs.fire(requester, 1, "a", "b", false));
				wire = bounce("serializedRestMiddleArgs", () =>
					server.serializedRestMiddleArgs.fire(requester, 1, "a", "b", false),
				);
			} else {
				const client = events.client!;
				bounce("restLast", () => client.restLast.fire([1]));
				bounce("restLast", () => client.restLast.fire([1, "a", "b"]));
				bounce("restFirst", () => client.restFirst.fire([true]));
				bounce("restFirst", () => client.restFirst.fire(["a", "b", false]));
				bounce("restMiddle", () => client.restMiddle.fire([1, true]));
				bounce("restMiddle", () => client.restMiddle.fire([1, "a", "b", false]));
				bounce("restLastArgs", () => client.restLastArgs.fire(1));
				bounce("restLastArgs", () => client.restLastArgs.fire(1, "a", "b"));
				bounce("restFirstArgs", () => client.restFirstArgs.fire(true));
				bounce("restFirstArgs", () => client.restFirstArgs.fire("a", "b", false));
				bounce("restMiddleArgs", () => client.restMiddleArgs.fire(1, true));
				bounce("restMiddleArgs", () => client.restMiddleArgs.fire(1, "a", "b", false));
				wire = bounce("serializedRestMiddleArgs", () =>
					client.serializedRestMiddleArgs.fire(1, "a", "b", false),
				);
			}
			expectTrue(typeIs(wire[0], "buffer"), "a serialized member's list, packed");

			const expected = [
				"restLast:1",
				"restLast:1,a,b",
				"restFirst:true",
				"restFirst:a,b,false",
				"restMiddle:1,true",
				"restMiddle:1,a,b,false",
				"restLastArgs:1",
				"restLastArgs:1,a,b",
				"restFirstArgs:true",
				"restFirstArgs:a,b,false",
				"restMiddleArgs:1,true",
				"restMiddleArgs:1,a,b,false",
				"serialized:1,a,b,false",
			];
			expectEqual(seen.size(), expected.size(), "values received");
			expected.forEach((line, index) => expectEqual(seen[index], line, `received #${index + 1}`));
			expectEqual(badRequests.size(), 0, "nothing rejected");
		},
	],
	[
		"checks the arguments after a rest parameter with their own guards",
		() => {
			const { events } = handlers();
			let received = 0;
			if (events.server !== undefined) {
				events.server.restMiddleArgs.connect(() => received++);
				events.server.restFirstArgs.connect(() => received++);
			} else {
				events.client!.restMiddleArgs.connect(() => received++);
				events.client!.restFirstArgs.connect(() => received++);
			}
			__harness.flush();
			badRequests.clear();

			if (restMiddleWire === undefined) {
				// Sent as they are: what reaches the guards is what was delivered.
				deliver(remote("restMiddleArgs"), 1, "a", "b", true);
				deliver(remote("restFirstArgs"), false);
				expectEqual(received, 2, "arguments that fit");

				deliver(remote("restMiddleArgs"), 1, "a", "b");
				deliver(remote("restMiddleArgs"), 1, 2, true);
				deliver(remote("restFirstArgs"), "a", "b");
				expectEqual(received, 2, "arguments that do not fit");
				expectEqual(badRequests.size(), 3, "rejected");
				expectEqual(badRequests[0].argIndex, 2, "the last argument, checked as the one after the rest");
				expectEqual(badRequests[1].argIndex, 1, "a rest argument");
				expectEqual(badRequests[2].argIndex, 1, "the last argument, after a rest");
			} else {
				const [payload] = restMiddleWire.pack.serialize([1, "a", "b", true]);
				deliver(remote("restMiddleArgs"), payload);
				expectEqual(received, 1, "a packed list that fits");
				expectEqual(badRequests.size(), 0, "nothing rejected");
			}
		},
	],
]);
