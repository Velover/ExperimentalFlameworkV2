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
	export function inspect<T>(value?: Modding.Emit<T>): T {
		assert(value);
		return value;
	}

	/**
	 * This type emits runtime equivalents of types, such as generating strings from string literal types.
	 *
	 * You are able to generate most TS types, including objects and tuples which will generate equivalent objects at runtime.
	 * Additionally, you can generate unions by using `Array<T>`, which will generate an array where each constituent of `T` is its own element.
	 *
	 * This type is primarily used to mark a user macro parameter as metadata, and is not necessary if you use other macro types.
	 */
	export type Emit<T> = T & {
		/** @hidden */ _flamework_macro_many: T;
	};

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
	 * This namespace contains types and metadata related to the current macro's callsite.
	 */
	export namespace Caller {
		/**
		 * Retrieves metadata about the callsite using Flamework's user macros.
		 */
		type CallerHelper<U, M extends string> = U & {
			/** @hidden */ _flamework_macro_caller: M;
		};

		/**
		 * The starting line of the expression.
		 */
		export type Line = CallerHelper<string, "line">;

		/**
		 * The char at the start of the expression relative to the starting line.
		 */
		export type Character = CallerHelper<string, "character">;

		/**
		 * The width of the expression.
		 * This includes the width of multiline statements.
		 */
		export type Width = CallerHelper<number, "width">;

		/**
		 * A unique identifier that can be used to identify exact callsites.
		 * This can be used for hooks.
		 */
		export type Uuid = CallerHelper<string, "uuid">;

		/**
		 * The source text for the expression.
		 */
		export type Text = CallerHelper<string, "text">;

		/**
		 * This API will generate a constant reference to the nested metadata.
		 * This means that the same object will be passed in for every invocation of a specific function call.
		 *
		 * This can be used to implement caching, and avoid allocation overhead for large metadata.
		 */
		export type Constant<T> = T & {
			/** @hidden */ _flamework_macro_shared_ref: T;
		};
	}

	/**
	 * This namespace contains types that allow you to perform functions or fetch metadata about specific types.
	 */
	export namespace Target {
		type TargetHelper<T, U, M extends string> = U & {
			/** @hidden */ _flamework_macro_generic: [T, M];
		};

		/**
		 * Retrieves the ID from the type.
		 *
		 * The ID is a mostly unique identifier meant to identify specific resources in Flamework projects, such as providers.
		 */
		export type Id<T> = TargetHelper<T, string, "id">;

		/**
		 * Retrieves the text of the type, equivalent to what is seen in TypeScript's intellisense.
		 *
		 * The resulting text may not be identical as the type inputted as its dependent on how TypeScript renders types.
		 */
		export type Text<T> = TargetHelper<T, string, "text">;

		/**
		 * Retrieves a `t` guard that matches this specific type.
		 */
		export type Guard<T> = TargetHelper<T, t.check<T>, "guard">;

		/**
		 * Retrieves the dependency info for this type, which contains the ID and any metadata included on the type.
		 */
		export type Dependency<T> = TargetHelper<T, DependencyInfo, "dependency">;

		/**
		 * Retrieves the dependency info for this type, which contains the ID and any metadata included on the type.
		 *
		 * This is equivalent to the {@link Dependency} type, except it will shorten itself to a string (the type's ID) if possible.
		 */
		export type DependencyConcise<T> = TargetHelper<T, DependencyInfo | string, "dependencyConcise">;

		/**
		 * Retrieves the labels from this tuple.
		 *
		 * This can also be used to extract parameter names via `Parameters<T>`
		 */
		export type Labels<T extends readonly unknown[]> =
			(string[] & { /** @hidden */ _flamework_macro_tuple_labels: T }) | undefined;

		/**
		 * Hashes a string literal type (such as an event name.)
		 *
		 * The second type argument, `C`, is for providing a context to the hashing which will generate new hashes
		 * for strings which already have a hash under another context.
		 */
		export type Hash<T extends string, C extends string = never> = string & {
			/** @hidden */ _flamework_macro_hash: [T, C];
		};

		/**
		 * This is equivalent to {@link Hash `Hash`} except it will only hash strings when `obfuscation` is turned on.
		 */
		export type Obfuscate<T extends string, C extends string = never> = string & {
			/** @hidden */ _flamework_macro_hash: [T, C, true];
		};
	}

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
