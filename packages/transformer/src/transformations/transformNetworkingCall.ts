import ts from "typescript";
import { Diagnostics } from "../classes/diagnostics";
import { TransformState } from "../classes/transformState";
import { f } from "../util/factory";
import { buildInlineEncoding, buildInlineResultEncoding, packingKey } from "../util/functions/buildSerializerFromType";
import { getNetworkMode, isPackedMode, NetworkMode } from "../util/functions/networkMode";

/**
 * A call that sends over a packed networking member -- every member but the raw ones with
 * `networking.serialization` on, the ones declared `Serialized` otherwise -- packs its argument list
 * right where it is made: the encoding is generated inline from the handler's types and the packed
 * `(payload, blobs?)` goes to the handler's hidden `_fire` / `_invoke` entry point.
 * A function receiver's callback is registered with a generated `pack` for its result type, which
 * the runtime applies to what the middleware chain resolves with, so that results leave packed.
 *
 * Apart from those result packers, nothing in the output can encode on its own; only these call
 * sites do. Decoding stays in the handler metadata, because a remote's payload has to be unpacked
 * before the guards and middleware see it, which is why the receiving side needs a function and
 * the sending side does not.
 *
 * Call sites are found by type: the handler members carry hidden `_flamework_send` /
 * `_flamework_fn` markers, the second holding the declared member, whose own markers say how it is
 * packed. A member declared `Networking.Raw*` has no marker and is left alone, as is
 * a handler reached through a widened type (which then sends unpacked values that the peer rejects
 * as malformed). A handler reached through `?.` is typed with `undefined` in it; the marker is looked
 * for on the rest. An argument list that carries nothing (`bump(): void`) sends no payload at all.
 *
 * A target typed as a union of members (a conditional, or a helper that returns one of several
 * members) is packed when every member in it is, the same way, and left alone when none is. Members
 * that are packed differently are refused, since whatever the call site did would not suit some of
 * them, and so are packed members whose argument lists (for `setCallback`, results) are laid out
 * differently on the wire. Their handler types carry how they are packed (`_flamework_packing`), so
 * that such a union does not reduce to the one member type the others extend. Members packed the same
 * way whose types are the same but for how their unions are spelled are one type to TypeScript all the
 * same, and a conditional or an inferred return type keeps only one of them: see the known limit in
 * guide 06.
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
	const typeChecker = state.typeChecker;
	const callee = node.expression;

	if (f.is.propertyAccessExpression(callee)) {
		const name = callee.name.text;
		if (name === "setCallback" || SENDERS[name] !== undefined) {
			const target = typeChecker.getNonNullableType(typeChecker.getTypeAtLocation(callee.expression));
			const optional = callee.questionDotToken !== undefined;
			const isCallback = name === "setCallback";

			const member = packedMember(
				state,
				target,
				isCallback ? "_flamework_fn" : "_flamework_send",
				callee.expression,
				node,
			);
			if (member) {
				return isCallback
					? transformReceiverCallback(state, node, callee.expression, member, optional)
					: transformSend(state, node, callee.expression, member, SENDERS[name], optional);
			}
		}
	}

	// `handler.event(...)` and `handler.fn(...)`: the call signature is the sender itself. This is also
	// how a member named like a method (an event called `fire`) is reached.
	const target = typeChecker.getNonNullableType(typeChecker.getTypeAtLocation(callee));
	const member = packedMember(state, target, "_flamework_send", callee, node);
	if (!member) return;

	const method = member.getProperty("_invoke") ? "_invoke" : "_fire";
	return transformSend(state, node, callee, member, method, node.questionDotToken !== undefined);
}

/** One of the types a call's target may be, and how a call on it is sent. */
interface TargetMember {
	type: ts.Type;
	/** `other` for a value that is not a networking member this kind of call packs for. */
	mode: NetworkMode | "other";
	packed: boolean;
}

/**
 * The handler member a call on `targetType` packs for, or `undefined` when the call is left as it is.
 * `marker` is what makes a member one this kind of call can pack: `_flamework_send` for a send,
 * `_flamework_fn` for `setCallback`. Whether it does follows the markers on its declared type
 * (`_flamework_fn`) and the project's switch; a member declared with conflicting markers is refused
 * here.
 *
 * A target typed as a union of members is packed only when every member is, and then as the first
 * of them. Members that are packed differently are refused, and so are packed members whose
 * argument lists (for `setCallback`, results) are laid out differently on the wire (`packingKey`):
 * one call site packs one way.
 */
function packedMember(
	state: TransformState,
	targetType: ts.Type,
	marker: "_flamework_send" | "_flamework_fn",
	target: ts.Expression,
	node: ts.CallExpression,
): ts.Type | undefined {
	const typeChecker = state.typeChecker;
	const targetName = ts.getParseTreeNode(target)?.getText();
	const resolved =
		targetType.flags & ts.TypeFlags.Instantiable ? typeChecker.getApparentType(targetType) : targetType;

	const members = (resolved.isUnion() ? resolved.types : [resolved]).map((type): TargetMember => {
		if (type.getProperty(marker)) {
			const mode = getNetworkMode(markerType(state, type, "_flamework_fn", node), node, targetName);
			return { type, mode, packed: isPackedMode(state, mode) };
		}

		// A raw member carries `_flamework_packing` without the marker.
		return { type, mode: type.getProperty("_flamework_packing") ? "raw" : "other", packed: false };
	});

	const packed = members.filter((member) => member.packed);
	if (packed.length === 0) return;

	const isCallback = marker === "_flamework_fn";
	if (packed.length < members.length) {
		refuseMixedTarget(
			node,
			describeModes(state, members),
			isCallback
				? "One call site packs the results of all of them or of none, so the callers of some would reject what the callback returns."
				: "One call site packs for all of them or for none, so some would drop what it sends as malformed.",
		);
	}

	// Several members that all pack: the one encoding has to suit each of them. Each member's receiver
	// (for a callback, each caller) decodes with the layout of its own declaration, which follows how its
	// unions are spelled as much as its types (`(x: string | number)` against `(x: number | string)`, one
	// TypeScript type), so the layouts are what is compared. Where they agree, any member packs the same.
	if (packed.length > 1) {
		const keyed = packed
			.map((member) => {
				const carried = markerType(state, member.type, isCallback ? "_flamework_fn" : "_flamework_send", node);
				const key = carried ? packingKey(state, node, carried, isCallback) : undefined;
				return { key, text: memberText(state, member.type, node) };
			})
			.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
		const other = keyed.find(({ key }) => key === undefined || key !== keyed[0].key);
		if (other) {
			const what = isCallback ? "results" : "argument lists";
			refuseMixedTarget(
				node,
				`their ${what} are laid out differently ('${keyed[0].text}' and '${other.text}')`,
				isCallback
					? "One call site packs the callback's results one way, so the callers of the other would read them wrong."
					: "One call site packs one way, so the receiver of the other would read what it sends wrong.",
			);
		}
	}

	return packed[0].type;
}

/**
 * A member as declared, for a message: the interface and the member's name, then its parameters and
 * result as written (`ServerEvents.move(x: string | number): void`), where TypeScript's own printing
 * would show every spelling of a union in one order.
 */
function memberText(state: TransformState, member: ts.Type, node: ts.Node): string {
	const declaration = markerType(state, member, "_flamework_fn", node)?.getCallSignatures()[0]?.getDeclaration();
	if (!declaration || !ts.isFunctionLike(declaration)) return state.typeChecker.typeToString(member);

	// A method (`move(x): void`), or the property (`move: Networking.Unreliable<(x) => void>`) or alias a
	// function type is written in.
	const owner = ts.findAncestor(
		declaration,
		(ancestor) =>
			ts.isMethodSignature(ancestor) || ts.isPropertySignature(ancestor) || ts.isTypeAliasDeclaration(ancestor),
	);
	let name = "";
	if (owner && ts.isTypeAliasDeclaration(owner)) {
		name = owner.name.text;
	} else if (owner && (ts.isMethodSignature(owner) || ts.isPropertySignature(owner))) {
		const container = ts.isInterfaceDeclaration(owner.parent) ? `${owner.parent.name.text}.` : "";
		name = `${container}${owner.name.getText()}`;
	}

	const parameters = declaration.parameters.map((parameter) => parameter.getText()).join(", ");
	const result = declaration.type ? `: ${declaration.type.getText()}` : "";
	return `${name}(${parameters})${result}`.replace(/\s+/g, " ");
}

/** How the members of a mixed target are sent, one phrase per way. */
function describeModes(state: TransformState, members: TargetMember[]): string {
	const switchOn = state.projectConfig.networking?.serialization === true;
	const phrases: Record<TargetMember["mode"], string> = {
		serialized: "Serialized members are packed into a buffer",
		plain: switchOn
			? "plain members are packed, as networking.serialization is on"
			: "plain members are sent as they are, as networking.serialization is off",
		raw: "Raw members are sent as they are",
		other: "a value that is not a networking member is called as it is",
	};

	const modes = new Set(members.map((member) => member.mode));
	return (["serialized", "plain", "raw", "other"] as const)
		.filter((mode) => modes.has(mode))
		.map((mode) => phrases[mode])
		.join("; ");
}

/** The build error for a call whose target may be members that one call site cannot pack for. */
function refuseMixedTarget(node: ts.CallExpression, what: string, consequence: string): never {
	const text = ts.getParseTreeNode(node.expression)?.getText().replace(/\s+/g, " ");
	const call = text !== undefined ? `The call '${text}(...)'` : "This call";
	return Diagnostics.error(
		node,
		`${call} may reach networking members that are packed differently: ${what}.`,
		consequence,
		"Make the call where the member's own type is known, such as in each case of a switch over the name, or declare these members the same way.",
	);
}

/**
 * `handler.x.fire(lead..., a, b)` becomes `handler.x._fire(lead..., payload, blobs?)`, with the packing
 * emitted ahead of the statement. The leading arguments (players, a timeout) pass through. The
 * target is evaluated first, as the call would: one that is more than a plain read is bound to a
 * local ahead of the arguments.
 */
function transformSend(
	state: TransformState,
	node: ts.CallExpression,
	target: ts.Expression,
	targetType: ts.Type,
	method: string,
	optionalTarget: boolean,
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
			"Flamework cannot pack this call: a spread argument ahead of the payload is not supported for a packed member (networking.serialization or Serialized).",
		);
	}

	const statements = new Array<ts.Statement>();
	const chained = guardOptionalChain(state, statements, target, optionalTarget);
	const transformedTarget = chained.target;
	const leadingValues = leading.map((argument, index) =>
		bindArgument(statements, argument, "target", emptyListAnnotation(node.arguments[index])),
	);

	const site = { name: memberName(state, target) };
	let encoding;
	if (packed.some(ts.isSpreadElement)) {
		// A spread makes the count a runtime matter: gather the list first, as `fire` itself would.
		const table = f.identifier("args", true);
		statements.push(f.variableStatement(table, f.as(f.array(packed, false), arrayType())));
		encoding = buildInlineEncoding(state, node, listType, { table }, site);
	} else {
		const values = packed.map((argument, index) =>
			bindArgument(statements, argument, "arg", emptyListAnnotation(node.arguments[restIndex + index])),
		);
		encoding = buildInlineEncoding(state, node, listType, values, site);
	}

	statements.push(...encoding.statements);

	const call = f.call(f.propertyAccessExpression(transformedTarget, f.identifier(method)), [
		...leadingValues,
		...packedArguments(encoding),
	]);
	return emitWithStatements(state, node, statements, call, [target, ...args], chained.wrap);
}

/**
 * The target of a send or `setCallback`, evaluated ahead of the arguments the way the call would
 * evaluate it: a plain read stays where it is, anything else is bound to a local first.
 *
 * A target reached through `?.` decides whether the call happens at all, so the packing has to
 * stay behind that decision: the call is wrapped in a function (`wrap`) that returns `undefined`
 * where the chain would short-circuit. The test goes on the operand ahead of each `?.` when every
 * one of them is a reference, which keeps the narrowing the chain gave the arguments; otherwise
 * the target is bound to a local and the test goes on that.
 */
function guardOptionalChain(
	state: TransformState,
	statements: ts.Statement[],
	target: ts.Expression,
	optionalTarget: boolean,
): { target: ts.Expression; wrap: boolean } {
	const transformedTarget = state.transformNode(target);
	const operands = optionalOperands(target, optionalTarget);

	if (operands.length > 0 && operands.every(isReference)) {
		for (const operand of operands) statements.push(shortCircuit(state.transformNode(operand)));
	} else if (operands.length > 0) {
		const bound = bindArgument(statements, transformedTarget, "target");
		statements.push(shortCircuit(bound));
		return { target: bound, wrap: true };
	}

	const bound = isPure(target) ? transformedTarget : bindArgument(statements, transformedTarget, "target");
	return { target: bound, wrap: operands.length > 0 };
}

/** `if (value === undefined) return undefined;` */
function shortCircuit(value: ts.Expression): ts.Statement {
	return ts.factory.createIfStatement(
		f.binary(value, ts.SyntaxKind.EqualsEqualsEqualsToken, f.nil()),
		f.block([f.returnStatement(f.nil())]),
	);
}

/**
 * The operands ahead of each `?.` in `target`, outermost first, then `target` itself when the
 * access after it is the optional one (`handler.x?.fire(...)`).
 */
function optionalOperands(target: ts.Expression, optionalTarget: boolean): ts.Expression[] {
	const operands = new Array<ts.Expression>();

	let current: ts.Expression = target;
	while (
		ts.isPropertyAccessExpression(current) ||
		ts.isElementAccessExpression(current) ||
		ts.isCallExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		if (!ts.isNonNullExpression(current) && current.questionDotToken) operands.unshift(current.expression);
		current = current.expression;
	}

	if (optionalTarget) operands.push(target);
	return operands;
}

/** A reference TypeScript narrows: an identifier, `this`, or a property (or literal index) of one. */
function isReference(node: ts.Expression): boolean {
	if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
	if (ts.isParenthesizedExpression(node) || ts.isPropertyAccessExpression(node)) return isReference(node.expression);
	if (ts.isElementAccessExpression(node)) {
		const index = node.argumentExpression;
		return (ts.isStringLiteral(index) || ts.isNumericLiteral(index)) && isReference(node.expression);
	}

	return false;
}

/** `payload, blobs`, `payload`, or nothing at all when the list carries nothing. */
function packedArguments(encoding: { payload: ts.Identifier | undefined; blobs: ts.Identifier | undefined }) {
	if (!encoding.payload) return [];
	return encoding.blobs ? [encoding.payload, encoding.blobs] : [encoding.payload];
}

/**
 * The packing statements go ahead of the enclosing statement when that keeps them in the call's
 * scope and runs them exactly when the call runs: once, unconditionally, and ahead of nothing that
 * could tell the difference. Anywhere else -- behind `&&`, `||`, `??` or a conditional, in a loop
 * condition, after a sibling with side effects, or inside an expression-bodied arrow, which has no
 * statement of its own -- the call is wrapped in an immediately invoked function that holds them.
 * `wrap` asks for that function outright: the statements then hold a short-circuit of their own.
 */
function emitWithStatements(
	state: TransformState,
	node: ts.Node,
	statements: ts.Statement[],
	call: ts.Expression,
	hoisted: readonly ts.Expression[],
	wrap = false,
): ts.Expression {
	if (statements.length === 0) return call;

	if (wrap || !hoistsCleanly(node, hoisted)) {
		return f.call(f.arrowFunction(f.block([...statements, f.returnStatement(call)])), []);
	}

	state.prereqList(statements);
	return call;
}

/**
 * Whether evaluating `hoisted` ahead of the statement that holds `node` is the same as evaluating it
 * where `node` is: the position must be reached once and unconditionally, and whatever the
 * statement evaluates before it must be unable to notice the difference -- plain reads on both
 * sides, or nothing that reads at all on that side.
 */
function hoistsCleanly(node: ts.Node, hoisted: readonly ts.Expression[]): boolean {
	const ahead = new Array<ts.Expression>();

	let child: ts.Node = node;
	let parent: ts.Node | undefined = node.parent;
	while (parent !== undefined && !ts.isStatement(parent)) {
		if (ts.isFunctionLike(parent)) return false;

		const before = evaluatedBefore(parent, child);
		if (before === undefined) return false;

		ahead.push(...before);
		child = parent;
		parent = parent.parent;
	}

	if (parent !== undefined && isRepeatedIn(parent, child)) return false;
	if (!ahead.every(isPure)) return false;
	return ahead.every(isConstant) || hoisted.every(isPure);
}

/**
 * The expressions `parent` evaluates before `child` when `child` is evaluated once and
 * unconditionally as part of it, or `undefined` when it is not (a short-circuited operand, a
 * conditional branch, a `case` label) or the position is not one this understands.
 */
function evaluatedBefore(parent: ts.Node, child: ts.Node): ts.Expression[] | undefined {
	if (
		ts.isParenthesizedExpression(parent) ||
		ts.isAsExpression(parent) ||
		ts.isTypeAssertionExpression(parent) ||
		ts.isNonNullExpression(parent) ||
		ts.isSatisfiesExpression(parent) ||
		ts.isAwaitExpression(parent) ||
		ts.isYieldExpression(parent) ||
		ts.isVoidExpression(parent) ||
		ts.isTypeOfExpression(parent) ||
		ts.isDeleteExpression(parent) ||
		ts.isPrefixUnaryExpression(parent) ||
		ts.isSpreadElement(parent) ||
		ts.isSpreadAssignment(parent) ||
		ts.isTemplateSpan(parent)
	) {
		return [];
	}

	if (ts.isPropertyAccessExpression(parent)) {
		return child === parent.expression ? [] : undefined;
	}

	if (ts.isElementAccessExpression(parent)) {
		return child === parent.expression ? [] : [parent.expression];
	}

	if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
		if (child === parent.expression) return [];

		const args: readonly ts.Expression[] = parent.arguments ?? [];
		const index = args.indexOf(child as ts.Expression);
		return index === -1 ? undefined : [parent.expression, ...args.slice(0, index)];
	}

	if (ts.isBinaryExpression(parent)) {
		if (child === parent.left) return [];

		const operator = parent.operatorToken.kind;
		if (
			operator === ts.SyntaxKind.AmpersandAmpersandToken ||
			operator === ts.SyntaxKind.BarBarToken ||
			operator === ts.SyntaxKind.QuestionQuestionToken
		) {
			return undefined;
		}

		if (!isAssignmentOperator(operator)) return [parent.left];

		// An assignment target is not a value: what runs ahead of the right-hand side is the object
		// (and index) it is stored into.
		if (ts.isIdentifier(parent.left)) return [];
		if (ts.isPropertyAccessExpression(parent.left)) return [parent.left.expression];
		if (ts.isElementAccessExpression(parent.left)) {
			return [parent.left.expression, parent.left.argumentExpression];
		}

		return undefined;
	}

	if (ts.isConditionalExpression(parent)) {
		return child === parent.condition ? [] : undefined;
	}

	if (ts.isArrayLiteralExpression(parent)) {
		const index = parent.elements.indexOf(child as ts.Expression);
		return index === -1 ? undefined : parent.elements.slice(0, index);
	}

	if (ts.isPropertyAssignment(parent)) {
		if (child !== parent.initializer) return undefined;
		return ts.isComputedPropertyName(parent.name) ? [parent.name.expression] : [];
	}

	if (ts.isObjectLiteralExpression(parent)) {
		const index = parent.properties.indexOf(child as ts.ObjectLiteralElementLike);
		if (index === -1) return undefined;

		const before = new Array<ts.Expression>();
		for (const property of parent.properties.slice(0, index)) {
			if (ts.isPropertyAssignment(property)) {
				if (ts.isComputedPropertyName(property.name)) before.push(property.name.expression);
				before.push(property.initializer);
			} else if (ts.isShorthandPropertyAssignment(property)) {
				before.push(property.name);
			} else if (ts.isSpreadAssignment(property)) {
				before.push(property.expression);
			}
		}

		return before;
	}

	if (ts.isTemplateExpression(parent)) {
		const index = parent.templateSpans.indexOf(child as ts.TemplateSpan);
		return index === -1 ? undefined : parent.templateSpans.slice(0, index).map((span) => span.expression);
	}

	if (ts.isVariableDeclaration(parent)) {
		return child === parent.initializer ? [] : undefined;
	}

	if (ts.isVariableDeclarationList(parent)) {
		const index = parent.declarations.indexOf(child as ts.VariableDeclaration);
		if (index === -1) return undefined;

		return parent.declarations
			.slice(0, index)
			.map((declaration) => declaration.initializer)
			.filter((initializer): initializer is ts.Expression => initializer !== undefined);
	}

	return undefined;
}

/** Whether `statement` evaluates `child` on every pass of a loop rather than once on the way in. */
function isRepeatedIn(statement: ts.Node, child: ts.Node): boolean {
	if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) return child === statement.expression;
	if (ts.isForStatement(statement)) return child === statement.condition || child === statement.incrementor;
	return false;
}

/** An expression that evaluates without touching state: a literal, a closure, or a plain read. */
function isPure(node: ts.Expression): boolean {
	if (isConstant(node) || ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
	if (ts.isPropertyAccessExpression(node)) return isPure(node.expression);
	if (ts.isElementAccessExpression(node)) return isPure(node.expression) && isPure(node.argumentExpression);
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isTypeOfExpression(node)
	) {
		return isPure(node.expression);
	}

	if (ts.isPrefixUnaryExpression(node)) {
		const mutates =
			node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
		return !mutates && isPure(node.operand);
	}

	if (ts.isBinaryExpression(node)) {
		return !isAssignmentOperator(node.operatorToken.kind) && isPure(node.left) && isPure(node.right);
	}

	if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isPure(span.expression));
	if (ts.isArrayLiteralExpression(node)) return node.elements.every(isPure);
	if (ts.isSpreadElement(node)) return isPure(node.expression);
	if (ts.isObjectLiteralExpression(node)) {
		return node.properties.every((property) => {
			if (ts.isPropertyAssignment(property)) {
				const name = property.name;
				return (!ts.isComputedPropertyName(name) || isPure(name.expression)) && isPure(property.initializer);
			}

			return !ts.isSpreadAssignment(property) || isPure(property.expression);
		});
	}

	return false;
}

/** `=` and the compound assignments, which TypeScript numbers in one run. */
function isAssignmentOperator(operator: ts.SyntaxKind): boolean {
	return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

/** An expression that reads nothing: a literal, a keyword, or a closure that is only being created. */
function isConstant(node: ts.Expression): boolean {
	return (
		ts.isLiteralExpression(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node)
	);
}

/**
 * `handler.fn.setCallback(cb)` becomes `handler.fn._setCallback(cb, (value) => pack(value))`, where
 * `pack` turns a successful result into `[payload, blobs?]` (or nothing, for a `void` result). The
 * callback itself is registered as it is: the runtime packs whatever the middleware chain resolves
 * with, so middleware sees plain results and one it returns is packed like the callback's own.
 */
function transformReceiverCallback(
	state: TransformState,
	node: ts.CallExpression,
	target: ts.Expression,
	targetType: ts.Type,
	optionalTarget: boolean,
): ts.Expression | undefined {
	const callbackArgument = node.arguments[0];
	if (!callbackArgument) return;

	const fnType = markerType(state, targetType, "_flamework_fn", node);
	if (!fnType) return;

	const statements = new Array<ts.Statement>();

	// The callback keeps the parameter types `setCallback` would have given it: an arrow bound to a
	// plain local would lose its contextual typing and end up with implicit `any` parameters.
	const chained = guardOptionalChain(state, statements, target, optionalTarget);
	const boundTarget = bindArgument(statements, chained.target, "target");
	const callbackAnnotation = f.indexedAccessType(
		f.referenceType("Parameters", [f.queryType(f.qualifiedNameType(boundTarget as ts.Identifier, "setCallback"))]),
		f.literalType(f.number(0)),
	);
	const callback = f.identifier("callback", true);
	const transformedCallback = state.transformNode(callbackArgument);
	statements.push(f.variableStatement(callback, transformedCallback, callbackAnnotation));

	// The runtime calls `pack` only with a resolved, successful value: never a Promise or a Skip.
	const value = f.identifier("value", true);
	const pack = f.arrowFunction(f.block(packResult(state, node, fnType, value, memberName(state, target))), [
		f.parameterDeclaration(value, f.keywordType(ts.SyntaxKind.UnknownKeyword)),
	]);

	const call = f.call(f.propertyAccessExpression(boundTarget, f.identifier("_setCallback")), [callback, pack]);
	return emitWithStatements(state, node, statements, call, [target, transformedCallback], chained.wrap);
}

/** `<pack v>; return [payload, blobs?]`, or `return undefined` when the result type carries nothing. */
function packResult(
	state: TransformState,
	node: ts.CallExpression,
	fnType: ts.Type,
	value: ts.Identifier,
	name: string | undefined,
): ts.Statement[] {
	const encoding = buildInlineResultEncoding(state, node, fnType, value, true, name);
	const packed = packedArguments(encoding);

	return [
		...encoding.statements,
		f.returnStatement(packed.length > 0 ? f.as(f.array(packed, false), arrayType()) : f.nil()),
	];
}

/**
 * The member a call goes through, as the source names it (`pong` in `server.pong.fire(...)`), for the
 * message of a width check. None under obfuscation, which keeps member names out of the output, and
 * none for a member reached any other way than by name.
 */
function memberName(state: TransformState, target: ts.Expression): string | undefined {
	if (state.config.obfuscation) return;

	const original = ts.getParseTreeNode(target) ?? target;
	if (ts.isPropertyAccessExpression(original)) return original.name.text;
	if (ts.isElementAccessExpression(original) && ts.isStringLiteralLike(original.argumentExpression)) {
		return original.argumentExpression.text;
	}
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
function bindArgument(
	statements: ts.Statement[],
	argument: ts.Expression,
	hint: string,
	annotation?: ts.TypeNode,
): ts.Expression {
	if (
		ts.isIdentifier(argument) ||
		ts.isLiteralExpression(argument) ||
		argument.kind === ts.SyntaxKind.TrueKeyword ||
		argument.kind === ts.SyntaxKind.FalseKeyword
	) {
		return argument;
	}

	const id = f.identifier(hint, true);
	statements.push(f.variableStatement(id, argument, annotation));
	return id;
}

/**
 * `const arg = []` is an implicit `any[]` (a local TypeScript lets evolve with what is pushed into it),
 * which a project compiled with `noImplicitAny` rejects: an empty list, as a leading argument
 * (`fire([], value)`) or a packed one (`fire([])`), parenthesized or not, is bound as `never[]`, the
 * type TypeScript gives the literal itself. The parameter's type is not used: it may name a type the
 * calling file cannot, one it never imports or one its module keeps to itself. The encoding reads
 * the value through casts, so the annotation changes nothing in the output.
 */
function emptyListAnnotation(original: ts.Expression | undefined): ts.TypeNode | undefined {
	if (!original) return;

	const list = ts.skipParentheses(original);
	if (!ts.isArrayLiteralExpression(list) || list.elements.length > 0) return;

	return ts.factory.createArrayTypeNode(f.keywordType(ts.SyntaxKind.NeverKeyword));
}

function arrayType() {
	return f.referenceType("Array", [f.keywordType(ts.SyntaxKind.UnknownKeyword)]);
}
