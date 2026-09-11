import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking, NetworkingFunctionError } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import { expectDefined, expectEqual, expectRejects, expectResolves, expectTrue, suite } from "../testkit";

/**
 * Both directions declare the same functions so that one spec body covers both realms: every method
 * is a sender *and* a receiver, which is also the case that exercises the direction prefixes on
 * remote ids.
 */
interface Bidirectional {
	echo(value: string): string;

	/** Never answered, so it stands in for both an unprocessed request and a timed out one. */
	pending(value: string): string;

	/** Has middleware that rewrites its argument. */
	transformed(value: string): string;

	/** Has middleware that returns `Networking.Skip`. */
	cancelled(value: string): string;
}

const GlobalFunctions = Networking.createFunction<Bidirectional, Bidirectional>();

/** A second global whose remotes nothing else touches, used by the cross-realm pairing case. */
const PairedFunctions = Networking.createFunction<{ pair(value: string): string }, { pair(value: string): string }>();

/** A raw function's requests and results travel as they are, whether or not the project serializes. */
interface RawBidirectional {
	rawEcho: Networking.Raw<(value: string) => string>;
}

const RawFunctions = Networking.createFunction<RawBidirectional, RawBidirectional>();

declare const __harness: {
	// Function-typed properties rather than methods: roblox-ts emits `:` calls for methods, which
	// would pass `__harness` itself as the first argument.
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemoteById: (id: string) => Instance | undefined;
	remoteIds: () => Array<string>;
	newPlayer: (name: string) => Instance;
	removePlayer: (player: Instance) => void;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

/** A remote signal the specs fire directly to stand in for the other realm. */
interface Inbound {
	Fire(this: unknown, ...args: unknown[]): void;
}

/**
 * Every method has the same shape across realms; only the leading player argument differs, which
 * the helpers below paper over.
 */
interface Method {
	invoke(...args: unknown[]): Promise<unknown>;
	invokeWithTimeout(...args: unknown[]): Promise<unknown>;
	setCallback(callback: (...args: unknown[]) => unknown): void;
	predict(...args: unknown[]): Promise<unknown>;
}

const isServer = RunService.IsServer();

/**
 * A function creates one remote per direction, both named after the function, so only the id tells
 * them apart. The server receives on `$name` and sends on `@name`; the client is the mirror image.
 * Asserting these from both realms is what proves the two agree on the wire.
 */
const RECEIVE_PREFIX = isServer ? "$" : "@";
const SEND_PREFIX = isServer ? "@" : "$";

/** The player a server-side request is addressed to. Unused on the client. */
const requester = __harness.newPlayer("Requester") as Player;

const badResponses = new Array<defined>();
GlobalFunctions.registerHandler("onBadResponse", (_player, data) => badResponses.push(data.value as defined));

const rewriteArgument: Networking.FunctionMiddleware<[value: string], string> = (processNext) => {
	return (player, value) => processNext(player, `${value}/middleware`);
};

const cancelRequest: Networking.FunctionMiddleware<[value: string], string> = () => {
	return () => Networking.Skip;
};

type Name = keyof Bidirectional;
type ServerFunctions = ReturnType<typeof GlobalFunctions.createServer>;
type ClientFunctions = ReturnType<typeof GlobalFunctions.createClient>;

/**
 * The realm's typed handler. Sends and callbacks go through the real types on purpose: with
 * serialization on, the transformer packs arguments and results at call sites it can type, and a
 * widened type would leave them unpacked.
 */
let handlers: { server?: ServerFunctions; client?: ClientFunctions } | undefined;

function getHandlers() {
	if (handlers !== undefined) {
		return handlers;
	}

	if (isServer) {
		handlers = {
			server: GlobalFunctions.createServer({
				middleware: { transformed: [rewriteArgument], cancelled: [cancelRequest] },
			}),
		};
	} else {
		// Remotes are created by the server and replicated. Flushing inside the server window wires
		// the primed handler to the channels a real server would listen on, rather than leaving its
		// deferred connections to resolve against the client realm.
		__harness.asRealm("Server", () => {
			GlobalFunctions.createServer({
				middleware: { transformed: [rewriteArgument], cancelled: [cancelRequest] },
			});
			__harness.flush();
		});

		handlers = {
			client: GlobalFunctions.createClient({
				middleware: { transformed: [rewriteArgument], cancelled: [cancelRequest] },
			}),
		};
	}

	__harness.flush();
	return handlers;
}

/**
 * A member by name through direct property access: the handler's keys are obfuscated, so the
 * transformer refuses to index it with a variable.
 */
function serverMember(server: ServerFunctions, name: Name) {
	switch (name) {
		case "echo":
			return server.echo;
		case "pending":
			return server.pending;
		case "transformed":
			return server.transformed;
		case "cancelled":
			return server.cancelled;
	}
}

function clientMember(client: ClientFunctions, name: Name) {
	switch (name) {
		case "echo":
			return client.echo;
		case "pending":
			return client.pending;
		case "transformed":
			return client.transformed;
		case "cancelled":
			return client.cancelled;
	}
}

/** Calls a sender with the realm's calling convention. */
function invoke(name: Name, value: string) {
	const { server, client } = getHandlers();
	return server !== undefined
		? serverMember(server, name).invoke(requester, value)
		: clientMember(client!, name).invoke(value);
}

function invokeWithTimeout(name: Name, timeout: number, value: string) {
	const { server, client } = getHandlers();
	return server !== undefined
		? serverMember(server, name).invokeWithTimeout(requester, timeout, value)
		: clientMember(client!, name).invokeWithTimeout(timeout, value);
}

/** Runs a receiver locally, middleware and all. `predict` takes plain values, so a widened type is fine. */
function predict(name: Name, ...args: unknown[]) {
	const { server, client } = getHandlers();
	const method = (server !== undefined
		? serverMember(server, name)
		: clientMember(client!, name)) as unknown as Method;
	return server !== undefined ? method.predict(requester, ...args) : method.predict(...args);
}

/** Registers a receiver callback, hiding the player argument the server is handed. */
function setCallback(name: Name, callback: (value: string) => unknown) {
	const { server, client } = getHandlers();
	if (server !== undefined) {
		serverMember(server, name).setCallback((_player, value) => callback(value) as string);
	} else {
		clientMember(client!, name).setCallback((value) => callback(value) as string);
	}
}

function remoteById(id: string, what: string) {
	return expectDefined(__harness.findRemoteById(id), what);
}

/** Delivers a message on a channel as the other realm would, adding the sender on the server. */
function deliver(channel: Instance, ...args: unknown[]) {
	const signals = channel as unknown as { OnServerEvent: Inbound; OnClientEvent: Inbound };

	if (isServer) {
		signals.OnServerEvent.Fire(requester, ...args);
	} else {
		signals.OnClientEvent.Fire(...args);
	}
}

/**
 * Decoders when the project enables `networking.serialization`, `undefined` otherwise (see the
 * networking specs). A function request is `(id, ...args)` and a response `(id, result, value)`; with
 * serialization the args or value become `(buffer, blobs?)` after the plain prefix. Encoding lives at
 * call sites only, so simulated traffic is packed with a serializer for the same tuple type.
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
	textArgs: { decode: wireDecoder<[string]>(), pack: Flamework.createSerializer<[string]>() },
	textResult: { decode: wireDecoder<[string]>(), pack: Flamework.createSerializer<[string]>() },
	numberResult: { decode: wireDecoder<[number]>(), pack: Flamework.createSerializer<[number]>() },
};
const SERIALIZED = wire.textArgs.decode !== undefined;

/** Packed values as the remote carries them: the buffer, then the blob list only when the type has blob slots. */
function packed<T extends unknown[]>(wire: Wire<T>, values: T): unknown[] {
	const [payload, blobs] = wire.pack.serialize(values);
	return blobs ? [payload, blobs] : [payload];
}

/** A response value as it travels after the plain `(id, result)` prefix. */
function onWire<T>(wire: Wire<[T]>, value: T): unknown[] {
	return wire.decode !== undefined ? packed<[T]>(wire, [value]) : [value];
}

/** A request's argument list as it travels after the plain `id`: spread when not serialized. */
function onWireArgs<T extends unknown[]>(wire: Wire<T>, args: T): unknown[] {
	return wire.decode !== undefined ? packed(wire, args) : args;
}

/** The response value that follows `prefix` plain arguments in a recorded message. */
function fromWire<T>(wire: Wire<[T]>, args: unknown[], prefix: number): T {
	return wire.decode !== undefined ? fromWireArgs(wire, args, prefix)[0] : (args[prefix] as T);
}

/** The single request argument that follows `prefix` plain arguments in a recorded message. */
function fromWireArgs<T extends unknown[]>(wire: Wire<T>, args: unknown[], prefix: number): T {
	if (wire.decode === undefined) return [args[prefix]] as unknown as T;
	return wire.decode(args[prefix] as buffer, (args[prefix + 1] ?? []) as Array<defined>);
}

export = suite("networking functions", [
	[
		"rejects an incoming request before a callback is set",
		() => {
			const reason = expectRejects(predict("pending", "hello"), "request without a callback");
			expectEqual(reason, NetworkingFunctionError.Unprocessed, "rejection");
		},
	],
	[
		"invokes the callback and resolves with its return value",
		() => {
			setCallback("echo", (value) => `${value}!`);

			expectEqual(expectResolves(predict("echo", "hello")), "hello!", "returned value");
		},
	],
	[
		// The guard is generated from `echo(value: string)`, so a number must never reach the callback.
		"rejects a request whose arguments fail the generated guards",
		() => {
			let called = false;
			setCallback("echo", (value) => {
				called = true;
				return `${value}!`;
			});

			const reason = expectRejects(predict("echo", 42), "request with a bad argument");

			expectEqual(reason, NetworkingFunctionError.BadRequest, "rejection");
			expectEqual(called, false, "callback ran");
		},
	],
	[
		"answers a request that arrives over its receive channel",
		() => {
			setCallback("echo", (value) => `${value}!`);

			const channel = remoteById(`${RECEIVE_PREFIX}echo`, "echo receive channel");
			__harness.clearSent(channel);

			deliver(channel, 7, ...onWireArgs(wire.textArgs, ["ping"] as [string]));

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "responses");
			expectEqual(sent[0].kind, isServer ? "FireClient" : "FireServer", "dispatch method");
			expectEqual(sent[0].args[0], 7, "request id echoed back");
			expectEqual(sent[0].args[1], true, "process result");
			expectEqual(fromWire(wire.textResult, sent[0].args, 2), "ping!", "returned value");
		},
	],
	[
		"sends a request and resolves once the response arrives",
		() => {
			const channel = remoteById(`${SEND_PREFIX}echo`, "echo send channel");
			__harness.clearSent(channel);

			const request = invoke("echo", "ping");

			const sent = __harness.sent(channel);
			expectEqual(sent.size(), 1, "requests");
			expectEqual(fromWireArgs(wire.textArgs, sent[0].args, 1)[0], "ping", "payload");

			deliver(channel, sent[0].args[0], true, ...onWire(wire.textResult, "pong"));

			expectEqual(expectResolves(request), "pong", "resolved value");
		},
	],
	[
		// `echo` returns a string, so a numeric response has to be rejected rather than handed on.
		"rejects a response that fails the generated return guard",
		() => {
			badResponses.clear();

			const channel = remoteById(`${SEND_PREFIX}echo`, "echo send channel");
			__harness.clearSent(channel);

			const request = invoke("echo", "ping");
			// Serialized, a number's bytes where a string is expected cannot be decoded: still InvalidResult.
			deliver(channel, __harness.sent(channel)[0].args[0], true, ...onWire(wire.numberResult, 42));

			expectEqual(expectRejects(request, "invalid response"), NetworkingFunctionError.InvalidResult, "rejection");
			expectEqual(badResponses.size(), 1, "onBadResponse events");
			if (!SERIALIZED) expectEqual(badResponses[0], 42, "reported value");
		},
	],
	[
		"rejects with Timeout when no response arrives",
		() => {
			const request = invokeWithTimeout("pending", 0.05, "ping");

			expectEqual(expectRejects(request, "unanswered request"), NetworkingFunctionError.Timeout, "rejection");
		},
	],
	[
		// Only the server tracks requests per player, so only the server can cancel them on leave.
		"cancels a player's pending requests when they leave",
		() => {
			if (!isServer) {
				return;
			}

			const leaver = __harness.newPlayer("Leaver");
			const request = getHandlers().server!.pending.invoke(leaver as Player, "ping");

			__harness.removePlayer(leaver);

			const reason = expectRejects(request, "request from a departed player");
			expectEqual(reason, NetworkingFunctionError.Cancelled, "rejection");
		},
	],
	[
		"runs middleware before the callback",
		() => {
			let received: string | undefined;
			setCallback("transformed", (value) => {
				received = value;
				return value;
			});

			expectEqual(expectResolves(predict("transformed", "value")), "value/middleware", "returned value");
			expectEqual(received, "value/middleware", "value the callback saw");
		},
	],
	[
		"cancels a request when middleware returns Skip",
		() => {
			let called = false;
			setCallback("cancelled", (value) => {
				called = true;
				return value;
			});

			const reason = expectRejects(predict("cancelled", "value"), "skipped request");

			expectEqual(reason, NetworkingFunctionError.Cancelled, "rejection");
			expectEqual(called, false, "callback ran");
		},
	],
	[
		"uses a separate channel per direction",
		() => {
			getHandlers();

			const receive = remoteById(`${RECEIVE_PREFIX}echo`, "receive channel");
			const send = remoteById(`${SEND_PREFIX}echo`, "send channel");

			expectTrue(receive !== send, "distinct channels");
			expectEqual(receive.Name, "echo", "receive channel name");
			expectEqual(send.Name, "echo", "send channel name");
		},
	],
	[
		"leaves a raw function's requests and results as they are",
		() => {
			let raw: ReturnType<typeof RawFunctions.createServer> | ReturnType<typeof RawFunctions.createClient>;
			if (isServer) {
				raw = RawFunctions.createServer({});
				raw.rawEcho.setCallback((_player, value) => `${value}!`);
			} else {
				__harness.asRealm("Server", () => {
					RawFunctions.createServer({});
					__harness.flush();
				});
				raw = RawFunctions.createClient({});
				raw.rawEcho.setCallback((value) => `${value}!`);
			}
			__harness.flush();

			// A request arrives with a plain value and is answered with one.
			const receive = remoteById(`${RECEIVE_PREFIX}rawEcho`, "rawEcho receive channel");
			__harness.clearSent(receive);
			deliver(receive, 7, "ping");

			const answered = __harness.sent(receive);
			expectEqual(answered.size(), 1, "responses");
			expectEqual(answered[0].args[1], true, "process result");
			expectEqual(answered[0].args[2], "ping!", "returned value on the wire");

			// A request leaves with a plain value and resolves with the plain response.
			const send = remoteById(`${SEND_PREFIX}rawEcho`, "rawEcho send channel");
			__harness.clearSent(send);
			const request = isServer
				? (raw as ReturnType<typeof RawFunctions.createServer>).rawEcho.invoke(requester, "ping")
				: (raw as ReturnType<typeof RawFunctions.createClient>).rawEcho.invoke("ping");

			const sent = __harness.sent(send);
			expectEqual(sent.size(), 1, "requests");
			expectEqual(sent[0].args[1], "ping", "argument on the wire");

			deliver(send, sent[0].args[0], true, "pong");
			expectEqual(expectResolves(request), "pong", "resolved value");
		},
	],
	[
		// The realms run as separate processes, so this is as close as one process gets to
		// replication: build the tree as the server, then let the client resolve it. If the two
		// disagreed on ids, the client would create remotes of its own instead of reusing these.
		"a client binds to the remotes the server created",
		() => {
			__harness.asRealm("Server", () => {
				PairedFunctions.createServer({});
				__harness.flush();
			});

			const afterServer = __harness.remoteIds();
			expectTrue(afterServer.includes("$pair"), "server receive channel");
			expectTrue(afterServer.includes("@pair"), "server send channel");

			__harness.asRealm("Client", () => {
				PairedFunctions.createClient({});
				__harness.flush();
			});

			expectEqual(__harness.remoteIds().size(), afterServer.size(), "remotes after the client resolved them");
		},
	],
]);
