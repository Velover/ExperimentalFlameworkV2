import { Modding, Serialization } from "@flamework/core";
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
 * Decode code for the argument list `T`, generated only when the project's flamework.config.json
 * enables `networking.serialization`; `undefined` otherwise, which passes values through as they
 * are. The matching encoding is generated inline at every call site, so no encoder exists at runtime.
 * @hidden Intrinsic feature not intended for users
 */
export type IntrinsicNetworkDecoder<T extends Array<unknown>> = Modding.Intrinsic<
	"network-decoder",
	[T],
	Serialization.Decoder<T> | undefined
>;

/**
 * Decode code for the result of the function type `F`, carried as a one-element list. Takes the
 * function type rather than its return type so that the return type as declared is known.
 * @hidden Intrinsic feature not intended for users
 */
export type IntrinsicNetworkResultDecoder<F> = Modding.Intrinsic<
	"network-result-decoder",
	[F],
	Serialization.Decoder | undefined
>;

type GuardType = [t.check<unknown>[], t.check<unknown> | undefined];
