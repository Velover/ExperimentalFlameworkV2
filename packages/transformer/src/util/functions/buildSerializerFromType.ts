import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { f } from "../factory";
import { TYPE_FLAG_DISJOINT_DOMAINS } from "../tsInternals";
import {
	buildGuardFromType,
	extractTypes,
	getLiteral,
	isConditionalType,
	isInstanceType,
	simplifyUnion,
} from "./buildGuardFromType";
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
 * - literal unions: a 1-byte index (2 past 255 members); a single literal costs nothing
 * - optionals: 1 presence byte, then the value when present
 * - arrays, sets, maps and tuple rest elements: varint count + elements
 * - unions: u8 member index + the member, members numbered in the order they were written, so
 *   `number | string` is 0 for the number and 1 for the string; past 255 members the union is a
 *   blob. Objects: fields in declaration order, nothing spent on names
 * - Vector3 12, Vector2 8, Vector3int16 6, Vector2int16 4, Color3 12, UDim 8, UDim2 16, NumberRange 8,
 *   Rect 16, BrickColor 2, CFrame 48 (its twelve components), EnumItems 2 (their `Value`), blobs 4
 *
 * A varint is 1 byte below 128, 2 below 16384, and so on up to 5; the three helpers that handle it
 * are hoisted once per file. Named types with a variable size are hoisted into `s_` (size), `w_`
 * (write) and `r_` (read) functions ahead of the statement, once per statement, which is also how
 * recursive types work. Fixed-size types are always inlined.
 *
 * What goes in the blob list: everything declared by roblox-ts's Roblox types (Instances, EnumItem,
 * Font, RBXScriptSignal, ...) unless it has a layout above, anything with a `_nominal_` marker,
 * `unknown`, `any`, `object`, `defined`, empty object types and class instances. Only what a remote
 * cannot carry at all is a compile error: functions, Promises outside a function result, symbols,
 * bigint, `never`, template literals and `LuaTuple` (several values at runtime, not a table).
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

/** A blob's 1-based index in the blob list, 0 for nil. */
const BLOB_SIZE = 4;
const VARINT_MAX_BYTES = 5;
/** Counts of zero-size elements cannot be bounded by the bytes left, so they get a plain cap. */
const ZERO_SIZE_COUNT_MAX = 0xffff;

/** Where roblox-ts declares the Roblox API: everything in there without a layout travels as a blob. */
const ROBLOX_TYPES = /[\\/]@rbxts[\\/]types[\\/]/;

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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MALFORMED = "malformed payload";

/**
 * What the generator knows about a type. Children are kept as types so that named ones can be
 * hoisted; the synthetic kinds (literal groups, optionals) only appear where a type cannot stand.
 */
type Kind =
	| { kind: "number"; width: Width }
	| { kind: "varint" }
	| { kind: "boolean" }
	| { kind: "string"; length: LengthWidth }
	| { kind: "buffer"; length: LengthWidth }
	| { kind: "constant"; value: ts.Expression }
	| { kind: "literals"; values: ts.Expression[] }
	| { kind: "nothing" }
	| { kind: "blob"; typeofName?: string }
	| { kind: "datatype"; name: string }
	| { kind: "cframe" }
	| { kind: "enum"; name: string }
	| { kind: "optional"; inner: Shape }
	| { kind: "array"; element: ts.Type }
	| { kind: "set"; element: ts.Type }
	| { kind: "map"; key: ts.Type; value: ts.Type }
	| { kind: "list"; elements: Shape[]; rest?: ts.Type }
	| { kind: "object"; fields: Array<{ name: string; shape: Shape }> }
	| { kind: "union"; alternatives: Alternative[] };

type Shape = ts.Type | Kind;
type ListKind = Extract<Kind, { kind: "list" }>;
type UnionKind = Extract<Kind, { kind: "union" }>;
type ObjectKind = Extract<Kind, { kind: "object" }>;

/** Kinds whose values are Luau tables, which can be indexed without a `typeof` check first. */
const TABLE_KINDS = new Set<Kind["kind"]>(["object", "map", "array", "set", "list"]);

/** A union member; `type` is set when the member is a real type, which a guard may be built from. */
interface Alternative {
	shape: Shape;
	type?: ts.Type;
}

interface Layout {
	/** Byte size when every value of the type takes the same number of bytes. */
	size: number | undefined;
	/** The fewest bytes any value takes; bounds counts read from a hostile buffer. */
	min: number;
	/** Whether any value of the type can put something in the blob list. */
	blobs: boolean;
}

/** Where the next write or read goes: `base + offset`, with `offset` folded at compile time. */
interface Cursor {
	/** The `let` that tracks the position in a variable-size layout; absent when everything is fixed. */
	variable: ts.Identifier | undefined;
	/** The identifier the offset is relative to: `variable`, or the second result of a hoisted read. */
	base: ts.Identifier | undefined;
	offset: number;
}

interface Ctx {
	buf: ts.Identifier;
	blobs: ts.Identifier | undefined;
	cursor: Cursor;
	out: ts.Statement[];
}

interface Hoisted {
	size: ts.Identifier;
	write: ts.Identifier;
	read: ts.Identifier;
	layout: Layout;
}

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
const bufferCall = (method: string, args: ts.Expression[]) => f.call(prop("buffer", method), args);
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
const range = (from: ts.Expression, to: ts.Expression) => f.call("$range", [from, to]);
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
const raise = (message: string) => f.statement(f.call("error", [f.string(message)]));
/** `typeIs(v, name)`: roblox-ts emits `type(v) == name` for primitives and `typeof(v) == name` otherwise, with no temporaries. */
const typeOfIs = (value: ts.Expression, name: string) => f.call("typeIs", [value, f.string(name)]);
const construct = (name: string, args: ts.Expression[], typeArguments?: ts.TypeNode[]) =>
	factory.createNewExpression(f.identifier(name), typeArguments, args);

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

namespace T {
	export const unknown = () => f.keywordType(ts.SyntaxKind.UnknownKeyword);
	export const number = () => f.keywordType(ts.SyntaxKind.NumberKeyword);
	export const string = () => f.keywordType(ts.SyntaxKind.StringKeyword);
	export const buffer = () => f.referenceType("buffer");
	export const defined = () => f.referenceType("defined");
	export const blobs = () => f.referenceType("Array", [defined()]);
	export const array = () => f.referenceType("Array", [unknown()]);
	export const record = () => f.referenceType("Record", [string(), unknown()]);
	export const map = () => f.referenceType("Map", [unknown(), unknown()]);
	export const set = () => f.referenceType("Set", [defined()]);
	export const enumItem = () => f.referenceType("EnumItem");
	export const tuple = (elements: ts.TypeNode[]) => f.referenceType("LuaTuple", [f.tupleType(elements)]);
	export const fn = (parameters: Array<[string, ts.TypeNode]>, result: ts.TypeNode) =>
		f.functionType(
			parameters.map(([name, type]) => f.parameterDeclaration(name, type)),
			result,
		);
}

// --- entry points -----------------------------------------------------------------------------------

/**
 * One generator per file: every intrinsic and call site in it shares the hoisted helpers (a named
 * type's functions, guards, literal and enum tables), which land at file scope ahead of the root
 * statement that first needed them.
 */
const generators = new WeakMap<ts.SourceFile, ReturnType<typeof createSerializerGenerator>>();

function generatorFor(state: TransformState, node: ts.Node, file: ts.SourceFile) {
	let generator = generators.get(file);
	if (!generator) {
		generator = createSerializerGenerator(state, file, node);
		generators.set(file, generator);
	}

	generator.use(node);
	return generator;
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
	if (ts.isCallExpression(node)) generator.hint(node.typeArguments?.[0], type);
	const serializer = generator.buildSerializer(unwrapPromise(state, type));
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
 * identifiers or literals: they are read more than once.
 */
export function buildInlineEncoding(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	values: ts.Expression[] | { table: ts.Expression },
	file = state.getSourceFile(node),
): InlineEncoding {
	const generator = generatorFor(state, node, file);
	const encoding = generator.encodeList(type, values);
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
 */
export function buildInlineResultEncoding(
	state: TransformState,
	node: ts.Node,
	fn: ts.Type,
	value: ts.Identifier,
	isParameter: boolean,
	file = state.getSourceFile(node),
): InlineEncoding {
	const generator = generatorFor(state, node, file);
	if (isParameter) generator.markParameter(value);
	const encoding = generator.encodeList(resultOf(state, generator, fn, node), [value]);
	emitHoisted(state, generator);
	return encoding;
}

/** The one-element list a function's (resolved) result travels as, with its declared return type node registered. */
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

	const returnType = signature.getReturnType();
	generator.hint(signature.getDeclaration()?.type, returnType);
	return { kind: "list", elements: [unwrapPromise(state, returnType)] };
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
	const guards = new Map<ts.Type, ts.Identifier>();
	const enumTables = new Map<string, ts.Identifier>();
	const literalTables = new Map<Kind, { list: ts.Identifier; index: ts.Identifier }>();
	const discriminants = new Map<UnionKind, string | undefined>();
	/** Where each union was written, which is the order its members are numbered in. */
	const unionNodes = new Map<ts.Type, ts.UnionTypeNode>();
	let varint: Varint | undefined;

	/**
	 * Parameters of the generated functions. roblox-ts copies a parameter into a temporary wherever one
	 * of its macros (`typeIs`, `Map.get`, `Array.push`) takes it, and then everything after it in the
	 * call too; a `const` copy of our own passes straight through, so {@link bind} makes one.
	 */
	const parameters = new Set<ts.Identifier>();

	return { buildSerializer, buildDecoder, encodeList, use, hint, markParameter, takeHoisted };

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
	}

	/** Registers where a type was written; see {@link registerTypeNode}. */
	function hint(node: ts.TypeNode | undefined, type: ts.Type | undefined) {
		registerTypeNode(node, type);
	}

	/** Hoisted statements added since the last call, in an order that keeps every reference in scope. */
	function takeHoisted(): ts.Statement[] {
		const statements = [
			...declarations.slice(emitted[0]),
			...tables.slice(emitted[1]),
			...definitions.slice(emitted[2]),
		];
		emitted = [declarations.length, tables.length, definitions.length];
		return statements;
	}

	function fail(message: string): never {
		const chain = trail.map((type) => typeChecker.typeToString(type)).join(" > ");
		const lines = [`Flamework cannot serialize this type: ${message}.`];
		if (chain !== "") lines.push(`Reached through: ${chain}`);
		return Diagnostics.error(diagnosticNode, ...(lines as [string, ...string[]]));
	}

	// --- top level -----------------------------------------------------------------------------------

	function buildSerializer(type: ts.Type): ts.Expression {
		const layout = layoutOf(type);
		const value = parameter("v");
		const serialize = f.arrowFunction(f.block(encodeBody(type, layout, value)), [
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

	function encodeList(type: ts.Type | ListKind, values: ts.Expression[] | { table: ts.Expression }): InlineEncoding {
		return encodeElements(isKind(type) ? type : listOf(type), values);
	}

	/** A list with nothing to carry: no elements, or only `void` ones. Such a list sends no payload. */
	function carriesNothing(list: ListKind): boolean {
		return !list.rest && list.elements.every((element) => describe(element).kind === "nothing");
	}

	/**
	 * Packs a list whose values are known one by one, so a static count of rest values and absent
	 * optionals fold into the layout: a call with only fixed-size arguments gets a constant buffer size.
	 */
	function encodeElements(list: ListKind, values: ts.Expression[] | { table: ts.Expression }): InlineEncoding {
		if (carriesNothing(list)) return { statements: [], payload: undefined, blobs: undefined };

		const layout = layoutOf(list);
		const statements = new Array<ts.Statement>();
		if (!Array.isArray(values)) {
			const { buf, blobs } = encodeInto(list, layout, values.table, statements);
			return { statements, payload: buf, blobs };
		}

		const elementValue = (index: number) => values[index] ?? f.nil();
		const rest = values.slice(list.elements.length);
		if (rest.length > 0 && !list.rest) fail("more arguments than the list has elements");

		// The rest count is known here, so its varint is a constant: literal bytes, no helper call.
		const countBytes = staticVarint(rest.length);

		const total = new Sum();
		list.elements.forEach((element, index) => total.add(emitSize(element, elementValue(index), statements)));
		if (list.rest) {
			total.add(countBytes.length);
			for (const value of rest) total.add(emitSize(list.rest, value, statements));
		}

		const size = total.build();
		const buf = uid("buf");
		statements.push(constDecl(buf, bufferCall("create", [size])));
		const blobs = layout.blobs ? uid("blobs") : undefined;
		if (blobs) statements.push(constDecl(blobs, construct("Array", []), T.blobs()));

		const variable = f.is.number(size) ? undefined : uid("o");
		if (variable) statements.push(letDecl(variable, num(0)));

		const ctx: Ctx = { buf, blobs, cursor: { variable, base: variable, offset: 0 }, out: statements };
		list.elements.forEach((element, index) => emitWrite(element, elementValue(index), ctx));
		if (list.rest) {
			for (const byte of countBytes) {
				ctx.out.push(f.statement(bufferCall("writeu8", [buf, at(ctx), num(byte)])));
				ctx.cursor.offset += 1;
			}
			for (const value of rest) emitWrite(list.rest, value, ctx);
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

	/** The argument list a tuple type describes, with Promise elements unwrapped. */
	function listOf(type: ts.Type): ListKind {
		if (!isTupleType(state, type)) {
			return { kind: "list", elements: [unwrapPromise(state, type)] };
		}

		const elements = new Array<Shape>();
		let rest: ts.Type | undefined;
		const types = typeChecker.getTypeArguments(type);
		for (let i = 0; i < types.length; i++) {
			const element = unwrapPromise(state, types[i]);
			const flags = type.target.elementFlags[i];
			const declaration = type.target.labeledElementDeclarations?.[i];
			registerDeclaration(declaration, types[i], (flags & ts.ElementFlags.Rest) !== 0);
			if (flags & ts.ElementFlags.Rest) {
				rest = element;
			} else if (flags & ts.ElementFlags.Optional && !hasUndefined(element)) {
				elements.push({ kind: "optional", inner: element });
			} else {
				elements.push(element);
			}
		}

		return { kind: "list", elements, rest };
	}

	/**
	 * `const buf = buffer.create(<size>)`, the blob list when the type has blob slots, the writes,
	 * and `return buf, blobs`.
	 */
	function encodeBody(shape: Shape, layout: Layout, value: ts.Identifier): ts.Statement[] {
		const body = new Array<ts.Statement>();
		const { buf, blobs } = encodeInto(shape, layout, value, body);
		body.push(f.returnStatement(blobs ? f.call("$tuple", [buf, blobs]) : buf));
		return body;
	}

	/** The size pass, the buffer, the blob list when the type has blob slots, and the writes. */
	function encodeInto(shape: Shape, layout: Layout, value: ts.Expression, body: ts.Statement[]) {
		const size = emitSize(shape, value, body);

		const buf = uid("buf");
		body.push(constDecl(buf, bufferCall("create", [size])));

		const blobs = layout.blobs ? uid("blobs") : undefined;
		if (blobs) body.push(constDecl(blobs, construct("Array", []), T.blobs()));

		const top = isKind(shape) ? undefined : hoist(shape);
		if (top) {
			body.push(f.statement(f.call(top.write, blobs ? [buf, num(0), value, blobs] : [buf, num(0), value])));
		} else {
			const variable = layout.size === undefined ? uid("o") : undefined;
			if (variable) body.push(letDecl(variable, num(0)));
			emitWrite(shape, value, { buf, blobs, cursor: { variable, base: variable, offset: 0 }, out: body });
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
		const top = isKind(shape) ? undefined : hoist(shape);
		if (top) {
			const value = uid("value");
			const end = uid("o");
			body.push(
				constDecl(
					f.arrayBindingDeclaration([value, end]),
					f.call(top.read, blobs ? [buf, num(0), blobs] : [buf, num(0)]),
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
			return { kind: "union", alternatives: branches.map((branch) => ({ shape: branch, type: branch })) };
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
				: { kind: "literals", values: literals };
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
			return { kind: "array", element };
		}

		if (type.getCallSignatures().length > 0) fail("functions cannot be sent");

		// `object`, and whatever else has no declaration behind it, has no structure to write.
		const symbol = type.getSymbol();
		if (!symbol) return { kind: "blob" };

		if (symbol === resolve("Map") || symbol === resolve("ReadonlyMap")) {
			const [key, value] = typeChecker.getTypeArguments(type as ts.TypeReference);
			if (!key || !value) fail("a Map without key and value types");
			return { kind: "map", key, value };
		}

		if (symbol === resolve("Set") || symbol === resolve("ReadonlySet")) {
			const [element] = typeChecker.getTypeArguments(type as ts.TypeReference);
			if (!element) fail("a Set without an element type");
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
		// structure a plain table could stand in for; a global's name is also what `typeof` reports.
		if (isRobloxType(symbol)) return { kind: "blob", typeofName: global ? symbol.name : undefined };
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

	function classifyUnion(type: ts.UnionType): Kind {
		if (type === typeChecker.getBooleanType()) return { kind: "boolean" };

		const { enums, literals, types } = simplifyUnion(type);
		const [isOptional, members] = extractTypes(typeChecker, types);
		const alternatives = new Array<Alternative>();

		for (const member of members) alternatives.push({ shape: member, type: member });
		for (const name of enums) alternatives.push({ shape: { kind: "enum", name } });
		if (literals.length === 1) alternatives.push({ shape: { kind: "constant", value: literals[0] } });
		if (literals.length > 1) alternatives.push({ shape: { kind: "literals", values: literals } });

		let inner: Shape;
		if (alternatives.length === 0) inner = { kind: "nothing" };
		else if (alternatives.length === 1) inner = alternatives[0].shape;
		// A one-byte tag numbers at most 256 members; past that the value travels whole.
		else if (alternatives.length > 0xff) inner = { kind: "blob" };
		else inner = { kind: "union", alternatives: orderAlternatives(type, alternatives) };

		if (isOptional) return { kind: "optional", inner };
		return describe(inner);
	}

	/**
	 * Union members in the order they were written: `{ Coins } | { Items }` numbers Coins 0 and Items
	 * 1. TypeScript lists them by internal id instead, so the order comes from the union's type node:
	 * an alias's own declaration, or the first property, parameter or type argument seen declaring
	 * it. Members that node does not account for (a generic alias instantiation, say) keep
	 * TypeScript's order after the others; a union with no node at all keeps it throughout.
	 */
	function orderAlternatives(type: ts.UnionType, alternatives: Alternative[]): Alternative[] {
		const node = unionNodes.get(type) ?? aliasNode(type);
		if (!node) return alternatives;

		const positions = new Map<Alternative, number>();
		for (const member of node.types) {
			const memberType = typeChecker.getTypeFromTypeNode(member);
			for (const constituent of memberType.isUnion() ? memberType.types : [memberType]) {
				const alternative = alternativeFor(alternatives, constituent);
				if (alternative && !positions.has(alternative)) positions.set(alternative, positions.size);
			}
		}

		const rank = (alternative: Alternative) =>
			positions.get(alternative) ?? positions.size + alternatives.indexOf(alternative);
		return [...alternatives].sort((a, b) => rank(a) - rank(b));
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
	 * Remembers where a type was written, walking into the node (array elements, type arguments, tuple
	 * elements, inline object members) so that anonymous unions inside get their order from the source
	 * too. The first place a type is seen wins; an aliased union is looked up on its own declaration.
	 */
	function registerTypeNode(node: ts.TypeNode | undefined, type: ts.Type | undefined): void {
		if (!node || !type) return;
		if (ts.isParenthesizedTypeNode(node)) return registerTypeNode(node.type, type);

		if (ts.isUnionTypeNode(node)) {
			if (!unionNodes.has(type)) unionNodes.set(type, node);
			return;
		}

		if (ts.isArrayTypeNode(node)) {
			const element = typeChecker.isArrayType(type)
				? typeChecker.getTypeArguments(type as ts.TypeReference)[0]
				: undefined;
			return registerTypeNode(node.elementType, element);
		}

		if (ts.isTypeReferenceNode(node) && node.typeArguments) {
			const isReference =
				(type.flags & ts.TypeFlags.Object) !== 0 &&
				((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
			if (!isReference) return;

			const args = typeChecker.getTypeArguments(type as ts.TypeReference);
			node.typeArguments.forEach((argument, index) => registerTypeNode(argument, args[index]));
			return;
		}

		if (ts.isTupleTypeNode(node) && isTupleType(state, type)) {
			const args = typeChecker.getTypeArguments(type);
			node.elements.forEach((element, index) => {
				if (ts.isNamedTupleMember(element))
					return registerElement(element.type, args[index], element.dotDotDotToken !== undefined);
				if (ts.isRestTypeNode(element)) return registerElement(element.type, args[index], true);
				if (ts.isOptionalTypeNode(element)) return registerTypeNode(element.type, args[index]);
				registerTypeNode(element, args[index]);
			});
			return;
		}

		if (ts.isTypeLiteralNode(node)) {
			for (const member of node.members) {
				if (!ts.isPropertySignature(member) || !member.type) continue;
				const name =
					ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
				if (name !== undefined) registerTypeNode(member.type, typeChecker.getTypeOfPropertyOfType(type, name));
			}
		}
	}

	/** A tuple element or parameter: a rest element's node is the array, its type the element. */
	function registerElement(node: ts.TypeNode, type: ts.Type | undefined, rest: boolean) {
		if (!rest) return registerTypeNode(node, type);
		if (ts.isArrayTypeNode(node)) return registerTypeNode(node.elementType, type);
		if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1) {
			return registerTypeNode(node.typeArguments[0], type);
		}
	}

	/** A property's, parameter's or tuple member's declared type node is where its unions were written. */
	function registerDeclaration(declaration: ts.Declaration | undefined, type: ts.Type, rest = false) {
		if (!declaration) return;
		if (
			ts.isPropertySignature(declaration) ||
			ts.isPropertyDeclaration(declaration) ||
			ts.isParameter(declaration) ||
			ts.isNamedTupleMember(declaration)
		) {
			if (declaration.type) registerElement(declaration.type, type, rest);
		}
	}

	function classifyIntersection(type: ts.IntersectionType): Kind {
		// `LuaTuple<T>` is `T & { LUA_TUPLE: never }`: several values at runtime, never a table.
		if (type.types.some((member) => member.getProperty("LUA_TUPLE") !== undefined)) {
			fail("a LuaTuple is several values at runtime, not a table; declare a tuple type such as `[A, B]` instead");
		}

		const brand = findBrand(type);
		const disjoint = type.types.find((member) => (member.flags & TYPE_FLAG_DISJOINT_DOMAINS) !== 0);
		if (disjoint) {
			if (disjoint.flags & ts.TypeFlags.Number) {
				if (brand === VARINT_BRAND) return { kind: "varint" };
				return { kind: "number", width: brand && NUMBER_BRANDS.has(brand) ? (brand as Width) : "f64" };
			}

			if (disjoint.flags & ts.TypeFlags.String) {
				return { kind: "string", length: (brand && STRING_BRANDS[brand]) || "v" };
			}

			return describe(disjoint);
		}

		const bufferSymbol = resolve("buffer");
		if (type.types.some((member) => member.getSymbol() === bufferSymbol)) {
			return { kind: "buffer", length: (brand && BUFFER_BRANDS[brand]) || "v" };
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

	/** The literal in `number & { __brand: "u8" }`, whatever the property is called. */
	function findBrand(type: ts.IntersectionType): string | undefined {
		for (const member of type.types) {
			if ((member.flags & ts.TypeFlags.Object) === 0) continue;

			for (const property of member.getProperties()) {
				const propertyType = typeChecker.getTypeOfPropertyOfType(member, property.name);
				if (propertyType?.isStringLiteral()) {
					const brand = propertyType.value;
					if (NUMBER_BRANDS.has(brand) || brand === VARINT_BRAND) return brand;
					if (brand in STRING_BRANDS || brand in BUFFER_BRANDS) return brand;
				}
			}
		}
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

		// Declaration order, which every compilation of the same source shares.
		const fields = properties.map((property) => {
			const propertyType = typeChecker.getTypeOfPropertyOfType(type, property.name)!;
			if (propertyType.getCallSignatures().length > 0) fail(`property '${property.name}' is a function`);
			registerDeclaration(property.valueDeclaration, propertyType);

			const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 && !hasUndefined(propertyType);
			const shape: Shape = optional ? { kind: "optional", inner: propertyType } : propertyType;
			return { name: property.name, shape };
		});

		return { kind: "object", fields };
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
			return { size: undefined, min: 0, blobs: false };
		}

		visiting.add(shape);
		const before = provisional;
		const layout = computeLayout(shape);
		visiting.delete(shape);

		// A result that saw a cycle is only final for the type that closes it, at the top of the chain.
		if (provisional === before || visiting.size === 0) layouts.set(shape, layout);
		if (visiting.size === 0) provisional = 0;

		return layout;
	}

	function computeLayout(shape: Shape): Layout {
		if (!isKind(shape)) {
			trail.push(shape);
			const layout = layoutOf(describe(shape));
			trail.pop();
			return layout;
		}

		const fixed = (size: number, blobs = false): Layout => ({ size, min: size, blobs });
		const kind = shape;
		switch (kind.kind) {
			case "number":
				return fixed(WIDTH_SIZE[kind.width]);
			case "varint":
				return { size: undefined, min: 1, blobs: false };
			case "boolean":
				return fixed(1);
			case "string":
			case "buffer":
				return { size: undefined, min: lengthMin(kind.length), blobs: false };
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
				return { size: undefined, min: 1, blobs: inner.blobs };
			}
			case "array":
			case "set": {
				const element = layoutOf(kind.element);
				return { size: undefined, min: 1, blobs: element.blobs };
			}
			case "map": {
				const key = layoutOf(kind.key);
				const value = layoutOf(kind.value);
				return { size: undefined, min: 1, blobs: key.blobs || value.blobs };
			}
			case "list": {
				const layout = sumLayouts(kind.elements.map((element) => layoutOf(element)));
				if (kind.rest) {
					const rest = layoutOf(kind.rest);
					return { size: undefined, min: layout.min + 1, blobs: layout.blobs || rest.blobs };
				}

				return layout;
			}
			case "object":
				return sumLayouts(kind.fields.map((field) => layoutOf(field.shape)));
			case "union": {
				const members = kind.alternatives.map((alternative) => layoutOf(alternative.shape));
				const sizes = new Set(members.map((member) => member.size));
				const size = sizes.size === 1 && !sizes.has(undefined) ? 1 + members[0].size! : undefined;
				return {
					size,
					min: 1 + Math.min(...members.map((member) => member.min)),
					blobs: members.some((member) => member.blobs),
				};
			}
		}
	}

	function sumLayouts(layouts: Layout[]): Layout {
		let size: number | undefined = 0;
		let min = 0;
		let blobs = false;
		for (const layout of layouts) {
			size = size === undefined || layout.size === undefined ? undefined : size + layout.size;
			min += layout.min;
			blobs ||= layout.blobs;
		}

		return { size, min, blobs };
	}

	// --- hoisting ------------------------------------------------------------------------------------

	/** Named object-like types with a variable size get their own functions; everything else inlines. */
	function hoist(type: ts.Type): Hoisted | undefined {
		const existing = hoisted.get(type);
		if (existing) return existing;

		const name = hoistName(type);
		if (name === undefined) return;

		const layout = layoutOf(type);
		if (layout.size !== undefined) return;

		// Only structured types are worth a function; a named alias of a string or an array inlines.
		const structure = describe(type).kind;
		if (structure !== "object" && structure !== "union" && structure !== "list") return;

		const info: Hoisted = { size: uid(`s_${name}`), write: uid(`w_${name}`), read: uid(`r_${name}`), layout };
		hoisted.set(type, info);

		const withBlobs = <U>(list: U[], entry: U) => (layout.blobs ? [...list, entry] : list);
		const blobsParameter: [string, ts.TypeNode] = ["blobs", T.blobs()];
		const writeParameters: Array<[string, ts.TypeNode]> = [
			["buf", T.buffer()],
			["o", T.number()],
			["v", T.unknown()],
		];
		const readParameters: Array<[string, ts.TypeNode]> = [
			["buf", T.buffer()],
			["o", T.number()],
		];
		declarations.push(letDecl(info.size, undefined, T.fn([["v", T.unknown()]], T.number())));
		declarations.push(letDecl(info.write, undefined, T.fn(withBlobs(writeParameters, blobsParameter), T.number())));
		declarations.push(
			letDecl(
				info.read,
				undefined,
				T.fn(withBlobs(readParameters, blobsParameter), T.tuple([T.unknown(), T.number()])),
			),
		);

		// The bodies are built after the identifiers exist, which is what lets a type refer to itself.
		const kind = describe(type);
		trail.push(type);

		const value = parameter("v");
		const sizeBody = new Array<ts.Statement>();
		const size = emitSize(kind, value, sizeBody);
		sizeBody.push(f.returnStatement(size));
		definitions.push(assign(info.size, f.arrowFunction(f.block(sizeBody), [f.parameterDeclaration(value)])));

		const buf = uid("buf");
		const o = uid("o");
		const blobs = layout.blobs ? uid("blobs") : undefined;
		const parameters = (...names: ts.Identifier[]) => names.map((id) => f.parameterDeclaration(id));

		const writeBody = new Array<ts.Statement>();
		const writeCtx: Ctx = { buf, blobs, cursor: { variable: o, base: o, offset: 0 }, out: writeBody };
		emitWrite(kind, value, writeCtx);
		sync(writeCtx);
		writeBody.push(f.returnStatement(o));
		definitions.push(
			assign(info.write, f.arrowFunction(f.block(writeBody), parameters(...withBlobs([buf, o, value], blobs!)))),
		);

		const readBody = new Array<ts.Statement>();
		const readCtx: Ctx = { buf, blobs, cursor: { variable: o, base: o, offset: 0 }, out: readBody };
		const result = emitRead(kind, readCtx);
		const bound = f.is.identifier(result) || isLiteral(result) ? result : bind(readBody, result, "value");
		sync(readCtx);
		readBody.push(f.returnStatement(f.call("$tuple", [bound, o])));
		definitions.push(
			assign(info.read, f.arrowFunction(f.block(readBody), parameters(...withBlobs([buf, o], blobs!)))),
		);

		trail.pop();
		return info;
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
			tables.push(constDecl(guard, buildGuardFromType(state, diagnosticNode, type, file)));
			guards.set(type, guard);
		}

		return guard;
	}

	/** `Enum.X` items by `Value`, built once: values are not always below 256, so they are sent as u16. */
	function enumTableFor(name: string): ts.Identifier {
		let table = enumTables.get(name);
		if (!table) {
			table = uid(`enum_${name}`);
			const item = uid("item");
			tables.push(
				constDecl(table, construct("Map", []), f.referenceType("Map", [T.number(), T.enumItem()])),
				forOf(item, f.call(prop(prop("Enum", name), "GetEnumItems"), []), [
					f.statement(f.call(prop(table, "set"), [prop(item, "Value"), item])),
				]),
			);
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
			const pairs = kind.values.map((value, index) => f.array([value, num(index)], false));
			tables.push(
				constDecl(entry.list, f.array(kind.values, false), T.blobs()),
				constDecl(
					entry.index,
					construct("Map", [f.array(pairs)], [T.defined(), T.number()]),
					f.referenceType("Map", [T.defined(), T.number()]),
				),
			);
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
		varint = { size: uid("vsize"), write: uid("vwrite"), read: uid("vread") };

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
									f.call(prop("math", "floor"), [f.binary(wn, ts.SyntaxKind.SlashToken, num(128))]),
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
								ifStatement(below(byte, 128), [f.returnStatement(f.call("$tuple", [rn, ro]))]),
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

		return varint;
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
	 * The order the members are tested in when encoding: every member with a test of its own first,
	 * a blob that matches anything last. The tag written is still the member's own index.
	 */
	function evaluationOrder(union: UnionKind): number[] {
		const catchAll = (index: number) => {
			const kind = describe(union.alternatives[index].shape);
			return kind.kind === "blob" && kind.typeofName === undefined ? 1 : 0;
		};

		return union.alternatives.map((_, index) => index).sort((a, b) => catchAll(a) - catchAll(b));
	}

	/**
	 * A cheap test for an object member of a union: its discriminant compared (`v.kind == "a"`), or
	 * else the presence of a required key no other object member has (`v.Coins ~= nil`). Neither
	 * leaves a guard in the output; a member with no such test falls back to one.
	 */
	function objectTest(union: UnionKind, kind: ObjectKind, record: ts.Expression): ts.Expression | undefined {
		const discriminant = discriminantOf(union);
		const field = discriminant !== undefined ? kind.fields.find((field) => field.name === discriminant) : undefined;
		if (field) {
			const constant = describe(field.shape) as Extract<Kind, { kind: "constant" }>;
			return equals(fieldAccess(record, field.name), constant.value);
		}

		// A collection among the members could hold any key, so presence is only trusted when the
		// other members are objects or not tables at all.
		const others = union.alternatives.map((other) => describe(other.shape)).filter((other) => other !== kind);
		if (others.some((other) => TABLE_KINDS.has(other.kind) && other.kind !== "object")) return;

		const unique = kind.fields.find((candidate) => {
			const shape = describe(candidate.shape);
			if (shape.kind === "optional" || shape.kind === "nothing") return false;
			return others.every(
				(other) => other.kind !== "object" || !other.fields.some((field) => field.name === candidate.name),
			);
		});
		if (unique) return notNil(fieldAccess(record, unique.name));
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
			if (ts.isAsExpression(value) && f.is.identifier(value.expression)) return value;
		}

		const id = uid(hint);
		out.push(constDecl(id, value, type));
		return id;
	}

	function isNilLiteral(expression: ts.Expression) {
		return ts.isIdentifier(expression) && expression.text === "undefined";
	}

	function isLiteral(expression: ts.Expression) {
		return f.is.string(expression) || f.is.number(expression) || f.is.bool(expression) || f.is.nil(expression);
	}

	function fieldAccess(object: ts.Expression, name: string): ts.Expression {
		return IDENTIFIER.test(name)
			? factory.createPropertyAccessExpression(object, name)
			: factory.createElementAccessExpression(object, f.string(name));
	}

	function path(object: ts.Expression, names: string[]): ts.Expression {
		return names.reduce((current, name) => prop(current, name), object);
	}

	// --- size ----------------------------------------------------------------------------------------

	/** The byte count of `value`: a constant for fixed layouts, otherwise an expression (plus statements). */
	function emitSize(shape: Shape, value: ts.Expression, out: ts.Statement[]): ts.Expression {
		const layout = layoutOf(shape);
		if (layout.size !== undefined) return num(layout.size);

		if (!isKind(shape)) {
			const info = hoist(shape);
			if (info) return f.call(info.size, [value]);
		}

		const kind = describe(shape);
		switch (kind.kind) {
			case "string":
				return sizeWithLength(out, kind.length, f.call(prop(f.as(value, T.string()), "size"), []));
			case "buffer":
				return sizeWithLength(out, kind.length, bufferCall("len", [f.as(value, T.buffer())]));
			case "varint":
				return f.call(varintHelpers().size, [f.as(value, T.number())]);
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
				body.push(addAssign(total, emitSize(kind.inner, v, body)));
				out.push(ifStatement(notNil(v), body));
				return total;
			}
			case "array": {
				const array = bind(out, f.as(value, T.array()), "array");
				const count = bind(out, f.call(prop(array, "size"), []), "n");
				const prefix = f.call(varintHelpers().size, [count]);
				const element = layoutOf(kind.element);
				if (element.size !== undefined) return countedSize(prefix, count, element.size);

				const total = uid("size");
				const item = uid("item");
				out.push(letDecl(total, prefix));
				const body = new Array<ts.Statement>();
				body.push(addAssign(total, emitSize(kind.element, item, body)));
				out.push(forOf(item, array, body));
				return total;
			}
			case "set": {
				const set = bind(out, f.as(value, T.set()), "set");
				const element = layoutOf(kind.element);
				const item = uid("item");
				return countedInPass(out, set, item, (body) =>
					element.size !== undefined ? num(element.size) : emitSize(kind.element, item, body),
				);
			}
			case "map": {
				const map = bind(out, f.as(value, T.map()), "map");
				const key = uid("key");
				const entry = uid("entry");
				return countedInPass(out, map, f.arrayBindingDeclaration([key, entry]), (body) =>
					add(emitSize(kind.key, key, body), emitSize(kind.value, entry, body)),
				);
			}
			case "list": {
				const list = bind(out, f.as(value, T.array()), "list");
				const total = new Sum();
				kind.elements.forEach((element, index) => {
					total.add(emitSize(element, f.elementAccessExpression(list, num(index)), out));
				});

				if (kind.rest) {
					const rest = layoutOf(kind.rest);
					const count = restCount(out, list, kind.elements.length);
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
					const element = f.elementAccessExpression(list, f.binary(index, ts.SyntaxKind.MinusToken, num(1)));
					body.push(addAssign(sum, emitSize(kind.rest, element, body)));
					out.push(
						forOf(index, range(num(kind.elements.length + 1), add(count, kind.elements.length)), body),
					);
					return sum;
				}

				return total.build();
			}
			case "object": {
				const object = bind(out, f.as(value, T.record()), "object");
				const total = new Sum();
				for (const field of kind.fields) {
					total.add(emitSize(field.shape, fieldAccess(object, field.name), out));
				}

				return total.build();
			}
			case "union": {
				const v = bind(out, value, "v");
				const total = uid("size");
				out.push(letDecl(total, num(1)));

				let chain: ts.Statement | undefined;
				for (const i of evaluationOrder(kind).reverse()) {
					const alternative = kind.alternatives[i];
					const layout = layoutOf(alternative.shape);
					const body = new Array<ts.Statement>();
					const size = layout.size !== undefined ? num(layout.size) : emitSize(alternative.shape, v, body);
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

	// --- write ---------------------------------------------------------------------------------------

	function emitWrite(shape: Shape, value: ts.Expression, ctx: Ctx): void {
		if (!isKind(shape)) {
			const info = hoist(shape);
			if (info) {
				const args = [ctx.buf, at(ctx), value];
				if (info.layout.blobs) args.push(ctx.blobs!);
				ctx.out.push(assign(ctx.cursor.variable!, f.call(info.write, args)));
				ctx.cursor.base = ctx.cursor.variable;
				ctx.cursor.offset = 0;
				return;
			}
		}

		const kind = describe(shape);
		switch (kind.kind) {
			case "number":
				ctx.out.push(
					f.statement(bufferCall(`write${kind.width}`, [ctx.buf, at(ctx), f.as(value, T.number())])),
				);
				ctx.cursor.offset += WIDTH_SIZE[kind.width];
				return;
			case "varint":
				writeVarint(ctx, f.as(value, T.number()));
				return;
			case "boolean":
				ctx.out.push(
					f.statement(
						bufferCall("writeu8", [
							ctx.buf,
							at(ctx),
							conditional(equals(value, f.bool(true)), num(1), num(0)),
						]),
					),
				);
				ctx.cursor.offset += 1;
				return;
			case "string": {
				const text = bind(ctx.out, f.as(value, T.string()), "text");
				const length = bind(ctx.out, f.call(prop(text, "size"), []), "length");
				writeLength(ctx, kind.length, length, "string");
				ctx.out.push(f.statement(bufferCall("writestring", [ctx.buf, at(ctx), text])));
				advanceBy(ctx, length);
				return;
			}
			case "buffer": {
				const bytes = bind(ctx.out, f.as(value, T.buffer()), "bytes");
				const length = bind(ctx.out, bufferCall("len", [bytes]), "length");
				writeLength(ctx, kind.length, length, "buffer");
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
				const slot = bind(ctx.out, f.call(prop(index, "get"), [f.as(v, T.defined())]), "index");
				ctx.out.push(ifStatement(isNil(slot), [raise("value is not one of the literals its type allows")]));
				const width = kind.values.length > 0xff ? "u16" : "u8";
				ctx.out.push(f.statement(bufferCall(`write${width}`, [ctx.buf, at(ctx), slot])));
				ctx.cursor.offset += WIDTH_SIZE[width];
				return;
			}
			case "blob": {
				const blob = bind(ctx.out, value, "blob");
				const blobs = ctx.blobs!;
				ctx.out.push(
					ifStatement(
						notNil(blob),
						[
							f.statement(f.call(prop(blobs, "push"), [f.as(blob, T.defined())])),
							f.statement(bufferCall("writeu32", [ctx.buf, at(ctx), f.call(prop(blobs, "size"), [])])),
						],
						[f.statement(bufferCall("writeu32", [ctx.buf, at(ctx), num(0)]))],
					),
				);
				ctx.cursor.offset += BLOB_SIZE;
				return;
			}
			case "datatype": {
				const datatype = bind(ctx.out, f.as(value, f.referenceType(kind.name)), kind.name.toLowerCase());
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
						f.call(prop(f.as(value, f.referenceType("CFrame")), "GetComponents"), []),
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
					f.statement(bufferCall("writeu16", [ctx.buf, at(ctx), prop(f.as(value, T.enumItem()), "Value")])),
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
				const array = bind(ctx.out, f.as(value, T.array()), "array");
				writeVarint(ctx, f.call(prop(array, "size"), []));
				const item = uid("item");
				ctx.out.push(
					forOf(
						item,
						array,
						branch(ctx, (child) => emitWrite(kind.element, item, child)),
					),
				);
				return;
			}
			case "set": {
				const set = bind(ctx.out, f.as(value, T.set()), "set");
				writeCounted(ctx, set, (item, child) => emitWrite(kind.element, item, child));
				return;
			}
			case "map": {
				const map = bind(ctx.out, f.as(value, T.map()), "map");
				const key = uid("key");
				const entry = uid("entry");
				writeCounted(
					ctx,
					map,
					(_, child) => {
						emitWrite(kind.key, key, child);
						emitWrite(kind.value, entry, child);
					},
					f.arrayBindingDeclaration([key, entry]),
				);
				return;
			}
			case "list": {
				const list = bind(ctx.out, f.as(value, T.array()), "list");
				kind.elements.forEach((element, index) => {
					emitWrite(element, f.elementAccessExpression(list, num(index)), ctx);
				});

				if (kind.rest) {
					const count = restCount(ctx.out, list, kind.elements.length);
					writeVarint(ctx, count);
					const index = uid("i");
					const element = f.elementAccessExpression(list, f.binary(index, ts.SyntaxKind.MinusToken, num(1)));
					ctx.out.push(
						forOf(
							index,
							range(num(kind.elements.length + 1), add(count, kind.elements.length)),
							branch(ctx, (child) => emitWrite(kind.rest!, element, child)),
						),
					);
				}
				return;
			}
			case "object": {
				const object = bind(ctx.out, f.as(value, T.record()), "object");
				for (const field of kind.fields) {
					emitWrite(field.shape, fieldAccess(object, field.name), ctx);
				}
				return;
			}
			case "union": {
				const v = bind(ctx.out, value, "v");
				const layout = layoutOf(kind);
				const start = ctx.cursor.offset;
				let chain: ts.Statement = f.block([raise("value matches none of the union's members")]);
				for (const i of evaluationOrder(kind).reverse()) {
					const alternative = kind.alternatives[i];
					const body = branch(ctx, (child) => {
						child.out.push(f.statement(bufferCall("writeu8", [child.buf, at(child), num(i)])));
						child.cursor.offset += 1;
						emitWrite(alternative.shape, v, child);
					});
					chain = ifStatement(discriminate(kind, i, v), body, chain);
				}

				ctx.out.push(chain);
				if (layout.size !== undefined) ctx.cursor.offset = start + layout.size;
				return;
			}
		}
	}

	/** How many rest elements a list holds: never negative, since absent trailing optionals shorten it. */
	function restCount(out: ts.Statement[], list: ts.Expression, fixed: number): ts.Identifier {
		const count = uid("count");
		const length = f.binary(f.call(prop(list, "size"), []), ts.SyntaxKind.MinusToken, num(fixed));
		out.push(constDecl(count, f.call(prop("math", "max"), [length, num(0)])));
		return count;
	}

	/** The length prefix of a string or buffer: a varint, or a fixed width refusing what it cannot hold. */
	function writeLength(ctx: Ctx, width: LengthWidth, length: ts.Expression, what: string) {
		if (width === "v") return writeVarint(ctx, length);

		if (width !== "u32") {
			ctx.out.push(
				ifStatement(f.binary(length, ts.SyntaxKind.GreaterThanToken, num(LENGTH_MAX[width])), [
					raise(`${what} is longer than its ${width} length prefix allows`),
				]),
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
		const alternative = union.alternatives[index];
		const kind = describe(alternative.shape);

		if (kind.kind === "object") {
			const test = objectTest(union, kind, f.as(value, T.record()));
			if (test) {
				// Indexing is only safe once the value is known to be a table.
				const tables = union.alternatives.every((other) => TABLE_KINDS.has(describe(other.shape).kind));
				return tables ? test : f.binary(typeOfIs(value, "table"), ts.SyntaxKind.AmpersandAmpersandToken, test);
			}
		}

		switch (kind.kind) {
			case "number":
			case "varint":
				return typeOfIs(value, "number");
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
				return f.binary(
					typeOfIs(value, "EnumItem"),
					ts.SyntaxKind.AmpersandAmpersandToken,
					equals(prop(f.as(value, T.enumItem()), "EnumType"), prop("Enum", kind.name)),
				);
			case "literals":
				return notNil(f.call(prop(literalTablesFor(kind).index, "get"), [f.as(value, T.defined())]));
			case "constant":
				return equals(value, kind.value);
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
				ctx.out.push(constDecl(f.arrayBindingDeclaration([value, next]), f.call(info.read, args)));
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
				const bytes = bind(ctx.out, bufferCall("create", [length]), "bytes");
				ctx.out.push(f.statement(bufferCall("copy", [bytes, num(0), ctx.buf, at(ctx), length])));
				advanceBy(ctx, length);
				return bytes;
			}
			case "constant":
				return kind.value;
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
								assign(
									f.elementAccessExpression(
										list,
										f.binary(index, ts.SyntaxKind.PlusToken, num(kind.elements.length - 1)),
									),
									element,
								),
							);
						}),
					),
				);
				return list;
			}
			case "object": {
				const fields = kind.fields.map((field) =>
					f.propertyAssignmentDeclaration(field.name, readInto(field.shape, ctx, field.name)),
				);
				return f.object(fields);
			}
			case "union": {
				const layout = layoutOf(kind);
				const tag = bind(ctx.out, bufferCall("readu8", [ctx.buf, at(ctx)]), "tag");
				ctx.cursor.offset += 1;
				const start = ctx.cursor.offset;
				const value = uid("value");
				ctx.out.push(letDecl(value, undefined, T.unknown()));

				let chain: ts.Statement = f.block([raise(MALFORMED)]);
				for (let i = kind.alternatives.length - 1; i >= 0; i--) {
					const alternative = kind.alternatives[i];
					const body = branch(ctx, (child) =>
						child.out.push(assign(value, emitRead(alternative.shape, child))),
					);
					chain = ifStatement(equals(tag, num(i)), body, chain);
				}

				ctx.out.push(chain);
				if (layout.size !== undefined) ctx.cursor.offset = start + layout.size - 1;
				return value;
			}
		}
	}

	/** A read whose result is bound to a local in variable layouts; see {@link emitRead}. */
	function readInto(shape: Shape, ctx: Ctx, hint: string): ts.Expression {
		const value = emitRead(shape, ctx);
		if (!ctx.cursor.variable || f.is.identifier(value) || isLiteral(value)) return value;
		return bind(ctx.out, value, hint.replace(/\W/g, "_"));
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
	 * bytes cannot be bounded that way and get a plain cap instead.
	 */
	function readCount(ctx: Ctx, minimumElementSize: number): ts.Expression {
		const count = readVarint(ctx, "count");
		sync(ctx);

		if (minimumElementSize === 0) {
			ctx.out.push(
				ifStatement(f.binary(count, ts.SyntaxKind.GreaterThanToken, num(ZERO_SIZE_COUNT_MAX)), [
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
}
