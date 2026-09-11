import { NetworkingFunctionError } from "../function/errors";
import {
	FunctionParameters,
	FunctionReturn,
	IntrinsicTupleGuards,
	IntrinsicNetworkDecoder,
	IntrinsicNetworkResultDecoder,
	IntrinsicObfuscate,
	NetworkingObfuscationMarker,
	NetworkRaw,
	ObfuscateNames,
} from "../types";
import { FunctionNetworkingEvents } from "../handlers";
import { FunctionMiddleware } from "../middleware/types";
import { Modding } from "@flamework-experimental/core";

/**
 * A sender declared `Networking.Raw`: its arguments and the result travel as they are. Without the
 * hidden marker below, no call site packs them and the peer runs no decoder.
 */
export interface RawServerSender<I extends unknown[], O> {
	(player: Player, ...args: I): Promise<O>;

	/**
	 * Sends this request to the specified player.
	 * @param player The player that will receive this event
	 */
	invoke(player: Player, ...args: I): Promise<O>;

	/**
	 * Sends this request to the specified player, specifying a timeout.
	 * @param player The player that will receive this event
	 * @param timeout The maximum time to wait before timing out
	 */
	invokeWithTimeout(player: Player, timeout: number, ...args: I): Promise<O>;
}

export interface ServerSender<I extends unknown[], O> extends RawServerSender<I, O> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_invoke(player: Player, payload?: buffer, blobs?: Array<defined>): Promise<O>;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_invokeWithTimeout(player: Player, timeout: number, payload?: buffer, blobs?: Array<defined>): Promise<O>;
}

export interface RawServerReceiver<I extends unknown[], O> {
	/**
	 * Connect to a networking event.
	 * @param event The event to connect to
	 * @param callback The callback that will be invoked
	 * @param guards A list of guards that will only be used on this connection
	 */
	setCallback(callback: (player: Player, ...args: I) => O | Promise<O>): void;

	/**
	 * Invokes a server function using player as the sender.
	 */
	predict(player: Player, ...args: I): Promise<O>;
}

export interface ServerReceiver<I extends unknown[], O, F = unknown> extends RawServerReceiver<I, O> {
	/** @hidden Marks a receiver for the transformer, which packs the callback's result at the call site. */
	readonly _flamework_receive?: I;

	/** @hidden The declared function type; its return type is what the transformer packs. */
	readonly _flamework_fn?: F;

	/** @hidden Registers a callback whose successful results are already packed as `[payload, blobs?]`. */
	_setCallback(callback: (player: Player, ...args: never[]) => unknown): void;
}

export interface RawClientSender<I extends unknown[], O> {
	(...args: I): Promise<O>;

	/**
	 * Sends this request to the server.
	 */
	invoke(...args: I): Promise<O>;

	/**
	 * Sends this request to the server, specifying a timeout.
	 * @param timeout The maximum time to wait before timing out
	 */
	invokeWithTimeout(timeout: number, ...args: I): Promise<O>;
}

export interface ClientSender<I extends unknown[], O> extends RawClientSender<I, O> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_invoke(payload?: buffer, blobs?: Array<defined>): Promise<O>;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_invokeWithTimeout(timeout: number, payload?: buffer, blobs?: Array<defined>): Promise<O>;
}

export interface RawClientReceiver<I extends unknown[], O> {
	/**
	 * Connect to a networking function.
	 * @param event The function to connect to
	 * @param callback The callback that will be invoked
	 */
	setCallback(callback: (...args: I) => O | Promise<O>): void;

	/**
	 * Invokes a client function.
	 */
	predict(...args: I): Promise<O>;
}

export interface ClientReceiver<I extends unknown[], O, F = unknown> extends RawClientReceiver<I, O> {
	/** @hidden Marks a receiver for the transformer, which packs the callback's result at the call site. */
	readonly _flamework_receive?: I;

	/** @hidden The declared function type; its return type is what the transformer packs. */
	readonly _flamework_fn?: F;

	/** @hidden Registers a callback whose successful results are already packed as `[payload, blobs?]`. */
	_setCallback(callback: (...args: never[]) => unknown): void;
}

export type ServerHandler<E, R> = NetworkingObfuscationMarker & {
	[k in keyof Functions<E>]: E[k] extends NetworkRaw<unknown>
		? RawServerSender<FunctionParameters<E[k]>, FunctionReturn<E[k]>>
		: ServerSender<FunctionParameters<E[k]>, FunctionReturn<E[k]>>;
} & {
	[k in keyof Functions<R>]: R[k] extends NetworkRaw<unknown>
		? RawServerReceiver<FunctionParameters<R[k]>, FunctionReturn<R[k]>>
		: ServerReceiver<FunctionParameters<R[k]>, FunctionReturn<R[k]>, R[k]>;
} & {
	[k in keyof FunctionNamespaces<E>]: ServerHandler<E[k], k extends keyof R ? R[k] : {}>;
} & {
	[k in keyof FunctionNamespaces<R>]: ServerHandler<k extends keyof E ? E[k] : {}, R[k]>;
};

export type ClientHandler<E, R> = NetworkingObfuscationMarker & {
	[k in keyof Functions<E>]: E[k] extends NetworkRaw<unknown>
		? RawClientSender<FunctionParameters<E[k]>, FunctionReturn<E[k]>>
		: ClientSender<FunctionParameters<E[k]>, FunctionReturn<E[k]>>;
} & {
	[k in keyof Functions<R>]: R[k] extends NetworkRaw<unknown>
		? RawClientReceiver<FunctionParameters<R[k]>, FunctionReturn<R[k]>>
		: ClientReceiver<FunctionParameters<R[k]>, FunctionReturn<R[k]>, R[k]>;
} & {
	[k in keyof FunctionNamespaces<E>]: ClientHandler<E[k], k extends keyof R ? R[k] : {}>;
} & {
	[k in keyof FunctionNamespaces<R>]: ClientHandler<k extends keyof E ? E[k] : {}, R[k]>;
};

export interface FunctionCreateConfiguration<T> {
	/**
	 * Disables input validation, allowing any value to pass.
	 * Defaults to `false`
	 */
	disableIncomingGuards: boolean;

	/**
	 * Emit a warning whenever a guard fails.
	 * Defaults to `RunService.IsStudio()`
	 */
	warnOnInvalidGuards: boolean;

	/**
	 * The default timeout for outgoing requests.
	 * Defaults to `10`
	 */
	defaultTimeout: number;

	/**
	 * The middleware for each event.
	 */
	middleware: FunctionMiddlewareList<T>;
}

export interface GlobalFunction<S, C> {
	/**
	 * This is the server implementation of the network and does not exist on the client.
	 *
	 * @metadata macro {@link config intrinsic-const} {@link config intrinsic-middleware}
	 */
	createServer(config: Partial<FunctionCreateConfiguration<S>>, meta?: NamespaceMetadata<S, C>): ServerHandler<C, S>;

	/**
	 * This is the client implementation of the network and does not exist on the server.
	 *
	 * @metadata macro {@link config intrinsic-const} {@link config intrinsic-middleware}
	 */
	createClient(config: Partial<FunctionCreateConfiguration<C>>, meta?: NamespaceMetadata<C, S>): ClientHandler<S, C>;

	/**
	 * Registers a networking event handler.
	 * @param key The name of the event
	 * @param callback The handler you wish to attach
	 */
	registerHandler<K extends keyof FunctionNetworkingEvents>(
		key: K,
		callback: FunctionNetworkingEvents[K],
	): RBXScriptConnection;
}

export interface FunctionConfiguration {
	/**
	 * Disables input validation and return validation on the server, allowing any value to pass.
	 * Defaults to `false`
	 */
	disableServerGuards: boolean;

	/**
	 * Disables input validation and return validation on the client, allowing any value to pass.
	 * Defaults to `false`
	 */
	disableClientGuards: boolean;

	/**
	 * The default timeout for requests from the server to the client.
	 * Defaults to `10`
	 */
	defaultServerTimeout: number;

	/**
	 * The default timeout for requests from the client to the server.
	 * Defaults to `30`
	 */
	defaultClientTimeout: number;

	/**
	 * Emit a warning whenever a guard fails.
	 * Defaults to `RunService.IsStudio()`
	 */
	warnOnInvalidGuards: boolean;
}

export interface RequestInfo {
	nextId: number;
	requests: Map<number, (value: unknown, rejection?: NetworkingFunctionError) => void>;
}

export type FunctionNamespaces<T> = ExcludeMembers<T, Callback>;
export type Functions<T> = ExtractMembers<T, Callback>;

/**
 * We must generate the return type of events separately as Flamework no longer includes all type guards on both server and client.
 */
export type NamespaceMetadata<R, S> = Modding.Emit<{
	incomingIds: ObfuscateNames<keyof Functions<R>>;
	incoming: IntrinsicObfuscate<{ [k in keyof Functions<R>]: IntrinsicTupleGuards<Parameters<R[k]>> }>;

	outgoingIds: ObfuscateNames<keyof Functions<S>>;
	outgoing: IntrinsicObfuscate<{ [k in keyof Functions<S>]: Modding.Target.Guard<ReturnType<S[k]>> }>;

	/**
	 * Decoders, present only with `networking.serialization` on and absent for raw functions: the
	 * argument lists of requests this realm receives, the results its callbacks return (so `predict`
	 * can unpack them) and the responses to requests it sends. Requests and results are packed inline
	 * where they are produced.
	 */
	incomingSerializers: IntrinsicObfuscate<{
		[k in keyof Functions<R>]: R[k] extends NetworkRaw<unknown>
			? undefined
			: IntrinsicNetworkDecoder<Parameters<R[k]>>;
	}>;
	incomingResults: IntrinsicObfuscate<{
		[k in keyof Functions<R>]: R[k] extends NetworkRaw<unknown> ? undefined : IntrinsicNetworkResultDecoder<R[k]>;
	}>;
	outgoingResults: IntrinsicObfuscate<{
		[k in keyof Functions<S>]: S[k] extends NetworkRaw<unknown> ? undefined : IntrinsicNetworkResultDecoder<S[k]>;
	}>;

	namespaceIds: ObfuscateNames<keyof FunctionNamespaces<R> | keyof FunctionNamespaces<S>>;
	namespaces: IntrinsicObfuscate<
		{
			[k in keyof FunctionNamespaces<R>]: NamespaceMetadata<R[k], k extends keyof S ? S[k] : {}>;
		} & {
			[k in keyof FunctionNamespaces<S>]: NamespaceMetadata<k extends keyof R ? R[k] : {}, S[k]>;
		}
	>;
}>;

export type FunctionMiddlewareList<T> = {
	readonly [k in keyof Functions<T>]?: T[k] extends (...args: infer I) => infer O
		? [...FunctionMiddleware<I, O>[]]
		: never;
} & {
	readonly [k in keyof FunctionNamespaces<T>]?: FunctionMiddlewareList<T[k]>;
};
