/**
 * `args` cut after its last value, so that spreading it passes every argument.
 *
 * roblox-ts spreads a list as `unpack(list)`, which stops at `#list`. When the last slot is nil, `#`
 * may stop at any earlier gap: `#{1, nil, nil, 4, nil}` can be 1, which drops the 4. A list that ends
 * in a value always spreads whole. The `{ ... }` that roblox-ts rebuilds from that spread at the next
 * hop also ends in a value, and so does every hop after it that passes the list on. So a list is
 * trimmed where it enters, and again wherever code may build its own: a middleware that names its
 * parameters passes on a list that can end in nil. Nothing is lost by trimming: an argument that was
 * not passed reads as nil too.
 */
export function trimArguments<T extends unknown[]>(args: T): T {
	// `pairs` visits every value, holes or not. Read as a map, the list gives the raw Luau (1-based)
	// index, which is the length up to that value.
	let length = 0;
	for (const [index] of pairs(args as unknown as ReadonlyMap<number, unknown>)) {
		if (index > length) length = index;
	}

	if (args.size() === length) return args;

	// Sized up front, so that the last slot is the last value and `#` is exact.
	const trimmed = table.create<unknown>(length);
	for (let i = 0; i < length; i++) {
		trimmed[i] = args[i];
	}

	return trimmed as T;
}
