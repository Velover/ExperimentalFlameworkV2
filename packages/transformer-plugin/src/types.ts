/**
 * Public type surface for Flamework transformer plugins.
 *
 * Plugins run in-process alongside the transformer. Everything a plugin can observe about a
 * TypeScript type, and everything it can emit, goes through the interfaces in this file --
 * the transformer never hands out raw `ts.Type` or `ts.Node` values, so this surface stays
 * stable across TypeScript upgrades.
 */

export interface PluginApi {
	/**
	 * Builds the nodes that a macro type handler returns.
	 */
	factory: NodeFactory;

	/**
	 * The options this plugin was configured with in `tsconfig.json`.
	 *
	 * ```json
	 * { "transform": "rbxts-transformer-flamework", "plugins": [{ "path": "./my-plugin.js", "options": { "verbose": true } }] }
	 * ```
	 */
	options: Readonly<Record<string, unknown>>;

	/**
	 * Registers a handler for a macro type.
	 *
	 * The handler is invoked once per call site of any macro declared as
	 * `Modding.Intrinsic<"plugin", [id, T], R>`, and its result is inlined in place of the call.
	 */
	registerMacroType(id: string, handler: MacroTypeHandler): void;
}

export type MacroTypeHandler = (value: Type, context: MacroContext) => Node;

export interface MacroContext {
	/**
	 * Lifts an expression into a `const` at the top level of the file being compiled and returns
	 * an identifier referencing it.
	 *
	 * Use this when a macro would otherwise emit the same large value at many call sites; the
	 * hoisted constant is shared by every call site in the file that hoists an equal expression.
	 */
	hoist(expression: Expression, name?: string): Expression;

	/**
	 * Lifts a statement to the top level of the file being compiled.
	 */
	hoistStatement(statement: Statement): void;

	/**
	 * Reports a compile error pointing at this macro's call site, and aborts the macro.
	 */
	error(message: string): never;

	/**
	 * Reports a compile warning pointing at this macro's call site.
	 */
	warning(message: string): void;

	/**
	 * The absolute path of the file containing this call site.
	 */
	readonly fileName: string;
}

export type PrimitiveTypeNames =
	"any" | "unknown" | "string" | "number" | "bigint" | "boolean" | "true" | "false" | "undefined" | "void" | "never";

export interface Type {
	/**
	 * Checks if this type is a subtype of another type.
	 * This is equivalent to TypeScript's `extends` syntax.
	 *
	 * For example, `Cat` is a subtype of `Animal` and `"foobar"` is a subtype of `string`.
	 */
	isSubtypeOf(other: Type): boolean;

	/**
	 * Checks if this type is a supertype of another type.
	 * TypeScript does not have a direct syntax equivalent, but it's the same as reversing the order of `extends`.
	 *
	 * For example, `Animal` is a supertype of `Cat` and `string` is a supertype of `"foobar"`
	 */
	isSupertypeOf(other: Type): boolean;

	/**
	 * Checks whether this type is structurally equivalent to another.
	 *
	 * This is not an equality check, but a structural similarity check.
	 * For example, `{ a: string } & { b: number }` is equivalent to `{ a: string, b: number }`
	 */
	isEquivalentTo(other: Type): boolean;

	/**
	 * Checks if this type is an intersection type, giving access to additional methods.
	 */
	isIntersection(): this is UnionOrIntersectionType;

	/**
	 * Checks if this type is a union type, giving access to additional methods.
	 */
	isUnion(): this is UnionOrIntersectionType;

	/**
	 * Checks if this type is an object-like type. This includes objects in the usual sense, as well as functions.
	 */
	isObjectLike(): this is ObjectLikeType;

	/**
	 * Checks if this type is an array type.
	 */
	isArray(): this is ArrayType;

	/**
	 * Checks if this type is a tuple type.
	 */
	isTuple(): this is TupleArrayType;

	/**
	 * Checks if this type is any type of literal.
	 * You can optionally provide the type of literal, such as string or number.
	 */
	isLiteral(): this is LiteralType;
	isLiteral(type: "string"): this is LiteralType<string>;
	isLiteral(type: "number"): this is LiteralType<number>;
	isLiteral(type: "boolean"): this is LiteralType<boolean>;

	/**
	 * Checks if this type is one of the primitive types, such as `any`, `string`, `number`, etc.
	 */
	isPrimitive(primitive: PrimitiveTypeNames): boolean;

	/**
	 * Returns the type with `undefined` and `null` removed, or this type if it is not optional.
	 */
	getNonNullable(): Type;

	/**
	 * Whether `undefined` or `null` is assignable to this type.
	 */
	isOptional(): boolean;

	/**
	 * Returns the name of the type's symbol, if it has one.
	 *
	 * For example, the alias `type Foo = { a: string }` returns `"Foo"`.
	 */
	getName(): string | undefined;

	/**
	 * Converts this type into a string representation. Result may be truncated.
	 */
	toString(): string;
}

export interface UnionOrIntersectionType extends Type {
	/**
	 * Gets the constituents that make up this union or intersection type.
	 * The result of this method is unordered when called on a union.
	 *
	 * For example, the constituents of `A | B` and `A & B` is [A, B].
	 */
	getConstituents(): Type[];
}

/**
 * This type includes objects in the expected sense, as well as functions.
 */
export interface ObjectLikeType extends Type {
	/**
	 * Returns the fields that make up this object.
	 */
	getFields(): ObjectField[];

	/**
	 * Returns the index signatures that this object has.
	 */
	getIndexSignatures(): IndexSignature[];

	/**
	 * Returns the call signatures that this object has.
	 */
	getCallSignatures(): Signature[];

	/**
	 * Returns the construct signatures that this object has.
	 */
	getConstructSignatures(): Signature[];
}

export interface TupleArrayType extends ArrayType {
	/**
	 * Returns the elements in this tuple.
	 */
	getElements(): TupleElement[];
}

export interface ArrayType extends Type {
	/**
	 * Returns the element type of the array, e.g the `T` in `Array<T>`.
	 *
	 * For a tuple this is the union of every element type.
	 */
	getElementType(): Type;

	/**
	 * Checks if this is a `ReadonlyArray` type.
	 */
	isReadonly(): boolean;
}

export interface LiteralType<T = string | number | boolean> extends Type {
	/**
	 * Returns the literal value of this type.
	 */
	getLiteralValue(): T;
}

export interface TupleElement {
	name: string | undefined;
	type: Type;
	/** This is an element like `...string[]` */
	spread: boolean;
	optional: boolean;
}

export interface ObjectField {
	name: string;
	readonly: boolean;
	optional: boolean;
	type: Type;
}

export interface IndexSignature {
	key: Type;
	value: Type;
	readonly: boolean;
}

export interface Signature {
	inputs: Type[];
	output: Type;
}

declare const NodeBrand: unique symbol;

/**
 * An opaque handle to a node the transformer will emit. Construct these with {@link NodeFactory}.
 */
export interface Node {
	readonly [NodeBrand]: unknown;
}

export interface Expression extends Node {
	readonly [NodeBrand]: "expression";
}

export interface Statement extends Node {
	readonly [NodeBrand]: "statement";
}

export interface NodeFactory {
	expr: ExpressionFactory;
	stmt: StatementFactory;
}

export type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "??";

export interface ExpressionFactory {
	/** A string literal, e.g. `"foo"`. */
	string(value: string): Expression;

	/** A number literal, e.g. `1` or `-1`. */
	number(value: number): Expression;

	/** A boolean literal. */
	bool(value: boolean): Expression;

	/** The `undefined` identifier, which roblox-ts emits as `nil`. */
	nil(): Expression;

	/**
	 * An identifier.
	 *
	 * Pass `unique` to generate a name that cannot collide with anything else in the file.
	 */
	identifier(name: string, unique?: boolean): Expression;

	/** An array literal, e.g. `[a, b]`. */
	array(values: Expression[]): Expression;

	/**
	 * An object literal, e.g. `{ a: b }`.
	 *
	 * Accepts either a record or an ordered list of fields; use the list when key order matters.
	 */
	object(fields: Record<string, Expression> | ObjectLiteralField[]): Expression;

	/** A call, e.g. `target(a, b)`. */
	call(target: Expression, args?: Expression[]): Expression;

	/**
	 * A construction, e.g. `new target(a, b)`.
	 *
	 * Quoted because an unquoted `new(...)` member declares a construct signature, not a method.
	 */
	"new"(target: Expression, args?: Expression[]): Expression;

	/** A property access, e.g. `target.name`. */
	property(target: Expression, name: string): Expression;

	/** An element access, e.g. `target[index]`. */
	element(target: Expression, index: Expression): Expression;

	/** A binary expression, e.g. `left + right`. */
	binary(left: Expression, operator: BinaryOperator, right: Expression): Expression;

	/** A logical negation, e.g. `!value`. */
	not(value: Expression): Expression;

	/** A ternary, e.g. `condition ? whenTrue : whenFalse`. */
	conditional(condition: Expression, whenTrue: Expression, whenFalse: Expression): Expression;

	/** An arrow function, e.g. `(a, b) => body`. */
	arrow(parameters: string[], body: Expression | Statement[]): Expression;

	/** Wraps an expression in parentheses. */
	parenthesize(value: Expression): Expression;
}

export interface StatementFactory {
	/** A `const` declaration, e.g. `const name = value`. */
	variable(name: Expression, value: Expression): Statement;

	/** Promotes an expression to a statement. */
	expression(value: Expression): Statement;

	/** A `return` statement. */
	return(value?: Expression): Statement;

	/** A block of statements. */
	block(statements: Statement[]): Statement;

	/** An `if` statement, with an optional `else` branch. */
	if(condition: Expression, whenTrue: Statement, whenFalse?: Statement): Statement;
}

export interface ObjectLiteralField {
	name: string;
	value: Expression;
}
