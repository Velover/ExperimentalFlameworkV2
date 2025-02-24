import type {
	ArrayType,
	IndexSignature,
	LiteralType,
	ObjectField,
	ObjectLikeType,
	PrimitiveTypeNames,
	Signature,
	TupleArrayType,
	TupleElement,
	Type,
	UnionOrIntersectionType,
} from "../types";

type SerializedObject<T> = { [k in keyof T]: T[k] extends Type ? number : T[k] extends Type[] ? number[] : T[k] };
type Serialized<T> = T extends Array<infer U> ? SerializedObject<U>[] : SerializedObject<T>;

declare function $isSubtypeOf(id: number, other: number): boolean;
declare function $isSupertypeOf(id: number, other: number): boolean;
declare function $isArrayType(id: number, other: number): boolean;
declare function $isEquivalentTo(id: number, other: number): boolean;
declare function $isIntersection(id: number): boolean;
declare function $isUnion(id: number): boolean;
declare function $isObjectLikeType(id: number): boolean;
declare function $isArrayType(id: number): boolean;
declare function $isTupleType(id: number): boolean;
declare function $isLiteralType(id: number, kind?: string): boolean;
declare function $isPrimitiveType(id: number, kind?: string): boolean;
declare function $getConstituents(id: number): number[];
declare function $getFields(id: number): Serialized<ObjectField[]>;
declare function $getIndexSignatures(id: number): Serialized<IndexSignature[]>;
declare function $getSignatures(id: number, kind: "call" | "construct"): Serialized<Signature[]>;
declare function $getElements(id: number): Serialized<TupleElement[]>;
declare function $getElementType(id: number): number;
declare function $isReadonly(id: number): boolean;
declare function $getLiteralValue(id: number): string | number | boolean;
declare function $typeToString(id: number): string;

const TYPE_CACHE = new Map<number, TypeImpl>();

export function instantiateType(index: number) {
	const result = TYPE_CACHE.get(index);
	if (result) {
		return result as never;
	}

	const value = new TypeImpl(index);
	TYPE_CACHE.set(index, value);

	return value;
}

export class TypeImpl implements Type, UnionOrIntersectionType, ObjectLikeType, ArrayType, TupleArrayType, LiteralType {
	constructor(public id: number) {}

	// Type implementations
	isSubtypeOf(other: Type): boolean {
		return $isSubtypeOf(this.id, other.id);
	}

	isSupertypeOf(other: Type): boolean {
		return $isSupertypeOf(this.id, other.id);
	}

	isEquivalentTo(other: Type): boolean {
		return $isEquivalentTo(this.id, other.id);
	}

	isIntersection(): this is UnionOrIntersectionType {
		return $isIntersection(this.id);
	}

	isUnion(): this is UnionOrIntersectionType {
		return $isUnion(this.id);
	}

	isObjectLike(): this is ObjectLikeType {
		return $isObjectLikeType(this.id);
	}

	isArray(): this is ArrayType {
		return $isArrayType(this.id);
	}

	isTuple(): this is TupleArrayType {
		return $isTupleType(this.id);
	}

	isLiteral(type: "string"): this is LiteralType<string>;
	isLiteral(type: "number"): this is LiteralType<number>;
	isLiteral(type: "boolean"): this is LiteralType<boolean>;
	isLiteral(): this is LiteralType;
	isLiteral(type?: string): this is LiteralType {
		return $isLiteralType(this.id, type);
	}

	isPrimitive(primitive: PrimitiveTypeNames): boolean {
		return $isPrimitiveType(this.id, primitive);
	}

	// UnionOrIntersectionType implementations
	getConstituents(): Type[] {
		return $getConstituents(this.id).map(instantiateType);
	}

	// ObjectLikeType implementations
	getFields(): ObjectField[] {
		return $getFields(this.id).map((v) => ({
			name: v.name,
			readonly: v.readonly,
			type: instantiateType(v.type),
		}));
	}

	getIndexSignatures(): IndexSignature[] {
		return $getIndexSignatures(this.id).map((v) => ({
			key: instantiateType(v.key),
			value: instantiateType(v.value),
			readonly: v.readonly,
		}));
	}

	getCallSignatures(): Signature[] {
		return $getSignatures(this.id, "call").map((v) => ({
			inputs: v.inputs.map(instantiateType),
			output: instantiateType(v.output),
		}));
	}

	getConstructSignatures(): Signature[] {
		return $getSignatures(this.id, "construct").map((v) => ({
			inputs: v.inputs.map(instantiateType),
			output: instantiateType(v.output),
		}));
	}

	// TupleArrayType implementations
	getElements(): TupleElement[] {
		return $getElements(this.id).map((v) => ({
			name: v.name,
			optional: v.optional,
			spread: v.spread,
			type: instantiateType(v.type),
		}));
	}

	// ArrayType implementations
	getElementType(): Type {
		return instantiateType($getElementType(this.id));
	}

	isReadonly(): boolean {
		return $isReadonly(this.id);
	}

	// LiteralType implementations

	getLiteralValue(): string | number | boolean {
		return $getLiteralValue(this.id);
	}

	toString(): string {
		return $typeToString(this.id);
	}
}
