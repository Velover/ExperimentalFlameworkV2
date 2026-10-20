import ts from "typescript";
import { TransformState } from "../classes/transformState";
import { getNodeList } from "../util/functions/getNodeList";
import { transformStatement } from "./transformStatement";

/** Transforms a list of statements; `root` when they are the file's own (see {@link transformStatement}). */
export function transformStatementList(state: TransformState, statements: ReadonlyArray<ts.Statement>, root = false) {
	const result = new Array<ts.Statement>();

	for (const statement of statements) {
		const [newStatements, prereqs] = state.capture(() => transformStatement(state, statement, root));

		result.push(...prereqs);
		result.push(...getNodeList(newStatements));
	}

	return result;
}
