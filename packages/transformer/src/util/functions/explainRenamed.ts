import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { COMPONENTS_PACKAGE, CORE_PACKAGE } from "../packages";
import { getDeclaringPackage } from "./getFlameworkDecorators";

interface Rename {
	/** The name that replaces it, on the same type or namespace. */
	replacement: string;
	/** The package that declares the replacement: only its own declarations are explained. */
	pkg: string;
	/** The change, as the message words it, with the old name and the new one filled in. */
	explain: (old: string, replacement: string) => string;
}

const renamed = (old: string, replacement: string) => `'${old}' was renamed '${replacement}' before beta.`;

/** The names dropped before beta, by their old name. */
const RENAMES = new Map<string, Rename>([
	["onPostIgnite", { replacement: "onConstructed", pkg: CORE_PACKAGE, explain: renamed }],
	["createPlugin", { replacement: "builder", pkg: COMPONENTS_PACKAGE, explain: renamed }],
	["ancestorWhitelist", { replacement: "ancestorAllowList", pkg: COMPONENTS_PACKAGE, explain: renamed }],
	["ancestorBlacklist", { replacement: "ancestorBlockList", pkg: COMPONENTS_PACKAGE, explain: renamed }],
	[
		"Default",
		{
			replacement: "Contextual",
			pkg: COMPONENTS_PACKAGE,
			explain: (old, replacement) =>
				`'${old}' was removed before beta. It stood for '${replacement}', which replaces it.`,
		},
	],
]);

/**
 * TypeScript's codes for a name a type or a namespace does not have: 2339 and 2551 (a property, the
 * second with a guess), 2353 and 2561 (an object literal's key, the second with a guess), 2694 and
 * 2724 (a namespace's member, the second with a guess).
 */
const MISSING_NAME_CODES = new Set([2339, 2551, 2353, 2561, 2694, 2724]);

/**
 * TypeScript's error for a name Flamework renamed or removed before beta (`onPostIgnite`,
 * `ComponentPlugin.createPlugin`, `ancestorWhitelist`, `ancestorBlacklist`,
 * `ComponentStreamingMode.Default`), as one that names
 * the replacement; `undefined` for any other diagnostic. Only where the replacement exists on the
 * same type or namespace, declared by Flamework's package: a name of the user's that happens to
 * match keeps TypeScript's message. Only TypeScript's "does not exist" errors are looked at, so a
 * build without one pays nothing.
 */
export function explainRenamed(
	state: TransformState,
	diagnostic: ts.DiagnosticWithLocation,
): ts.DiagnosticWithLocation | undefined {
	if (!MISSING_NAME_CODES.has(diagnostic.code)) return undefined;

	const name = ts.getTokenAtPosition(diagnostic.file, diagnostic.start);
	if (!ts.isIdentifier(name)) return undefined;

	const rename = RENAMES.get(name.text);
	if (rename === undefined) return undefined;

	const replacement = findReplacement(state, name, rename.replacement);
	if (replacement === undefined) return undefined;

	const declaredByFlamework = replacement.declarations?.some(
		(declaration) => getDeclaringPackage(declaration) === rename.pkg,
	);
	if (!declaredByFlamework) return undefined;

	const parent = name.parent;
	const owner =
		(ts.isPropertyAccessExpression(parent) && parent.name === name) ||
		(ts.isQualifiedName(parent) && parent.right === name)
			? `${(ts.isPropertyAccessExpression(parent) ? parent.expression : parent.left).getText(diagnostic.file)}.`
			: "";

	return Diagnostics.createDiagnostic(
		name,
		ts.DiagnosticCategory.Error,
		rename.explain(`${owner}${name.text}`, `${owner}${rename.replacement}`),
		`Write '${rename.replacement}'.`,
	);
}

/** The symbol named `replacement` on whatever `name` was looked up on, if it has one. */
function findReplacement(state: TransformState, name: ts.Identifier, replacement: string) {
	const checker = state.typeChecker;
	const parent = name.parent;

	if (ts.isPropertyAccessExpression(parent) && parent.name === name) {
		return checker.getTypeAtLocation(parent.expression).getProperty(replacement);
	}

	if (ts.isQualifiedName(parent) && parent.right === name) {
		let namespace = checker.getSymbolAtLocation(parent.left);
		if (namespace && namespace.flags & ts.SymbolFlags.Alias) namespace = checker.getAliasedSymbol(namespace);
		return namespace?.exports?.get(replacement as ts.__String);
	}

	if (
		(ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
		parent.name === name &&
		ts.isObjectLiteralExpression(parent.parent)
	) {
		const contextual = checker.getContextualType(parent.parent);
		if (contextual === undefined) return undefined;

		for (const type of contextual.isUnion() ? contextual.types : [contextual]) {
			const property = type.getProperty(replacement);
			if (property !== undefined) return property;
		}
	}

	return undefined;
}
