import ts from "typescript";
import { Diagnostics } from "../classes/diagnostics";
import { TransformState } from "../classes/transformState";
import { f } from "../util/factory";
import { checkSerializerOutput } from "../util/functions/buildSerializerFromType";
import { transformStatementList } from "./transformStatementList";

export function transformFile(state: TransformState, file: ts.SourceFile): ts.SourceFile {
	state.buildInfo.invalidateGlobs(state.getFileId(file));
	state.buildInfo.invalidatePathUses(state.getFileId(file));

	// What a root statement hoisted lands ahead of the next one that succeeds. When the last root
	// statement of the previous file failed, what it hoisted is that file's, and must not open this one.
	state.nextRootStatements = [];

	const statements = transformStatementList(state, file.statements);

	const imports = state.fileImports.get(file.fileName);
	if (imports) {
		const firstStatement = statements[0];

		statements.unshift(
			...imports.map((info) =>
				f.importDeclaration(
					info.path,
					info.entries.map((x) => [x.name, x.identifier]),
				),
			),
		);

		// steal comments from original first statement so that comment directives work properly
		if (firstStatement && statements[0]) {
			ts.copyComments(firstStatement, statements[0]);
			ts.removeAllComments(firstStatement);
		}
	}

	checkSerializerOutput(state, file);

	for (const diag of Diagnostics.flush()) {
		state.addDiagnostic(diag);
	}

	const sourceFile = f.update.sourceFile(file, statements);

	return sourceFile;
}
