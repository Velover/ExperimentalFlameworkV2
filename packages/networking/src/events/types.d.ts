import {
	FunctionParameters,
	IntrinsicTupleGuards,
	IntrinsicNetworkDecoder,
	IntrinsicNetworkUnreliable,
	IntrinsicObfuscate,
	IsRawMember,
	NetworkingObfuscationMarker,
	NetworkMemberName,
	NetworkPacking,
	ObfuscateNames,
} from "../types";
import { EventNetworkingEvents } from "../handlers";
import { EventMiddleware } from "../middleware/types";
import { SignalConnection } from "../util/signal";
import { Modding } from "@flamework-experimental/core";

/**
 * A sender declared `Networking.RawReliable` / `RawUnreliable`: its arguments travel as they are.
 * Without the hidden marker below, no call site packs them and the peer runs no decoder.
 */
export interface RawServerSender<I extends unknown[], M = "raw"> {
	(player: Player | Player[], ...args: I): void;

	/** @hidden How the member is packed (see `NetworkPacking`), which keeps differently packed members apart in a union. */
	readonly _flamework_packing?: M;

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

export interface ServerSender<
	I extends unknown[],
	F = unknown,
	M = NetworkPacking<F>,
	K extends string = string,
> extends RawServerSender<I, M> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden The declared member, whose markers (`Serialized`) say whether its call sites pack. */
	readonly _flamework_fn?: F;

	/**
	 * @hidden The member's name after its namespaces' names (`items.setA`; see `NetworkMemberName`),
	 * which keeps members whose types are otherwise the same apart in a union. A sender type written
	 * without it (`ClientSender<[number]>`) takes any member's.
	 */
	readonly _flamework_member?: K;

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
	connect(cb: (player: Player, ...args: I) => void): SignalConnection;

	/**
	 * Fires a server event using player as the sender.
	 */
	predict(player: Player, ...args: I): void;
}

export interface ServerReceiver<I extends unknown[]> extends RawServerReceiver<I> {
	/** @hidden Marks a receiver for the transformer. */
	readonly _flamework_receive?: I;
}

export interface RawClientSender<I extends unknown[], M = "raw"> {
	(...args: I): void;

	/** @hidden How the member is packed (see `NetworkPacking`), which keeps differently packed members apart in a union. */
	readonly _flamework_packing?: M;

	/**
	 * Sends this request to the server.
	 */
	fire(...args: I): void;
}

export interface ClientSender<
	I extends unknown[],
	F = unknown,
	M = NetworkPacking<F>,
	K extends string = string,
> extends RawClientSender<I, M> {
	/** @hidden Marks a sender for the transformer, which packs its arguments at each call site. */
	readonly _flamework_send?: I;

	/** @hidden The declared member, whose markers (`Serialized`) say whether its call sites pack. */
	readonly _flamework_fn?: F;

	/**
	 * @hidden The member's name after its namespaces' names (`items.setA`; see `NetworkMemberName`),
	 * which keeps members whose types are otherwise the same apart in a union. A sender type written
	 * without it (`ClientSender<[number]>`) takes any member's.
	 */
	readonly _flamework_member?: K;

	/** @hidden Sends an argument list the transformer already packed; nothing when the list carries nothing. */
	_fire(payload?: buffer, blobs?: Array<defined>): void;
}

export interface RawClientReceiver<I extends unknown[]> {
	/**
	 * Connect to this networking event.
	 * @param callback The callback that will be fired
	 */
	connect(cb: (...args: I) => void): SignalConnection;

	/**
	 * Fires a client event.
	 */
	predict(...args: I): void;
}

export interface ClientReceiver<I extends unknown[]> extends RawClientReceiver<I> {
	/** @hidden Marks a receiver for the transformer. */
	readonly _flamework_receive?: I;
}

/**
 * The server's handler: senders for the events `E`, receivers for the events `R`, and a handler of
 * the same kind for each namespace. `P` is the namespace path of its members (`"items."`), which each
 * sender carries in its name (`NetworkMemberName`).
 */
export type ServerHandler<E, R, P extends string = ""> = NetworkingObfuscationMarker & {
	[k in keyof Events<E>]: IsRawMember<E[k]> extends true
		? RawServerSender<FunctionParameters<E[k]>>
		: ServerSender<FunctionParameters<E[k]>, E[k], NetworkPacking<E[k]>, NetworkMemberName<P, k>>;
} & {
	[k in keyof Events<R>]: IsRawMember<R[k]> extends true
		? RawServerReceiver<FunctionParameters<R[k]>>
		: ServerReceiver<FunctionParameters<R[k]>>;
} & {
	[k in keyof EventNamespaces<E>]: ServerHandler<E[k], k extends keyof R ? R[k] : {}, `${NetworkMemberName<P, k>}.`>;
} & {
	[k in keyof EventNamespaces<R>]: ServerHandler<k extends keyof E ? E[k] : {}, R[k], `${NetworkMemberName<P, k>}.`>;
};

/** The client's handler; see {@link ServerHandler}. */
export type ClientHandler<E, R, P extends string = ""> = NetworkingObfuscationMarker & {
	[k in keyof Events<E>]: IsRawMember<E[k]> extends true
		? RawClientSender<FunctionParameters<E[k]>>
		: ClientSender<FunctionParameters<E[k]>, E[k], NetworkPacking<E[k]>, NetworkMemberName<P, k>>;
} & {
	[k in keyof Events<R>]: IsRawMember<R[k]> extends true
		? RawClientReceiver<FunctionParameters<R[k]>>
		: ClientReceiver<FunctionParameters<R[k]>>;
} & {
	[k in keyof EventNamespaces<E>]: ClientHandler<E[k], k extends keyof R ? R[k] : {}, `${NetworkMemberName<P, k>}.`>;
} & {
	[k in keyof EventNamespaces<R>]: ClientHandler<k extends keyof E ? E[k] : {}, R[k], `${NetworkMemberName<P, k>}.`>;
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
	): SignalConnection;
}

export type EventNamespaces<T> = ExcludeMembers<T, Callback>;
export type Events<T> = ExtractMembers<T, Callback>;

export type NamespaceMetadata<R, S> = Modding.Emit<{
	incomingIds: ObfuscateNames<keyof Events<R>>;
	incoming: IntrinsicObfuscate<{ [k in keyof Events<R>]: IntrinsicTupleGuards<Parameters<Events<R>[k]>> }>;
	incomingUnreliable: IntrinsicObfuscate<{
		[k in keyof Events<R>]: IntrinsicNetworkUnreliable<R[k], k>;
	}>;

	outgoingIds: ObfuscateNames<keyof Events<S>>;
	outgoingUnreliable: IntrinsicObfuscate<{
		[k in keyof Events<S>]: IntrinsicNetworkUnreliable<S[k], k>;
	}>;

	/**
	 * Decoders for each incoming event's argument list, present for the events that are packed (all of
	 * them with `networking.serialization` on, else the serialized ones) and absent for raw events and
	 * for lists that carry nothing. Outgoing lists are packed inline where they are fired; nothing here
	 * can encode.
	 */
	incomingSerializers: IntrinsicObfuscate<{
		[k in keyof Events<R>]: IntrinsicNetworkDecoder<Parameters<Events<R>[k]>, R[k], k>;
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
