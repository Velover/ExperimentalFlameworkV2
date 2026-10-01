import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

/** Every implicit width next to its strict twin, one serializer each: `widthChecks.test.ts` pairs them. */
export const implicitU8 = Flamework.createSerializer<Serialization.Implicit.u8>();
export const strictU8 = Flamework.createSerializer<Serialization.u8>();
export const implicitI8 = Flamework.createSerializer<Serialization.Implicit.i8>();
export const strictI8 = Flamework.createSerializer<Serialization.i8>();
export const implicitU16 = Flamework.createSerializer<Serialization.Implicit.u16>();
export const strictU16 = Flamework.createSerializer<Serialization.u16>();
export const implicitI16 = Flamework.createSerializer<Serialization.Implicit.i16>();
export const strictI16 = Flamework.createSerializer<Serialization.i16>();
export const implicitU32 = Flamework.createSerializer<Serialization.Implicit.u32>();
export const strictU32 = Flamework.createSerializer<Serialization.u32>();
export const implicitI32 = Flamework.createSerializer<Serialization.Implicit.i32>();
export const strictI32 = Flamework.createSerializer<Serialization.i32>();
export const implicitF32 = Flamework.createSerializer<Serialization.Implicit.f32>();
export const strictF32 = Flamework.createSerializer<Serialization.f32>();
export const implicitF64 = Flamework.createSerializer<Serialization.Implicit.f64>();
export const strictF64 = Flamework.createSerializer<Serialization.f64>();
export const implicitVarint = Flamework.createSerializer<Serialization.Implicit.varint>();
export const strictVarint = Flamework.createSerializer<Serialization.varint>();
export const implicitString8 = Flamework.createSerializer<Serialization.Implicit.string8>();
export const strictString8 = Flamework.createSerializer<Serialization.string8>();
export const implicitString16 = Flamework.createSerializer<Serialization.Implicit.string16>();
export const strictString16 = Flamework.createSerializer<Serialization.string16>();
export const implicitString32 = Flamework.createSerializer<Serialization.Implicit.string32>();
export const strictString32 = Flamework.createSerializer<Serialization.string32>();
export const implicitBuffer16 = Flamework.createSerializer<Serialization.Implicit.buffer16>();
export const strictBuffer16 = Flamework.createSerializer<Serialization.buffer16>();
export const implicitBuffer32 = Flamework.createSerializer<Serialization.Implicit.buffer32>();
export const strictBuffer32 = Flamework.createSerializer<Serialization.buffer32>();

/** A brand of the project's own, optional as `Implicit`'s are: it counts as implicit. */
type OwnU16 = number & { readonly unit?: "u16" };
export const ownU16 = Flamework.createSerializer<OwnU16>();

/** A named type whose code is shared: a check's path starts from its name. */
interface Entity {
	id: Serialization.Implicit.u16;
	name: Serialization.Implicit.string8;
	tags: Serialization.Implicit.u8[];
	scores: Map<Serialization.Implicit.i8, Serialization.Implicit.buffer16>;
	pos: { x: Serialization.Implicit.i16 };
	strict: Serialization.u16;
}

export const entitySerializer = Flamework.createSerializer<Entity>();

/** A number that fits no member fails the check of the members with a width. */
type Pick = Serialization.Implicit.u8 | Serialization.Implicit.u16 | string;
export const pickSerializer = Flamework.createSerializer<Pick>();

/** A plain `number` takes whatever the width does not: no check, no fallback. */
export const orNumberSerializer = Flamework.createSerializer<Serialization.Implicit.u16 | number>();

/** A strict width and its implicit twin in one union: one width to the message of the fallback. */
type Twins = Serialization.u16 | Serialization.Implicit.u16 | string;
export const twinsSerializer = Flamework.createSerializer<Twins>();

/** A named union whose width member only takes a number its test found in range: its shared writer checks nothing. */
type OrNumber = Serialization.Implicit.u16 | number;
export const namedOrNumberSerializer = Flamework.createSerializer<OrNumber>();

interface WidthServerEvents {
	move(id: Serialization.Implicit.u16, pos: { x: Serialization.Implicit.i16 }): void;
}

interface WidthClientEvents {
	noop(): void;
}

interface WidthServerFunctions {
	ask(id: Serialization.Implicit.u8): Serialization.Implicit.u16;
}

interface WidthClientFunctions {}

const widthEvents = Networking.createEvent<WidthServerEvents, WidthClientEvents>();
const widthFunctions = Networking.createFunction<WidthServerFunctions, WidthClientFunctions>();
export const widthClient = widthEvents.createClient({});
export const widthServerFunctions = widthFunctions.createServer({});
export const widthClientFunctions = widthFunctions.createClient({});

export function sendMove(id: number, x: number) {
	widthClient.move.fire(id, { x });
}

export function sendLiterals() {
	widthClient.move.fire(3, { x: -1 });
	widthClient.move.fire(70000, { x: 0 });
}

export function askFor(id: number) {
	return widthClientFunctions.ask.invoke(id);
}

widthServerFunctions.ask.setCallback((_player, id) => id * 300);
