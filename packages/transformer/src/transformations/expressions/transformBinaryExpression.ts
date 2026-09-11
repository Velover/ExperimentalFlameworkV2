import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { f } from "../../util/factory";
import { getIndexExpression } from "../../util/functions/getIndexExpression";
import { isAttributesAccess } from "../../util/functions/isAttributesAccess";
import { COMPONENTS_PACKAGE } from "../../util/packages";

const MUTATING_OPERATORS = new Map<ts.BinaryOperator, ts.BinaryOperator>([
	[ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsToken],
	[ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
	[ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
	[ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
	[ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
	[ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
	[ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.BarBarToken],
	[ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
	[ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
	[ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
	[ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.QuestionQuestionToken],
	[ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskToken],
	[ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
	[ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken],
	[ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
	[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken],
]);

/**
 * Writes to `this.attributes` go through the component, which writes the value back to the
 * instance. `attributes` is an ordinary field otherwise, so the rewrite is what makes assignment
 * mean anything at all.
 */
export function transformBinaryExpression(state: TransformState, node: ts.BinaryExpression) {
	const nonAssignmentOperator = MUTATING_OPERATORS.get(node.operatorToken.kind);
	if (nonAssignmentOperator) {
		if (isAttributesAccess(state, node.left)) {
			const name = getIndexExpression(node.left);
			if (!name) Diagnostics.error(node.left, "could not get index expression");

			if (!f.is.accessExpression(node.left.expression))
				Diagnostics.error(node.left, "assignments not supported with direct access");

			const attributeSetter = state.addFileImport(
				node.getSourceFile(),
				`${COMPONENTS_PACKAGE}/out/baseComponent`,
				"SYMBOL_ATTRIBUTE_SETTER",
			);
			const thisAccess = node.left.expression.expression;
			const valueExpr =
				nonAssignmentOperator === ts.SyntaxKind.EqualsToken
					? node.right
					: f.binary(node.left, nonAssignmentOperator, node.right);

			return f.call(f.field(state.transformNode(thisAccess), attributeSetter, true), [
				name,
				state.transformNode(valueExpr),
			]);
		}
	}

	return state.transform(node);
}
