import ts from "typescript";
import { TRANSFORMER_PACKAGE } from "../util/packages";

function createDiagnosticAtLocation(
	node: ts.Node,
	messageText: string,
	category: ts.DiagnosticCategory,
	file = ts.getSourceFileOfNode(node),
): ts.DiagnosticWithLocation {
	return {
		category,
		file,
		messageText,
		start: node.getStart(),
		length: node.getWidth(),
		// TypeScript prints `error TS<code>: `; the leading space keeps the name apart from the `TS`, as
		// roblox-ts does for its own (`error TS roblox-ts: `).
		code: ` ${TRANSFORMER_PACKAGE}` as never,
	};
}

export class DiagnosticError extends Error {
	constructor(public diagnostic: ts.DiagnosticWithLocation) {
		super(diagnostic.messageText as string);
	}
}

/**
 * A problem with the project's own files or setup rather than with a node of the program: a
 * flamework.config.json that does not parse or validate, an option where it is not read, a
 * flamework.build that cannot be used. The transformer stops the build with the message and no
 * stack trace (see transformer.ts), since nothing in it is a bug in Flamework. The first line says
 * what is wrong, the lines after it what to do about it.
 */
export class ProjectError extends Error {
	constructor(message: string) {
		super(message);

		// The transformer is compiled to ES5, where a subclass of Error constructs a plain Error.
		Object.setPrototypeOf(this, ProjectError.prototype);
	}
}

export class Diagnostics {
	static diagnostics = new Array<ts.DiagnosticWithLocation>();

	static addDiagnostic(diag: ts.DiagnosticWithLocation) {
		this.diagnostics.push(diag);
	}

	static createDiagnostic(node: ts.Node, category: ts.DiagnosticCategory, ...messages: string[]) {
		return createDiagnosticAtLocation(node, messages.join("\n"), category);
	}

	static relocate(diagnostic: ts.DiagnosticWithLocation, node: ts.Node): never {
		diagnostic.file = ts.getSourceFileOfNode(node);
		diagnostic.start = node.getStart();
		diagnostic.length = node.getWidth();
		throw new DiagnosticError(diagnostic);
	}

	static error(node: ts.Node, ...messages: string[]): never {
		throw new DiagnosticError(this.createDiagnostic(node, ts.DiagnosticCategory.Error, ...messages));
	}

	static warning(node: ts.Node, ...messages: string[]) {
		this.addDiagnostic(this.createDiagnostic(node, ts.DiagnosticCategory.Warning, ...messages));
	}

	static flush() {
		const diagnostics = this.diagnostics;
		this.diagnostics = [];

		return diagnostics;
	}
}
