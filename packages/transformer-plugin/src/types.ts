import type { NodeFactory } from "./plugin/nodes";

export interface TypeChecker {
	primitives: Record<PrimitiveTypeNames, Type>;
}

export interface PluginApi {
	factory: NodeFactory;

	registerMacroType(id: string, handler: (value: Type) => Node): void;
}

export type PrimitiveTypeNames =
	| "any"
	| "unknown"
	| "string"
	| "number"
	| "bigint"
	| "boolean"
	| "true"
	| "false"
	| "undefined"
	| "void"
	| "never";

export interface Type {
	/** @internal */
	id: number;

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
	 * Checks if this type is an array type. This includes objects in the usual sense, as well as functions.
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

	/**
	 * Checks if this type is a string literal
	 */
	isLiteral(type: "string"): this is LiteralType<string>;

	/**
	 * Checks if this type is a string literal
	 */
	isLiteral(type: "number"): this is LiteralType<number>;

	/**
	 * Checks if this type is a string literal
	 */
	isLiteral(type: "boolean"): this is LiteralType<boolean>;

	/**
	 * Checks if this type is one of the primitive types, such as `any`, `string`, `number`, etc.
	 */
	isPrimitive(primitive: PrimitiveTypeNames): boolean;

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

// TODO: TupleArrayType should extend ArrayType and support both ArrayType methods
export interface TupleArrayType extends Type {
	/**
	 * Returns the elements in this tuple.
	 */
	getElements(): TupleElement[];
}

export interface ArrayType extends Type {
	/**
	 * Returns the element type of the array, e.g the `T` in `Array<T>`.
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

export type NodeHint<T extends Node> = number & { _node_hint: T };

export interface Node {
	readonly _nominal_Node: unique symbol;

	/** @internal */
	id: NodeHint<this>;
}

export interface Expression extends Node {
	readonly _nominal_Expression: unique symbol;
}

export interface Statement extends Node {
	readonly _nominal_Statement: unique symbol;
}

export interface Declaration extends Node {
	readonly _nominal_Declaration: unique symbol;
}
