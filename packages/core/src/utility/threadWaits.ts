/**
 * Every thread waiting for another to finish something, to the thread it waits for: an extinguish
 * waiting in `awaitExtinguished` for one running on another thread, and an ignition waiting for an
 * `onInit` the lifecycle plugin runs on a thread of its own. Shared by every module, since a chain
 * of waits runs through several: `awaitExtinguished` follows it to refuse the wait that would close
 * a circle.
 *
 * Or to the Promise it waits for: an ignition waiting for the Promise an `onInit` returned, whose
 * work runs on a thread nothing can name -- an `async` method's body runs on one of its own, not the
 * `onInit` thread. A chain that ends at one may end at any thread, the waiting one included.
 *
 * An entry is removed by whatever ends the wait -- what is waited for, as it finishes, or the poll
 * that sees the waiting thread die -- and not by the waiting thread once it resumes: one that is
 * cancelled never resumes.
 */
export const threadWaits = new Map<thread, thread | Promise<unknown>>();

const asyncFunction = async () => {};

/**
 * The scripts a thread doing Promise work starts in: the Promise library, which runs executors and
 * chained callbacks on threads of their own, and the runtime library, which runs an `async`
 * function's body on one of its own.
 */
const promiseSources = new Set([debug.info(Promise.is, "s")[0], debug.info(asyncFunction, "s")[0]]);

/**
 * Whether a thread does Promise work: whether its outermost function -- what it was started with --
 * is the Promise library's or the one an `async` function's body runs in.
 *
 * The lifecycle plugin takes such a thread to be doing the work of the Promise an `onInit` returned
 * while it waits on one, since nothing records which threads that is: an `async` body that has
 * yielded, an executor, a chained callback. An unrelated Promise's thread passes too, and a thread
 * an executor starts itself with `task.spawn` or `task.delay` does not.
 */
export function runsPromiseWork(thread: thread) {
	let outermost: string | undefined;
	let level = 1;
	while (true) {
		const source: string | undefined = debug.info(thread, level, "s")[0];
		if (source === undefined) break;

		// A C function (`pcall`, the scheduler's resume) is not where the thread's work comes from.
		if (source !== "[C]") {
			outermost = source;
		}

		level += 1;
	}

	return outermost !== undefined && promiseSources.has(outermost);
}
