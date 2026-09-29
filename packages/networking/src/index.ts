import { GlobalEvent } from "./events/types";
import { GlobalFunction } from "./functions/types";
import { Skip as NetworkingSkip } from "./middleware/skip";
import { NetworkingFunctionError } from "./function/errors";
import {
	MiddlewareFactory as _MiddlewareFactory,
	EventMiddleware as _EventMiddleware,
	FunctionMiddleware as _FunctionMiddleware,
} from "./middleware/types";
import { SignalConnection as _SignalConnection } from "./util/signal";
import { createNetworkingEvent } from "./events/createNetworkingEvent";
import { createNetworkingFunction } from "./functions/createNetworkingFunction";
import { NetworkInfo as _NetworkInfo, NetworkRaw, NetworkSerialized, NetworkUnreliable } from "./types";
import type { Modding } from "@flamework-experimental/core";

export namespace Networking {
	/**
	 * Creates a new event based off the supplied types.
	 * @param serverMiddleware Middleware for server events
	 * @param clientMiddleware Middleware for client events
	 * @metadata macro
	 */
	export function createEvent<S, C>(name?: Modding.Caller.Uuid): GlobalEvent<S, C> {
		return createNetworkingEvent(name!);
	}

	/**
	 * Creates a new function event based off the supplied types.
	 * @param serverMiddleware Middleware for server events
	 * @param clientMiddleware Middleware for client events
	 * @metadata macro
	 */
	export function createFunction<S, C>(name?: Modding.Caller.Uuid): GlobalFunction<S, C> {
		return createNetworkingFunction(name!);
	}

	/**
	 * Stops networking function middleware.
	 */
	export const Skip = NetworkingSkip;

	/**
	 * Specifies that this event is unreliable.
	 *
	 * This will only work on remote events.
	 */
	export type Unreliable<T> = NetworkUnreliable<T>;

	/**
	 * Sends this event's arguments as they are, bypassing `networking.serialization` for this event
	 * alone. The generated guards still run on what arrives.
	 */
	export type RawReliable<T> = NetworkRaw<T>;

	/**
	 * An unreliable event whose arguments bypass serialization; see {@link RawReliable}.
	 */
	export type RawUnreliable<T> = NetworkUnreliable<NetworkRaw<T>>;

	/**
	 * A function whose requests and results bypass serialization; see {@link RawReliable}.
	 */
	export type Raw<T> = NetworkRaw<T>;

	/**
	 * Packs this event's arguments into a buffer even when `networking.serialization` is off, exactly
	 * as the switch would. With the switch on, it changes nothing.
	 *
	 * `Unreliable<Serialized<T>>` and `Serialized<Unreliable<T>>` are the same as `SerializedUnreliable<T>`.
	 * It cannot be combined with `Raw`.
	 */
	export type SerializedReliable<T> = NetworkSerialized<T>;

	/**
	 * An unreliable event whose arguments are packed into a buffer; see {@link SerializedReliable}.
	 */
	export type SerializedUnreliable<T> = NetworkUnreliable<NetworkSerialized<T>>;

	/**
	 * A function whose requests and results are packed into a buffer; see {@link SerializedReliable}.
	 */
	export type Serialized<T> = NetworkSerialized<T>;

	/**
	 * What a middleware factory receives as its second argument: the event or function's `name`,
	 * `globalName` and `eventType`.
	 */
	export type NetworkInfo = _NetworkInfo;

	/**
	 * A function that generates an event middleware.
	 */
	export type EventMiddleware<I extends readonly unknown[] = unknown[]> = _EventMiddleware<I>;

	/**
	 * A function that generates an event middleware.
	 */
	export type FunctionMiddleware<I extends readonly unknown[] = unknown[], O = void> = _FunctionMiddleware<I, O>;

	/**
	 * What `connect` and `registerHandler` return: `Connected`, `Disconnect()`, and `Destroy()` for
	 * maids and janitors. It is networking's own, not an engine `RBXScriptConnection`.
	 */
	export type Connection = _SignalConnection;
}

export { NetworkingFunctionError };
