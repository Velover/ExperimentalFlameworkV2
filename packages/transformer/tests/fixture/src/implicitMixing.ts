import type { Serialization } from "@flamework-experimental/core";

/*
 * What goes into what among the widths, checked by the fixture's own build: an `Expect` or a
 * `Refused` that does not hold is a type error, and the fixture does not compile. (roblox-ts does
 * not allow `@ts-expect-error`, so a refusal is asserted through a type as well.)
 *
 * `Serialization.Implicit` widths behave like plain numbers, strings and buffers: they mix with each
 * other, take any strict width of their kind, and go into a strict width only through a cast.
 * Types only: the module emits no code.
 */

/**
 * `true` when every member of `From` goes into every member of `To`, `false` when none does, and
 * `boolean` when some do.
 */
type Into<To, From> = To extends unknown
	? From extends unknown
		? [From] extends [To]
			? true
			: false
		: never
	: never;

/** Every one goes in. */
type Expect<T extends true> = T;
/** None goes in. */
type Refused<T extends false> = T;

type ImplicitNumber =
	| Serialization.Implicit.u8
	| Serialization.Implicit.i8
	| Serialization.Implicit.u16
	| Serialization.Implicit.i16
	| Serialization.Implicit.u32
	| Serialization.Implicit.i32
	| Serialization.Implicit.f32
	| Serialization.Implicit.f64
	| Serialization.Implicit.varint;

type StrictNumber =
	| Serialization.u8
	| Serialization.i8
	| Serialization.u16
	| Serialization.i16
	| Serialization.u32
	| Serialization.i32
	| Serialization.f32
	| Serialization.f64
	| Serialization.varint;

type ImplicitString =
	Serialization.Implicit.string8 | Serialization.Implicit.string16 | Serialization.Implicit.string32;
type StrictString = Serialization.string8 | Serialization.string16 | Serialization.string32;
type ImplicitBuffer = Serialization.Implicit.buffer16 | Serialization.Implicit.buffer32;
type StrictBuffer = Serialization.buffer16 | Serialization.buffer32;

/**
 * `same(a, b)`: one type for two values. TypeScript infers whichever of them the other is a subtype
 * of, and assigning this to `(a: A, b: B) => void` infers `T` the same way; `[a, b]` and
 * `flag ? a : b` likewise drop a member that is a subtype of the other.
 */
type Same = <T>(a: T, b: T) => void;

/** Each strict width and its implicit twin. */
interface Twins {
	u8: [Serialization.u8, Serialization.Implicit.u8];
	i8: [Serialization.i8, Serialization.Implicit.i8];
	u16: [Serialization.u16, Serialization.Implicit.u16];
	i16: [Serialization.i16, Serialization.Implicit.i16];
	u32: [Serialization.u32, Serialization.Implicit.u32];
	i32: [Serialization.i32, Serialization.Implicit.i32];
	f32: [Serialization.f32, Serialization.Implicit.f32];
	f64: [Serialization.f64, Serialization.Implicit.f64];
	varint: [Serialization.varint, Serialization.Implicit.varint];
	string8: [Serialization.string8, Serialization.Implicit.string8];
	string16: [Serialization.string16, Serialization.Implicit.string16];
	string32: [Serialization.string32, Serialization.Implicit.string32];
	buffer16: [Serialization.buffer16, Serialization.Implicit.buffer16];
	buffer32: [Serialization.buffer32, Serialization.Implicit.buffer32];
}

/** `true` when `same(strict, implicit)` compiles for every width, in that order and the other. */
type InferredTogether = {
	[K in keyof Twins]:
		Into<(a: Twins[K][0], b: Twins[K][1]) => void, Same> | Into<(a: Twins[K][1], b: Twins[K][0]) => void, Same>;
}[keyof Twins];

/** Brands of the project's own on the property the strict widths use: implicit, but one property for every width. */
type SharedU8 = number & { readonly __brand?: "u8" };
type SharedU16 = number & { readonly __brand?: "u16" };
/** The same with a property per width, as `Serialization.Implicit` has. */
type OwnU8 = number & { readonly ownU8?: "u8" };
type OwnU16 = number & { readonly ownU16?: "u16" };

export type Mixing = [
	// Each implicit width takes every other one, any strict width of its kind, a plain value and a literal.
	Expect<Into<ImplicitNumber, ImplicitNumber | StrictNumber | number>>,
	Expect<Into<ImplicitNumber, 300>>,
	Expect<Into<ImplicitString, ImplicitString | StrictString | string>>,
	Expect<Into<ImplicitString, "text">>,
	Expect<Into<ImplicitBuffer, ImplicitBuffer | StrictBuffer | buffer>>,

	// And goes into a plain value.
	Expect<Into<number, ImplicitNumber>>,
	Expect<Into<string, ImplicitString>>,
	Expect<Into<buffer, ImplicitBuffer>>,

	// No implicit width goes into a strict one, even its twin, just as no plain value does.
	Refused<Into<StrictNumber, ImplicitNumber | number>>,
	Refused<Into<StrictString, ImplicitString | string>>,
	Refused<Into<StrictBuffer, ImplicitBuffer | buffer>>,
	Refused<Into<Serialization.u16, Serialization.Implicit.u16>>,

	// Kinds never mix.
	Refused<Into<ImplicitNumber, ImplicitString | StrictString | string | ImplicitBuffer | StrictBuffer | buffer>>,
	Refused<Into<ImplicitString, ImplicitNumber | StrictNumber | number | ImplicitBuffer | StrictBuffer | buffer>>,
	Refused<Into<ImplicitBuffer, ImplicitNumber | StrictNumber | number | ImplicitString | StrictString | string>>,

	// A strict width is a subtype of its implicit twin, as an implicit width is of `number`: a strict
	// value and an implicit one together are inferred as the twin, so `same(strictU8, implicitU8)`
	// compiles and `[strictU8, implicitU8]` is an `Implicit.u8[]`.
	Expect<InferredTogether>,

	// Strict widths are as they were: each goes into itself and its implicit twin, and into no other strict width.
	Expect<Into<Serialization.u16, Serialization.u16>>,
	Refused<Into<Serialization.u16, Exclude<StrictNumber, Serialization.u16>>>,
	Refused<Into<Serialization.string8, Serialization.string16 | Serialization.string32>>,
	Refused<Into<Serialization.buffer16, Serialization.buffer32>>,

	// A brand of the project's own mixes with the implicit widths both ways.
	Expect<Into<ImplicitNumber, SharedU8 | OwnU8>>,
	Expect<Into<SharedU8 | OwnU8, ImplicitNumber>>,
	// Brands sharing one property do not mix with each other, nor take a strict width other than
	// their own, which uses that property too; with a property per width they mix.
	Refused<Into<SharedU16, SharedU8>>,
	Refused<Into<SharedU8, Serialization.u16>>,
	Expect<Into<SharedU8, Serialization.u8>>,
	Expect<Into<OwnU16, OwnU8 | Serialization.u8>>,
];
