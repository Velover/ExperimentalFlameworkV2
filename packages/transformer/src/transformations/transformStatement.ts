import ts from "typescript";
import { TransformState } from "../classes/transformState";
import { catchDiagnostic } from "../util/diagnosticsUtils";
import { getNodeList } from "../util/functions/getNodeList";
import { transformClassDeclaration } from "./statements/transformClassDeclaration";
import { transformNode } from "./transformNode";

const TRANSFORMERS = new Map<ts.SyntaxKind, (state: TransformState, node: any) => ts.Statement | ts.Statement[]>([
	[ts.SyntaxKind.ClassDeclaration, transformClassDeclaration],
]);

/**
 * Transforms one statement. `root` says it is one of the file's own statements, which
 * {@link transformFile} hands over: what the transform hoisted to file level
 * (`state.nextRootStatements`) goes ahead of it. A nested statement leaves that for the root
 * statement it is in.
 *
 * Root-ness is not read from `statement.parent`: a transformer listed before Flamework's that
 * rewrote the statement (`factory.update*`) hands over one with no parent.
 */
export function transformStatement(
	state: TransformState,
	statement: ts.Statement,
	root = false,
): ts.Statement | ts.Statement[] {
	return catchDiagnostic<ts.Statement | ts.Statement[]>(statement, () => {
		const [node, prereqs] = state.capture(() => {
			const transformer = TRANSFORMERS.get(statement.kind);
			if (transformer) {
				return transformer(state, statement);
			}

			return ts.visitEachChild(statement, (newNode) => transformNode(state, newNode), state.context);
		});

		if (root) {
			const nextRootStatements = state.nextRootStatements;
			state.nextRootStatements = [];

			return [...nextRootStatements, ...prereqs, ...getNodeList(node)];
		}

		return [...prereqs, ...getNodeList(node)];
	});
}
