import ts from "typescript";
import { TransformState } from "../classes/transformState";
import { catchDiagnostic } from "../util/diagnosticsUtils";
import { transformAccessExpression } from "./expressions/transformAccessExpression";
import { transformCallExpression } from "./expressions/transformCallExpression";
import { transformNewExpression } from "./expressions/transformNewExpression";
import { transformNode } from "./transformNode";

const TRANSFORMERS = new Map<ts.SyntaxKind, (state: TransformState, node: any) => ts.Expression>([
	[ts.SyntaxKind.CallExpression, transformCallExpression],
	[ts.SyntaxKind.NewExpression, transformNewExpression],
	[ts.SyntaxKind.ElementAccessExpression, transformAccessExpression],
	[ts.SyntaxKind.PropertyAccessExpression, transformAccessExpression],
]);

export function transformExpression(state: TransformState, expression: ts.Expression): ts.Expression {
	return catchDiagnostic(expression, () => {
		const transformer = TRANSFORMERS.get(expression.kind);
		if (transformer) {
			return transformer(state, expression);
		}
		return ts.visitEachChild(expression, (newNode) => transformNode(state, newNode), state.context);
	});
}
