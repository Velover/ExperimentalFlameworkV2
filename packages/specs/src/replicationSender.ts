import { GlobalEvents } from "./replication";

/**
 * The sending half of the union-order regression, kept out of `replication.ts` on purpose: the bug
 * was that a file numbered an anonymous union by the first spelling it met, so a sender in one file
 * and a receiver in another -- the ordinary client/server split -- disagreed on the wire. This file
 * meets `sortB` first, the receiver meets `sortA` first.
 */
export function fireSorted() {
	const events = GlobalEvents.createClient({});
	events.sortB.fire("b");
	events.sortA.fire(7);
	events.sortB.fire(3);
	events.sortA.fire("a");
}
