import { Modding, Reflect } from "@flamework-experimental/core";

export type Constructor<T = object> = new (...args: never[]) => T;
export type AbstractConstructor<T = object> = abstract new (...args: never[]) => T;

export type ConstructorRef<T> = Constructor<T> | Modding.Target.Id<T> | string;
export type AbstractConstructorRef<T> = AbstractConstructor<T> | Modding.Target.Id<T> | string;

export function isConstructor(obj: object): obj is Constructor {
	return "constructor" in obj && "new" in obj;
}

export function getParentConstructor(ctor: AbstractConstructor) {
	const metatable = getmetatable(ctor) as { __index?: object };
	if (metatable && typeIs(metatable, "table")) {
		const parentConstructor = rawget(metatable, "__index") as AbstractConstructor;
		return parentConstructor;
	}
}

type Describe = (a: unknown, b: unknown, c: unknown) => unknown[];
type Run = (a: unknown, b: unknown, c: unknown) => void;

/** A thread parked with nothing to run, kept for the next `safeCall`. */
let idleThread: thread | undefined;

/**
 * What a raise is reported with, taken where it was raised: a string with the traceback appended to
 * it, or anything else alongside the traceback.
 */
function captureWithStack(err: unknown): unknown {
	if (typeIs(err, "string")) return debug.traceback(err, 2);

	return [err, debug.traceback(undefined, 2)];
}

function captureWithoutStack(err: unknown): unknown {
	return err;
}

/**
 * Runs `func` and reports a raise from it. The message is described only then, from the same
 * arguments: most calls never raise, and a message built for each -- a full name read off the
 * instance, the strings around it -- is thrown away unread.
 */
function runSafely(describe: Describe, func: Run, printStack: boolean, a: unknown, b: unknown, c: unknown) {
	const [ok, caught] = xpcall(func, printStack ? captureWithStack : captureWithoutStack, a, b, c);
	if (ok) return;

	warn(...describe(a, b, c));
	if (printStack && !typeIs(caught, "string")) {
		const [err, stack] = caught as [unknown, string];
		warn(err);
		warn(stack);
	} else {
		warn(caught);
	}
}

function reusableThread(describe: Describe, func: Run, printStack: boolean, a: unknown, b: unknown, c: unknown) {
	const thread = coroutine.running();

	while (true) {
		if (idleThread === thread) {
			idleThread = undefined;
		}

		runSafely(describe, func, printStack, a, b, c);

		// Another thread is already parked: this one ends rather than making two.
		if (idleThread !== undefined) {
			break;
		}

		idleThread = thread;

		// Let go of what it ran while it is parked -- a component, an instance -- which this thread
		// would otherwise keep reachable until the next call comes through, and for good when none does.
		describe = undefined!;
		func = undefined!;
		a = undefined;
		b = undefined;
		c = undefined;
		[describe, func, printStack, a, b, c] = coroutine.yield() as LuaTuple<
			[Describe, Run, boolean, unknown, unknown, unknown]
		>;
	}
}

/**
 * Runs `func` with the arguments given on a thread of its own, so that one that yields holds up
 * nothing and one that raises is reported, with `describe`'s message, rather than raised. The thread
 * is kept for the next call once `func` returns, and one that yields keeps its thread while the next
 * call gets another; the arguments are passed through rather than closed over, so that a call
 * creates nothing of its own.
 */
export function safeCall<A>(describe: (a: A) => unknown[], func: (a: A) => void, printStack: boolean, a: A): void;
export function safeCall<A, B, C>(
	describe: (a: A, b: B, c: C) => unknown[],
	func: (a: A, b: B, c: C) => void,
	printStack: boolean,
	a: A,
	b: B,
	c: C,
): void;
export function safeCall(describe: Describe, func: Run, printStack: boolean, a: unknown, b?: unknown, c?: unknown) {
	// Reused only while it is still parked. What it ran can keep hold of it -- `coroutine.running()`
	// in an `onStart` -- and cancel it afterwards, from `destroy` say, which leaves it dead: resuming
	// it raises, for this call and every one after.
	if (idleThread !== undefined && coroutine.status(idleThread) !== "suspended") {
		idleThread = undefined;
	}

	if (idleThread !== undefined) {
		task.spawn(idleThread, describe, func, printStack, a, b, c);
	} else {
		task.spawn(reusableThread, describe, func, printStack, a, b, c);
	}
}

export function getIdFromSpecifier<T extends AbstractConstructor>(componentSpecifier?: T | string) {
	if (componentSpecifier !== undefined) {
		return typeIs(componentSpecifier, "string")
			? componentSpecifier
			: Reflect.getMetadata<string>(componentSpecifier, "identifier");
	}
}
