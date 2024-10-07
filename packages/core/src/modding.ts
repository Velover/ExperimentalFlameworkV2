import { t } from "@rbxts/t";

export namespace Modding {
	/**
	 * This function is able to utilize Flamework's user macros to generate and inspect types.
	 * This function supports all values natively supported by Flamework's user macros.
	 *
	 * For example, if you want to retrieve the properties of an instance, you could write code like this:
	 * ```ts
	 * // Returns an array of all keys part of the union.
	 * const basePartKeys = Modding.inspect<InstancePropertyNames<BasePart>[]>();
	 * ```
	 *
	 * @metadata macro
	 */
	export function inspect<T>(value?: Modding.Many<T>): T {
		assert(value);
		return value;
	}

	/**
	 * This API allows you to use more complex queries, inspect types, generate arbitrary objects based on types, etc.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Many<T> = T & {
		/** @hidden */ _flamework_macro_many: T;
	};

	/**
	 * Hashes a string literal type (such as an event name) under Flamework's {@link Many `Many`} API.
	 *
	 * The second type argument, `C`, is for providing a context to the hashing which will generate new hashes
	 * for strings which already have a hash under another context.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Hash<T extends string, C extends string = never> = string & {
		/** @hidden */ _flamework_macro_hash: [T, C];
	};

	/**
	 * This is equivalent to {@link Hash `Hash`} except it will only hash strings when `obfuscation` is turned on.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Obfuscate<T extends string, C extends string = never> = string & {
		/** @hidden */ _flamework_macro_hash: [T, C, true];
	};

	/**
	 * Retrieves the labels from this tuple under Flamework's {@link Many `Many`} API.
	 *
	 * This can also be used to extract parameter names via `Parameters<T>`
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type TupleLabels<T extends readonly unknown[]> =
		| (string[] & { /** @hidden */ _flamework_macro_tuple_labels: T })
		| undefined;

	/**
	 * Retrieves metadata about the specified type using Flamework's user macros.
	 */
	export type Generic<T, M extends keyof GenericMetadata<T>> = GenericMetadata<T>[M] & {
		/** @hidden */ _flamework_macro_generic: [T, M];
	};

	/**
	 * Retrieves multiple types of metadata from Flamework's user macros.
	 */
	export type GenericMany<T, M extends keyof GenericMetadata<T>> = Modding.Many<{ [k in M]: Generic<T, k> }>;

	/**
	 * Retrieves metadata about the callsite using Flamework's user macros.
	 */
	export type Caller<M extends keyof CallerMetadata> = CallerMetadata[M] & {
		/** @hidden */ _flamework_macro_caller: M;
	};

	/**
	 * Retrieves multiple types of metadata about the callsite using Flamework's user macros.
	 */
	export type CallerMany<M extends keyof CallerMetadata> = Modding.Many<{ [k in M]: Caller<k> }>;

	/**
	 * Creates an injectable type that can be used to modify dependency injection behavior.
	 */
	export type Injectable<C extends { type: unknown; id?: unknown; metadata?: unknown[] }> = RealType<C["type"]> & {
		/** @hidden @deprecated */
		_flamework_injectable: C;
	};

	/**
	 * An internal type for intrinsic user macro metadata.
	 *
	 * @hidden
	 */
	export type Intrinsic<N extends string, M extends unknown[], T = symbol> = T & { _flamework_intrinsic: [N, ...M] };

	/**
	 * Information about an injected dependency.
	 */
	export interface DependencyInfo {
		/**
		 * The ID used to resolve this dependency.
		 */
		id: string;

		/**
		 * Metadata provided by the injectable type.
		 */
		metadata?: unknown[];
	}

	// This is used so that nested `Modding.Injectable` calls are treated correctly.
	type RealType<T> = T extends { _flamework_injectable: { type: infer R } } ? RealType<R> : T;

	interface CallerMetadata {
		/**
		 * The starting line of the expression.
		 */
		line: number;

		/**
		 * The char at the start of the expression relative to the starting line.
		 */
		character: number;

		/**
		 * The width of the expression.
		 * This includes the width of multiline statements.
		 */
		width: number;

		/**
		 * A unique identifier that can be used to identify exact callsites.
		 * This can be used for hooks.
		 */
		uuid: string;

		/**
		 * The source text for the expression.
		 */
		text: string;
	}

	interface GenericMetadata<T> {
		/**
		 * The ID of the type.
		 */
		id: string;

		/**
		 * A string equivalent of the type.
		 */
		text: string;

		/**
		 * A generated guard for the type.
		 */
		guard: t.check<T>;

		/**
		 * The dependency injection info.
		 */
		dependency: DependencyInfo;

		/**
		 * The dependency injection info, or the ID there is no metadata.
		 */
		dependencyConcise: string | DependencyInfo;
	}
}
