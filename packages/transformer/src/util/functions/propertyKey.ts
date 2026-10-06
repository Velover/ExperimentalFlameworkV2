import ts from "typescript";
import { f } from "../factory";

/**
 * A property's key in a Luau table: a string, or a number. roblox-ts compiles a key as it is
 * written, never as TypeScript names the property: `{ 10: v }`, `{ [-1]: v }`,
 * `{ [Level.High]: v }` and `v[10]` use the number, `{ "10": v }` and `v["10"]` the string, though
 * TypeScript calls the property "10" either way.
 */
export type TableKey = string | number;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The key generated code uses for a property of a type, where nothing writes the key down: the
 * one the type declares, worked out as TypeScript's `keyof` works it out (`getLiteralTypeFromProperty`
 * in its checker). A property a mapped type made, or one named by a constant, carries its key's
 * literal type (`Record<10 | 2, V>`, `Partial<Record<Level, V>>`, `Pick<T, 10>`, `{ [Level.High]: V }`);
 * any other has its declaration's name: a numeric literal (`{ 10: V }`, `{ 1.5: V }`) or a computed
 * number (`{ [-1]: V }`) is a number, an identifier or a string (`{ "10": V }`) a string.
 */
export function getPropertyKey(checker: ts.TypeChecker, property: ts.Symbol): TableKey {
	// TypeScript's own record of the key (`nameType`), which it keeps on the symbols it makes: a mapped
	// type's properties, late-bound ones, and those of a union or an intersection.
	if (property.flags & ts.SymbolFlags.Transient) {
		const nameType = (property as ts.TransientSymbol).links.nameType;
		if (nameType) return nameType.isNumberLiteral() ? nameType.value : property.name;
	}

	const declaration = property.valueDeclaration ?? property.declarations?.[0];
	const name = declaration && ts.getNameOfDeclaration(declaration);
	if (name && ts.isNumericLiteral(name)) return Number(name.text);
	if (name && ts.isComputedPropertyName(name)) {
		const type = checker.getTypeAtLocation(name.expression);
		if (type.isNumberLiteral()) return type.value;
	}

	return property.name;
}

/** `object.name`, `object["two words"]` or `object[10]`, which roblox-ts compiles to that very key. */
export function keyAccess(object: ts.Expression, key: TableKey): ts.Expression {
	if (typeof key === "number") return ts.factory.createElementAccessExpression(object, numberKey(key));
	return IDENTIFIER.test(key)
		? ts.factory.createPropertyAccessExpression(object, key)
		: ts.factory.createElementAccessExpression(object, f.string(key));
}

/** The name of an object literal's property with this key: `"name"`, `10` or `[-1]`. */
export function keyName(key: TableKey): ts.PropertyName {
	if (typeof key === "string") return f.string(key);
	const expression = numberKey(key);
	return ts.isNumericLiteral(expression) ? expression : ts.factory.createComputedPropertyName(expression);
}

/** A key as a step of a path in a message: `.pos`, `["two words"]` or `[10]`. */
export function keySegment(key: TableKey): string {
	if (typeof key === "number") return `[${key}]`;
	return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * A number key as an expression: `10`, `-1`, `1.5`, `1e+21`. An infinity is `1e999`, which Luau
 * reads as `math.huge`; -0 is 0, which a Luau table takes for the same key.
 */
function numberKey(value: number): ts.Expression {
	const magnitude = Math.abs(value);
	const literal = ts.factory.createNumericLiteral(isFinite(magnitude) ? `${magnitude}` : "1e999");
	return value < 0 ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, literal) : literal;
}
