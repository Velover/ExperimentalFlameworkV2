let inactiveThread: thread | undefined;

type Runnable = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown) => void;

function reusableThread(func: Runnable, a: unknown, b: unknown, c: unknown, d: unknown, e: unknown) {
	const thread = coroutine.running();

	while (true) {
		if (inactiveThread === thread) {
			inactiveThread = undefined;
		}

		func(a, b, c, d, e);

		// If there's a different idle thread, we should end the current thread.
		if (inactiveThread !== undefined) {
			break;
		}

		inactiveThread = thread;

		// Let go of the callback and its arguments while idle: they are whatever it was run for -- a
		// lifecycle listener, a component -- which would otherwise stay reachable from this thread
		// until the next callback comes through, and for good when none does.
		func = undefined!;
		a = undefined;
		b = undefined;
		c = undefined;
		d = undefined;
		e = undefined;
		[func, a, b, c, d, e] = coroutine.yield() as LuaTuple<[Runnable, unknown, unknown, unknown, unknown, unknown]>;
	}
}

/**
 * Runs `func` with the arguments given, on a thread that is kept for the next call once it returns:
 * one that yields keeps its thread, and the next call gets a new one.
 *
 * The arguments are passed through rather than closed over, so that a caller running many callbacks
 * -- the per-frame events, once per listener every frame -- creates nothing per call.
 */
export function recycleThread(func: () => void): void;
export function recycleThread<A>(func: (a: A) => void, a: A): void;
export function recycleThread<A, B>(func: (a: A, b: B) => void, a: A, b: B): void;
export function recycleThread<A, B, C>(func: (a: A, b: B, c: C) => void, a: A, b: B, c: C): void;
export function recycleThread<A, B, C, D>(func: (a: A, b: B, c: C, d: D) => void, a: A, b: B, c: C, d: D): void;
export function recycleThread<A, B, C, D, E>(
	func: (a: A, b: B, c: C, d: D, e: E) => void,
	a: A,
	b: B,
	c: C,
	d: D,
	e: E,
): void;
export function recycleThread(func: Runnable, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown) {
	// Only while it is parked: a callback that kept `coroutine.running()` and cancelled it later left
	// a dead thread here, and every later call, of every module, raised trying to resume it. One that
	// is not is dropped, and a new thread takes its place.
	const idle = inactiveThread;
	if (idle !== undefined && coroutine.status(idle) === "suspended") {
		task.spawn(idle, func, a, b, c, d, e);
	} else {
		inactiveThread = undefined;
		task.spawn(reusableThread, func, a, b, c, d, e);
	}
}
