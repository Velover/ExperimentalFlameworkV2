import { Signal, createSignal } from "./signal";

export interface SignalContainer<T> {
	fire<K extends keyof T>(name: K, ...args: Parameters<T[K]>): void;
	connect<K extends keyof T>(name: K, callback: T[K]): RBXScriptConnection;
}

export function createSignalContainer<T>(): SignalContainer<T> {
	const signals = new Map<keyof T, Signal>();

	return {
		fire(name, ...args) {
			const signal = signals.get(name);
			if (signal) {
				signal.Fire(...args);
			}
		},

		// The connection is networking's own (see `signal.luau`), shaped like an RBXScriptConnection.
		connect(name, callback) {
			let signal = signals.get(name);
			if (!signal) signals.set(name, (signal = createSignal()));

			return signal.Connect(callback as Callback) as unknown as RBXScriptConnection;
		},
	};
}
