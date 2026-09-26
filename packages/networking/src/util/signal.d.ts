/**
 * A handler's connection. Shaped like an `RBXScriptConnection` (`Connected`, `Disconnect`), plus
 * `Destroy` for maids and janitors; it is a table, not an engine connection.
 */
export interface SignalConnection {
	readonly Connected: boolean;
	Disconnect(): void;
	Destroy(): void;
}

/**
 * Networking's own signal (see `signal.luau`): arguments are passed by reference, each handler runs
 * on a recycled thread of its own, newest connection first.
 */
export interface Signal<T extends Callback = Callback> {
	Connect(callback: T): SignalConnection;
	Fire(...args: Parameters<T>): void;
}

export function createSignal<T extends Callback = Callback>(): Signal<T>;

/**
 * Runs `callback(...args)` at once on a recycled thread: a yield inside it does not hold up the
 * caller, and an error is printed rather than raised to it.
 */
export function spawn<A extends unknown[]>(callback: (...args: A) => unknown, ...args: A): void;
