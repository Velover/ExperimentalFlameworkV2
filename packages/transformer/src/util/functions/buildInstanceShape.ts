import ts from "typescript";
import { TransformState } from "../../classes/transformState";
import { f } from "../factory";
import { extractTypes, isInstanceType } from "./buildGuardFromType";
import { getInstanceTypeFromType } from "./getInstanceTypeFromType";

interface Shape {
	isA: string[];
	children?: Map<string, Shape>;
	optional: boolean;
}

/**
 * The instance tree a type describes, as the data `@flamework-experimental/components` checks and
 * watches: `{ isA = { "Model" }, children = { Root = { isA = { "BasePart" } } } }` for
 * `Model & { Root: BasePart }`.
 *
 * `componentChildren` names the direct children that are typed as a component. Their own trees
 * belong to that component -- its tracker checks and watches them -- so the shape stops at their
 * class.
 *
 * Nothing when the type says more than classes and children -- a union whose members declare
 * children of their own, a member that is not an instance -- and the caller falls back to a `t`
 * guard, which can say anything but has to read the whole tree to say it.
 */
export function buildInstanceShape(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	componentChildren?: ReadonlySet<string>,
): ts.Expression | undefined {
	const shape = readShape(state, node, type, false, true, componentChildren);

	return shape === undefined ? undefined : emitShape(shape);
}

function readShape(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	allowOptional: boolean,
	descend: boolean,
	componentChildren?: ReadonlySet<string>,
): Shape | undefined {
	const checker = state.typeChecker;
	let members: readonly ts.Type[] = [type];
	let optional = false;

	if (type.isUnion()) {
		const [isOptional, types] = extractTypes(checker, [...type.types]);
		if (isOptional && !allowOptional) return undefined;

		optional = isOptional;
		members = types;
	}

	if (members.length === 0) return undefined;

	const file = state.getSourceFile(node);
	const isA = new Array<string>();
	let children: Map<string, Shape> | undefined;

	for (const member of members) {
		if (!isInstanceType(member)) return undefined;

		const instanceType = getInstanceTypeFromType(file, member);
		const className = instanceType.symbol?.name;
		if (className === undefined) return undefined;
		if (!isA.includes(className)) isA.push(className);

		if (!descend) continue;

		const declared = new Map<string, Shape>();
		for (const property of member.getProperties()) {
			if (instanceType.getProperty(property.name)) continue;

			const propertyType = checker.getTypeOfPropertyOfType(member, property.name);
			if (!propertyType) return undefined;

			const child = readShape(state, node, propertyType, true, !componentChildren?.has(property.name));
			if (child === undefined) return undefined;

			declared.set(property.name, child);
		}

		if (declared.size > 0) {
			// Which children go with which class is more than a shape says.
			if (members.length > 1) return undefined;

			children = declared;
		}
	}

	return { isA, children, optional };
}

function emitShape(shape: Shape): ts.Expression {
	const properties: ts.ObjectLiteralElementLike[] = [
		f.propertyAssignmentDeclaration(
			"isA",
			f.array(
				shape.isA.map((name) => f.string(name)),
				false,
			),
		),
	];

	if (shape.children !== undefined) {
		const children = new Array<ts.ObjectLiteralElementLike>();
		for (const [name, child] of shape.children) {
			children.push(f.propertyAssignmentDeclaration(name, emitShape(child)));
		}

		properties.push(f.propertyAssignmentDeclaration("children", f.object(children, false)));
	}

	if (shape.optional) {
		properties.push(f.propertyAssignmentDeclaration("optional", true));
	}

	return f.object(properties, false);
}
