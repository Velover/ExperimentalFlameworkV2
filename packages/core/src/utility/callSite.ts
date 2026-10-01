/**
 * What every frame of one of core's own modules starts with: this module's source up to
 * `utility/callSite`, which is the folder the whole package is built into -- `....core.out.` in a
 * place, a file path under a harness. Read once, from this module's own frame, so it follows the
 * package wherever a game maps it. Nothing when the source does not end the way it is built to.
 */
const CORE_SOURCE = (() => {
	const [source] = debug.info(1, "s") as LuaTuple<[string | undefined]>;
	if (source === undefined) return undefined;

	const [start] = source.find("utility.callSite");
	return start !== undefined && start > 1 ? source.sub(1, start - 1) : undefined;
})();

/** Far enough for any registration: the walk ends at the first frame that is not core's. */
const MAX_DEPTH = 64;

function isCoreSource(source: string) {
	return CORE_SOURCE !== undefined && source.sub(1, CORE_SOURCE.size()) === CORE_SOURCE;
}

/** A chunk loaded from a string names itself `[string "name"]`; a script is named by its full name. */
function displaySource(source: string) {
	const [inner] = source.match('^%[string "(.*)"%]$');
	return typeIs(inner, "string") ? inner : source;
}

/**
 * The line that called into core, as `script:line`: the first frame on this thread, from the
 * caller up, that is neither one of core's own modules nor a C function (`pcall`). However many of
 * core's frames sit in between -- a folder registration, `apply`, a plugin included by a plugin --
 * this is the user's line, not core's.
 *
 * Nothing when core cannot tell its own frames apart, or when no such frame is found.
 */
export function findCallSite(): string | undefined {
	if (CORE_SOURCE === undefined) return undefined;

	for (let level = 2; level <= MAX_DEPTH; level++) {
		const [source, line] = debug.info(level, "sl") as LuaTuple<[string | undefined, number | undefined]>;
		if (source === undefined || line === undefined) return undefined;

		if (line >= 0 && !isCoreSource(source)) {
			return `${displaySource(source)}:${line}`;
		}
	}
}

/**
 * Whether a function is defined in one of core's own modules, as the lifecycle plugin's setup is.
 * What core registers itself has no line of the user's to name: the walk from it would pass the
 * ignition and land on whatever called it.
 */
export function isCoreFunction(callback: Callback) {
	const [source] = debug.info(callback, "s") as LuaTuple<[string | undefined]>;
	return source !== undefined && isCoreSource(source);
}
