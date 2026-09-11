import ts from "typescript";
import { TransformState } from "../../../classes/transformState";
import { f } from "../../../util/factory";

/**
 * An inlining intrinsic: the call is replaced by the value generated for one of its parameters.
 *
 * The value is cast to the call's resolved return type rather than to the declaration's return
 * type node: a declaration such as `F extends string ? string : string | undefined` names type
 * parameters that mean nothing in the caller's file, whereas the resolved type of that call is a
 * plain `string | undefined` the checker can write down there.
 */
export function inlineMacroIntrinsic(
	state: TransformState,
	node: ts.Node,
	signature: ts.Signature,
	args: ts.Expression[],
	parameter: ts.Symbol,
) {
	const parameterIndex = signature.parameters.findIndex((v) => v.valueDeclaration?.symbol === parameter);
	const argument = args[parameterIndex];

	const returnType = state.typeChecker.typeToTypeNode(
		signature.getReturnType(),
		node,
		ts.NodeBuilderFlags.NoTruncation,
	);

	return returnType !== undefined ? f.as(argument, returnType) : argument;
}
