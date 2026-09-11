import ts from "typescript";
import { NodeMetadata } from "../../classes/nodeMetadata";
import { TransformState } from "../../classes/transformState";
import { f } from "../../util/factory";
import { buildGuardFromType } from "../../util/functions/buildGuardFromType";
import { getNodeTypeUid, getTypeUid } from "../../util/uid";
import { getDependencyInjectionMetadata } from "../transformUserMacro";
import { validateConstraintMetadata } from "../../util/functions/validateConstraintMetadata";
import { Diagnostics } from "../../classes/diagnostics";
import { CORE_PACKAGE } from "../../util/packages";

/**
 * A parameter together with the type it has at the class being transformed.
 *
 * The declaration alone is not enough: a constructor inherited from a generic base such as
 * `class Derived extends Base<Dep>` declares its parameter as `T`, and only the instantiated
 * signature knows that `T` is `Dep` here.
 */
interface ParameterInfo {
	declaration: ts.ParameterDeclaration | undefined;
	type: ts.Type;
	trace: ts.Node;
}

export function transformClassDeclaration(state: TransformState, node: ts.ClassDeclaration) {
	const symbol = state.getSymbol(node);
	if (!symbol || !node.name) return state.transform(node);

	const metadata = NodeMetadata.fromCache(state, node);
	if (!hasReflectMetadata(state, node, metadata)) {
		return state.transform(node);
	}

	const importIdentifier = state.addFileImport(state.getSourceFile(node), CORE_PACKAGE, "Reflect");
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

	const parameters = method.parameters.map((declaration): ParameterInfo => ({
		declaration,
		type: state.typeChecker.getTypeAtLocation(declaration),
		trace: declaration,
	}));

	fields.push(...generateParametersMetadata(state, metadata, parameters));

	const baseSignature = state.typeChecker.getSignatureFromDeclaration(method);
	if (baseSignature) {
		if (metadata.isRequested("flamework:return_type")) {
			const id = getTypeUid(state, baseSignature.getReturnType(), method.name ?? method);
			fields.push(["flamework:return_type", id]);
		}

		if (metadata.isRequested("flamework:return_guard")) {
			const guard = buildGuardFromType(state, method.type ?? method, baseSignature.getReturnType());
			fields.push(["flamework:return_guard", guard]);
		}
	}

	return fields;
}

function generateParametersMetadata(state: TransformState, metadata: NodeMetadata, parameters: ParameterInfo[]) {
	const fields = new Array<[string, f.ConvertableExpression]>();

	generateMetadata("flamework:parameters", (param) => {
		return getTypeUid(state, param.type, param.trace);
	});

	generateMetadata("flamework:parameter_names", (param) => {
		return param.declaration && f.is.identifier(param.declaration.name) ? param.declaration.name.text : "_binding_";
	});

	generateMetadata("flamework:parameter_guards", (param) => {
		return buildGuardFromType(state, param.declaration ?? param.trace, param.type);
	});

	generateMetadata("flamework:dependencies", (param) => {
		return getDependencyInjectionMetadata(state, param.trace, param.type);
	});

	return fields;

	function generateMetadata(name: string, callback: (value: ParameterInfo) => f.ConvertableExpression) {
		if (metadata.isRequested(name)) {
			const values = new Array<f.ConvertableExpression>();

			for (const parameter of parameters) {
				values.push(callback(parameter));
			}

			fields.push([name, values]);
		}
	}
}

function generateClassMetadata(state: TransformState, metadata: NodeMetadata, node: ts.ClassDeclaration) {
	const symbol = state.getSymbol(node)!;
	const fields: [string, f.ConvertableExpression][] = [];

	if (metadata.isRequested("identifier")) {
		fields.push(["identifier", getNodeTypeUid(state, node)]);
	}

	if (metadata.isRequested("flamework:implements")) {
		const implementClauses = new Array<ts.StringLiteral>();

		if (node.heritageClauses) {
			for (const clause of node.heritageClauses) {
				if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
					continue;
				}

				for (const type of clause.types) {
					implementClauses.push(f.string(getNodeTypeUid(state, type)));
				}
			}
		}

		fields.push(["flamework:implements", f.array(implementClauses, false)]);
	}

	const [firstSignature] = state.typeChecker.getTypeOfSymbol(symbol).getConstructSignatures();
	if (firstSignature !== undefined) {
		// The parameter *types* come from the signature, not the declarations, so that a constructor
		// inherited from a generic base is seen with its type arguments applied.
		const parameters = firstSignature.parameters.map((parameter, index): ParameterInfo => {
			const declaration = parameter.declarations?.find(ts.isParameter);
			return {
				declaration,
				type: state.typeChecker.getParameterType(firstSignature, index),
				trace: declaration ?? node.name ?? node,
			};
		});

		fields.push(...generateParametersMetadata(state, metadata, parameters));
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
