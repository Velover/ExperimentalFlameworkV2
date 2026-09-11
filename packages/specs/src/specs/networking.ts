import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { Players, RunService } from "@rbxts/services";
import { expectDefined, expectEqual, expectTrue, suite } from "../testkit";

interface ServerEvents {
	setScore(score: number): void;
	rename(name: string): void;

	/** Carries nothing, so with serialization on it sends no payload at all. */
	bump(): void;

	/** A nested namespace, which gets its own remote named after the path to it. */
	stats: { report(value: number): void };
}

interface ClientEvents {
	scoreChanged(score: number): void;

	/** Declared unreliable, so it gets an `UnreliableRemoteEvent` on a separate channel. */
	tick: Networking.Unreliable<(value: number) => void>;

	/** Declared raw: its arguments travel as they are whether or not the project serializes. */
	raw: Networking.RawReliable<(value: number) => void>;

	stats: { report(value: number): void };
}

const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();

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

interface Wire<T extends unknown[]> {
	decode: Serialization.Decoder<T> | undefined;
	pack: Serialization.Serializer<T>;
}

const wire = {
	number: { decode: wireDecoder<[number]>(), pack: Flamework.createSerializer<[number]>() },
	text: { decode: wireDecoder<[string]>(), pack: Flamework.createSerializer<[string]>() },
};

/** The arguments a recorded message carried, decoded when they went out serialized. */
function carried<T extends unknown[]>(wire: Wire<T>, message: { args: unknown[] }): T {
	if (wire.decode === undefined) return message.args as T;
	return wire.decode(message.args[0] as buffer, (message.args[1] ?? []) as Array<defined>);
}

/** Arguments as the other realm would put them on the wire. */
function onWire<T extends unknown[]>(wire: Wire<T>, ...args: T): unknown[] {
	if (wire.decode === undefined) return args;
	const [payload, blobs] = wire.pack.serialize(args);
	return blobs ? [payload, blobs] : [payload];
}

/**
 * The harness records everything a remote sends instead of replicating it, and exposes the
 * receiving signals so inbound traffic can be simulated. `__harness` is injected by the runtime
 * harness; it does not exist in a real Roblox environment.
 */
declare const __harness: {
	// Declared as function-typed properties rather than methods: roblox-ts emits `:` calls for
	// methods, which would pass `__harness` itself as the first argument.
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

/**
 * Declared with method syntax on purpose: roblox-ts emits `:` calls for methods, which is how the
 * real handler is declared, and a function-typed property would drop the `self` argument.
 */
interface NamespacedMethod {
	connect(callback: (...args: unknown[]) => void): RBXScriptConnection;
	predict(...args: unknown[]): void;
}

/**
 * Remotes are created by the server and replicated. The harness runs a single realm, so a client
 * spec has to create the tree as the server would before the client can find it.
 */
let primed = false;
function primeRemotes() {
	if (primed) {
		return;
	}

	primed = true;
	__harness.asRealm("Server", () => {
		GlobalEvents.createServer({});
	});
}

export = suite("networking", [
	[
		"creates a namespace handler for the running realm",
		() => {
			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				expectDefined(server, "server handler");
				expectDefined(server.scoreChanged, "server-side client event");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				expectDefined(client, "client handler");
				expectDefined(client.setScore, "client-side server event");
			}
		},
	],
	[
		"sends an outgoing event through a remote",
		() => {
			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				const player = __harness.newPlayer("Tester");

				server.scoreChanged.fire(player as never, 42);

				const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
				const sent = __harness.sent(remote);

				expectEqual(sent.size(), 1, "sent messages");
				expectEqual(sent[0].kind, "FireClient", "dispatch method");
				expectEqual(carried(wire.number, sent[0])[0], 42, "payload");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				client.setScore.fire(7);

				const remote = expectDefined(__harness.findRemote("setScore"), "setScore remote");
				const sent = __harness.sent(remote);

				expectEqual(sent.size(), 1, "sent messages");
				expectEqual(sent[0].kind, "FireServer", "dispatch method");
				expectEqual(carried(wire.number, sent[0])[0], 7, "payload");
			}
		},
	],
	[
		"broadcasts to every client",
		() => {
			if (!RunService.IsServer()) {
				return;
			}

			const server = GlobalEvents.createServer({});
			const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
			__harness.clearSent(remote);

			server.scoreChanged.broadcast(99);

			const sent = __harness.sent(remote);
			expectEqual(sent.size(), 1, "sent messages");
			expectEqual(sent[0].kind, "FireAllClients", "dispatch method");
			expectEqual(carried(wire.number, sent[0])[0], 99, "payload");
		},
	],
	[
		"sends one message per player when given a list",
		() => {
			if (!RunService.IsServer()) {
				return;
			}

			const server = GlobalEvents.createServer({});
			const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
			__harness.clearSent(remote);

			const first = __harness.newPlayer("First");
			const second = __harness.newPlayer("Second");
			server.scoreChanged.fire([first, second] as never, 3);

			const sent = __harness.sent(remote);
			expectEqual(sent.size(), 2, "sent messages");
			expectEqual(sent[0].player, first, "first recipient");
			expectEqual(sent[1].player, second, "second recipient");
		},
	],
	[
		"sends to everyone but the excluded player",
		() => {
			if (!RunService.IsServer()) {
				return;
			}

			const server = GlobalEvents.createServer({});
			const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
			__harness.clearSent(remote);

			const excluded = __harness.newPlayer("Excluded");
			server.scoreChanged.except(excluded as never, 4);

			const sent = __harness.sent(remote);
			expectEqual(sent.size(), Players.GetPlayers().size() - 1, "sent messages");

			for (const message of sent) {
				expectTrue(message.player !== excluded, "excluded player was skipped");
			}
		},
	],
	[
		"accepts an incoming event whose arguments satisfy the generated guards",
		() => {
			const received = new Array<number>();

			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				server.setScore.connect((_player, score) => received.push(score));
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("setScore"), "setScore remote");
				const player = __harness.newPlayer("Sender");
				(
					remote as unknown as { OnServerEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnServerEvent.Fire(player, ...onWire(wire.number, 5));

				expectEqual(received.size(), 1, "accepted messages");
				expectEqual(received[0], 5, "received payload");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				client.scoreChanged.connect((score) => received.push(score));
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
				(
					remote as unknown as { OnClientEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnClientEvent.Fire(...onWire(wire.number, 11));

				expectEqual(received.size(), 1, "accepted messages");
				expectEqual(received[0], 11, "received payload");
			}
		},
	],
	[
		// The guard is generated from `setScore(score: number)`, so a string must be dropped before
		// it ever reaches the handler.
		"drops an incoming event whose arguments fail the generated guards",
		() => {
			const received = new Array<string | number>();

			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				server.rename.connect((_player, name) => received.push(name));
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("rename"), "rename remote");
				const player = __harness.newPlayer("Sender");
				const onServerEvent = (
					remote as unknown as { OnServerEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnServerEvent;

				// Serialized, this is a number's bytes where a string is expected: a malformed payload.
				onServerEvent.Fire(player, ...onWire(wire.number, 12345));
				expectEqual(received.size(), 0, "messages accepted after a bad payload");

				onServerEvent.Fire(player, ...onWire(wire.text, "valid"));
				expectEqual(received.size(), 1, "messages accepted after a good payload");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				client.scoreChanged.connect((score) => received.push(score));
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("scoreChanged"), "scoreChanged remote");
				const onClientEvent = (
					remote as unknown as { OnClientEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnClientEvent;

				onClientEvent.Fire(...onWire(wire.text, "not a number"));
				expectEqual(received.size(), 0, "messages accepted after a bad payload");

				onClientEvent.Fire(...onWire(wire.number, 3));
				expectEqual(received.size(), 1, "messages accepted after a good payload");
			}
		},
	],
	[
		"creates one remote per event name",
		() => {
			primeRemotes();
			expectTrue(__harness.findRemote("setScore") !== __harness.findRemote("rename"), "distinct remotes");
		},
	],
	[
		// Unlike a function, an event uses a single remote for both directions, so its id is the
		// bare event name rather than a direction-prefixed one.
		"uses a single unprefixed remote for both directions",
		() => {
			primeRemotes();

			expectDefined(__harness.findRemoteById("setScore"), "unprefixed remote");
			expectEqual(__harness.findRemoteById("$setScore"), undefined, "prefixed receive channel");
			expectEqual(__harness.findRemoteById("@setScore"), undefined, "prefixed send channel");
		},
	],
	[
		"gives a nested namespace its own remote",
		() => {
			primeRemotes();

			const received = new Array<number>();
			const handler = (RunService.IsServer()
				? GlobalEvents.createServer({})
				: GlobalEvents.createClient({})) as unknown as { stats: { report: NamespacedMethod } };

			const remote = expectDefined(__harness.findRemoteById("stats/report"), "namespaced remote");
			expectEqual(remote.Name, "report", "remote name");

			if (RunService.IsServer()) {
				handler.stats.report.connect((_player, value) => received.push(value as number));
				handler.stats.report.predict(__harness.newPlayer("Reporter"), 12);
			} else {
				handler.stats.report.connect((value) => received.push(value as number));
				handler.stats.report.predict(12);
			}

			expectEqual(received.size(), 1, "events the handler saw");
			expectEqual(received[0], 12, "received payload");
		},
	],
	[
		"puts an unreliable event on an UnreliableRemoteEvent",
		() => {
			primeRemotes();

			const remote = expectDefined(__harness.findRemoteById("unreliable:tick"), "unreliable remote");
			expectEqual(remote.ClassName, "UnreliableRemoteEvent", "remote class");
			expectEqual(__harness.findRemoteById("tick"), undefined, "reliable channel");
		},
	],
	[
		"sends nothing for an event without arguments and accepts it bare",
		() => {
			let received = 0;

			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				server.bump.connect(() => received++);
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("bump"), "bump remote");
				(
					remote as unknown as { OnServerEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnServerEvent.Fire(__harness.newPlayer("Bumper"));

				expectEqual(received, 1, "accepted messages");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				client.bump.fire();

				const remote = expectDefined(__harness.findRemote("bump"), "bump remote");
				const sent = __harness.sent(remote);
				expectEqual(sent.size(), 1, "sent messages");
				expectEqual(sent[0].args.size(), 0, "arguments on the wire");
			}
		},
	],
	[
		"leaves a raw event's arguments as they are",
		() => {
			const received = new Array<number>();

			if (RunService.IsServer()) {
				const server = GlobalEvents.createServer({});
				const remote = expectDefined(__harness.findRemote("raw"), "raw remote");
				__harness.clearSent(remote);

				server.raw.broadcast(42);

				const sent = __harness.sent(remote);
				expectEqual(sent.size(), 1, "sent messages");
				expectEqual(sent[0].args[0], 42, "argument on the wire");
			} else {
				primeRemotes();
				const client = GlobalEvents.createClient({});
				client.raw.connect((value) => received.push(value));
				__harness.flush();

				const remote = expectDefined(__harness.findRemote("raw"), "raw remote");
				(
					remote as unknown as { OnClientEvent: { Fire(this: unknown, ...args: unknown[]): void } }
				).OnClientEvent.Fire(42);

				expectEqual(received.size(), 1, "accepted messages");
				expectEqual(received[0], 42, "received value");
			}
		},
	],
]);
