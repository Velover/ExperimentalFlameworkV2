import ts from "typescript";
import { Diagnostics } from "../../../classes/diagnostics";
import { TransformState } from "../../../classes/transformState";
import { f } from "../../../util/factory";

/**
 * Inlines an environment variable: `Flamework.env("NAME")` becomes the variable's value as a
 * string literal, from the environment the compiler read when it started (`.env`, `.env.local`,
 * the process), or `nil` when it is not set. A fallback is inlined in its place, and has to be a
 * string literal: it is what lets the declared type promise a `string`, so one the compiler cannot
 * read is refused rather than quietly dropped.
 */
export function buildEnvIntrinsic(state: TransformState, node: ts.Node, nameType: ts.Type, fallbackType?: ts.Type) {
	if (!nameType.isStringLiteral()) {
		Diagnostics.error(
			node,
			`Flamework.env expects the variable's name as a string literal, got: ${state.typeChecker.typeToString(nameType)}`,
		);
	}

	let fallback: string | undefined;
	if (fallbackType !== undefined && (fallbackType.flags & ts.TypeFlags.Undefined) === 0) {
		if (!fallbackType.isStringLiteral()) {
			Diagnostics.error(
				node,
				`Flamework.env expects the fallback as a string literal, got: ${state.typeChecker.typeToString(fallbackType)}`,
				"The fallback is inlined at compile time, which is what makes the result a string rather than string | undefined.",
			);
		}

		fallback = fallbackType.value;
	}

	const value = state.env[nameType.value] ?? fallback;
	return value === undefined ? f.nil() : f.string(value);
}
