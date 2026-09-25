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
