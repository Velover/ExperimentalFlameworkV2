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
