import ts from "typescript";
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
} from "@flamework-experimental/transformer-plugin";
import type { TransformState } from "../../classes/transformState";
import { isArrayType, isTupleType } from "../../util/functions/isTupleType";
import { TYPE_FLAG_INTRINSIC } from "../../util/tsInternals";

/**
 * Wraps a `ts.Type` in the stable surface plugins are allowed to see.
 *
 * Facades are cached per `ts.Type` so that plugins can use reference equality and so repeated
 * traversals of the same type do not reallocate.
 */
export function createTypeFactory(state: TransformState) {
	const checker = state.typeChecker;
	const cache = new Map<ts.Type, Type>();

	function wrap(type: ts.Type): Type {
		const existing = cache.get(type);
		if (existing) {
			return existing;
		}

		const facade = new TypeFacade(type);
		cache.set(type, facade);

		return facade;
	}

	function unwrap(type: Type): ts.Type {
		if (!(type instanceof TypeFacade)) {
			throw new Error("received a Type that was not created by this transformer");
		}

		return type.type;
	}

	class TypeFacade implements Type, UnionOrIntersectionType, ObjectLikeType, ArrayType, TupleArrayType, LiteralType {
		constructor(public readonly type: ts.Type) {}

		isSubtypeOf(other: Type) {
			return checker.isTypeAssignableTo(this.type, unwrap(other));
		}

		isSupertypeOf(other: Type) {
			return checker.isTypeAssignableTo(unwrap(other), this.type);
		}

		isEquivalentTo(other: Type) {
			const otherType = unwrap(other);
			return checker.isTypeAssignableTo(this.type, otherType) && checker.isTypeAssignableTo(otherType, this.type);
		}

		isIntersection(): this is UnionOrIntersectionType {
			return this.type.isIntersection();
		}

		isUnion(): this is UnionOrIntersectionType {
			return this.type.isUnion();
		}

		isObjectLike(): this is ObjectLikeType {
			return (this.type.flags & ts.TypeFlags.Object) !== 0;
		}

		isArray(): this is ArrayType {
			return isArrayType(state, this.type) || isTupleType(state, this.type);
		}

		isTuple(): this is TupleArrayType {
			return isTupleType(state, this.type);
		}

		isLiteral(): this is LiteralType;
		isLiteral(kind: "string"): this is LiteralType<string>;
		isLiteral(kind: "number"): this is LiteralType<number>;
		isLiteral(kind: "boolean"): this is LiteralType<boolean>;
		isLiteral(kind?: "string" | "number" | "boolean"): boolean {
			if (kind === "string") return this.type.isStringLiteral();
			if (kind === "number") return this.type.isNumberLiteral();
			if (kind === "boolean") return (this.type.flags & ts.TypeFlags.BooleanLiteral) !== 0;

			return this.type.isLiteral() || (this.type.flags & ts.TypeFlags.BooleanLiteral) !== 0;
		}

		isPrimitive(primitive: PrimitiveTypeNames) {
			if ((this.type.flags & TYPE_FLAG_INTRINSIC) === 0) {
				return false;
			}

			return (this.type as ts.IntrinsicType).intrinsicName === primitive;
		}

		getNonNullable(): Type {
			return wrap(this.type.getNonNullableType());
		}

		isOptional() {
			if (!this.type.isUnion()) {
				return false;
			}

			return this.type.types.some((v) => (v.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0);
		}

		getName() {
			return this.type.aliasSymbol?.name ?? this.type.getSymbol()?.name;
		}

		// UnionOrIntersectionType
		getConstituents(): Type[] {
			if (!this.type.isUnionOrIntersection()) {
				throw new Error("getConstituents called on a type that is not a union or intersection");
			}

			return this.type.types.map(wrap);
		}

		// ObjectLikeType
		getFields(): ObjectField[] {
			const fields = new Array<ObjectField>();

			for (const field of checker.getPropertiesOfType(this.type)) {
				const fieldType = checker.getTypeOfPropertyOfType(this.type, field.name);
				if (!fieldType) {
					continue;
				}

				fields.push({
					name: field.name,
					readonly: isReadonlySymbol(field),
					optional: (field.flags & ts.SymbolFlags.Optional) !== 0,
					type: wrap(fieldType),
				});
			}

			return fields;
		}

		getIndexSignatures(): IndexSignature[] {
			return checker.getIndexInfosOfType(this.type).map((info) => ({
				key: wrap(info.keyType),
				value: wrap(info.type),
				readonly: info.isReadonly,
			}));
		}

		getCallSignatures(): Signature[] {
			return this.getSignatures(ts.SignatureKind.Call);
		}

		getConstructSignatures(): Signature[] {
			return this.getSignatures(ts.SignatureKind.Construct);
		}

		private getSignatures(kind: ts.SignatureKind): Signature[] {
			return checker.getSignaturesOfType(this.type, kind).map((signature) => ({
				inputs: signature.getParameters().map((v) => wrap(checker.getTypeOfSymbol(v))),
				output: wrap(signature.getReturnType()),
			}));
		}

		// TupleArrayType
		getElements(): TupleElement[] {
			if (!isTupleType(state, this.type)) {
				throw new Error("getElements called on a type that is not a tuple");
			}

			const target = this.type.target;
			return checker.getTypeArguments(this.type).map((argument, index) => {
				const nameDeclaration = target.labeledElementDeclarations?.[index]?.name;
				const elementFlags = target.elementFlags[index];

				return {
					name: nameDeclaration && ts.isIdentifier(nameDeclaration) ? nameDeclaration.text : undefined,
					type: wrap(argument),
					spread: (elementFlags & ts.ElementFlags.Rest) !== 0,
					optional: (elementFlags & ts.ElementFlags.Optional) !== 0,
				};
			});
		}

		// ArrayType
		getElementType(): Type {
			if (isTupleType(state, this.type)) {
				const elements = checker.getTypeArguments(this.type);
				return wrap(elements.length > 0 ? checker.getUnionType([...elements]) : checker.getNeverType());
			}

			if (!isArrayType(state, this.type)) {
				throw new Error("getElementType called on a type that is not an array");
			}

			return wrap(checker.getElementTypeOfArrayType(this.type) ?? checker.getAnyType());
		}

		isReadonly() {
			const symbol = this.type.getSymbol();
			if (!symbol) {
				return false;
			}

			// `readonly T[]` and `ReadonlyArray<T>` both resolve to the global ReadonlyArray symbol.
			const readonlyArray = checker.resolveName("ReadonlyArray", undefined, ts.SymbolFlags.Type, false);
			return (
				readonlyArray !== undefined &&
				checker.getMergedSymbol(symbol) === checker.getMergedSymbol(readonlyArray)
			);
		}

		// LiteralType
		getLiteralValue(): string | number | boolean {
			if (this.type.isStringLiteral() || this.type.isNumberLiteral()) {
				return this.type.value;
			}

			if (this.type === checker.getTrueType()) return true;
			if (this.type === checker.getFalseType()) return false;

			throw new Error("getLiteralValue called on a type that is not a literal");
		}

		toString() {
			return checker.typeToString(this.type);
		}
	}

	function isReadonlySymbol(symbol: ts.Symbol) {
		return symbol.declarations?.some((v) => ts.isDeclarationReadonly(v)) ?? false;
	}

	return { wrap, unwrap };
}

export type TypeFactory = ReturnType<typeof createTypeFactory>;
