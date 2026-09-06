import { Modding } from "@flamework/core";

/** @metadata macro */
export function withEmit(value?: Modding.Caller.Constant<Modding.Emit<{ marker: true }>>) {
	return value!;
}

/** @metadata macro */
export function plain(value?: Modding.Caller.Constant<{ marker: true }>) {
	return value!;
}

// Both forms hoist their table to the file root, so every invocation of one callsite shares it.
// Regression: `Constant<Emit<T>>` carries both markers and the `Emit` one used to be found first,
// which dropped the `Constant` and rebuilt the table on every call.
export function invoke() {
	return [withEmit(), plain()];
}
