import ts from "typescript";
import type { TransformState } from "../../classes/transformState";
import { NodeMetadata } from "../../classes/nodeMetadata";
import { assert } from "./assert";
import { Diagnostics } from "../../classes/diagnostics";

export function validateConstraintMetadata(
	state: TransformState,
	node: ts.ClassDeclaration | ts.ClassElement,
	metadata = new NodeMetadata(state, node),
) {
	if (!node.name) {
		return [];
	}

	const symbol = state.getSymbol(node.name);
	assert(symbol);

	const constraintTypes = metadata.getType("constraint");
	const nodeType = state.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
	for (const constraintType of constraintTypes ?? []) {
		if (!state.typeChecker.isTypeAssignableTo(nodeType, constraintType)) {
			Diagnostics.addDiagnostic(
				getAssignabilityDiagnostics(
					node.name ?? node,
					nodeType,
					constraintType,
					metadata.getTrace(constraintType),
				),
			);
		}
	}
}

function getAssignabilityDiagnostics(
	node: ts.Node,
	sourceType: ts.Type,
	constraintType: ts.Type,
	trace?: ts.Node,
): ts.DiagnosticWithLocation {
	const diagnostic = Diagnostics.createDiagnostic(
		node,
		ts.DiagnosticCategory.Error,
		`Type '${formatType(sourceType)}' does not satify constraint '${formatType(constraintType)}'`,
	);

	if (trace) {
		ts.addRelatedInfo(
			diagnostic,
			Diagnostics.createDiagnostic(trace, ts.DiagnosticCategory.Message, "The constraint is defined here."),
		);
	}

	return diagnostic;
}

function formatType(type: ts.Type) {
	const typeNode = type.checker.typeToTypeNode(
		type,
		undefined,
		ts.NodeBuilderFlags.InTypeAlias | ts.NodeBuilderFlags.IgnoreErrors,
	)!;

	const printer = ts.createPrinter();
	return printer.printNode(ts.EmitHint.Unspecified, typeNode, undefined!);
}
