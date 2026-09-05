import ts from "typescript";
import { Diagnostics } from "../classes/diagnostics";
import { TransformState } from "../classes/transformState";
import { f } from "../util/factory";
import { buildInlineEncoding, buildInlineResultEncoding } from "../util/functions/buildSerializerFromType";

/**
 * With `networking.serialization` on, a call that sends over a networking handler packs its
 * argument list right where it is made: the encoding is generated inline from the handler's types
 * and the packed `(payload, blobs?)` goes to the handler's hidden `_fire` / `_invoke` entry point.
 * A function receiver's callback is wrapped the same way so that its results leave packed.
 *
 * Nothing in the output can encode on its own; only these call sites do. Decoding stays in the
 * handler metadata, because a remote's payload has to be unpacked before the guards and middleware
 * see it, which is why the receiving side needs a function and the sending side does not.
 *
 * Call sites are found by type: the handler members carry hidden `_flamework_send` /
 * `_flamework_fn` markers. A member declared `Networking.Raw*` has no marker and is left alone, as is
 * a handler reached through a widened type (which then sends unpacked values that the peer rejects
 * as malformed). An argument list that carries nothing (`bump(): void`) sends no payload at all.
 */

/** Sending methods and the hidden entry point each becomes. */
const SENDERS: Record<string, string> = {
	fire: "_fire",
	except: "_except",
	broadcast: "_broadcast",
	invoke: "_invoke",
	invokeWithTimeout: "_invokeWithTimeout",
};

export function transformNetworkingCall(state: TransformState, node: ts.CallExpression): ts.Expression | undefined {
	if (state.projectConfig.networking?.serialization !== true) return;

	const typeChecker = state.typeChecker;
	const callee = node.expression;

	if (f.is.propertyAccessExpression(callee)) {
		const name = callee.name.text;
		const target = typeChecker.getTypeAtLocation(callee.expression);

		if (name === "setCallback" && target.getProperty("_flamework_fn")) {
			return transformReceiverCallback(state, node, callee.expression, target);
		}

		if (SENDERS[name] !== undefined && target.getProperty("_flamework_send")) {
			return transformSend(state, node, callee.expression, target, SENDERS[name]);
		}
	}

	// `handler.event(...)` and `handler.fn(...)`: the call signature is the sender itself.
	const target = typeChecker.getTypeAtLocation(callee);
	if (target.getProperty("_flamework_send")) {
		return transformSend(state, node, callee, target, target.getProperty("_invoke") ? "_invoke" : "_fire");
	}
}

/**
 * `handler.x.fire(lead..., a, b)` becomes `handler.x._fire(lead..., payload, blobs?)`, with the packing
 * emitted ahead of the statement. The leading arguments (players, a timeout) pass through.
 */
function transformSend(
	state: TransformState,
	node: ts.CallExpression,
	target: ts.Expression,
	targetType: ts.Type,
	method: string,
): ts.Expression | undefined {
	const typeChecker = state.typeChecker;
	const signature = typeChecker.getResolvedSignature(node);
	const declaration = signature?.declaration;
	if (!declaration || !ts.isFunctionLike(declaration)) return;

	// The declared signature is `(lead..., ...args: I)`; the resolved one has `I` expanded.
	const restIndex = declaration.parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined);
	if (restIndex === -1) return;

	const listType = markerType(state, targetType, "_flamework_send", node);
	if (!listType) return;

	const args = node.arguments.map((argument) => state.transformNode(argument));
	const leading = args.slice(0, restIndex);
	const packed = args.slice(restIndex);

	if (leading.some(ts.isSpreadElement)) {
		Diagnostics.error(
			node,
			"Flamework cannot pack this call: a spread argument ahead of the payload is not supported with networking.serialization enabled.",
		);
	}

	const statements = new Array<ts.Statement>();
	const leadingValues = leading.map((argument) => bindArgument(statements, argument, "target"));

	let encoding;
	if (packed.some(ts.isSpreadElement)) {
		// A spread makes the count a runtime matter: gather the list first, as `fire` itself would.
		const table = f.identifier("args", true);
		statements.push(f.variableStatement(table, f.as(f.array(packed, false), arrayType())));
		encoding = buildInlineEncoding(state, node, listType, { table });
	} else {
		const values = packed.map((argument) => bindArgument(statements, argument, "arg"));
		encoding = buildInlineEncoding(state, node, listType, values);
	}

	statements.push(...encoding.statements);

	const transformedTarget = state.transformNode(target);
	const call = f.call(f.propertyAccessExpression(transformedTarget, f.identifier(method)), [
		...leadingValues,
		...packedArguments(encoding),
	]);
	return emitWithStatements(state, node, statements, call);
}

/** `payload, blobs`, `payload`, or nothing at all when the list carries nothing. */
function packedArguments(encoding: { payload: ts.Identifier | undefined; blobs: ts.Identifier | undefined }) {
	if (!encoding.payload) return [];
	return encoding.blobs ? [encoding.payload, encoding.blobs] : [encoding.payload];
}

/**
 * The packing statements go ahead of the enclosing statement when that keeps them in the call's
 * scope. Inside an expression-bodied arrow there is no such statement, so the call is wrapped in an
 * immediately invoked function that holds them instead.
 */
function emitWithStatements(
	state: TransformState,
	node: ts.Node,
	statements: ts.Statement[],
	call: ts.Expression,
): ts.Expression {
	if (statements.length === 0) return call;

	let current: ts.Node | undefined = node.parent;
	while (current !== undefined && !ts.isStatement(current)) {
		if (ts.isFunctionLike(current)) {
			return f.call(f.arrowFunction(f.block([...statements, f.returnStatement(call)])), []);
		}

		current = current.parent;
	}

	state.prereqList(statements);
	return call;
}

/**
 * `handler.fn.setCallback(cb)` becomes `handler.fn._setCallback((lead..., a, b) => pack(cb(lead..., a, b)))`,
 * where `pack` turns a successful result into `[payload, blobs?]` (or nothing, for a `void` result),
 * follows a Promise if the callback returned one, and lets `Networking.Skip` through untouched.
 */
function transformReceiverCallback(
	state: TransformState,
	node: ts.CallExpression,
	target: ts.Expression,
	targetType: ts.Type,
): ts.Expression | undefined {
	const typeChecker = state.typeChecker;
	const callbackArgument = node.arguments[0];
	if (!callbackArgument) return;

	const listType = markerType(state, targetType, "_flamework_receive", node);
	const fnType = markerType(state, targetType, "_flamework_fn", node);
	if (!listType || !fnType) return;

	// How many arguments precede the list: the callback type is declared `(lead..., ...args: I) => ...`.
	const signature = typeChecker.getResolvedSignature(node);
	const declaration = signature?.declaration;
	if (!declaration || !ts.isFunctionLike(declaration)) return;
	const callbackType = declaration.parameters[0]?.type;
	if (!callbackType || !ts.isFunctionTypeNode(callbackType)) return;
	const leadingCount = callbackType.parameters.filter((parameter) => parameter.dotDotDotToken === undefined).length;

	const statements = new Array<ts.Statement>();

	// The callback keeps the parameter types `setCallback` would have given it: an arrow bound to a
	// plain local would lose its contextual typing and end up with implicit `any` parameters.
	const boundTarget = bindArgument(statements, state.transformNode(target), "target");
	const callbackAnnotation = f.indexedAccessType(
		f.referenceType("Parameters", [f.queryType(f.qualifiedNameType(boundTarget as ts.Identifier, "setCallback"))]),
		f.literalType(f.number(0)),
	);
	const callback = f.identifier("callback", true);
	statements.push(f.variableStatement(callback, state.transformNode(callbackArgument), callbackAnnotation));

	// The wrapper mirrors the callback's parameters, so nothing is gathered into a table per call.
	const parameters = new Array<ts.ParameterDeclaration>();
	const forwarded = new Array<ts.Expression>();
	for (let i = 0; i < leadingCount; i++) {
		const id = f.identifier("lead", true);
		parameters.push(f.parameterDeclaration(id, f.keywordType(ts.SyntaxKind.UnknownKeyword)));
		forwarded.push(id);
	}

	if (typeChecker.isTupleType(listType)) {
		const tuple = listType as ts.TupleTypeReference;
		tuple.target.elementFlags.forEach((flags) => {
			const id = f.identifier("arg", true);
			if (flags & ts.ElementFlags.Rest) {
				parameters.push(f.parameterDeclaration(id, arrayType(), undefined, false, true));
				forwarded.push(ts.factory.createSpreadElement(id));
			} else {
				parameters.push(f.parameterDeclaration(id, f.keywordType(ts.SyntaxKind.UnknownKeyword)));
				forwarded.push(id);
			}
		});
	}

	const callable = f.functionType(
		[f.parameterDeclaration("args", arrayType(), undefined, false, true)],
		f.keywordType(ts.SyntaxKind.UnknownKeyword),
	);
	const result = f.identifier("result", true);
	const body = new Array<ts.Statement>();
	body.push(f.variableStatement(result, f.call(f.as(callback, callable), forwarded)));

	// A Promise is followed; its value is packed once it resolves.
	const value = f.identifier("value", true);
	const packLater = f.arrowFunction(f.block(packResult(state, node, fnType, value, true)), [
		f.parameterDeclaration(value),
	]);
	body.push(
		ts.factory.createIfStatement(
			f.call(f.propertyAccessExpression(f.identifier("Promise"), f.identifier("is")), [result]),
			f.block([f.returnStatement(f.call(f.propertyAccessExpression(result, f.identifier("then")), [packLater]))]),
		),
	);
	body.push(...packResult(state, node, fnType, result, false));

	const wrapper = f.arrowFunction(f.block(body), parameters);
	const call = f.call(f.propertyAccessExpression(boundTarget, f.identifier("_setCallback")), [wrapper]);
	return emitWithStatements(state, node, statements, call);
}

/**
 * `if (v === Networking.Skip) return v; <pack v>; return [payload, blobs?]`, or `return undefined`
 * when the result type carries nothing.
 */
function packResult(
	state: TransformState,
	node: ts.CallExpression,
	fnType: ts.Type,
	value: ts.Identifier,
	isParameter: boolean,
): ts.Statement[] {
	const networking = state.addFileImport(state.getSourceFile(node), "@flamework/networking", "Networking");
	const skip = f.propertyAccessExpression(networking, f.identifier("Skip"));
	const encoding = buildInlineResultEncoding(state, node, fnType, value, isParameter);
	const packed = packedArguments(encoding);

	return [
		ts.factory.createIfStatement(
			f.binary(value, ts.SyntaxKind.EqualsEqualsEqualsToken, skip),
			f.block([f.returnStatement(value)]),
		),
		...encoding.statements,
		f.returnStatement(packed.length > 0 ? f.as(f.array(packed, false), arrayType()) : f.nil()),
	];
}

/** The type a hidden marker property carries, without the `undefined` its optionality adds. */
function markerType(state: TransformState, type: ts.Type, marker: string, node: ts.Node): ts.Type | undefined {
	const property = type.getProperty(marker);
	if (!property) return;

	const markerType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
	return state.typeChecker.getNonNullableType(markerType);
}

/**
 * An argument that is read more than once is evaluated once, in call order, into a local. Identifiers
 * and literals are returned as they are; anything else comes back as the new local's identifier.
 */
function bindArgument(statements: ts.Statement[], argument: ts.Expression, hint: string): ts.Expression {
	if (
		ts.isIdentifier(argument) ||
		ts.isLiteralExpression(argument) ||
		argument.kind === ts.SyntaxKind.TrueKeyword ||
		argument.kind === ts.SyntaxKind.FalseKeyword
	) {
		return argument;
	}

	const id = f.identifier(hint, true);
	statements.push(f.variableStatement(id, argument));
	return id;
}

function arrayType() {
	return f.referenceType("Array", [f.keywordType(ts.SyntaxKind.UnknownKeyword)]);
}
