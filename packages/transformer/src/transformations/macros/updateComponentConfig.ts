import ts from "typescript";
import { TransformState } from "../../classes/transformState";
import { buildGuardFromType, buildGuardsFromType, isInstanceType } from "../../util/functions/buildGuardFromType";
import { f } from "../../util/factory";
import { getSuperClasses } from "../../util/functions/getSuperClasses";
import { NodeMetadata } from "../../classes/nodeMetadata";
import { withDiagnosticContext } from "../../util/diagnosticsUtils";
import { getInstanceTypeFromType } from "../../util/functions/getInstanceTypeFromType";
import { Diagnostics } from "../../classes/diagnostics";
import { getTypeUid } from "../../util/uid";

/**
 * The property every component carries, which is how a component type is told apart from the
 * Instance types around it.
 */
const COMPONENT_BRAND = "_flamework_link_instance";

/**
 * Reads one of `BaseComponent`'s type parameters through the property that carries it, so that a
 * subclass gets the instantiated type and an unrelated class gets nothing.
 */
function getMarkedType(state: TransformState, node: ts.ClassDeclaration, property: string, marker: string) {
	const type = state.typeChecker.getTypeAtLocation(node);

	const symbol = type.getProperty(property);
	if (!symbol) return;

	const metadata = NodeMetadata.fromSymbol(state, symbol);
	if (!metadata || !metadata.isRequested(marker)) return;

	return state.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
}

function calculateOmittedGuards(
	state: TransformState,
	classDeclaration: ts.ClassDeclaration,
	customAttributes?: ts.ObjectLiteralElementLike,
) {
	const omittedNames = new Set<string>();
	if (f.is.propertyAssignmentDeclaration(customAttributes) && f.is.object(customAttributes.initializer)) {
		for (const prop of customAttributes.initializer.properties) {
			if (f.is.string(prop.name) || f.is.identifier(prop.name)) {
				omittedNames.add(prop.name.text);
			}
		}
	}

	const type = state.typeChecker.getTypeAtLocation(classDeclaration);
	const property = type.getProperty("_flamework_attribute_guards");
	if (!property) return omittedNames;

	const superClass = getSuperClasses(state.typeChecker, classDeclaration)[0];
	if (!superClass) return omittedNames;

	const superType = state.typeChecker.getTypeAtLocation(superClass);
	const superProperty = superType.getProperty("_flamework_attribute_guards");
	if (!superProperty) return omittedNames;

	const attributes = state.typeChecker.getTypeOfSymbolAtLocation(property, classDeclaration);
	const superAttributes = state.typeChecker.getTypeOfSymbolAtLocation(superProperty, superClass);
	for (const { name } of superAttributes.getProperties()) {
		const prop = state.typeChecker.getTypeOfPropertyOfType(attributes, name);
		const superProp = state.typeChecker.getTypeOfPropertyOfType(superAttributes, name);

		if (prop && superProp && superProp === prop) {
			omittedNames.add(name);
		}
	}

	return omittedNames;
}

function updateAttributeGuards(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
) {
	// The guards come from the written shape of the attributes rather than the declared one: an
	// instance-valued attribute is stored as an `InstanceHandle`, so that is what is checked.
	const attributesType = getMarkedType(
		state,
		node,
		"_flamework_attribute_guards",
		"intrinsic-component-attribute-guards",
	);
	if (!attributesType) return;

	const attributes = properties.find((x) => x.name && "text" in x.name && x.name.text === "attributes");
	const attributeGuards = withDiagnosticContext(
		node.name ?? node,
		() => `Failed to generate component attributes: ${state.typeChecker.typeToString(attributesType)}`,
		() => buildGuardsFromType(state, node.name ?? node, attributesType),
	);

	const omittedGuards = calculateOmittedGuards(state, node, attributes);
	const filteredGuards = attributeGuards.filter((x) => !omittedGuards.has((x.name as ts.StringLiteral).text));
	properties = properties.filter((x) => x !== attributes);

	if (f.is.propertyAssignmentDeclaration(attributes) && f.is.object(attributes.initializer)) {
		properties.push(
			f.update.propertyAssignmentDeclaration(
				attributes,
				f.update.object(attributes.initializer, [
					...attributes.initializer.properties.map((v) => state.transformNode(v)),
					...filteredGuards,
				]),
				attributes.name,
			),
		);
	} else {
		properties.push(f.propertyAssignmentDeclaration("attributes", f.object(filteredGuards)));
	}

	return properties;
}

function updateInstanceGuard(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
) {
	const type = state.typeChecker.getTypeAtLocation(node);

	const property = type.getProperty("instance");
	if (!property) return;

	const attributesMeta = NodeMetadata.fromSymbol(state, property);
	if (!attributesMeta || !attributesMeta.isRequested("intrinsic-component-instance")) return;

	const superClass = getSuperClasses(state.typeChecker, node)[0];
	if (!superClass) return;

	const customGuard = properties.find((x) => x.name && "text" in x.name && x.name.text === "instanceGuard");
	if (customGuard) return;

	const instanceType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
	if (!instanceType) return;

	const superType = state.typeChecker.getTypeAtLocation(superClass);
	const superProperty = superType.getProperty("instance");
	if (!superProperty) return;

	const superInstanceType = state.typeChecker.getTypeOfSymbolAtLocation(superProperty, superClass);
	if (!superInstanceType) return;

	if (!type.checker.isTypeAssignableTo(superInstanceType, instanceType)) {
		const guard = buildGuardFromType(state, node, instanceType);
		properties.push(f.propertyAssignmentDeclaration("instanceGuard", guard));
	}

	return properties;
}

/**
 * The instance a component type is attached to, or nothing when the type is not a component. This
 * is the resolved tree rather than the declared one, so a linked component's own children are part
 * of the guard.
 */
function getComponentInstanceType(state: TransformState, type: ts.Type, node: ts.Node) {
	if (!type.getProperty(COMPONENT_BRAND)) return;

	const instance = type.getProperty("instance");
	if (!instance) return;

	return state.typeChecker.getTypeOfSymbolAtLocation(instance, node);
}

/**
 * The members of an instance type that are not part of the Roblox class itself, which is how the
 * guard builder reads an intersection: as the children the instance must have.
 */
function getDeclaredChildren(state: TransformState, node: ts.ClassDeclaration, type: ts.Type) {
	const instanceType = getInstanceTypeFromType(node.getSourceFile(), type);
	const children = new Array<[ts.Symbol, ts.Type]>();

	for (const property of type.getProperties()) {
		if (instanceType.getProperty(property.name)) continue;

		const propertyType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
		if (propertyType) children.push([property, propertyType]);
	}

	return children;
}

function isOptionalMember(state: TransformState, symbol: ts.Symbol, type: ts.Type) {
	return (symbol.flags & ts.SymbolFlags.Optional) !== 0 || state.typeChecker.getNonNullableType(type) !== type;
}

function createLink(
	state: TransformState,
	node: ts.ClassDeclaration,
	kind: "attribute" | "child",
	name: string,
	optional: boolean,
	componentType?: ts.Type,
	guardType?: ts.Type,
) {
	const fields: ts.ObjectLiteralElementLike[] = [
		f.propertyAssignmentDeclaration("kind", kind),
		f.propertyAssignmentDeclaration("name", name),
		f.propertyAssignmentDeclaration("optional", optional),
	];

	if (guardType) {
		fields.push(
			f.propertyAssignmentDeclaration(
				"guard",
				withDiagnosticContext(
					node.name ?? node,
					() => `Failed to generate a guard for the '${name}' link`,
					() => buildGuardFromType(state, node.name ?? node, guardType),
				),
			),
		);
	}

	if (componentType) {
		fields.push(f.propertyAssignmentDeclaration("component", getTypeUid(state, componentType, node.name ?? node)));
	}

	return f.object(fields, false);
}

/**
 * Discovers the components and instances a component links to, from the attributes it declares and
 * from its instance tree. `Components` waits for each one and keeps it resolved.
 */
function updateLinks(state: TransformState, node: ts.ClassDeclaration, properties: ts.ObjectLiteralElementLike[]) {
	const attributesType = getMarkedType(
		state,
		node,
		"_flamework_link_attributes",
		"intrinsic-component-attribute-links",
	);
	const instanceType = getMarkedType(state, node, COMPONENT_BRAND, "intrinsic-component-instance-links");
	if (!attributesType && !instanceType) return;

	const links = new Array<ts.Expression>();

	if (attributesType) {
		for (const property of attributesType.getProperties()) {
			const declaredType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
			const targetType = state.typeChecker.getNonNullableType(declaredType);
			const optional = isOptionalMember(state, property, declaredType);

			const componentInstance = getComponentInstanceType(state, targetType, node);
			if (componentInstance) {
				links.push(
					createLink(state, node, "attribute", property.name, optional, targetType, componentInstance),
				);
			} else if (isInstanceType(targetType)) {
				links.push(createLink(state, node, "attribute", property.name, optional, undefined, targetType));
			}
		}
	}

	if (instanceType) {
		for (const [property, declaredType] of getDeclaredChildren(state, node, instanceType)) {
			const targetType = state.typeChecker.getNonNullableType(declaredType);
			const optional = isOptionalMember(state, property, declaredType);

			if (getComponentInstanceType(state, targetType, node)) {
				// A child's own guard is part of the component's instance guard, so the link only
				// has to name the component that must exist on it.
				links.push(createLink(state, node, "child", property.name, optional, targetType));
			} else if (isInstanceType(targetType)) {
				if (optional) assertChildIsRequired(node, property, property.name);

				assertInstanceTree(state, node, targetType, property.name);
			}
		}
	}

	if (links.length !== 0) {
		properties.push(f.propertyAssignmentDeclaration("links", f.array(links)));
	}

	return properties;
}

/**
 * The node a diagnostic about a declared child belongs on, which is the child itself wherever it
 * was written down, and the component otherwise.
 */
function getPropertyNode(node: ts.ClassDeclaration, property: ts.Symbol): ts.Node {
	const declaration = property.valueDeclaration ?? property.declarations?.[0];
	if (!declaration) return node.name ?? node;

	return f.is.namedDeclaration(declaration) ? declaration.name : declaration;
}

/**
 * A child of the instance tree cannot be optional. `this.instance.Head` is an index into the
 * instance itself, and Roblox raises on a child that is not there rather than handing back nothing,
 * so the optional type would promise a read that is not safe to make.
 *
 * A child typed as a *component* is the exception, and is let through above: it is a link, so its
 * presence is watched and `childComponents.Head` -- an ordinary table read -- is what says whether
 * the child is there.
 */
function assertChildIsRequired(node: ts.ClassDeclaration, property: ts.Symbol, path: string): never {
	const component = node.name ? ` of '${node.name.text}'` : "";

	// Naming a component is only an option for a direct child; one deeper in the tree cannot be
	// linked at all, so it is not offered as a way out there.
	const link = path.includes(".")
		? ""
		: " type it as a component so that Flamework watches it and 'childComponents' says whether it is there, or";

	Diagnostics.error(
		getPropertyNode(node, property),
		`Child '${path}' of the instance tree${component} is optional, which Flamework does not allow: Roblox raises when a child that does not exist is indexed, so 'this.instance.${path}' would error rather than be undefined.`,
		`Require the child,${link} leave it out of the tree and reach for it with FindFirstChild.`,
	);
}

/**
 * Checks the children declared below a direct child of the instance tree.
 *
 * A component deeper in the tree cannot be linked: `this.instance` only resolves components it
 * holds directly, and the guard builder would meet the class itself. Saying so here beats the
 * "Flamework does not support generating guards for classes" that would follow. An optional child
 * is refused at every depth, for the same reason it is refused at the top.
 */
function assertInstanceTree(state: TransformState, node: ts.ClassDeclaration, type: ts.Type, path: string): void {
	for (const [property, declaredType] of getDeclaredChildren(state, node, type)) {
		const targetType = state.typeChecker.getNonNullableType(declaredType);
		const childPath = `${path}.${property.name}`;

		if (targetType.getProperty(COMPONENT_BRAND)) {
			Diagnostics.error(
				node.name ?? node,
				`Component '${state.typeChecker.typeToString(targetType)}' is linked at '${childPath}', which is not a direct child of this component.`,
				"Only a direct child of the instance tree can name a component. Declare it on the component attached to that child, or look it up with getComponent.",
			);
		}

		if (isInstanceType(targetType)) {
			if (isOptionalMember(state, property, declaredType)) {
				assertChildIsRequired(node, property, childPath);
			}

			assertInstanceTree(state, node, targetType, childPath);
		}
	}
}

export function updateComponentConfig(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
): ts.ObjectLiteralElementLike[] {
	// Links first: they are what reports a component the guards cannot be generated for, and that
	// reads far better than the "cannot generate a guard for a class" the guards would raise.
	properties = updateLinks(state, node, properties) ?? properties;
	properties = updateAttributeGuards(state, node, properties) ?? properties;
	properties = updateInstanceGuard(state, node, properties) ?? properties;
	return properties;
}
