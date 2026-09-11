import ts from "typescript";
import { Diagnostics } from "../../../classes/diagnostics";
import { TransformState } from "../../../classes/transformState";
import { f } from "../../../util/factory";

/**
 * Inlines an environment variable: `Flamework.env("NAME")` becomes the variable's value as a
 * string literal, from the environment the compiler read when it started (`.env`, `.env.local`,
 * the process). A variable that is not set and has no fallback is a build error at the call site,
 * since the alternative is a `nil` that only fails somewhere else at runtime.
 */
export function buildEnvIntrinsic(state: TransformState, node: ts.Node, nameType: ts.Type, fallbackType?: ts.Type) {
	if (!nameType.isStringLiteral()) {
		Diagnostics.error(
			node,
			`Flamework.env expects the variable's name as a string literal, got: ${state.typeChecker.typeToString(nameType)}`,
		);
	}

	const name = nameType.value;
	const fallback = fallbackType !== undefined && fallbackType.isStringLiteral() ? fallbackType.value : undefined;

	const value = state.env[name] ?? fallback;
	if (value === undefined) {
		Diagnostics.error(
			node,
			`$${name} is not set in the environment, .env or .env.local, and Flamework.env was given no fallback.`,
			`Set it, or write Flamework.env("${name}", "value") to give it one.`,
		);
	}

	return f.string(value);
}
