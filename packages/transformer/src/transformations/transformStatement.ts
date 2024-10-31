import ts from "typescript";
import { TransformState } from "../classes/transformState";
import { catchDiagnostic } from "../util/diagnosticsUtils";
import { getNodeList } from "../util/functions/getNodeList";
import { transformClassDeclaration } from "./statements/transformClassDeclaration";
import { transformNode } from "./transformNode";
import { f } from "../util/factory";

const TRANSFORMERS = new Map<ts.SyntaxKind, (state: TransformState, node: any) => ts.Statement | ts.Statement[]>([
	[ts.SyntaxKind.ClassDeclaration, transformClassDeclaration],
]);

export function transformStatement(state: TransformState, statement: ts.Statement): ts.Statement | ts.Statement[] {
	return catchDiagnostic<ts.Statement | ts.Statement[]>(statement, () => {
		const [node, prereqs] = state.capture(() => {
			const transformer = TRANSFORMERS.get(statement.kind);
			if (transformer) {
				return transformer(state, statement);
			}

			return ts.visitEachChild(statement, (newNode) => transformNode(state, newNode), state.context);
		});

		if (f.is.file(statement.parent)) {
			const nextRootStatements = state.nextRootStatements;
			state.nextRootStatements = [];

			return [...nextRootStatements, ...prereqs, ...getNodeList(node)];
		}

		return [...prereqs, ...getNodeList(node)];
	});
}
