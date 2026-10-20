import path from "path";
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

	const statements = transformStatementList(state, file.statements, true);

	// A root statement that succeeds takes everything queued so far, so what is left was hoisted for
	// root statements that failed, every one after it included: they are emitted as written and stop
	// the build, so it is dropped. Left behind with no error, it is a bug, and an error: placed at the
	// end, a helper or guard that code running at load uses would still be nil there.
	const leftover = state.nextRootStatements;
	state.nextRootStatements = [];
	const parseTreeFile = ts.getParseTreeNode(file, ts.isSourceFile) ?? file;
	if (
		leftover.length > 0 &&
		!Diagnostics.diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
	) {
		Diagnostics.addDiagnostic(
			Diagnostics.createDiagnostic(
				parseTreeFile,
				ts.DiagnosticCategory.Error,
				`Flamework generated ${leftover.length} statement(s) for ${path.relative(state.currentDirectory, parseTreeFile.fileName).replace(/\\/g, "/")} that it did not place in the file.`,
				"This is a bug in Flamework: please report it, with the file.",
			),
		);
	}

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

		// steal comments from original first statement so that comment directives work properly. They
		// are read from its parse tree node: a statement a transformer before Flamework's rewrote, or one
		// Flamework generated, has no parent to find the file's text through.
		const parseTreeStatement = firstStatement && ts.getParseTreeNode(firstStatement);
		if (firstStatement && parseTreeStatement && statements[0]) {
			ts.copyComments(parseTreeStatement, statements[0]);
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
