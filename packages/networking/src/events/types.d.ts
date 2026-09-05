import {
	FunctionParameters,
	IntrinsicTupleGuards,
	IntrinsicNetworkDecoder,
	IntrinsicObfuscate,
	NetworkingObfuscationMarker,
	NetworkRaw,
	NetworkUnreliable,
	ObfuscateNames,
} from "../types";
import { EventNetworkingEvents } from "../handlers";
import { EventMiddleware } from "../middleware/types";
import { Modding } from "@flamework/core";

/**
 * A sender declared `Networking.RawReliable` / `RawUnreliable`: its arguments travel as they are.
 * Without the hidden marker below, no call site packs them and the peer runs no decoder.
 */
export interface RawServerSender<I extends unknown[]> {
	(player: Player | Player[], ...args: I): void;

	/**
	 * Sends this request to the specified player(s).
	 * @param players The player(s) that will receive this event
	 */
	fire(players: Player | Player[], ...args: I): void;

	/**
	 * Sends this request to all players, excluding the specified player(s).
	 * @param players The player(s) that will not receive this event
	 */
	except(players: Player | Player[], ...args: I): void;

	/**
	 * Sends this request to all connected players.
	 */
	broadcast(...args: I): void;
}

export interface ServerSender<I extends unknown[]> extends RawServerSender<I> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_fire(players: Player | Player[], payload?: buffer, blobs?: Array<defined>): void;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_except(players: Player | Player[], payload?: buffer, blobs?: Array<defined>): void;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_broadcast(payload?: buffer, blobs?: Array<defined>): void;
}

export interface RawServerReceiver<I extends unknown[]> {
	/**
	 * Connect to this networking event.
	 * @param callback The callback that will be fired
	 */
	connect(cb: (player: Player, ...args: I) => void): RBXScriptConnection;

	/**
	 * Fires a server event using player as the sender.
	 */
	predict(player: Player, ...args: I): void;
}

export interface ServerReceiver<I extends unknown[]> extends RawServerReceiver<I> {
	/** @hidden Marks a receiver for the transformer. */
	readonly _flamework_receive?: I;
}

export interface RawClientSender<I extends unknown[]> {
	(...args: I): void;

	/**
	 * Sends this request to the server.
	 */
	fire(...args: I): void;
}

export interface ClientSender<I extends unknown[]> extends RawClientSender<I> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_fire(payload?: buffer, blobs?: Array<defined>): void;
}

export interface RawClientReceiver<I extends unknown[]> {
	/**
	 * Connect to this networking event.
	 * @param callback The callback that will be fired
	 */
	connect(cb: (...args: I) => void): RBXScriptConnection;

	/**
	 * Fires a client event.
	 */
	predict(...args: I): void;
}

export interface ClientReceiver<I extends unknown[]> extends RawClientReceiver<I> {
	/** @hidden Marks a receiver for the transformer. */
	readonly _flamework_receive?: I;
}

export type ServerHandler<E, R> = NetworkingObfuscationMarker & {
	[k in keyof Events<E>]: E[k] extends NetworkRaw<unknown>
		? RawServerSender<FunctionParameters<E[k]>>
		: ServerSender<FunctionParameters<E[k]>>;
} & {
	[k in keyof Events<R>]: R[k] extends NetworkRaw<unknown>
		? RawServerReceiver<FunctionParameters<R[k]>>
		: ServerReceiver<FunctionParameters<R[k]>>;
} & {
	[k in keyof EventNamespaces<E>]: ServerHandler<E[k], k extends keyof R ? R[k] : {}>;
} & {
	[k in keyof EventNamespaces<R>]: ServerHandler<k extends keyof E ? E[k] : {}, R[k]>;
};

export type ClientHandler<E, R> = NetworkingObfuscationMarker & {
	[k in keyof Events<E>]: E[k] extends NetworkRaw<unknown>
		? RawClientSender<FunctionParameters<E[k]>>
		: ClientSender<FunctionParameters<E[k]>>;
} & {
	[k in keyof Events<R>]: R[k] extends NetworkRaw<unknown>
		? RawClientReceiver<FunctionParameters<R[k]>>
		: ClientReceiver<FunctionParameters<R[k]>>;
} & {
	[k in keyof EventNamespaces<E>]: ClientHandler<E[k], k extends keyof R ? R[k] : {}>;
} & {
	[k in keyof EventNamespaces<R>]: ClientHandler<k extends keyof E ? E[k] : {}, R[k]>;
};

export interface EventCreateConfiguration<T> {
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
	 * The middleware for each event.
	 */
	middleware: EventMiddlewareList<T>;
}

export interface GlobalEvent<S, C> {
	/**
	 * This is the server implementation of the network and does not exist on the client.
	 *
	 * @metadata macro {@link config intrinsic-const} {@link config intrinsic-middleware}
	 */
	createServer(config: Partial<EventCreateConfiguration<S>>, meta?: NamespaceMetadata<S, C>): ServerHandler<C, S>;

	/**
	 * This is the client implementation of the network and does not exist on the server.
	 *
	 * @metadata macro {@link config intrinsic-const} {@link config intrinsic-middleware}
	 */
	createClient(config: Partial<EventCreateConfiguration<C>>, meta?: NamespaceMetadata<C, S>): ClientHandler<S, C>;

	/**
	 * Registers a networking event handler.
	 * @param key The name of the event
	 * @param callback The handler you wish to attach
	 */
	registerHandler<K extends keyof EventNetworkingEvents>(
		key: K,
		callback: EventNetworkingEvents[K],
	): RBXScriptConnection;
}

export type EventNamespaces<T> = ExcludeMembers<T, Callback>;
export type Events<T> = ExtractMembers<T, Callback>;

export type NamespaceMetadata<R, S> = Modding.Emit<{
	incomingIds: ObfuscateNames<keyof Events<R>>;
	incoming: IntrinsicObfuscate<{ [k in keyof Events<R>]: IntrinsicTupleGuards<Parameters<Events<R>[k]>> }>;
	incomingUnreliable: IntrinsicObfuscate<{
		[k in keyof Events<R>]: R[k] extends NetworkUnreliable<unknown> ? true : undefined;
	}>;

	outgoingIds: ObfuscateNames<keyof Events<S>>;
	outgoingUnreliable: IntrinsicObfuscate<{
		[k in keyof Events<S>]: S[k] extends NetworkUnreliable<unknown> ? true : undefined;
	}>;

	/**
	 * Decoders for each incoming event's argument list, present only with `networking.serialization`
	 * on, and absent for raw events and for lists that carry nothing. Outgoing lists are packed
	 * inline where they are fired; nothing here can encode.
	 */
	incomingSerializers: IntrinsicObfuscate<{
		[k in keyof Events<R>]: R[k] extends NetworkRaw<unknown>
			? undefined
			: IntrinsicNetworkDecoder<Parameters<Events<R>[k]>>;
	}>;

	namespaceIds: ObfuscateNames<keyof EventNamespaces<R> | keyof EventNamespaces<S>>;
	namespaces: IntrinsicObfuscate<
		{
			[k in keyof EventNamespaces<R>]: NamespaceMetadata<R[k], k extends keyof S ? S[k] : {}>;
		} & {
			[k in keyof EventNamespaces<S>]: NamespaceMetadata<k extends keyof R ? R[k] : {}, S[k]>;
		}
	>;
}>;

export type EventMiddlewareList<T> = {
	readonly [k in keyof Events<T>]?: T[k] extends (...args: infer I) => void ? [...EventMiddleware<I>[]] : never;
} & {
	readonly [k in keyof EventNamespaces<T>]?: EventMiddlewareList<T[k]>;
};
