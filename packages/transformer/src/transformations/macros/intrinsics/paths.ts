import { TransformState } from "../../../classes/transformState";
import path from "path";
import { f } from "../../../util/factory";
import ts from "typescript";
import { Diagnostics } from "../../../classes/diagnostics";
import type { GlobUse } from "../../../classes/buildInfo";
import { getPackageJson } from "../../../util/functions/getPackageJson";
import { CORE_PACKAGE } from "../../../util/packages";

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
	const { macro, line, column } = getMacroCall(file, node);
	return { glob, text, macro, line, column };
}

/**
 * The macro call a generated argument belongs to: its name, and where it is, one-based. A method
 * call is placed at the method's name: a chain of registrations
 * (`createModule().registerProvidersGlob(a).registerProvidersGlob(b)`) is one expression, and every
 * call in it starts where the chain does. `qualified` also names the receiver when it is a plain
 * name, as a static call's class is (`ComponentPlugin.fromPath`).
 */
function getMacroCall(file: ts.SourceFile, node: ts.Node, qualified = false) {
	const call = ts.getParseTreeNode(node) ?? node;

	let macro = "a macro";
	let anchor: ts.Node = call;
	if (ts.isCallExpression(call) || ts.isNewExpression(call)) {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee)) {
			macro =
				qualified && ts.isIdentifier(callee.expression)
					? `${callee.expression.text}.${callee.name.text}`
					: callee.name.text;
			anchor = callee.name;
		} else if (ts.isIdentifier(callee)) {
			macro = callee.text;
		}
	}

	const position = anchor.pos >= 0 ? anchor.getStart(file) : 0;
	const { line, character } = file.getLineAndCharacterOfPosition(position);

	return { macro, line: line + 1, column: character + 1 };
}

/**
 * Generates a path as an array of Rojo path segments.
 *
 * The use is recorded, so that a path the place will not have, or will have with no module in it,
 * is warned about where it is written (see `TransformState.warnEmptyPaths`).
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
		const output = path.relative(state.currentDirectory, outputPath).replace(/\\/g, "/");
		Diagnostics.error(
			node,
			`Could not find Rojo data for '${pathType.value}'`,
			state.rojoResolver
				? `It compiles to '${output}', and no $path in your Rojo project covers that. Give the source path of a folder the project maps, relative to the project, such as "src/server/commands".`
				: "No Rojo project file was found, so a source path cannot be turned into a Rojo path.",
		);
	}

	const file = state.getSourceFile(node);
	state.buildInfo.addPathUse(state.getFileId(file), {
		path: pathType.value,
		...getMacroCall(file, node, true),
		...(isCoreRequireModules(state, node) ? { raises: true } : {}),
	});

	return f.array(rbxPath.map(f.string));
}

/**
 * Whether a path macro's call is core's `requireModules`, which raises once it has waited five
 * seconds for a folder that is not there, where registration waits on.
 */
function isCoreRequireModules(state: TransformState, node: ts.Node) {
	const call = ts.getParseTreeNode(node) ?? node;
	if (!ts.isCallExpression(call)) return false;

	const declaration = state.typeChecker.getResolvedSignature(call)?.getDeclaration();
	if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) return false;
	if (declaration.name?.text !== "requireModules") return false;

	try {
		return getPackageJson(path.dirname(declaration.getSourceFile().fileName)).result.name === CORE_PACKAGE;
	} catch {
		return false;
	}
}
