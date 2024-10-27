import ts from "typescript";
import { NodeMetadata } from "../../classes/nodeMetadata";
import { TransformState } from "../../classes/transformState";
import { f } from "../../util/factory";
import { buildGuardFromType } from "../../util/functions/buildGuardFromType";
import { getNodeTypeUid, getTypeUid } from "../../util/uid";
import { getDependencyInjectionMetadata } from "../transformUserMacro";
import { validateConstraintMetadata } from "../../util/functions/validateConstraintMetadata";
import { Diagnostics } from "../../classes/diagnostics";

export function transformClassDeclaration(state: TransformState, node: ts.ClassDeclaration) {
	const symbol = state.getSymbol(node);
	if (!symbol || !node.name) return state.transform(node);

	const metadata = NodeMetadata.fromCache(state, node);
	if (!hasReflectMetadata(state, node, metadata)) {
		return state.transform(node);
	}

	const importIdentifier = state.addFileImport(state.getSourceFile(node), "@flamework/core", "Reflect");
	const reflectStatements = new Array<ts.Statement>();

	reflectStatements.push(...convertReflectionToStatements(generateClassMetadata(state, metadata, node)));
	validateConstraintMetadata(state, node, metadata);

	for (const member of node.members) {
		if (!member.name) {
			continue;
		}

		const propertyName = ts.getPropertyNameForPropertyNameNode(member.name);
		if (!propertyName) {
			continue;
		}

		const reflection = getNodeReflection(state, member) ?? [];
		if (reflection.length > 0 && ts.hasStaticModifier(member)) {
			Diagnostics.error(member.name, "Flamework does not support reflection on static members.");
		}

		reflectStatements.push(...convertReflectionToStatements(reflection, propertyName));
		validateConstraintMetadata(state, member);
	}

	return [updateClass(state, node, reflectStatements)];

	function convertReflectionToStatements(metadata: [string, f.ConvertableExpression][], property?: string) {
		const statements = metadata.map(([name, value]) => {
			const args = [node.name!, name, value];
			if (property !== undefined) {
				args.push(property);
			}

			return f.statement(f.call(f.field(importIdentifier, "defineMetadata"), args));
		});

		addSectionComment(statements[0], node, property, "metadata");

		return statements;
	}
}

function generateFieldMetadata(state: TransformState, metadata: NodeMetadata, field: ts.PropertyDeclaration) {
	const fields = new Array<[string, f.ConvertableExpression]>();
	const type = state.typeChecker.getTypeAtLocation(field);

	if (metadata.isRequested("flamework:type")) {
		const id = getTypeUid(state, type, field.name ?? field);
		fields.push(["flamework:type", id]);
	}

	if (metadata.isRequested("flamework:guard")) {
		const guard = buildGuardFromType(state, field.type ?? field, type);
		fields.push(["flamework:guard", guard]);
	}

	return fields;
}

function generateMethodMetadata(state: TransformState, metadata: NodeMetadata, method: ts.FunctionLikeDeclaration) {
	const fields = new Array<[string, f.ConvertableExpression]>();
	const baseSignature = state.typeChecker.getSignatureFromDeclaration(method);
	if (!baseSignature) return [];

	if (metadata.isRequested("flamework:return_type")) {
		const id = getTypeUid(state, baseSignature.getReturnType(), method.name ?? method);
		fields.push(["flamework:return_type", id]);
	}

	if (metadata.isRequested("flamework:return_guard")) {
		const guard = buildGuardFromType(state, method.type ?? method, baseSignature.getReturnType());
		fields.push(["flamework:return_guard", guard]);
	}

	const parameters = new Array<string>();
	const parameterNames = new Array<string>();
	const parameterGuards = new Array<ts.Expression>();
	const dependencies = new Array<ts.Expression>();

	for (const parameter of method.parameters) {
		if (metadata.isRequested("flamework:parameters")) {
			const type = state.typeChecker.getTypeAtLocation(parameter);
			const id = getTypeUid(state, type, parameter);
			parameters.push(id);
		}

		if (metadata.isRequested("flamework:parameter_names")) {
			if (f.is.identifier(parameter.name)) {
				parameterNames.push(parameter.name.text);
			} else {
				parameterNames.push("_binding_");
			}
		}

		if (metadata.isRequested("flamework:parameter_guards")) {
			const type = state.typeChecker.getTypeAtLocation(parameter);
			const guard = buildGuardFromType(state, parameter, type);
			parameterGuards.push(guard);
		}

		if (metadata.isRequested("flamework:dependencies")) {
			const type = state.typeChecker.getTypeAtLocation(parameter);
			dependencies.push(getDependencyInjectionMetadata(state, parameter, type));
		}
	}

	if (parameters.length > 0) {
		fields.push(["flamework:parameters", parameters]);
	}

	if (parameterNames.length > 0) {
		fields.push(["flamework:parameter_names", parameterNames]);
	}

	if (parameterGuards.length > 0) {
		fields.push(["flamework:parameter_guards", parameterGuards]);
	}

	if (dependencies.length > 0) {
		fields.push(["flamework:dependencies", dependencies]);
	}

	return fields;
}

function generateClassMetadata(state: TransformState, metadata: NodeMetadata, node: ts.ClassDeclaration) {
	const fields: [string, f.ConvertableExpression][] = [];

	if (metadata.isRequested("identifier")) {
		fields.push(["identifier", getNodeTypeUid(state, node)]);
	}

	const constructor = node.members.find((x): x is ts.ConstructorDeclaration => f.is.constructor(x));
	if (constructor) {
		fields.push(...generateMethodMetadata(state, metadata, constructor));
	}

	if (node.heritageClauses) {
		const implementClauses = new Array<ts.StringLiteral>();
		for (const clause of node.heritageClauses) {
			if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;

			for (const type of clause.types) {
				implementClauses.push(f.string(getNodeTypeUid(state, type)));
			}
		}

		if (implementClauses.length > 0 && metadata.isRequested("flamework:implements")) {
			fields.push(["flamework:implements", f.array(implementClauses, false)]);
		}
	}

	return fields;
}

function getNodeReflection(
	state: TransformState,
	node: ts.ClassDeclaration | ts.ClassElement,
	metadata = NodeMetadata.fromCache(state, node),
) {
	if (f.is.methodDeclaration(node)) {
		return generateMethodMetadata(state, metadata, node);
	} else if (f.is.propertyDeclaration(node)) {
		return generateFieldMetadata(state, metadata, node);
	}
}

function addSectionComment(
	node: ts.Node | undefined,
	declaration: ts.ClassDeclaration,
	property: string | undefined,
	label: string,
) {
	if (!node) {
		return;
	}

	const elementName = property === undefined ? `${declaration.name!.text}` : `${declaration.name!.text}.${property}`;
	ts.addSyntheticLeadingComment(node, ts.SyntaxKind.SingleLineCommentTrivia, ` (Flamework) ${elementName} ${label}`);
}

function updateClass(state: TransformState, node: ts.ClassDeclaration, staticStatements?: ts.Statement[]) {
	const members = node.members.map((node) => state.transformNode(node));

	if (staticStatements) {
		members.push(f.staticBlockDeclaration(staticStatements));
	}

	return f.update.classDeclaration(
		node,
		node.name ? state.transformNode(node.name) : undefined,
		members,
		node.heritageClauses,
		node.typeParameters,
		node.modifiers?.map((v) => state.transformNode(v)),
	);
}

function hasReflectMetadata(state: TransformState, declaration: ts.ClassDeclaration, metadata: NodeMetadata) {
	if (metadata.isRequested("reflect")) {
		return true;
	}

	for (const member of declaration.members) {
		const metadata = NodeMetadata.fromCache(state, member);
		if (metadata.isRequested("reflect")) {
			return true;
		}
	}

	return false;
}
