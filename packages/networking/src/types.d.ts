import { Modding, Serialization } from "@flamework-experimental/core";
import { t } from "@rbxts/t";

export interface NetworkInfo {
	/**
	 * The name provided for this event.
	 */
	name: string;

	/**
	 * The (generated) global name used for distinguishing different createEvent calls.
	 */
	globalName: string;

	/**
	 * Whether this remote is an event or function.
	 */
	eventType: "Event" | "Function";
}

export type NetworkUnreliable<T> = T & { _flamework_unreliable: never };

/**
 * Marks an event or function whose values travel as they are, outside serialization: the transformer
 * leaves its call sites alone and the metadata carries no decoder for it.
 */
export type NetworkRaw<T> = T & { _flamework_raw: never };

/**
 * Marks an event or function whose values are packed into a buffer whether or not the project turns
 * `networking.serialization` on: the call sites encode and the metadata decodes, exactly as the switch
 * would have them do.
 */
export type NetworkSerialized<T> = T & { _flamework_serialized: never };

/**
 * A member declared raw and nothing else. One that is also serialized gets the marked handler
 * instead, so that the transformer sees it where it is used and reports the conflict.
 */
export type IsRawMember<T> =
	T extends NetworkRaw<unknown> ? (T extends NetworkSerialized<unknown> ? false : true) : false;

/**
 * How the member `F` is packed. Each sender and function receiver takes it as a type argument of its
 * own and carries it as the hidden `_flamework_packing`, so members that are packed differently have
 * unrelated handler types. (Worked out from `F` inside the interface, it would be compared through
 * `F`, which a `Serialized` member's type extends.) A union of them, from a conditional or a helper
 * that returns one of several members, then keeps every one of them rather than reducing to the one
 * the others extend, and the transformer refuses a call that cannot pack for all of them.
 */
export type NetworkPacking<F> =
	IsRawMember<F> extends true ? "raw" : F extends NetworkSerialized<unknown> ? "serialized" : "plain";

export interface NetworkingObfuscationMarker {
	/**
	 * An internal marker type used to signify to Flamework to obfuscate access expressions.
	 * @hidden
	 * @deprecated
	 */
	readonly _flamework_key_obfuscation: "remotes";
}

export type FunctionParameters<T> = T extends (...args: infer P) => unknown ? P : never;
export type FunctionReturn<T> = T extends (...args: never[]) => infer R ? R : never;

export type ObfuscateNames<T> = IntrinsicObfuscateArray<
	(T extends T ? Modding.Target.Obfuscate<T & string, "remotes"> : never)[],
	string[]
>;

/** @hidden Intrinsic feature not intended for users */
export type IntrinsicObfuscate<T> = Modding.Intrinsic<"obfuscate-obj", [T, "remotes"], Record<string, T[keyof T]>>;

/** @hidden Intrinsic feature not intended for users */
export type IntrinsicObfuscateArray<T, V = T> = Modding.Intrinsic<"shuffle-array", [T], V>;

/** @hidden Intrinsic feature not intended for users */
export type IntrinsicTupleGuards<T> = Modding.Intrinsic<"tuple-guards", [T], GuardType>;

/**
 * Decode code for the argument list `T` of the member `F`, generated when the member is packed: with
 * the project's `networking.serialization` on (unless `F` is raw), or when `F` is serialized.
 * `undefined` otherwise, which passes values through as they are. `K` is the member's name, for the
 * transformer's messages. The matching encoding is generated inline at every call site, so no encoder
 * exists at runtime.
 * @hidden Intrinsic feature not intended for users
 */
export type IntrinsicNetworkDecoder<T extends Array<unknown>, F = unknown, K = unknown> = Modding.Intrinsic<
	"network-decoder",
	[T, F, K],
	Serialization.Decoder<T> | undefined
>;

/**
 * Decode code for the result of the function type `F`, carried as a one-element list. Takes the
 * function type rather than its return type so that the return type as declared is known, and so
 * that its markers are; see {@link IntrinsicNetworkDecoder} for `K`.
 * @hidden Intrinsic feature not intended for users
 */
export type IntrinsicNetworkResultDecoder<F, K = unknown> = Modding.Intrinsic<
	"network-result-decoder",
	[F, K],
	Serialization.Decoder | undefined
>;

/**
 * `true` for a member declared unreliable, `undefined` otherwise. An intrinsic rather than a
 * conditional type so that every member of an event network, in both directions, passes through the
 * transformer's check of its markers wherever a handler is created.
 * @hidden Intrinsic feature not intended for users
 */
export type IntrinsicNetworkUnreliable<F, K = unknown> = Modding.Intrinsic<
	"network-unreliable",
	[F, K],
	true | undefined
>;

/** The guards of the arguments before a rest parameter, of the rest, and of any after it (`[A, ...B[], C]`). */
type GuardType = [t.check<unknown>[], t.check<unknown> | undefined, t.check<unknown>[]?];
