/**
 * Returns a function that builds a value on its first call and returns that value from then on.
 *
 * `build` may yield: a client handler waits for the server's remotes to replicate. A thread that
 * calls while a build is under way waits for it rather than starting a second one, which would wire
 * a second handler to the same remotes. If the build throws, the thread that started it gets the
 * error and the next waiting thread builds again.
 *
 * The build runs on a thread of its own, and the thread that started it waits like the others. A
 * caller can be killed while it waits (`task.cancel`, a cancelled Promise, a test's timeout), and a
 * killed thread never reaches a `finally`: a build killed with its caller would leave every thread
 * queued behind it, and every later caller, waiting for good.
 */
export function createOnce<T extends defined>(): (build: () => T) => T {
	let value: T | undefined;
	let waiting: thread[] | undefined;

	return (build) => {
		while (value === undefined) {
			if (waiting !== undefined) {
				waiting.push(coroutine.running());
				coroutine.yield();
				continue;
			}

			const threads = new Array<thread>();
			waiting = threads;

			// Set by the build's thread, so widened: the checks below must not narrow them to their start.
			let finished = false as boolean;
			let failure = undefined as { reason: unknown } | undefined;
			task.spawn(() => {
				const [ok, result] = pcall(build);
				if (ok) {
					value = result;
				} else {
					failure = { reason: result };
				}

				finished = true;
				waiting = undefined;
				for (const thread of threads) {
					// A waiter killed meanwhile, the starter included, is not resumed.
					if (coroutine.status(thread) === "suspended") task.spawn(thread);
				}
			});

			if (!finished) {
				threads.push(coroutine.running());
				coroutine.yield();
			}

			if (failure) error(failure.reason, 0);
		}

		return value;
	};
}
