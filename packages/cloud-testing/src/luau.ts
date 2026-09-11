/**
 * Rendering of the test shim: turning CLI flags into the Luau literals that
 * `tasks/run-tests.luau` expects in place of `__FILTER__` and `__OPTIONS__`.
 */

export type Filter = string[] | undefined;

export interface ShimOptions {
	/** `--list`: ask the runner to enumerate tests instead of running them. */
	list?: boolean;
}

function isControl(code: number): boolean {
	return code < 0x20 || code === 0x7f;
}

/** Quotes a string as a Luau string literal. */
export function escapeLuauString(value: string): string {
	let out = '"';
	for (const char of value) {
		switch (char) {
			case "\\":
				out += "\\\\";
				break;
			case '"':
				out += '\\"';
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			default: {
				const code = char.codePointAt(0) ?? 0;
				// Luau has no \0 in the middle of a literal without a decimal
				// escape, and raw control bytes in a JSON payload are asking for
				// trouble, so spell them out.
				out += isControl(code) ? `\\${code}` : char;
			}
		}
	}
	return out + '"';
}

/**
 * `undefined`/empty -> `nil` (every section), one name -> a string literal,
 * several -> a table of string literals.
 */
export function renderFilter(filter: Filter): string {
	const names = (filter ?? []).filter((name) => name.length > 0);
	if (names.length === 0) return "nil";
	if (names.length === 1) return escapeLuauString(names[0]!);
	return `{ ${names.map(escapeLuauString).join(", ")} }`;
}

/** `{ list = true }` or `nil`. */
export function renderOptions(options: ShimOptions | undefined): string {
	if (!options) return "nil";
	const entries: string[] = [];
	if (options.list) entries.push("list = true");
	return entries.length === 0 ? "nil" : `{ ${entries.join(", ")} }`;
}

/** Splits a `--sections a,b` value into names. */
export function parseSections(value: string | undefined): Filter {
	if (value === undefined) return undefined;
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	return names.length === 0 ? undefined : names;
}

/** Substitutes the two placeholders in the shim template. */
export function renderShim(template: string, filter: Filter, options?: ShimOptions): string {
	return template.replaceAll("__FILTER__", renderFilter(filter)).replaceAll("__OPTIONS__", renderOptions(options));
}
