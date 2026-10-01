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

	/**
	 * Decodes a packed argument list, which is how networking unpacks what a remote delivered. One is
	 * generated per event and function; the matching encoding is generated inline at every call
	 * site, so no encoder exists as a value at runtime.
	 */
	export type Decoder<T extends Array<unknown> = Array<unknown>> = (payload: buffer, blobs: Array<defined>) => T;

	// --- brands ------------------------------------------------------------------------------------
	// A `number & { __brand: "u8" }` (any property name, this literal) is written as one unsigned byte,
	// and so on. Plain `number` is an f64; plain `string` and `buffer` get a varint length prefix (one
	// byte below 128, two below 16384, up to five).
	//
	// Each strict width also carries its implicit twin's optional property (`_flamework_u8?`), naming
	// the same width. That makes it a subtype of the twin, so a strict value and an implicit one
	// together are inferred as the twin, as a plain `number` and an `Implicit.u8` are inferred as
	// `number`. The required `__brand` is what keeps plain and implicit values out.

	/** An unsigned byte, 0 to 255. */
	export type u8 = number & { readonly __brand: "u8"; readonly _flamework_u8?: "u8" };
	/** A signed byte, -128 to 127. */
	export type i8 = number & { readonly __brand: "i8"; readonly _flamework_i8?: "i8" };
	/** An unsigned 16-bit integer, 0 to 65535. */
	export type u16 = number & { readonly __brand: "u16"; readonly _flamework_u16?: "u16" };
	/** A signed 16-bit integer, -32768 to 32767. */
	export type i16 = number & { readonly __brand: "i16"; readonly _flamework_i16?: "i16" };
	/** An unsigned 32-bit integer. */
	export type u32 = number & { readonly __brand: "u32"; readonly _flamework_u32?: "u32" };
	/** A signed 32-bit integer. */
	export type i32 = number & { readonly __brand: "i32"; readonly _flamework_i32?: "i32" };
	/** A single-precision float: four bytes, about seven significant digits. */
	export type f32 = number & { readonly __brand: "f32"; readonly _flamework_f32?: "f32" };
	/** A double-precision float, which is what a plain `number` is written as. */
	export type f64 = number & { readonly __brand: "f64"; readonly _flamework_f64?: "f64" };
	/**
	 * A non-negative integer written as a LEB128 varint: one byte below 128, two below 16384, up to
	 * five bytes. The right choice for counts, ids and other small-most-of-the-time integers.
	 */
	export type varint = number & { readonly __brand: "varint"; readonly _flamework_varint?: "varint" };
	/** A string of at most 255 bytes: a fixed one-byte length. */
	export type string8 = string & { readonly __brand: "u8_string"; readonly _flamework_string8?: "u8_string" };
	/** A string of at most 65535 bytes: a fixed two-byte length. */
	export type string16 = string & { readonly __brand: "u16_string"; readonly _flamework_string16?: "u16_string" };
	/** A string with a fixed four-byte length. */
	export type string32 = string & { readonly __brand: "u32_string"; readonly _flamework_string32?: "u32_string" };
	/** A buffer of at most 65535 bytes: a fixed two-byte length. */
	export type buffer16 = buffer & { readonly __brand: "u16_buffer"; readonly _flamework_buffer16?: "u16_buffer" };
	/** A buffer with a fixed four-byte length. */
	export type buffer32 = buffer & { readonly __brand: "u32_buffer"; readonly _flamework_buffer32?: "u32_buffer" };

	/**
	 * The same widths, for plain values: `const id: Serialization.Implicit.u16 = 7` needs no cast. An
	 * implicit width is written exactly as its strict twin, and its value is checked where it is
	 * written, which a cast never is: `serialization.checks` in `flamework.config.json` decides what a
	 * value that does not fit does (by default it raises, naming the width, the value and where it
	 * is).
	 *
	 * Implicit widths behave like plain numbers, strings and buffers: they mix with each other and
	 * take any strict width of their kind: an `Implicit.u8` goes into an `Implicit.u16` and back, and
	 * a strict `u32` goes into either. A value is checked against the width it is written as. Like a plain
	 * `number`, an implicit width does not go into a strict one without a cast.
	 *
	 * Each width's brand is an optional property of its own (`number & { readonly _flamework_u16?: "u16" }`):
	 * optional is what lets a plain value in, and a property per width is what lets the widths mix.
	 * A type of your own with an optional brand counts as implicit too. Types that share one optional
	 * property (`__brand?: "u8"` and `__brand?: "u16"`) do not mix with each other; give each width a
	 * property of its own, as these do, to make them mix. A type that names two different widths,
	 * such as `Serialization.u16 & Serialization.Implicit.u8`, cannot be serialized.
	 */
	export namespace Implicit {
		/** An unsigned byte, 0 to 255, checked where it is written. */
		export type u8 = number & { readonly _flamework_u8?: "u8" };
		/** A signed byte, -128 to 127, checked where it is written. */
		export type i8 = number & { readonly _flamework_i8?: "i8" };
		/** An unsigned 16-bit integer, 0 to 65535, checked where it is written. */
		export type u16 = number & { readonly _flamework_u16?: "u16" };
		/** A signed 16-bit integer, -32768 to 32767, checked where it is written. */
		export type i16 = number & { readonly _flamework_i16?: "i16" };
		/** An unsigned 32-bit integer, checked where it is written. */
		export type u32 = number & { readonly _flamework_u32?: "u32" };
		/** A signed 32-bit integer, checked where it is written. */
		export type i32 = number & { readonly _flamework_i32?: "i32" };
		/** A single-precision float; a finite value past its range is refused where it is written. */
		export type f32 = number & { readonly _flamework_f32?: "f32" };
		/** A double-precision float, which holds every number: nothing to check. */
		export type f64 = number & { readonly _flamework_f64?: "f64" };
		/** A LEB128 varint, a whole number from 0 to 2^35 - 1, checked where it is written. */
		export type varint = number & { readonly _flamework_varint?: "varint" };
		/** A string of at most 255 bytes, checked where it is written. */
		export type string8 = string & { readonly _flamework_string8?: "u8_string" };
		/** A string of at most 65535 bytes, checked where it is written. */
		export type string16 = string & { readonly _flamework_string16?: "u16_string" };
		/** A string with a fixed four-byte length: nothing to check. */
		export type string32 = string & { readonly _flamework_string32?: "u32_string" };
		/** A buffer of at most 65535 bytes, checked where it is written. */
		export type buffer16 = buffer & { readonly _flamework_buffer16?: "u16_buffer" };
		/** A buffer with a fixed four-byte length: nothing to check. */
		export type buffer32 = buffer & { readonly _flamework_buffer32?: "u32_buffer" };
	}
}
