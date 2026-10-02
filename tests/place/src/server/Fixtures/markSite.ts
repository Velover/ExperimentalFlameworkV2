/**
 * Records the calling line as the duplicate-id error names a call site, `script:line`, and hands
 * `value` through. Wrapped around a registration's argument, it runs on the line the registration
 * is.
 *
 * In a module of its own: Luau inlines a local function into its callers within a module, and an
 * inlined `mark` reads the frame above its caller (the test runner's, or core's for a plugin's setup)
 * instead of its caller's. A function imported from another module is never inlined.
 */
export function mark<T>(sites: string[], value: T): T {
	const [source, line] = debug.info(2, "sl");
	sites.push(`${source}:${line}`);
	return value;
}
