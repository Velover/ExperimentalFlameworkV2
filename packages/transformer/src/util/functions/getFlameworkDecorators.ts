import path from "path";
import ts from "typescript";
import { TransformState } from "../../classes/transformState";
import { f } from "../factory";
import { COMPONENTS_PACKAGE, CORE_PACKAGE } from "../packages";
import { getPackageJson } from "./getPackageJson";

/** The Flamework decorators whose presence on a class decides how a module can reach it. */
export type FlameworkDecoratorKind = "provider" | "component";

/** Each decorator by the package that declares it and its exported name. */
const DECORATORS: ReadonlyArray<[kind: FlameworkDecoratorKind, pkg: string, name: string]> = [
	["provider", CORE_PACKAGE, "Provider"],
	["component", COMPONENTS_PACKAGE, "Component"],
];

const cache = new WeakMap<ts.ClassLikeDeclaration, ReadonlySet<FlameworkDecoratorKind>>();

/**
 * Which of `@Provider()` and `@Component()` a class declaration carries itself -- not through a
 * parent, since a module registers a class by its own decorator only.
 *
 * A decorator is recognised by the declaration its name resolves to: the function of that name
 * exported by the Flamework package that owns it, found through the package.json above the
 * declaring file, so re-exports and aliased imports are followed, and a user's own function that
 * happens to share the name is not mistaken for it.
 */
export function getFlameworkDecorators(state: TransformState, declaration: ts.ClassLikeDeclaration) {
	const cached = cache.get(declaration);
	if (cached) return cached;

	const kinds = new Set<FlameworkDecoratorKind>();
	for (const decorator of (ts.canHaveDecorators(declaration) ? ts.getDecorators(declaration) : undefined) ?? []) {
		const expression = decorator.expression;
		const symbol = state.getSymbol(f.is.call(expression) ? expression.expression : expression);
		if (!symbol) continue;

		for (const decoratorDeclaration of symbol.declarations ?? []) {
			const packageName = getDeclaringPackage(decoratorDeclaration);
			for (const [kind, pkg, name] of DECORATORS) {
				if (symbol.name === name && packageName === pkg) {
					kinds.add(kind);
				}
			}
		}
	}

	cache.set(declaration, kinds);
	return kinds;
}

/**
 * The class declaration a type is the instance type of, when the type names a class declared with
 * `@Component()` and not `@Provider()`: a class a module can never construct or resolve, because
 * components are built by `Components` on the instances they are attached to.
 */
export function getComponentOnlyClass(state: TransformState, type: ts.Type) {
	const symbol = type.getSymbol();
	if (!symbol || !(symbol.flags & ts.SymbolFlags.Class)) return;

	for (const declaration of symbol.declarations ?? []) {
		if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;

		const kinds = getFlameworkDecorators(state, declaration);
		if (kinds.has("component") && !kinds.has("provider")) {
			return declaration;
		}
	}
}

function getDeclaringPackage(declaration: ts.Declaration) {
	try {
		return getPackageJson(path.dirname(declaration.getSourceFile().fileName)).result.name;
	} catch {
		return undefined;
	}
}

/**
 * Whether a called signature is one of core's own ways of resolving a dependency by type:
 * `Dependency<T>()` and `Module.resolveDependency<T>()`. A macro of the user's that takes a
 * `Modding.Target.Dependency<T>` may do anything with it, so only these two are judged.
 */
export function isCoreDependencyResolver(declaration: ts.Declaration | undefined) {
	if (!declaration) return false;

	let name: string | undefined;
	if (
		ts.isFunctionDeclaration(declaration) ||
		ts.isMethodDeclaration(declaration) ||
		ts.isMethodSignature(declaration)
	) {
		name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
	} else if (
		ts.isFunctionTypeNode(declaration) ||
		ts.isArrowFunction(declaration) ||
		ts.isFunctionExpression(declaration)
	) {
		// `resolveDependency: <T>(info?) => T` on the `Module` interface.
		const parent = declaration.parent;
		if (
			(ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
			ts.isIdentifier(parent.name)
		) {
			name = parent.name.text;
		}
	}

	if (name !== "Dependency" && name !== "resolveDependency") return false;
	return getDeclaringPackage(declaration) === CORE_PACKAGE;
}
