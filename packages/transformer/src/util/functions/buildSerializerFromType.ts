import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { Logger } from "../../classes/logger";
import { TransformState } from "../../classes/transformState";
import { f } from "../factory";
import {
	buildGuardFromType,
	EnumMemberOrigin,
	enumMemberOf,
	enumMemberOrigins,
	extractTypes,
	getLiteral,
	isConditionalType,
	isInstanceType,
	simplifyUnion,
} from "./buildGuardFromType";
import { localName } from "./identifierName";
import { getPropertyKey, keyAccess, keyName, keySegment, TableKey } from "./propertyKey";
import { isArrayType, isTupleType } from "./isTupleType";

/**
 * Generates serialization code from types.
 *
 * Nothing about a type survives into the output. A value is written straight into a `buffer` with
 * `buffer.write*` calls, at offsets folded at compile time wherever the layout is fixed, and read
 * back the same way; a fixed-size payload is `buffer.create(<constant>)` followed by writes at
 * literal offsets. Values with no buffer representation (Instances, `unknown`, most Roblox datatypes)
 * go into a blob list, and the buffer holds each one's 1-based index in that list (0 for nil), so a
 * missing or invalid value never shifts the others.
 *
 * Wire format, in bytes:
 * - numbers: 8 (f64) unless branded (`u8` .. `f64`, or `varint` for a LEB128 unsigned integer); booleans 1
 * - strings and buffers: varint length + bytes (a fixed 1 / 2 / 4 with the `u8_string` .. `u32_buffer` brands)
 * - literal unions: a 1-byte index (2 past 255 members) into the values in canonical order (see
 *   `sortLiterals`: `false`, `true`, `""`, `0` and the names `typeof` returns first, then sorted, a
 *   TypeScript enum's in declaration order, Roblox enum items last); a single literal costs nothing
 * - optionals: 1 presence byte, then the value when present
 * - arrays, sets, maps and tuple rest elements: varint count + elements. A tuple is the elements
 *   before its rest, the rest, then the elements after it (`[A, ...B[], C]`)
 * - unions: u8 member index + the member, members numbered in the order they were written, so
 *   `number | string` is 0 for the number and 1 for the string; past 255 members the union is a
 *   blob. A plain `number` member gives the whole numbers from 0 to 2^35 - 1 a tag of their own,
 *   one past the written members, and writes them as a varint: `number | string` sends 3 as tag 2
 *   and one byte. A member written as another union (`type Id = number | string` in `Id | Alpha`)
 *   numbers its built-in types first, in the order TypeScript creates them (`string`, `number`, then
 *   `boolean`), then `""`, `0` and the names `typeof` returns (`"string"`, `"number"`, ...), then the
 *   rest as written. Members no spelling orders go after the others: `boolean` first, then the
 *   built-in types (`string`, `number`), in the order TypeScript creates them, then the rest by how
 *   deeply they nest type arguments (`Item` before `Item[]` and `Box<Item>`, and `Zed` before
 *   `Alpha[]` too), then by a key of their type, a name for a named one (see `orderAlternatives`).
 *   Which member a value is written as is decided by `evaluation`, not by the written order alone.
 *   Objects: fields in TypeScript's order -- declaration order, a homomorphic
 *   mapped type's (`Partial<T>`) as `T`'s -- except a mapped type over a union of keys (`Record`,
 *   `Pick`), whose fields go by their keys, sorted (see `fieldOrder`); nothing spent on names
 * - Vector3 12, Vector2 8, Vector3int16 6, Vector2int16 4, Color3 12, UDim 8, UDim2 16, NumberRange 8,
 *   Rect 16, BrickColor 2, CFrame 48 (its twelve components), EnumItems 2 (their `Value`), blobs 4
 *
 * Every order on the wire is a function of the types alone, never of TypeScript's internal type ids,
 * which follow what the checker happened to create first in a compilation: a watcher's rebuild
 * compiles a sender without its receiver, and a buffer `createSerializer` wrote can be stored.
 *
 * A varint is 1 byte below 128, 2 below 16384, and so on up to 5; the three helpers that handle it
 * are hoisted once per file. A named object, union or tuple with a variable size, and any other
 * variable-size structured type a file reaches more than once (see `hoist`), gets `s_` (size), `w_`
 * (write) and `r_` (read) functions, kept in one table per file ahead of the statement that first
 * needs them; that is also how recursive types work. Fixed-size types are always inlined.
 *
 * What goes in the blob list: everything declared by roblox-ts's Roblox types (Instances, EnumItem,
 * Font, RBXScriptSignal, ...) unless it has a layout above, anything with a `_nominal_` marker,
 * `unknown`, `any`, `object`, `defined`, empty object types and class instances. Only what a remote
 * cannot carry at all is a compile error: functions, Promises outside a function result, symbols,
 * bigint, `never`, template literals and `LuaTuple` (several values at runtime, not a table).
 *
 * Width checks (`serialization.checks`): a brand whose property is optional (`Serialization.Implicit.*`)
 * is written exactly as the required one, and its values are checked where they are written: an
 * integer width takes whole numbers in its range, a varint whole numbers below 2^35, an f32 any
 * number but a finite one past its range, a string8, string16 or buffer16 no more bytes than its
 * length prefix holds. A value that fails calls one helper per file (`checkWidth`), which raises or
 * warns with the width, the value and where it is (`Entity.id`, `'move' [2].pos`), and which also
 * decides the realm, so that a shared module checks only where `side` says. With `category: "all"`
 * the required brands are checked too, and with `"none"` nothing is generated.
 *
 * Type checks (`serialization.checks.types`, off by default): each value is tested to be of its kind
 * before anything reads it (`type(v) == "number"`, `typeof(v) == "Vector3"`, a table for an object or
 * a collection, a literal's or an enum's members), in the pass that reaches it first: the size pass
 * for a value whose size varies, which it reads to measure, the writes for the others. A value that
 * fails calls the file's `checkType`, which raises with what was expected, what came and where
 * (`[Flamework] number expected, got string, at 'move' [0].pos.x`), in either `mode`, but for a
 * boolean, which `warn` lets through to be written as whether it is truthy; `side` decides the realm
 * as it does for the widths. A union member is written only once its test found its kind, so only the
 * values inside it are tested again. Off, nothing is generated.
 */

type Width = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";
/** A length prefix: a varint (`v`) by default, or the fixed width a brand asks for. */
type LengthWidth = "v" | "u8" | "u16" | "u32";
type FixedLengthWidth = Exclude<LengthWidth, "v">;

const WIDTH_SIZE: Record<Width, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 };
const LENGTH_MAX: Record<FixedLengthWidth, number> = { u8: 0xff, u16: 0xffff, u32: 0xffffffff };
const lengthMin = (width: LengthWidth) => (width === "v" ? 1 : WIDTH_SIZE[width]);

/** `number & { <anything>: "<brand>" }` selects a width; the property name does not matter. */
const NUMBER_BRANDS = new Set<string>(Object.keys(WIDTH_SIZE));
const VARINT_BRAND = "varint";
const STRING_BRANDS: Record<string, LengthWidth> = { u8_string: "u8", u16_string: "u16", u32_string: "u32" };
const BUFFER_BRANDS: Record<string, LengthWidth> = { u16_buffer: "u16", u32_buffer: "u32" };
const isNumberBrand = (literal: string) => NUMBER_BRANDS.has(literal) || literal === VARINT_BRAND;
const isStringBrand = (literal: string) => Object.prototype.hasOwnProperty.call(STRING_BRANDS, literal);
const isBufferBrand = (literal: string) => Object.prototype.hasOwnProperty.call(BUFFER_BRANDS, literal);

/** A brand's width literal, and whether every property that names it is optional (`implicit`). */
interface Brand {
	brand: string;
	implicit: boolean;
}

/** A blob's 1-based index in the blob list, 0 for nil. */
const BLOB_SIZE = 4;
const VARINT_MAX_BYTES = 5;
/** What a varint of `VARINT_MAX_BYTES` holds: the whole numbers below 2^35. */
const VARINT_LIMIT = 128 ** VARINT_MAX_BYTES;
/**
 * Counts of zero-size elements cannot be bounded by the bytes left, so a payload gets a plain cap on
 * how many of them it may hold in all. Per payload rather than per collection: a cap per collection
 * multiplies through nesting, and `Array<Array<Marker>>` let a 151-byte payload drive 50 × 65535
 * element tables.
 */
const ZERO_SIZE_COUNT_MAX = 0xffff;

/** Where roblox-ts declares the Roblox API: everything in there without a layout travels as a blob. */
const ROBLOX_TYPES = /[\\/]@rbxts[\\/]types[\\/]/;

/**
 * TypeScript's built-in types by `intrinsicName`, in the order its checker creates them when it
 * starts, ahead of every other type (`createTypeChecker`, from `anyType` to `nonPrimitiveType`, the
 * same in TypeScript 5.5.3 and 5.9.3): the order their type ids gave them, which 2.0.0-alpha.7
 * numbered a union's members by. Written out, never read off the ids, so that it is the same
 * whatever TypeScript version is loaded. Few of them reach a union's members (`string`, `number`,
 * `object`, `null`): `any` and `unknown` absorb a union, `undefined` and `void` make it optional,
 * `never` drops out, `boolean` is a group of its own (but for the parts of a written member, where it
 * goes at `false`'s place: see `memberRank`), and `true` and `false` go with the literal values
 * (`sortLiterals`). Later in its start, after some types of its own (`{}`, `` `${number}` ``, ...),
 * the checker creates `""` and `0` (`emptyStringType` and `zeroType`), then the names `typeof` returns
 * ({@link TYPEOF_NAMES}), ahead of every literal a program writes; `valueRank` puts them after `true`.
 */
const INTRINSIC_ORDER = [
	"any",
	"error",
	"unresolved",
	"intrinsic",
	"unknown",
	"undefined",
	"null",
	"string",
	"number",
	"bigint",
	"false",
	"true",
	"symbol",
	"void",
	"never",
	"object",
];

/**
 * The names `typeof` returns, in the order the checker creates their string literal types when it
 * starts (`createTypeofType`, in `typeofNEFacts`' key order), right after `""`, `0` and `0n` and
 * ahead of every literal a program writes, the same in TypeScript 5.5.3 and 5.9.3. So 2.0.0-alpha.7's
 * type ids put `"string"` ahead of `"number"`, and both ahead of `1` and `"npc"`, in every build
 * (`valueRank`, `startupRank`).
 */
const TYPEOF_NAMES = ["string", "number", "bigint", "boolean", "symbol", "undefined", "object", "function"];

/** Roblox datatypes with a buffer representation: the fields written, in constructor order. */
const DATATYPES: Record<string, Array<[Width, string[]]>> = {
	Vector3: [
		["f32", ["X"]],
		["f32", ["Y"]],
		["f32", ["Z"]],
	],
	Vector2: [
		["f32", ["X"]],
		["f32", ["Y"]],
	],
	Vector3int16: [
		["i16", ["X"]],
		["i16", ["Y"]],
		["i16", ["Z"]],
	],
	Vector2int16: [
		["i16", ["X"]],
		["i16", ["Y"]],
	],
	Color3: [
		["f32", ["R"]],
		["f32", ["G"]],
		["f32", ["B"]],
	],
	UDim: [
		["f32", ["Scale"]],
		["i32", ["Offset"]],
	],
	UDim2: [
		["f32", ["X", "Scale"]],
		["i32", ["X", "Offset"]],
		["f32", ["Y", "Scale"]],
		["i32", ["Y", "Offset"]],
	],
	NumberRange: [
		["f32", ["Min"]],
		["f32", ["Max"]],
	],
	Rect: [
		["f32", ["Min", "X"]],
		["f32", ["Min", "Y"]],
		["f32", ["Max", "X"]],
		["f32", ["Max", "Y"]],
	],
	BrickColor: [["u16", ["Number"]]],
};

const CFRAME_COMPONENTS = 12;

const MALFORMED = "malformed payload";

/**
 * What the generator knows about a type. Children are kept as types so that named ones can be
 * hoisted; the synthetic kinds (literal groups, optionals, a union ordered by its spelling) only
 * appear where a type cannot stand.
 */
type Kind =
	/** `implicit`: the width came from an optional brand, whose values are checked (see `checkedWidth`). */
	| { kind: "number"; width: Width; implicit?: boolean }
	| { kind: "varint"; implicit?: boolean }
	| { kind: "boolean" }
	| { kind: "string"; length: LengthWidth; implicit?: boolean }
	| { kind: "buffer"; length: LengthWidth; implicit?: boolean }
	| { kind: "constant"; value: ts.Expression }
	| { kind: "literals"; values: ts.Expression[] }
	| { kind: "nothing" }
	| { kind: "blob"; typeofName?: string }
	| { kind: "datatype"; name: string }
	| { kind: "cframe" }
	| { kind: "enum"; name: string }
	| { kind: "optional"; inner: Shape }
	| { kind: "array"; element: Shape }
	| { kind: "set"; element: Shape }
	| { kind: "map"; key: Shape; value: Shape }
	/** A tuple: `elements`, then any number of `rest` values, then `after` (only with a rest). */
	| { kind: "list"; elements: Shape[]; rest?: Shape; after?: Shape[] }
	/** `name` is TypeScript's name of a field, `key` its key in the table (see {@link getPropertyKey}). */
	| { kind: "object"; fields: Array<{ name: string; key: TableKey; shape: Shape }> }
	| {
			kind: "union";
			alternatives: Alternative[];
			type?: ts.Type;
			/** The plain `number` member, whose whole values are a varint under the tag after the members. */
			whole?: number;
	  };

type Shape = ts.Type | Kind;
type ListKind = Extract<Kind, { kind: "list" }>;
type UnionKind = Extract<Kind, { kind: "union" }>;
type ObjectKind = Extract<Kind, { kind: "object" }>;

/**
 * Kinds whose type check (`checks.types`) goes ahead of the code that writes them. A number and a
 * boolean are tested in a block with their write, a literal union and a union where they find no
 * member, a blob once it is not nil.
 */
const TESTED_AHEAD = new Set<Kind["kind"]>(["constant", "datatype", "cframe", "enum", "list", "object"]);

/** Kinds whose values are Luau tables, which can be indexed without a `typeof` check first. */
const TABLE_KINDS = new Set<Kind["kind"]>(["object", "map", "array", "set", "list"]);

/** Kinds whose code is worth a function of its own; see `hoist`. */
const HOISTABLE = new Set<Kind["kind"]>(["object", "union", "list", "array", "set", "map"]);

/**
 * How a union member is picked out when a value is written:
 * - `exact`: a test only the member's own values pass: a `type` or `typeof` check (a branded number
 *   also has to fit its width), a literal, a discriminant (`v.kind == "a"`) or a required key no other
 *   member declares (`v.Coins ~= nil`);
 * - `guard`: the member's `t` guard: an object, a collection, or anything else without a test of
 *   its own. A guard checks a value's shape but ignores the keys an object does not declare, at any
 *   depth, so it can take another member's values and write them without those keys;
 * - `partial`: the guard of an object whose fields are all optional, which accepts nearly any table;
 * - `anything`: a blob with no `typeof` name to test, which takes whatever is left.
 */
type Test = "exact" | "guard" | "partial" | "anything";

/**
 * What the guard and the writer of one shape do with the values of another, over all of them: no
 * value passes the guard, every value that passes is written whole, or some value that passes is
 * written without part of it.
 */
type Fit = "none" | "whole" | "lossy";
const FIT_RANK: Record<Fit, number> = { none: 0, whole: 1, lossy: 2 };
const worse = (a: Fit, b: Fit): Fit => (FIT_RANK[a] >= FIT_RANK[b] ? a : b);

/** The whole numbers each integer width holds, and the largest finite `f32`. */
const WIDTH_RANGE: Partial<Record<Width, [number, number]>> = {
	u8: [0, 0xff],
	i8: [-0x80, 0x7f],
	u16: [0, 0xffff],
	i16: [-0x8000, 0x7fff],
	u32: [0, 0xffffffff],
	i32: [-0x80000000, 0x7fffffff],
};
const F32_MAX = 3.4028234663852886e38;

/** A set's values, seen as a map's. */
const TRUE: Kind = { kind: "constant", value: ts.factory.createTrue() };

/** The order a union's members are tested in when a value is written; see `evaluation`. */
interface Evaluation {
	order: number[];
	/**
	 * The member tested last when it has no exact test. Every other member has been ruled out by
	 * then, so the value is only checked to be a table: its guard would walk the whole value again.
	 */
	tableOnly: number | undefined;
}

/** A union member; `type` is set when the member is a real type, which a guard may be built from. */
interface Alternative {
	shape: Shape;
	type?: ts.Type;
}

/**
 * Where a union member that no spelling orders goes: by group, then depth, then key, then index
 * (`alternativeRank`).
 */
interface AlternativeRank {
	group: number;
	/** How deeply a type nests type arguments (`nestingDepth`); 0 for anything else. */
	depth: number;
	key: string;
	index: number;
}

/** Where a literal value goes in its group (`sortLiterals`): by group, then key, then index. */
type LiteralRank = [group: number, key: number | string, index: number];

interface Layout {
	/** Byte size when every value of the type takes the same number of bytes. */
	size: number | undefined;
	/** The fewest bytes any value takes; bounds counts read from a hostile buffer. */
	min: number;
	/** Whether any value of the type can put something in the blob list. */
	blobs: boolean;
	/** Whether a value of the type can hold a count of elements that take no bytes; see `readCount`. */
	zeros: boolean;
}

/** Where the next write or read goes: `base + offset`, with `offset` folded at compile time. */
interface Cursor {
	/** The `let` that tracks the position in a variable-size layout; absent when everything is fixed. */
	variable: ts.Identifier | undefined;
	/** The identifier the offset is relative to: `variable`, or the second result of a hoisted read. */
	base: ts.Identifier | undefined;
	offset: number;
}

/**
 * Where a value being written or measured sits, for the message of a width check or of an array with a
 * hole in it.
 */
interface Place {
	/**
	 * A root (`value`, a type's name, `result`) or an argument (`[2]`), then fields (`.pos`), elements
	 * (`[]`) and map keys and values (`<key>`, `<value>`). Inside a hoisted `w_`, the part after its `where`.
	 */
	path?: string;
	/** The event or function a call site sends through, which a message names when it may. */
	site?: string;
	/**
	 * Inside a hoisted `w_` whose type has checks: its `where` parameter, which the caller fills with
	 * where the value is (`'move' [1]`, `Entity.tags`). A failed check's message joins it with `path`,
	 * only once it has failed.
	 */
	where?: ts.Identifier;
	/**
	 * Inside a hoisted function: the type's name, which starts the `where` it passes to the `w_` of another
	 * type (`Entity.tags`), so that a call costs no joining of strings. Only the outermost place a value
	 * is written from, a call site's argument or a serializer's value, reaches past one `w_`.
	 */
	owner?: string;
	/** The value is a call's whole argument list (a spread made its length unknown): its elements are `[i]`. */
	args?: boolean;
	/**
	 * A union's test has already found the value's kind (`type(v) == "number"`, a guard), so its own type
	 * check is not generated again; the values inside it are still checked. Gone a step further in.
	 */
	tested?: boolean;
	/** On a union's object member: the field its discriminant compared (see `discriminantField`). */
	compared?: string;
}

interface Ctx extends Place {
	buf: ts.Identifier;
	blobs: ts.Identifier | undefined;
	cursor: Cursor;
	out: ts.Statement[];
	/**
	 * Where the value being written sits, for a width check's message; see {@link Place.path}. Writes only.
	 */
	path?: string;
	/** Writes a number without its check: a union's fallback member, whose check has already run. */
	unchecked?: boolean;
}

/** `serialization.checks`, with the defaults filled in. */
interface Checks {
	category: "implicit" | "all" | "none";
	mode: "assert" | "warn";
	side: "both" | "server" | "client";
	/** Whether every value written is tested to be of its kind first (see `typeCheckIn`). */
	types: boolean;
}

/** Where a call site's values go: the member it sends through, and whether the value is a function's result. */
export interface EncodingSite {
	/** The event or function, named in a check's message; left out under obfuscation. */
	name?: string;
	/** The one value is a function's result (`result` in a message) rather than an argument list. */
	result?: boolean;
}

/** A hoisted type: its functions are `s_<name>`, `w_<name>` and `r_<name>` in the file's table. */
interface Hoisted {
	name: string;
	/** The type as the self-check's message names it (`the type 'Pair'`); see `checkSerializerOutput`. */
	owner: string;
	layout: Layout;
	/**
	 * Whether a value of the type can fail a width check. Its `w_` then takes where the value is as a
	 * last argument (`where`), which starts the paths of the checks inside; see {@link Ctx.where}.
	 */
	checks: boolean;
	/** Whether its size pass can fail a type check (`checks.types`): its `s_` then takes `where` too. */
	sizeChecks: boolean;
}

type HoistedRole = "s" | "w" | "r";

/** The per-file varint helpers: `vsize(n)`, `vwrite(buf, o, n) -> o` and `vread(buf, o) -> n, o`. */
interface Varint {
	size: ts.Identifier;
	write: ts.Identifier;
	read: ts.Identifier;
}

function isKind(shape: Shape): shape is Kind {
	return "kind" in shape;
}

// --- AST shorthands ---------------------------------------------------------------------------------

const factory = ts.factory;
const num = (value: number) => f.number(value);
const prop = (object: ts.Expression | string, name: string) =>
	factory.createPropertyAccessExpression(typeof object === "string" ? f.identifier(object) : object, name);
const uid = (hint: string) => f.identifier(hint, true);
const assign = (target: ts.Expression, value: ts.Expression) =>
	f.statement(f.binary(target, ts.SyntaxKind.EqualsToken, value));
const addAssign = (target: ts.Expression, value: ts.Expression) =>
	f.statement(f.binary(target, ts.SyntaxKind.PlusEqualsToken, value));
const constDecl = (name: ts.Identifier | ts.BindingName, value: ts.Expression, type?: ts.TypeNode) =>
	f.variableStatement(name, value, type);
const letDecl = (name: ts.Identifier, value?: ts.Expression, type?: ts.TypeNode) =>
	f.variableStatement(name, value, type, true);
const ifStatement = (condition: ts.Expression, then: ts.Statement[], otherwise?: ts.Statement | ts.Statement[]) =>
	factory.createIfStatement(condition, f.block(then), Array.isArray(otherwise) ? f.block(otherwise) : otherwise);
const forOf = (name: ts.BindingName, iterable: ts.Expression, body: ts.Statement[]) =>
	factory.createForOfStatement(
		undefined,
		factory.createVariableDeclarationList([factory.createVariableDeclaration(name)], ts.NodeFlags.Const),
		iterable,
		f.block(body),
	);
const notNil = (value: ts.Expression) => f.binary(value, ts.SyntaxKind.ExclamationEqualsEqualsToken, f.nil());
const isNil = (value: ts.Expression) => f.binary(value, ts.SyntaxKind.EqualsEqualsEqualsToken, f.nil());
const equals = (left: ts.Expression, right: ts.Expression) =>
	f.binary(left, ts.SyntaxKind.EqualsEqualsEqualsToken, right);
const conditional = (condition: ts.Expression, whenTrue: ts.Expression, whenFalse: ts.Expression) =>
	factory.createConditionalExpression(
		condition,
		f.token(ts.SyntaxKind.QuestionToken),
		whenTrue,
		f.token(ts.SyntaxKind.ColonToken),
		whenFalse,
	);

/** A literal expression as text, for comparing and ordering literals. */
function printLiteral(expression: ts.Expression): string {
	if (f.is.string(expression)) return JSON.stringify(expression.text);
	if (f.is.number(expression)) return expression.text;
	if (ts.isPrefixUnaryExpression(expression)) return `-${printLiteral(expression.operand)}`;
	if (expression.kind === ts.SyntaxKind.TrueKeyword) return "true";
	if (expression.kind === ts.SyntaxKind.FalseKeyword) return "false";
	return `#${expression.kind}`;
}

/** A byte total under construction: the constants fold into one literal, the terms keep their order. */
class Sum {
	private constant = 0;
	private readonly terms = new Array<ts.Expression>();

	add(part: ts.Expression | number) {
		if (typeof part === "number") this.constant += part;
		else if (f.is.number(part)) this.constant += Number(part.text);
		else this.terms.push(part);
	}

	build(): ts.Expression {
		let total: ts.Expression | undefined;
		for (const term of this.terms) {
			total = total ? f.binary(total, ts.SyntaxKind.PlusToken, term) : term;
		}

		return total ? add(total, this.constant) : num(this.constant);
	}
}

/** `left + right` with constants folded. */
function add(left: ts.Expression, right: ts.Expression | number): ts.Expression {
	if (typeof right === "number") {
		if (right === 0) return left;
		if (f.is.number(left)) return num(Number(left.text) + right);
		return f.binary(left, ts.SyntaxKind.PlusToken, num(right));
	}

	if (f.is.number(left) && Number(left.text) === 0) return right;
	if (f.is.number(right)) return add(left, Number(right.text));
	return f.binary(left, ts.SyntaxKind.PlusToken, right);
}

/**
 * The types the generated code is written with. `global` names a global type, checked against what the
 * place the code lands in declares (see {@link GLOBAL_TYPES}). Arrays, records and the functions of a
 * file's table are spelled out rather than named (`unknown[]`, not `Array<unknown>`), so a project's own
 * `Record` or `Callback` cannot stand in for them.
 */
function typeNodes(global: (name: string, args?: ts.TypeNode[]) => ts.TypeNode) {
	const unknown = () => f.keywordType(ts.SyntaxKind.UnknownKeyword);
	const number = () => f.keywordType(ts.SyntaxKind.NumberKeyword);
	const string = () => f.keywordType(ts.SyntaxKind.StringKeyword);
	const defined = () => global("defined");
	const fn = (parameters: Array<[string, ts.TypeNode]>, result: ts.TypeNode) =>
		f.functionType(
			parameters.map(([name, type]) => f.parameterDeclaration(name, type)),
			result,
		);
	return {
		unknown,
		number,
		string,
		defined,
		fn,
		buffer: () => global("buffer"),
		blobs: () => factory.createArrayTypeNode(defined()),
		array: () => factory.createArrayTypeNode(unknown()),
		record: () =>
			factory.createTypeLiteralNode([
				factory.createIndexSignature(undefined, [f.parameterDeclaration("key", string())], unknown()),
			]),
		map: () => global("Map", [unknown(), unknown()]),
		set: () => global("Set", [defined()]),
		enumItem: () => global("EnumItem"),
		tuple: (elements: ts.TypeNode[]) => global("LuaTuple", [f.tupleType(elements)]),
		/** What a file's table of hoisted functions holds: the functions, called through casts to their own types. */
		functions: () =>
			factory.createTypeLiteralNode([
				factory.createIndexSignature(
					undefined,
					[f.parameterDeclaration("key", string())],
					f.functionType(
						[
							f.parameterDeclaration(
								"args",
								factory.createArrayTypeNode(f.keywordType(ts.SyntaxKind.NeverKeyword)),
								undefined,
								false,
								true,
							),
						],
						unknown(),
					),
				),
			]),
	};
}

/**
 * The globals the generated code names, which a declaration where that code lands can hide. Code packed
 * at a call site sits in the caller's scope, so `for (const [player, buffer] of ...)` around a send
 * turns `buffer.create` into a read of the caller's buffer; the helpers hoisted to the top of the file
 * sit in the module's scope. `alias`: a call site reads the global through a module-level `const`
 * instead, which works wherever the module itself does not hide it. `refuse`: a macro or constructor
 * roblox-ts only recognises by its own name (`typeIs`, `$range`, `new Map()`), or a global of the
 * hoisted helpers, which a module-level declaration hides for all of them; the build asks for the
 * declaration to be renamed. The other Luau globals roblox-ts reserves (`game`, `string`, `table`,
 * and `type` and `typeof`, which it emits for `typeIs`) cannot be declared, a `catch` clause's
 * variable aside.
 */
const GLOBAL_VALUES: Record<string, "alias" | "refuse"> = {
	buffer: "alias",
	// roblox-ts refuses a local, a parameter, a function or an import named after these, but not a
	// `catch` clause's variable: `catch (error) { ... }` around a send would make the code's `error(...)`
	// call it. Only a `catch` can hide them, so the module-level alias always reaches the global. A
	// hidden `error` is mostly not aliased but raised through `assert` instead; see `raiseWith`.
	error: "alias",
	math: "alias",
	typeIs: "refuse",
	// A declaration named `$range` or `$tuple` is no Luau identifier: roblox-ts refuses a local, and a
	// `catch ($range)` stops it outright, so nothing can hide these where a build gets this far.
	$range: "refuse",
	$tuple: "refuse",
	Array: "refuse",
	Map: "refuse",
	Set: "refuse",
	Enum: "refuse",
	CFrame: "refuse",
	warn: "refuse",
	Promise: "refuse",
};

/**
 * The global types the generated code names, which a declaration where it lands can hide too. A hidden
 * one is spelled through `globalThis` (`globalThis.Map<unknown, unknown>`), which reaches the global
 * whatever the module declares and leaves nothing in the Luau.
 */
const GLOBAL_TYPES = new Set(["buffer", "defined", "Map", "Set", "EnumItem", "LuaTuple", "CFrame"]);

// --- entry points -----------------------------------------------------------------------------------

type Generator = ReturnType<typeof createSerializerGenerator>;

/**
 * One generator per file and transform pass: every intrinsic and call site in the file shares the
 * hoisted helpers (a named type's functions, guards, literal and enum tables), which land at file
 * scope ahead of the root statement that first needed them. Kept per pass as well: a watcher that
 * keeps an unchanged file's `SourceFile` (roblox-ts after 3.0.0) transforms it again in a later pass,
 * which has to start with nothing emitted. A generator kept by file alone believed its table and
 * helpers were already there, and the file's new output called `codec`, `vsize`, `vwrite` and `vread`
 * without declaring them.
 */
const generators = new WeakMap<TransformState, Map<ts.SourceFile, Generator>>();

function generatorFor(state: TransformState, node: ts.Node, file: ts.SourceFile) {
	let perPass = generators.get(state);
	if (!perPass) generators.set(state, (perPass = new Map()));

	let generator = perPass.get(file);
	if (!generator) {
		generator = createSerializerGenerator(state, file, node);
		perPass.set(file, generator);
	}

	generator.use(node);
	return generator;
}

/**
 * The build-time self-check, at the end of a file's transform: every field of the file's `codec`
 * table that the code built for it calls has to have been handed out with its definition. `codec`
 * has an index signature, so TypeScript says nothing about a missing field, and the call would only
 * fail at runtime, as a call of nil; this turns it into a build error naming the type. A file whose
 * transform already reported an error is left alone: its code is not emitted, and what a failed value
 * left behind is not this check's to report.
 */
export function checkSerializerOutput(state: TransformState, file: ts.SourceFile) {
	// Generators are kept by the file their nodes come from, the original one.
	const generator = generators.get(state)?.get(ts.getParseTreeNode(file, ts.isSourceFile) ?? file);
	if (!generator) return;

	const missing = generator.finishFile();
	if (Diagnostics.diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return;

	// One error per type (or helper), where the file first called one of its functions.
	const byOwner = new Map<string, { node: ts.Node; fields: string[] }>();
	for (const { field, node, owner } of missing) {
		let entry = byOwner.get(owner);
		if (!entry) byOwner.set(owner, (entry = { node, fields: [] }));
		entry.fields.push(`'codec.${field}'`);
	}

	for (const [owner, { node, fields }] of byOwner) {
		const list =
			fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}` : fields[0];
		Diagnostics.addDiagnostic(
			Diagnostics.createDiagnostic(
				node,
				ts.DiagnosticCategory.Error,
				`Flamework's generated code for ${owner} calls ${list}, which this file never defines.`,
				"This is a bug in Flamework: please report it, with the file. Building again from scratch (delete the output folder) may get past it.",
			),
		);
	}
}

function emitHoisted(state: TransformState, generator: ReturnType<typeof createSerializerGenerator>) {
	state.nextRootStatements.push(...generator.takeHoisted());
}

/** `Flamework.createSerializer<T>()`: a `{ serialize, deserialize }` pair for one value. */
export function buildSerializerFromType(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	file = state.getSourceFile(node),
): ts.Expression {
	const generator = generatorFor(state, node, file);
	// The type argument as written is where the unions in it get their member order from.
	const written = ts.isCallExpression(node) ? node.typeArguments?.[0] : undefined;
	const serializer = generator.buildSerializer(generator.spell(written, unwrapPromise(state, type)));
	emitHoisted(state, generator);

	// roblox-ts type-checks the transformed file. The generated functions are typed loosely inside
	// (`unknown` values with casts); the macro's own return type is what users see.
	return f.asNever(serializer);
}

/**
 * Networking: the decoder for an argument list, given its tuple type: `(payload, blobs) => values`.
 * Promise elements are unwrapped, since a function's resolved value is what crosses the network.
 * There is no encoder counterpart as a value; see {@link buildInlineEncoding}. A list that carries
 * nothing (no elements, or only `void` ones) gets `undefined`: the runtime then passes the (empty)
 * argument list through, and the call sites send no payload at all.
 */
export function buildDecoderFromType(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	file = state.getSourceFile(node),
): ts.Expression {
	const generator = generatorFor(state, node, file);
	const decoder = generator.buildDecoder(type);
	emitHoisted(state, generator);
	if (!decoder) return f.nil();
	// A block-bodied arrow cannot be followed by `as` without parentheses.
	return f.asNever(factory.createParenthesizedExpression(decoder));
}

/**
 * Statements that pack values into `payload` (and `blobs`, when the types have blob slots). Both are
 * absent, with no statements, when the list carries nothing.
 */
export interface InlineEncoding {
	statements: ts.Statement[];
	payload: ts.Identifier | undefined;
	blobs: ts.Identifier | undefined;
}

/**
 * Packs an argument list where it is sent. `values` are the call's arguments for the tuple's
 * elements (a missing optional is `undefined`, extra ones feed the rest element), or the table that
 * holds them when a spread argument makes their number unknown. Argument expressions must be
 * identifiers or literals: they are read more than once. `site` names the member for the message of
 * a width check.
 */
export function buildInlineEncoding(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	values: ts.Expression[] | { table: ts.Expression },
	site: EncodingSite = {},
	file = state.getSourceFile(node),
): InlineEncoding {
	const generator = generatorFor(state, node, file);
	const encoding = generator.encodeList(type, values, site);
	emitHoisted(state, generator);
	return encoding;
}

/**
 * Networking: the decoder for the result of a function type, carried as a one-element list. The
 * function type, rather than its return type, so that a union written in the return type gets its
 * member order from the declaration.
 */
export function buildResultDecoderFromType(
	state: TransformState,
	node: ts.Node,
	fn: ts.Type,
	file = state.getSourceFile(node),
): ts.Expression {
	const generator = generatorFor(state, node, file);
	const decoder = generator.buildDecoder(resultOf(state, generator, fn, node));
	emitHoisted(state, generator);
	if (!decoder) return f.nil();
	return f.asNever(factory.createParenthesizedExpression(decoder));
}

/**
 * Packs a function's result as a one-element list; see {@link buildResultDecoderFromType}. `value`
 * is flagged as a parameter when it is one, so the generated code copies it before any macro sees it.
 * `name` is the function's, for the message of a width check.
 */
export function buildInlineResultEncoding(
	state: TransformState,
	node: ts.Node,
	fn: ts.Type,
	value: ts.Identifier,
	isParameter: boolean,
	name?: string,
	file = state.getSourceFile(node),
): InlineEncoding {
	const generator = generatorFor(state, node, file);
	if (isParameter) generator.markParameter(value);
	const encoding = generator.encodeList(resultOf(state, generator, fn, node), [value], { name, result: true });
	emitHoisted(state, generator);
	return encoding;
}

/**
 * Networking: how an argument list (a member's `_flamework_send` tuple) or, with `result`, a function
 * type's result is laid out on the wire, and what is checked there, as text; it builds no code. Lists
 * with one key are packed, checked and decoded alike: a call site whose target may be several members
 * packs for all of them only when their keys agree (see `transformNetworkingCall`). The key is read
 * off the same list the call site packs and each member's decoder reads, so their spellings count:
 * `(x: string | number)` and `(x: number | string)` differ. It is stricter than the bytes: a `u8`
 * and an `Implicit.u8` write one byte alike, but only the second is checked.
 */
export function packingKey(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	result = false,
	file = state.getSourceFile(node),
): string {
	const generator = generatorFor(state, node, file);
	return generator.listKey(result ? resultOf(state, generator, type, node) : type);
}

/** The one-element list a function's (resolved) result travels as, shaped by its declared return type node. */
function resultOf(
	state: TransformState,
	generator: ReturnType<typeof createSerializerGenerator>,
	fn: ts.Type,
	node: ts.Node,
): ListKind {
	const signature = fn.getCallSignatures()[0];
	if (!signature) {
		Diagnostics.error(
			node,
			`Flamework expected a function type here, got '${state.typeChecker.typeToString(fn)}'.`,
		);
	}

	const returnType = unwrapPromise(state, signature.getReturnType());
	return { kind: "list", elements: [generator.spell(signature.getDeclaration()?.type, returnType)] };
}

/** The project's `serialization.checks`, with every default filled in. */
function checkSettings(state: TransformState): Checks {
	const checks = state.projectConfig.serialization?.checks;
	return {
		category: checks?.category ?? "implicit",
		mode: checks?.mode ?? "assert",
		side: checks?.side ?? "both",
		types: checks?.types ?? false,
	};
}

/** Unwraps `Promise<T>` to `T`. */
export function unwrapPromise(state: TransformState, type: ts.Type): ts.Type {
	const promiseSymbol = state.typeChecker.resolveName("Promise", undefined, ts.SymbolFlags.Type, false);
	if (promiseSymbol !== undefined && type.getSymbol() === promiseSymbol) {
		return state.typeChecker.getTypeArguments(type as ts.TypeReference)[0] ?? type;
	}

	return type;
}

// --- generator --------------------------------------------------------------------------------------

export function createSerializerGenerator(state: TransformState, file: ts.SourceFile, initialNode: ts.Node) {
	const typeChecker = state.typeChecker;
	let diagnosticNode = initialNode;
	const resolve = (name: string) => typeChecker.resolveName(name, undefined, ts.SymbolFlags.Type, false);

	const kinds = new Map<ts.Type, Kind>();
	const layouts = new Map<Shape, Layout>();
	const visiting = new Set<Shape>();
	let provisional = 0;
	const trail = new Array<ts.Type>();

	/** Forward declarations of hoisted functions, then everything they refer to, then their bodies. */
	const declarations = new Array<ts.Statement>();
	const tables = new Array<ts.Statement>();
	const definitions = new Array<ts.Statement>();
	let emitted = [0, 0, 0];

	const hoisted = new Map<ts.Type, Hoisted>();
	const hoistedNames = new Set<string>();
	let functionTable: ts.Identifier | undefined;
	/**
	 * For the self-check (see {@link finishFile}): each field of the table the code built since the
	 * file's transform began calls, with where it was first called and what for; the field each
	 * definition statement assigns; and the fields whose definitions {@link takeHoisted} handed out.
	 */
	const called = new Map<string, { node: ts.Node; owner: string }>();
	const definitionOf = new Map<ts.Statement, string>();
	const handedOut = new Set<string>();
	const guards = new Map<ts.Type, ts.Identifier>();
	const enumTables = new Map<string, ts.Identifier>();
	const literalTables = new Map<Kind, { list: ts.Identifier; index: ts.Identifier }>();
	const discriminants = new Map<UnionKind, string | undefined>();
	const evaluations = new Map<UnionKind, Evaluation>();
	/** `fit`'s results, by the kind whose guard is asked and then the kind of the values. */
	const fits = new Map<Kind, Map<Kind, Fit>>();
	/** The unions warned about in this file: once each, where first written. */
	const warnedUnions = new Set<unknown>();
	/** Warnings already given for this file. */
	const warned = new Set<string>();
	/** How many times each shape is reached from the values built so far; see `countUses`. */
	const uses = new Map<Shape, number>();
	const walked = new Set<Shape>();
	/** A name for an unnamed type's hoisted functions: how it was written, or the property it was reached through. */
	const hints = new Map<ts.Type, string>();
	/** The node each intersection was first spelled as, which is how messages name it; see {@link typeText}. */
	const writtenAs = new Map<ts.Type, ts.TypeNode>();
	/** A union's members as alternatives, shared by every spelling of it so a literal group is one table. */
	const unionAlternatives = new Map<ts.UnionType, { isOptional: boolean; alternatives: Alternative[] }>();
	/** {@link wireKey}'s results for the shapes whose key reads nothing outside them. */
	const wireKeys = new Map<Shape, string>();
	let varint: Varint | undefined;
	/** The per-file tally of zero-size elements the payload being decoded has announced; see `readCount`. */
	let zeros: ts.Identifier | undefined;
	/** The project's width checks, and the per-file helper a failed one calls; see `checkHelper`. */
	const checks = checkSettings(state);
	/** Whether the helper is in the file's table yet. */
	let checkFunction = false;
	/** Whether the type checks' helper is in the file's table yet; see `typeCheckHelper`. */
	let typeCheckFunction = false;
	/** roblox-ts's `CheckableTypes`, once looked up (`null` when the project has none); see `isTypeofName`. */
	let checkableTypes: ts.Type | null | undefined;

	/**
	 * Parameters of the generated functions. roblox-ts copies a parameter into a temporary wherever one
	 * of its macros (`typeIs`, `Map.get`, `Array.push`) takes it, and then everything after it in the
	 * call too; a `const` copy of our own passes straight through, so {@link bind} makes one.
	 */
	const parameters = new Set<ts.Identifier>();

	/**
	 * Values handed in from outside (a call site's arguments) and the copies {@link bind} makes of them.
	 * Everything the generator makes itself is `unknown` and casts to any loose type, but these keep the
	 * type they were declared with, and TypeScript refuses some of those casts outright: a readonly
	 * tuple to `unknown[]`, an object with an index signature to `Map<unknown, unknown>`. {@link cast}
	 * sends them through `unknown`, which leaves nothing in the Luau.
	 */
	const typed = new Set<ts.Expression>();

	/**
	 * How deep the generator is in code that lands at the top of the file (hoisted functions, tables,
	 * helpers) rather than where the value is written or read; the globals that code names are looked
	 * up in the module's scope rather than the call site's. See {@link globalRef}.
	 */
	let fileLevel = 0;
	/** Whether each global is hidden where the current code lands, by scope, meaning and name. */
	const hiddenHere = new Map<string, ts.Symbol | undefined>();
	/** The module-level `const` each aliased global is read through, declared once per file. */
	const globalAliases = new Map<string, ts.Identifier>();

	const T = typeNodes(globalType);

	return {
		buildSerializer,
		buildDecoder,
		encodeList,
		use,
		spell,
		markParameter,
		takeHoisted,
		finishFile,
		listKey,
	};

	/** A fresh identifier declared as a parameter of a generated function. */
	function parameter(hint: string): ts.Identifier {
		const id = uid(hint);
		parameters.add(id);
		return id;
	}

	/** Marks an identifier declared as a parameter by the caller; see {@link bind}. */
	function markParameter(id: ts.Identifier) {
		parameters.add(id);
	}

	/** Whether an identifier from user code names a parameter, which roblox-ts treats as mutable. */
	function isParameterReference(id: ts.Identifier): boolean {
		if (parameters.has(id)) return true;
		const declaration = typeChecker.getSymbolAtLocation(id)?.valueDeclaration;
		return declaration !== undefined && ts.isParameter(declaration);
	}

	/** Points diagnostics at the intrinsic or call site being built. */
	function use(node: ts.Node) {
		diagnosticNode = node;
		hiddenHere.clear();
	}

	// --- globals ---------------------------------------------------------------------------------------

	/** Builds code that lands at the top of the file; see {@link fileLevel}. */
	function atFileLevel<R>(build: () => R): R {
		fileLevel += 1;
		try {
			return build();
		} finally {
			fileLevel -= 1;
		}
	}

	/**
	 * The declaration that hides the global `name` where the code being built lands, if any: the call
	 * site's scope for code packed there, the module's for the file's hoisted code.
	 */
	function hidingDeclaration(name: string, meaning: ts.SymbolFlags): ts.Symbol | undefined {
		const key = `${fileLevel > 0 ? "file" : "site"}:${meaning}:${name}`;
		if (hiddenHere.has(key)) return hiddenHere.get(key);

		const location = fileLevel > 0 ? file : ts.getParseTreeNode(diagnosticNode);
		const found = location && typeChecker.resolveName(name, location, meaning, false);
		const hidden =
			found !== undefined && found !== typeChecker.resolveName(name, undefined, meaning, false)
				? found
				: undefined;
		hiddenHere.set(key, hidden);
		return hidden;
	}

	/**
	 * The build error for a global the generated code needs, hidden by a declaration of the project's:
	 * "Flamework's generated code here uses the global 'Array', which the declaration of 'Array' on line
	 * 12 hides. Rename that declaration."
	 */
	function refuseHidden(name: string, declared: ts.Symbol, isType = false): never {
		const declaration = declared.declarations?.[0];
		let at = "";
		if (declaration) {
			const source = declaration.getSourceFile();
			const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
			at = source === file ? ` on line ${line}` : ` in ${state.getFileId(source)}, line ${line}`;
		}

		return Diagnostics.error(
			diagnosticNode,
			`Flamework's generated code here uses the global ${isType ? "type " : ""}'${name}', which the declaration of '${name}'${at} hides. Rename that declaration.`,
		);
	}

	/**
	 * A global value from {@link GLOBAL_VALUES} (or a datatype's constructor), as the code being built can
	 * reach it: its own name, or, where a call site's declaration hides `buffer`, `math` or `error`, the
	 * module-level alias (`local math_1 = math`, one per file and global, only where one is hidden).
	 */
	function globalRef(name: string): ts.Identifier {
		const hidden = hidingDeclaration(name, ts.SymbolFlags.Value);
		if (!hidden) return f.identifier(name);

		const policy = GLOBAL_VALUES[name] ?? "refuse";
		if (policy === "refuse" || fileLevel > 0) return refuseHidden(name, hidden);

		let alias = globalAliases.get(name);
		if (!alias) {
			// The alias is declared at the top of the file, where a module-level declaration would hide the
			// global just as well.
			const moduleLevel = atFileLevel(() => hidingDeclaration(name, ts.SymbolFlags.Value));
			if (moduleLevel) return refuseHidden(name, moduleLevel);

			alias = uid(name);
			declarations.push(constDecl(alias, f.identifier(name), f.queryType(f.identifier(name))));
			globalAliases.set(name, alias);
		}

		return alias;
	}

	/**
	 * A reference to a global type from {@link GLOBAL_TYPES} (or a datatype): its own name, or, where a
	 * declaration hides it (`type Map<K, V> = globalThis.Map<K, V>`, a local `interface Map`), the same
	 * type through `globalThis`, which a type position reaches whatever is declared around it.
	 */
	function globalType(name: string, args?: ts.TypeNode[]): ts.TypeNode {
		const hidden = hidingDeclaration(name, ts.SymbolFlags.Type);
		if (!hidden) return f.referenceType(name, args);
		if (hidingDeclaration("globalThis", ts.SymbolFlags.Namespace)) refuseHidden(name, hidden, true);
		return f.referenceType(f.qualifiedNameType(f.identifier("globalThis"), name), args);
	}

	/**
	 * Checks the globals named in code built elsewhere that the generated code includes: guards (`typeIs`,
	 * `$range`, `Enum`, `Promise`) and literals (`Enum.KeyCode.A`). Those hold no identifier of the
	 * project's, so every name there that is one of the globals refers to it. A global type a declaration
	 * hides is spelled through `globalThis` instead (see {@link globalType}), so the node that comes back
	 * may be a new one.
	 */
	function checkGlobalsIn<N extends ts.Node>(node: N): N {
		const visit = (current: ts.Node): ts.Node => {
			if (ts.isIdentifier(current)) {
				if (
					!ts.isGeneratedIdentifier(current) &&
					(current.text in GLOBAL_VALUES || isDatatypeName(current.text))
				) {
					globalRef(current.text);
				}
				return current;
			}
			if (ts.isPropertyAccessExpression(current)) {
				const expression = visit(current.expression) as ts.Expression;
				return expression === current.expression
					? current
					: factory.updatePropertyAccessExpression(current, expression, current.name);
			}
			if (ts.isPropertyAssignment(current)) {
				const name = ts.isComputedPropertyName(current.name)
					? factory.updateComputedPropertyName(current.name, visit(current.name.expression) as ts.Expression)
					: current.name;
				const initializer = visit(current.initializer) as ts.Expression;
				return name === current.name && initializer === current.initializer
					? current
					: factory.updatePropertyAssignment(current, name, initializer);
			}
			if (ts.isTypeReferenceNode(current)) {
				const args = current.typeArguments?.map((argument) => visit(argument) as ts.TypeNode);
				const changed = args?.some((argument, i) => argument !== current.typeArguments![i]) ?? false;
				if (ts.isIdentifier(current.typeName) && isGlobalTypeName(current.typeName.text)) {
					const reference = globalType(current.typeName.text, args) as ts.TypeReferenceNode;
					return changed || !ts.isIdentifier(reference.typeName) ? reference : current;
				}
				return changed
					? factory.updateTypeReferenceNode(current, current.typeName, factory.createNodeArray(args))
					: current;
			}
			// A parameter's or a variable's own name is the guard's, not a global.
			if (ts.isParameter(current) || ts.isVariableDeclaration(current)) {
				const type = current.type && (visit(current.type) as ts.TypeNode);
				const initializer = current.initializer && (visit(current.initializer) as ts.Expression);
				if (type === current.type && initializer === current.initializer) return current;
				return ts.isParameter(current)
					? factory.updateParameterDeclaration(
							current,
							current.modifiers,
							current.dotDotDotToken,
							current.name,
							current.questionToken,
							type,
							initializer,
						)
					: factory.updateVariableDeclaration(
							current,
							current.name,
							current.exclamationToken,
							type,
							initializer,
						);
			}
			return ts.visitEachChild(current, visit, state.context);
		};

		return visit(node) as N;
	}

	function isDatatypeName(name: string) {
		return DATATYPES[name] !== undefined;
	}

	function isGlobalTypeName(name: string) {
		return GLOBAL_TYPES.has(name) || isDatatypeName(name);
	}

	function bufferCall(method: string, args: ts.Expression[]) {
		return f.call(prop(globalRef("buffer"), method), args);
	}

	function range(from: ts.Expression, to: ts.Expression) {
		return f.call(globalRef("$range"), [from, to]);
	}

	function tuple(values: ts.Expression[]) {
		return f.call(globalRef("$tuple"), values);
	}

	/** `typeIs(v, name)`: roblox-ts emits `type(v) == name` for primitives and `typeof(v) == name` otherwise, with no temporaries. */
	function typeOfIs(value: ts.Expression, name: string) {
		return f.call(globalRef("typeIs"), [value, f.string(name)]);
	}

	function construct(name: string, args: ts.Expression[], typeArguments?: ts.TypeNode[]) {
		return factory.createNewExpression(globalRef(name), typeArguments, args);
	}

	/** `error("...")`, as a statement. */
	function raise(message: string) {
		return raiseWith(f.string(message));
	}

	/**
	 * `error(message)` as a statement, as the code being built can reach it. Where a call site's `catch
	 * (error)` hides the global, it is `assert(false, message)`, which raises the same message from the
	 * same line (Luau's `assert` adds the position as `error` does) and costs the file no local: a file
	 * at Luau's 200 locals that loaded before the hole checks put `error` into its sends still loads.
	 * Only where a `catch (assert)` hides that too does it go through the module-level alias.
	 */
	function raiseWith(message: ts.Expression) {
		if (
			fileLevel === 0 &&
			hidingDeclaration("error", ts.SymbolFlags.Value) &&
			!hidingDeclaration("assert", ts.SymbolFlags.Value)
		) {
			return f.statement(f.call("assert", [f.bool(false), message]));
		}

		return f.statement(f.call(globalRef("error"), [message]));
	}

	// --- casts -----------------------------------------------------------------------------------------

	/** `value as type`, through `unknown` when the value keeps its caller's type (see {@link typed}). */
	function cast(value: ts.Expression, type: ts.TypeNode): ts.Expression {
		return f.as(value, type, typed.has(value));
	}

	function skipCasts(expression: ts.Expression): ts.Expression {
		while (ts.isAsExpression(expression)) expression = expression.expression;
		return expression;
	}

	/** Hoisted statements added since the last call, in an order that keeps every reference in scope. */
	function takeHoisted(): ts.Statement[] {
		const statements = [
			...declarations.slice(emitted[0]),
			...tables.slice(emitted[1]),
			...definitions.slice(emitted[2]),
		];
		emitted = [declarations.length, tables.length, definitions.length];
		for (const statement of statements) {
			const field = definitionOf.get(statement);
			if (field !== undefined) handedOut.add(field);
		}

		return statements;
	}

	/**
	 * `table.<field> = <value>`, a definition of a field of the file's table, recorded for the self-check.
	 */
	function define(field: string, value: ts.Expression): ts.Statement {
		const statement = assign(prop(hoistedTable(), field), value);
		definitionOf.set(statement, field);
		return statement;
	}

	/** Records a call of a field of the file's table, for the self-check: `owner` says what the code is for. */
	function noteCall(field: string, owner: string) {
		if (!called.has(field)) called.set(field, { node: diagnosticNode, owner });
	}

	/**
	 * The end of the file's transform: the fields called since it began whose definitions were not
	 * handed out (see `checkSerializerOutput`). Both records start again empty, so that a second
	 * transform of the file by this generator, which would hand nothing out again, is caught too.
	 */
	function finishFile(): Array<{ field: string; node: ts.Node; owner: string }> {
		const missing = [...called]
			.filter(([field]) => !handedOut.has(field))
			.map(([field, { node, owner }]) => ({ field, node, owner }));
		called.clear();
		handedOut.clear();
		return missing;
	}

	function fail(message: string): never {
		const chain = trail.map((type) => typeText(type)).join(" > ");
		const lines = [`Flamework cannot serialize this type: ${message}.`];
		if (chain !== "") lines.push(`Reached through: ${chain}`);
		return Diagnostics.error(diagnosticNode, ...(lines as [string, ...string[]]));
	}

	/**
	 * A type for a message: an intersection as it was written where the generator reached it
	 * (`Serialization.Implicit.u8 & Serialization.Implicit.u16`), anything else as TypeScript prints
	 * it. TypeScript prints an intersection whose brands conflict (`Serialization.u8 & Serialization.u16`)
	 * as `never`; one of those not reached through a node of its own is named by its alias or its members.
	 */
	function typeText(type: ts.Type): string {
		const node = writtenAs.get(type);
		if (node) return node.getText().replace(/\s+/g, " ");

		const text = typeChecker.typeToString(type);
		if (text !== "never" || !type.isIntersection()) return text;
		if (type.aliasSymbol) {
			const args = type.aliasTypeArguments?.map((arg) => typeText(arg));
			return `${type.aliasSymbol.name}${args ? `<${args.join(", ")}>` : ""}`;
		}

		return type.types.map((member) => (member.isUnion() ? `(${typeText(member)})` : typeText(member))).join(" & ");
	}

	// --- top level -----------------------------------------------------------------------------------

	function buildSerializer(type: Shape): ts.Expression {
		const layout = layoutOf(type);
		countUses(type);
		const value = parameter("v");
		const serialize = f.arrowFunction(f.block(encodeBody(type, layout, value, rootPath(type))), [
			f.parameterDeclaration(value, T.unknown()),
		]);

		const buf = uid("buf");
		const blobs = layout.blobs ? uid("blobs") : undefined;
		const body = new Array<ts.Statement>();
		const result = decodeBody(type, layout, buf, blobs, body);
		body.push(f.returnStatement(result));
		const deserialize = f.arrowFunction(
			f.block(body),
			blobs
				? [f.parameterDeclaration(buf, T.buffer()), f.parameterDeclaration(blobs, T.blobs())]
				: [f.parameterDeclaration(buf, T.buffer())],
		);

		return f.object([
			f.propertyAssignmentDeclaration("serialize", serialize),
			f.propertyAssignmentDeclaration("deserialize", deserialize),
		]);
	}

	function buildDecoder(type: ts.Type | ListKind): ts.Expression | undefined {
		const list = isKind(type) ? type : listOf(type);
		if (carriesNothing(list)) return;

		const layout = layoutOf(list);
		countUses(list);
		const buf = uid("buf");
		const blobs = layout.blobs ? uid("blobs") : undefined;
		const body = new Array<ts.Statement>();
		const result = decodeBody(list, layout, buf, blobs, body);
		body.push(f.returnStatement(result));
		return f.arrowFunction(
			f.block(body),
			blobs
				? [f.parameterDeclaration(buf, T.buffer()), f.parameterDeclaration(blobs, T.blobs())]
				: [f.parameterDeclaration(buf, T.buffer())],
		);
	}

	function encodeList(
		type: ts.Type | ListKind,
		values: ts.Expression[] | { table: ts.Expression },
		site: EncodingSite = {},
	): InlineEncoding {
		return encodeElements(isKind(type) ? type : listOf(type), values, site);
	}

	/** A list with nothing to carry: no elements, or only `void` ones. Such a list sends no payload. */
	function carriesNothing(list: ListKind): boolean {
		return !list.rest && list.elements.every((element) => describe(element).kind === "nothing");
	}

	/** {@link wireKey} of an argument list, given as its tuple type or as a list (a function's result). */
	function listKey(type: ts.Type | ListKind): string {
		return wireKey(isKind(type) ? type : listOf(type), []).text;
	}

	/**
	 * The wire format of a shape as text, which builds no code: what each byte is and what a decoder
	 * makes of it -- widths and lengths, which of them are checked, literal tables in order, field
	 * keys in order (`10` and `"10"` differ), union members in tag order -- so that two shapes with one
	 * key are written and read alike, whatever their types are called and however their code is hoisted.
	 * A type met again inside itself is `^n`, n levels up. `reaches` is the outermost place on `stack`
	 * the key refers to; a key that refers to nothing outside itself is the same wherever it is met, and
	 * is kept.
	 */
	function wireKey(shape: Shape, stack: Shape[]): { text: string; reaches: number } {
		const at = stack.indexOf(shape);
		if (at >= 0) return { text: `^${stack.length - at}`, reaches: at };
		const known = wireKeys.get(shape);
		if (known !== undefined) return { text: known, reaches: Infinity };

		const depth = stack.length;
		let reaches = Infinity;
		const key = (inner: Shape) => {
			const result = wireKey(inner, stack);
			reaches = Math.min(reaches, result.reaches);
			return result.text;
		};
		const keys = (inner: Shape[]) => inner.map(key).join(", ");
		const checked = (implicit: boolean | undefined) => (implicit ? " checked" : "");

		const kind = describe(shape);
		stack.push(shape);
		let text: string;
		try {
			switch (kind.kind) {
				case "number":
					text = `${kind.width}${checked(kind.implicit)}`;
					break;
				case "varint":
					text = `varint${checked(kind.implicit)}`;
					break;
				case "string":
				case "buffer":
					text = `${kind.kind}(${kind.length})${checked(kind.implicit)}`;
					break;
				case "constant":
					text = `=${literalKey(kind.value)}`;
					break;
				case "literals":
					text = `literals(${kind.values.map(literalKey).join(", ")})`;
					break;
				case "blob":
					text = kind.typeofName !== undefined ? `blob(${kind.typeofName})` : "blob";
					break;
				case "datatype":
				case "enum":
					text = `${kind.kind}(${kind.name})`;
					break;
				case "optional":
					text = `optional(${key(kind.inner)})`;
					break;
				case "array":
				case "set":
					text = `${kind.kind}(${key(kind.element)})`;
					break;
				case "map":
					text = `map(${key(kind.key)}, ${key(kind.value)})`;
					break;
				case "list": {
					const rest = kind.rest ? `; ...${key(kind.rest)}` : "";
					const after = kind.after?.length ? `; ${keys(kind.after)}` : "";
					text = `list(${keys(kind.elements)}${rest}${after})`;
					break;
				}
				case "object":
					text = `object(${kind.fields.map((field) => `${JSON.stringify(field.key)}: ${key(field.shape)}`).join(", ")})`;
					break;
				case "union": {
					const whole = kind.whole !== undefined ? `; whole ${kind.whole}` : "";
					text = `union(${keys(kind.alternatives.map((alternative) => alternative.shape))}${whole})`;
					break;
				}
				default:
					text = kind.kind;
			}
		} finally {
			stack.pop();
		}

		if (reaches >= depth) wireKeys.set(shape, text);
		return { text, reaches };
	}

	/**
	 * Packs a list whose values are known one by one, so a static count of rest values and absent
	 * optionals fold into the layout: a call with only fixed-size arguments gets a constant buffer size.
	 */
	function encodeElements(
		list: ListKind,
		values: ts.Expression[] | { table: ts.Expression },
		site: EncodingSite,
	): InlineEncoding {
		if (carriesNothing(list)) return { statements: [], payload: undefined, blobs: undefined };

		const layout = layoutOf(list);
		countUses(list);
		const statements = new Array<ts.Statement>();
		if (!Array.isArray(values)) {
			const { buf, blobs } = encodeInto(list, layout, values.table, statements, {
				path: "",
				site: site.name,
				args: true,
			});
			return { statements, payload: buf, blobs };
		}

		for (const value of values) if (f.is.identifier(value)) typed.add(value);
		const elementValue = (index: number) => values[index] ?? f.nil();
		// The elements after a rest are the last arguments; TypeScript requires every one of them.
		const after = list.after ?? [];
		const afterValues = after.length > 0 ? values.slice(-after.length) : [];
		const rest = values.slice(list.elements.length, values.length - afterValues.length);
		if (rest.length > 0 && !list.rest) fail("more arguments than the list has elements");
		// Each rest argument is packed on its own, so the rest element is reached once per argument.
		for (let i = 1; i < rest.length; i++) countUses(list.rest!);

		// The rest count is known here, so its varint is a constant: literal bytes, no helper call.
		const countBytes = staticVarint(rest.length);

		const total = new Sum();
		const sizePlace = (index: number): Place => ({ path: site.result ? "result" : `[${index}]`, site: site.name });
		list.elements.forEach((element, index) =>
			total.add(emitSize(element, elementValue(index), statements, sizePlace(index))),
		);
		if (list.rest) {
			total.add(countBytes.length);
			const start = list.elements.length;
			rest.forEach((value, index) =>
				total.add(emitSize(list.rest!, value, statements, sizePlace(start + index))),
			);
			after.forEach((element, index) =>
				total.add(emitSize(element, afterValues[index], statements, sizePlace(start + rest.length + index))),
			);
		}

		const size = total.build();
		const buf = uid("buf");
		statements.push(constDecl(buf, bufferCall("create", [size])));
		const blobs = layout.blobs ? uid("blobs") : undefined;
		if (blobs) statements.push(constDecl(blobs, construct("Array", []), T.blobs()));

		const variable = f.is.number(size) ? undefined : uid("o");
		if (variable) statements.push(letDecl(variable, num(0)));

		const ctx: Ctx = {
			buf,
			blobs,
			cursor: { variable, base: variable, offset: 0 },
			out: statements,
			site: site.name,
		};
		// Each argument is where a check's message starts: `[0]`, or `result` for a function's result.
		const argument = (index: number) => within(ctx, site.result ? "result" : `[${index}]`, true);
		list.elements.forEach((element, index) => emitWrite(element, elementValue(index), argument(index)));
		if (list.rest) {
			for (const byte of countBytes) {
				ctx.out.push(f.statement(bufferCall("writeu8", [buf, at(ctx), num(byte)])));
				ctx.cursor.offset += 1;
			}
			const start = list.elements.length;
			rest.forEach((value, index) => emitWrite(list.rest!, value, argument(start + index)));
			after.forEach((element, index) =>
				emitWrite(element, afterValues[index], argument(start + rest.length + index)),
			);
		}

		return { statements, payload: buf, blobs };
	}

	/** The bytes of a varint known at compile time. */
	function staticVarint(n: number): number[] {
		const bytes = new Array<number>();
		while (n >= 128) {
			bytes.push((n % 128) + 128);
			n = Math.floor(n / 128);
		}

		bytes.push(n);
		return bytes;
	}

	/**
	 * The argument list a tuple type describes, with Promise elements unwrapped. Each element is shaped
	 * by where it was written: the tuple node when there is one, else the parameter or member it was
	 * declared with (`Parameters<F>` keeps those). An array is a list of nothing but a rest element:
	 * `Parameters<F>` of `(...values: number[]) => void` is `number[]`, not a tuple.
	 */
	function listOf(type: ts.Type, node?: ts.TupleTypeNode): ListKind {
		if (!isTupleType(state, type)) {
			if (isArrayType(state, type)) {
				const element = typeChecker.getTypeArguments(type)[0];
				if (element) return { kind: "list", elements: [], rest: unwrapPromise(state, element) };
			}

			return { kind: "list", elements: [unwrapPromise(state, type)] };
		}

		const elements = new Array<Shape>();
		let rest: Shape | undefined;
		// TypeScript allows only required elements after a rest (`[A, ...B[], C]`), and one rest.
		const after = new Array<Shape>();
		const types = typeChecker.getTypeArguments(type);
		for (let i = 0; i < types.length; i++) {
			const element = unwrapPromise(state, types[i]);
			const flags = type.target.elementFlags[i];
			const isRest = (flags & ts.ElementFlags.Rest) !== 0;
			const written = node
				? tupleElementNode(node.elements[i])
				: declaredTypeNode(type.target.labeledElementDeclarations?.[i]);
			const shape = spellElement(written, element, isRest);
			if (isRest) {
				rest = shape;
			} else if (rest) {
				after.push(shape);
			} else if (flags & ts.ElementFlags.Optional && !hasUndefined(element)) {
				elements.push({ kind: "optional", inner: shape });
			} else {
				elements.push(shape);
			}
		}

		return after.length > 0 ? { kind: "list", elements, rest, after } : { kind: "list", elements, rest };
	}

	/**
	 * `const buf = buffer.create(<size>)`, the blob list when the type has blob slots, the writes,
	 * and `return buf, blobs`.
	 */
	function encodeBody(shape: Shape, layout: Layout, value: ts.Identifier, path: string): ts.Statement[] {
		const body = new Array<ts.Statement>();
		const { buf, blobs } = encodeInto(shape, layout, value, body, { path });
		body.push(f.returnStatement(blobs ? tuple([buf, blobs]) : buf));
		return body;
	}

	/**
	 * The size pass, the buffer, the blob list when the type has blob slots, and the writes. `where`
	 * is where the value is, for the messages of the checks (see {@link Place}).
	 */
	function encodeInto(
		shape: Shape,
		layout: Layout,
		value: ts.Expression,
		body: ts.Statement[],
		where: { path: string; site?: string; args?: boolean },
	) {
		const size = emitSize(shape, value, body, where);

		const buf = uid("buf");
		body.push(constDecl(buf, bufferCall("create", [size])));

		const blobs = layout.blobs ? uid("blobs") : undefined;
		if (blobs) body.push(constDecl(blobs, construct("Array", []), T.blobs()));

		const top = isKind(shape) ? undefined : hoist(shape);
		if (top) {
			const args = blobs ? [buf, num(0), value, blobs] : [buf, num(0), value];
			if (top.checks) args.push(whereOf({ path: where.path, site: where.site }));
			body.push(f.statement(callHoisted(top, "w", args)));
		} else {
			const variable = layout.size === undefined ? uid("o") : undefined;
			if (variable) body.push(letDecl(variable, num(0)));
			emitWrite(shape, value, {
				buf,
				blobs,
				cursor: { variable, base: variable, offset: 0 },
				out: body,
				path: where.path,
				site: where.site,
				args: where.args,
			});
		}

		return { buf, blobs };
	}

	/** The reads, ending with a check that the whole buffer was consumed; returns the value. */
	function decodeBody(
		shape: Shape,
		layout: Layout,
		buf: ts.Identifier,
		blobs: ts.Identifier | undefined,
		body: ts.Statement[],
	): ts.Expression {
		const length = bufferCall("len", [buf]);
		// The payload's own tally of zero-size elements starts here; decoding never yields, so one
		// per file is never shared between two payloads.
		if (layout.zeros) body.push(assign(zeroTally(), num(0)));

		const top = isKind(shape) ? undefined : hoist(shape);
		if (top) {
			const value = uid("value");
			const end = uid("o");
			body.push(
				constDecl(
					f.arrayBindingDeclaration([value, end]),
					callHoisted(top, "r", blobs ? [buf, num(0), blobs] : [buf, num(0)]),
				),
			);
			body.push(
				ifStatement(f.binary(end, ts.SyntaxKind.ExclamationEqualsEqualsToken, length), [raise(MALFORMED)]),
			);
			return value;
		}

		const variable = layout.size === undefined ? uid("o") : undefined;
		if (variable) body.push(letDecl(variable, num(0)));

		const ctx: Ctx = { buf, blobs, cursor: { variable, base: variable, offset: 0 }, out: body };
		let result = emitRead(shape, ctx);
		if (!f.is.identifier(result) && !isLiteral(result)) {
			result = bind(body, result, "value");
		}

		if (variable) {
			sync(ctx);
			body.push(
				ifStatement(f.binary(variable, ts.SyntaxKind.ExclamationEqualsEqualsToken, length), [raise(MALFORMED)]),
			);
		} else {
			body.push(
				ifStatement(f.binary(length, ts.SyntaxKind.ExclamationEqualsEqualsToken, num(layout.size!)), [
					raise(MALFORMED),
				]),
			);
		}

		return result;
	}

	// --- classification ------------------------------------------------------------------------------

	function describe(shape: Shape): Kind {
		if (isKind(shape)) return shape;

		let kind = kinds.get(shape);
		if (!kind) {
			kind = classify(shape);
			kinds.set(shape, kind);
		}

		return kind;
	}

	function classify(type: ts.Type): Kind {
		if (type.isUnion()) return classifyUnion(type);
		if (isInstanceType(type)) return { kind: "blob", typeofName: "Instance" };
		if (type.isIntersection()) return classifyIntersection(type);

		if (isConditionalType(type)) {
			const branches = [type.resolvedTrueType!, type.resolvedFalseType!];
			return unionKind(
				branches.map((branch) => ({ shape: branch, type: branch })),
				type,
			);
		}

		if ((type.flags & ts.TypeFlags.TypeVariable) !== 0) {
			// An unconstrained type parameter can be anything, which is what a blob carries.
			const constraint = typeChecker.getBaseConstraintOfType(type);
			return constraint ? describe(constraint) : { kind: "blob" };
		}

		const literals = getLiteral(type);
		if (literals) {
			return literals.length === 1
				? { kind: "constant", value: literals[0] }
				: { kind: "literals", values: sortLiterals(literals, enumMemberOrigins(type, literals.length)) };
		}

		if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return { kind: "nothing" };
		if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: "blob" };
		if (type.flags & ts.TypeFlags.Never) fail("`never` has no values");
		// A template literal (`${string}-id`) or `Uppercase<T>` is a string with a pattern; the bytes are the same.
		if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
			return { kind: "string", length: "v" };
		}
		if (type.flags & ts.TypeFlags.Number) return { kind: "number", width: "f64" };
		if (type.flags & ts.TypeFlags.BigInt) fail("bigint does not exist in Luau");
		if (type.flags & ts.TypeFlags.ESSymbolLike) fail("symbols cannot be sent");

		if (isTupleType(state, type)) return listOf(type);

		if (isArrayType(state, type) || typeChecker.isArrayType(type)) {
			const element = typeChecker.getTypeArguments(type as ts.TypeReference)[0];
			if (!element) fail("an array without an element type");
			inheritHint(type, element);
			return { kind: "array", element };
		}

		if (type.getCallSignatures().length > 0) fail("functions cannot be sent");

		// `object`, and whatever else has no declaration behind it, has no structure to write.
		const symbol = type.getSymbol();
		if (!symbol) return { kind: "blob" };

		if (symbol === resolve("Map") || symbol === resolve("ReadonlyMap")) {
			const [key, value] = typeChecker.getTypeArguments(type as ts.TypeReference);
			if (!key || !value) fail("a Map without key and value types");
			inheritHint(type, value);
			return { kind: "map", key, value };
		}

		if (symbol === resolve("Set") || symbol === resolve("ReadonlySet")) {
			const [element] = typeChecker.getTypeArguments(type as ts.TypeReference);
			if (!element) fail("a Set without an element type");
			inheritHint(type, element);
			return { kind: "set", element };
		}

		if (symbol === resolve("WeakMap") || symbol === resolve("WeakSet")) fail("weak collections cannot be sent");
		if (symbol === resolve("Promise")) fail("a Promise cannot be sent; send its resolved value");
		if (symbol === resolve("buffer")) return { kind: "buffer", length: "v" };

		const global = symbol === resolve(symbol.name);
		if (global) {
			if (symbol.name === "CFrame") return { kind: "cframe" };
			if (DATATYPES[symbol.name] !== undefined) return { kind: "datatype", name: symbol.name };
		}

		// `Enum.Material` and friends are interfaces declared under the Enum namespace.
		const enumNamespace = resolve("Enum");
		if (symbol.parent && enumNamespace && typeChecker.getMergedSymbol(symbol.parent) === enumNamespace) {
			return { kind: "enum", name: symbol.name };
		}

		// The rest of the Roblox API (EnumItem, Font, RBXScriptSignal, ...) and anything nominal has no
		// structure a plain table could stand in for; a global's name is also what `typeof` reports, when
		// `typeIs` takes it (see `isTypeofName`). A struct the API declares (`GroupInfo`) is a plain table
		// at runtime, which no name tests: it takes anything, as a nominal type does.
		if (isRobloxType(symbol)) {
			return { kind: "blob", typeofName: global && isTypeofName(symbol.name) ? symbol.name : undefined };
		}
		if (hasNominalMarker(type)) return { kind: "blob" };

		// A class instance is more than its fields; it travels as a reference.
		if (type.isClass()) return { kind: "blob" };

		return classifyObject(type);
	}

	/** Declared by roblox-ts's Roblox API types, as opposed to by the project or the TypeScript library. */
	function isRobloxType(symbol: ts.Symbol | undefined): boolean {
		const declarations = symbol?.declarations;
		if (!declarations) return false;
		return declarations.some((declaration) => ROBLOX_TYPES.test(declaration.getSourceFile().fileName));
	}

	/** roblox-ts marks its nominal types with a `_nominal_X` property; project code may do the same. */
	function hasNominalMarker(type: ts.Type): boolean {
		return type.getProperties().some((property) => property.name.startsWith("_nominal_"));
	}

	/** A union as a kind; `node` is the spelling its members are numbered by, else the alias's own. */
	function classifyUnion(type: ts.UnionType, node?: ts.UnionTypeNode): Kind {
		if (type === typeChecker.getBooleanType()) return { kind: "boolean" };

		const { isOptional, alternatives } = alternativesOf(type);
		for (const alternative of alternatives) inheritHint(type, alternative.type);

		let inner: Shape;
		if (alternatives.length === 0) inner = { kind: "nothing" };
		else if (alternatives.length === 1) inner = alternatives[0].shape;
		// A one-byte tag numbers at most 256 members; past that the value travels whole.
		else if (alternatives.length > 0xff) inner = { kind: "blob" };
		else inner = unionKind(orderAlternatives(alternatives, node ?? aliasNode(type), type), type);

		if (isOptional) return { kind: "optional", inner };
		return describe(inner);
	}

	/**
	 * A union of ordered members. A plain `number` among them also gets the tag after the members, for
	 * the whole numbers a varint holds: array indices, counts and ids, sent as `string | number` map
	 * keys for one, take one to five bytes that way instead of eight. A branded width is left alone.
	 */
	function unionKind(alternatives: Alternative[], type: ts.Type): UnionKind {
		const whole = alternatives.findIndex(
			(alternative) => alternative.type !== undefined && (alternative.type.flags & ts.TypeFlags.Number) !== 0,
		);
		return {
			kind: "union",
			alternatives,
			type,
			whole: whole >= 0 && alternatives.length <= 0xff ? whole : undefined,
		};
	}

	function alternativesOf(type: ts.UnionType): { isOptional: boolean; alternatives: Alternative[] } {
		let entry = unionAlternatives.get(type);
		if (!entry) {
			const { enums, literals, literalOrigins, types } = simplifyUnion(type);
			const [isOptional, members] = extractTypes(typeChecker, types);
			const alternatives = new Array<Alternative>();

			for (const member of members) alternatives.push({ shape: member, type: member });
			for (const name of enums) alternatives.push({ shape: { kind: "enum", name } });
			if (literals.length === 1) alternatives.push({ shape: { kind: "constant", value: literals[0] } });
			if (literals.length > 1) {
				alternatives.push({ shape: { kind: "literals", values: sortLiterals(literals, literalOrigins) } });
			}

			entry = { isOptional, alternatives };
			unionAlternatives.set(type, entry);
		}

		return entry;
	}

	/**
	 * Union members in the order they were written: `{ Coins } | { Items }` numbers Coins 0 and Items
	 * 1. TypeScript lists them by internal type id instead, which follows what the checker happened to
	 * create first in a compilation, so the order comes from the union's type node: an alias's own
	 * declaration, or the spelling the value is reached through (see {@link spell}). A member written as
	 * another union goes by that union's own spelling, in parentheses or a non-generic alias's
	 * declaration, after its parts the checker creates when it starts (`string`, `number`, `boolean`,
	 * `""`, `0`, `"number"`), which go first, at their places ({@link memberRank}), as 2.0.0-alpha.7's
	 * type ids put them. A TypeScript enum written as a member goes by its declaration order (see
	 * {@link byDeclaration}). The members no spelling orders -- a union with no node at all (`Box<A | B>`
	 * reaches `value: T`), the members of a generic alias's instantiation (`Maybe<A>`) -- go by
	 * {@link byKey}, after the members ahead of them; the parts of a written member that no spelling
	 * orders (`Prims[keyof Prims]`) by {@link memberRank}. So the order never depends on type ids: a
	 * watcher's rebuild compiles a sender without its receiver, and a stored buffer outlives a build.
	 */
	function orderAlternatives(
		alternatives: Alternative[],
		node: ts.UnionTypeNode | undefined,
		union: ts.UnionType,
	): Alternative[] {
		const ordered = new Array<Alternative>();
		const place = (alternative: Alternative | undefined) => {
			if (alternative && !ordered.includes(alternative)) ordered.push(alternative);
		};
		const placeByKey = (group: Alternative[], rank?: (alternative: Alternative) => AlternativeRank) =>
			byKey(
				group.filter((member) => !ordered.includes(member)),
				union,
				rank,
			).forEach(place);

		const aliases = new Set<ts.Node>();
		const visit = (member: ts.TypeNode): void => {
			if (ts.isParenthesizedTypeNode(member)) return visit(member.type);

			const memberType = typeChecker.getTypeFromTypeNode(member);
			if (!memberType.isUnion()) return place(alternativeFor(alternatives, memberType));

			// `boolean`, a literal union or a whole enum is one alternative, whatever order its parts are in.
			const found = new Array<Alternative>();
			const startup = new Map<Alternative, number>();
			for (const constituent of memberType.types) {
				const alternative = alternativeFor(alternatives, constituent);
				if (!alternative) continue;
				if (!found.includes(alternative)) found.push(alternative);
				const at = startupRank(constituent);
				if (at !== undefined) startup.set(alternative, Math.min(startup.get(alternative) ?? Infinity, at));
			}
			if (found.length <= 1) return found.forEach(place);
			if (isTypeScriptEnum(memberType)) return byDeclaration(memberType, found).forEach(place);

			// Its parts the checker creates when it starts go first, at their places, where 2.0.0-alpha.7's
			// type ids put them whatever order the member writes them in (`Id | Alpha` with
			// `type Id = number | string` numbers `string` 0). Its own written order, in parentheses or in
			// a non-generic alias's declaration, numbers the others; `memberRank` the parts nothing writes.
			const rank = (alternative: Alternative) => memberRank(alternative, startup.get(alternative));
			placeByKey(
				found.filter((alternative) => startup.has(alternative)),
				rank,
			);
			if (ts.isUnionTypeNode(member)) return member.types.forEach(visit);

			const alias = memberType.aliasTypeArguments === undefined ? aliasNode(memberType) : undefined;
			if (alias && !aliases.has(alias)) {
				aliases.add(alias);
				visit(alias);
			}
			placeByKey(found, rank);
		};
		node?.types.forEach(visit);
		placeByKey(alternatives);
		return ordered;
	}

	/**
	 * Members no spelling orders, by `rank` ({@link alternativeRank} unless given). Two with one rank
	 * could only be put in an order that depends on something other than the types, so the build
	 * stops, naming them, rather than pick one.
	 */
	function byKey(
		members: Alternative[],
		union: ts.UnionType,
		rank: (alternative: Alternative) => AlternativeRank = alternativeRank,
	): Alternative[] {
		const ranked = members.map((alternative) => ({ alternative, rank: rank(alternative) }));
		ranked.sort((a, b) => compareRanks(a.rank, b.rank));
		for (let i = 1; i < ranked.length; i++) {
			if (compareRanks(ranked[i].rank, ranked[i - 1].rank) !== 0) continue;
			const [a, b] = [ranked[i - 1], ranked[i]].map(({ alternative }) => alternativeName(alternative));
			fail(
				`the union '${typeText(union)}' has two members, '${a}' and '${b}', that nothing but TypeScript's internal type ids would put in an order, and a union's members are numbered by their order. ` +
					"Declare an alias for the union (`type Choice = A | B`) and use it where the value is declared, so that its written order numbers them, or rename one of the two",
			);
		}

		return ranked.map(({ alternative }) => alternative);
	}

	/**
	 * What orders a union member that no spelling orders. First its group, in the order `alternativesOf`
	 * lists them, which 2.0.0-alpha.7 numbered such a union by and which never depended on type ids:
	 * `boolean`, then the other types, then whole Roblox enums, then the literal values. The types
	 * split in two: TypeScript's built-in ones (`string`, `number`, `object`), which its checker creates
	 * first of all, so their ids put them ahead of every other type, go first, in that creation order
	 * ({@link INTRINSIC_ORDER}); then the rest by {@link nestingDepth}, how deeply each nests type
	 * arguments, made from one another or not: so a type goes ahead of the types made from it (`Item`
	 * before `Item[]` and `Box<Item>`, which the checker can only create after `Item`), and `Zed` ahead
	 * of `Alpha[]` too. Then a key: a type's {@link typeKey}, an enum's name (`Enum.KeyCode`), the
	 * literal values. A TypeScript enum's computed member (`C = "abc".size()`), a type of its own, goes
	 * by the enum's name and then its place among the enum's members, so a whole enum keeps the order
	 * 2.0.0-alpha.7 gave it: its computed members as declared, then its values. Only the order of the
	 * rest of the types among themselves followed the ids then.
	 */
	function alternativeRank(alternative: Alternative): AlternativeRank {
		const type = alternative.type;
		if (type) {
			if (type === typeChecker.getBooleanType()) return { group: 0, depth: 0, key: "boolean", index: 0 };
			const intrinsic = intrinsicRank(type);
			if (intrinsic !== undefined) return { group: 1, depth: 0, key: "", index: intrinsic };
			const member = enumMemberOf(type);
			if (member) return { group: 2, depth: 0, key: qualifiedName(member.enum), index: member.index };
			return { group: 2, depth: nestingDepth(type), key: typeKey(type), index: -1 };
		}

		const kind = describe(alternative.shape);
		if (kind.kind === "enum") return { group: 3, depth: 0, key: `Enum.${kind.name}`, index: 0 };
		if (kind.kind === "constant") return { group: 4, depth: 0, key: literalKey(kind.value), index: 0 };
		if (kind.kind === "literals") {
			return { group: 4, depth: 0, key: kind.values.map(literalKey).join(" | "), index: 0 };
		}
		return { group: 2, depth: 0, key: kind.kind, index: -1 };
	}

	/**
	 * What orders the parts of a member written as a union that no spelling orders, such as
	 * `Prims[keyof Prims]` in `Prims[keyof Prims] | Alpha`. 2.0.0-alpha.7 put each part where the first
	 * of its types came in the member's type ids. So, unlike in a union nothing writes out, `boolean`
	 * did not go first: it went at `false`'s place among the built-in types, after `string` and
	 * `number`, and a literal group holding `false`, `true`, `""`, `0` or a name `typeof` returns
	 * (`"number"`), which the checker creates when it starts, at its earliest such value's place.
	 * `startup` is that place ({@link startupRank}), for a part that has one; every other part goes by
	 * {@link alternativeRank}, after them. The parts that have one go first in a member written out
	 * too, in parentheses or as an alias, ahead of its written order, which numbers only the others:
	 * alpha.7 put them there from the same ids.
	 */
	function memberRank(alternative: Alternative, startup: number | undefined): AlternativeRank {
		if (startup !== undefined) return { group: 1, depth: 0, key: "", index: startup };
		return alternativeRank(alternative);
	}

	/** A built-in type's place in {@link INTRINSIC_ORDER}, by its name. */
	function intrinsicRank(type: ts.Type): number | undefined {
		if (!(type.flags & ts.TypeFlags.Intrinsic)) return;
		const index = INTRINSIC_ORDER.indexOf((type as ts.IntrinsicType).intrinsicName);
		return index >= 0 ? index : undefined;
	}

	/**
	 * Where the checker creates `type` when it starts, ahead of every type a program makes: a built-in
	 * type at its place in {@link INTRINSIC_ORDER} (`false` and `true` among them), then `""` and `0`,
	 * which `createTypeChecker` creates later in its start (`emptyStringType`, `zeroType`), then the
	 * names `typeof` returns, in {@link TYPEOF_NAMES}' order, which it creates next; the same in
	 * TypeScript 5.5.3 and 5.9.3. `undefined` for any other type, an enum member whose value is `""`,
	 * `0` or `"number"` included: that is a type of its own.
	 */
	function startupRank(type: ts.Type): number | undefined {
		const intrinsic = intrinsicRank(type);
		if (intrinsic !== undefined) return intrinsic;
		if (type.flags & ts.TypeFlags.EnumLiteral) return;
		if (type.isStringLiteral() && type.value === "") return INTRINSIC_ORDER.length;
		if (type.isNumberLiteral() && type.value === 0) return INTRINSIC_ORDER.length + 1;
		const typeofName = type.isStringLiteral() ? TYPEOF_NAMES.indexOf(type.value) : -1;
		if (typeofName >= 0) return INTRINSIC_ORDER.length + 2 + typeofName;
	}

	/**
	 * How deeply `type` nests type arguments: 0 for a type with none, one more than its deepest
	 * argument for an array, a tuple, a generic's instance (an interface's, a class's or an alias's)
	 * or an intersection; a union counts as its deepest member. TypeScript can only create such a type
	 * after the types it is made from, so 2.0.0-alpha.7's type ids put `Item` ahead of `Item[]`,
	 * `[Item, number]` and `Box<Item>` in every compilation. It cannot see what a non-generic alias of
	 * a generic alias's instance is made from (`type AZed = Wrapped<Zed>`, which TypeScript keeps
	 * without type arguments): that is 0, so `AZed` goes by its name, ahead of `Zed`.
	 */
	function nestingDepth(type: ts.Type, seen = new Set<ts.Type>()): number {
		if (type.isUnion()) return Math.max(0, ...type.types.map((member) => nestingDepth(member, seen)));

		const parts = [...(type.aliasTypeArguments ?? [])];
		if (type.isIntersection()) parts.push(...type.types);
		else if (ts.getObjectFlags(type) & ts.ObjectFlags.Reference) {
			const reference = type as ts.TypeReference;
			const typeArguments = typeChecker.getTypeArguments(reference);
			parts.push(...typeArguments.slice(0, reference.target.typeParameters?.length ?? 0));
		}
		if (parts.length === 0 || seen.has(type)) return 0;

		seen.add(type);
		try {
			return 1 + Math.max(...parts.map((part) => nestingDepth(part, seen)));
		} finally {
			seen.delete(type);
		}
	}

	function compareRanks(a: AlternativeRank, b: AlternativeRank): number {
		return (
			a.group - b.group || a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.index - b.index
		);
	}

	/** Whether `type` is a TypeScript enum with several members: a union of its members' types. */
	function isTypeScriptEnum(type: ts.UnionType): boolean {
		return (type.flags & ts.TypeFlags.EnumLiteral) !== 0 && ((type.symbol?.flags ?? 0) & ts.SymbolFlags.Enum) !== 0;
	}

	/**
	 * The alternatives a TypeScript enum's members fall into, in the enum's declaration order: each
	 * where its first member is declared. TypeScript creates an enum's member types together, in
	 * declaration order, so the order 2.0.0-alpha.7 took from their type ids was already this one: a
	 * value group before a computed member declared after its first value, and after one declared
	 * ahead of it.
	 */
	function byDeclaration(enumType: ts.UnionType, found: Alternative[]): Alternative[] {
		const first = new Map<Alternative, number>();
		for (const constituent of enumType.types) {
			const alternative = alternativeFor(found, constituent);
			const index = enumMemberOf(constituent)?.index;
			if (!alternative || index === undefined) continue;
			first.set(alternative, Math.min(first.get(alternative) ?? Infinity, index));
		}

		const at = (alternative: Alternative) => first.get(alternative) ?? Number.MAX_SAFE_INTEGER;
		return [...found].sort((a, b) => at(a) - at(b));
	}

	/**
	 * A type as text that depends on nothing but the type, where TypeScript's own printing follows
	 * internal type ids (it prints a union's members in that order): a named type is its name, inside
	 * the namespaces that declare it, with its type arguments (`Wrapper<Item>`, `Enum.KeyCode.A`); the
	 * members of a union or an intersection and the properties of an object literal type are sorted; a
	 * literal is its value. Two different types can share one (two interfaces of one name in two
	 * files), which {@link byKey} refuses.
	 */
	function typeKey(type: ts.Type, seen = new Set<ts.Type>()): string {
		if (type === typeChecker.getBooleanType()) return "boolean";
		if (type.flags & ts.TypeFlags.EnumLiteral && type.symbol) return qualifiedName(type.symbol);
		const literals = getLiteral(type, true);
		if (literals) {
			return sortLiterals(literals, enumMemberOrigins(type, literals.length)).map(literalKey).join(" | ");
		}
		if (type.flags & ts.TypeFlags.Intrinsic) return (type as ts.IntrinsicType).intrinsicName;
		if (seen.has(type)) return "...";

		seen.add(type);
		try {
			const key = (inner: ts.Type) => typeKey(inner, seen);
			const sorted = (parts: string[]) => [...parts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			const args = (list: readonly ts.Type[] | undefined) =>
				list && list.length > 0 ? `<${list.map(key).join(", ")}>` : "";

			if (type.aliasSymbol) return `${qualifiedName(type.aliasSymbol)}${args(type.aliasTypeArguments)}`;
			if (type.isUnion()) return sorted(type.types.map(key)).join(" | ");
			if (type.isIntersection()) return sorted(type.types.map(key)).join(" & ");

			if (isTupleType(state, type)) {
				const flags = type.target.elementFlags;
				const elements = typeChecker.getTypeArguments(type).map((element, i) => {
					if (flags[i] & ts.ElementFlags.Variable) return `...${key(element)}[]`;
					return flags[i] & ts.ElementFlags.Optional ? `${key(element)}?` : key(element);
				});
				return `[${elements.join(", ")}]`;
			}

			const symbol = type.getSymbol();
			if (symbol && symbol.name !== "__type" && symbol.name !== "__object") {
				const target =
					ts.getObjectFlags(type) & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target : undefined;
				const typeArguments = target
					? typeChecker
							.getTypeArguments(type as ts.TypeReference)
							.slice(0, target.typeParameters?.length ?? 0)
					: undefined;
				return `${qualifiedName(symbol)}${args(typeArguments)}`;
			}

			if (type.flags & ts.TypeFlags.Object) {
				const parts = type.getProperties().map((property) => {
					const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
					const propertyType = typeChecker.getTypeOfPropertyOfType(type, property.name);
					return `${property.name}${optional}: ${propertyType ? key(propertyType) : "unknown"}`;
				});
				for (const info of typeChecker.getIndexInfosOfType(type)) {
					parts.push(`[${key(info.keyType)}]: ${key(info.type)}`);
				}
				if (type.getCallSignatures().length > 0) parts.push("()");
				return `{ ${sorted(parts).join("; ")} }`;
			}

			return typeChecker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
		} finally {
			seen.delete(type);
		}
	}

	/** A symbol's name inside the namespaces that declare it (`Enum.KeyCode.A`), never a file's. */
	function qualifiedName(symbol: ts.Symbol): string {
		let name = symbol.name;
		for (let parent = symbol.parent; parent; parent = parent.parent) {
			// A module's symbol is named after its file (`"C:/.../types"`): a path, not a namespace.
			if (!(parent.flags & ts.SymbolFlags.Namespace) || parent.name.startsWith('"')) break;
			name = `${parent.name}.${name}`;
		}

		return name;
	}

	function aliasNode(type: ts.UnionType): ts.UnionTypeNode | undefined {
		const declaration = type.aliasSymbol?.declarations?.[0];
		if (declaration && ts.isTypeAliasDeclaration(declaration) && ts.isUnionTypeNode(declaration.type)) {
			return declaration.type;
		}
	}

	/** The alternative a flattened union constituent belongs to: its own, or the group it was folded into. */
	function alternativeFor(alternatives: Alternative[], constituent: ts.Type): Alternative | undefined {
		const own = alternatives.find((alternative) => alternative.type === constituent);
		if (own) return own;

		if (constituent.flags & ts.TypeFlags.BooleanLiteral) {
			const boolean = alternatives.find((alternative) => alternative.type === typeChecker.getBooleanType());
			if (boolean) return boolean;
		}

		const enumName = robloxEnumOf(constituent);
		if (enumName !== undefined) {
			const whole = alternatives.find(
				(alternative) =>
					isKind(alternative.shape) &&
					alternative.shape.kind === "enum" &&
					alternative.shape.name === enumName,
			);
			if (whole) return whole;
		}

		if (enumName !== undefined || getLiteral(constituent, true) !== undefined) {
			return alternatives.find(
				(alternative) =>
					isKind(alternative.shape) &&
					(alternative.shape.kind === "constant" || alternative.shape.kind === "literals"),
			);
		}
	}

	/** `Material` for `Enum.Material.Plastic`. */
	function robloxEnumOf(type: ts.Type): string | undefined {
		const symbol = type.getSymbol();
		const enumNamespace = resolve("Enum");
		const group = symbol?.parent;
		if (group?.parent && enumNamespace && typeChecker.getMergedSymbol(group.parent) === enumNamespace) {
			return group.name;
		}
	}

	/**
	 * The shape of `type` as written at `node`. TypeScript keeps one type for every spelling of an
	 * anonymous union -- `string | number` here and `number | string` elsewhere are the same object
	 * -- so its member order, which is the wire tag, has to come from the spelling the value is
	 * reached through: a union node gives a union kind numbered as written, and the walk goes on
	 * into array elements, `Set`, `Map` and `Promise` arguments, tuple elements, `readonly` and
	 * parentheses. Where the node adds nothing -- a reference to an alias, whose own declaration
	 * decides; a generic's type argument, which is not where the value is reached -- the type
	 * itself, whose unions go by their alias's declaration or else by `orderAlternatives`'s key.
	 * Either way the sender and the receiver of a value go through the same declaration and number its
	 * members the same way.
	 */
	function spell(node: ts.TypeNode | undefined, type: ts.Type): Shape {
		if (!node) return type;
		nameAfter(node, type);
		if (ts.isParenthesizedTypeNode(node)) return spell(node.type, type);
		if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
			return spell(node.type, type);
		}

		if (
			type.isIntersection() &&
			node.pos >= 0 &&
			!writtenAs.has(type) &&
			typeChecker.getTypeFromTypeNode(node) === type
		) {
			writtenAs.set(type, node);
		}

		if (ts.isUnionTypeNode(node)) {
			return type.isUnion() ? classifyUnion(type, node) : type;
		}

		// A spelling that changes nothing inside keeps the type itself, which hoisting can key on.
		if (ts.isArrayTypeNode(node)) {
			const kind = describe(type);
			if (kind.kind !== "array" || isKind(kind.element)) return type;
			const element = spell(node.elementType, kind.element);
			return element === kind.element ? type : { kind: "array", element };
		}

		if (ts.isTypeReferenceNode(node) && node.typeArguments) {
			const args = node.typeArguments;
			const written = typeChecker.getTypeFromTypeNode(node);
			// `Promise<T>` in a declaration: what crosses is `T`, so its spelling is the argument.
			if (written !== type) {
				return args.length === 1 && unwrapPromise(state, written) === type ? spell(args[0], type) : type;
			}

			const kind = describe(type);
			if ((kind.kind === "array" || kind.kind === "set") && args.length === 1 && !isKind(kind.element)) {
				const element = spell(args[0], kind.element);
				return element === kind.element ? type : { kind: kind.kind, element };
			}
			if (kind.kind === "map" && args.length === 2 && !isKind(kind.key) && !isKind(kind.value)) {
				const key = spell(args[0], kind.key);
				const value = spell(args[1], kind.value);
				return key === kind.key && value === kind.value ? type : { kind: "map", key, value };
			}
			return type;
		}

		if (ts.isTupleTypeNode(node) && isTupleType(state, type)) return listOf(type, node);

		return type;
	}

	/** A tuple element or parameter: a rest element's node is the array, its type the element. */
	function spellElement(node: ts.TypeNode | undefined, type: ts.Type, rest: boolean): Shape {
		if (!node || !rest) return spell(node, type);
		if (ts.isArrayTypeNode(node)) return spell(node.elementType, type);
		if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1) {
			return spell(node.typeArguments[0], type);
		}

		return type;
	}

	/** The node a tuple element's type was written in, past its name, `?` or `...`. */
	function tupleElementNode(element: ts.TypeNode | undefined): ts.TypeNode | undefined {
		if (!element) return;
		if (ts.isNamedTupleMember(element) || ts.isRestTypeNode(element) || ts.isOptionalTypeNode(element)) {
			return element.type;
		}

		return element;
	}

	/** A property's, parameter's or tuple member's declared type node, where its unions were written. */
	function declaredTypeNode(declaration: ts.Declaration | undefined): ts.TypeNode | undefined {
		if (!declaration) return;
		if (
			ts.isPropertySignature(declaration) ||
			ts.isPropertyDeclaration(declaration) ||
			ts.isParameter(declaration) ||
			ts.isNamedTupleMember(declaration)
		) {
			return declaration.type;
		}
	}

	function classifyIntersection(type: ts.IntersectionType): Kind {
		// `LuaTuple<T>` is `T & { LUA_TUPLE: never }`: several values at runtime, never a table.
		if (type.types.some((member) => member.getProperty("LUA_TUPLE") !== undefined)) {
			fail("a LuaTuple is several values at runtime, not a table; declare a tuple type such as `[A, B]` instead");
		}

		// An optional brand's values are checked; a required one's are not, unless the project says so.
		const implicitOf = (found: Brand) => (found.implicit ? { implicit: true } : {});
		const disjoint = type.types.find((member) => (member.flags & ts.TypeFlags.DisjointDomains) !== 0);
		if (disjoint) {
			if (disjoint.flags & ts.TypeFlags.Number) {
				const found = findBrand(type, isNumberBrand);
				if (!found) return { kind: "number", width: "f64" };
				if (found.brand === VARINT_BRAND) return { kind: "varint", ...implicitOf(found) };
				return { kind: "number", width: found.brand as Width, ...implicitOf(found) };
			}

			if (disjoint.flags & ts.TypeFlags.String) {
				const found = findBrand(type, isStringBrand);
				if (!found) return { kind: "string", length: "v" };
				return { kind: "string", length: STRING_BRANDS[found.brand], ...implicitOf(found) };
			}

			return describe(disjoint);
		}

		const bufferSymbol = resolve("buffer");
		if (type.types.some((member) => member.getSymbol() === bufferSymbol)) {
			const found = findBrand(type, isBufferBrand);
			if (!found) return { kind: "buffer", length: "v" };
			return { kind: "buffer", length: BUFFER_BRANDS[found.brand], ...implicitOf(found) };
		}

		const datatype = type.types.find((member) => {
			const name = member.getSymbol()?.name;
			return (
				name !== undefined &&
				(DATATYPES[name] !== undefined || name === "CFrame") &&
				member.getSymbol() === resolve(name)
			);
		});
		if (datatype) return describe(datatype);
		if (type.types.some((member) => isInstanceType(member))) return { kind: "blob", typeofName: "Instance" };
		if (type.types.some((member) => isRobloxType(member.getSymbol())) || hasNominalMarker(type)) {
			return { kind: "blob" };
		}

		return classifyObject(type);
	}

	/**
	 * The width in `number & { __brand: "u8" }`: the literal of a property, whatever the property is
	 * called, that `isWidth` takes for this kind of value (a number's widths for a number, and so on).
	 * An optional property (`__brand?: "u8"`, or `Serialization.Implicit.u8`'s `_flamework_u8?`) makes
	 * the width implicit: it takes plain values, and they are checked where they are written.
	 *
	 * Every member of the intersection is read, so a type that names two widths
	 * (`Serialization.u16 & Serialization.Implicit.u8`, two implicit widths, or a brand of the
	 * project's own next to one) is a build error naming it rather than whichever came first. The
	 * same width named twice is that width, and implicit only when every property naming it is
	 * optional: a required one keeps plain values out. Each strict width names its own twice, with
	 * its implicit twin's optional property next to the required `__brand`.
	 */
	function findBrand(type: ts.IntersectionType, isWidth: (literal: string) => boolean): Brand | undefined {
		let found: Brand | undefined;
		for (const member of type.types) {
			if ((member.flags & ts.TypeFlags.Object) === 0) continue;

			for (const property of member.getProperties()) {
				const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
				let propertyType = typeChecker.getTypeOfPropertyOfType(member, property.name);
				// An optional property's type carries `undefined` as well: `"u16" | undefined`.
				if (propertyType && optional) propertyType = typeChecker.getNonNullableType(propertyType);
				if (!propertyType?.isStringLiteral() || !isWidth(propertyType.value)) continue;

				const brand = propertyType.value;
				if (found && found.brand !== brand) {
					// Named as the widths are: `u8_string` is a string8.
					const [a, b] = [found.brand, brand].map((literal) =>
						literal.replace(/^u(\d+)_(string|buffer)$/, "$2$1"),
					);
					fail(
						`'${typeText(type)}' names two widths, ${a} and ${b}; a value is written at one width, so keep one of them`,
					);
				}
				found = { brand, implicit: (found?.implicit ?? true) && optional };
			}
		}

		return found;
	}

	function classifyObject(type: ts.Type): Kind {
		const indexInfos = typeChecker.getIndexInfosOfType(type);
		const properties = type.getProperties().filter((property) => {
			const propertyType = typeChecker.getTypeOfPropertyOfType(type, property.name);
			return (
				propertyType !== undefined &&
				(propertyType.flags & (ts.TypeFlags.Never | ts.TypeFlags.UniqueESSymbol)) === 0
			);
		});

		if (properties.length === 0 && indexInfos.length === 0) return { kind: "blob" };

		if (indexInfos.length > 0) {
			// Named properties next to an index signature, or several signatures, have no single layout.
			if (properties.length > 0 || indexInfos.length > 1) return { kind: "blob" };
			return { kind: "map", key: indexInfos[0].keyType, value: indexInfos[0].type };
		}

		const fields = fieldOrder(type, properties).map((property) => {
			const propertyType = typeChecker.getTypeOfPropertyOfType(type, property.name)!;
			if (propertyType.getCallSignatures().length > 0) fail(`property '${property.name}' is a function`);
			const written = spell(declaredTypeNode(property.valueDeclaration), propertyType);
			if (!isKind(written) && !hints.has(written)) hints.set(written, property.name);

			const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 && !hasUndefined(propertyType);
			const shape: Shape = optional ? { kind: "optional", inner: written } : written;
			return { name: property.name, key: getPropertyKey(typeChecker, property), shape };
		});

		return { kind: "object", fields };
	}

	/**
	 * The order an object's fields go on the wire: TypeScript's own, which 2.0.0-alpha.7 sent, wherever
	 * that follows from the types alone, and a sorted one where it followed TypeScript's type ids (see
	 * {@link propertyOrder}). A field missing from that order goes last, by name.
	 */
	function fieldOrder(type: ts.Type, properties: ts.Symbol[]): ts.Symbol[] {
		const order = propertyOrder(type, new Set());
		const position = new Map(order.map((name, i) => [name, i]));
		const at = (property: ts.Symbol) => position.get(property.name) ?? Number.MAX_SAFE_INTEGER;
		return [...properties].sort((a, b) => at(a) - at(b) || compareText(a.name, b.name));
	}

	/**
	 * A type's property names in wire order. TypeScript lists an interface's or an object literal
	 * type's properties as declared, then those it inherits, base by base, and an intersection's part
	 * by part: all of it follows from the source. A mapped type is where its order can follow the type
	 * ids instead (`resolveMappedTypeMembers` in TypeScript's checker, 5.5 and 5.9 alike):
	 * - A homomorphic one, `{ [P in keyof T]: ... }` (`Partial`, `Readonly`, `Required`, and the
	 *   project's own) makes its properties in the order `T` lists its own (`getPropertiesOfType` of
	 *   `T`), so it follows `T`'s order, worked out by these same rules.
	 * - One over a union of keys (`Record<K, V>`, `Pick`, `Omit`, `{ [P in K]: ... }`) makes them in the
	 *   order of the union's members, which is by type id: whichever key literal the checker happened to
	 *   create first in that compilation came first. Those go by their keys, sorted as a literal group's
	 *   values are (`sortLiterals`): numbers by value, then strings by code units, then a TypeScript
	 *   enum's members as the enum declares them (which is what the ids gave them too: `Record<E, V>`
	 *   keeps its order), the enums by name.
	 * A type whose properties came from a mapped type (an interface extending a `Record`, a spread)
	 * keeps TypeScript's order around them and puts that mapped type's run in the mapped type's order.
	 * Where the origin cannot be told -- a property with no declaration that no mapped type made, one
	 * an intersection made among a mapped type's -- the type's properties go by name.
	 */
	function propertyOrder(type: ts.Type, seen: Set<ts.Type>): string[] {
		const properties = typeChecker.getPropertiesOfType(type);
		const byName = () => properties.map((property) => property.name).sort(compareText);
		if (seen.has(type)) return byName();

		seen.add(type);
		try {
			if (type.isIntersection()) {
				// `getPropertiesOfUnionOrIntersectionType`: each part's in turn, a name where it first comes.
				const order = new Array<string>();
				for (const part of type.types) {
					for (const name of propertyOrder(part, seen)) if (!order.includes(name)) order.push(name);
				}
				return order;
			}

			if (ts.getObjectFlags(type) & ts.ObjectFlags.Mapped) return mappedOrder(type as ts.MappedType, seen);

			const mappedBy = (property: ts.Symbol) =>
				ts.getCheckFlags(property) & ts.CheckFlags.Mapped
					? (property as ts.MappedSymbol).links.mappedType
					: undefined;
			const unknownOrigin = properties.some((property) => !mappedBy(property) && !property.declarations?.length);
			const synthetic = properties.some(
				(property) => (ts.getCheckFlags(property) & ts.CheckFlags.SyntheticProperty) !== 0,
			);
			if (unknownOrigin || (synthetic && properties.some(mappedBy))) return byName();

			// A mapped type's properties come in one run, in that type's order: put the run in its wire order.
			const order = new Array<string>();
			let start = 0;
			while (start < properties.length) {
				const mapped = mappedBy(properties[start]);
				let end = start + 1;
				while (mapped && end < properties.length && mappedBy(properties[end]) === mapped) end++;

				const run = properties.slice(start, end).map((property) => property.name);
				if (mapped) {
					const inner = propertyOrder(mapped, seen);
					run.sort((a, b) => inner.indexOf(a) - inner.indexOf(b));
				}
				order.push(...run);
				start = end;
			}
			return order;
		} finally {
			seen.delete(type);
		}
	}

	/** {@link propertyOrder} of a mapped type. */
	function mappedOrder(type: ts.MappedType, seen: Set<ts.Type>): string[] {
		const properties = typeChecker.getPropertiesOfType(type);
		const links = (property: ts.Symbol) =>
			ts.getCheckFlags(property) & ts.CheckFlags.Mapped ? (property as ts.MappedSymbol).links : undefined;
		const constraint = ts.getEffectiveConstraintOfTypeParameter(type.declaration.typeParameter);
		const homomorphic =
			constraint !== undefined &&
			ts.isTypeOperatorNode(constraint) &&
			constraint.operator === ts.SyntaxKind.KeyOfKeyword;

		let rank: (property: ts.Symbol) => Array<number | string>;
		if (homomorphic && type.modifiersType) {
			// Made from the properties of `T` (which resolving the type's members cached as `modifiersType`),
			// each where `T` has the property its key names; a key remapped (`as`) into several names makes
			// them together.
			const inner = propertyOrder(typeChecker.getApparentType(type.modifiersType), seen);
			rank = (property) => {
				const origin = links(property)?.syntheticOrigin ?? property;
				const at = inner.indexOf(origin.name);
				return [at >= 0 ? at : Number.MAX_SAFE_INTEGER];
			};
		} else if (!homomorphic) {
			rank = (property) => {
				const key = links(property)?.keyType;
				return key ? keyRank(key) : [Number.MAX_SAFE_INTEGER];
			};
		} else {
			return properties.map((property) => property.name).sort(compareText);
		}

		return [...properties]
			.sort((a, b) => compareTuples(rank(a), rank(b)) || compareText(a.name, b.name))
			.map((property) => property.name);
	}

	/**
	 * Where a mapped type's key goes, as `sortLiterals` puts a literal group's values ({@link valueRank}):
	 * `""`, `0` and the names `typeof` returns first, then numbers by size, each before its negative,
	 * then strings by code units, then a TypeScript enum's members by the enum's name and declaration
	 * order (`Record<"number" | "string", V>` sends `string`, then `number`). A key that names
	 * several properties (`as`) goes where the first of them would.
	 */
	function keyRank(key: ts.Type): Array<number | string> {
		if (key.isUnion()) {
			return key.types.map(keyRank).reduce((least, rank) => (compareTuples(rank, least) < 0 ? rank : least));
		}

		const member = enumMemberOf(key);
		if (member) return [3, qualifiedName(member.enum), member.index];
		if (key.isNumberLiteral() || key.isStringLiteral()) return valueRank(key.value);
		return [5, "", 0];
	}

	function compareTuples(a: ReadonlyArray<number | string>, b: ReadonlyArray<number | string>): number {
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			const [x, y] = [a[i], b[i]];
			if (x === y) continue;
			if (typeof x === "number" && typeof y === "number") return x - y;
			return compareText(String(x), String(y));
		}

		return a.length - b.length;
	}

	/** Text by code units, the same on every machine (`localeCompare` is not). */
	function compareText(a: string, b: string): number {
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function hasUndefined(type: ts.Type) {
		return (
			type.isUnion() &&
			type.types.some((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
		);
	}

	// --- layout --------------------------------------------------------------------------------------

	function layoutOf(shape: Shape): Layout {
		const memo = layouts.get(shape);
		if (memo) return memo;

		// A type reached again while it is being measured: its size is not fixed, whatever it is.
		if (visiting.has(shape)) {
			provisional += 1;
			return { size: undefined, min: 0, blobs: false, zeros: false };
		}

		visiting.add(shape);
		const before = provisional;
		let layout: Layout;
		try {
			layout = computeLayout(shape);
		} finally {
			visiting.delete(shape);
		}

		// A result that saw a cycle is only final for the type that closes it, at the top of the chain.
		if (provisional === before || visiting.size === 0) layouts.set(shape, layout);
		if (visiting.size === 0) provisional = 0;

		return layout;
	}

	function computeLayout(shape: Shape): Layout {
		if (!isKind(shape)) {
			// Popped however the type ends: the generator lives on after a failed type, for the file's next value.
			trail.push(shape);
			try {
				return layoutOf(describe(shape));
			} finally {
				trail.pop();
			}
		}

		const fixed = (size: number, blobs = false): Layout => ({ size, min: size, blobs, zeros: false });
		const kind = shape;
		switch (kind.kind) {
			case "number":
				return fixed(WIDTH_SIZE[kind.width]);
			case "varint":
				return { size: undefined, min: 1, blobs: false, zeros: false };
			case "boolean":
				return fixed(1);
			case "string":
			case "buffer":
				return { size: undefined, min: lengthMin(kind.length), blobs: false, zeros: false };
			case "constant":
			case "nothing":
				return fixed(0);
			case "literals":
				return fixed(kind.values.length > 0xff ? 2 : 1);
			case "blob":
				return fixed(BLOB_SIZE, true);
			case "datatype":
				return fixed(DATATYPES[kind.name].reduce((total, [width]) => total + WIDTH_SIZE[width], 0));
			case "cframe":
				return fixed(CFRAME_COMPONENTS * 4);
			case "enum":
				return fixed(2);
			case "optional": {
				const inner = layoutOf(kind.inner);
				return { size: undefined, min: 1, blobs: inner.blobs, zeros: inner.zeros };
			}
			case "array":
			case "set": {
				const element = layoutOf(kind.element);
				// A zero-size element is a fixed size of 0; a type still being measured reports `min` 0 too.
				return { size: undefined, min: 1, blobs: element.blobs, zeros: element.size === 0 || element.zeros };
			}
			case "map": {
				const key = layoutOf(kind.key);
				const value = layoutOf(kind.value);
				return {
					size: undefined,
					min: 1,
					blobs: key.blobs || value.blobs,
					zeros: (key.size === 0 && value.size === 0) || key.zeros || value.zeros,
				};
			}
			case "list": {
				const layout = sumLayouts(
					[...kind.elements, ...(kind.after ?? [])].map((element) => layoutOf(element)),
				);
				if (kind.rest) {
					const rest = layoutOf(kind.rest);
					return {
						size: undefined,
						min: layout.min + 1,
						blobs: layout.blobs || rest.blobs,
						zeros: layout.zeros || rest.size === 0 || rest.zeros,
					};
				}

				return layout;
			}
			case "object":
				return sumLayouts(kind.fields.map((field) => layoutOf(field.shape)));
			case "union": {
				const members = kind.alternatives.map((alternative) => layoutOf(alternative.shape));
				// A whole number is a varint of its own.
				if (kind.whole !== undefined) members.push({ size: undefined, min: 1, blobs: false, zeros: false });
				const sizes = new Set(members.map((member) => member.size));
				const size = sizes.size === 1 && !sizes.has(undefined) ? 1 + members[0].size! : undefined;
				return {
					size,
					min: 1 + Math.min(...members.map((member) => member.min)),
					blobs: members.some((member) => member.blobs),
					zeros: members.some((member) => member.zeros),
				};
			}
		}
	}

	function sumLayouts(layouts: Layout[]): Layout {
		let size: number | undefined = 0;
		let min = 0;
		let blobs = false;
		let zeros = false;
		for (const layout of layouts) {
			size = size === undefined || layout.size === undefined ? undefined : size + layout.size;
			min += layout.min;
			blobs ||= layout.blobs;
			zeros ||= layout.zeros;
		}

		return { size, min, blobs, zeros };
	}

	// --- hoisting ------------------------------------------------------------------------------------

	/**
	 * Variable-size types that get their own size, write and read functions, called wherever the type
	 * is reached, instead of being written out in place:
	 * - a named object, union or tuple, always;
	 * - any other object, union, tuple, array, set or map that the values built so far in the file
	 *   reach more than once: a mapped or conditional type's instance, an object literal type,
	 *   `string[]`, `Map<string, number>`. Written out in place, each of those is emitted three times
	 *   (size, write, read) at every place it is reached, and every type inside it with it.
	 * A recursive type reaches itself, so it is hoisted with or without a name, which is what lets
	 * its code refer to itself. A type reached once stays in place: its code is emitted once either
	 * way, while functions cost their own headers and a call per value. A fixed-size type always stays
	 * in place. The functions live in one table per file (see {@link hoistedTable}).
	 */
	function hoist(type: ts.Type): Hoisted | undefined {
		const existing = hoisted.get(type);
		if (existing) return existing;

		if (!canHoist(type)) return;

		const layout = layoutOf(type);
		const structure = describe(type).kind;
		const named = hoistName(type);
		const isCollection = structure === "array" || structure === "set" || structure === "map";
		const name =
			named !== undefined && !isCollection
				? named
				: (uses.get(type) ?? 0) > 1
					? generatedName(type, structure)
					: undefined;
		if (name === undefined) return;

		let unique = name;
		for (let suffix = 1; hoistedNames.has(unique); suffix++) unique = `${name}_${suffix}`;
		hoistedNames.add(unique);

		const info: Hoisted = {
			name: unique,
			owner: `the type '${typeText(type)}'`,
			layout,
			checks: hasChecks(type),
			sizeChecks: hasTypeChecks(type, "size"),
		};

		// Recorded ahead of its functions, which is what lets a type refer to itself: they are looked
		// up in the table when called, so their bodies can be built now. They land at the top of the
		// file. When building them fails, the type is taken out again, with every type hoisted while it
		// was built (one of those may call it), so that a later value of the file builds them anew
		// rather than calling functions that were never finished. Their names stay taken: what was
		// built of them before the failure may still be handed out, and a new build must not define
		// the same fields twice.
		// A Map keeps insertion order: what was hoisted from here on is what comes after `before`.
		const before = hoisted.size;
		hoisted.set(type, info);
		try {
			atFileLevel(() => buildHoisted(type, info));
		} catch (error) {
			for (const key of [...hoisted.keys()].slice(before)) hoisted.delete(key);
			throw error;
		}

		return info;
	}

	/** The size, write and read functions of a hoisted type; see {@link hoist}. */
	function buildHoisted(type: ts.Type, info: Hoisted) {
		trail.push(type);
		try {
			buildHoistedFunctions(type, info);
		} finally {
			trail.pop();
		}
	}

	function buildHoistedFunctions(type: ts.Type, info: Hoisted) {
		const layout = info.layout;
		const kind = describe(type);

		const value = parameter("v");
		const sizeBody = new Array<ts.Statement>();
		// With type checks, the size pass tests what it measures, from the `where` its caller passes.
		const sizeWhere = info.sizeChecks ? uid("where") : undefined;
		const size = emitSize(kind, value, sizeBody, { path: "", owner: displayName(type), where: sizeWhere });
		sizeBody.push(f.returnStatement(size));
		const sizeParameters = [f.parameterDeclaration(value, T.unknown())];
		if (sizeWhere) sizeParameters.push(f.parameterDeclaration(sizeWhere, T.string()));
		definitions.push(define(fieldName(info, "s"), f.arrowFunction(f.block(sizeBody), sizeParameters)));

		const buf = uid("buf");
		const o = uid("o");
		const blobs = layout.blobs ? uid("blobs") : undefined;
		const declare = (list: Array<[ts.Identifier, ts.TypeNode]>) =>
			list.map(([id, type]) => f.parameterDeclaration(id, type));
		const withBlobs = (list: Array<[ts.Identifier, ts.TypeNode]>) =>
			declare(blobs ? [...list, [blobs, T.blobs()]] : list);

		const writeBody = new Array<ts.Statement>();
		// Shared by every place that reaches the type: a check's path starts from the `where` its caller
		// passes, and the `where` this passes on to another type's `w_` from this type's name.
		const where = info.checks ? uid("where") : undefined;
		const writeCtx: Ctx = {
			buf,
			blobs,
			cursor: { variable: o, base: o, offset: 0 },
			out: writeBody,
			path: "",
			where,
			owner: displayName(type),
		};
		emitWrite(kind, value, writeCtx);
		sync(writeCtx);
		writeBody.push(f.returnStatement(o));
		const writeParameters = withBlobs([
			[buf, T.buffer()],
			[o, T.number()],
			[value, T.unknown()],
		]);
		if (where) writeParameters.push(f.parameterDeclaration(where, T.string()));
		definitions.push(define(fieldName(info, "w"), f.arrowFunction(f.block(writeBody), writeParameters)));

		const readBody = new Array<ts.Statement>();
		const readCtx: Ctx = { buf, blobs, cursor: { variable: o, base: o, offset: 0 }, out: readBody };
		const result = emitRead(kind, readCtx);
		const bound = f.is.identifier(result) || isLiteral(result) ? result : bind(readBody, result, "value");
		sync(readCtx);
		readBody.push(f.returnStatement(tuple([bound, o])));
		definitions.push(
			define(
				fieldName(info, "r"),
				f.arrowFunction(
					f.block(readBody),
					withBlobs([
						[buf, T.buffer()],
						[o, T.number()],
					]),
				),
			),
		);
	}

	/**
	 * The file's table of hoisted functions, declared ahead of the first. One local holds them all:
	 * Luau allows 200 locals in a function, the file's main chunk included, and three per hoisted
	 * type ran a file with about 66 of them past it, where it compiled but no longer loaded.
	 */
	function hoistedTable(): ts.Identifier {
		if (!functionTable) {
			functionTable = uid("codec");
			declarations.push(constDecl(functionTable, f.object([]), T.functions()));
		}

		return functionTable;
	}

	function fieldName(info: Hoisted, role: HoistedRole): string {
		return `${role}_${info.name}`;
	}

	/** A call of a hoisted function, typed as it is so the call's result has the right type. */
	function callHoisted(info: Hoisted, role: HoistedRole, args: ts.Expression[]): ts.Expression {
		const blobs: Array<[string, ts.TypeNode]> = info.layout.blobs ? [["blobs", T.blobs()]] : [];
		const where: Array<[string, ts.TypeNode]> =
			(role === "w" && info.checks) || (role === "s" && info.sizeChecks) ? [["where", T.string()]] : [];
		const type =
			role === "s"
				? T.fn([["v", T.unknown()], ...where], T.number())
				: role === "w"
					? T.fn([["buf", T.buffer()], ["o", T.number()], ["v", T.unknown()], ...blobs, ...where], T.number())
					: T.fn([["buf", T.buffer()], ["o", T.number()], ...blobs], T.tuple([T.unknown(), T.number()]));
		noteCall(fieldName(info, role), info.owner);
		return f.call(f.as(prop(hoistedTable(), fieldName(info, role)), type), args);
	}

	/**
	 * Counts how many times each shape is reached from `root`, adding to the counts of the values
	 * built before it in the file. The contents of a type that can be hoisted are walked the first
	 * time only, since its body is emitted once however many times it is reached; anything else is
	 * written out wherever it is reached, and so is everything inside it. Every cycle in a type goes
	 * through one that can be hoisted, so the walk ends.
	 */
	function countUses(root: Shape) {
		uses.set(root, (uses.get(root) ?? 0) + 1);
		if (!isKind(root) && canHoist(root)) {
			if (walked.has(root)) return;
			walked.add(root);
		}

		const kind = describe(root);
		switch (kind.kind) {
			case "optional":
				countUses(kind.inner);
				break;
			case "array":
			case "set":
				countUses(kind.element);
				break;
			case "map":
				countUses(kind.key);
				countUses(kind.value);
				break;
			case "list":
				kind.elements.forEach(countUses);
				if (kind.rest) countUses(kind.rest);
				kind.after?.forEach(countUses);
				break;
			case "object":
				for (const field of kind.fields) countUses(field.shape);
				break;
			case "union":
				for (const alternative of kind.alternatives) countUses(alternative.shape);
				break;
		}
	}

	/** A variable-size object, union, tuple or collection type: one whose code a function can hold. */
	function canHoist(type: ts.Type): boolean {
		if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.UnionOrIntersection)) === 0) return false;
		return layoutOf(type).size === undefined && HOISTABLE.has(describe(type).kind);
	}

	/**
	 * A name for the functions of a type hoisted without a name of its own: its alias, or how
	 * TypeScript prints it (`ReadonlyMap<string, number>`), cut short; a type printed as an object
	 * literal is named after the property it was first reached through instead.
	 */
	function generatedName(type: ts.Type, structure: Kind["kind"]): string {
		const printed = type.aliasSymbol?.name ?? typeChecker.typeToString(type);
		const text = printed.includes("{") ? (hints.get(type) ?? structure) : printed;
		const words = text
			.replace(/\[\]/g, "Array")
			.replace(/\W+/g, "_")
			.replace(/^_+|_+$/g, "");
		const name = words.length > 40 ? words.slice(0, 40).replace(/_[^_]*$/, "") : words;
		return name === "" ? structure : name;
	}

	/** Names a type after how it is written (`Patch<Tree>`), unless it is written out as an object literal. */
	function nameAfter(node: ts.TypeNode, type: ts.Type) {
		if (hints.has(type) || node.pos < 0) return;
		const text = node.getText();
		if (!text.includes("{")) hints.set(type, text);
	}

	/** Names an unnamed part of `parent` after it, unless something named it first. */
	function inheritHint(parent: ts.Type, child: Shape | undefined) {
		const hint = hints.get(parent);
		if (hint !== undefined && child !== undefined && !isKind(child) && !hints.has(child)) hints.set(child, hint);
	}

	function hoistName(type: ts.Type): string | undefined {
		if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.UnionOrIntersection)) === 0) return;
		if (isInstanceType(type) || getLiteral(type) !== undefined) return;

		const symbolName = type.aliasSymbol?.name ?? type.symbol?.name;
		if (symbolName === undefined || symbolName === "__type" || symbolName === "__object") return;
		if (symbolName === "Array" || symbolName === "ReadonlyArray") return;
		if (DATATYPES[symbolName] !== undefined || symbolName === "CFrame") return;

		return symbolName.replace(/\W/g, "_");
	}

	function guardFor(type: ts.Type): ts.Identifier {
		let guard = guards.get(type);
		if (!guard) {
			guard = uid("guard");
			const expression = atFileLevel(() => checkGlobalsIn(buildGuardFromType(state, diagnosticNode, type, file)));
			tables.push(constDecl(guard, expression));
			guards.set(type, guard);
		}

		return guard;
	}

	/** `Enum.X` items by `Value`, built once: values are not always below 256, so they are sent as u16. */
	function enumTableFor(name: string): ts.Identifier {
		let table = enumTables.get(name);
		if (!table) {
			const id = uid(`enum_${name}`);
			const item = uid("item");
			atFileLevel(() =>
				tables.push(
					constDecl(id, construct("Map", []), globalType("Map", [T.number(), T.enumItem()])),
					forOf(item, f.call(prop(prop(globalRef("Enum"), name), "GetEnumItems"), []), [
						f.statement(f.call(prop(id, "set"), [prop(item, "Value"), item])),
					]),
				),
			);
			table = id;
			enumTables.set(name, table);
		}

		return table;
	}

	/** A literal union's members as a list (decode) and as a lookup from member to index (encode). */
	function literalTablesFor(kind: Kind & { kind: "literals" }) {
		let entry = literalTables.get(kind);
		if (!entry) {
			entry = { list: uid("literals"), index: uid("literalIndex") };
			// The key type is spelled out: inferred from the pairs, TypeScript would pick the first literal's
			// type (`"lit"`, or one EnumItem interface) and reject the others.
			const { list, index } = entry;
			atFileLevel(() => {
				const values = kind.values.map(checkGlobalsIn);
				const pairs = values.map((value, position) => f.array([value, num(position)], false));
				tables.push(
					constDecl(list, f.array(values, false), T.blobs()),
					constDecl(
						index,
						construct("Map", [f.array(pairs)], [T.defined(), T.number()]),
						globalType("Map", [T.defined(), T.number()]),
					),
				);
			});
			literalTables.set(kind, entry);
		}

		return entry;
	}

	// --- varints -------------------------------------------------------------------------------------

	/**
	 * The LEB128 helpers, hoisted once per file: seven bits per byte, low bits first, the high bit set
	 * on every byte but the last. Reading gives up after five bytes, so a hostile buffer cannot loop.
	 */
	function varintHelpers(): Varint {
		if (varint) return varint;
		const helpers = { size: uid("vsize"), write: uid("vwrite"), read: uid("vread") };
		// Kept once they are built: helpers whose build failed (a global they name is hidden) are built
		// again, under new names, for the file's next value instead of being called undeclared.
		atFileLevel(() => buildVarintHelpers(helpers));
		varint = helpers;
		return helpers;
	}

	function buildVarintHelpers(varint: Varint) {
		const below = (value: ts.Expression, limit: number) => f.binary(value, ts.SyntaxKind.LessThanToken, num(limit));
		const parameter = (id: ts.Identifier, type: ts.TypeNode) => f.parameterDeclaration(id, type);

		// vsize: `n < 128 ? 1 : n < 16384 ? 2 : ... : 5`
		const sizeOf = uid("n");
		let size: ts.Expression = num(VARINT_MAX_BYTES);
		for (let bytes = VARINT_MAX_BYTES - 1; bytes >= 1; bytes--) {
			size = conditional(below(sizeOf, 128 ** bytes), num(bytes), size);
		}
		tables.push(constDecl(varint.size, f.arrowFunction(size, [parameter(sizeOf, T.number())])));

		// vwrite: continuation bytes while 128 or more remain, then the last byte; returns the new position.
		const wbuf = uid("buf");
		const wo = uid("o");
		const wn = uid("n");
		tables.push(
			constDecl(
				varint.write,
				f.arrowFunction(
					f.block([
						factory.createWhileStatement(
							f.binary(wn, ts.SyntaxKind.GreaterThanEqualsToken, num(128)),
							f.block([
								f.statement(
									bufferCall("writeu8", [
										wbuf,
										wo,
										f.binary(
											f.binary(wn, ts.SyntaxKind.PercentToken, num(128)),
											ts.SyntaxKind.PlusToken,
											num(128),
										),
									]),
								),
								addAssign(wo, num(1)),
								assign(
									wn,
									f.call(prop(globalRef("math"), "floor"), [
										f.binary(wn, ts.SyntaxKind.SlashToken, num(128)),
									]),
								),
							]),
						),
						f.statement(bufferCall("writeu8", [wbuf, wo, wn])),
						f.returnStatement(add(wo, 1)),
					]),
					[parameter(wbuf, T.buffer()), parameter(wo, T.number()), parameter(wn, T.number())],
				),
			),
		);

		// vread: `n += (b % 128) * scale` per byte until one is below 128; returns the value and position.
		const rbuf = uid("buf");
		const ro = uid("o");
		const rn = uid("n");
		const byte = uid("b");
		const scale = uid("scale");
		tables.push(
			constDecl(
				varint.read,
				f.arrowFunction(
					f.block([
						letDecl(rn, num(0)),
						letDecl(scale, num(1)),
						factory.createWhileStatement(
							f.bool(true),
							f.block([
								constDecl(byte, bufferCall("readu8", [rbuf, ro])),
								addAssign(ro, num(1)),
								addAssign(
									rn,
									f.binary(
										f.binary(byte, ts.SyntaxKind.PercentToken, num(128)),
										ts.SyntaxKind.AsteriskToken,
										scale,
									),
								),
								ifStatement(below(byte, 128), [f.returnStatement(tuple([rn, ro]))]),
								f.statement(f.binary(scale, ts.SyntaxKind.AsteriskEqualsToken, num(128))),
								ifStatement(
									f.binary(scale, ts.SyntaxKind.GreaterThanToken, num(128 ** (VARINT_MAX_BYTES - 1))),
									[raise(MALFORMED)],
								),
							]),
						),
					]),
					[parameter(rbuf, T.buffer()), parameter(ro, T.number())],
				),
			),
		);
	}

	/**
	 * Whether a number is one a branded width writes as it is: `n >= min and n <= max and n % 1 == 0`
	 * for an integer width or a varint, and for `f32` any number but a finite one past its range
	 * (`not (math.abs(n) > max and math.abs(n) < math.huge)`), since infinities and NaN survive.
	 */
	function fitsRange(n: ts.Expression, [minimum, maximum, whole]: [number, number, boolean]): ts.Expression {
		const and = (left: ts.Expression, right: ts.Expression) =>
			f.binary(left, ts.SyntaxKind.AmpersandAmpersandToken, right);
		if (!whole) {
			const magnitude = () => f.call(prop(globalRef("math"), "abs"), [n]);
			return factory.createPrefixUnaryExpression(
				ts.SyntaxKind.ExclamationToken,
				factory.createParenthesizedExpression(
					and(
						f.binary(magnitude(), ts.SyntaxKind.GreaterThanToken, num(maximum)),
						f.binary(magnitude(), ts.SyntaxKind.LessThanToken, prop(globalRef("math"), "huge")),
					),
				),
			);
		}

		const bound = (value: number) =>
			value < 0 ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, num(-value)) : num(value);
		return and(
			and(
				f.binary(n, ts.SyntaxKind.GreaterThanEqualsToken, bound(minimum)),
				f.binary(n, ts.SyntaxKind.LessThanEqualsToken, bound(maximum)),
			),
			equals(f.binary(n, ts.SyntaxKind.PercentToken, num(1)), num(0)),
		);
	}

	// --- width checks ---------------------------------------------------------------------------------

	/** A width as it is spelled in `Serialization`: `u16`, `varint`, `string8`, `buffer16`. */
	function widthName(kind: Kind): string {
		switch (kind.kind) {
			case "number":
				return kind.width;
			case "varint":
				return "varint";
			case "string":
				return kind.length === "u8" ? "string8" : kind.length === "u16" ? "string16" : "string32";
			case "buffer":
				return kind.length === "u16" ? "buffer16" : "buffer32";
			default:
				return kind.kind;
		}
	}

	/**
	 * The width to check a value of `kind` against where it is written, or `undefined` when there is
	 * nothing to check: the width holds every value (`f64`, `string32`, `buffer32`, a plain `number` or
	 * `string`), or the project does not check it (`category`), or the write is a union's fallback
	 * member, whose check has already run.
	 */
	function checkedWidth(kind: Kind, ctx?: Ctx): string | undefined {
		if (checks.category === "none" || ctx?.unchecked) return;

		let implicit: boolean | undefined;
		switch (kind.kind) {
			case "number":
				if (kind.width === "f64") return;
				implicit = kind.implicit;
				break;
			case "varint":
				implicit = kind.implicit;
				break;
			case "string":
			case "buffer":
				if (kind.length === "v" || kind.length === "u32") return;
				implicit = kind.implicit;
				break;
			default:
				return;
		}

		if (checks.category === "implicit" && implicit !== true) return;
		return widthName(kind);
	}

	/**
	 * The file's helper for a value that failed its check, defined once ahead of everything that calls
	 * it: `codec.checkWidth(width, value, where, unit?)`. It builds the message, `[Flamework] u16 cannot
	 * hold 70000, at Entity.id`, and then raises (`assert`) or warns and returns `true` (`warn`), so the
	 * value is written as it is. Under a `side` other than `both` it first asks the realm and returns
	 * `false` outside it, leaving the value to be written unchecked: only a value that failed pays for
	 * that question, and a module shared by both realms answers it where it runs. It is kept in the
	 * file's table of hoisted functions rather than a local of its own (see {@link hoistedTable}): a file
	 * that has the table pays no local for it.
	 */
	function checkHelper(): ts.Expression {
		const helper = prop(hoistedTable(), "checkWidth");
		// Flagged once it is built: a helper whose build failed (a global it names is hidden) is built
		// again for the file's next value instead of being called unbuilt.
		if (!checkFunction) {
			atFileLevel(() => buildCheckHelper());
			checkFunction = true;
		}
		noteCall("checkWidth", "a width check");

		const parameter = (name: string, type: ts.TypeNode, optional = false) =>
			f.parameterDeclaration(name, type, undefined, optional);
		return f.as(
			helper,
			f.functionType(
				[
					parameter("width", T.string()),
					parameter("value", T.number()),
					parameter("where", T.string()),
					parameter("unit", T.string(), true),
				],
				f.keywordType(ts.SyntaxKind.BooleanKeyword),
			),
		);
	}

	function buildCheckHelper() {
		const width = uid("width");
		const value = uid("value");
		const where = uid("where");
		const unit = uid("unit");
		const message = uid("message");

		const body = new Array<ts.Statement>();
		if (checks.side !== "both") {
			const runService = f.call(prop("game", "GetService"), [f.string("RunService")]);
			const inRealm = f.call(prop(runService, checks.side === "server" ? "IsServer" : "IsClient"), []);
			body.push(
				ifStatement(factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, inRealm), [
					f.returnStatement(f.bool(false)),
				]),
			);
		}

		const text = factory.createTemplateExpression(factory.createTemplateHead("[Flamework] "), [
			factory.createTemplateSpan(width, factory.createTemplateMiddle(" cannot hold ")),
			factory.createTemplateSpan(value, factory.createTemplateMiddle("")),
			factory.createTemplateSpan(unit, factory.createTemplateMiddle(", at ")),
			factory.createTemplateSpan(where, factory.createTemplateTail("")),
		]);
		body.push(constDecl(message, text));

		if (checks.mode === "assert") {
			// Level 2: the message points at the write that called this.
			body.push(f.statement(f.call(globalRef("error"), [message, num(2)])));
		} else {
			body.push(f.statement(f.call(globalRef("warn"), [message])), f.returnStatement(f.bool(true)));
		}

		tables.push(
			define(
				"checkWidth",
				f.arrowFunction(
					f.block(body),
					[
						f.parameterDeclaration(width, T.string()),
						f.parameterDeclaration(value, T.number()),
						f.parameterDeclaration(where, T.string()),
						f.parameterDeclaration(unit, T.string(), f.string("")),
					],
					undefined,
					f.keywordType(ts.SyntaxKind.BooleanKeyword),
				),
			),
		);
	}

	/** `codec.checkWidth("u16", n, <where>)`: the call a failed check makes; `unit` follows a length. */
	function callCheck(width: string, value: ts.Expression, ctx: Ctx, unit?: string): ts.Expression {
		const args = [f.string(width), value, whereOf(ctx)];
		if (unit !== undefined) args.push(f.string(unit));
		return f.call(checkHelper(), args);
	}

	/**
	 * Where a value is, as a check's message says it: a string known at build time (`'move' [0].x`,
	 * `value.id`), or, inside a hoisted `w_`, its `where` joined with the path after it (`where ..
	 * ".id"`), which only runs once a check has failed.
	 */
	function whereOf(ctx: Place): ts.Expression {
		if (ctx.where) {
			return ctx.path ? f.binary(ctx.where, ts.SyntaxKind.PlusToken, f.string(ctx.path)) : ctx.where;
		}

		const path = ctx.path === undefined || ctx.path === "" ? "value" : ctx.path;
		return f.string(ctx.site !== undefined ? `'${ctx.site}' ${path}` : path);
	}

	/**
	 * The `where` a call of another type's `w_` passes, known at build time. Inside a hoisted `w_` it
	 * starts from that type's name (`Entity.tags`) rather than from the caller's `where`, which would
	 * join two strings on every call.
	 */
	function passedWhere(ctx: Place): ts.Expression {
		if (ctx.owner !== undefined) return f.string(`${ctx.owner}${ctx.path ?? ""}`);
		return whereOf(ctx);
	}

	// --- type checks ---------------------------------------------------------------------------------

	/**
	 * The kind of a value whose type is tested in this pass, or `undefined`: type checks are off, the
	 * kind has no test (an optional, which takes nil and tests what else it holds; `undefined`; a blob
	 * that takes anything), a union's test found the value's kind already, the value is the argument
	 * list a call spread into a table, or the other pass reaches the value first. The size pass reads
	 * every value whose size varies to measure it (`#text`, `vsize(n)`, an object's fields) before
	 * anything is written, so that is where such a value is tested; one of a fixed size is only read
	 * by the writes.
	 */
	function typeCheckIn(shape: Shape, pass: "size" | "write", place: Place): Kind | undefined {
		if (!checks.types || place.tested || place.args) return;
		if ((layoutOf(shape).size !== undefined) !== (pass === "write")) return;
		const kind = describe(shape);
		return typeExpectation(kind) !== undefined ? kind : undefined;
	}

	/**
	 * What a value of `kind` has to be, as a type check's message says it, and whether the message shows
	 * a value that is not that as itself (`"c"`, `Enum.KeyCode.A`) rather than as its type: for a literal
	 * or an enum, whose wrong values are mostly of the right type. `undefined` for a kind with no test.
	 * A blob is tested only where `typeof` names its type (an Instance, an EnumItem, a Font); the other
	 * blobs take anything.
	 */
	function typeExpectation(kind: Kind): { expected: string; show?: boolean } | undefined {
		switch (kind.kind) {
			case "number":
			case "varint":
				return { expected: "number" };
			case "string":
			case "boolean":
			case "buffer":
				return { expected: kind.kind };
			case "datatype":
				return { expected: kind.name };
			case "cframe":
				return { expected: "CFrame" };
			case "enum":
				return { expected: `Enum.${kind.name}`, show: true };
			case "constant":
				return { expected: literalKey(kind.value), show: true };
			case "literals":
				return {
					expected: kind.values.map(literalKey).join(" | "),
					show: true,
				};
			case "blob":
				return kind.typeofName !== undefined ? { expected: kind.typeofName } : undefined;
			case "array":
			case "set":
			case "map":
			case "list":
			case "object":
				return { expected: "table" };
			case "union":
				return { expected: unionText(kind) };
			default:
				return undefined;
		}
	}

	/**
	 * Whether `typeof` names the values of a Roblox API type, so that a union's member test and a type
	 * check can test a blob of it: one of roblox-ts's `CheckableTypes` (an Instance, an EnumItem, a
	 * Font, a TweenInfo...), which is also what `typeIs` takes. Another type the API declares
	 * (`GroupInfo`, a struct some method returns) is a plain table no name can test, which `classify`
	 * makes a blob that takes anything, as a nominal type is. A project without `CheckableTypes`
	 * trusts the name.
	 */
	function isTypeofName(name: string): boolean {
		if (name === "Instance") return true;
		if (checkableTypes === undefined) {
			const symbol = resolve("CheckableTypes");
			checkableTypes = symbol ? typeChecker.getDeclaredTypeOfSymbol(symbol) : null;
		}

		return checkableTypes === null || checkableTypes.getProperty(name) !== undefined;
	}

	/** A union as a type check's message names it: its alias, or its members in the order written. */
	function unionText(union: UnionKind): string {
		if (union.type?.aliasSymbol) return typeChecker.typeToString(union.type);
		return union.alternatives.map((alternative) => alternativeName(alternative)).join(" | ");
	}

	/**
	 * The test a value of `kind` passes, which `value` may be handed to a macro in: never a parameter
	 * (see {@link emitTypeCheck}). Literals and unions have tests of their own, where they are written.
	 */
	function typeTest(kind: Kind, value: ts.Expression): ts.Expression {
		switch (kind.kind) {
			case "number":
			case "varint":
				return typeOfIs(value, "number");
			case "string":
			case "boolean":
			case "buffer":
				return typeOfIs(value, kind.kind);
			case "datatype":
				return typeOfIs(value, kind.name);
			case "cframe":
				return typeOfIs(value, "CFrame");
			case "enum":
				return enumTest(kind.name, value);
			case "constant":
				return equals(cast(value, T.unknown()), checkGlobalsIn(kind.value));
			case "blob":
				return typeOfIs(value, kind.typeofName!);
			default:
				return typeOfIs(value, "table");
		}
	}

	/** `typeof(v) == "EnumItem" and v.EnumType == Enum.<name>`. */
	function enumTest(name: string, value: ts.Expression): ts.Expression {
		return f.binary(
			typeOfIs(value, "EnumItem"),
			ts.SyntaxKind.AmpersandAmpersandToken,
			equals(prop(cast(value, T.enumItem()), "EnumType"), prop(globalRef("Enum"), name)),
		);
	}

	/** The negation of a test: `a ~= b` for a comparison, `not (...)` otherwise. */
	function failed(test: ts.Expression): ts.Expression {
		if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
			return f.binary(test.left, ts.SyntaxKind.ExclamationEqualsEqualsToken, test.right);
		}

		return factory.createPrefixUnaryExpression(
			ts.SyntaxKind.ExclamationToken,
			factory.createParenthesizedExpression(test),
		);
	}

	/** `codec.checkType(expected, value, <where>[, true])`: the call a failed type check makes. */
	function callTypeCheck(kind: Kind, value: ts.Expression, place: Place): ts.Expression {
		const { expected, show } = typeExpectation(kind)!;
		const args = [f.string(expected), value, whereOf(place)];
		if (show) args.push(f.bool(true));
		return f.call(typeCheckHelper(), args);
	}

	/** `if not <test> then codec.checkType(...) end`. */
	function typeCheckStatement(kind: Kind, value: ts.Expression, place: Place): ts.Statement {
		return ifStatement(failed(typeTest(kind, value)), [f.statement(callTypeCheck(kind, value, place))]);
	}

	/**
	 * Tests `value` ahead of the code that reads it. A literal is judged when building: one of the right
	 * kind needs no test, and one of another calls the helper as it is. A comparison (a lone literal's)
	 * reads the value as it is, and so does a macro (`typeIs`) a plain local; anything else roblox-ts
	 * reads into a temporary of its own for the macro, a parameter included (see {@link parameters}),
	 * which would be one more local of the function the code lands in (Luau allows 200). It is read into
	 * a local in a block of its own instead, with its test, as `writeNumber` reads a checked number.
	 */
	function emitTypeCheck(kind: Kind, value: ts.Expression, out: ts.Statement[], place: Place) {
		const literal = literalType(value);
		if (literal !== undefined) {
			if (!literalPasses(kind, value, literal)) out.push(f.statement(callTypeCheck(kind, value, place)));
			return;
		}

		if (kind.kind === "constant" || (f.is.identifier(value) && !isParameterReference(value))) {
			out.push(typeCheckStatement(kind, value, place));
			return;
		}

		const v = uid("v");
		if (typed.has(value)) typed.add(v);
		out.push(f.block([constDecl(v, value), typeCheckStatement(kind, v, place)]));
	}

	/**
	 * The field of a union's object member that the union's discriminant compared to the member's literal
	 * (`v.kind == "circle"`), which the member's write then does not test again.
	 */
	function discriminantField(union: UnionKind, index: number): string | undefined {
		const kind = describe(union.alternatives[index].shape);
		if (kind.kind !== "object" || evaluation(union).tableOnly === index) return;
		const key = objectKey(union, kind);
		return key?.value !== undefined ? key.name : undefined;
	}

	/** What `type` says about a literal expression (`7`, `-1`, `"a"`, `true`, `undefined`), if it is one. */
	function literalType(expression: ts.Expression): string | undefined {
		if (literalNumber(expression) !== undefined) return "number";
		if (f.is.string(expression)) return "string";
		if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
			return "boolean";
		}
		if (isNilLiteral(expression)) return "nil";
	}

	function literalPasses(kind: Kind, value: ts.Expression, type: string): boolean {
		if (kind.kind === "constant") return type !== "nil" && printLiteral(value) === printLiteral(kind.value);
		return (
			type === primitiveType(kind) &&
			(kind.kind === "number" || kind.kind === "varint" || kind.kind === "string" || kind.kind === "boolean")
		);
	}

	/**
	 * Under type checks, a union whose members are all tables and that tells one of them by a key
	 * (`v.kind == "a"`, with no test that the value is a table first) tests that once, ahead of its
	 * members: reading a key of a number or a boolean raises before the union could say what it wanted.
	 */
	function tablePrecheck(union: UnionKind, value: ts.Expression, out: ts.Statement[], place: Place) {
		if (!union.alternatives.every((alternative) => TABLE_KINDS.has(describe(alternative.shape).kind))) return;

		const { tableOnly } = evaluation(union);
		const keyed = union.alternatives.some((alternative, index) => {
			const kind = describe(alternative.shape);
			return kind.kind === "object" && index !== tableOnly && objectKey(union, kind) !== undefined;
		});
		if (!keyed) return;

		out.push(ifStatement(failed(typeOfIs(value, "table")), [f.statement(callTypeCheck(union, value, place))]));
	}

	/**
	 * The file's helper for a value of the wrong type, defined once like `checkWidth`:
	 * `codec.checkType(expected, value, where, show?)`. It builds the message, `[Flamework] number
	 * expected, got string, at 'move' [0].pos.x` (with `show`, the value itself: `got "c"`), and raises:
	 * a value of the wrong type cannot be written, so `warn` raises too, but for a boolean (`expected`
	 * is `"boolean"`), which it warns about and lets through to be written as whether it is truthy.
	 * Under a `side` other than `both` it first asks the realm and returns `false` outside it, leaving
	 * the value to be written unchecked, as with the type checks off.
	 */
	function typeCheckHelper(): ts.Expression {
		const helper = prop(hoistedTable(), "checkType");
		// Flagged once it is built, as `checkWidth` is.
		if (!typeCheckFunction) {
			atFileLevel(() => buildTypeCheckHelper());
			typeCheckFunction = true;
		}
		noteCall("checkType", "a type check");

		const parameter = (name: string, type: ts.TypeNode, optional = false) =>
			f.parameterDeclaration(name, type, undefined, optional);
		return f.as(
			helper,
			f.functionType(
				[
					parameter("expected", T.string()),
					parameter("value", T.unknown()),
					parameter("where", T.string()),
					parameter("show", f.keywordType(ts.SyntaxKind.BooleanKeyword), true),
				],
				f.keywordType(ts.SyntaxKind.BooleanKeyword),
			),
		);
	}

	function buildTypeCheckHelper() {
		const expected = uid("expected");
		const value = uid("value");
		const where = uid("where");
		const show = uid("show");
		const got = uid("got");
		const message = uid("message");

		const body = new Array<ts.Statement>();
		if (checks.side !== "both") {
			const runService = f.call(prop("game", "GetService"), [f.string("RunService")]);
			const inRealm = f.call(prop(runService, checks.side === "server" ? "IsServer" : "IsClient"), []);
			body.push(
				ifStatement(factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, inRealm), [
					f.returnStatement(f.bool(false)),
				]),
			);
		}

		// What came: its type, or with `show`, a string, number, boolean or EnumItem as itself.
		const is = (name: string) => equals(got, f.string(name));
		const or = (left: ts.Expression, right: ts.Expression) => f.binary(left, ts.SyntaxKind.BarBarToken, right);
		body.push(letDecl(got, f.call(globalRef("typeOf"), [value]), T.string()));
		body.push(
			ifStatement(show, [
				ifStatement(
					is("string"),
					[assign(got, interpolate(['"', value, '"']))],
					ifStatement(or(or(is("number"), is("boolean")), is("EnumItem")), [
						assign(got, interpolate(["", value])),
					]),
				),
			]),
		);

		body.push(constDecl(message, interpolate(["[Flamework] ", expected, " expected, got ", got, ", at ", where])));

		if (checks.mode === "warn") {
			body.push(
				ifStatement(equals(expected, f.string("boolean")), [
					f.statement(f.call(globalRef("warn"), [message])),
					f.returnStatement(f.bool(true)),
				]),
			);
		}

		// Level 2: the message points at the write that called this.
		body.push(f.statement(f.call(globalRef("error"), [message, num(2)])));

		tables.push(
			define(
				"checkType",
				f.arrowFunction(
					f.block(body),
					[
						f.parameterDeclaration(expected, T.string()),
						f.parameterDeclaration(value, T.unknown()),
						f.parameterDeclaration(where, T.string()),
						f.parameterDeclaration(show, f.keywordType(ts.SyntaxKind.BooleanKeyword), undefined, true),
					],
					undefined,
					f.keywordType(ts.SyntaxKind.BooleanKeyword),
				),
			),
		);
	}

	/**
	 * Whether some value of a shape can fail one of the width checks this project generates in the shape's
	 * own code: not in a named type inside it, which is always hoisted and checks its values in its own
	 * `w_`, and not in a union's member with a range, which only takes a number its test found in range.
	 */
	function hasChecks(root: Shape): boolean {
		const seen = new Set<Shape>();
		const walk = (shape: Shape): boolean => {
			if (seen.has(shape)) return false;
			seen.add(shape);
			if (shape !== root && !isKind(shape) && alwaysHoisted(shape)) return false;

			const kind = describe(shape);
			switch (kind.kind) {
				case "number":
				case "varint":
				case "string":
				case "buffer":
					return checkedWidth(kind) !== undefined;
				case "optional":
					return walk(kind.inner);
				case "array":
				case "set":
					return walk(kind.element);
				case "map":
					return walk(kind.key) || walk(kind.value);
				case "list":
					return (
						kind.elements.some(walk) ||
						(kind.rest !== undefined && walk(kind.rest)) ||
						(kind.after ?? []).some(walk)
					);
				case "object":
					return kind.fields.some((field) => walk(field.shape));
				case "union":
					// A number no member takes is checked by the union's fallback (see `numericFallback`).
					return (
						numericFallback(kind) !== undefined ||
						kind.alternatives.some(
							(alternative) =>
								numberRange(describe(alternative.shape)) === undefined && walk(alternative.shape),
						)
					);
				default:
					return false;
			}
		};

		return walk(root) || hasTypeChecks(root, "write");
	}

	/**
	 * Whether a shape's own code tests the type of some value in the pass named (see {@link typeCheckIn}):
	 * not inside a named type, which is always hoisted and tests in its own functions, and not a union
	 * member's own kind, which the union's test found, though the values inside the member are tested.
	 */
	function hasTypeChecks(root: Shape, pass: "size" | "write"): boolean {
		if (!checks.types) return false;

		const seen = new Set<Shape>();
		const seenTested = new Set<Shape>();
		const walk = (shape: Shape, tested: boolean): boolean => {
			const visited = tested ? seenTested : seen;
			if (visited.has(shape)) return false;
			visited.add(shape);
			if (shape !== root && !isKind(shape) && alwaysHoisted(shape)) return false;

			const kind = describe(shape);
			if (!tested && typeExpectation(kind) !== undefined) {
				const fixed = layoutOf(shape).size !== undefined;
				if (fixed === (pass === "write")) return true;
			}

			switch (kind.kind) {
				case "optional":
					return walk(kind.inner, tested);
				case "array":
				case "set":
					return walk(kind.element, false);
				case "map":
					return walk(kind.key, false) || walk(kind.value, false);
				case "list":
					return (
						kind.elements.some((element) => walk(element, false)) ||
						(kind.rest !== undefined && walk(kind.rest, false)) ||
						(kind.after ?? []).some((element) => walk(element, false))
					);
				case "object":
					return kind.fields.some((field) => walk(field.shape, false));
				case "union":
					return kind.alternatives.some((alternative) => walk(alternative.shape, true));
				default:
					return false;
			}
		};

		return walk(root, false);
	}

	/** A variable-size named object, union or tuple, which {@link hoist} always hoists wherever it is reached. */
	function alwaysHoisted(type: ts.Type): boolean {
		if (hoisted.has(type)) return true;
		if (!canHoist(type) || hoistName(type) === undefined) return false;
		const structure = describe(type).kind;
		return structure !== "array" && structure !== "set" && structure !== "map";
	}

	/** A place one step further into the value: a field (`.pos`), an element (`[]`), or a new root. */
	function within<P extends Place>(place: P, segment: string, root = false): P {
		return {
			...place,
			path: root ? segment : `${place.path ?? ""}${segment}`,
			args: undefined,
			tested: undefined,
			compared: undefined,
		};
	}

	/**
	 * Where a check's path starts in `Flamework.createSerializer<T>()`: the name of a named object,
	 * union or tuple type (`Entity.id`), else `value` (`value[0]`, or `value` itself for a width).
	 */
	function rootPath(shape: Shape): string {
		if (isKind(shape) || hoistName(shape) === undefined) return "value";
		const structure = describe(shape).kind;
		return structure === "object" || structure === "union" || structure === "list" ? displayName(shape) : "value";
	}

	/**
	 * A type as a check's path starts from it inside its hoisted functions, which every place that
	 * reaches the type shares: its name (`Entity`, `Patch<Tree>`), parenthesized when TypeScript
	 * prints it as more than a name (`(u16[])`), so the segments after it read as its own.
	 */
	function displayName(type: ts.Type): string {
		const text = typeChecker.typeToString(type);
		return /^[\w$.]+(<.*>)?$/.test(text) ? text : `(${text})`;
	}

	/**
	 * Writes a number with `write`, checked first when its width is: `if not (<fits>) then checkWidth(...)
	 * end`. A value that is more than a name is read once, into a local, and that local, the check and
	 * the write go in a block of their own (`do ... end`): Luau allows 200 locals in a function, and a
	 * function that writes many checked values holds no more of them than it would unchecked. A literal is
	 * judged here: one that fits needs no check at all, one that does not calls the check as it is.
	 */
	function writeNumber(kind: Kind, value: ts.Expression, ctx: Ctx, write: (n: ts.Expression, ctx: Ctx) => void) {
		const width = checkedWidth(kind, ctx);
		const range = numberRange(kind);
		// A type check (`checks.types`) goes first: a string must not reach the range's comparisons.
		const typed = typeCheckIn(kind, "write", ctx) !== undefined;
		const ranged = width !== undefined && range !== undefined;
		if (!ranged && !typed) return write(value, ctx);

		const known = literalNumber(value);
		if (known !== undefined) {
			// A number literal is of the right type as it is built.
			if (ranged && !fitsStatically(known, range)) ctx.out.push(f.statement(callCheck(width, value, ctx)));
			return write(value, ctx);
		}

		const block: Ctx = { ...ctx, out: [] };
		// `typeIs` would copy a parameter again (see `emitTypeCheck`), so the test reads a copy.
		const n =
			f.is.identifier(value) && !(typed && isParameterReference(value)) ? value : bind(block.out, value, "n");
		const target = block.out.length > 0 ? block : ctx;
		if (typed) target.out.push(typeCheckStatement(kind, n, ctx));
		if (ranged) {
			target.out.push(
				ifStatement(failsRange(cast(n, T.number()), range), [
					f.statement(callCheck(width, cast(n, T.number()), ctx)),
				]),
			);
		}
		write(n, target);
		if (target === block) ctx.out.push(f.block(block.out));
	}

	/**
	 * Writes a boolean with `write`, tested first under type checks: read once, into a local in a block
	 * of its own with its test and its write, as {@link writeNumber} reads a checked number.
	 */
	function writeTyped(kind: Kind, value: ts.Expression, ctx: Ctx, write: (v: ts.Expression, ctx: Ctx) => void) {
		const block: Ctx = { ...ctx, out: [] };
		const v = f.is.identifier(value) && !isParameterReference(value) ? value : bind(block.out, value, "v");
		const target = block.out.length > 0 ? block : ctx;
		target.out.push(typeCheckStatement(kind, v, ctx));
		write(v, target);
		if (target === block) ctx.out.push(f.block(block.out));
	}

	/** The negation of {@link fitsRange}, without a double negation for `f32`. */
	function failsRange(n: ts.Expression, range: [number, number, boolean]): ts.Expression {
		const fits = fitsRange(n, range);
		if (
			ts.isPrefixUnaryExpression(fits) &&
			fits.operator === ts.SyntaxKind.ExclamationToken &&
			ts.isParenthesizedExpression(fits.operand)
		) {
			return fits.operand.expression;
		}

		return factory.createPrefixUnaryExpression(
			ts.SyntaxKind.ExclamationToken,
			factory.createParenthesizedExpression(fits),
		);
	}

	/** A number literal's value (`7`, `-1`), or `undefined` for anything else. */
	function literalNumber(expression: ts.Expression): number | undefined {
		if (f.is.number(expression)) return Number(expression.text);
		if (
			ts.isPrefixUnaryExpression(expression) &&
			expression.operator === ts.SyntaxKind.MinusToken &&
			f.is.number(expression.operand)
		) {
			return -Number(expression.operand.text);
		}
	}

	/** What {@link fitsRange} says about a number known at compile time. */
	function fitsStatically(n: number, [minimum, maximum, whole]: [number, number, boolean]): boolean {
		if (!whole) return !(Math.abs(n) > maximum && Math.abs(n) < Infinity);
		return n >= minimum && n <= maximum && n % 1 === 0;
	}

	/**
	 * The member a number that fits none of a union's members is written as, once its check has let it
	 * through (`warn`): the first checked member with a range, in written order. `widths` names every
	 * member with a range, for the message. None when a member takes every number anyway (a plain
	 * `number` or `f64`, or a blob that takes anything), or when no member with a range is checked;
	 * such a number then raises "value matches none of the union's members", as it always has.
	 */
	function numericFallback(union: UnionKind, ctx?: Ctx): { index: number; widths: string } | undefined {
		if (union.whole !== undefined) return;

		const widths = new Array<string>();
		for (const alternative of union.alternatives) {
			const kind = describe(alternative.shape);
			// A strict width and its implicit twin are one width to the message.
			if (numberRange(kind) !== undefined && !widths.includes(widthName(kind))) widths.push(widthName(kind));
		}

		let index: number | undefined;
		for (const i of evaluation(union).order) {
			const kind = describe(union.alternatives[i].shape);
			if (kind.kind === "number" && kind.width === "f64") return;
			if (kind.kind === "blob" && kind.typeofName === undefined) return;
			if (index === undefined && numberRange(kind) !== undefined && checkedWidth(kind, ctx) !== undefined) {
				index = i;
			}
		}

		return index !== undefined ? { index, widths: widths.join(" | ") } : undefined;
	}

	/**
	 * Whether a number is whole and a varint holds it: `n < 2^35 and 1 / n > 0 and n % 1 == 0`.
	 * `1 / n > 0` rules out negatives, NaN and -0, which a varint would read back as 0.
	 */
	function isWhole(n: ts.Expression): ts.Expression {
		const and = (left: ts.Expression, right: ts.Expression) =>
			f.binary(left, ts.SyntaxKind.AmpersandAmpersandToken, right);
		return and(
			and(
				f.binary(n, ts.SyntaxKind.LessThanToken, num(VARINT_LIMIT)),
				f.binary(f.binary(num(1), ts.SyntaxKind.SlashToken, n), ts.SyntaxKind.GreaterThanToken, num(0)),
			),
			equals(f.binary(n, ts.SyntaxKind.PercentToken, num(1)), num(0)),
		);
	}

	/** `o = vwrite(buf, o, n)`: the cursor re-bases on the position variable. */
	function writeVarint(ctx: Ctx, n: ts.Expression) {
		const variable = ctx.cursor.variable;
		if (!variable) throw new Error("Flamework: a varint inside a fixed layout");

		ctx.out.push(assign(variable, f.call(varintHelpers().write, [ctx.buf, at(ctx), n])));
		ctx.cursor.base = variable;
		ctx.cursor.offset = 0;
	}

	/** `const [n, o2] = vread(buf, o)`: the cursor re-bases on the position that came back. */
	function readVarint(ctx: Ctx, hint = "n"): ts.Identifier {
		if (!ctx.cursor.variable) throw new Error("Flamework: a varint inside a fixed layout");

		const n = uid(hint);
		const next = uid("o");
		ctx.out.push(constDecl(f.arrayBindingDeclaration([n, next]), f.call(varintHelpers().read, [ctx.buf, at(ctx)])));
		ctx.cursor.base = next;
		ctx.cursor.offset = 0;
		return n;
	}

	/** `<prefix> + length`: a constant prefix for a branded width, `vsize(length)` otherwise. */
	function sizeWithLength(out: ts.Statement[], width: LengthWidth, length: ts.Expression): ts.Expression {
		if (width !== "v") return add(length, WIDTH_SIZE[width]);

		const bound = bind(out, length, "length");
		return add(f.call(varintHelpers().size, [bound]), bound);
	}

	/** `vsize(n) + n * size` for a run of `n` fixed-size elements. */
	function countedSize(prefix: ts.Expression, count: ts.Expression, size: number): ts.Expression {
		if (size === 0) return prefix;
		return add(prefix, f.binary(count, ts.SyntaxKind.AsteriskToken, num(size)));
	}

	/**
	 * Sets and maps have no cheap length, so the elements are counted in the pass that measures them:
	 * `let size = 0, n = 0; for (...) { n += 1; size += <element>; } size += vsize(n)`.
	 */
	function countedInPass(
		out: ts.Statement[],
		collection: ts.Expression,
		binding: ts.BindingName,
		element: (body: ts.Statement[]) => ts.Expression,
	): ts.Identifier {
		const total = uid("size");
		const count = uid("n");
		out.push(letDecl(total, num(0)), letDecl(count, num(0)));
		const body = new Array<ts.Statement>();
		body.push(addAssign(count, num(1)));
		body.push(addAssign(total, element(body)));
		out.push(forOf(binding, collection, body));
		out.push(addAssign(total, f.call(varintHelpers().size, [count])));
		return total;
	}

	// --- unions --------------------------------------------------------------------------------------

	/**
	 * The order the members are tested in when a value is written; the tag written is still the
	 * member's own index.
	 * - Members with an exact test come first, in written order: they only take their own values.
	 * - Members checked by a guard come next. A guard ignores the keys an object does not declare,
	 *   at any depth, so one member's guard can take another member's values and write them without
	 *   those keys; {@link fit} works out through the nested shapes which member would do that to
	 *   which. A member that would goes after the member whose values it would take, unless that
	 *   member would do the same to it. Otherwise the written order stands, with objects whose fields
	 *   are all optional after the others. Where a loss remains, the build warns.
	 * - A blob that takes anything comes last.
	 * `Partial<Crate> | None` therefore sends a `None` as `None` in either written order: `None` has a
	 * test of its own, and the patch, the only member left, is only checked to be a table.
	 */
	function evaluation(union: UnionKind): Evaluation {
		let entry = evaluations.get(union);
		if (entry) return entry;

		const indices = union.alternatives.map((_, index) => index);
		const tests = indices.map((index) => testOf(union, index));
		const shapeAt = (index: number) => union.alternatives[index].shape;
		const takes = (a: number, b: number) => fit(shapeAt(a), shapeAt(b)) === "lossy";

		const guarded = [
			...indices.filter((index) => tests[index] === "guard"),
			...indices.filter((index) => tests[index] === "partial"),
		];
		const remaining = [...guarded];
		const ordered = new Array<number>();
		while (remaining.length > 0) {
			const loses = (a: number) => remaining.some((b) => b !== a && takes(a, b) && !takes(b, a));
			const next = remaining.find((a) => !loses(a)) ?? remaining[0];
			ordered.push(next);
			remaining.splice(remaining.indexOf(next), 1);
		}

		const order = [
			...indices.filter((index) => tests[index] === "exact"),
			...ordered,
			...indices.filter((index) => tests[index] === "anything"),
		];

		const last = order[order.length - 1];
		const loose = tests[last] === "guard" || tests[last] === "partial";
		const tableOnly = loose && TABLE_KINDS.has(describe(shapeAt(last)).kind) ? last : undefined;

		entry = { order, tableOnly };
		evaluations.set(union, entry);

		// A member ahead of another that it would still take values from and write without part of them.
		const involved = new Set<number>();
		ordered.forEach((earlier, position) => {
			for (const later of ordered.slice(position + 1)) {
				if (takes(earlier, later)) {
					involved.add(earlier);
					involved.add(later);
				}
			}
		});
		if (involved.size > 0) {
			warnIndistinct(
				union,
				ordered.filter((index) => involved.has(index)),
			);
		}

		return entry;
	}

	function testOf(union: UnionKind, index: number): Test {
		const kind = describe(union.alternatives[index].shape);
		switch (kind.kind) {
			case "blob":
				return kind.typeofName === undefined ? "anything" : "exact";
			case "object":
				if (objectKey(union, kind)) return "exact";
				return kind.fields.some((field) => isRequired(field.shape)) ? "guard" : "partial";
			case "array":
			case "set":
			case "map":
			case "list":
			case "optional":
			case "union":
				return "guard";
			default:
				return "exact";
		}
	}

	function isRequired(shape: Shape): boolean {
		const kind = describe(shape).kind;
		return kind !== "optional" && kind !== "nothing";
	}

	/**
	 * The field that tells an object member of a union apart without a guard: the union's
	 * discriminant, compared (`v.kind == "a"`), or else a required field no other object member
	 * declares, whose presence is enough (`v.Coins ~= nil`).
	 */
	function objectKey(
		union: UnionKind,
		kind: ObjectKind,
	): { name: string; key: TableKey; value?: ts.Expression } | undefined {
		const discriminant = discriminantOf(union);
		const field = discriminant !== undefined ? kind.fields.find((field) => field.name === discriminant) : undefined;
		if (field) {
			const constant = describe(field.shape) as Extract<Kind, { kind: "constant" }>;
			return { name: field.name, key: field.key, value: constant.value };
		}

		// A collection among the members could hold any key, so presence is only trusted when the
		// other members are objects or not tables at all.
		const others = union.alternatives.map((other) => describe(other.shape)).filter((other) => other !== kind);
		if (others.some((other) => TABLE_KINDS.has(other.kind) && other.kind !== "object")) return;

		const unique = kind.fields.find(
			(candidate) =>
				isRequired(candidate.shape) &&
				others.every(
					(other) => other.kind !== "object" || !other.fields.some((field) => field.name === candidate.name),
				),
		);
		if (unique) return { name: unique.name, key: unique.key };
	}

	/**
	 * Warns, once per union in a file and where it is first written, about members that a value cannot
	 * tell apart: one tried earlier whose guard takes some of a later one's values and writes them
	 * without part of them. Telling such members apart at runtime would mean matching every key of the
	 * value against each of them, so the build says so instead.
	 */
	function warnIndistinct(union: UnionKind, members: number[]) {
		const key = union.type ?? union;
		if (warnedUnions.has(key)) return;
		warnedUnions.add(key);

		const name = (index: number) => `'${alternativeName(union.alternatives[index])}'`;
		const written = union.type?.aliasSymbol
			? typeChecker.typeToString(union.type)
			: union.alternatives.map((alternative) => alternativeName(alternative)).join(" | ");
		warn(
			`the union '${written}' has members a value cannot tell apart: ${members.map(name).join(", ")}. ` +
				`A value that fits more than one is written as the first of them in this order, without the parts only the others declare`,
		);
	}

	/** A member as TypeScript prints it, or its literals. */
	function alternativeName(alternative: Alternative): string {
		if (alternative.type) return typeChecker.typeToString(alternative.type);
		const kind = describe(alternative.shape);
		if (kind.kind === "constant") return literalKey(kind.value);
		if (kind.kind === "literals") return kind.values.map(literalKey).join(" | ");
		if (kind.kind === "enum") return `Enum.${kind.name}`;
		return kind.kind;
	}

	/**
	 * A literal group's values in the order they are numbered on the wire. First `false`, `true`, `""`
	 * and `0`, in that order, then the names `typeof` returns, in {@link TYPEOF_NAMES}' order (in
	 * `"number" | "string"`, `"string"` is 0). Then the other plain values, sorted: numbers by size,
	 * each before its negative (`1`, `-1`, `2`), then strings by their text in code units. Then a
	 * TypeScript enum's members as the enum declares them, a whole enum or some of its members alike;
	 * the members of several enums go by the enum's name inside its namespaces (never a file's), then
	 * as declared. Then Roblox enum items by name (`Enum.Material.Plastic`). `origins` says which values
	 * are a TypeScript enum's members (see `enumMemberOrigins`), since a member is a plain string or
	 * number by the time it is a value here.
	 *
	 * TypeScript lists a union's literals by internal type id, which follows whichever literal the
	 * checker happened to create first in a compilation, so the same union could be numbered one way
	 * in a sender and another way in its receiver after a partial rebuild. Some orders were already
	 * fixed, and keep the layout 2.0.0-alpha.7 gave them (see {@link valueRank}): the values the checker
	 * creates when it starts came first, a number came before its negative, and TypeScript creates an
	 * enum's members together, in declaration order, so the ids put them in that order. `simplifyUnion`
	 * adds the Roblox enum items after every other value.
	 */
	function sortLiterals(
		values: ts.Expression[],
		origins: ReadonlyArray<EnumMemberOrigin | undefined>,
	): ts.Expression[] {
		const rank = (value: ts.Expression, origin: EnumMemberOrigin | undefined): LiteralRank => {
			if (origin) return [3, qualifiedName(origin.enum), origin.index];
			if (value.kind === ts.SyntaxKind.FalseKeyword) return valueRank(false);
			if (value.kind === ts.SyntaxKind.TrueKeyword) return valueRank(true);
			const number = literalNumber(value);
			if (number !== undefined) return valueRank(number);
			if (f.is.string(value)) return valueRank(value.text);
			return [4, literalKey(value), 0];
		};
		const compare = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);

		// Two enums of one name from two files whose members share an index are put in order by value,
		// which is still the types' alone; equal values are the same entry either way.
		return values
			.map((value, i) => ({ value, rank: rank(value, origins[i]), text: literalKey(value) }))
			.sort(
				(a, b) =>
					a.rank[0] - b.rank[0] ||
					compare(a.rank[1], b.rank[1]) ||
					a.rank[2] - b.rank[2] ||
					compare(a.text, b.text),
			)
			.map(({ value }) => value);
	}

	/**
	 * Where a plain literal value goes among a literal group's values ({@link sortLiterals}) and a
	 * mapped type's keys ({@link keyRank}), keeping the orders 2.0.0-alpha.7's type ids already fixed.
	 * `false`, `true`, `""` and `0` come first, in that order, then the names `typeof` returns, in
	 * {@link TYPEOF_NAMES}' order (`"string"`, `"number"`, ...): the checker creates them when it starts,
	 * ahead of every literal a program writes (see {@link startupRank}). Then the other numbers, by
	 * size, each before its negative: the checker gets `-1` by checking `1` first
	 * (`checkPrefixUnaryExpression`, the same in TypeScript 5.5.3 and 5.9.3). Then the strings, by code
	 * units. The order of two values of different size or of two strings followed the ids alone.
	 */
	function valueRank(value: boolean | number | string): LiteralRank {
		if (value === false) return [0, 0, 0];
		if (value === true) return [0, 1, 0];
		if (value === "") return [0, 2, 0];
		if (value === 0) return [0, 3, 0];
		const typeofName = typeof value === "string" ? TYPEOF_NAMES.indexOf(value) : -1;
		if (typeofName >= 0) return [0, 4 + typeofName, 0];
		if (typeof value === "number") return [1, Math.abs(value), value < 0 ? 1 : 0];
		return [2, value, 0];
	}

	/**
	 * A literal as text, telling enum items apart too (`Enum.KeyCode.A`): `getLiteral` builds an item as
	 * `Enum["KeyCode"]["A"]`, which would otherwise print as its syntax kind, the same for every item.
	 */
	function literalKey(expression: ts.Expression): string {
		if (ts.isPropertyAccessExpression(expression))
			return `${literalKey(expression.expression)}.${expression.name.text}`;
		if (ts.isElementAccessExpression(expression) && f.is.string(expression.argumentExpression))
			return `${literalKey(expression.expression)}.${expression.argumentExpression.text}`;
		if (ts.isIdentifier(expression)) return expression.text;
		return printLiteral(expression);
	}

	/**
	 * What the guard and the writer of `a` do with the values of `b`, taken as the types say: no value
	 * of `b` passes `a`'s guard, every one that passes is written whole, or some value that passes
	 * is written without part of it. It follows the guard: an object's checks only the fields it
	 * declares, at every depth, a collection's every key and value, a union's any of its members.
	 * Recursive types are assumed to fit where they meet themselves again.
	 */
	function fit(a: Shape, b: Shape): Fit {
		if (a === b) return "whole";
		const left = describe(a);
		const right = describe(b);
		if (left === right) return "whole";

		let row = fits.get(left);
		if (!row) fits.set(left, (row = new Map()));
		const known = row.get(right);
		if (known !== undefined) return known;

		row.set(right, "whole");
		const result = computeFit(left, right);
		row.set(right, result);
		return result;
	}

	function computeFit(a: Kind, b: Kind): Fit {
		// A nil of `b` passes an optional `a` whole; `a`'s guard sees the rest as they are.
		if (b.kind === "optional") {
			const present = fit(a, b.inner);
			return a.kind === "optional" || a.kind === "nothing" ? worse(present, "whole") : present;
		}
		if (b.kind === "nothing") return a.kind === "optional" || a.kind === "nothing" ? "whole" : "none";
		if (a.kind === "optional") return fit(a.inner, b);

		// Any member of `b` may be the value. `a` a union: the value goes to one of its members;
		// the worst any of them does is what can happen.
		if (b.kind === "union") {
			return b.alternatives.reduce<Fit>(
				(result, alternative) => worse(result, fit(a, alternative.shape)),
				"none",
			);
		}
		if (a.kind === "union") {
			return a.alternatives.reduce<Fit>(
				(result, alternative) => worse(result, fit(alternative.shape, b)),
				"none",
			);
		}

		// A blob keeps the value itself; a value that could be anything could carry more than a table
		// type writes.
		if (a.kind === "blob") return a.typeofName === undefined || b.kind === "blob" ? "whole" : "none";
		if (b.kind === "blob") return TABLE_KINDS.has(a.kind) ? "lossy" : "whole";

		const primitive = primitiveFit(a, b);
		if (primitive !== undefined) return primitive;

		// Tables. A set is a map from its elements to `true`.
		const asMap = (kind: Kind): Extract<Kind, { kind: "map" }> | undefined =>
			kind.kind === "map"
				? kind
				: kind.kind === "set"
					? { kind: "map", key: kind.element, value: TRUE }
					: undefined;
		const mapA = asMap(a);
		const mapB = asMap(b);

		if (a.kind === "object") {
			if (b.kind === "object") return objectFit(a, b);
			if (mapB) {
				// A map value holds any of its keys, so it can always hold one the object does not declare.
				for (const field of a.fields) {
					if (!isRequired(field.shape)) continue;
					if (!keyFits(mapB.key, field.key) || fit(field.shape, mapB.value) === "none") return "none";
				}
				return "lossy";
			}
			// An array or tuple has no named keys: only an object that requires none takes it, empty.
			return a.fields.some((field) => isRequired(field.shape)) ? "none" : "lossy";
		}

		if (mapA) {
			if (b.kind === "object") {
				let result: Fit = "whole";
				for (const field of b.fields) {
					const value = keyFits(mapA.key, field.key) ? fit(mapA.value, field.shape) : "none";
					if (value === "none") {
						if (isRequired(field.shape)) return "none";
						continue;
					}
					result = worse(result, value);
				}
				return result;
			}
			if (mapB) return atLeastEmpty(worst([fit(mapA.key, mapB.key), fit(mapA.value, mapB.value)]));
			if (b.kind === "array") {
				return keyFits(mapA.key, 1) ? atLeastEmpty(fit(mapA.value, b.element)) : "whole";
			}
			if (b.kind === "list") return keyFits(mapA.key, 1) ? listInto(b, () => mapA.value) : "none";
			return "none";
		}

		if (a.kind === "array") {
			if (b.kind === "array") return atLeastEmpty(fit(a.element, b.element));
			if (b.kind === "list") return listInto(b, () => a.element);
			if (mapB) return keyFits(mapB.key, 1) ? atLeastEmpty(fit(a.element, mapB.value)) : "whole";
			if (b.kind === "object") return b.fields.some((field) => isRequired(field.shape)) ? "none" : "whole";
			return "none";
		}

		if (a.kind === "list") {
			const afterA = a.after ?? [];
			if (b.kind === "list") {
				const afterB = b.after ?? [];
				if (
					b.elements.length !== a.elements.length ||
					(a.rest === undefined) !== (b.rest === undefined) ||
					afterB.length !== afterA.length
				) {
					return "none";
				}
				const elements = a.elements.map((element, index) => fit(element, b.elements[index]));
				if (a.rest && b.rest) elements.push(atLeastEmpty(fit(a.rest, b.rest)));
				elements.push(...afterA.map((element, index) => fit(element, afterB[index])));
				return elements.includes("none") ? "none" : worst(elements);
			}
			if (b.kind === "array") {
				const elements = [...a.elements, ...afterA].map((element) => fit(element, b.element));
				return elements.includes("none") ? "none" : worst(elements);
			}
			return "none";
		}

		return "none";
	}

	/** An object's guard over another object's values: its fields, and the fields only the other has. */
	function objectFit(a: ObjectKind, b: ObjectKind): Fit {
		let result: Fit = "whole";
		for (const field of a.fields) {
			const other = b.fields.find((candidate) => candidate.name === field.name);
			if (!other) {
				if (isRequired(field.shape)) return "none";
				continue;
			}

			const value = fit(field.shape, other.shape);
			if (value === "none") return "none";
			result = worse(result, value);
		}

		// A field only `b` declares is dropped, whenever a value carries it.
		for (const field of b.fields) {
			if (describe(field.shape).kind === "nothing") continue;
			if (!a.fields.some((candidate) => candidate.name === field.name)) return "lossy";
		}

		return result;
	}

	/** A tuple's values as a collection whose element is `element()`: each position has to pass it. */
	function listInto(list: ListKind, element: () => Shape): Fit {
		const elements = [...list.elements, ...(list.after ?? [])].map((shape) => fit(element(), shape));
		if (list.rest) elements.push(atLeastEmpty(fit(element(), list.rest)));
		return elements.includes("none") ? "none" : worst(elements);
	}

	/** An empty collection always passes and is written whole. */
	function atLeastEmpty(value: Fit): Fit {
		return value === "none" ? "whole" : value;
	}

	function worst(values: Fit[]): Fit {
		return values.reduce<Fit>((result, value) => worse(result, value), "whole");
	}

	/** Whether a map whose keys are `key` can hold the field name or array index `name`. */
	function keyFits(key: Shape, name: string | number): boolean {
		const kind = describe(key);
		switch (kind.kind) {
			case "string":
				return typeof name === "string";
			case "number":
			case "varint":
				return typeof name === "number";
			case "constant":
				return literalKey(kind.value) === (typeof name === "string" ? JSON.stringify(name) : `${name}`);
			case "literals":
				return kind.values.some(
					(value) => literalKey(value) === (typeof name === "string" ? JSON.stringify(name) : `${name}`),
				);
			case "optional":
				return keyFits(kind.inner, name);
			case "union":
				return kind.alternatives.some((alternative) => keyFits(alternative.shape, name));
			case "blob":
				return kind.typeofName === undefined;
			default:
				return false;
		}
	}

	/**
	 * Two primitive kinds: `none` when no value is both, `whole` when `a` keeps every value of `b` its
	 * guard accepts, `lossy` when a number of `b` can be out of `a`'s width. `undefined` when either
	 * side is not a primitive; a primitive against a table is `none`.
	 */
	function primitiveFit(a: Kind, b: Kind): Fit | undefined {
		const left = primitiveType(a);
		const right = primitiveType(b);
		if (left === undefined && right === undefined) return;
		if (left === undefined || right === undefined || left !== right) return "none";

		const values = (kind: Kind) =>
			kind.kind === "constant" ? [kind.value] : kind.kind === "literals" ? kind.values : undefined;
		const leftValues = values(a);
		const rightValues = values(b);
		if (leftValues && rightValues) {
			const keys = new Set(leftValues.map(literalKey));
			return rightValues.some((value) => keys.has(literalKey(value))) ? "whole" : "none";
		}
		if (leftValues) return "whole";
		if (a.kind === "enum" && b.kind === "enum") return a.name === b.name ? "whole" : "none";
		if (a.kind === "datatype" && b.kind === "datatype") return a.name === b.name ? "whole" : "none";

		const holds = numberRange(a);
		if (holds) {
			const range = rightValues ? literalRange(rightValues) : numberRange(b);
			if (!range) return "lossy";
			const [minimum, maximum, whole] = range;
			return minimum >= holds[0] && maximum <= holds[1] && (whole || !holds[2]) ? "whole" : "lossy";
		}

		return "whole";
	}

	/** The values a number kind writes exactly: `[min, max, whole numbers only]`, or nothing for `f64`. */
	function numberRange(kind: Kind): [number, number, boolean] | undefined {
		if (kind.kind === "varint") return [0, VARINT_LIMIT - 1, true];
		if (kind.kind !== "number" || kind.width === "f64") return;
		if (kind.width === "f32") return [-F32_MAX, F32_MAX, false];
		const [minimum, maximum] = WIDTH_RANGE[kind.width]!;
		return [minimum, maximum, true];
	}

	function literalRange(values: ts.Expression[]): [number, number, boolean] | undefined {
		const numbers = values.map((value) => Number(literalKey(value)));
		if (numbers.some((value) => Number.isNaN(value))) return;
		return [Math.min(...numbers), Math.max(...numbers), numbers.every((value) => Number.isInteger(value))];
	}

	/** What `typeof` says about every value of a primitive kind; nothing for the others. */
	function primitiveType(kind: Kind): string | undefined {
		switch (kind.kind) {
			case "number":
			case "varint":
				return "number";
			case "string":
			case "boolean":
			case "buffer":
				return kind.kind;
			case "datatype":
				return kind.name;
			case "cframe":
				return "CFrame";
			case "enum":
				return "EnumItem";
			case "literals":
				return primitiveType({ kind: "constant", value: kind.values[0] });
			case "constant": {
				const value = kind.value;
				if (f.is.string(value)) return "string";
				if (f.is.number(value) || ts.isPrefixUnaryExpression(value)) return "number";
				if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
					return "boolean";
				return "EnumItem";
			}
		}
	}

	/** A build warning at the value being serialized, in the form the empty-glob warning takes. */
	function warn(message: string) {
		const node = ts.getParseTreeNode(diagnosticNode);
		const position = node && node.pos >= 0 ? node.getStart(file) : 0;
		const { line, character } = file.getLineAndCharacterOfPosition(position);
		const text = `${state.getFileId(file)}:${line + 1}:${character + 1} - ${message}`;
		if (warned.has(text)) return;

		warned.add(text);
		Logger.warn(text);
	}

	/**
	 * A property every object member has with a distinct literal type (`kind: "circle"` against
	 * `kind: "rect"`). Comparing it is cheaper than a guard and leaves no guard in the output.
	 */
	function discriminantOf(union: UnionKind): string | undefined {
		if (discriminants.has(union)) return discriminants.get(union);

		const objects = union.alternatives
			.map((alternative) => describe(alternative.shape))
			.filter((kind): kind is ObjectKind => kind.kind === "object");

		let discriminant: string | undefined;
		for (const field of objects[0]?.fields ?? []) {
			const seen = new Set<string>();
			const distinct = objects.every((object) => {
				const candidate = object.fields.find((other) => other.name === field.name);
				const kind = candidate && describe(candidate.shape);
				if (!kind || kind.kind !== "constant") return false;

				const text = printLiteral(kind.value);
				if (seen.has(text)) return false;
				seen.add(text);
				return true;
			});

			if (distinct) {
				discriminant = field.name;
				break;
			}
		}

		discriminants.set(union, discriminant);
		return discriminant;
	}

	// --- cursor --------------------------------------------------------------------------------------

	function at(ctx: Ctx, extra = 0): ts.Expression {
		const offset = ctx.cursor.offset + extra;
		return ctx.cursor.base ? add(ctx.cursor.base, offset) : num(offset);
	}

	/** Folds the pending constant (and any hoisted read's result) into the position variable. */
	function sync(ctx: Ctx) {
		const cursor = ctx.cursor;
		if (cursor.base === cursor.variable && cursor.offset === 0) return;
		if (!cursor.variable) throw new Error("Flamework: a variable-size write inside a fixed layout");

		if (cursor.base === cursor.variable) {
			ctx.out.push(addAssign(cursor.variable, num(cursor.offset)));
		} else {
			ctx.out.push(assign(cursor.variable, at(ctx)));
		}

		cursor.base = cursor.variable;
		cursor.offset = 0;
	}

	/** Moves the position by a runtime amount, folding the pending constant into the same statement. */
	function advanceBy(ctx: Ctx, amount: ts.Expression) {
		const cursor = ctx.cursor;
		if (!cursor.variable) throw new Error("Flamework: a variable-size write inside a fixed layout");

		if (cursor.base === cursor.variable) {
			ctx.out.push(addAssign(cursor.variable, add(amount, cursor.offset)));
		} else {
			ctx.out.push(assign(cursor.variable, add(at(ctx), amount)));
		}

		cursor.base = cursor.variable;
		cursor.offset = 0;
	}

	/**
	 * Statements for a conditional or repeated body. In a variable layout the body starts from the
	 * synced position variable and leaves it exact; in a fixed layout it inherits the offset and the
	 * caller advances past it.
	 */
	function branch(ctx: Ctx, build: (child: Ctx) => void): ts.Statement[] {
		if (ctx.cursor.variable) {
			sync(ctx);
			const child: Ctx = {
				...ctx,
				cursor: { variable: ctx.cursor.variable, base: ctx.cursor.variable, offset: 0 },
				out: [],
			};
			build(child);
			sync(child);
			return child.out;
		}

		const child: Ctx = { ...ctx, cursor: { ...ctx.cursor }, out: [] };
		build(child);
		return child.out;
	}

	/**
	 * A value as a local: identifiers and casts of identifiers are returned as they are, except for a
	 * parameter, which is copied so that the macros it reaches see a `const` (see {@link parameters}).
	 */
	function bind(out: ts.Statement[], value: ts.Expression, hint: string, type?: ts.TypeNode): ts.Expression {
		if (!type) {
			if (f.is.identifier(value) && !isParameterReference(value)) return value;
			if (ts.isAsExpression(value) && f.is.identifier(skipCasts(value.expression))) return value;
		}

		const id = uid(hint);
		out.push(constDecl(id, value, type));
		if (!type && typed.has(value)) typed.add(id);
		return id;
	}

	function isNilLiteral(expression: ts.Expression) {
		return ts.isIdentifier(expression) && expression.text === "undefined";
	}

	function isLiteral(expression: ts.Expression) {
		return f.is.string(expression) || f.is.number(expression) || f.is.bool(expression) || f.is.nil(expression);
	}

	function path(object: ts.Expression, names: string[]): ts.Expression {
		return names.reduce((current, name) => prop(current, name), object);
	}

	// --- size ----------------------------------------------------------------------------------------

	/**
	 * The byte count of `value`: a constant for fixed layouts, otherwise an expression (plus statements).
	 * `place` is where the value is, for the message of an array with a hole (see {@link elementAt}).
	 */
	function emitSize(shape: Shape, value: ts.Expression, out: ts.Statement[], place: Place): ts.Expression {
		const layout = layoutOf(shape);
		if (layout.size !== undefined) return num(layout.size);

		if (!isKind(shape)) {
			const info = hoist(shape);
			if (info) return callHoisted(info, "s", info.sizeChecks ? [value, passedWhere(place)] : [value]);
		}

		const kind = describe(shape);
		// Measuring reads the value, so a value whose size varies has its type tested here (a union, in its chain).
		const typed = typeCheckIn(shape, "size", place) !== undefined;
		if (typed && kind.kind !== "union") emitTypeCheck(kind, value, out, place);
		switch (kind.kind) {
			case "string":
				return sizeWithLength(out, kind.length, f.call(prop(cast(value, T.string()), "size"), []));
			case "buffer":
				return sizeWithLength(out, kind.length, bufferCall("len", [cast(value, T.buffer())]));
			case "varint":
				return f.call(varintHelpers().size, [cast(value, T.number())]);
			case "optional": {
				if (isNilLiteral(value)) return num(1);
				const inner = layoutOf(kind.inner);
				const v = bind(out, value, "v");
				if (inner.size !== undefined) {
					return conditional(notNil(v), num(1 + inner.size), num(1));
				}

				const total = uid("size");
				out.push(letDecl(total, num(1)));
				const body = new Array<ts.Statement>();
				body.push(addAssign(total, emitSize(kind.inner, v, body, place)));
				out.push(ifStatement(notNil(v), body));
				return total;
			}
			case "array": {
				const array = bind(out, cast(value, T.array()), "array");
				const count = bind(out, f.call(prop(array, "size"), []), "n");
				const prefix = f.call(varintHelpers().size, [count]);
				const element = layoutOf(kind.element);
				if (element.size !== undefined) return countedSize(prefix, count, element.size);

				// By index, as the elements are written: a nil the element type takes still takes its byte,
				// and one it does not is refused here, the first time it is reached.
				const total = uid("size");
				const index = uid("i");
				out.push(letDecl(total, prefix));
				const body = new Array<ts.Statement>();
				const hole = allowsNil(kind.element) ? undefined : { place, container: "the array" };
				const item = elementAt(array, index, body, hole);
				body.push(addAssign(total, emitSize(kind.element, item, body, within(place, "[]"))));
				out.push(forOf(index, range(num(1), count), body));
				return total;
			}
			case "set": {
				const set = bind(out, cast(value, T.set()), "set");
				const element = layoutOf(kind.element);
				const item = uid("item");
				return countedInPass(out, set, item, (body) =>
					element.size !== undefined
						? num(element.size)
						: emitSize(kind.element, item, body, within(place, "[]")),
				);
			}
			case "map": {
				const map = bind(out, cast(value, T.map()), "map");
				const key = uid("key");
				const entry = uid("entry");
				return countedInPass(out, map, f.arrayBindingDeclaration([key, entry]), (body) =>
					add(
						emitSize(kind.key, key, body, within(place, "<key>")),
						emitSize(kind.value, entry, body, within(place, "<value>")),
					),
				);
			}
			case "list": {
				const list = bind(out, cast(value, T.array()), "list");
				const total = new Sum();
				kind.elements.forEach((element, index) => {
					const at = within(place, `[${index}]`);
					total.add(emitSize(element, f.elementAccessExpression(list, num(index)), out, at));
				});

				if (kind.rest) {
					const rest = layoutOf(kind.rest);
					const after = kind.after ?? [];
					const count = restCount(out, list, kind.elements.length + after.length);
					// The elements after the rest are at the end of the list, past `count` rest values.
					after.forEach((element, index) => {
						const at = add(count, kind.elements.length + index);
						total.add(emitSize(element, f.elementAccessExpression(list, at), out, within(place, "[]")));
					});

					const prefix = f.call(varintHelpers().size, [count]);
					if (rest.size !== undefined) {
						total.add(countedSize(prefix, count, rest.size));
						return total.build();
					}

					const sum = uid("size");
					const index = uid("i");
					total.add(prefix);
					out.push(letDecl(sum, total.build()));
					const body = new Array<ts.Statement>();
					const element = allowsNil(kind.rest)
						? f.elementAccessExpression(list, f.binary(index, ts.SyntaxKind.MinusToken, num(1)))
						: elementAt(list, index, body, { place, container: tupleName(place) });
					body.push(addAssign(sum, emitSize(kind.rest, element, body, within(place, "[]"))));
					out.push(
						forOf(index, range(num(kind.elements.length + 1), add(count, kind.elements.length)), body),
					);
					return sum;
				}

				return total.build();
			}
			case "object": {
				const object = bind(out, cast(value, T.record()), "object");
				const total = new Sum();
				for (const field of kind.fields) {
					const at = within(place, keySegment(field.key));
					total.add(emitSize(field.shape, keyAccess(object, field.key), out, at));
				}

				return total.build();
			}
			case "union": {
				const v = bind(out, value, "v");
				const total = uid("size");
				out.push(letDecl(total, num(1)));
				if (typed) tablePrecheck(kind, v, out, place);

				// A value no member takes is the type check's, which this pass reaches first.
				let chain: ts.Statement | undefined = typed
					? f.block([f.statement(callTypeCheck(kind, v, place))])
					: undefined;
				// A member's test found its kind: what is inside it is still tested.
				const member = { ...place, tested: true };
				// Room for a number no member takes, which `warn` writes as the fallback member.
				const fallback = numericFallback(kind);
				if (fallback) {
					const shape = kind.alternatives[fallback.index].shape;
					const memberSize = layoutOf(shape).size;
					const body = new Array<ts.Statement>();
					body.push(
						addAssign(total, memberSize !== undefined ? num(memberSize) : emitSize(shape, v, body, member)),
					);
					chain = ifStatement(typeOfIs(v, "number"), body, chain);
				}

				for (const i of [...evaluation(kind).order].reverse()) {
					const alternative = kind.alternatives[i];
					const layout = layoutOf(alternative.shape);
					const body = new Array<ts.Statement>();
					const size =
						kind.whole === i
							? conditional(
									isWhole(cast(v, T.number())),
									f.call(varintHelpers().size, [cast(v, T.number())]),
									num(8),
								)
							: layout.size !== undefined
								? num(layout.size)
								: emitSize(alternative.shape, v, body, member);
					if (!(f.is.number(size) && size.text === "0")) body.push(addAssign(total, size));
					if (body.length === 0 && chain === undefined) continue;
					chain = ifStatement(discriminate(kind, i, v), body, chain);
				}

				if (chain) out.push(chain);
				return total;
			}
			default:
				throw new Error(`Flamework: '${kind.kind}' has a fixed size`);
		}
	}

	/**
	 * Whether nil is one of a shape's values: an optional, `undefined`, or anything at all (`unknown`,
	 * `any`, an unconstrained type parameter). An array element that takes nil is written as one; one that
	 * does not has nothing to write a hole as, so the hole is refused (see {@link elementAt}).
	 */
	function allowsNil(shape: Shape): boolean {
		const kind = describe(shape);
		if (kind.kind === "optional" || kind.kind === "nothing") return true;
		if (isKind(shape)) return false;
		if (shape.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
		if (shape.flags & ts.TypeFlags.TypeVariable) {
			const constraint = typeChecker.getBaseConstraintOfType(shape);
			return constraint === undefined || constraint === shape || allowsNil(constraint);
		}

		return false;
	}

	/** What a message calls a tuple: a call's argument list, or a tuple value. */
	function tupleName(place: Place): string {
		return place.args ? "the argument list" : "the tuple";
	}

	/**
	 * The element at the 1-based `index` of an array or a tuple's rest (`list[index - 1]`), as a local.
	 * An array is counted and walked up to its length (`#`), so an element the length counts but that is
	 * nil has to be written as a nil, which only an element type that takes nil can do. With `hole`, the
	 * one pass that reaches the elements first (the size pass when it walks them, otherwise the writes)
	 * refuses it, whatever `serialization.checks` says: `[Flamework] the array has no value at
	 * 'send' [0][2]`, the index counted from 0.
	 */
	function elementAt(
		list: ts.Expression,
		index: ts.Identifier,
		out: ts.Statement[],
		hole?: { place: Place; container: string },
	): ts.Identifier {
		const item = uid("item");
		out.push(constDecl(item, f.elementAccessExpression(list, f.binary(index, ts.SyntaxKind.MinusToken, num(1)))));
		if (hole) {
			const message = interpolate([
				`[Flamework] ${hole.container} has no value at `,
				...holeWhere(hole.place),
				"[",
				f.binary(index, ts.SyntaxKind.MinusToken, num(1)),
				"]",
			]);
			out.push(ifStatement(isNil(item), [raiseWith(message)]));
		}

		return item;
	}

	/** Where the array with a hole is, as the parts of the message before its index. */
	function holeWhere(place: Place): Array<string | ts.Expression> {
		if (place.where) return place.path ? [place.where, place.path] : [place.where];
		if (place.owner !== undefined) return [`${place.owner}${place.path ?? ""}`];
		if (place.args) return [place.site !== undefined ? `'${place.site}' ` : ""];
		const where = whereOf(place);
		return [f.is.string(where) ? where.text : where];
	}

	/** Text and values as a template string, which roblox-ts emits as a Luau interpolated string. */
	function interpolate(parts: Array<string | ts.Expression>): ts.Expression {
		let head = "";
		const spans = new Array<{ expression: ts.Expression; text: string }>();
		for (const part of parts) {
			if (typeof part !== "string") spans.push({ expression: part, text: "" });
			else if (spans.length === 0) head += part;
			else spans[spans.length - 1].text += part;
		}

		if (spans.length === 0) return f.string(head);
		return factory.createTemplateExpression(
			factory.createTemplateHead(head),
			spans.map(({ expression, text }, position) =>
				factory.createTemplateSpan(
					expression,
					position === spans.length - 1
						? factory.createTemplateTail(text)
						: factory.createTemplateMiddle(text),
				),
			),
		);
	}

	// --- write ---------------------------------------------------------------------------------------

	function emitWrite(shape: Shape, value: ts.Expression, ctx: Ctx): void {
		if (!isKind(shape)) {
			const info = hoist(shape);
			if (info) {
				const args = [ctx.buf, at(ctx), value];
				if (info.layout.blobs) args.push(ctx.blobs!);
				if (info.checks) args.push(passedWhere(ctx));
				ctx.out.push(assign(ctx.cursor.variable!, callHoisted(info, "w", args)));
				ctx.cursor.base = ctx.cursor.variable;
				ctx.cursor.offset = 0;
				return;
			}
		}

		const kind = describe(shape);
		// A value of a fixed size is first read here, so its type is tested here (see `typeCheckIn`):
		// ahead of the write for these kinds, in their own code for the others.
		const typed = typeCheckIn(shape, "write", ctx) !== undefined;
		if (typed && TESTED_AHEAD.has(kind.kind)) emitTypeCheck(kind, value, ctx.out, ctx);
		switch (kind.kind) {
			case "number":
				return writeNumber(kind, value, ctx, (n, target) => {
					target.out.push(
						f.statement(bufferCall(`write${kind.width}`, [target.buf, at(target), cast(n, T.number())])),
					);
					target.cursor.offset += WIDTH_SIZE[kind.width];
				});
			case "varint":
				return writeNumber(kind, value, ctx, (n, target) => writeVarint(target, cast(n, T.number())));
			case "boolean": {
				// The value is the condition rather than `value === true`: an argument packed at its
				// call site can be a literal, and `false === true` is a comparison TypeScript rejects
				// when it checks the emitted code.
				const write = (b: ts.Expression, target: Ctx) => {
					target.out.push(
						f.statement(bufferCall("writeu8", [target.buf, at(target), conditional(b, num(1), num(0))])),
					);
					target.cursor.offset += 1;
				};
				if (typed) {
					if (literalType(value) === undefined) return writeTyped(kind, value, ctx, write);
					// A literal is judged now: `true` needs no test, and `undefined` (which a call can pass
					// where `strictNullChecks` is off) calls the helper as it is, as any other value of the
					// wrong type would: it raises, or under `warn` warns and the value is written as false.
					emitTypeCheck(kind, value, ctx.out, ctx);
				}
				return write(value, ctx);
			}
			case "string": {
				const text = bind(ctx.out, cast(value, T.string()), "text");
				const length = bind(ctx.out, f.call(prop(text, "size"), []), "length");
				writeLength(ctx, kind.length, length, "string", checkedWidth(kind, ctx));
				ctx.out.push(f.statement(bufferCall("writestring", [ctx.buf, at(ctx), text])));
				advanceBy(ctx, length);
				return;
			}
			case "buffer": {
				const bytes = bind(ctx.out, cast(value, T.buffer()), "bytes");
				const length = bind(ctx.out, bufferCall("len", [bytes]), "length");
				writeLength(ctx, kind.length, length, "buffer", checkedWidth(kind, ctx));
				ctx.out.push(f.statement(bufferCall("copy", [ctx.buf, at(ctx), bytes])));
				advanceBy(ctx, length);
				return;
			}
			case "constant":
			case "nothing":
				return;
			case "literals": {
				const { index } = literalTablesFor(kind);
				const v = bind(ctx.out, value, "v");
				const slot = bind(ctx.out, f.call(prop(index, "get"), [cast(v, T.defined())]), "index");
				// No member found: the type check names it, the refusal stays behind it (`side`).
				const refuse = raise("value is not one of the literals its type allows");
				ctx.out.push(
					ifStatement(isNil(slot), typed ? [f.statement(callTypeCheck(kind, v, ctx)), refuse] : [refuse]),
				);
				const width = kind.values.length > 0xff ? "u16" : "u8";
				ctx.out.push(f.statement(bufferCall(`write${width}`, [ctx.buf, at(ctx), slot])));
				ctx.cursor.offset += WIDTH_SIZE[width];
				return;
			}
			case "blob": {
				const blob = bind(ctx.out, value, "blob");
				const blobs = ctx.blobs!;
				// nil is a blob's 0 as it always was; anything else has to be of the type `typeof` names.
				const present: ts.Statement[] = [
					f.statement(f.call(prop(blobs, "push"), [cast(blob, T.defined())])),
					f.statement(bufferCall("writeu32", [ctx.buf, at(ctx), f.call(prop(blobs, "size"), [])])),
				];
				if (typed) present.unshift(typeCheckStatement(kind, blob, ctx));
				ctx.out.push(
					ifStatement(notNil(blob), present, [
						f.statement(bufferCall("writeu32", [ctx.buf, at(ctx), num(0)])),
					]),
				);
				ctx.cursor.offset += BLOB_SIZE;
				return;
			}
			case "datatype": {
				const datatype = bind(ctx.out, cast(value, globalType(kind.name)), kind.name.toLowerCase());
				for (const [width, names] of DATATYPES[kind.name]) {
					ctx.out.push(f.statement(bufferCall(`write${width}`, [ctx.buf, at(ctx), path(datatype, names)])));
					ctx.cursor.offset += WIDTH_SIZE[width];
				}
				return;
			}
			case "cframe": {
				const components = Array.from({ length: CFRAME_COMPONENTS }, (_, i) => uid(`c${i}`));
				ctx.out.push(
					constDecl(
						f.arrayBindingDeclaration(components),
						f.call(prop(cast(value, globalType("CFrame")), "GetComponents"), []),
					),
				);
				for (const component of components) {
					ctx.out.push(f.statement(bufferCall("writef32", [ctx.buf, at(ctx), component])));
					ctx.cursor.offset += 4;
				}
				return;
			}
			case "enum":
				ctx.out.push(
					f.statement(bufferCall("writeu16", [ctx.buf, at(ctx), prop(cast(value, T.enumItem()), "Value")])),
				);
				ctx.cursor.offset += 2;
				return;
			case "optional": {
				if (isNilLiteral(value)) {
					ctx.out.push(f.statement(bufferCall("writeu8", [ctx.buf, at(ctx), num(0)])));
					ctx.cursor.offset += 1;
					return;
				}

				const v = bind(ctx.out, value, "v");
				ctx.out.push(
					f.statement(bufferCall("writeu8", [ctx.buf, at(ctx), conditional(notNil(v), num(1), num(0))])),
				);
				ctx.cursor.offset += 1;
				ctx.out.push(
					ifStatement(
						notNil(v),
						branch(ctx, (child) => emitWrite(kind.inner, v, child)),
					),
				);
				return;
			}
			case "array": {
				// By index up to the count written, as the size pass counts them: a nil inside the array is
				// written as one where the element type takes nil and refused where it does not, instead of
				// being skipped, which left every element after it one place early.
				const array = bind(ctx.out, cast(value, T.array()), "array");
				writeVarint(ctx, f.call(prop(array, "size"), []));
				const hole = holeInWrite(kind.element) ? { place: ctx, container: "the array" } : undefined;
				const index = uid("i");
				ctx.out.push(
					forOf(
						index,
						range(num(1), f.call(prop(array, "size"), [])),
						branch(ctx, (child) =>
							emitWrite(kind.element, elementAt(array, index, child.out, hole), within(child, "[]")),
						),
					),
				);
				return;
			}
			case "set": {
				const set = bind(ctx.out, cast(value, T.set()), "set");
				writeCounted(ctx, set, (item, child) => emitWrite(kind.element, item, within(child, "[]")));
				return;
			}
			case "map": {
				const map = bind(ctx.out, cast(value, T.map()), "map");
				const key = uid("key");
				const entry = uid("entry");
				writeCounted(
					ctx,
					map,
					(_, child) => {
						emitWrite(kind.key, key, within(child, "<key>"));
						emitWrite(kind.value, entry, within(child, "<value>"));
					},
					f.arrayBindingDeclaration([key, entry]),
				);
				return;
			}
			case "list": {
				const list = bind(ctx.out, cast(value, T.array()), "list");
				kind.elements.forEach((element, index) => {
					emitScopedWrite(element, f.elementAccessExpression(list, num(index)), within(ctx, `[${index}]`));
				});

				if (kind.rest) {
					const after = kind.after ?? [];
					const count = restCount(ctx.out, list, kind.elements.length + after.length);
					writeVarint(ctx, count);
					const index = uid("i");
					const rest = kind.rest;
					const hole = holeInWrite(rest) ? { place: ctx, container: tupleName(ctx) } : undefined;
					ctx.out.push(
						forOf(
							index,
							range(num(kind.elements.length + 1), add(count, kind.elements.length)),
							branch(ctx, (child) => {
								const element = hole
									? elementAt(list, index, child.out, hole)
									: f.elementAccessExpression(
											list,
											f.binary(index, ts.SyntaxKind.MinusToken, num(1)),
										);
								emitWrite(rest, element, within(child, "[]"));
							}),
						),
					);

					after.forEach((shape, position) => {
						const at = add(count, kind.elements.length + position);
						emitScopedWrite(shape, f.elementAccessExpression(list, at), within(ctx, "[]"));
					});
				}
				return;
			}
			case "object": {
				const object = bind(ctx.out, cast(value, T.record()), "object");
				for (const field of kind.fields) {
					const place = within(ctx, keySegment(field.key));
					// A union's discriminant has compared this one already.
					const compared = field.name === ctx.compared ? { ...place, tested: true } : place;
					emitScopedWrite(field.shape, keyAccess(object, field.key), compared);
				}
				return;
			}
			case "union": {
				const v = bind(ctx.out, value, "v");
				const layout = layoutOf(kind);
				// Who moves the position past the union. In a fixed layout the branches write at
				// literal offsets and move nothing, so the size is added here; in a variable one
				// `branch` syncs the position variable on the way out of every branch, and the
				// union has already been stepped over. Adding it in both cases steps over it
				// twice, which puts the next write a union's worth too far along and runs the
				// element past what the size pass budgeted.
				const isFixedLayout = ctx.cursor.variable === undefined;
				const start = ctx.cursor.offset;
				// Under type checks a value no member takes is named by the check (a union whose size varies
				// was measured first, which named it already), and the refusal stays behind it (`side`).
				if (typed) tablePrecheck(kind, v, ctx.out, ctx);
				const refuse = raise("value matches none of the union's members");
				let chain: ts.Statement = f.block(
					typed ? [f.statement(callTypeCheck(kind, v, ctx)), refuse] : [refuse],
				);
				const writeMember = (child: Ctx, i: number) => {
					child.out.push(f.statement(bufferCall("writeu8", [child.buf, at(child), num(i)])));
					child.cursor.offset += 1;
					// A member with a range is only reached by a number its test found in range, or by
					// the fallback below once its check has run: no check of its own. Any member's test
					// found its kind, so its own type is not tested again either (`tested`).
					const shape = kind.alternatives[i].shape;
					const ranged = numberRange(describe(shape)) !== undefined;
					const compared = checks.types ? discriminantField(kind, i) : undefined;
					const member: Ctx = { ...child, tested: true, compared };
					emitWrite(shape, v, ranged ? { ...member, unchecked: true } : member);
				};

				// A number no member takes fails the check of the members with a range: raised, or
				// warned about and written as the first checked one, as it is (see `numericFallback`).
				const fallback = numericFallback(kind, ctx);
				if (fallback) {
					const test = f.binary(
						typeOfIs(v, "number"),
						ts.SyntaxKind.AmpersandAmpersandToken,
						callCheck(fallback.widths, cast(v, T.number()), ctx),
					);
					const body = branch(ctx, (child) => writeMember(child, fallback.index));
					chain = ifStatement(test, body, chain);
				}

				for (const i of [...evaluation(kind).order].reverse()) {
					const body = branch(ctx, (child) => {
						if (kind.whole !== i) return writeMember(child, i);

						const n = cast(v, T.number());
						const whole = branch(child, (inner) => {
							inner.out.push(
								f.statement(
									bufferCall("writeu8", [inner.buf, at(inner), num(kind.alternatives.length)]),
								),
							);
							inner.cursor.offset += 1;
							writeVarint(inner, n);
						});
						child.out.push(
							ifStatement(
								isWhole(n),
								whole,
								branch(child, (inner) => writeMember(inner, i)),
							),
						);
					});
					chain = ifStatement(discriminate(kind, i, v), body, chain);
				}

				ctx.out.push(chain);
				if (isFixedLayout && layout.size !== undefined) ctx.cursor.offset = start + layout.size;
				return;
			}
		}
	}

	/**
	 * A field's or a tuple element's write. Under type checks, code that declares a local goes in a `do`
	 * block of its own, so that the function holds the locals of one value at a time: the `where` the
	 * checks add to a hoisted `w_` is one more of the 200 locals Luau allows a function, and a type at
	 * that limit without the checks (sixteen CFrames hold twelve each) would otherwise no longer load
	 * with them. Off, the code is as it was. The size pass is left as it is: a type's `r_` holds at
	 * least as many locals as its `s_` does with `where` (reading a value takes at least the locals
	 * measuring it does, and `r_` has two parameters), so a type whose `s_` the checks would push past
	 * the limit does not load without them either.
	 */
	function emitScopedWrite(shape: Shape, value: ts.Expression, place: Ctx) {
		if (!checks.types) return emitWrite(shape, value, place);
		const block: Ctx = { ...place, out: [] };
		emitWrite(shape, value, block);
		if (block.out.some((statement) => ts.isVariableStatement(statement))) place.out.push(f.block(block.out));
		else place.out.push(...block.out);
	}

	/**
	 * Whether the writes of an array or a tuple's rest refuse a hole (see {@link elementAt}): when the
	 * element type takes no nil and has a fixed size, so the size pass never walked the elements.
	 */
	function holeInWrite(element: Shape): boolean {
		return !allowsNil(element) && layoutOf(element).size !== undefined;
	}

	/** How many rest elements a list holds: never negative, since absent trailing optionals shorten it. */
	function restCount(out: ts.Statement[], list: ts.Expression, fixed: number): ts.Identifier {
		const count = uid("count");
		const size = f.call(prop(list, "size"), []);
		// A list of nothing but its rest (an array rest parameter's arguments) is all rest.
		const length = fixed === 0 ? size : f.binary(size, ts.SyntaxKind.MinusToken, num(fixed));
		out.push(constDecl(count, fixed === 0 ? length : f.call(prop(globalRef("math"), "max"), [length, num(0)])));
		return count;
	}

	/**
	 * The length prefix of a string or buffer: a varint, or a fixed width refusing what it cannot hold.
	 * A checked width (`checked`, its name) calls the check first, which raises or warns with where the
	 * value is; the refusal stays behind it either way, since a length past its prefix cannot be
	 * written without every value after it being misread, so even `warn` does not write one.
	 */
	function writeLength(ctx: Ctx, width: LengthWidth, length: ts.Expression, what: string, checked?: string) {
		if (width === "v") return writeVarint(ctx, length);

		if (width !== "u32") {
			const refuse = raise(`${what} is longer than its ${width} length prefix allows`);
			ctx.out.push(
				ifStatement(
					f.binary(length, ts.SyntaxKind.GreaterThanToken, num(LENGTH_MAX[width])),
					checked !== undefined ? [f.statement(callCheck(checked, length, ctx, " bytes")), refuse] : [refuse],
				),
			);
		}

		ctx.out.push(f.statement(bufferCall(`write${width}`, [ctx.buf, at(ctx), length])));
		ctx.cursor.offset += WIDTH_SIZE[width];
	}

	/** Sets and maps have no cheap length: they are counted (a loop, in roblox-ts) before the elements. */
	function writeCounted(
		ctx: Ctx,
		collection: ts.Expression,
		body: (item: ts.Identifier, child: Ctx) => void,
		binding?: ts.BindingName,
	) {
		const count = bind(ctx.out, f.call(prop(collection, "size"), []), "n");
		writeVarint(ctx, count);
		const item = uid("item");
		ctx.out.push(
			forOf(
				binding ?? item,
				collection,
				branch(ctx, (child) => body(item, child)),
			),
		);
	}

	/** The test that tells member `index` of `union` apart from the others, given a value. */
	function discriminate(union: UnionKind, index: number, value: ts.Expression): ts.Expression {
		// The last member left once the others are ruled out only has to be a table: anything else
		// still falls through to the error.
		if (evaluation(union).tableOnly === index) return typeOfIs(value, "table");

		const alternative = union.alternatives[index];
		const kind = describe(alternative.shape);

		if (kind.kind === "object") {
			const key = objectKey(union, kind);
			if (key) {
				const field = keyAccess(cast(value, T.record()), key.key);
				const test = key.value ? equals(field, checkGlobalsIn(key.value)) : notNil(field);
				// Indexing is only safe once the value is known to be a table.
				const tables = union.alternatives.every((other) => TABLE_KINDS.has(describe(other.shape).kind));
				return tables ? test : f.binary(typeOfIs(value, "table"), ts.SyntaxKind.AmpersandAmpersandToken, test);
			}
		}

		switch (kind.kind) {
			case "number":
			case "varint": {
				// A branded width only takes a number it writes as it is, so one that does not fit goes
				// to the next member: 70000 in `u16 | number` is the number, not 4464.
				const range = numberRange(kind);
				if (!range) return typeOfIs(value, "number");
				return f.binary(
					typeOfIs(value, "number"),
					ts.SyntaxKind.AmpersandAmpersandToken,
					fitsRange(cast(value, T.number()), range),
				);
			}
			case "string":
				return typeOfIs(value, "string");
			case "boolean":
				return typeOfIs(value, "boolean");
			case "buffer":
				return typeOfIs(value, "buffer");
			case "datatype":
				return typeOfIs(value, kind.name);
			case "cframe":
				return typeOfIs(value, "CFrame");
			case "enum":
				return enumTest(kind.name, value);
			case "literals":
				return notNil(f.call(prop(literalTablesFor(kind).index, "get"), [cast(value, T.defined())]));
			case "constant":
				return equals(value, checkGlobalsIn(kind.value));
			case "nothing":
				return isNil(value);
			case "blob":
				return kind.typeofName !== undefined ? typeOfIs(value, kind.typeofName) : f.bool(true);
			default:
				if (!alternative.type) throw new Error(`Flamework: cannot discriminate a synthetic ${kind.kind}`);
				return f.call(guardFor(alternative.type), [value]);
		}
	}

	// --- read ----------------------------------------------------------------------------------------

	/**
	 * The value read at the cursor. Fixed-size reads are plain expressions; anything that moves the
	 * position by a runtime amount is bound to a local first, so the expressions of one container are
	 * always evaluated against a position that no later read has changed.
	 */
	function emitRead(shape: Shape, ctx: Ctx): ts.Expression {
		if (!isKind(shape)) {
			const info = hoist(shape);
			if (info) {
				const args = [ctx.buf, at(ctx)];
				if (info.layout.blobs) args.push(ctx.blobs!);
				const value = uid("value");
				const next = uid("o");
				ctx.out.push(constDecl(f.arrayBindingDeclaration([value, next]), callHoisted(info, "r", args)));
				ctx.cursor.base = next;
				ctx.cursor.offset = 0;
				return value;
			}
		}

		const kind = describe(shape);
		switch (kind.kind) {
			case "number": {
				const read = bufferCall(`read${kind.width}`, [ctx.buf, at(ctx)]);
				ctx.cursor.offset += WIDTH_SIZE[kind.width];
				return read;
			}
			case "varint":
				return readVarint(ctx);
			case "boolean": {
				const read = f.binary(
					bufferCall("readu8", [ctx.buf, at(ctx)]),
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
					num(0),
				);
				ctx.cursor.offset += 1;
				return read;
			}
			case "string": {
				const length = readLength(ctx, kind.length);
				const text = bind(ctx.out, bufferCall("readstring", [ctx.buf, at(ctx), length]), "text");
				advanceBy(ctx, length);
				return text;
			}
			case "buffer": {
				const length = readLength(ctx, kind.length);
				// `buffer.copy` bounds-checks, but only after `buffer.create` has allocated the announced
				// length: a hostile length must be refused against what is left before it drives that.
				const remaining = f.binary(bufferCall("len", [ctx.buf]), ts.SyntaxKind.MinusToken, at(ctx));
				ctx.out.push(
					ifStatement(f.binary(length, ts.SyntaxKind.GreaterThanToken, remaining), [raise(MALFORMED)]),
				);
				const bytes = bind(ctx.out, bufferCall("create", [length]), "bytes");
				ctx.out.push(f.statement(bufferCall("copy", [bytes, num(0), ctx.buf, at(ctx), length])));
				advanceBy(ctx, length);
				return bytes;
			}
			case "constant":
				return checkGlobalsIn(kind.value);
			case "nothing":
				return f.nil();
			case "literals": {
				const { list } = literalTablesFor(kind);
				const width = kind.values.length > 0xff ? "u16" : "u8";
				const index = bufferCall(`read${width}`, [ctx.buf, at(ctx)]);
				ctx.cursor.offset += WIDTH_SIZE[width];
				const value = bind(ctx.out, f.elementAccessExpression(list, index), "literal");
				ctx.out.push(ifStatement(isNil(value), [raise(MALFORMED)]));
				return value;
			}
			case "blob": {
				const index = bufferCall("readu32", [ctx.buf, at(ctx)]);
				ctx.cursor.offset += BLOB_SIZE;
				// 1-based on the wire; roblox-ts adds the one back when indexing an array.
				return f.elementAccessExpression(ctx.blobs!, f.binary(index, ts.SyntaxKind.MinusToken, num(1)));
			}
			case "datatype": {
				const args = DATATYPES[kind.name].map(([width]) => {
					const read = bufferCall(`read${width}`, [ctx.buf, at(ctx)]);
					ctx.cursor.offset += WIDTH_SIZE[width];
					return read;
				});
				return construct(kind.name, args);
			}
			case "cframe": {
				const args = Array.from({ length: CFRAME_COMPONENTS }, () => {
					const read = bufferCall("readf32", [ctx.buf, at(ctx)]);
					ctx.cursor.offset += 4;
					return read;
				});
				return construct("CFrame", args);
			}
			case "enum": {
				const index = bufferCall("readu16", [ctx.buf, at(ctx)]);
				ctx.cursor.offset += 2;
				return f.call(prop(enumTableFor(kind.name), "get"), [index]);
			}
			case "optional": {
				const present = bind(
					ctx.out,
					f.binary(
						bufferCall("readu8", [ctx.buf, at(ctx)]),
						ts.SyntaxKind.ExclamationEqualsEqualsToken,
						num(0),
					),
					"present",
				);
				ctx.cursor.offset += 1;
				const value = uid("value");
				ctx.out.push(letDecl(value, undefined, T.unknown()));
				ctx.out.push(
					ifStatement(
						present,
						branch(ctx, (child) => child.out.push(assign(value, emitRead(kind.inner, child)))),
					),
				);
				return value;
			}
			case "array": {
				const count = readCount(ctx, layoutOf(kind.element).min);
				const array = bind(ctx.out, construct("Array", [count]), "array", T.array());
				const index = uid("i");
				ctx.out.push(
					forOf(
						index,
						range(num(1), count),
						branch(ctx, (child) => {
							const element = emitRead(kind.element, child);
							child.out.push(
								assign(
									f.elementAccessExpression(array, f.binary(index, ts.SyntaxKind.MinusToken, num(1))),
									element,
								),
							);
						}),
					),
				);
				return array;
			}
			case "set": {
				const count = readCount(ctx, layoutOf(kind.element).min);
				const set = bind(ctx.out, construct("Set", []), "set", T.set());
				ctx.out.push(
					forOf(
						uid("_"),
						range(num(1), count),
						branch(ctx, (child) => {
							const element = emitRead(kind.element, child);
							child.out.push(f.statement(f.call(prop(set, "add"), [f.as(element, T.defined())])));
						}),
					),
				);
				return set;
			}
			case "map": {
				const count = readCount(ctx, layoutOf(kind.key).min + layoutOf(kind.value).min);
				const map = bind(ctx.out, construct("Map", []), "map", T.map());
				ctx.out.push(
					forOf(
						uid("_"),
						range(num(1), count),
						branch(ctx, (child) => {
							const key = readInto(kind.key, child, "key");
							const value = readInto(kind.value, child, "entry");
							child.out.push(f.statement(f.call(prop(map, "set"), [key, value])));
						}),
					),
				);
				return map;
			}
			case "list": {
				const elements = kind.elements.map((element) => readInto(element, ctx, "arg"));
				// Typed explicitly: an empty list would otherwise be an implicit `any[]`.
				if (!kind.rest) return f.as(f.array(elements, false), T.array());

				const count = readCount(ctx, layoutOf(kind.rest).min);
				const list = bind(ctx.out, f.array(elements, false), "list", T.array());
				const index = uid("i");
				ctx.out.push(
					forOf(
						index,
						range(num(1), count),
						branch(ctx, (child) => {
							const element = emitRead(kind.rest!, child);
							child.out.push(
								assign(f.elementAccessExpression(list, add(index, kind.elements.length - 1)), element),
							);
						}),
					),
				);

				// The elements after the rest, in their places past it.
				kind.after?.forEach((shape, position) => {
					const element = readInto(shape, ctx, "arg");
					const at = add(count, kind.elements.length + position);
					ctx.out.push(assign(f.elementAccessExpression(list, at), element));
				});
				return list;
			}
			case "object": {
				const fields = kind.fields.map((field) =>
					f.propertyAssignmentDeclaration(keyName(field.key), readInto(field.shape, ctx, field.name)),
				);
				return f.object(fields);
			}
			case "union": {
				const layout = layoutOf(kind);
				// As in {@link emitWrite}: only a fixed layout's branches leave the position where
				// they found it, so only there does the union's size get added on top of them.
				const isFixedLayout = ctx.cursor.variable === undefined;
				const tag = bind(ctx.out, bufferCall("readu8", [ctx.buf, at(ctx)]), "tag");
				ctx.cursor.offset += 1;
				const start = ctx.cursor.offset;
				const value = uid("value");
				ctx.out.push(letDecl(value, undefined, T.unknown()));

				let chain: ts.Statement = f.block([raise(MALFORMED)]);
				if (kind.whole !== undefined) {
					const body = branch(ctx, (child) => child.out.push(assign(value, readVarint(child))));
					chain = ifStatement(equals(tag, num(kind.alternatives.length)), body, chain);
				}

				for (let i = kind.alternatives.length - 1; i >= 0; i--) {
					const alternative = kind.alternatives[i];
					const body = branch(ctx, (child) =>
						child.out.push(assign(value, emitRead(alternative.shape, child))),
					);
					chain = ifStatement(equals(tag, num(i)), body, chain);
				}

				ctx.out.push(chain);
				if (isFixedLayout && layout.size !== undefined) ctx.cursor.offset = start + layout.size - 1;
				return value;
			}
		}
	}

	/** A read whose result is bound to a local in variable layouts; see {@link emitRead}. */
	function readInto(shape: Shape, ctx: Ctx, hint: string): ts.Expression {
		const value = emitRead(shape, ctx);
		if (!ctx.cursor.variable || f.is.identifier(value) || isLiteral(value)) return value;
		return bind(ctx.out, value, localName(typeChecker, hint));
	}

	function readLength(ctx: Ctx, width: LengthWidth): ts.Expression {
		if (width === "v") return readVarint(ctx, "length");

		const length = bind(ctx.out, bufferCall(`read${width}`, [ctx.buf, at(ctx)]), "length");
		ctx.cursor.offset += WIDTH_SIZE[width];
		return length;
	}

	/**
	 * An element count from the buffer, refused when the elements it announces could not fit in what
	 * is left: a hostile count must not drive a huge allocation or a long loop. Elements that take no
	 * bytes cannot be bounded that way; they are tallied across the whole payload instead, and the
	 * tally is capped, so that nesting cannot multiply what one count may announce.
	 */
	function readCount(ctx: Ctx, minimumElementSize: number): ts.Expression {
		const count = readVarint(ctx, "count");
		sync(ctx);

		if (minimumElementSize === 0) {
			const tally = zeroTally();
			ctx.out.push(addAssign(tally, count));
			ctx.out.push(
				ifStatement(f.binary(tally, ts.SyntaxKind.GreaterThanToken, num(ZERO_SIZE_COUNT_MAX)), [
					raise(MALFORMED),
				]),
			);
			return count;
		}

		const remaining = f.binary(bufferCall("len", [ctx.buf]), ts.SyntaxKind.MinusToken, ctx.cursor.variable!);
		const needed =
			minimumElementSize > 1 ? f.binary(count, ts.SyntaxKind.AsteriskToken, num(minimumElementSize)) : count;
		ctx.out.push(ifStatement(f.binary(needed, ts.SyntaxKind.GreaterThanToken, remaining), [raise(MALFORMED)]));
		return count;
	}

	/** The file's zero-size element tally, declared once ahead of the hoisted functions that share it. */
	function zeroTally(): ts.Identifier {
		if (!zeros) {
			zeros = uid("zeros");
			tables.push(letDecl(zeros, num(0)));
		}

		return zeros;
	}
}
