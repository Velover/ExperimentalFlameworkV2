import ts from "typescript";
import type {
	BinaryOperator,
	Expression,
	Node,
	NodeFactory,
	ObjectLiteralField,
	Statement,
} from "@flamework-experimental/transformer-plugin";
import { f } from "../../util/factory";

/**
 * Plugins build nodes through this factory rather than touching `ts.factory`, so the emitted AST
 * stays valid regardless of what a plugin does. Each returned handle is an opaque `Node` whose
 * underlying `ts.Node` is recovered with {@link unwrapNode}.
 */

const NODES = new WeakMap<object, ts.Node>();

function handle<T extends Node>(node: ts.Node): T {
	const result = {} as T;
	NODES.set(result, node);

	return result;
}

export function unwrapNode(node: Node): ts.Node {
	const result = NODES.get(node as object);
	if (!result) {
		throw new Error("received a Node that was not created by this transformer's factory");
	}

	return result;
}

function expression(node: Node): ts.Expression {
	const result = unwrapNode(node);
	if (!ts.isExpression(result)) {
		throw new Error(`expected an expression, got ${ts.SyntaxKind[result.kind]}`);
	}

	return result;
}

function statement(node: Node): ts.Statement {
	const result = unwrapNode(node);
	if (!ts.isStatement(result)) {
		throw new Error(`expected a statement, got ${ts.SyntaxKind[result.kind]}`);
	}

	return result;
}

const BINARY_OPERATORS: Record<BinaryOperator, ts.BinaryOperator> = {
	"+": ts.SyntaxKind.PlusToken,
	"-": ts.SyntaxKind.MinusToken,
	"*": ts.SyntaxKind.AsteriskToken,
	"/": ts.SyntaxKind.SlashToken,
	"%": ts.SyntaxKind.PercentToken,
	"==": ts.SyntaxKind.EqualsEqualsEqualsToken,
	"!=": ts.SyntaxKind.ExclamationEqualsEqualsToken,
	"<": ts.SyntaxKind.LessThanToken,
	"<=": ts.SyntaxKind.LessThanEqualsToken,
	">": ts.SyntaxKind.GreaterThanToken,
	">=": ts.SyntaxKind.GreaterThanEqualsToken,
	"&&": ts.SyntaxKind.AmpersandAmpersandToken,
	"||": ts.SyntaxKind.BarBarToken,
	"??": ts.SyntaxKind.QuestionQuestionToken,
};

export function createNodeFactory(): NodeFactory {
	return {
		expr: {
			string: (value) => handle<Expression>(f.string(value)),
			number: (value) =>
				handle<Expression>(
					value < 0
						? ts.factory.createPrefixUnaryExpression(
								ts.SyntaxKind.MinusToken,
								ts.factory.createNumericLiteral(-value),
							)
						: ts.factory.createNumericLiteral(value),
				),
			bool: (value) => handle<Expression>(value ? ts.factory.createTrue() : ts.factory.createFalse()),
			nil: () => handle<Expression>(ts.factory.createIdentifier("undefined")),
			identifier: (name, unique) =>
				handle<Expression>(
					unique
						? ts.factory.createUniqueName(name, ts.GeneratedIdentifierFlags.Optimistic)
						: ts.factory.createIdentifier(name),
				),
			array: (values) => handle<Expression>(ts.factory.createArrayLiteralExpression(values.map(expression))),
			object: (fields) => {
				const entries: ObjectLiteralField[] = Array.isArray(fields)
					? fields
					: Object.entries(fields).map(([name, value]) => ({ name, value }));

				return handle<Expression>(
					ts.factory.createObjectLiteralExpression(
						entries.map((v) =>
							ts.factory.createPropertyAssignment(createPropertyName(v.name), expression(v.value)),
						),
						true,
					),
				);
			},
			call: (target, args) =>
				handle<Expression>(
					ts.factory.createCallExpression(expression(target), undefined, (args ?? []).map(expression)),
				),
			new: (target, args) =>
				handle<Expression>(
					ts.factory.createNewExpression(expression(target), undefined, (args ?? []).map(expression)),
				),
			property: (target, name) =>
				handle<Expression>(ts.factory.createPropertyAccessExpression(expression(target), name)),
			element: (target, index) =>
				handle<Expression>(ts.factory.createElementAccessExpression(expression(target), expression(index))),
			binary: (left, operator, right) => {
				const token = BINARY_OPERATORS[operator];
				if (token === undefined) {
					throw new Error(`unsupported binary operator '${operator}'`);
				}

				return handle<Expression>(
					ts.factory.createBinaryExpression(expression(left), token, expression(right)),
				);
			},
			not: (value) =>
				handle<Expression>(
					ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, expression(value)),
				),
			conditional: (condition, whenTrue, whenFalse) =>
				handle<Expression>(
					ts.factory.createConditionalExpression(
						expression(condition),
						undefined,
						expression(whenTrue),
						undefined,
						expression(whenFalse),
					),
				),
			arrow: (parameters, body) =>
				handle<Expression>(
					ts.factory.createArrowFunction(
						undefined,
						undefined,
						parameters.map((name) =>
							ts.factory.createParameterDeclaration(undefined, undefined, name, undefined, undefined),
						),
						undefined,
						undefined,
						Array.isArray(body)
							? ts.factory.createBlock(body.map(statement), true)
							: expression(body as Node),
					),
				),
			parenthesize: (value) => handle<Expression>(ts.factory.createParenthesizedExpression(expression(value))),
		},

		stmt: {
			variable: (name, value) =>
				handle<Statement>(
					ts.factory.createVariableStatement(
						undefined,
						ts.factory.createVariableDeclarationList(
							[
								ts.factory.createVariableDeclaration(
									expression(name) as ts.Identifier,
									undefined,
									undefined,
									expression(value),
								),
							],
							ts.NodeFlags.Const,
						),
					),
				),
			expression: (value) => handle<Statement>(ts.factory.createExpressionStatement(expression(value))),
			return: (value) =>
				handle<Statement>(ts.factory.createReturnStatement(value ? expression(value) : undefined)),
			block: (statements) => handle<Statement>(ts.factory.createBlock(statements.map(statement), true)),
			if: (condition, whenTrue, whenFalse) =>
				handle<Statement>(
					ts.factory.createIfStatement(
						expression(condition),
						statement(whenTrue),
						whenFalse ? statement(whenFalse) : undefined,
					),
				),
		},
	};
}

/**
 * Object keys that are not valid identifiers have to be emitted as string literals.
 */
function createPropertyName(name: string): ts.PropertyName {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? ts.factory.createIdentifier(name) : f.string(name);
}

export { handle as createNodeHandle };
