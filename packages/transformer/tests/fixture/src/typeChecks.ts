import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

/**
 * One serializer per kind the writer handles, and call sites of every kind, for `typeChecks.test.ts`,
 * which builds the fixture again with `serialization.checks.types` on. The default build has the type
 * checks off, so this file compiles as it would without them.
 */
export const tcNumber = Flamework.createSerializer<number>();
export const tcU16 = Flamework.createSerializer<Serialization.u16>();
export const tcF32 = Flamework.createSerializer<Serialization.f32>();
export const tcVarint = Flamework.createSerializer<Serialization.varint>();
export const tcString = Flamework.createSerializer<string>();
export const tcString8 = Flamework.createSerializer<Serialization.string8>();
export const tcBoolean = Flamework.createSerializer<boolean>();
export const tcBuffer = Flamework.createSerializer<buffer>();
export const tcLiterals = Flamework.createSerializer<"a" | "b" | "c">();
export const tcConstant = Flamework.createSerializer<{
	kind: "circle";
	r: number;
}>();
export const tcEnum = Flamework.createSerializer<Enum.Material>();
export const tcVector3 = Flamework.createSerializer<Vector3>();
export const tcCFrame = Flamework.createSerializer<CFrame>();
export const tcInstance = Flamework.createSerializer<Part>();
export const tcUnknown = Flamework.createSerializer<unknown>();
/** The engine names a Font with `typeof`; a GroupInfo is a plain table no name can test. */
export const tcFont = Flamework.createSerializer<Font>();
export const tcGroupInfo = Flamework.createSerializer<GroupInfo>();
/** Enum items as literal types: one alone, a union of them, and a union of them with a number. */
export const tcEnumItem = Flamework.createSerializer<Enum.Material.Plastic>();
export const tcEnumItems = Flamework.createSerializer<Enum.Material.Plastic | Enum.Material.Wood>();
export const tcEnumItemsOrNumber = Flamework.createSerializer<Enum.Material.Plastic | Enum.Material.Wood | number>();
export const tcArray = Flamework.createSerializer<number[]>();
export const tcStrings = Flamework.createSerializer<string[]>();
export const tcSet = Flamework.createSerializer<Set<string>>();
export const tcMap = Flamework.createSerializer<Map<string, number>>();
export const tcOptional = Flamework.createSerializer<number | undefined>();
export const tcUnion = Flamework.createSerializer<number | string>();
export const tcTuple = Flamework.createSerializer<[number, string]>();
export const tcFixedTuple = Flamework.createSerializer<[number, boolean]>();
export const tcObject = Flamework.createSerializer<{ x: number; y: number }>();

/** Every member a table of the same size, told apart by `kind`: a union of a fixed size. */
type Fixed = { kind: "a"; v: number } | { kind: "b"; w: number };
export const tcFixedUnion = Flamework.createSerializer<Fixed>();

/** Every member a table, told apart by a key only one of them has. */
type Purse = { Coins: number } | { Items: string[] };
export const tcKeyed = Flamework.createSerializer<Purse>();

interface TcOwner {
	label: string;
}

/** A named type whose size varies: shared code, whose `s_` and `w_` take where the value is. */
interface TcEntity {
	id: number;
	name: string;
	flag: boolean;
	owner: TcOwner;
}

export const tcEntity = Flamework.createSerializer<TcEntity>();

interface TypeServerEvents {
	tcMove(id: number, entity: TcEntity, flag: boolean): void;
	tcMany(label: string, ...values: number[]): void;
}

interface TypeServerFunctions {
	tcAsk(id: number): { x: number; y: number };
}

export const typeClient = Networking.createEvent<TypeServerEvents, {}>().createClient({});
const typeFunctions = Networking.createFunction<TypeServerFunctions, {}>();
export const typeServerFunctions = typeFunctions.createServer({});
export const typeClientFunctions = typeFunctions.createClient({});

export function tcSendMove(id: number, entity: TcEntity, flag: boolean) {
	typeClient.tcMove.fire(id, entity, flag);
}

/** Literals are judged when building: a number and a boolean need no test. */
export function tcSendLiterals(entity: TcEntity) {
	typeClient.tcMove.fire(3, entity, true);
}

export function tcSendMany(label: string, a: number, b: number) {
	typeClient.tcMany.fire(label, a, b);
}

export function tcSendSpread(label: string, values: number[]) {
	typeClient.tcMany.fire(label, ...values);
}

export function tcAskFor(id: number) {
	return typeClientFunctions.tcAsk.invoke(id);
}

typeServerFunctions.tcAsk.setCallback((_player, id) => ({ x: id, y: id }));
