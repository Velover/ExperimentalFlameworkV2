import { Serialization } from "@flamework-experimental/core";
import { RunService } from "@rbxts/services";
import { MiddlewareFactory } from "../middleware/types";
import { createRemoteInstance } from "./createRemoteInstance";
import { NetworkInfo } from "../types";
import { Guards, createProcessor, createReceiver, decode, deliverTo } from "../middleware/processor";
import { SignalConnection, createSignal, spawn } from "../util/signal";
import { trimArguments } from "../util/trimArguments";

export interface CreateEventOptions {
	/**
	 * The namespace this event should be created in.
	 */
	namespace: string;

	/**
	 * The name of the remote instance, not necessarily unique and used for debugging purposes.
	 */
	debugName: string;

	/**
	 * The remote's ID which must be unique.
	 */
	id: string;

	/**
	 * Information about the network, which includes some of the above.
	 *
	 * Passed to the middleware.
	 */
	networkInfo: NetworkInfo;

	/**
	 * The reliability of this remote.
	 *
	 * Defaults to reliable.
	 */
	reliability?: "reliable" | "unreliable";

	/**
	 * A list of middleware that this event uses when it receives an event.
	 */
	incomingMiddleware?: MiddlewareFactory<any[], void>[];

	/**
	 * The generated argument checks, run on what arrives before any middleware. A message that fails
	 * them is dropped.
	 */
	incomingGuards?: Guards;

	/**
	 * Unpacks the argument list of incoming events. Absent when the project does not enable
	 * serialization. Outgoing lists reach `fire*` already packed: the transformer generates the
	 * encoding inline at each call site.
	 */
	incomingDecoder?: Serialization.Decoder;

	/**
	 * Called when an incoming payload cannot be decoded; the event is dropped.
	 */
	onMalformed?: (player: Player | undefined, message: string) => void;
}

export interface EventInterface {
	fireEither(player: Player | undefined, ...args: unknown[]): void;
	fireServer(...args: unknown[]): void;
	fireClient(player: Player, ...args: unknown[]): void;
	fireAllClients(...args: unknown[]): void;
	connectServer(callback: (player: Player, ...args: unknown[]) => void): SignalConnection;
	connectClient(callback: (...args: unknown[]) => void): SignalConnection;

	/**
	 * Runs the receiving half as if the remote had delivered `args` (plain values, never a payload), on
	 * a recycled thread of its own, so that a middleware that yields does not hold up the caller.
	 */
	predict(player: Player | undefined, ...args: unknown[]): void;
}

/**
 * The argument list a remote delivered: `args` as they are without a decoder, otherwise the buffer
 * and blob list unpacked. `undefined` when the payload was malformed, after reporting it through
 * `onMalformed`. Decoding runs under `pcall`: a hostile buffer raises instead of yielding garbage.
 *
 * Either way the list is trimmed after its last value, so that no hop after it loses the values
 * that follow a nil (see `trimArguments`). A decoded list keeps one slot per declared parameter,
 * so an absent trailing optional would otherwise end it in nil.
 *
 * An event's own messages are decoded in the receive pipeline (`processor.luau`); this is for a
 * function's requests and responses, which carry a plain request id ahead of the payload.
 */
export function decodeArguments(
	decoder: Serialization.Decoder | undefined,
	player: Player | undefined,
	args: unknown[],
	onMalformed?: (player: Player | undefined, message: string) => void,
): unknown[] | undefined {
	if (!decoder) return trimArguments(args);

	const [ok, result] = decode(decoder, args[0], args[1]);
	if (!ok) {
		onMalformed?.(player, result);
		return undefined;
	}

	return trimArguments(result);
}

export function createEvent(options: CreateEventOptions): EventInterface {
	const remote = createRemoteInstance(
		options.reliability === "unreliable" ? "UnreliableRemoteEvent" : "RemoteEvent",
		options.namespace,
		options.debugName,
		options.id,
	) as RemoteEvent;

	// Which half this event is, fixed when it is made: the server's handlers are given the sender.
	const isServer = RunService.IsServer();

	// Passes the arguments by reference. A BindableEvent would copy them, turning a decoded
	// `Map<Instance, ...>` into one keyed by strings and raising on a `Set<boolean>`.
	const signal = createSignal();

	// Guards, then middleware, then the signal: plain calls in the thread that received the message.
	const process = createProcessor(
		options.incomingMiddleware,
		options.networkInfo,
		deliverTo(signal, isServer),
		options.incomingGuards,
		undefined,
		undefined,
	);

	// Nothing to deliver to until something connects (a `predict` may come first), so the remote is
	// only listened to from the first connection on.
	let listening = false;
	const listen = () => {
		if (listening) return;
		listening = true;

		// We defer to allow any other immediate connections to take place before unloading Roblox's queue.
		task.defer(() => {
			// Runs in the thread the engine gives the handler, one per message.
			const receive = createReceiver(options.incomingDecoder, options.onMalformed, process, isServer);
			if (isServer) {
				remote.OnServerEvent.Connect(receive);
			} else {
				remote.OnClientEvent.Connect(receive);
			}
		});
	};

	return {
		fireEither(player, ...args) {
			if (player) {
				this.fireClient(player, ...args);
			} else {
				this.fireServer(...args);
			}
		},

		fireServer(...args) {
			remote.FireServer(...args);
		},

		fireClient(player, ...args) {
			remote.FireClient(player, ...args);
		},

		fireAllClients(...args) {
			remote.FireAllClients(...args);
		},

		connectServer(callback) {
			assert(RunService.IsServer());

			listen();
			return signal.Connect(callback);
		},

		connectClient(callback) {
			assert(RunService.IsClient());

			listen();
			return signal.Connect(callback);
		},

		predict(player, ...args) {
			spawn(process, player, ...args);
		},
	};
}
