import ts from "typescript";
import { DiagnosticError, Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { f } from "../factory";
import { getDeclarationOfType } from "./getDeclarationOfType";
import { getInstanceTypeFromType } from "./getInstanceTypeFromType";
import { localName } from "./identifierName";
import { getPropertyKey, keyName } from "./propertyKey";
import assert from "assert";

/**
 * Convert a type into a list of typeguards.
 * @param state The TransformState
 * @param file The file that this type belongs to
 * @param type The type to convert
 * @param isInterfaceType Determines whether unknown should be omitted, and whether a property keyed by a
 * number (`{ 10: V }`) is keyed by that number, as `t.interface` needs; otherwise every key is the
 * property's name, as a component's attributes need.
 * @returns An array of property assignments.
 */
export function buildGuardsFromType(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	file = state.getSourceFile(node),
	isInterfaceType = false,
): ts.PropertyAssignment[] {
	const generator = createGuardGenerator(state, file, node);
	return generator.buildGuardsFromType(type, isInterfaceType);
}

// This compiles directly to `t.typeof` for any userdata that `t` does not have an alias for, or users might not have yet.
const RBX_TYPES_NEW = ["buffer", "InstanceHandle"];

const RBX_TYPES = [
	"UDim",
	"UDim2",
	"BrickColor",
	"Color3",
	"Vector2",
	"Vector3",
	"NumberSequence",
	"NumberSequenceKeypoint",
	"ColorSequence",
	"ColorSequenceKeypoint",
	"NumberRange",
	"Rect",
	"DockWidgetPluginGuiInfo",
	"CFrame",
	"Axes",
	"Faces",
	"Font",
	"Instance",
	"Ray",
	"Random",
	"Region3",
	"Region3int16",
	"Enum",
	"TweenInfo",
	"PhysicalProperties",
	"Vector3int16",
	"Vector2int16",
	"PathWaypoint",
	"EnumItem",
	"RBXScriptSignal",
	"RBXScriptConnection",
	"FloatCurveKey",
	"OverlapParams",
	"thread",
	...RBX_TYPES_NEW,
] as const;

const OBJECT_IGNORED_FIELD_TYPES = ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.UniqueESSymbol;
const DEDUP_HEURISTIC_LIMIT = 5;
const DEDUP_HEURISTIC_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.UnionOrIntersection;

/**
 * How many times one check may go round a recursive type into a value before it refuses the value.
 * A hostile client can send a table nested as deep as it likes, and a value can contain itself;
 * without a limit, either would run the check until Luau's stack overflows (about 20,000 calls, and
 * a level costs a guard four or five). A thousand levels is far deeper than a tree, a menu or a
 * JSON-like value a game sends, and keeps the deepest check well inside the stack. The count is the
 * guard's: the deduplicated guards it is built from share it, and so does a check of the same guard
 * started inside it (by a metatable of the value).
 */
export const GUARD_RECURSION_LIMIT = 1000;

/**
 * How many types deep a guard's type may nest before the build gives up on it. Only a type that
 * keeps making new types as it nests (`interface Box<T> { inner?: Box<Box<T>> }`) gets anywhere near
 * this: a recursive type that comes back to itself is checked through a function that calls itself.
 */
const TYPE_NESTING_LIMIT = 500;

/** Stops the whole of {@link getTypesRequiringDedupHeuristic}'s walk at once. */
class NestingLimitReached {}

/**
 * Finds the object and union types that appear at least `dedupLimit` times within `type`, which are
 * worth emitting once as a local and referencing, rather than inlining at every occurrence.
 *
 * None, for a type nested over {@link TYPE_NESTING_LIMIT} types deep, whose guard the builder then
 * refuses, saying where.
 */
function getTypesRequiringDedupHeuristic(type: ts.Type, dedupLimit = DEDUP_HEURISTIC_LIMIT) {
	const seenCount = new Map<ts.Type, number>();

	// Types currently being walked, so that a self-referential type (`Vector3.Unit` is a `Vector3`)
	// is counted where it recurs but not descended into again.
	const visiting = new Set<ts.Type>();

	function recurse(type: ts.Type, modifier = 1) {
		if (type.flags & DEDUP_HEURISTIC_FLAGS) {
			const typeSeenCount = seenCount.get(type) ?? 0;
			seenCount.set(type, typeSeenCount + modifier);
		}

		if (visiting.has(type)) {
			return;
		}

		// A type that keeps making new types as it nests never comes back to one being walked, and may
		// make several at each level (`Box<T> { a?: Box<Box<T>>; b?: Box<[T]> }`). Turning back here
		// would only go on across them, through 2^n types, so the walk stops altogether.
		if (visiting.size >= TYPE_NESTING_LIMIT) {
			throw new NestingLimitReached();
		}

		visiting.add(type);
		recurseChildren(type, modifier);
		visiting.delete(type);
	}

	function recurseChildren(type: ts.Type, modifier: number) {
		if (type.isUnionOrIntersection()) {
			type.types.forEach((ty) => recurse(ty, modifier));
		} else if (type.flags & ts.TypeFlags.Object && !isInstanceType(type)) {
			for (const property of type.getProperties()) {
				const propertyType = type.checker.getTypeOfPropertyOfType(type, property.name);
				if (!propertyType) {
					continue;
				}

				recurse(propertyType, modifier);
			}

			for (const indexInfo of type.checker.getIndexInfosOfType(type)) {
				recurse(indexInfo.keyType, modifier);
				recurse(indexInfo.type, modifier);
			}
		}
	}

	const requiresDedup = new Set<ts.Type>();

	try {
		recurse(type);

		for (const [type, count] of seenCount) {
			if (count >= dedupLimit) {
				requiresDedup.add(type);

				// We subtract all the children, as deduplicating the parent effectively removes `count - 1` of any children from the emit.
				recurse(type, -(count - 1));
			}
		}
	} catch (error) {
		if (error instanceof NestingLimitReached) {
			return new Set<ts.Type>();
		}

		throw error;
	}

	return requiresDedup;
}

/**
 * Convert a type into a type guard.
 * @param state The TransformState
 * @param file The file that this type belongs to
 * @param type The type to convert
 * @returns An array of property assignments.
 */
export function buildGuardFromType(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	file = state.getSourceFile(node),
): ts.Expression {
	const generator = createGuardGenerator(state, file, node);
	return generator.buildGuard(type);
}

/**
 * Convert a type into a type guard, deduplicating large guards when the
 * `optimizations.guardGenerationDedupLimit` transformer option is set.
 *
 * The returned statements declare the shared guards and must be emitted ahead of the expression. When
 * one of them is recursive, there are none: they are declared inside the guard (see
 * {@link createGuardGenerator}).
 * @param state The TransformState
 * @param file The file that this type belongs to
 * @param type The type to convert
 */
export function buildGuardFromTypeWithDedup(
	state: TransformState,
	node: ts.Node,
	type: ts.Type,
	file = state.getSourceFile(node),
) {
	const generator = createGuardGenerator(state, file, node);
	const dedupLimit = state.config.optimizations?.guardGenerationDedupLimit;
	if (dedupLimit !== undefined) {
		generator.calculateDedup(type, Math.max(dedupLimit, 1));
	}

	return {
		guard: generator.buildGuard(type),
		statements: generator.dedupStatements,
	};
}

/** A type whose guard is being built, with the types it is being built inside of below it. */
interface GuardFrame {
	type: ts.Type;
	/** Its place among the frames being built, counted from the outermost. */
	index: number;
	/** The local its guard is kept in, given once something inside it reaches the type again. */
	self?: ts.Identifier;
}

/**
 * Where the guards of recursive types are kept: one function, called once, whose locals hold them.
 * A guard is built in one scope, and each guard the dedup heuristic hoists in a scope of its own.
 */
interface GuardScope {
	/** How many frames were open when the scope began: a frame below this is outside it. */
	base: number;
	locals: ts.Identifier[];
	/** The assignments of `locals`, in the order their guards were finished. */
	statements: ts.Statement[];
	/** The recursive types finished in this scope, by the local that holds each one's guard. */
	finished: Map<ts.Type, ts.Identifier>;
	/** Whether a guard built in it calls one still being built outside it. */
	escapes: boolean;
}

/**
 * What the recursive guards of one generator share while a check runs: how deep it has gone, and
 * what each recursive guard said of each table it has checked.
 */
interface CheckState {
	depth: ts.Identifier;
	memo: ts.Identifier;
}

/**
 * Creates a stateful guard generator.
 *
 * A recursive type (`interface Tree { kids: Tree[] }`) reaches itself, so its guard cannot be written
 * out in place. Its guard is kept in a local of a function the guard is wrapped in, and the place
 * that reaches the type again calls that local through a function, which counts how deeply it has
 * gone ({@link GUARD_RECURSION_LIMIT}) and remembers what the local said of each table:
 *
 * ```lua
 * (function()
 * 	local depth = 0
 * 	local memo
 * 	local Tree
 * 	Tree = t.interface({ kids = t.array(function(value)
 * 		if depth >= 1000 then return false end
 * 		local results
 * 		if type(value) == "table" then
 * 			results = memo[Tree]
 * 			if results == nil then
 * 				results = {}
 * 				memo[Tree] = results
 * 			else
 * 				local known = results[value]
 * 				if known ~= nil then return known end
 * 			end
 * 		end
 * 		depth += 1
 * 		local result = Tree(value)
 * 		depth -= 1
 * 		if results ~= nil then results[value] = result end
 * 		return result
 * 	end) })
 * 	return function(value)
 * 		local outerDepth = depth
 * 		local outerMemo = memo
 * 		memo = {}
 * 		local ok, result = pcall(Tree, value)
 * 		depth = outerDepth
 * 		memo = outerMemo
 * 		if not ok then error(result, 0) end
 * 		return result
 * 	end
 * end)()
 * ```
 *
 * The memo keeps a check linear in the value. Without it, a union whose members go into the same
 * children (`{ kind: "a"; kids: Node[] } | { kind: "b"; kids: Node[] }`), or an intersection, checks
 * them once for each member it tries, and so each level twice or more: a client could send a few
 * hundred bytes nested 30 levels deep and hold the server for minutes. With it, each recursive guard
 * checks each table once per check, whichever member or place reaches it; a table reached again
 * below the limit gets what it got where it was first reached, which only a value that holds the
 * same table in two places can tell.
 *
 * The function the guard is called through gives each check a memo of its own and puts back what it
 * found, under `pcall`, so a check that raised halfway (a value whose metatable raises) leaves
 * neither the count nor the memo, nor the tables it holds, behind for the next one; the error is
 * raised again as it was. A check started inside another (by a metatable of the value) goes on from
 * the count of the one around it, so the limit holds across both.
 *
 * The guards the dedup heuristic declares once share the guard's count and memo. When one of them is
 * recursive, they are all declared inside the function the guard is wrapped in, after the count and
 * the memo, rather than ahead of the guard: that keeps them out of the locals of the code around the
 * guard, which Luau caps at 200, and only the guard is called through such a function.
 */
export function createGuardGenerator(state: TransformState, file: ts.SourceFile, diagnosticNode: ts.Node) {
	const tracking = new Array<[ts.Node, ts.Type]>();
	const dedupStatements = new Array<ts.Statement>();
	const dedupIds = new Map<ts.Type, ts.Identifier>();
	let requiresDedup = new Set<ts.Type>();

	const frames = new Array<GuardFrame>();
	const openFrames = new Map<ts.Type, GuardFrame>();
	const scopes = new Array<GuardScope>();

	// One count and one memo for every recursive guard the generator builds, declared in the function
	// the guard is wrapped in, with the deduplicated guards when one of those is recursive.
	let checkState: CheckState | undefined;
	let dedupIsRecursive = false;

	return { buildGuard, buildGuardsFromType, calculateDedup, dedupStatements };

	function fail(err: string): never {
		const basicDiagnostic = Diagnostics.createDiagnostic(diagnosticNode, ts.DiagnosticCategory.Error, err);
		let previousType: ts.Type | undefined;
		for (const location of tracking) {
			if (location[1] === previousType) {
				continue;
			}

			previousType = location[1];
			ts.addRelatedInfo(
				basicDiagnostic,
				Diagnostics.createDiagnostic(
					f.is.namedDeclaration(location[0]) ? location[0].name : location[0],
					ts.DiagnosticCategory.Error,
					`Type was defined here: ${state.typeChecker.typeToString(location[1])}`,
				),
			);
		}
		throw new DiagnosticError(basicDiagnostic);
	}

	function calculateDedup(type: ts.Type, dedupLimit?: number) {
		requiresDedup = getTypesRequiringDedupHeuristic(type, dedupLimit);
	}

	function buildGuard(type: ts.Type): ts.Expression {
		// A guard of its own, not one inside another: it gets the outermost scope, which declares what
		// the guard needs, the deduplicated guards too when one of them is recursive.
		if (scopes.length === 0) {
			const root = openScope();
			return closeScope(root, buildGuard(type), true);
		}

		// The type is reached again inside its own guard.
		const open = openFrames.get(type);
		if (open) {
			return callRecursive(open);
		}

		const finished = scopes[scopes.length - 1].finished.get(type);
		if (finished) {
			return finished;
		}

		if (requiresDedup.has(type)) {
			const existingId = dedupIds.get(type);
			if (existingId) {
				return existingId;
			}

			return buildDedupGuard(type);
		}

		return buildFrame(type);
	}

	/**
	 * A guard the dedup heuristic picked, declared once ahead of the guard (inside the guard's function
	 * when one of them is recursive; see `closeScope`) and referenced. It is built in a scope of its
	 * own, since the declaration lands outside the guard; a guard that calls a type
	 * still being built around it cannot leave it, so it stays in place, its scope merged into the one
	 * around it.
	 */
	function buildDedupGuard(type: ts.Type): ts.Expression {
		const scope = openScope();
		const guard = buildFrame(type);
		scopes.pop();

		if (scope.escapes) {
			const outer = scopes[scopes.length - 1];
			assert(outer, "A guard escaped the outermost scope");
			outer.locals.push(...scope.locals);
			outer.statements.push(...scope.statements);
			scope.finished.forEach((id, finishedType) => outer.finished.set(finishedType, id));
			return guard;
		}

		// Named after the type, as a local can be named: `const class = ...` or `const Map = ...` would
		// not compile, or would hide the global from the code after it.
		const typeName = type.aliasSymbol?.name ?? type.symbol?.name ?? "dedup";
		const dedupId = f.identifier(localName(state.typeChecker, typeName), true);
		dedupIds.set(type, dedupId);
		dedupStatements.push(f.variableStatement(dedupId, closeScope(scope, guard, false)));

		return dedupId;
	}

	function openScope(): GuardScope {
		const scope: GuardScope = {
			base: frames.length,
			locals: [],
			statements: [],
			finished: new Map(),
			escapes: false,
		};
		scopes.push(scope);
		return scope;
	}

	/** The guard of a type, as a frame other guards built inside it can come back to. */
	function buildFrame(type: ts.Type): ts.Expression {
		if (frames.length >= TYPE_NESTING_LIMIT) {
			fail(
				`Flamework cannot generate a guard for a type nested over ${TYPE_NESTING_LIMIT} types deep. A type that makes a new type of itself as it nests (\`Box<Box<T>>\`) never ends.`,
			);
		}

		const scope = scopes[scopes.length - 1];
		assert(scope, "A guard frame was built outside a scope");

		const frame: GuardFrame = { type, index: frames.length };
		frames.push(frame);
		openFrames.set(type, frame);

		let guard: ts.Expression;
		try {
			guard = buildTrackedGuard(type);
		} finally {
			frames.pop();
			openFrames.delete(type);
		}

		if (!frame.self) {
			return guard;
		}

		// Kept in its local, assigned before anything after it in the scope can use it.
		scope.locals.push(frame.self);
		scope.statements.push(f.statement(f.binary(frame.self, ts.SyntaxKind.EqualsToken, guard)));
		scope.finished.set(type, frame.self);
		return frame.self;
	}

	function buildTrackedGuard(type: ts.Type): ts.Expression {
		const declaration = getDeclarationOfType(type);
		if (declaration) {
			tracking.push([declaration, type]);
		}

		const guard = buildGuardInner(type);

		if (declaration) {
			assert(tracking.pop()?.[0] === declaration, "Popped value was not expected");
		}

		return guard;
	}

	/**
	 * A type reached inside its own guard: a call of the local its guard will be kept in, through a
	 * function that refuses the value once the check has gone {@link GUARD_RECURSION_LIMIT} deep, so a
	 * value nested without end, or one that contains itself, is refused rather than overflowing, and
	 * that remembers what the local said of each table (see {@link createGuardGenerator}).
	 */
	function callRecursive(frame: GuardFrame): ts.Expression {
		const self = (frame.self ??= f.identifier(
			localName(state.typeChecker, guardName(frame.type, "recursive")),
			true,
		));

		// A scope that began above the frame cannot leave the scope the frame is in.
		for (const scope of scopes) {
			if (scope.base > frame.index) {
				scope.escapes = true;
			}
		}

		const { depth, memo } = getCheckState();
		const value = f.identifier("value", true);
		const results = f.identifier("results", true);
		const known = f.identifier("known", true);
		const result = f.identifier("result", true);
		const assign = (target: ts.Identifier, expression: ts.Expression) =>
			f.statement(f.binary(target, ts.SyntaxKind.EqualsToken, expression));

		return checkFunction(value, [
			ts.factory.createIfStatement(
				f.binary(depth, ts.SyntaxKind.GreaterThanEqualsToken, f.number(GUARD_RECURSION_LIMIT)),
				f.block([f.returnStatement(f.bool(false))]),
			),
			// Only a table is remembered: a check of anything else goes no deeper.
			f.variableStatement(results, undefined, f.unionType([resultsType(), undefinedType()]), true),
			ts.factory.createIfStatement(
				f.call("typeIs", [value, f.string("table")]),
				f.block([
					assign(results, f.call(f.field(f.bang(memo), "get"), [self])),
					ts.factory.createIfStatement(
						f.binary(results, ts.SyntaxKind.EqualsEqualsEqualsToken, f.nil()),
						f.block([
							assign(results, f.as(f.object([], false), resultsType())),
							f.statement(f.call(f.field(f.bang(memo), "set"), [self, results])),
						]),
						f.block([
							f.variableStatement(known, f.call(f.field(results, "get"), [value])),
							ts.factory.createIfStatement(
								f.binary(known, ts.SyntaxKind.ExclamationEqualsEqualsToken, f.nil()),
								f.block([f.returnStatement(known)]),
							),
						]),
					),
				]),
			),
			f.statement(f.binary(depth, ts.SyntaxKind.PlusEqualsToken, f.number(1))),
			f.variableStatement(result, f.call(self, [value])),
			f.statement(f.binary(depth, ts.SyntaxKind.MinusEqualsToken, f.number(1))),
			ts.factory.createIfStatement(
				f.binary(results, ts.SyntaxKind.ExclamationEqualsEqualsToken, f.nil()),
				f.block([f.statement(f.call(f.field(results, "set"), [value, result]))]),
			),
			f.returnStatement(result),
		]);
	}

	/**
	 * A guard built in `scope`. One that holds recursive types is wrapped in a function called once,
	 * which declares their locals and assigns them. A deduplicated guard's (not `root`) returns the
	 * guard. The guard's own declares the count and the memo first, then the deduplicated guards when
	 * one of them is recursive, and returns the function the guard is called through.
	 */
	function closeScope(scope: GuardScope, guard: ts.Expression, root: boolean): ts.Expression {
		if (scopes[scopes.length - 1] === scope) {
			scopes.pop();
		}

		const locals = scope.locals.map((local) => f.variableStatement(local, undefined, checkType(), true));
		if (!root) {
			if (locals.length === 0) {
				return guard;
			}

			dedupIsRecursive = true;
			return calledOnce([...locals, ...scope.statements, f.returnStatement(guard)]);
		}

		// The deduplicated guards are only ever called from this one.
		const deduplicated = dedupIsRecursive ? dedupStatements.splice(0) : [];
		if (locals.length === 0 && deduplicated.length === 0) {
			return guard;
		}

		const body = [...checkStateDeclarations(), ...deduplicated, ...locals, ...scope.statements];
		let entry = guard;
		if (!f.is.identifier(entry)) {
			entry = f.identifier("guard", true);
			body.push(f.variableStatement(entry as ts.Identifier, guard));
		}

		body.push(f.returnStatement(checkThrough(entry as ts.Identifier)));
		return calledOnce(body);
	}

	/**
	 * The function a guard with recursive types is called through: a memo of its own for the check,
	 * and the count and the memo put back as they were, even when the check raised, which is then
	 * raised again as it was.
	 */
	function checkThrough(guard: ts.Identifier): ts.Expression {
		const { depth, memo } = getCheckState();
		const value = f.identifier("value", true);
		const outerDepth = f.identifier("outerDepth", true);
		const outerMemo = f.identifier("outerMemo", true);
		const ok = f.identifier("ok", true);
		const result = f.identifier("result", true);

		return checkFunction(value, [
			f.variableStatement(outerDepth, depth),
			f.variableStatement(outerMemo, memo),
			f.statement(f.binary(memo, ts.SyntaxKind.EqualsToken, f.as(f.object([], false), memoType()))),
			f.variableStatement(f.arrayBindingDeclaration([ok, result]), f.call("pcall", [guard, value])),
			f.statement(f.binary(depth, ts.SyntaxKind.EqualsToken, outerDepth)),
			f.statement(f.binary(memo, ts.SyntaxKind.EqualsToken, outerMemo)),
			ts.factory.createIfStatement(
				ts.factory.createLogicalNot(ok),
				f.block([f.statement(f.call("error", [result, f.number(0)]))]),
			),
			f.returnStatement(f.as(result, f.keywordType(ts.SyntaxKind.BooleanKeyword))),
		]);
	}

	function getCheckState(): CheckState {
		return (checkState ??= { depth: f.identifier("depth", true), memo: f.identifier("memo", true) });
	}

	/** `let depth = 0; let memo: ...;`, outside any check. */
	function checkStateDeclarations(): ts.Statement[] {
		const { depth, memo } = getCheckState();
		return [
			f.variableStatement(depth, f.number(0), undefined, true),
			f.variableStatement(memo, undefined, f.unionType([memoType(), undefinedType()]), true),
		];
	}

	/** `(() => { ... })()` */
	function calledOnce(body: ts.Statement[]): ts.Expression {
		return f.call(ts.factory.createParenthesizedExpression(f.arrowFunction(f.block(body))), []);
	}

	/** `Map<unknown, boolean>`: what one recursive guard said of each table. */
	function resultsType(): ts.TypeNode {
		return f.referenceType("Map", [
			f.keywordType(ts.SyntaxKind.UnknownKeyword),
			f.keywordType(ts.SyntaxKind.BooleanKeyword),
		]);
	}

	/** `Map<unknown, Map<unknown, boolean>>`: the results of each recursive guard, by the guard. */
	function memoType(): ts.TypeNode {
		return f.referenceType("Map", [f.keywordType(ts.SyntaxKind.UnknownKeyword), resultsType()]);
	}

	function undefinedType(): ts.TypeNode {
		return f.keywordType(ts.SyntaxKind.UndefinedKeyword);
	}

	/** `(value: unknown) => value is unknown`, the type `t.check<unknown>` spells out. */
	function checkType(): ts.TypeNode {
		const value = f.identifier("value");
		return f.functionType(
			[f.parameterDeclaration(value, f.keywordType(ts.SyntaxKind.UnknownKeyword))],
			ts.factory.createTypePredicateNode(undefined, value, f.keywordType(ts.SyntaxKind.UnknownKeyword)),
		);
	}

	/** `(value: unknown): value is unknown => { ... }`, which `t` takes as a check. */
	function checkFunction(value: ts.Identifier, body: ts.Statement[]): ts.Expression {
		return f.arrowFunction(
			f.block(body),
			[f.parameterDeclaration(value, f.keywordType(ts.SyntaxKind.UnknownKeyword))],
			undefined,
			ts.factory.createTypePredicateNode(undefined, value, f.keywordType(ts.SyntaxKind.UnknownKeyword)),
		);
	}

	/**
	 * A name for the local of a recursive type's guard: the type's, `TreeArray` for `Tree[]`,
	 * `TreeOptional` for an optional property's `Tree | undefined`.
	 */
	function guardName(type: ts.Type, fallback: string): string {
		if (!type.aliasSymbol && state.typeChecker.isArrayType(type)) {
			const element = (type as ts.TypeReference).typeArguments?.[0];
			return `${element ? guardName(element, fallback) : fallback}Array`;
		}

		if (!type.aliasSymbol && type.isUnion()) {
			const [isOptional, members] = extractTypes(state.typeChecker, type.types);
			if (isOptional && members.length === 1) {
				const name = guardName(members[0], fallback);
				return name === fallback ? fallback : `${name}Optional`;
			}
		}

		const name = type.aliasSymbol?.name ?? type.symbol?.name;
		return name === undefined || name === "__type" || name === "__object" ? fallback : name;
	}

	function buildGuardInner(type: ts.Type): ts.Expression {
		const typeChecker = state.typeChecker;
		const tId = state.getGuardLibrary(file);

		if (type.isUnion()) {
			return buildUnionGuard(type);
		}

		if (isInstanceType(type)) {
			const instanceType = getInstanceTypeFromType(file, type);
			const additionalGuards = new Array<ts.PropertyAssignment>();

			for (const property of type.getProperties()) {
				const propertyType = type.checker.getTypeOfPropertyOfType(type, property.name);
				if (propertyType && !instanceType.getProperty(property.name)) {
					// assume intersections are children
					additionalGuards.push(f.propertyAssignmentDeclaration(property.name, buildGuard(propertyType)));
				}
			}

			const baseGuard = f.call(f.field(tId, "instanceIsA"), [instanceType.symbol.name]);
			return additionalGuards.length === 0
				? baseGuard
				: listLikeGuard("intersection", [
						baseGuard,
						f.call(f.field(tId, "children"), [f.object(additionalGuards)]),
					]);
		}

		if (type.isIntersection()) {
			return buildIntersectionGuard(type);
		}

		if (isConditionalType(type)) {
			return listLikeGuard("union", [buildGuard(type.resolvedTrueType!), buildGuard(type.resolvedFalseType!)]);
		}

		if ((type.flags & ts.TypeFlags.TypeVariable) !== 0) {
			const constraint = type.checker.getBaseConstraintOfType(type);
			if (!constraint) fail("could not find constraint of type parameter");

			return buildGuard(constraint);
		}

		const literals = getLiteral(type);
		if (literals) {
			return listLikeGuard("literal", literals);
		}

		if (typeChecker.isTupleType(type)) {
			const typeArgs = (type as ts.TypeReference).resolvedTypeArguments ?? [];
			const flags = (type as ts.TupleTypeReference).target.elementFlags;
			const restIndex = flags.findIndex((flag) => (flag & ts.ElementFlags.Rest) !== 0);
			if (restIndex !== -1) {
				return buildRestTupleGuard(
					typeArgs.slice(0, restIndex),
					typeArgs[restIndex],
					typeArgs.slice(restIndex + 1),
					(type as ts.TupleTypeReference).target.minLength,
				);
			}

			return f.call(
				f.field(tId, "strictArray"),
				typeArgs.map((x) => buildGuard(x)),
			);
		}

		if (typeChecker.isArrayType(type)) {
			const typeArg = (type as ts.GenericType).typeArguments?.[0];
			return f.call(f.field(tId, "array"), [typeArg ? buildGuard(typeArg) : f.field(tId, "any")]);
		}

		if (type.getCallSignatures().length > 0) {
			return f.field(tId, "callback");
		}

		const voidType = typeChecker.getVoidType();
		const undefinedType = typeChecker.getUndefinedType();
		if (type === voidType || type === undefinedType) {
			return f.field(tId, "none");
		}

		const anyType = typeChecker.getAnyType();
		if (type === anyType) {
			return f.field(tId, "any");
		}

		const stringType = typeChecker.getStringType();
		if (type === stringType) {
			return f.field(tId, "string");
		}

		const numberType = typeChecker.getNumberType();
		if (type === numberType) {
			return f.field(tId, "number");
		}

		if ((type.flags & ts.TypeFlags.Unknown) !== 0) {
			return listLikeGuard("union", [f.field(tId, "any"), f.field(tId, "none")]);
		}

		if (type.flags & ts.TypeFlags.TemplateLiteral) {
			// `${string}-id` becomes an anchored Lua pattern: the literal parts verbatim, each placeholder
			// matching anything, which is as much as a runtime check can tell about the placeholders.
			const template = type as ts.TemplateLiteralType;
			const escape = (text: string) => text.replace(/[%^$().[\]*+\-?]/g, (char) => `%${char}`);
			const pattern = `^${template.texts.map(escape).join(".*")}$`;
			return f.call(f.field(tId, "match"), [f.string(pattern)]);
		}

		// `Uppercase<T>` and friends are strings with a shape no runtime check can see.
		if (type.flags & ts.TypeFlags.StringMapping) {
			return f.field(tId, "string");
		}

		const symbol = type.getSymbol();
		if (!symbol) {
			fail(`An unknown type was encountered with no symbol: ${typeChecker.typeToString(type)}`);
		}

		const mapSymbol = typeChecker.resolveName("Map", undefined, ts.SymbolFlags.Type, false);
		const readonlyMapSymbol = typeChecker.resolveName("ReadonlyMap", undefined, ts.SymbolFlags.Type, false);
		const weakMapSymbol = typeChecker.resolveName("WeakMap", undefined, ts.SymbolFlags.Type, false);
		if (symbol === mapSymbol || symbol === readonlyMapSymbol || symbol === weakMapSymbol) {
			const keyType = (type as ts.GenericType).typeArguments?.[0];
			const valueType = (type as ts.GenericType).typeArguments?.[1];
			return f.call(f.field(tId, "map"), [
				keyType ? buildGuard(keyType) : f.field(tId, "any"),
				valueType ? buildGuard(valueType) : f.field(tId, "any"),
			]);
		}

		const setSymbol = typeChecker.resolveName("Set", undefined, ts.SymbolFlags.Type, false);
		const readonlySetSymbol = typeChecker.resolveName("ReadonlySet", undefined, ts.SymbolFlags.Type, false);
		if (symbol === setSymbol || symbol === readonlySetSymbol) {
			const valueType = (type as ts.GenericType).typeArguments?.[0];
			return f.call(f.field(tId, "set"), [valueType ? buildGuard(valueType) : f.field(tId, "any")]);
		}

		const promiseSymbol = typeChecker.resolveName("Promise", undefined, ts.SymbolFlags.Type, false);
		if (symbol === promiseSymbol) {
			return f.field("Promise", "is");
		}

		for (const guard of RBX_TYPES) {
			const guardSymbol = typeChecker.resolveName(guard, undefined, ts.SymbolFlags.Type, false);
			if (!guardSymbol && symbol.name === guard) {
				fail(`Could not find symbol for ${guard}`);
			}

			if (symbol === guardSymbol) {
				if (RBX_TYPES_NEW.includes(guard)) {
					return f.call(f.field(tId, "typeof"), [guard]);
				} else {
					return f.field(tId, guard);
				}
			}
		}

		if (type.isClass()) {
			fail(
				`Class "${type.symbol.name}" was encountered. Flamework does not support generating guards for classes.`,
			);
		}

		const isObject = isObjectType(type);
		const indexInfos = type.checker.getIndexInfosOfType(type);
		if (isObject && type.getApparentProperties().length === 0 && indexInfos.length === 0) {
			return f.field(tId, "any");
		}

		if (isObject || type.isClassOrInterface()) {
			const guards = [];

			if (type.getApparentProperties().length > 0) {
				guards.push(f.call(f.field(tId, "interface"), [f.object(buildGuardsFromType(type, true))]));
			}

			const indexInfo = indexInfos[0];
			if (indexInfo) {
				if (indexInfos.length > 1) {
					fail("Flamework cannot generate types with multiple index signatures.");
				}

				guards.push(f.call(f.field(tId, "map"), [buildGuard(indexInfo.keyType), buildGuard(indexInfo.type)]));
			}

			return guards.length > 1 ? listLikeGuard("intersection", guards) : guards[0];
		}

		fail(`An unknown type was encountered: ${typeChecker.typeToString(type)}`);
	}

	/**
	 * A tuple with a rest element, `[A, B?, ...C[], D]`: a table whose keys are whole numbers from 1,
	 * with the elements before the rest in their places (an optional one may be nil), at least
	 * `minLength` of them in all, the ones after the rest at the end, and every one in between a rest
	 * element. `t.strictArray` would treat the rest element as one element, refusing `[a]` and
	 * `[a, c, c]` for `[A, ...C[]]`.
	 *
	 * The element guards are built once, as the arguments of a function that returns the check.
	 */
	function buildRestTupleGuard(
		leading: readonly ts.Type[],
		rest: ts.Type,
		trailing: readonly ts.Type[],
		minLength: number,
	): ts.Expression {
		const checks = [...leading, rest, ...trailing].map((type) => buildGuard(type));
		const names = checks.map((_, index) =>
			f.identifier(index < leading.length ? "element" : index === leading.length ? "rest" : "last", true),
		);

		const value = f.identifier("value", true);
		const key = f.identifier("key", true);
		const size = f.identifier("size", true);
		const list = f.identifier("list", true);
		const index = f.identifier("index", true);
		const reject = () => f.returnStatement(f.bool(false));
		const failUnless = (condition: ts.Expression) =>
			ts.factory.createIfStatement(ts.factory.createLogicalNot(condition), f.block([reject()]));
		const check = (name: ts.Identifier, at: ts.Expression) =>
			failUnless(f.call(name, [f.elementAccessExpression(list, at)]));
		const binary = (left: ts.Expression, operator: ts.BinaryOperator, right: ts.Expression) =>
			f.binary(left, operator, right);
		const typeIs = (expression: ts.Expression, name: string) => f.call("typeIs", [expression, f.string(name)]);

		const body = new Array<ts.Statement>();
		body.push(failUnless(typeIs(value, "table")));

		// The highest key, and every key a whole number from 1: `#` is unreliable around nils.
		body.push(f.variableStatement(size, f.number(0), undefined, true));
		body.push(
			ts.factory.createForOfStatement(
				undefined,
				ts.factory.createVariableDeclarationList(
					[ts.factory.createVariableDeclaration(f.arrayBindingDeclaration([key]))],
					ts.NodeFlags.Const,
				),
				f.call("pairs", [
					f.as(
						value,
						f.referenceType("Map", [
							f.keywordType(ts.SyntaxKind.UnknownKeyword),
							f.keywordType(ts.SyntaxKind.UnknownKeyword),
						]),
					),
				]),
				f.block([
					ts.factory.createIfStatement(
						binary(
							binary(
								ts.factory.createLogicalNot(typeIs(key, "number")),
								ts.SyntaxKind.BarBarToken,
								binary(key, ts.SyntaxKind.LessThanToken, f.number(1)),
							),
							ts.SyntaxKind.BarBarToken,
							binary(
								binary(key, ts.SyntaxKind.PercentToken, f.number(1)),
								ts.SyntaxKind.ExclamationEqualsEqualsToken,
								f.number(0),
							),
						),
						f.block([reject()]),
					),
					ts.factory.createIfStatement(
						binary(key, ts.SyntaxKind.GreaterThanToken, size),
						f.block([f.statement(binary(size, ts.SyntaxKind.EqualsToken, key))]),
					),
				]),
			),
		);

		if (minLength > 0) {
			body.push(
				ts.factory.createIfStatement(
					binary(size, ts.SyntaxKind.LessThanToken, f.number(minLength)),
					f.block([reject()]),
				),
			);
		}

		body.push(
			f.variableStatement(
				list,
				f.as(value, f.referenceType("Array", [f.keywordType(ts.SyntaxKind.UnknownKeyword)])),
			),
		);

		// The elements before the rest, in their places.
		leading.forEach((_, position) => body.push(check(names[position], f.number(position))));

		// The rest, between them and the ones after it: `list[index - 1]` is Luau's `list[index]`.
		body.push(
			ts.factory.createForOfStatement(
				undefined,
				ts.factory.createVariableDeclarationList(
					[ts.factory.createVariableDeclaration(index)],
					ts.NodeFlags.Const,
				),
				f.call("$range", [
					f.number(leading.length + 1),
					trailing.length > 0 ? binary(size, ts.SyntaxKind.MinusToken, f.number(trailing.length)) : size,
				]),
				f.block([check(names[leading.length], binary(index, ts.SyntaxKind.MinusToken, f.number(1)))]),
			),
		);

		// The ones after the rest, at the end.
		trailing.forEach((_, position) =>
			body.push(
				check(
					names[leading.length + 1 + position],
					binary(size, ts.SyntaxKind.MinusToken, f.number(trailing.length - position)),
				),
			),
		);

		body.push(f.returnStatement(f.bool(true)));

		const guard = f.arrowFunction(
			f.block(body),
			[f.parameterDeclaration(value, f.keywordType(ts.SyntaxKind.UnknownKeyword))],
			undefined,
			ts.factory.createTypePredicateNode(undefined, value, f.keywordType(ts.SyntaxKind.UnknownKeyword)),
		);

		return f.call(
			ts.factory.createParenthesizedExpression(
				f.arrowFunction(
					guard,
					names.map((name) => f.parameterDeclaration(name)),
				),
			),
			checks,
		);
	}

	function buildUnionGuard(type: ts.UnionType) {
		const tId = state.getGuardLibrary(file);

		const boolType = type.checker.getBooleanType();
		if (type === boolType) {
			return f.field(tId, "boolean");
		}

		const { enums, literals, types: simplifiedTypes } = simplifyUnion(type);
		const [isOptional, types] = extractTypes(type.checker, simplifiedTypes);
		const guards = types.map((type) => buildGuard(type));
		guards.push(...enums.map((enumId) => f.call(f.field(tId, "enum"), [f.field("Enum", enumId)])));

		if (literals.length > 0) {
			guards.push(listLikeGuard("literal", literals));
		}

		const union = guards.length > 1 ? listLikeGuard("union", guards) : guards[0];
		if (!union) return f.field(tId, "none");

		return isOptional ? f.call(f.field(tId, "optional"), [union]) : union;
	}

	function buildIntersectionGuard(type: ts.IntersectionType) {
		if (type.checker.getIndexInfosOfType(type).length > 1) {
			fail("Flamework cannot generate intersections with multiple index signatures.");
		}

		// We find any disjoint types (strings, numbers, etc) as intersections with them are invalid.
		// Most intersections with disjoint types are used to introduce nominal fields.
		const disjointType = type.types.find((v) => v.flags & ts.TypeFlags.DisjointDomains);
		if (disjointType) {
			return buildGuard(disjointType);
		}

		// A brand on a buffer (`Serialization.buffer16`) is such a field too: the value is a buffer, which
		// is no table, so guarding the brand's object as well rejected every buffer that arrived.
		const bufferSymbol = type.checker.resolveName("buffer", undefined, ts.SymbolFlags.Type, false);
		const bufferType = type.types.find((v) => bufferSymbol !== undefined && v.getSymbol() === bufferSymbol);
		if (bufferType) {
			return buildGuard(bufferType);
		}

		const guards = type.types.map(buildGuard);
		return listLikeGuard("intersection", guards);
	}

	function buildGuardsFromType(type: ts.Type, isInterfaceType = false): ts.PropertyAssignment[] {
		const typeChecker = state.typeChecker;

		const declaration = getDeclarationOfType(type);
		if (declaration) {
			tracking.push([declaration, type]);
		}

		const guards = new Array<ts.PropertyAssignment>();
		for (const property of type.getProperties()) {
			const declaration = property.valueDeclaration;
			const propertyType = typeChecker.getTypeOfPropertyOfType(type, property.name);
			if (!propertyType) fail("Could not find type for field");

			if (isInterfaceType && (propertyType.flags & OBJECT_IGNORED_FIELD_TYPES) !== 0) {
				continue;
			}

			if (declaration) {
				tracking.push([declaration, propertyType]);
			}

			const attribute = buildGuard(propertyType);
			// `t.interface` checks the value at each guard's key, so a property keyed by a number
			// (`{ 10: V }`, `Record<Level, V>`) is checked at the number roblox-ts keys it by. A
			// component's attributes are named by strings, as the engine stores them.
			const name = isInterfaceType ? keyName(getPropertyKey(typeChecker, property)) : property.name;
			guards.push(f.propertyAssignmentDeclaration(name, attribute));

			if (declaration) {
				assert(tracking.pop()?.[0] === declaration, "Popped value was not expected");
			}
		}

		if (declaration) {
			assert(tracking.pop()?.[0] === declaration, "Popped value was not expected");
		}

		return guards;
	}

	/**
	 * Emits `t.<guard>(a, b)` for up to two members and `t.<guard>List({ ... })` beyond that.
	 *
	 * A Luau call has a hard limit on its argument count, so a large union or literal set spelled
	 * out as varargs fails to compile; the list variants take a table instead. This does not track
	 * the real register count, but fixing that fully would mean moving away from `t`.
	 */
	function listLikeGuard(guard: "union" | "intersection" | "literal", list: ts.Expression[]) {
		const tId = state.getGuardLibrary(file);

		if (list.length <= 2) {
			return f.call(f.field(tId, guard), list);
		}

		return f.call(f.field(tId, `${guard}List`), [list]);
	}
}

/**
 * The TypeScript enum member a literal is: the enum, merged across its declarations, and the member's
 * place among the enum's members as declared, counted across its declarations in order.
 */
export interface EnumMemberOrigin {
	enum: ts.Symbol;
	index: number;
}

/**
 * For each of the `count` literals {@link getLiteral} gave for `type`, the TypeScript enum member it
 * is (see {@link EnumMemberOrigin}), or `undefined` for a plain literal. The serializer numbers an
 * enum's values in its declaration order (`sortLiterals`).
 */
export function enumMemberOrigins(type: ts.Type, count: number): Array<EnumMemberOrigin | undefined> {
	// A member (`E.A`): a literal type whose symbol is the member, whose parent is the enum.
	if (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) {
		const member = enumMemberOf(type);
		if (member) return [member];
	}

	// A whole enum that `getLiteral` lists itself, from its one declaration, in order.
	if (type.flags & ts.TypeFlags.Enum && type.symbol) {
		const enumSymbol = type.checker.getMergedSymbol(type.symbol);
		return Array.from({ length: count }, (_, index) => ({ enum: enumSymbol, index }));
	}

	return new Array<EnumMemberOrigin | undefined>(count).fill(undefined);
}

/**
 * The TypeScript enum member `type` is (see {@link EnumMemberOrigin}): a member with a constant value,
 * whose type is a literal, or a computed one (`C = "abc".size()`), whose type is an `Enum` type of its
 * own. Either way the type's symbol is the member and its parent the enum.
 */
export function enumMemberOf(type: ts.Type): EnumMemberOrigin | undefined {
	const symbol = type.symbol;
	if (!(type.flags & (ts.TypeFlags.EnumLiteral | ts.TypeFlags.Enum))) return;
	if (!symbol || !(symbol.flags & ts.SymbolFlags.EnumMember) || !symbol.parent) return;

	const enumSymbol = type.checker.getMergedSymbol(symbol.parent);
	return { enum: enumSymbol, index: enumMemberIndex(enumSymbol, symbol) };
}

function enumMemberIndex(enumSymbol: ts.Symbol, member: ts.Symbol): number {
	let index = 0;
	for (const declaration of enumSymbol.declarations ?? []) {
		if (!ts.isEnumDeclaration(declaration)) continue;
		for (const declared of declaration.members) {
			if (declared === member.valueDeclaration) return index;
			index++;
		}
	}

	return index;
}

export function simplifyUnion(type: ts.UnionType) {
	const enumType = type.checker.resolveName("Enum", undefined, ts.SymbolFlags.Type, false);
	if (
		type.aliasSymbol &&
		type.aliasSymbol.parent &&
		type.checker.getMergedSymbol(type.aliasSymbol.parent) === enumType
	) {
		return { enums: [type.aliasSymbol.name], types: [], literals: [], literalOrigins: [] };
	}

	const currentTypes = type.types;
	const possibleEnums = new Map<ts.Symbol, Set<ts.Type>>();
	const enums = new Array<string>();
	const types = new Array<ts.Type>();
	const literals = new Array<ts.Expression>();
	/** Parallel to `literals`: the TypeScript enum member each one is, if any (see `enumMemberOrigins`). */
	const literalOrigins = new Array<EnumMemberOrigin | undefined>();
	const isBoolean = currentTypes.filter((v) => v.flags & ts.TypeFlags.BooleanLiteral).length === 2;

	if (isBoolean) {
		types.push(type.checker.getBooleanType());
	}

	for (const type of currentTypes) {
		// We do not need to generate symbol types as they don't exist in Lua.
		if (type.flags & ts.TypeFlags.ESSymbolLike) {
			continue;
		}

		// This is a full `boolean`, so we can skip the individual literals.
		if (isBoolean && type.flags & ts.TypeFlags.BooleanLiteral) {
			continue;
		}

		const literal = getLiteral(type, true);
		if (literal) {
			literals.push(...literal);
			literalOrigins.push(...enumMemberOrigins(type, literal.length));
			continue;
		}

		if (!type.symbol || !type.symbol.parent) {
			types.push(type);
			continue;
		}

		const enumKind = type.symbol.parent;
		if (!enumKind || !enumKind.parent || type.checker.getMergedSymbol(enumKind.parent) !== enumType) {
			types.push(type);
			continue;
		}

		if (type.symbol === enumKind.exports?.get(type.symbol.escapedName)) {
			let enumValues = possibleEnums.get(enumKind);
			if (!enumValues) possibleEnums.set(enumKind, (enumValues = new Set()));

			enumValues.add(type);
		}
	}

	for (const [symbol, set] of possibleEnums) {
		// Every item of the enum is present. The namespace also exports `GetEnumItems` and, for some
		// enums, alias constants (`KeyCode.Unknown` is `None`), so only the item interfaces are counted.
		let items = 0;
		symbol.exports?.forEach((member) => {
			if (member.flags & ts.SymbolFlags.Interface) items++;
		});

		if (set.size === items) {
			enums.push(symbol.name);
		} else {
			for (const type of set) {
				literals.push(f.field(f.field("Enum", symbol.name), type.symbol.name));
				literalOrigins.push(undefined);
			}
		}
	}

	return { enums, types, literals, literalOrigins };
}

export function extractTypes(typeChecker: ts.TypeChecker, types: ts.Type[]): [isOptional: boolean, types: ts.Type[]] {
	const undefinedtype = typeChecker.getUndefinedType();
	const voidType = typeChecker.getVoidType();

	return [
		types.some((type) => type === undefinedtype || type === voidType),
		types.filter((type) => type !== undefinedtype && type !== voidType),
	];
}

export function getLiteral(type: ts.Type, withoutEnums = false): ts.Expression[] | undefined {
	if (type.isStringLiteral() || type.isNumberLiteral()) {
		return [typeof type.value === "string" ? f.string(type.value) : f.number(type.value)];
	}

	const trueType = type.checker.getTrueType();
	if (type === trueType) {
		return [f.bool(true)];
	}

	const falseType = type.checker.getFalseType();
	if (type === falseType) {
		return [f.bool(false)];
	}

	if (type.flags & ts.TypeFlags.Enum) {
		const declarations = type.symbol.declarations;
		if (!declarations || declarations.length != 1 || !f.is.enumDeclaration(declarations[0])) return;

		const declaration = declarations[0];
		const memberValues = new Array<ts.Expression>();

		for (const member of declaration.members) {
			const constant = type.checker.getConstantValue(member);
			if (constant === undefined) return;

			memberValues.push(typeof constant === "string" ? f.string(constant) : f.number(constant));
		}

		return memberValues;
	}

	if (!withoutEnums) {
		const symbol = type.getSymbol();
		if (!symbol) return;

		const enumType = type.checker.resolveName("Enum", undefined, ts.SymbolFlags.Type, false);
		if (symbol.parent?.parent && type.checker.getMergedSymbol(symbol.parent.parent) === enumType) {
			return [f.field(f.field("Enum", symbol.parent.name), symbol.name)];
		}
	}
}

function isObjectType(type: ts.Type): type is ts.InterfaceType {
	return (type.flags & ts.TypeFlags.Object) !== 0;
}

export function isInstanceType(type: ts.Type) {
	return type.getProperty("_nominal_Instance") !== undefined;
}

export function isConditionalType(type: ts.Type): type is ts.ConditionalType {
	return (type.flags & ts.TypeFlags.Conditional) !== 0;
}
