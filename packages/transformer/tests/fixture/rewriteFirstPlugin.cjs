/**
 * A transformer listed before Flamework's in a probe tsconfig's `plugins`, as a project may list
 * one that rewrites code using a service. What it hands on is rebuilt with `factory.update*`, so
 * the statements it rewrote have no `parent`, as such a transformer's have.
 *
 * - `mode: "classes"` rebuilds each top-level class declaration, members unchanged.
 * - `mode: "statements"` rebuilds every top-level statement and the nodes between it and the lists
 *   of nodes in it (members, declarations, arguments, block statements), whose nodes are unchanged.
 * - `mode: "deep"` rebuilds every node of every top-level statement on the way to a list of nodes,
 *   which is every statement and most of what is in them.
 *
 * `files` (a substring of the file name) limits it to the files whose name contains it.
 *
 * It uses roblox-ts's own `typescript`: another copy numbers `SyntaxKind` differently, so its
 * `isClassDeclaration` would match nothing here.
 */
const path = require("path");
const ts = require(
	require.resolve("typescript", {
		paths: [path.dirname(require.resolve("roblox-ts/package.json", { paths: [__dirname] }))],
	}),
);

module.exports = (_program, config) => (context) => {
	const factory = context.factory;
	const copy = (nodes) =>
		nodes && ts.setTextRange(factory.createNodeArray([...nodes], nodes.hasTrailingComma), nodes);
	const shallow = (node) => ts.visitEachChild(node, shallow, context, copy);
	const deep = (node) => ts.visitEachChild(node, deep, context, (nodes) => copy(nodes && ts.visitNodes(nodes, deep)));

	const rewrite = (statement) => {
		if (config.mode === "statements") return shallow(statement);
		if (config.mode === "deep") return deep(statement);
		if (!ts.isClassDeclaration(statement)) return statement;
		return factory.updateClassDeclaration(
			statement,
			statement.modifiers,
			statement.name,
			statement.typeParameters,
			statement.heritageClauses,
			copy(statement.members),
		);
	};

	return (file) =>
		config.files === undefined || file.fileName.includes(config.files)
			? factory.updateSourceFile(file, file.statements.map(rewrite))
			: file;
};
