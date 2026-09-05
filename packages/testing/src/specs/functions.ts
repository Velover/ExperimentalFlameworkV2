import { Modding, Serialization } from "@flamework/core";
import { Networking, NetworkingFunctionError } from "@flamework/networking";
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

type Handler = { [K in keyof Bidirectional]: Method };

const isServer = RunService.IsServer();

/**
 * A function creates one remote per direction, both named after the function, so only the id tells
 * them apart. The server receives on `$name` and sends on `@name`; the client is the mirror image.
 * Asserting these from both realms is what proves the two agree on the wire.
 */
const RECEIVE_PREFIX = isServer ? "$" : "@";
const SEND_PREFIX = isServer ? "@" : "$";

/** The player a server-side request is addressed to. Unused on the client. */
const requester = __harness.newPlayer("Requester");

const badResponses = new Array<defined>();
GlobalFunctions.registerHandler("onBadResponse", (_player, data) => badResponses.push(data.value as defined));

const rewriteArgument: Networking.FunctionMiddleware<[value: string], string> = (processNext) => {
	return (player, value) => processNext(player, `${value}/middleware`);
};

const cancelRequest: Networking.FunctionMiddleware<[value: string], string> = () => {
	return () => Networking.Skip;
};

let handler: Handler | undefined;

function getHandler(): Handler {
	if (handler !== undefined) {
		return handler;
	}

	if (isServer) {
		handler = GlobalFunctions.createServer({
			middleware: { transformed: [rewriteArgument], cancelled: [cancelRequest] },
		}) as never;
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

		handler = GlobalFunctions.createClient({
			middleware: { transformed: [rewriteArgument], cancelled: [cancelRequest] },
		}) as never;
	}

	__harness.flush();
	return handler!;
}

/** Calls a sender with the realm's calling convention. */
function invoke(method: Method, ...args: unknown[]) {
	return isServer ? method.invoke(requester, ...args) : method.invoke(...args);
}

function invokeWithTimeout(method: Method, timeout: number, ...args: unknown[]) {
	return isServer
		? method.invokeWithTimeout(requester, timeout, ...args)
		: method.invokeWithTimeout(timeout, ...args);
}

/** Runs a receiver locally, middleware and all. */
function predict(method: Method, ...args: unknown[]) {
	return isServer ? method.predict(requester, ...args) : method.predict(...args);
}

/** Registers a receiver callback, hiding the player argument the server is handed. */
function setCallback(method: Method, callback: (value: string) => unknown) {
	method.setCallback(isServer ? (_player, value) => callback(value as string) : (value) => callback(value as string));
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
 * Wire codecs when the project enables `networking.serialization`, `undefined` otherwise (see the
 * networking specs). A function request is `(id, ...args)` and a response `(id, result, value)`; with
 * serialization the args or value become `(buffer, blobs?)` after the plain prefix.
 * @metadata macro
 */
function wireCodec<T extends unknown[]>(
	meta?: Modding.Intrinsic<"network-serializer", [T], Serialization.Codec<T> | undefined>,
): Serialization.Codec<T> | undefined {
	return meta;
}

const wire = {
	textArgs: wireCodec<[string]>(),
	textResult: wireCodec<[string]>(),
	numberResult: wireCodec<[number]>(),
};
const SERIALIZED = wire.textArgs !== undefined;

/** Packed values as the remote carries them: the buffer, then the blob list only when the type has blob slots. */
function packed<T extends unknown[]>(codec: Serialization.Codec<T>, values: T): unknown[] {
	const [payload, blobs] = codec.encode(values);
	return blobs ? [payload, blobs] : [payload];
}

/** A response value as it travels after the plain `(id, result)` prefix. */
function onWire<T>(codec: Serialization.Codec<[T]> | undefined, value: T): unknown[] {
	return codec ? packed<[T]>(codec, [value]) : [value];
}

/** A request's argument list as it travels after the plain `id`: spread when not serialized. */
function onWireArgs<T extends unknown[]>(codec: Serialization.Codec<T> | undefined, args: T): unknown[] {
	return codec ? packed(codec, args) : args;
}

/** The response value that follows `prefix` plain arguments in a recorded message. */
function fromWire<T>(codec: Serialization.Codec<[T]> | undefined, args: unknown[], prefix: number): T {
	return codec ? fromWireArgs(codec, args, prefix)[0] : (args[prefix] as T);
}

/** The single request argument that follows `prefix` plain arguments in a recorded message. */
function fromWireArgs<T extends unknown[]>(
	codec: Serialization.Codec<T> | undefined,
	args: unknown[],
	prefix: number,
): T {
	if (!codec) return [args[prefix]] as unknown as T;
	return codec.decode(args[prefix] as buffer, (args[prefix + 1] ?? []) as Array<defined>);
}

export = suite("networking functions", [
	[
		"rejects an incoming request before a callback is set",
		() => {
			const reason = expectRejects(predict(getHandler().pending, "hello"), "request without a callback");
			expectEqual(reason, NetworkingFunctionError.Unprocessed, "rejection");
		},
	],
	[
		"invokes the callback and resolves with its return value",
		() => {
			setCallback(getHandler().echo, (value) => `${value}!`);

			expectEqual(expectResolves(predict(getHandler().echo, "hello")), "hello!", "returned value");
		},
	],
	[
		// The guard is generated from `echo(value: string)`, so a number must never reach the callback.
		"rejects a request whose arguments fail the generated guards",
		() => {
			let called = false;
			setCallback(getHandler().echo, (value) => {
				called = true;
				return `${value}!`;
			});

			const reason = expectRejects(predict(getHandler().echo, 42), "request with a bad argument");

			expectEqual(reason, NetworkingFunctionError.BadRequest, "rejection");
			expectEqual(called, false, "callback ran");
		},
	],
	[
		"answers a request that arrives over its receive channel",
		() => {
			setCallback(getHandler().echo, (value) => `${value}!`);

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

			const request = invoke(getHandler().echo, "ping");

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

			const request = invoke(getHandler().echo, "ping");
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
			const request = invokeWithTimeout(getHandler().pending, 0.05, "ping");

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
			const request = getHandler().pending.invoke(leaver, "ping");

			__harness.removePlayer(leaver);

			const reason = expectRejects(request, "request from a departed player");
			expectEqual(reason, NetworkingFunctionError.Cancelled, "rejection");
		},
	],
	[
		"runs middleware before the callback",
		() => {
			let received: string | undefined;
			setCallback(getHandler().transformed, (value) => {
				received = value;
				return value;
			});

			expectEqual(
				expectResolves(predict(getHandler().transformed, "value")),
				"value/middleware",
				"returned value",
			);
			expectEqual(received, "value/middleware", "value the callback saw");
		},
	],
	[
		"cancels a request when middleware returns Skip",
		() => {
			let called = false;
			setCallback(getHandler().cancelled, (value) => {
				called = true;
				return value;
			});

			const reason = expectRejects(predict(getHandler().cancelled, "value"), "skipped request");

			expectEqual(reason, NetworkingFunctionError.Cancelled, "rejection");
			expectEqual(called, false, "callback ran");
		},
	],
	[
		"uses a separate channel per direction",
		() => {
			getHandler();

			const receive = remoteById(`${RECEIVE_PREFIX}echo`, "receive channel");
			const send = remoteById(`${SEND_PREFIX}echo`, "send channel");

			expectTrue(receive !== send, "distinct channels");
			expectEqual(receive.Name, "echo", "receive channel name");
			expectEqual(send.Name, "echo", "send channel name");
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
