/**
 * Types for Flamework's static serialization. There is no runtime here: the transformer generates
 * the encode and decode code for each type at the call site, straight `buffer` reads and writes with
 * nothing describing the type left in the output.
 */
export namespace Serialization {
	/** What `Flamework.createSerializer<T>()` returns. */
	export interface Serializer<T> {
		/**
		 * Encodes `value`. The second result is the blob list: values with no buffer representation
		 * (Instances, `unknown`, most Roblox datatypes), referenced from the buffer by index. It is
		 * `undefined` when the type has no such values, and a table (possibly empty) when it has.
		 */
		serialize: (value: T) => LuaTuple<[buffer, Array<defined> | undefined]>;

		/**
		 * Decodes a payload produced by {@link serialize}. Raises on malformed input, so wrap it in
		 * `pcall` for data from an untrusted peer; the networking package does.
		 */
		deserialize: (payload: buffer, blobs?: Array<defined>) => T;
	}

	/** Encode and decode for a list of values, which is how networking packs an argument list. */
	export interface Codec<T extends Array<unknown> = Array<unknown>> {
		encode: (values: T) => LuaTuple<[buffer, Array<defined> | undefined]>;
		decode: (payload: buffer, blobs: Array<defined>) => T;
	}

	// --- brands ------------------------------------------------------------------------------------
	// A `number & { __brand: "u8" }` (any property name, this literal) is written as one unsigned byte,
	// and so on. Plain `number` is an f64, plain `string` has a four-byte length prefix.

	export type u8 = number & { readonly __brand: "u8" };
	export type i8 = number & { readonly __brand: "i8" };
	export type u16 = number & { readonly __brand: "u16" };
	export type i16 = number & { readonly __brand: "i16" };
	export type u32 = number & { readonly __brand: "u32" };
	export type i32 = number & { readonly __brand: "i32" };
	export type f32 = number & { readonly __brand: "f32" };
	export type f64 = number & { readonly __brand: "f64" };
	/** A string of at most 255 bytes: one length byte. */
	export type string8 = string & { readonly __brand: "u8_string" };
	/** A string of at most 65535 bytes: two length bytes. */
	export type string16 = string & { readonly __brand: "u16_string" };
	export type string32 = string & { readonly __brand: "u32_string" };
	/** A buffer of at most 65535 bytes: two length bytes. */
	export type buffer16 = buffer & { readonly __brand: "u16_buffer" };
	export type buffer32 = buffer & { readonly __brand: "u32_buffer" };
}
