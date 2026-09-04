/**
 * Declarations for the TypeScript compiler internals this transformer relies on.
 *
 * These used to come from `ts-expose-internals`, which stopped tracking TypeScript at 5.6 and so
 * capped the whole project to a 2024 compiler. Declaring only what is actually used keeps the
 * transformer buildable against current TypeScript, and makes the coupling to compiler internals
 * explicit rather than implicit in a dependency.
 *
 * Everything here is unsupported API. When bumping TypeScript, a compile error in this file is the
 * signal that an internal changed shape.
 */

import "typescript";

declare module "typescript" {
	// -- module-level functions --

	function findPackageJson(directory: string, host: ModuleResolutionHost): string | undefined;
	function forEachAncestorDirectory<T>(
		directory: string,
		callback: (directory: string) => T | undefined,
	): T | undefined;

	function getSourceFileOfNode(node: Node): SourceFile;
	function getNameFromPropertyName(name: DeclarationName): string | undefined;
	function getPropertyNameForPropertyNameNode(name: PropertyName): __String | undefined;
	function getEffectiveImplementsTypeNodes(node: ClassLikeDeclaration): ExpressionWithTypeArguments[] | undefined;
	function getLineOfLocalPosition(sourceFile: SourceFile, pos: number): number;

	function skipAlias(symbol: Symbol, checker: TypeChecker): Symbol;
	function addRelatedInfo<T extends Diagnostic>(diagnostic: T, ...related: DiagnosticRelatedInformation[]): T;

	function isDiagnosticWithLocation(diagnostic: Diagnostic): diagnostic is DiagnosticWithLocation;
	function isDeclarationReadonly(declaration: Declaration): boolean;
	function isNamedDeclaration(node: Node): node is NamedDeclaration & { name: DeclarationName };
	function isNamespaceBody(node: Node): node is ModuleBody;
	function isAccessExpression(node: Node): node is PropertyAccessExpression | ElementAccessExpression;
	function isSuperKeyword(node: Node): boolean;
	function isSimpleInlineableExpression(expression: Expression): boolean;
	function hasStaticModifier(node: Node): boolean;
	function signatureHasRestParameter(signature: Signature): boolean;

	function copyComments(source: Node, target: Node): void;
	function removeAllComments<T extends Node>(node: T): T;

	// -- interface members --

	interface TypeChecker {
		getTypeOfPropertyOfType(type: Type, propertyName: string): Type | undefined;
		getUnionType(types: Type[], subtypeReduction?: number): Type;
		getElementTypeOfArrayType(type: Type): Type | undefined;
		getParameterType(signature: Signature, parameterIndex: number): Type;
		getNeverType(): Type;
		getAnyType(): Type;
		getTrueType(): Type;
		getFalseType(): Type;
	}

	interface Program {
		getCommonSourceDirectory(): string;
	}

	interface TransformationContext {
		addDiagnostic(diagnostic: DiagnosticWithLocation): void;
	}

	interface Type {
		id?: number;
		checker: TypeChecker;
	}

	interface Symbol {
		parent?: Symbol;
	}

	interface Declaration {
		symbol: Symbol;
	}

	interface TypeReference {
		resolvedTypeArguments?: Type[];
	}

	interface IntrinsicType extends Type {
		intrinsicName: string;
	}
}
