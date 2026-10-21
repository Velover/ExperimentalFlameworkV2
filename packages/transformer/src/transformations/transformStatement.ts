import ts from "typescript";
import { TransformState } from "../classes/transformState";
import { catchDiagnostic } from "../util/diagnosticsUtils";
import { f } from "../util/factory";
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

		// A statement a call site's packing went ahead of past the scope's budget of locals goes in a
		// block of its own with it (see `emitWithStatements`), which ends those locals with it.
		const scoped = prereqs.length > 0 && state.scopedStatements.has(ts.getParseTreeNode(statement) ?? statement);
		const statements = scoped ? [f.block([...prereqs, ...getNodeList(node)])] : [...prereqs, ...getNodeList(node)];

		if (root) {
			const nextRootStatements = state.nextRootStatements;
			state.nextRootStatements = [];

			return [...nextRootStatements, ...statements];
		}

		return statements;
	});
}
