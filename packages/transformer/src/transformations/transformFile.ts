import path from "path";
import ts from "typescript";
import { Diagnostics } from "../classes/diagnostics";
import { TransformState } from "../classes/transformState";
import { f } from "../util/factory";
import { checkSerializerOutput } from "../util/functions/buildSerializerFromType";
import { transformStatementList } from "./transformStatementList";
import { LUAU_MAX_LOCALS, sureImportLocals, sureLocalsOf, sureMainChunkLocals } from "../util/luauLimits";

export function transformFile(state: TransformState, file: ts.SourceFile): ts.SourceFile {
	state.buildInfo.invalidateGlobs(state.getFileId(file));
	state.buildInfo.invalidatePathUses(state.getFileId(file));
	state.buildInfo.invalidateEnvInputs(state.getFileId(file));

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
	checkMainChunkLocals(
		state,
		parseTreeFile,
		statements,
		imports?.reduce((sum, info) => sum + info.entries.length, 0) ?? 0,
	);

	for (const diag of Diagnostics.flush()) {
		state.addDiagnostic(diag);
	}

	const sourceFile = f.update.sourceFile(file, statements);

	return sourceFile;
}

/**
 * The build's error for a file whose main chunk Flamework's code takes past the 200 locals Luau loads a
 * function with: the file would build and then fail to load. It counts only the locals the file is
 * sure to keep (see `sureMainChunkLocals`), so it never refuses a file that loads: the file as written
 * and as transformed, with the imports (a local for each name read as a value, and roblox-ts's `TS`
 * for the runtime library, which a file that imports anything at run time has: see
 * `sureImportLocals`) and the ones Flamework added. A file past the limit without Flamework's code is
 * roblox-ts's to report, and is left alone.
 */
function checkMainChunkLocals(
	state: TransformState,
	original: ts.SourceFile,
	statements: readonly ts.Statement[],
	imports: number,
) {
	if (Diagnostics.diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return;

	const own = sureImportLocals(state.typeChecker, original);
	const before = sureMainChunkLocals(original.statements) + own.locals + (own.runtime ? 1 : 0);
	let running = own.locals + imports + (own.runtime || imports > 0 ? 1 : 0);
	let at: ts.Statement | undefined;
	for (const statement of statements) {
		running += sureLocalsOf(statement);
		// Where Luau stops: the first statement the count passes the limit at, or the next one written in the file.
		if (running > LUAU_MAX_LOCALS && (at === undefined || ts.getParseTreeNode(at) === undefined)) at = statement;
	}

	if (running <= LUAU_MAX_LOCALS || running <= before) return;

	const written = statements.map((statement) => ts.getParseTreeNode(statement)).filter((node) => node !== undefined);
	const located = ts.getParseTreeNode(at!) ?? written[written.length - 1] ?? original;
	Diagnostics.addDiagnostic(
		Diagnostics.createDiagnostic(
			located,
			ts.DiagnosticCategory.Error,
			`This file declares at least ${running} locals at its top level, ${running - before} of them in code Flamework generated, and Luau loads a module with at most ${LUAU_MAX_LOCALS} there: it would build, then fail to load ("Out of local registers").`,
			"Move some of the file's top-level declarations into a table or another module, or split the file.",
		),
	);
}
