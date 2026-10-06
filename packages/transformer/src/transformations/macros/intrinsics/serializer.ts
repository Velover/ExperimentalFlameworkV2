import ts from "typescript";
import { Diagnostics } from "../../../classes/diagnostics";
import { NodeMetadata } from "../../../classes/nodeMetadata";
import { TransformState } from "../../../classes/transformState";

/** A serializer's version is written as one byte. */
const VERSION_MAX = 255;

/**
 * The version a serializer macro is called with (`Flamework.createSerializer<T>({ version: 3 })`), or
 * `undefined` for a serializer without one. The options are the argument of the parameter that the
 * macro's declaration names with `{@link options intrinsic-serializer-options}`, read here, when the
 * project builds, because the version is written into the generated code: an object literal whose
 * `version` has one number for its type, a whole one from 0 to 255 -- a literal, or a `const` or an
 * enum member whose type is that number.
 */
export function getSerializerVersion(state: TransformState, node: ts.Node): number | undefined {
	if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;

	const signature = state.typeChecker.getResolvedSignature(node);
	const declaration = signature?.getDeclaration();
	if (!signature || !declaration) return;

	const parameter = NodeMetadata.fromCache(state, declaration).getSymbol("intrinsic-serializer-options")?.[0];
	if (!parameter) return;

	const index = signature.parameters.findIndex((v) => v.valueDeclaration?.symbol === parameter);
	const argument = index >= 0 ? node.arguments?.[index] : undefined;
	if (!argument) return;

	const options = ts.skipOuterExpressions(argument);
	if (!ts.isObjectLiteralExpression(options)) {
		Diagnostics.error(
			argument,
			"Flamework reads a serializer's options when the project builds, so they have to be written here as an object literal, such as `{ version: 1 }`.",
		);
	}

	let version: { node: ts.Node; type: ts.Type } | undefined;
	for (const property of options.properties) {
		if (ts.isSpreadAssignment(property)) {
			Diagnostics.error(
				property,
				"Flamework reads a serializer's options when the project builds, and cannot read a spread in them: write each option out.",
			);
		}

		const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
		const named = name ?? (property.name && ts.isStringLiteral(property.name) ? property.name.text : undefined);
		if (named !== "version") continue;

		if (ts.isPropertyAssignment(property)) {
			version = { node: property.initializer, type: state.typeChecker.getTypeAtLocation(property.initializer) };
		} else if (ts.isShorthandPropertyAssignment(property)) {
			// `{ version }`: the variable's own type; the property's is widened to `number`.
			const symbol = state.typeChecker.getShorthandAssignmentValueSymbol(property);
			const type = symbol && state.typeChecker.getTypeOfSymbolAtLocation(symbol, property);
			version = { node: property, type: type ?? state.typeChecker.getTypeAtLocation(property.name) };
		} else {
			Diagnostics.error(property, "A serializer's `version` has to be a number, written as `version: 1`.");
		}
	}

	if (!version) {
		Diagnostics.error(argument, "Flamework found no `version` in these serializer options.");
	}

	if (!version.type.isNumberLiteral()) {
		Diagnostics.error(
			version.node,
			`Flamework writes a serializer's version into the code it generates, so it has to be known when the project builds, and the type of this one is '${state.typeChecker.typeToString(version.type)}'.`,
			"Write the version as a number literal (`{ version: 3 }`), or as a `const` or an enum member whose type is that number.",
		);
	}

	const value = version.type.value;
	if (!Number.isInteger(value) || value < 0 || value > VERSION_MAX) {
		Diagnostics.error(
			version.node,
			`A serializer's version is written as one byte: a whole number from 0 to ${VERSION_MAX}, not ${value}.`,
		);
	}

	return value;
}
