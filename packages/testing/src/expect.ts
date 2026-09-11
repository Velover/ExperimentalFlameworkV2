/**
 * Assertions. Each raises a plain message, which the runner records as the test's failure; there
 * is no matcher object to learn, and a failure reads as one line.
 */

export function fail(message: string): never {
	throw message;
}

export function expectEqual<T>(actual: T, expected: T, what = "value") {
	if (actual !== expected) {
		fail(`expected ${what} to be ${tostring(expected)}, got ${tostring(actual)}`);
	}
}

export function expectTrue(actual: boolean, what = "condition") {
	if (actual !== true) {
		fail(`expected ${what} to be true`);
	}
}

export function expectFalse(actual: boolean, what = "condition") {
	if (actual !== false) {
		fail(`expected ${what} to be false`);
	}
}

export function expectDefined<T>(actual: T | undefined, what = "value"): T {
	if (actual === undefined) {
		fail(`expected ${what} to be defined`);
	}

	return actual;
}

/**
 * Asserts that `callback` raises. Returns the raised message so callers can assert on it.
 */
export function expectThrows(callback: () => void, what = "callback"): string {
	const [ok, err] = pcall(callback);
	if (ok) {
		fail(`expected ${what} to throw`);
	}

	return tostring(err);
}

export function expectNoThrow(callback: () => void, what = "callback") {
	const [ok, err] = pcall(callback);
	if (!ok) {
		fail(`expected ${what} not to throw, but it raised: ${tostring(err)}`);
	}
}

export function expectArrayEqual<T>(actual: readonly T[], expected: readonly T[], what = "array") {
	if (actual.size() !== expected.size()) {
		fail(`expected ${what} to have ${expected.size()} entries, got ${actual.size()}`);
	}

	for (let i = 0; i < expected.size(); i++) {
		if (actual[i] !== expected[i]) {
			fail(`expected ${what}[${i}] to be ${tostring(expected[i])}, got ${tostring(actual[i])}`);
		}
	}
}

/** Bounds every wait so that a regression fails the test instead of hanging it. */
const SETTLE_TIMEOUT = 5;
const NEVER_SETTLED = "@flamework-experimental/testing: the promise never settled";

/**
 * Waits for `promise` to settle. Awaiting yields, so anything the promise is waiting on -- a
 * deferred remote connection, a `Promise.delay` timeout -- gets a chance to run.
 */
function settle(promise: Promise<unknown>, what: string) {
	const [status, value] = promise.timeout(SETTLE_TIMEOUT, NEVER_SETTLED).awaitStatus();
	if (value === NEVER_SETTLED) {
		fail(`expected ${what} to settle, but it was still pending after ${SETTLE_TIMEOUT} seconds`);
	}

	return { status, value };
}

/** Waits for `promise` to settle and asserts that it resolved, returning its value. */
export function expectResolves<T>(promise: Promise<T>, what = "promise"): T {
	const { status, value } = settle(promise, what);
	if (status !== Promise.Status.Resolved) {
		fail(`expected ${what} to resolve, but it ${string.lower(status)} with ${tostring(value)}`);
	}

	return value as T;
}

/** Waits for `promise` to settle and asserts that it rejected, returning the rejection value. */
export function expectRejects(promise: Promise<unknown>, what = "promise"): unknown {
	const { status, value } = settle(promise, what);
	if (status !== Promise.Status.Rejected) {
		fail(`expected ${what} to reject, but it ${string.lower(status)} with ${tostring(value)}`);
	}

	return value;
}

/**
 * Polls `predicate` every frame until it holds or `timeout` seconds pass, and fails if it never
 * did. For anything the engine delivers later: a deferred signal, a replicated instance, a
 * component built on the next resumption.
 */
export function eventually(predicate: () => boolean, what = "condition", timeout = 5) {
	const deadline = os.clock() + timeout;
	while (os.clock() < deadline) {
		if (predicate()) return;
		task.wait();
	}

	if (!predicate()) {
		fail(`expected ${what} to hold within ${timeout} seconds`);
	}
}
