import { Flamework, Serialization } from "@flamework-experimental/core";
import * as typeCodecs from "../typeChecks/codecs";

/*
 * The encodings the width-check specs run under every `serialization.checks` configuration. This
 * file is compiled with the specs, under their own config (the defaults: implicit widths checked,
 * raising, in both realms), and again by each project in packages/specs/variants, with a config of
 * its own; the Lune harness hands a variant's build out through `__harness.checkVariant(name)`.
 * Nothing here may depend on which build it is: the specs tell them apart.
 */

/** The type-check specs' encodings, built along with these, as the harness reaches only this file. */
export const types = typeCodecs;

export interface Tagged {
	readonly id: Serialization.Implicit.u16;
	readonly label: Serialization.Implicit.string8;
}

export const u16 = Flamework.createSerializer<Serialization.Implicit.u16>();
export const strictU16 = Flamework.createSerializer<Serialization.u16>();
export const i8 = Flamework.createSerializer<Serialization.Implicit.i8>();
export const f32 = Flamework.createSerializer<Serialization.Implicit.f32>();
export const varint = Flamework.createSerializer<Serialization.Implicit.varint>();
export const string8 = Flamework.createSerializer<Serialization.Implicit.string8>();
export const strictString8 = Flamework.createSerializer<Serialization.string8>();
export const buffer16 = Flamework.createSerializer<Serialization.Implicit.buffer16>();
export const tagged = Flamework.createSerializer<Tagged>();
export const either = Flamework.createSerializer<Serialization.Implicit.u16 | string>();
export const orNumber = Flamework.createSerializer<Serialization.Implicit.u16 | number>();

/** Arrays with a hole: refused where the element type takes no nil, whatever the checks say, and written where it does. */
export const holes = Flamework.createSerializer<defined[]>();
export const optionalHoles = Flamework.createSerializer<Array<Serialization.Implicit.u16 | undefined>>();

/**
 * Made inside catch blocks whose variables hide `math` and `error`, which the code made there calls: a
 * strict f32's check (`math.abs`, under category `all`) and an array's refusal of a hole (`error`).
 */
export function f32InCatch(value: number): buffer {
	try {
		throw "caught";
	} catch (math) {
		return Flamework.createSerializer<Serialization.f32>().serialize(value as Serialization.f32)[0];
	}
}

export function holesInCatch(values: boolean[]): buffer {
	try {
		throw "caught";
	} catch (error) {
		return Flamework.createSerializer<boolean[]>().serialize(values)[0];
	}
}
