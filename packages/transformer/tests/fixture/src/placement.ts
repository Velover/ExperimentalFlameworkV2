import { clientFunctions, server, serverFunctions } from "./serialization";

// Regression: the packing was put in front of the whole statement, so a call behind a short-circuit
// or in a conditional branch ran its packing unconditionally (reading `holder.score` while it was
// undefined, and `missing.score` before the narrowing that allows it), a call in a loop condition
// packed once before the loop, and one after a sibling with side effects packed before the sibling ran.
export function conditional(
	player: Player,
	holder: { score?: number },
	scores: number[],
	missing: { score: number } | undefined,
	log: string[],
) {
	holder.score !== undefined && server.pong.fire(player, holder.score);
	const picked = scores.size() > 0 ? server.pong.fire(player, scores[0]) : 0;
	const narrowed = missing !== undefined ? server.pong.fire(player, missing.score) : 0;
	let i = 0;
	do {
		i++;
	} while (i <= 3 && (server.pong.fire(player, i), true));
	const ordered = [log.push("first"), clientFunctions.echo.invoke(`${log.size()}`)];
	return [picked, narrowed, ordered];
}

// Regression: a handler reached through `?.` is typed with `undefined` in it, so the marker was not
// found and the call was left alone, sending raw values the peer dropped. The packing now runs
// behind the same short-circuit; a test on the operand ahead of each `?.` keeps the narrowing the
// chain gave the arguments, and a target that is not a plain reference is tested once it is bound.
export function optional(
	maybe: typeof server | undefined,
	callers: typeof clientFunctions | undefined,
	receivers: typeof serverFunctions | undefined,
	lookup: Map<string, typeof server>,
	player: Player,
) {
	maybe?.pong.fire(player, maybe === undefined ? 0 : 1);
	const echoed = callers?.echo.invoke("hi");
	receivers?.echo.setCallback((_, value) => Promise.resolve(value));
	lookup.get("k")?.pong.fire(player, 2);
	return echoed;
}

// Regression: the target was evaluated after the arguments it must come ahead of, so `pick()` ran
// after `calls` was read.
let calls = 0;
function pick() {
	calls++;
	return server;
}

export function targetFirst(player: Player) {
	pick().pong.fire(player, calls);
	return calls;
}
