/**
 * Connects to a remote's delivery signal and records how many arguments each message carried, as
 * `select("#", ...)` counts them: a trailing nil included, a missing argument not. `first` is the
 * first of them. `fromPlayer` for `OnServerEvent`, whose first argument is the sender rather than
 * something on the wire.
 */
export declare function countWire(
	signal: RBXScriptSignal,
	fromPlayer: boolean,
	record: (count: number, first: unknown) => void,
): RBXScriptConnection;
