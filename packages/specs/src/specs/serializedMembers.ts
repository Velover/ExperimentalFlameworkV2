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

	/** Its types can hold an Instance, which a call may leave out; middleware records what it is given. */
	serializedMaybe: Networking.SerializedReliable<(label: string, where?: Instance) => void>;

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

	/** A request and a result that can each hold an Instance or leave it out; middleware records the request. */
	serializedFind: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
}

const GlobalEvents = Networking.createEvent<Bidirectional, Bidirectional>();
const GlobalFunctions = Networking.createFunction<BidirectionalFunctions, BidirectionalFunctions>();

/**
 * A message a remote sent. `args` is what the harness's `table.pack` made of the call, so `n` is
 * `select("#", ...)`: every argument the remote was handed, a trailing nil included.
 */
interface Recorded {
	kind: string;
	player?: Instance;
	args: Array<unknown> & { readonly n: number };
}

declare const __harness: {
	sent: (remote: Instance) => Array<Recorded>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	removePlayer: (player: Instance) => void;
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

/** What the middleware on `serializedMaybe` and `serializedFind` was handed, as `label@where`. */
const maybeSaw = new Array<string>();
function describeWhere(label: string, where?: Instance) {
	return `${label}@${where !== undefined ? where.Name : "none"}`;
}

const recordMaybe: Networking.EventMiddleware<[label: string, where?: Instance]> = (processNext) => {
	return (player, label, where) => {
		maybeSaw.push(describeWhere(label, where));
		return processNext(player, label, where);
	};
};

const recordFind: Networking.FunctionMiddleware<[label: string, where?: Instance], Instance | undefined> = (
	processNext,
) => {
	return (player, label, where) => {
		maybeSaw.push(`find:${describeWhere(label, where)}`);
		return processNext(player, label, where);
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
		events = {
			server: GlobalEvents.createServer({
				middleware: { serializedPart: [recordPart], serializedMaybe: [recordMaybe] },
			}),
		};
		functions = {
			server: GlobalFunctions.createServer({
				middleware: { serializedLookup: [renameResult], serializedFind: [recordFind] },
			}),
		};
	} else {
		__harness.asRealm("Server", () => {
			GlobalEvents.createServer({});
			GlobalFunctions.createServer({});
			__harness.flush();
		});
		events = {
			client: GlobalEvents.createClient({
				middleware: { serializedPart: [recordPart], serializedMaybe: [recordMaybe] },
			}),
		};
		functions = {
			client: GlobalFunctions.createClient({
				middleware: { serializedLookup: [renameResult], serializedFind: [recordFind] },
			}),
		};
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
		"leaves an empty blob list off an event, and sends a full one as before",
		() => {
			const { events } = handlers();
			const channel = remote("serializedMaybe");
			const received = new Array<string>();
			if (events.server !== undefined)
				events.server.serializedMaybe.connect((_player, label, where) =>
					received.push(describeWhere(label, where)),
				);
			else events.client!.serializedMaybe.connect((label, where) => received.push(describeWhere(label, where)));
			__harness.flush();
			maybeSaw.clear();
			badRequests.clear();

			const where = new Instance("Folder");
			where.Name = "Spot";
			__harness.clearSent(channel);
			if (events.server !== undefined) {
				events.server.serializedMaybe.fire(requester, "bare");
				events.server.serializedMaybe.fire(requester, "placed", where);
			} else {
				events.client!.serializedMaybe.fire("bare");
				events.client!.serializedMaybe.fire("placed", where);
			}

			// A copy: the harness's list is the remote's own, which `clearSent` empties.
			const sent = [...__harness.sent(channel)];
			expectEqual(sent.size(), 2, "messages");
			expectEqual(sent[0].args.n, 1, "arguments without an Instance (the payload alone)");
			expectTrue(typeIs(sent[0].args[0], "buffer"), "the payload");
			expectEqual(sent[1].args.n, 2, "arguments with an Instance (the payload and the blob list)");
			const blobs = sent[1].args[1] as Array<defined>;
			expectEqual(blobs.size(), 1, "the blob list's size");
			expectEqual(blobs[0], where, "the Instance in the blob list");

			// The count is the engine's: a nil handed to the remote is an argument, which costs a byte.
			__harness.clearSent(channel);
			(channel as RemoteEvent).FireServer(sent[0].args[0], undefined);
			expectEqual(__harness.sent(channel)[0].args.n, 2, "arguments counted with a trailing nil");

			// Each goes back in as the other realm would deliver it, and the first once more as a sender
			// that still sends an empty list would put it.
			deliver(channel, ...sent[0].args);
			deliver(channel, ...sent[1].args);
			deliver(channel, sent[0].args[0], []);

			const expected = ["bare@none", "placed@Spot", "bare@none"];
			expectEqual(received.size(), expected.size(), "messages received");
			expectEqual(maybeSaw.size(), expected.size(), "messages the middleware saw");
			expected.forEach((line, index) => {
				expectEqual(received[index], line, `received #${index + 1}`);
				expectEqual(maybeSaw[index], line, `the middleware's #${index + 1}`);
			});
			expectEqual(badRequests.size(), 0, "messages rejected");
		},
	],
	[
		"leaves an empty blob list off a broadcast and an except, and sends a full one as before",
		() => {
			// Both are the server's alone; the client's `fire` is the case above.
			if (!isServer) return;

			const server = handlers().events.server!;
			const channel = remote("serializedMaybe");
			const received = new Array<string>();
			server.serializedMaybe.connect((_player, label, where) => received.push(describeWhere(label, where)));
			__harness.flush();
			maybeSaw.clear();
			badRequests.clear();

			const where = new Instance("Folder");
			where.Name = "Everywhere";
			const excluded = __harness.newPlayer("Excluded") as Player;

			__harness.clearSent(channel);
			server.serializedMaybe.broadcast("all");
			server.serializedMaybe.broadcast("all", where);
			const broadcasts = [...__harness.sent(channel)];
			expectEqual(broadcasts.size(), 2, "broadcasts");
			expectEqual(broadcasts[0].kind, "FireAllClients", "the broadcast's dispatch");
			expectEqual(broadcasts[0].args.n, 1, "a broadcast's arguments without an Instance");
			expectEqual(broadcasts[1].args.n, 2, "a broadcast's arguments with an Instance");
			expectEqual((broadcasts[1].args[1] as Array<defined>)[0], where, "the broadcast's blob list");

			__harness.clearSent(channel);
			server.serializedMaybe.except(excluded, "most");
			const bare = [...__harness.sent(channel)];
			__harness.clearSent(channel);
			server.serializedMaybe.except([excluded], "most", where);
			const full = [...__harness.sent(channel)];
			__harness.removePlayer(excluded);

			expectTrue(
				bare.some((message) => message.player === requester),
				"an except reached the requester",
			);
			expectEqual(full.size(), bare.size(), "messages of each except");
			for (const message of bare) {
				expectEqual(message.kind, "FireClient", "an except's dispatch");
				expectTrue(message.player !== excluded, "an except left out the excluded player");
				expectEqual(message.args.n, 1, "an except's arguments without an Instance");
			}
			for (const message of full) {
				expectTrue(message.player !== excluded, "an except left out the excluded player");
				expectEqual(message.args.n, 2, "an except's arguments with an Instance");
				expectEqual((message.args[1] as Array<defined>)[0], where, "an except's blob list");
			}

			deliver(channel, ...broadcasts[0].args);
			deliver(channel, ...broadcasts[1].args);
			deliver(channel, ...bare[0].args);
			deliver(channel, ...full[0].args);

			const expected = ["all@none", "all@Everywhere", "most@none", "most@Everywhere"];
			expectEqual(received.size(), expected.size(), "messages received");
			expectEqual(maybeSaw.size(), expected.size(), "messages the middleware saw");
			expected.forEach((line, index) => {
				expectEqual(received[index], line, `received #${index + 1}`);
				expectEqual(maybeSaw[index], line, `the middleware's #${index + 1}`);
			});
			expectEqual(badRequests.size(), 0, "messages rejected");
		},
	],
	[
		"leaves an empty blob list off a function's request and its result, and sends full ones as before",
		() => {
			const { functions } = handlers();
			const given = new Instance("Folder");
			given.Name = "Given";

			// `give` answers with an Instance of its own, `drop` with none, `echo` with what it was sent.
			const answer = (label: string, where?: Instance) =>
				label === "give" ? given : label === "drop" ? undefined : where;
			if (functions.server !== undefined)
				functions.server.serializedFind.setCallback((_player, label, where) => answer(label, where));
			else functions.client!.serializedFind.setCallback((label, where) => answer(label, where));
			maybeSaw.clear();

			const where = new Instance("Folder");
			where.Name = "Asked";

			// The request this realm sends goes into its own receiver as the other realm's would, and the
			// result that receiver sends back answers the request. A request is `(id, payload, blobs?)`
			// and a result `(id, true, payload, blobs?)`.
			const send = remoteById(`${isServer ? "@" : "$"}serializedFind`);
			const receive = remoteById(`${isServer ? "$" : "@"}serializedFind`);
			const roundTrip = (
				label: string,
				asked: Instance | undefined,
				requestCount: number,
				resultCount: number,
			) => {
				__harness.clearSent(send);
				__harness.clearSent(receive);
				const request =
					functions.server !== undefined
						? asked !== undefined
							? functions.server.serializedFind.invoke(requester, label, asked)
							: functions.server.serializedFind.invoke(requester, label)
						: asked !== undefined
							? functions.client!.serializedFind.invoke(label, asked)
							: functions.client!.serializedFind.invoke(label);

				const requests = __harness.sent(send);
				expectEqual(requests.size(), 1, `${label}: requests`);
				expectEqual(requests[0].args.n, requestCount, `${label}: the request's arguments`);
				deliver(receive, ...requests[0].args);

				const results = __harness.sent(receive);
				expectEqual(results.size(), 1, `${label}: results`);
				expectEqual(results[0].args[1], true, `${label}: a successful result`);
				expectEqual(results[0].args.n, resultCount, `${label}: the result's arguments`);
				deliver(send, ...results[0].args);

				return expectResolves(request, `${label}: the request`);
			};

			expectEqual(roundTrip("echo", undefined, 2, 3), undefined, "nothing asked and nothing found");
			expectEqual(roundTrip("echo", where, 3, 4), where, "an Instance asked and found");
			expectEqual(roundTrip("drop", where, 3, 3), undefined, "an Instance asked, nothing found");
			expectEqual(roundTrip("give", undefined, 2, 4), given, "nothing asked, an Instance found");

			const expected = ["find:echo@none", "find:echo@Asked", "find:drop@Asked", "find:give@none"];
			expectEqual(maybeSaw.size(), expected.size(), "requests the middleware saw");
			expected.forEach((line, index) => expectEqual(maybeSaw[index], line, `the middleware's #${index + 1}`));
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
