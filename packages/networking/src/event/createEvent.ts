import { Serialization } from "@flamework/core";
import { RunService } from "@rbxts/services";
import { MiddlewareFactory, MiddlewareProcessor } from "../middleware/types";
import { createRemoteInstance } from "./createRemoteInstance";
import { NetworkInfo } from "../types";
import { createMiddlewareProcessor } from "../middleware/createMiddlewareProcessor";

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
	 * Packs the argument list of outgoing events into a buffer, plus a blob list when the types call
	 * for one. Generated from the event's types; absent when the project does not enable serialization.
	 */
	outgoingCodec?: Serialization.Codec;

	/**
	 * Unpacks the argument list of incoming events. Absent when the project does not enable serialization.
	 */
	incomingCodec?: Serialization.Codec;

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
	connectServer(callback: (player: Player, ...args: unknown[]) => void): RBXScriptConnection;
	connectClient(callback: (...args: unknown[]) => void): RBXScriptConnection;
	invoke: MiddlewareProcessor<any[], void>;
}

/** A sender whose type has blob slots always sends a table; one without never does. */
const NO_BLOBS = new Array<defined>();

/**
 * The argument list a remote delivered: `args` as they are without a codec, otherwise the buffer and
 * blob list unpacked. `undefined` when the payload was malformed, after reporting it through
 * `onMalformed`. Decoding runs under `pcall`: a hostile buffer raises instead of yielding garbage.
 */
export function decodeArguments(
	codec: Serialization.Codec | undefined,
	player: Player | undefined,
	args: unknown[],
	onMalformed?: (player: Player | undefined, message: string) => void,
): unknown[] | undefined {
	if (!codec) return args;

	const [payload, blobs] = args;
	if (!typeIs(payload, "buffer") || (blobs !== undefined && !typeIs(blobs, "table"))) {
		onMalformed?.(player, "payload is not a buffer with an optional blob list");
		return undefined;
	}

	const [ok, result] = pcall(codec.decode, payload, (blobs ?? NO_BLOBS) as Array<defined>);
	if (!ok) {
		onMalformed?.(player, tostring(result));
		return undefined;
	}

	return result as unknown[];
}

export function createEvent(options: CreateEventOptions): EventInterface {
	const remote = createRemoteInstance(
		options.reliability === "unreliable" ? "UnreliableRemoteEvent" : "RemoteEvent",
		options.namespace,
		options.debugName,
		options.id,
	) as RemoteEvent;

	let bindable: BindableEvent | undefined;

	const invoke = createMiddlewareProcessor(options.incomingMiddleware, options.networkInfo, (player, ...args) => {
		if (RunService.IsServer()) {
			bindable!.Fire(player as never, ...(args as never[]));
		} else {
			bindable!.Fire(...(args as never[]));
		}
	});

	const receive = (player: Player | undefined, args: unknown[]) => {
		const decoded = decodeArguments(options.incomingCodec, player, args, options.onMalformed);
		if (decoded) {
			invoke(player, ...decoded);
		}
	};

	const createConnection = (callback: (...args: never[]) => void) => {
		if (bindable) {
			return bindable.Event.Connect(callback);
		}

		bindable = new Instance("BindableEvent");

		// We defer to allow any other immediate connections to take place before unloading Roblox's queue.
		task.defer(() => {
			if (RunService.IsServer()) {
				remote.OnServerEvent.Connect((player, ...args) => receive(player, args));
			} else {
				remote.OnClientEvent.Connect((...args: unknown[]) => receive(undefined, args));
			}
		});

		return bindable.Event.Connect(callback);
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
			const codec = options.outgoingCodec;
			if (codec) {
				const [payload, blobs] = codec.encode(args);
				remote.FireServer(payload, blobs);
			} else {
				remote.FireServer(...args);
			}
		},

		fireClient(player, ...args) {
			const codec = options.outgoingCodec;
			if (codec) {
				const [payload, blobs] = codec.encode(args);
				remote.FireClient(player, payload, blobs);
			} else {
				remote.FireClient(player, ...args);
			}
		},

		fireAllClients(...args) {
			const codec = options.outgoingCodec;
			if (codec) {
				const [payload, blobs] = codec.encode(args);
				remote.FireAllClients(payload, blobs);
			} else {
				remote.FireAllClients(...args);
			}
		},

		connectServer(callback) {
			assert(RunService.IsServer());

			return createConnection(callback);
		},

		connectClient(callback) {
			assert(RunService.IsClient());

			return createConnection(callback);
		},

		invoke,
	};
}
