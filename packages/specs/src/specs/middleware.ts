import { Networking } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import { expectArrayEqual, expectDefined, expectEqual, expectTrue, suite } from "../testkit";

/**
 * Declared in both directions so that one spec body covers both realms: each name is a sender and a
 * receiver, and `predict` runs the receiving half locally, middleware and all.
 */
interface Bidirectional {
	ordered(value: string): void;
	blocked(value: string): void;
	transformed(value: string): void;
	described(value: string): void;
	guarded(value: string): void;

	/** Its inner middleware returns a Promise; the outer one reads what `processNext` gave back. */
	awaited(value: string): void;

	/** Its middleware yields before handing the message on. */
	yielding(value: string): void;

	/** Optional parameters, passed on by a middleware that names them all. */
	gapped(a?: string, b?: number, c?: string, d?: number): void;

	/** Values a copying signal would change: instance keys, and a set of booleans. */
	keyed(map: Map<Instance, number>, flags: Set<boolean>): void;

	/** Two handlers, the newer of which raises. */
	shared(value: string): void;
}

interface Unchecked {
	anything(value: string): void;
}

const GlobalEvents = Networking.createEvent<Bidirectional, Bidirectional>();
const UncheckedEvents = Networking.createEvent<Unchecked, Unchecked>();

declare const __harness: {
	newPlayer: (name: string) => Instance;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

interface Method {
	connect(callback: (...args: unknown[]) => void): RBXScriptConnection;
	predict(...args: unknown[]): void;
}

const isServer = RunService.IsServer();
const requester = __harness.newPlayer("Sender");

const trace = new Array<string>();
const handled = new Array<defined>();

/** Values the `guarded` middleware was handed, which the generated guards should keep empty. */
const passedGuards = new Array<defined>();

let describedInfo: { name: string; globalName: string; eventType: string } | undefined;

function record(label: string): Networking.EventMiddleware<[value: string]> {
	return (processNext) => {
		return (player, value) => {
			trace.push(label);
			return processNext(player, value);
		};
	};
}

/** Never calls `processNext`, which is how middleware rejects an event. */
const dropEvent: Networking.EventMiddleware<[value: string]> = () => {
	return () => {};
};

const rewriteArgument: Networking.EventMiddleware<[value: string]> = (processNext) => {
	return (player, value) => processNext(player, `${value}/middleware`);
};

/** The network info is handed to the factory, not to each call, so it is captured on construction. */
const captureInfo: Networking.EventMiddleware<[value: string]> = (processNext, event) => {
	describedInfo = event;
	return (player, value) => processNext(player, value);
};

const observeArgument: Networking.EventMiddleware<[value: string]> = (processNext) => {
	return (player, value) => {
		passedGuards.push(value);
		return processNext(player, value);
	};
};

/** What `awaited`'s two middleware did, in order. */
const awaitedLog = new Array<string>();

/** Hands the message on from a Promise that settles a frame later. */
const promiseLink: Networking.EventMiddleware<[value: string]> = (processNext) => {
	return (player, value) =>
		new Promise<void>((resolve) => {
			task.wait();
			awaitedLog.push("inner handed it on");
			processNext(player, value);
			resolve();
		});
};

/** Reads what `processNext` returned, once it has returned. */
const readResult: Networking.EventMiddleware<[value: string]> = (processNext) => {
	return (player, value) => {
		const result = processNext(player, value);
		awaitedLog.push(`outer continued with ${typeOf(result)}`);
	};
};

/** Yields before handing the message on. */
const yieldFirst: Networking.EventMiddleware<[value: string]> = (processNext) => {
	return (player, value) => {
		task.wait();
		return processNext(player, value);
	};
};

/** Names every parameter, so it passes on a list that ends in nil whenever `d` was not sent. */
const nameParameters: Networking.EventMiddleware<[a?: string, b?: number, c?: string, d?: number]> = (processNext) => {
	return (player, a, b, c, d) => processNext(player, a, b, c, d);
};

const badRequests = new Array<{ networkInfo: { name: string }; argIndex: number; argValue: unknown }>();
GlobalEvents.registerHandler("onBadRequest", (_player, data) => badRequests.push(data));

type Handler = { [K in keyof Bidirectional]: Method };

let handler: Handler | undefined;

function getHandler(): Handler {
	if (handler !== undefined) {
		return handler;
	}

	if (isServer) {
		handler = GlobalEvents.createServer({
			middleware: {
				ordered: [record("first"), record("second")],
				blocked: [dropEvent],
				transformed: [rewriteArgument],
				described: [captureInfo],
				guarded: [observeArgument],
				awaited: [readResult, promiseLink],
				yielding: [yieldFirst],
				gapped: [nameParameters],
			},
		}) as never;
	} else {
		// Remotes are created by the server and replicated, so a client spec has to build the tree
		// the way a server would before it can resolve it.
		__harness.asRealm("Server", () => GlobalEvents.createServer({}));

		handler = GlobalEvents.createClient({
			middleware: {
				ordered: [record("first"), record("second")],
				blocked: [dropEvent],
				transformed: [rewriteArgument],
				described: [captureInfo],
				guarded: [observeArgument],
				awaited: [readResult, promiseLink],
				yielding: [yieldFirst],
				gapped: [nameParameters],
			},
		}) as never;
	}

	return handler!;
}

function getUnchecked(): Method {
	if (isServer) {
		return UncheckedEvents.createServer({ disableIncomingGuards: true }).anything as never;
	}

	__harness.asRealm("Server", () => UncheckedEvents.createServer({}));
	return UncheckedEvents.createClient({ disableIncomingGuards: true }).anything as never;
}

/** Waits a few frames for `condition`, which a yielding middleware or a Promise delivers later. */
function waitFor(condition: () => boolean) {
	for (let i = 0; i < 30 && !condition(); i++) task.wait();
	return condition();
}

/** Connects a receiver, hiding the player argument the server is handed. */
function connect(method: Method, callback: (value: defined) => void) {
	return method.connect(
		isServer ? (_player, value) => callback(value as defined) : (value) => callback(value as defined),
	);
}

/** Runs the receiving half locally, exactly as an incoming message would. */
function predict(method: Method, ...args: unknown[]) {
	if (isServer) {
		method.predict(requester, ...args);
	} else {
		method.predict(...args);
	}
}

export = suite("networking middleware", [
	[
		"runs middleware in the order it was registered",
		() => {
			trace.clear();
			handled.clear();

			connect(getHandler().ordered, (value) => handled.push(value));
			predict(getHandler().ordered, "value");

			expectArrayEqual(trace, ["first", "second"], "middleware order");
			expectArrayEqual(handled, ["value"], "events the handler saw");
		},
	],
	[
		"drops an event when middleware does not call processNext",
		() => {
			handled.clear();

			connect(getHandler().blocked, (value) => handled.push(value));
			predict(getHandler().blocked, "value");

			expectEqual(handled.size(), 0, "events the handler saw");
		},
	],
	[
		"passes rewritten arguments down the chain",
		() => {
			handled.clear();

			connect(getHandler().transformed, (value) => handled.push(value));
			predict(getHandler().transformed, "value");

			expectArrayEqual(handled, ["value/middleware"], "events the handler saw");
		},
	],
	[
		"hands the middleware factory the event's network info",
		() => {
			getHandler();

			const info = expectDefined(describedInfo, "network info");
			expectEqual(info.name, "described", "event name");
			expectEqual(info.eventType, "Event", "event type");
			expectTrue(info.globalName.size() > 0, "global name is set");
		},
	],
	[
		// The generated guards are inserted ahead of user middleware, so a bad payload is rejected
		// before any user code -- middleware included -- observes it.
		"runs the generated guards before user middleware",
		() => {
			handled.clear();
			passedGuards.clear();

			connect(getHandler().guarded, (value) => handled.push(value));
			predict(getHandler().guarded, 42);

			expectEqual(passedGuards.size(), 0, "values user middleware saw");
			expectEqual(handled.size(), 0, "events the handler saw");
		},
	],
	[
		"reports the offending argument through onBadRequest",
		() => {
			badRequests.clear();

			connect(getHandler().guarded, () => {});
			predict(getHandler().guarded, 42);

			expectEqual(badRequests.size(), 1, "onBadRequest events");
			expectEqual(badRequests[0].networkInfo.name, "guarded", "reported event");
			expectEqual(badRequests[0].argIndex, 0, "reported argument index");
			expectEqual(badRequests[0].argValue, 42, "reported argument value");
		},
	],
	[
		// processNext returns the next link's result, with a Promise the link returned followed in
		// the thread handling the message: the outer middleware continues after the inner one's
		// Promise settled, and reads nothing rather than a Promise.
		"waits for a middleware's Promise before the middleware ahead of it continues",
		() => {
			awaitedLog.clear();
			handled.clear();

			const connection = connect(getHandler().awaited, (value) => handled.push(value));
			predict(getHandler().awaited, "value");

			// predict returns at once: the chain runs on a thread of its own.
			expectEqual(awaitedLog.size(), 0, "middleware steps done before the Promise settled");

			expectTrue(
				waitFor(() => awaitedLog.size() >= 2),
				"both middleware finished",
			);
			expectArrayEqual(awaitedLog, ["inner handed it on", "outer continued with nil"], "middleware steps");
			expectArrayEqual(handled, ["value"], "events the handler saw");
			connection.Disconnect();
		},
	],
	[
		"a middleware that yields holds up only its own message",
		() => {
			handled.clear();

			const connection = connect(getHandler().yielding, (value) => handled.push(value));
			predict(getHandler().yielding, "first");
			predict(getHandler().yielding, "second");
			expectEqual(handled.size(), 0, "events delivered before the middleware resumed");

			expectTrue(
				waitFor(() => handled.size() >= 2),
				"both events delivered",
			);
			expectArrayEqual(handled, ["first", "second"], "events the handler saw");
			connection.Disconnect();
		},
	],
	[
		// A list with a gap and a trailing undefined keeps every value, through a middleware that
		// names its parameters and so hands on a list ending in nil.
		"keeps the values after a gap through a middleware that names its parameters",
		() => {
			const seen = new Array<{ size: number; values: unknown[] }>();
			const method = getHandler().gapped;
			const connection = isServer
				? method.connect((_player, ...args) => seen.push({ size: args.size(), values: args }))
				: method.connect((...args) => seen.push({ size: args.size(), values: args }));

			predict(method, "x", undefined, "z", undefined);
			connection.Disconnect();

			expectEqual(seen.size(), 1, "events the handler saw");
			expectEqual(seen[0].size, 3, "arguments up to the last value");
			expectEqual(seen[0].values[0], "x", "first argument");
			expectEqual(seen[0].values[1], undefined, "the gap");
			expectEqual(seen[0].values[2], "z", "the value after the gap");
		},
	],
	[
		// A BindableEvent copies what it is fired with: a Map keyed by instances would arrive keyed
		// by strings, and a Set of booleans would raise. The signal hands over the same objects.
		"delivers a Map keyed by instances and a Set of booleans as the same objects",
		() => {
			const key = new Instance("Folder");
			const map = new Map<Instance, number>([[key, 5]]);
			const flags = new Set<boolean>([true, false]);
			const seen = new Array<[unknown, unknown]>();

			const method = getHandler().keyed;
			const connection = isServer
				? method.connect((_player, a, b) => seen.push([a, b]))
				: method.connect((a, b) => seen.push([a, b]));

			predict(method, map, flags);
			connection.Disconnect();

			expectEqual(seen.size(), 1, "events the handler saw");
			expectTrue(seen[0][0] === map, "the same Map");
			expectTrue(seen[0][1] === flags, "the same Set");
			expectEqual(map.get(key), 5, "the instance key");
		},
	],
	[
		// Each handler runs on a thread of its own: one that raises has its error printed, and the
		// others still run. The newest connection runs first, as an engine signal's does.
		"a handler that raises does not stop the others",
		() => {
			const order = new Array<string>();
			const method = getHandler().shared;
			const older = connect(method, (value) => order.push(`older ${value}`));
			const newer = connect(method, () => {
				order.push("newer");
				error("a handler raised on purpose (expected in this log)");
			});

			predict(method, "value");
			older.Disconnect();
			newer.Disconnect();

			expectArrayEqual(order, ["newer", "older value"], "handlers that ran");
		},
	],
	[
		"accepts any payload once incoming guards are disabled",
		() => {
			const received = new Array<defined>();
			const method = getUnchecked();

			connect(method, (value) => received.push(value));
			predict(method, 42);

			expectArrayEqual(received, [42], "events the handler saw");
		},
	],
]);
