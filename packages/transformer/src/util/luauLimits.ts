import ts from "typescript";

/**
 * Luau's limits on one function, a file's main chunk included, which roblox-ts does not check: past
 * either, the file builds and then fails to load ("Out of local registers when trying to allocate
 * x: exceeded limit 200", "Out of registers when trying to allocate 1 registers: exceeded limit
 * 255"). Locals are the variables a function declares, live to the end of the block they are in;
 * registers are those and the temporaries an expression needs on top of them. A function at either
 * limit loads; the build refuses a type's generated function only past them (see
 * {@link exceedsLimits}), by an estimate that counts no fewer than Luau: 99 levels of
 * `{ a: string; b: ... }` take 199 locals and build, 100 take 201 and are refused; 35 levels of
 * `Set<...>` take 255 registers and build, 36 take 262 and are refused. A send's packing, which lands
 * in the user's function among temporaries of roblox-ts's the estimate cannot all see, is never
 * refused: past the limits it is built compactly, and emitted as it is where even that is over.
 */
export const LUAU_MAX_LOCALS = 200;
export const LUAU_MAX_REGISTERS = 255;

/**
 * How many locals Flamework's generated code may add to a file's main chunk before what it adds goes
 * elsewhere: into a table the file keeps for them, into a block of its own, or into a function of its
 * own. Below it, the code is as it always was (a local is the cheapest thing to read); above it, a
 * file that holds hundreds of guards, literal tables or sends adds no more than this many locals
 * however many it holds, besides a few fixed ones (the table, the varint helpers).
 */
export const LOCAL_BUDGET = 16;

/**
 * The same for a function a call site's code lands in (a send's packing): a function's locals are its
 * own, and the user's function around a few sends is far from Luau's limit, so it keeps more of its
 * code as it always was before the rest goes in blocks of their own.
 */
export const FUNCTION_LOCAL_BUDGET = 64;

/**
 * What a generated function may reach, by {@link measurePressure}'s estimate, before its code is
 * built again in the compact form that keeps one field's locals at a time. The estimate counts the
 * locals the TypeScript it is built of declares and the temporaries roblox-ts adds for it, and errs
 * on the side of too many, never too few.
 */
export const COMPACT_LOCALS = 150;
export const COMPACT_REGISTERS = 200;

/**
 * Flamework's locals in each scope, against {@link LOCAL_BUDGET} for a file's main chunk, keyed by the
 * file's name, and {@link FUNCTION_LOCAL_BUDGET} for a function, keyed by its node. Each claim is also
 * kept by where its locals went, which tells where they are live (see {@link localsAround}).
 */
export class LocalBudget {
	private readonly used = new Map<ts.Node | string, number>();
	/** Claims by the statement, as written, that their locals went ahead of. */
	private readonly placed = new Map<ts.Node, number>();
	/** Claims of no statement's: locals the scope keeps to its end (a file's hoisted guards and tables). */
	private readonly unplaced = new Map<ts.Node | string, number>();

	/**
	 * Takes `count` locals of the scope's budget, or none and returns false when they do not fit.
	 * `statement` is the one, as written, they go ahead of, in its block, where they are live to the
	 * block's end; without one, they are live to the scope's end.
	 */
	claim(scope: ts.Node | string, count: number, statement?: ts.Node): boolean {
		const used = this.used.get(scope) ?? 0;
		if (used + count > (typeof scope === "string" ? LOCAL_BUDGET : FUNCTION_LOCAL_BUDGET)) return false;
		this.used.set(scope, used + count);
		if (statement) this.placed.set(statement, (this.placed.get(statement) ?? 0) + count);
		else this.unplaced.set(scope, (this.unplaced.get(scope) ?? 0) + count);
		return true;
	}

	/** The locals claimed ahead of `statement`, as written. */
	ahead(statement: ts.Node): number {
		return this.placed.get(statement) ?? 0;
	}

	/** The locals claimed in the scope with no statement, live to its end. */
	scopeWide(scope: ts.Node | string): number {
		return this.unplaced.get(scope) ?? 0;
	}
}

/** The statement `node` is in, as written: the one code put ahead of it goes ahead of. */
export function enclosingStatement(node: ts.Node): ts.Statement | undefined {
	let current: ts.Node | undefined = ts.getParseTreeNode(node) ?? node;
	while (current !== undefined && !ts.isStatement(current)) current = current.parent;
	return current;
}

/**
 * The scope a call site's code lands in: the function around `node`, or its file (by name) when it is
 * at the top of the file. Read from the node as written; a node with no parent (a transformer before
 * Flamework's rewrote it) has no scope that can be told, and gets `undefined`.
 */
export function enclosingScope(node: ts.Node): ts.Node | string | undefined {
	const original = ts.getParseTreeNode(node) ?? node;
	let current: ts.Node | undefined = original.parent;
	while (current !== undefined) {
		if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current)) return current;
		if (ts.isSourceFile(current)) return current.fileName;
		current = current.parent;
	}

	return undefined;
}

export interface Pressure {
	locals: number;
	registers: number;
}

/**
 * An estimate of the most locals and registers a function whose body is `statements` holds at once,
 * its `parameters` included, and `outer` more where the statements land in a function that holds
 * locals of its own (a send's packing). Each local is counted to the end of its block, as Luau keeps it,
 * roblox-ts's temporaries among them (see {@link Temporaries}); an expression costs the registers
 * Luau's compiler takes for it (see {@link Temporaries.value}), where it cannot be told the larger
 * count. Functions written inside the statements are functions of their own and cost one register
 * here. It is meant never to count short: the build refuses a type's function by it at Luau's own
 * limits.
 */
export function measurePressure(
	statements: readonly ts.Statement[],
	parameters: readonly string[] = [],
	outer = 0,
): Pressure {
	return new Temporaries(statements, parameters).block(statements, parameters.length + outer);
}

/**
 * The locals live where code put ahead of `node`'s statement runs, as far as the source tells: the
 * parameters of the function around it (and a method's `self`), the loop variables and the names
 * declared ahead of it in each block around it, and at the top of a file those the file is sure to
 * keep (see {@link sureLocalsOf}). With `budget`, Flamework's locals too: those it claimed ahead of the
 * statements, `node`'s own among them, of each block around it, live to that block's end; a claim
 * inside a block that has ended is not counted. The least there are: what the estimate of the code
 * adds them to.
 */
export function localsAround(node: ts.Node, budget?: LocalBudget): number {
	let child: ts.Node = ts.getParseTreeNode(node) ?? node;
	let current = child.parent;
	let count = 0;
	while (current !== undefined) {
		if (
			ts.isBlock(current) ||
			ts.isSourceFile(current) ||
			ts.isModuleBlock(current) ||
			ts.isCaseOrDefaultClause(current)
		) {
			for (const statement of current.statements) {
				if (budget) count += budget.ahead(statement);
				if (statement === child) break;
				count += ts.isSourceFile(current) ? sureLocalsOf(statement) : declaredNames(statement);
			}
			if (ts.isSourceFile(current)) return count;
		}
		if (
			(ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isForStatement(current)) &&
			child === current.statement &&
			current.initializer !== undefined &&
			ts.isVariableDeclarationList(current.initializer)
		) {
			for (const declaration of current.initializer.declarations) count += bindingNames(declaration.name);
		}
		if (ts.isFunctionLike(current)) {
			for (const parameter of current.parameters) {
				// `this` is a type annotation, not a parameter.
				if (!(ts.isIdentifier(parameter.name) && parameter.name.text === "this"))
					count += bindingNames(parameter.name);
			}
			if (ts.isMethodDeclaration(current) || ts.isAccessor(current) || ts.isConstructorDeclaration(current))
				count += 1;
			return count;
		}
		if (ts.isClassStaticBlockDeclaration(current)) return count;
		child = current;
		current = current.parent;
	}
	return count;
}

/** Whether a function's measure is past what {@link COMPACT_LOCALS} and {@link COMPACT_REGISTERS} allow. */
export function needsCompacting(pressure: Pressure) {
	return pressure.locals > COMPACT_LOCALS || pressure.registers > COMPACT_REGISTERS;
}

/**
 * Whether a function's measure is past Luau's limits, {@link LUAU_MAX_LOCALS} and
 * {@link LUAU_MAX_REGISTERS}, which a function at them loads with: past them, the build refuses a
 * type's function (a send's packing it never refuses).
 */
export function exceedsLimits(pressure: Pressure) {
	return pressure.locals > LUAU_MAX_LOCALS || pressure.registers > LUAU_MAX_REGISTERS;
}

/** The locals a list of statements declares in the block it is in. */
export function declaredLocals(statements: readonly ts.Statement[]): number {
	return statements.reduce((sum, statement) => sum + declaredNames(statement), 0);
}

/**
 * Whether `statements` leave a local in the block they are in: one they declare, or a temporary
 * roblox-ts declares ahead of one of them. A block of their own ends those with it.
 */
export function holdsLocals(statements: readonly ts.Statement[]): boolean {
	const temporaries = new Temporaries(statements);
	return statements.some((statement) => declaredNames(statement) > 0 || temporaries.ofStatement(statement) > 0);
}

/** The locals a statement declares in the block it is in. */
function declaredNames(statement: ts.Statement): number {
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.reduce(
			(sum, declaration) => sum + bindingNames(declaration.name),
			0,
		);
	}

	if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name ? 1 : 0;
	return 0;
}

function bindingNames(name: ts.BindingName): number {
	if (ts.isIdentifier(name)) return 1;
	let count = 0;
	for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) count += bindingNames(element.name);
	}

	return count;
}

// --- roblox-ts's temporaries ------------------------------------------------------------------------

/**
 * The locals roblox-ts 3.0 declares on top of the ones written: an expression that cannot be one Luau
 * expression is compiled to statements ahead of the statement it is in (its prerequisites), and those
 * declare temporaries, locals of the same block, live to its end like any other. What each shape of
 * code costs, as roblox-ts compiles it:
 *
 * - `a(x, y)`, `[x, y]`, `x + y`, `new A(x, y)`, `` `${x}` ``: one `_exp` for each operand ahead of the last
 *   one with prerequisites, unless it is a literal or a `const` (`ensureTransformOrder`).
 * - A macro call (`m.get(k)`, `s.push(x)`, ...): one `_arg` for each argument that is not a literal, a
 *   function or a `const`, and then one `_exp` for the object unless it is a `const`.
 * - `m.size()` of a `Map` or `Set` (a cast to one too): one `_size`, counted in a loop of five registers
 *   (a string's or an array's is `#`).
 * - `a(x)` whose arguments have prerequisites: one `_fn` for a callee that is not a `const` or a global's
 *   member.
 * - `o[i]` whose index has prerequisites: one `_exp` for `o`.
 * - `c ? a : b`, `if (c)`, `!c` of a type that may be 0, NaN or "": one `_value` for `c`, unless it is a
 *   local or a literal; one `_result` if `a` or `b` has prerequisites.
 * - `a && b`, `a || b`, `a ?? b` that cannot be one expression: one `_condition`.
 * - `{ k: v }` where a value has prerequisites: one `_object` for the table and one `_left` for each such
 *   key.
 * - `const [a, b] = x` of anything but a list or a call: one `_binding`.
 *
 * Generated code is not type checked here, so a type is told from the casts it is written with
 * (`v as boolean`, `text as string`); where it cannot be told, the count is the larger one. Names
 * declared with `const` in the statements are constants; any other name is taken for a variable (a
 * parameter, which roblox-ts copies), except where it is the object of a call, where it is a global
 * or a constant of the file's in what Flamework generates.
 */
class Temporaries {
	private readonly constants = new Set<string>();
	private readonly variables = new Set<string>();
	/** Names that hold a string or an array, whose `size()` is `#` rather than a count. */
	private readonly measurable = new Set<string>();
	/** What names declared with a collection's type or cast hold, which tells how roblox-ts loops over them. */
	private readonly collections = new Map<string, Collection>();
	/** The function's parameters, locals like those the statements declare. */
	private readonly parameters: ReadonlySet<string>;
	/**
	 * Whether the function may hold more than 256 constants, past which Luau's arithmetic cannot take
	 * one as it is (its operand is a byte) and reads it into a register. Counted generously: every
	 * distinct number, string, field name and name that is not a local.
	 */
	private readonly manyConstants: boolean;

	constructor(statements: readonly ts.Statement[], parameters: readonly string[] = []) {
		this.parameters = new Set(parameters);
		const constants = new Set<string>();
		const names = new Set<string>();
		const visit = (node: ts.Node) => {
			if (ts.isNumericLiteral(node)) constants.add(`n${node.text}`);
			else if (
				ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)
			)
				constants.add(`s${node.text}`);
			else if (ts.isPropertyAccessExpression(node)) constants.add(`s${node.name.text}`);
			else if (ts.isIdentifier(node)) names.add(node.text);
			if (ts.isVariableDeclarationList(node)) {
				const constant = (node.flags & ts.NodeFlags.Let) === 0;
				for (const declaration of node.declarations) {
					for (const name of namesOf(declaration.name)) {
						(constant ? this.constants : this.variables).add(name);
						if (
							ts.isIdentifier(declaration.name) &&
							(isMeasurableType(declaration.type) ||
								(declaration.initializer !== undefined && isMeasurableValue(declaration.initializer)))
						) {
							this.measurable.add(name);
						}
						const collection = ts.isIdentifier(declaration.name)
							? (collectionOfType(declaration.type) ??
								(declaration.initializer && collectionOf(declaration.initializer)))
							: undefined;
						if (collection) this.collections.set(name, collection);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		statements.forEach(visit);
		for (const name of names) {
			if (!this.constants.has(name) && !this.variables.has(name) && !this.parameters.has(name))
				constants.add(`s${name}`);
		}
		this.manyConstants = constants.size > 255;
	}

	block(statements: readonly ts.Statement[], live: number): Pressure {
		let locals = live;
		let registers = live;
		for (const statement of statements) {
			const temporaries = this.ofStatement(statement);
			const inner = this.statement(statement, live, temporaries);
			live += declaredNames(statement) + temporaries;
			locals = Math.max(locals, inner.locals, live);
			registers = Math.max(registers, inner.registers, live);
		}

		return { locals, registers };
	}

	/** One statement's pressure, with `temporaries` of roblox-ts's ahead of it. */
	private statement(statement: ts.Statement, live: number, temporaries = this.ofStatement(statement)): Pressure {
		const before = live;
		live += temporaries;
		const flat = (registers: number): Pressure => ({ locals: live, registers: live + registers });
		const most = (...pressures: Pressure[]): Pressure => ({
			locals: Math.max(live, ...pressures.map((pressure) => pressure.locals)),
			registers: Math.max(live, ...pressures.map((pressure) => pressure.registers)),
		});

		if (ts.isVariableStatement(statement)) {
			let registers = 0;
			let names = 0;
			for (const declaration of statement.declarationList.declarations) {
				if (declaration.initializer)
					registers = Math.max(registers, names + this.registers(declaration.initializer));
				names += bindingNames(declaration.name);
			}
			return { locals: live + names, registers: live + Math.max(registers, names) };
		}

		if (ts.isExpressionStatement(statement)) return flat(this.registers(statement.expression));
		if (ts.isReturnStatement(statement))
			return flat(statement.expression ? this.registers(statement.expression) : 0);
		if (ts.isBlock(statement)) return this.block(statement.statements, before);
		if (ts.isIfStatement(statement)) {
			const branches = [
				flat(this.registers(statement.expression)),
				this.statement(statement.thenStatement, live),
			];
			if (statement.elseStatement) branches.push(this.statement(statement.elseStatement, live));
			return most(...branches);
		}

		if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
			// The loop's variables are locals of its body; the registers it keeps for itself are not.
			const loop = this.loop(statement);
			const body = this.statement(statement.statement, live + loop.locals);
			return most(flat(this.registers(statement.expression) + 3), {
				locals: body.locals,
				registers: body.registers + loop.registers,
			});
		}

		if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
			return most(flat(this.registers(statement.expression)), this.statement(statement.statement, live));
		}

		if (ts.isForStatement(statement)) {
			// roblox-ts writes a numeric `for` (three registers, the third its variable, one local) or,
			// where it cannot, a `while` that keeps each variable in up to three locals and whether to
			// increment in one more, which is never less.
			const declared =
				statement.initializer && ts.isVariableDeclarationList(statement.initializer)
					? statement.initializer.declarations.reduce(
							(sum, declaration) => sum + bindingNames(declaration.name),
							0,
						)
					: 0;
			const locals = 3 * declared + 1;
			return most(flat(locals), this.statement(statement.statement, live + locals));
		}

		// Anything else generated code holds is a statement with no locals of its own: its expressions.
		let registers = 0;
		statement.forEachChild((child) => {
			if (ts.isExpression(child)) registers = Math.max(registers, this.registers(child));
		});
		return flat(registers);
	}

	/**
	 * The locals a `for ... of` declares for its body, as roblox-ts writes it, and the registers it
	 * keeps on top of them for the length of its body. Over a `$range` it is Luau's numeric `for`,
	 * three registers, the third of them its variable. Over anything else it is Luau's generic `for`,
	 * which keeps three registers and then one for each of the names roblox-ts gives it, two at
	 * least: `_` and the element over an array, the element alone over a set, the pattern's names
	 * over a map or `pairs` (`_k` and `_v` for a name, which then holds them as a list). Where the
	 * collection cannot be told, the count is the largest.
	 */
	private loop(statement: ts.ForOfStatement | ts.ForInStatement): Pressure {
		const declaration = ts.isVariableDeclarationList(statement.initializer)
			? statement.initializer.declarations[0]
			: undefined;
		const iterable = skipOuter(statement.expression);
		if (
			ts.isCallExpression(iterable) &&
			ts.isIdentifier(iterable.expression) &&
			iterable.expression.text === "$range" &&
			declaration !== undefined &&
			ts.isIdentifier(declaration.name)
		) {
			return { locals: 1, registers: 2 };
		}

		const generic = (variables: number, inner = 0): Pressure => ({
			locals: variables + inner,
			registers: 3 + Math.max(variables, 2) - variables,
		});
		// A pattern takes one value, and its names are declared in the body from it.
		const unpacked = (pattern: ts.BindingName | undefined) =>
			pattern === undefined || ts.isIdentifier(pattern) ? 0 : bindingNames(pattern);
		const name = declaration?.name;
		const asArray = generic(2, unpacked(name));
		const asSet = generic(1, unpacked(name));
		// Over a map, each element of an array pattern is a variable of the loop's.
		let asMap = generic(2, name === undefined ? 0 : 1 + unpacked(name));
		if (name !== undefined && ts.isArrayBindingPattern(name)) {
			let inner = 0;
			for (const element of name.elements) if (ts.isBindingElement(element)) inner += unpacked(element.name);
			asMap = generic(name.elements.length, inner);
		}
		switch (this.collectionOf(statement.expression)) {
			case "array":
				return asArray;
			case "set":
				return asSet;
			case "map":
				return asMap;
			default: {
				const loops = [asArray, asSet, asMap];
				const locals = Math.max(...loops.map((loop) => loop.locals));
				const registers = Math.max(...loops.map((loop) => loop.locals + loop.registers));
				return { locals, registers: registers - locals };
			}
		}
	}

	/** The kind of collection `node` is, by how it is written or the name it reads. */
	private collectionOf(node: ts.Expression): Collection | undefined {
		const written = collectionOf(node);
		if (written) return written;
		const expression = skipOuter(node);
		return ts.isIdentifier(expression) ? this.collections.get(expression.text) : undefined;
	}

	/** The temporaries roblox-ts declares ahead of `statement`, in the block it is in. */
	ofStatement(statement: ts.Statement): number {
		if (ts.isVariableStatement(statement)) {
			let count = 0;
			for (const declaration of statement.declarationList.declarations) {
				const initializer = declaration.initializer;
				if (!initializer) continue;
				count += this.of(initializer).count;
				const value = skipOuter(initializer);
				if (
					!ts.isIdentifier(declaration.name) &&
					!ts.isArrayLiteralExpression(value) &&
					!ts.isCallExpression(value)
				)
					count += 1;
			}
			return count;
		}

		if (ts.isExpressionStatement(statement)) {
			const expression = skipOuter(statement.expression);
			if (ts.isBinaryExpression(expression) && isAssignment(expression.operatorToken.kind))
				return this.assignment(expression, true).count;
			if (
				(ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) &&
				(expression.operator === ts.SyntaxKind.PlusPlusToken ||
					expression.operator === ts.SyntaxKind.MinusMinusToken)
			) {
				return this.of(expression.operand).count;
			}
			return this.of(expression).count;
		}

		if (ts.isIfStatement(statement)) return this.condition(statement.expression).count;
		if (ts.isWhileStatement(statement) || ts.isDoStatement(statement))
			return this.condition(statement.expression).count;
		if (ts.isBlock(statement)) return 0;
		if (ts.isForStatement(statement)) {
			let count = 0;
			if (statement.initializer && ts.isVariableDeclarationList(statement.initializer)) {
				for (const declaration of statement.initializer.declarations)
					if (declaration.initializer) count += this.of(declaration.initializer).count;
			} else if (statement.initializer) {
				count += this.of(statement.initializer).count;
			}
			if (statement.condition) count += this.condition(statement.condition).count;
			if (statement.incrementor) count += this.of(statement.incrementor).count;
			return count;
		}

		let count = 0;
		statement.forEachChild((child) => {
			if (ts.isExpression(child)) count += this.of(child).count;
		});
		return count;
	}

	/** An expression's temporaries, and whether it has prerequisites at all (some write no local). */
	private of(node: ts.Expression): Cost {
		const expression = skipOuter(node);
		if (isPrimitive(expression) || ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword)
			return FREE;
		if (ts.isPropertyAccessExpression(expression)) return this.of(expression.expression);
		if (ts.isElementAccessExpression(expression)) {
			const object = this.of(expression.expression);
			const index = this.of(expression.argumentExpression);
			return {
				count: object.count + index.count + (index.prereqs ? 1 : 0),
				prereqs: object.prereqs || index.prereqs,
			};
		}

		if (ts.isCallExpression(expression)) return this.call(expression);
		if (ts.isNewExpression(expression)) return this.ordered(expression.arguments ?? []);
		if (ts.isBinaryExpression(expression)) {
			const operator = expression.operatorToken.kind;
			if (
				operator === ts.SyntaxKind.AmpersandAmpersandToken ||
				operator === ts.SyntaxKind.BarBarToken ||
				operator === ts.SyntaxKind.QuestionQuestionToken
			) {
				return this.logical(expression);
			}
			if (isAssignment(operator)) return this.assignment(expression, false);
			return this.ordered([expression.left, expression.right]);
		}

		if (ts.isConditionalExpression(expression)) {
			const condition = this.condition(expression.condition);
			const whenTrue = this.of(expression.whenTrue);
			const whenFalse = this.of(expression.whenFalse);
			if (!whenTrue.prereqs && !whenFalse.prereqs) return condition;
			// `local _result; if c then <a's> _result = a else <b's> _result = b end`
			return { count: condition.count + 1 + Math.max(whenTrue.count, whenFalse.count), prereqs: true };
		}

		if (ts.isPrefixUnaryExpression(expression)) {
			if (expression.operator === ts.SyntaxKind.ExclamationToken) return this.condition(expression.operand);
			if (
				expression.operator === ts.SyntaxKind.PlusPlusToken ||
				expression.operator === ts.SyntaxKind.MinusMinusToken
			) {
				return { count: this.of(expression.operand).count + 1, prereqs: true };
			}
			return this.of(expression.operand);
		}

		if (ts.isPostfixUnaryExpression(expression)) {
			return { count: this.of(expression.operand).count + 1, prereqs: true };
		}

		if (ts.isObjectLiteralExpression(expression)) return this.object(expression);
		if (ts.isArrayLiteralExpression(expression)) {
			const spreads = expression.elements.filter(ts.isSpreadElement).length;
			const cost = this.ordered(expression.elements);
			return spreads > 0 ? { count: cost.count + spreads + 1, prereqs: true } : cost;
		}

		if (ts.isTemplateExpression(expression))
			return this.ordered(expression.templateSpans.map((span) => span.expression));
		if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isClassExpression(expression))
			return FREE;
		if (
			ts.isAwaitExpression(expression) ||
			ts.isTypeOfExpression(expression) ||
			ts.isVoidExpression(expression) ||
			ts.isDeleteExpression(expression) ||
			ts.isSpreadElement(expression)
		) {
			return this.of(expression.expression);
		}

		// Anything else: what its parts cost, and a temporary of its own, to be sure.
		let count = 1;
		expression.forEachChild((child) => {
			if (ts.isExpression(child)) count += this.of(child).count;
		});
		return { count, prereqs: true };
	}

	/** Operands roblox-ts evaluates in order: those ahead of the last with prerequisites are copied. */
	private ordered(operands: readonly ts.Expression[]): Cost {
		const costs = operands.map((operand) => this.of(operand));
		const last = lastIndexWithPrereqs(costs);
		let count = 0;
		costs.forEach((cost, index) => {
			count += cost.count;
			if (index < last && this.isCopiedAhead(operands[index])) count += 1;
		});
		return { count, prereqs: last >= 0 };
	}

	/** Whether `ensureTransformOrder` copies an operand ahead of a later one's prerequisites. */
	private isCopiedAhead(operand: ts.Expression) {
		// roblox-ts reads the operand as it is written: a cast of a constant is copied.
		if (ts.isIdentifier(operand) && this.constants.has(operand.text)) return false;
		return !isPrimitive(skipOuter(operand));
	}

	private call(call: ts.CallExpression): Cost {
		// A method is called on its object; anything else (a cast of a field included) is a plain call.
		const callee = call.expression;
		const property = ts.isPropertyAccessExpression(callee) ? callee : undefined;
		const object = property ? property.expression : callee;
		const head = this.of(object);
		const args = call.arguments;
		const costs = args.map((argument) => this.of(argument));
		const last = lastIndexWithPrereqs(costs);
		let count = head.count;
		let prereqs = head.prereqs;
		let argumentPrereqs = last >= 0;
		const copied = args.map((argument, index) => index < last && this.isCopiedAhead(argument));
		costs.forEach((cost, index) => (count += cost.count + (copied[index] ? 1 : 0)));

		if (property && MACRO_METHODS.has(property.name.text) && !isLibrary(object)) {
			// A macro reads each argument that might change into a temporary of its own.
			args.forEach((argument, index) => {
				if (!copied[index] && this.mightChange(argument, true)) {
					count += 1;
					argumentPrereqs = true;
				}
			});
			if (property.name.text === "size" && args.length === 0 && !this.isMeasurable(object)) {
				count += 1;
				prereqs = true;
			}
		}

		if (argumentPrereqs && this.mightChange(property ? object : callee, false)) count += 1;
		return { count, prereqs: prereqs || argumentPrereqs };
	}

	private assignment(expression: ts.BinaryExpression, statement: boolean): Cost {
		const target = skipOuter(expression.left);
		let written: Cost = FREE;
		if (ts.isElementAccessExpression(target))
			written = this.ordered([target.expression, target.argumentExpression]);
		else if (ts.isPropertyAccessExpression(target)) written = this.of(target.expression);
		const value = this.of(expression.right);
		// Used as a value, the target is read again after the write, through temporaries.
		const read = statement ? 0 : 1;
		return { count: written.count + value.count + read, prereqs: written.prereqs || value.prereqs || !statement };
	}

	private logical(expression: ts.BinaryExpression): Cost {
		const operator = expression.operatorToken.kind;
		const operands = flatten(expression, operator);
		const costs = operands.map((operand) => this.of(operand));
		const count = costs.reduce((sum, cost) => sum + cost.count, 0);
		const inline =
			costs.every((cost) => !cost.prereqs) &&
			(operator === ts.SyntaxKind.QuestionQuestionToken
				? operands.slice(0, -1).every((operand) => ts.isIdentifier(skipOuter(operand)))
				: operands.slice(0, -1).every((operand) => isBooleanTyped(operand)));
		return inline ? { count, prereqs: false } : { count: count + 1, prereqs: true };
	}

	/** A value tested as a condition: JavaScript's test reads one of a type that may be falsy into a temporary. */
	private condition(condition: ts.Expression): Cost {
		const cost = this.of(condition);
		const inner = skipOuter(condition);
		if (isBooleanTyped(condition) || ts.isIdentifier(inner) || isPrimitive(inner)) return cost;
		return { count: cost.count + 1, prereqs: true };
	}

	private object(expression: ts.ObjectLiteralExpression): Cost {
		let count = 0;
		let prereqs = false;
		for (const property of expression.properties) {
			let cost: Cost = FREE;
			if (ts.isPropertyAssignment(property)) {
				const key = ts.isComputedPropertyName(property.name) ? this.of(property.name.expression) : FREE;
				const value = this.of(property.initializer);
				cost = { count: key.count + value.count, prereqs: key.prereqs || value.prereqs };
			} else if (ts.isSpreadAssignment(property)) {
				cost = { count: this.of(property.expression).count + 1, prereqs: true };
			}
			count += cost.count;
			if (!cost.prereqs) continue;
			// The table goes in `_object` at the first such value, and each such key in a `_left`.
			if (!prereqs) count += 1;
			count += 1;
			prereqs = true;
		}
		return { count, prereqs };
	}

	/** roblox-ts's `expressionMightMutate`: whether reading `expression` later could see another value. */
	private mightChange(node: ts.Expression, unknownNames: boolean): boolean {
		const expression = skipOuter(node);
		if (isPrimitive(expression) || ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
			return false;
		if (ts.isIdentifier(expression)) {
			if (this.constants.has(expression.text)) return false;
			return this.variables.has(expression.text) || unknownNames;
		}
		if (ts.isConditionalExpression(expression)) {
			return [expression.condition, expression.whenTrue, expression.whenFalse].some((part) =>
				this.mightChange(part, unknownNames),
			);
		}
		if (ts.isBinaryExpression(expression) && !isAssignment(expression.operatorToken.kind)) {
			return this.mightChange(expression.left, unknownNames) || this.mightChange(expression.right, unknownNames);
		}
		if (ts.isPrefixUnaryExpression(expression)) return this.mightChange(expression.operand, unknownNames);
		if (ts.isArrayLiteralExpression(expression))
			return expression.elements.some((element) => this.mightChange(element, unknownNames));
		return true;
	}

	/**
	 * Whether `size()` of `node` is `#`. A cast says it (`(v as Set<defined>).size()` is a count); a
	 * name the statements do not declare is a parameter, and the only ones generated code calls
	 * `size()` on uncast are its blob list and its `where`.
	 */
	private isMeasurable(node: ts.Expression): boolean {
		if (isMeasurableValue(node)) return true;
		if (castType(node) !== undefined) return false;
		const expression = skipOuter(node);
		if (!ts.isIdentifier(expression)) return false;
		const declared = this.constants.has(expression.text) || this.variables.has(expression.text);
		return !declared || this.measurable.has(expression.text);
	}
	// --- the registers an expression takes ------------------------------------------------------------

	/**
	 * The registers a statement's expression takes on top of the locals live at it: what Luau's
	 * compiler takes for it ({@link value}), and at least the five a \`size()\` counted in a loop takes
	 * ahead of it (a generic \`for\`'s three and its two variables, above its \`_size\`).
	 */
	private registers(expression: ts.Expression): number {
		return Math.max(this.value(expression), this.countsInLoop(expression) ? 5 : 0);
	}

	/**
	 * The registers Luau's compiler takes to compute `node` into a register at the top of the stack,
	 * that one included. A local is read where it is; anything else an operation reads (a field, a
	 * call, a constant most operations cannot take as it is, an upvalue such as the file's table) is
	 * computed into a register of its own above the result, held until the operation is done: `a.b.c`
	 * takes two, `t[f(x)]` one for `t` when it is not a local and then the call's. A call puts its
	 * function and arguments in registers of their own, one after another, a method its object too.
	 * Where how roblox-ts writes the expression cannot be told from it, the count is the larger one: an
	 * index that is not a constant is taken for a list's, which roblox-ts reads at `i + 1`.
	 */
	private value(node: ts.Expression): number {
		const expression = skipOuter(node);
		if (isPrimitive(expression) || ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword)
			return 1;
		if (ts.isPropertyAccessExpression(expression)) {
			// A global's chain (`buffer.writeu8`, `Enum.KeyCode.A`) is one import.
			if (this.isImport(expression)) return 1;
			return 1 + this.peak(expression.expression);
		}
		if (ts.isElementAccessExpression(expression))
			return this.indexRegisters(expression.expression, expression.argumentExpression);
		if (ts.isCallExpression(expression)) return this.callRegisters(expression.expression, expression.arguments);
		if (ts.isNewExpression(expression)) return this.callOf(1, expression.arguments ?? []);
		if (ts.isBinaryExpression(expression)) return this.binaryRegisters(expression);
		if (ts.isConditionalExpression(expression)) {
			// The condition is tested in a register above the result, then a branch computed into it.
			return Math.max(
				1 + this.tested(expression.condition),
				this.value(expression.whenTrue),
				this.value(expression.whenFalse),
			);
		}
		if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression))
			return 1 + this.peak(expression.operand);
		if (ts.isObjectLiteralExpression(expression)) {
			let registers = 0;
			for (const property of expression.properties) {
				if (ts.isPropertyAssignment(property))
					registers = Math.max(registers, this.value(property.initializer));
				else if (ts.isSpreadAssignment(property))
					registers = Math.max(registers, 2 + this.value(property.expression));
			}
			return 1 + registers;
		}
		if (ts.isArrayLiteralExpression(expression)) {
			let registers = 0;
			for (const element of expression.elements) registers = Math.max(registers, this.value(element));
			// Luau stores the elements of a constructor in batches of sixteen.
			return 1 + Math.min(expression.elements.length, 16) + registers;
		}
		if (ts.isTemplateExpression(expression)) {
			// `string.format` on the text, a method call in registers above the result's: the function,
			// the text, then each value.
			return (
				1 +
				this.callOf(
					2,
					expression.templateSpans.map((span) => span.expression),
				)
			);
		}
		if (ts.isTypeOfExpression(expression)) return this.callOf(1, [expression.expression]);
		if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isClassExpression(expression))
			return 1;

		// Anything else: one more than the most any part takes, to be sure.
		let registers = 1;
		expression.forEachChild((child) => {
			if (ts.isExpression(child)) registers = Math.max(registers, 1 + this.value(child));
		});
		return registers;
	}

	/** Whether `node` is a local of the function: a name the statements declare, or a parameter. */
	private isLocal(node: ts.Expression): boolean {
		const expression = skipOuter(node);
		return (
			ts.isIdentifier(expression) &&
			(this.constants.has(expression.text) ||
				this.variables.has(expression.text) ||
				this.parameters.has(expression.text))
		);
	}

	/** What an operation that reads `node` takes to have it in a register: none for a local. */
	private peak(node: ts.Expression): number {
		return this.isLocal(node) ? 0 : this.value(node);
	}

	/** The register `node` holds while the rest of an operation is computed: none for a local. */
	private held(node: ts.Expression): number {
		return this.isLocal(node) ? 0 : 1;
	}

	/** {@link peak} of an operand Luau takes as a constant when it is one (a comparison's, an index). */
	private constantPeak(node: ts.Expression): number {
		return isPrimitive(skipOuter(node)) ? 0 : this.peak(node);
	}

	private constantHeld(node: ts.Expression): number {
		return isPrimitive(skipOuter(node)) ? 0 : this.held(node);
	}

	/** Whether a field read is a global's chain of up to three names, which Luau reads with one import. */
	private isImport(expression: ts.PropertyAccessExpression): boolean {
		let object = skipOuter(expression.expression);
		let names = 2;
		while (ts.isPropertyAccessExpression(object)) {
			object = skipOuter(object.expression);
			names++;
		}
		return names <= 3 && ts.isIdentifier(object) && !this.isLocal(object) && isGlobalName(object.text);
	}

	/** `object[index]`: the object, held, then the index; one that is not a constant read at `i + 1`. */
	private indexRegisters(object: ts.Expression, index: ts.Expression): number {
		if (isPrimitive(skipOuter(index))) return 1 + this.peak(object);
		return 1 + Math.max(this.peak(object), this.held(object) + 1 + this.peak(index));
	}

	/** A call of `callee` with `args`, as roblox-ts writes it. */
	private callRegisters(node: ts.Expression, args: readonly ts.Expression[]): number {
		const callee = skipOuter(node);
		if (ts.isPropertyAccessExpression(callee)) {
			const object = callee.expression;
			const name = callee.name.text;
			if (MACRO_METHODS.has(name) && !isLibrary(object)) {
				if (name === "size" && args.length === 0) {
					// `#object` of a string or a list; a set's or a map's is its `_size`, a local.
					return this.isMeasurable(object) ? 1 + this.peak(object) : 1;
				}
				// `m.get(k)` is `m[k]`.
				if (name === "get" && args.length === 1)
					return 1 + Math.max(this.peak(object), this.held(object) + this.constantPeak(args[0]));
				// Any other macro: as a library function of the object and the arguments, and one more
				// (`s.has(x)` is `s[x] ~= nil`, `a.push(x)` is `table.insert(a, x)`).
				return 1 + this.callOf(1, [object, ...args]);
			}

			// A method of a Roblox type (`CFrame.GetComponents`, `Enum.KeyCode.GetEnumItems`) is called
			// with its object in the register after the function's.
			if (/^[A-Z]/.test(name)) return Math.max(1 + this.value(object), this.callOf(2, args));
		}

		// roblox-ts's macros of a value (`typeIs(x, "table")` is `type(x) == "table"`): one more.
		if (ts.isIdentifier(callee) && MACRO_FUNCTIONS.has(callee.text)) return 1 + this.callOf(1, args);
		return Math.max(this.value(callee), this.callOf(1, args));
	}

	/** The registers of a call whose function (and object) take `head` registers, before `args`. */
	private callOf(head: number, args: readonly ts.Expression[]): number {
		let registers = head + args.length;
		args.forEach((argument, index) => {
			registers = Math.max(registers, head + index + this.value(argument));
		});
		return registers;
	}

	private binaryRegisters(expression: ts.BinaryExpression): number {
		const operator = expression.operatorToken.kind;
		const left = expression.left;
		const right = expression.right;
		switch (operator) {
			// A short circuit computes both sides into the result's register.
			case ts.SyntaxKind.AmpersandAmpersandToken:
			case ts.SyntaxKind.BarBarToken:
			case ts.SyntaxKind.QuestionQuestionToken:
				return Math.max(this.value(left), this.value(right));
			// Compared, then a boolean written: an equality takes a constant as it is.
			case ts.SyntaxKind.EqualsEqualsEqualsToken:
			case ts.SyntaxKind.ExclamationEqualsEqualsToken:
			case ts.SyntaxKind.EqualsEqualsToken:
			case ts.SyntaxKind.ExclamationEqualsToken:
				return 1 + this.tested(expression);
			case ts.SyntaxKind.LessThanToken:
			case ts.SyntaxKind.LessThanEqualsToken:
			case ts.SyntaxKind.GreaterThanToken:
			case ts.SyntaxKind.GreaterThanEqualsToken:
				return 1 + Math.max(this.peak(left), this.held(left) + this.peak(right));
			// Bit operations are calls of `bit32`'s.
			case ts.SyntaxKind.AmpersandToken:
			case ts.SyntaxKind.BarToken:
			case ts.SyntaxKind.CaretToken:
			case ts.SyntaxKind.LessThanLessThanToken:
			case ts.SyntaxKind.GreaterThanGreaterThanToken:
			case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
				return this.callOf(1, [left, right]);
			case ts.SyntaxKind.InKeyword:
			case ts.SyntaxKind.InstanceOfKeyword:
				return 1 + this.callOf(1, [left, right]);
		}
		if (isAssignment(operator)) return this.assigned(expression);

		// A string's `+` is Luau's `..`, which takes its operands in registers one after another.
		if (operator === ts.SyntaxKind.PlusToken && (isStringValue(left) || isStringValue(right))) {
			const operands = flatten(expression, operator);
			return this.callOf(1, operands);
		}

		// Arithmetic takes a number on the right as it is, among a function's first 256 constants, and
		// anything else in a register.
		const rightPeak = ts.isNumericLiteral(skipOuter(right)) && !this.manyConstants ? 0 : this.peak(right);
		return 1 + Math.max(this.peak(left), this.held(left) + rightPeak);
	}

	/**
	 * What testing `node` as a condition takes above where its result goes: none for a local or a
	 * constant, an equality's operands (a constant as it is), each side of `&&` and `||` alike.
	 */
	private tested(node: ts.Expression): number {
		const expression = skipOuter(node);
		if (isPrimitive(expression) || this.isLocal(expression)) return 0;
		if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken)
			return this.tested(expression.operand);
		if (ts.isBinaryExpression(expression)) {
			switch (expression.operatorToken.kind) {
				case ts.SyntaxKind.AmpersandAmpersandToken:
				case ts.SyntaxKind.BarBarToken:
					return Math.max(this.tested(expression.left), this.tested(expression.right));
				case ts.SyntaxKind.EqualsEqualsEqualsToken:
				case ts.SyntaxKind.ExclamationEqualsEqualsToken:
				case ts.SyntaxKind.EqualsEqualsToken:
				case ts.SyntaxKind.ExclamationEqualsToken:
					return Math.max(
						this.constantPeak(expression.left),
						this.constantHeld(expression.left) + this.constantPeak(expression.right),
					);
			}
		}
		return this.value(expression);
	}

	/** An assignment: where it goes (a field's object, an index), held, then the value. */
	private assigned(expression: ts.BinaryExpression): number {
		const target = skipOuter(expression.left);
		const compound = expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken;
		// A compound assignment reads the target into a register first, and takes a number as it is.
		const value = compound
			? (ts.isNumericLiteral(skipOuter(expression.right)) && !this.manyConstants
					? 0
					: this.peak(expression.right)) + (this.isLocal(target) ? 0 : 1)
			: this.value(expression.right);
		if (ts.isPropertyAccessExpression(target)) {
			return Math.max(this.peak(target.expression), this.held(target.expression) + value);
		}
		if (ts.isElementAccessExpression(target)) {
			const object = target.expression;
			const index = target.argumentExpression;
			const constant = isPrimitive(skipOuter(index));
			const indexPeak = constant ? 0 : 1 + this.peak(index);
			const indexHeld = constant ? 0 : 1;
			return Math.max(this.peak(object), this.held(object) + indexPeak, this.held(object) + indexHeld + value);
		}
		return value;
	}

	/** Whether `node` holds a `size()` that roblox-ts counts in a loop ahead of the statement. */
	private countsInLoop(node: ts.Node): boolean {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return false;
		if (
			ts.isCallExpression(node) &&
			node.arguments.length === 0 &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "size" &&
			!isLibrary(node.expression.expression) &&
			!this.isMeasurable(node.expression.expression)
		) {
			return true;
		}
		return ts.forEachChild(node, (child) => this.countsInLoop(child) || undefined) ?? false;
	}
}

interface Cost {
	/** The temporaries, locals of the block the statement is in. */
	count: number;
	/** Whether roblox-ts writes statements ahead of the expression, which makes it copy what comes before. */
	prereqs: boolean;
}

const FREE: Cost = { count: 0, prereqs: false };

/** roblox-ts's property call macros: the methods of its arrays, maps, sets and strings. */
const MACRO_METHODS = new Set([
	"add",
	"byte",
	"clear",
	"delete",
	"every",
	"filter",
	"filterUndefined",
	"find",
	"findIndex",
	"forEach",
	"format",
	"get",
	"gmatch",
	"gsub",
	"has",
	"includes",
	"indexOf",
	"insert",
	"isEmpty",
	"join",
	"lower",
	"map",
	"mapFiltered",
	"match",
	"move",
	"pop",
	"push",
	"reduce",
	"remove",
	"rep",
	"reverse",
	"set",
	"shift",
	"size",
	"some",
	"sort",
	"split",
	"sub",
	"unorderedRemove",
	"unshift",
	"upper",
]);

/** Luau's libraries, whose functions are plain calls. */
const LIBRARIES = new Set(["buffer", "math", "string", "table", "bit32", "utf8", "vector", "coroutine", "os", "debug"]);

function isLibrary(expression: ts.Expression) {
	const inner = skipOuter(expression);
	return ts.isIdentifier(inner) && LIBRARIES.has(inner.text);
}

/** roblox-ts's macros called as functions, which compile to an operation on what a call returns. */
const MACRO_FUNCTIONS = new Set(["typeIs", "typeOf", "classIs"]);

/** Luau's global functions generated code calls. */
const GLOBAL_FUNCTIONS = new Set([
	"error",
	"typeof",
	"type",
	"select",
	"tostring",
	"tonumber",
	"rawget",
	"rawequal",
	"rawlen",
	"next",
	"pairs",
	"ipairs",
	"print",
	"warn",
]);

/**
 * Whether a name that is not a local is a global, which Luau reads with an import (a library, a
 * global function, a Roblox type such as `Vector3` or `Enum`), rather than an upvalue of the file's.
 */
function isGlobalName(name: string) {
	return LIBRARIES.has(name) || GLOBAL_FUNCTIONS.has(name) || /^[A-Z]/.test(name);
}

/** A string by how it is written: a literal, a template, or a cast to `string`. */
function isStringValue(node: ts.Expression): boolean {
	const cast = castType(node);
	if (cast !== undefined) return cast.kind === ts.SyntaxKind.StringKeyword;
	const expression = skipOuter(node);
	return (
		ts.isStringLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression) ||
		ts.isTemplateExpression(expression)
	);
}

function skipOuter(expression: ts.Expression): ts.Expression {
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		expression = expression.expression;
	}
	return expression;
}

/** A literal roblox-ts compiles to a Luau constant (`nil`, `true`, a number, a string). */
function isPrimitive(expression: ts.Expression) {
	return (
		ts.isStringLiteral(expression) ||
		ts.isNumericLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression) ||
		expression.kind === ts.SyntaxKind.TrueKeyword ||
		expression.kind === ts.SyntaxKind.FalseKeyword ||
		expression.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isIdentifier(expression) && expression.text === "undefined")
	);
}

/** Whether an expression is a boolean by how it is written, which JavaScript's test reads as it is. */
function isBooleanTyped(node: ts.Expression): boolean {
	let expression = node;
	while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
		expression = expression.expression;
	if (
		ts.isAsExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	)
		return expression.type.kind === ts.SyntaxKind.BooleanKeyword;
	if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return true;
	if (ts.isPrefixUnaryExpression(expression)) return expression.operator === ts.SyntaxKind.ExclamationToken;
	// A call is a guard or a test in what Flamework generates.
	if (ts.isCallExpression(expression)) return true;
	if (ts.isBinaryExpression(expression)) {
		switch (expression.operatorToken.kind) {
			case ts.SyntaxKind.EqualsEqualsEqualsToken:
			case ts.SyntaxKind.ExclamationEqualsEqualsToken:
			case ts.SyntaxKind.EqualsEqualsToken:
			case ts.SyntaxKind.ExclamationEqualsToken:
			case ts.SyntaxKind.LessThanToken:
			case ts.SyntaxKind.LessThanEqualsToken:
			case ts.SyntaxKind.GreaterThanToken:
			case ts.SyntaxKind.GreaterThanEqualsToken:
			case ts.SyntaxKind.InstanceOfKeyword:
			case ts.SyntaxKind.InKeyword:
				return true;
			case ts.SyntaxKind.AmpersandAmpersandToken:
			case ts.SyntaxKind.BarBarToken:
				return isBooleanTyped(expression.left) && isBooleanTyped(expression.right);
		}
	}
	return false;
}

function isAssignment(operator: ts.SyntaxKind) {
	return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

function flatten(expression: ts.Expression, operator: ts.SyntaxKind): ts.Expression[] {
	const inner = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
	if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === operator)
		return [...flatten(inner.left, operator), ...flatten(inner.right, operator)];
	return [expression];
}

function lastIndexWithPrereqs(costs: readonly Cost[]) {
	for (let index = costs.length - 1; index >= 0; index--) if (costs[index].prereqs) return index;
	return -1;
}

function namesOf(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : namesOf(element.name)));
}

/** The collections roblox-ts loops over each in its own way (see `Temporaries.loop`). */
type Collection = "array" | "set" | "map";

/** The collection a type written out is. */
function collectionOfType(type: ts.TypeNode | undefined): Collection | undefined {
	if (type === undefined) return undefined;
	if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return "array";
	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
	return collectionNamed(type.typeName.text);
}

/** The collection a type of that name is. */
function collectionNamed(name: string): Collection | undefined {
	switch (name) {
		case "Array":
		case "ReadonlyArray":
			return "array";
		case "Set":
		case "ReadonlySet":
			return "set";
		case "Map":
		case "ReadonlyMap":
			return "map";
	}
	return undefined;
}

/**
 * The collection a value is by how it is written: a cast to one, a new one, an enum's items (a list),
 * or `pairs(...)`, whose pairs roblox-ts loops over as a map's.
 */
function collectionOf(node: ts.Expression): Collection | undefined {
	let expression = node;
	while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
		expression = expression.expression;
	if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression))
		return collectionOfType(expression.type) ?? collectionOf(expression.expression);
	if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression))
		return collectionNamed(expression.expression.text);
	if (ts.isCallExpression(expression)) {
		const callee = expression.expression;
		if (ts.isIdentifier(callee) && callee.text === "pairs") return "map";
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === "GetEnumItems") return "array";
	}
	return undefined;
}

/** A string's or an array's type, written out. */
function isMeasurableType(type: ts.TypeNode | undefined): boolean {
	return (
		type !== undefined &&
		(type.kind === ts.SyntaxKind.StringKeyword || ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type))
	);
}

/** The type the outermost cast of `node` names, if it is a cast (parentheses and `!` aside). */
function castType(node: ts.Expression): ts.TypeNode | undefined {
	let expression = node;
	while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
		expression = expression.expression;
	return ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ? expression.type : undefined;
}

/** A value that is a string or an array by how it is written: a literal of one, or a cast to one. */
function isMeasurableValue(node: ts.Expression): boolean {
	const cast = castType(node);
	if (cast !== undefined) return isMeasurableType(cast);
	let expression = node;
	while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
		expression = expression.expression;
	return (
		ts.isStringLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression) ||
		ts.isTemplateExpression(expression) ||
		ts.isArrayLiteralExpression(expression)
	);
}

/**
 * Replaces each of `replacements`' identifiers, wherever the very node is used in `node`, with a new
 * node of what it maps to. Generated code refers to a local through the node it was declared with,
 * so this moves locals into a table without touching anything that only shares their name.
 */
export function replaceIdentifiers<T extends ts.Node>(
	node: T,
	replacements: ReadonlyMap<ts.Identifier, () => ts.Expression>,
	context: ts.TransformationContext,
): T {
	if (replacements.size === 0) return node;

	const visit = (current: ts.Node): ts.Node => {
		if (ts.isIdentifier(current)) return replacements.get(current)?.() ?? current;
		return ts.visitEachChild(current, visit, context);
	};

	return visit(node) as T;
}

// --- the main chunk's locals ------------------------------------------------------------------------

/**
 * The locals a file's top-level statements declare that the file is sure to keep: a value that is not
 * a constant (a call, a table, a function), a function, a class, an enum. A local holding a literal
 * may be folded into a constant by Luau's compiler and take no register, and roblox-ts adds
 * temporaries of its own, so none of those are counted; imports are counted apart (see
 * {@link sureImportLocals}): this is the least the file declares, which is what lets the build refuse
 * it without ever refusing one that loads.
 */
export function sureMainChunkLocals(statements: readonly ts.Statement[]): number {
	let count = 0;
	for (const statement of statements) count += sureLocalsOf(statement);
	return count;
}

/**
 * The locals roblox-ts declares for a file's own imports, as it decides them: one for each name
 * imported that the file reads as a value (a name only used as a type is dropped), one more for a
 * module more than one such name comes from (`local _core = TS.import(...)`), and whether the file
 * imports anything at run time, which needs the runtime library's `TS` local.
 */
export function sureImportLocals(checker: ts.TypeChecker, file: ts.SourceFile): { locals: number; runtime: boolean } {
	const resolver = checker.getEmitResolver(file);
	const isValue = (declaration: ts.Node, name: ts.Identifier) => {
		if (!resolver.isReferencedAliasDeclaration(declaration)) return false;
		let symbol = checker.getSymbolAtLocation(name);
		if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
		return (
			!symbol || ((symbol.flags & ts.SymbolFlags.Value) !== 0 && (symbol.flags & ts.SymbolFlags.ConstEnum) === 0)
		);
	};

	let locals = 0;
	let runtime = false;
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		if (clause?.isTypeOnly) continue;
		// `import "./module"`: a call of `TS.import` for its effects.
		if (!clause) {
			runtime = true;
			continue;
		}

		let uses = 0;
		if (clause.name && isValue(clause, clause.name)) uses++;
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) uses++;
		else if (bindings) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly && isValue(element, element.name)) uses++;
			}
		}

		if (uses > 0) runtime = true;
		locals += uses > 1 ? uses + 1 : uses;
	}

	return { locals, runtime };
}

/** {@link sureMainChunkLocals} of one statement. */
export function sureLocalsOf(statement: ts.Statement): number {
	const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
	if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return 0;
	const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

	if (ts.isVariableStatement(statement)) {
		const list = statement.declarationList;
		// An exported `let` lives in the module's exports table rather than a local.
		if (exported && (list.flags & ts.NodeFlags.Const) === 0) return 0;

		let count = 0;
		for (const declaration of list.declarations) {
			if (declaration.initializer && isSureValue(declaration.initializer))
				count += bindingNames(declaration.name);
		}
		return count;
	}

	if (ts.isFunctionDeclaration(statement)) return statement.name && statement.body ? 1 : 0;
	if (ts.isClassDeclaration(statement)) return statement.name ? 1 : 0;
	if (ts.isEnumDeclaration(statement)) {
		const isConst = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword) ?? false;
		return isConst ? 0 : 1;
	}

	return 0;
}

const FOLDABLE_LIBRARIES = new Set([
	"math",
	"bit32",
	"string",
	"vector",
	"buffer",
	"type",
	"typeof",
	"tostring",
	"tonumber",
]);

/** Whether an initializer is a value Luau keeps in a register: one no compiler folds into a constant. */
function isSureValue(expression: ts.Expression): boolean {
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		expression = expression.expression;
	}

	// Luau folds a library call on constants (`math.floor(2.5)`) into one, under `--!optimize 2`.
	if (ts.isCallExpression(expression) && expression.arguments.every((argument) => ts.isLiteralExpression(argument))) {
		const callee = expression.expression;
		const library = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
		if (ts.isIdentifier(library) && FOLDABLE_LIBRARIES.has(library.text)) return false;
	}

	return (
		ts.isCallExpression(expression) ||
		ts.isNewExpression(expression) ||
		ts.isObjectLiteralExpression(expression) ||
		ts.isArrayLiteralExpression(expression) ||
		ts.isArrowFunction(expression) ||
		ts.isFunctionExpression(expression) ||
		ts.isClassExpression(expression) ||
		ts.isTaggedTemplateExpression(expression) ||
		ts.isAwaitExpression(expression)
	);
}
