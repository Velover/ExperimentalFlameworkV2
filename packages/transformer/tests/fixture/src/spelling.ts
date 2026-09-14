import { client } from "./serialization";

// Regression: an anonymous union was numbered by the first spelling a file happened to meet, so the
// receiver (walking the events in declaration order) numbered both `sortA` and `sortB` as `sortA`
// spells it, and the sender (in another file, transforming call sites in source order) numbered both
// as `sortB` does. Every message on both events was dropped or decoded as something else.
export function sendB(value: number | string) {
	client.sortB.fire(value);
}

export function sendA(value: string | number) {
	client.sortA.fire(value);
}
