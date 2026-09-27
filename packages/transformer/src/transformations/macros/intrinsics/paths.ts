import { TransformState } from "../../../classes/transformState";
import path from "path";
import { f } from "../../../util/factory";
import ts from "typescript";
import { Diagnostics } from "../../../classes/diagnostics";
import type { GlobUse } from "../../../classes/buildInfo";

/**
 * Generates a path glob.
 *
 * This generates a string as a reference to the runtime metadata exposed in core.
 */
export function buildPathGlobIntrinsic(state: TransformState, node: ts.Node, pathType: ts.Type) {
	if (!pathType.isStringLiteral()) {
		Diagnostics.error(
			node,
			`Path is invalid, expected string literal and got: ${state.typeChecker.typeToString(pathType)}`,
		);
	}

	const file = state.getSourceFile(node);
	const glob = pathType.value;
	const absoluteGlob = glob.startsWith(".")
		? path.relative(state.rootDirectory, path.resolve(path.dirname(file.fileName), glob)).replace(/\\/g, "/")
		: glob;

	state.buildInfo.addGlob(absoluteGlob, state.getFileId(file), getGlobUse(file, node, glob, absoluteGlob));
	return f.string(state.obfuscateText(absoluteGlob, "addPaths"));
}

/**
 * Where a glob is used: the macro call it was given to, and the glob as written. The build warns
 * there when the glob matches nothing (see `TransformState.warnEmptyGlobs`).
 */
function getGlobUse(file: ts.SourceFile, node: ts.Node, text: string, glob: string): GlobUse {
	const call = ts.getParseTreeNode(node) ?? node;

	// A method call is placed at the method's name: a chain of registrations
	// (`createModule().registerProvidersGlob(a).registerProvidersGlob(b)`) is one expression, and
	// every call in it starts where the chain does.
	let macro = "a macro";
	let anchor: ts.Node = call;
	if (ts.isCallExpression(call) || ts.isNewExpression(call)) {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee)) {
			macro = callee.name.text;
			anchor = callee.name;
		} else if (ts.isIdentifier(callee)) {
			macro = callee.text;
		}
	}

	const position = anchor.pos >= 0 ? anchor.getStart(file) : 0;
	const { line, character } = file.getLineAndCharacterOfPosition(position);

	return { glob, text, macro, line: line + 1, column: character + 1 };
}

/**
 * Generates a path as an array of Rojo path segments.
 */
export function buildPathIntrinsic(state: TransformState, node: ts.Node, pathType: ts.Type) {
	if (!pathType.isStringLiteral()) {
		Diagnostics.error(
			node,
			`Path is invalid, expected string literal and got: ${state.typeChecker.typeToString(pathType)}`,
		);
	}

	const outputPath = state.pathTranslator.getOutputPath(pathType.value);
	const rbxPath = state.rojoResolver?.getRbxPathFromFilePath(outputPath);
	if (!rbxPath) {
		Diagnostics.error(node, `Could not find Rojo data for '${pathType.value}'`);
	}

	return f.array(rbxPath.map(f.string));
}
