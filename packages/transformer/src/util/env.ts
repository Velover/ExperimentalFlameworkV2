import fs from "fs";
import path from "path";

export type Env = Record<string, string | undefined>;

/** The files read next to `flamework.config.json`, in order; a later file overrides an earlier one. */
export const ENV_FILES = [".env", ".env.local"] as const;

/**
 * Parses a dotenv file: one `KEY=value` per line, an optional `export ` prefix, `#` comments and
 * blank lines. A value in double quotes honours `\n`, `\t`, `\r`, `\\` and `\"`; one in single
 * quotes is taken as written; an unquoted value is trimmed and ends at a ` #` comment.
 */
export function parseEnvFile(text: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}

		const [, key, rest] = match;
		result[key] = parseEnvValue(rest);
	}

	return result;
}

function parseEnvValue(rest: string): string {
	const quote = rest[0];
	if (quote === '"' || quote === "'") {
		let value = "";
		for (let i = 1; i < rest.length; i++) {
			const char = rest[i];
			if (char === quote) {
				return value;
			}

			if (quote === '"' && char === "\\" && i + 1 < rest.length) {
				const next = rest[++i];
				value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
				continue;
			}

			value += char;
		}

		// No closing quote: the rest of the line is the value, quote included, as dotenv does.
		return rest;
	}

	const comment = rest.search(/\s#/);
	return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}

/**
 * The environment a config file is substituted from: `.env`, then `.env.local` on top, both from
 * the given directory, with the process environment on top of both.
 */
export function loadEnv(directory: string, processEnv: Env = process.env): Env {
	const env: Env = {};

	for (const file of ENV_FILES) {
		const envPath = path.join(directory, file);
		if (fs.existsSync(envPath)) {
			Object.assign(env, parseEnvFile(fs.readFileSync(envPath, "utf8")));
		}
	}

	for (const [key, value] of Object.entries(processEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}

	return env;
}

const PLACEHOLDER = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface SubstitutionResult<T> {
	value: T;

	/** The JSON pointers (`/transformer/obfuscation`) of every string that had a placeholder. */
	substituted: Set<string>;
}

/**
 * Replaces `${NAME}` and `${NAME:-fallback}` in every string of a parsed config with the variable's
 * value, and `$$` with a literal dollar. Keys are left alone.
 *
 * A variable that is not set and has no fallback raises, naming the variable and where it was used.
 */
export function substituteEnv<T>(value: T, env: Env, describe: (pointer: string) => string): SubstitutionResult<T> {
	const substituted = new Set<string>();

	const visit = (current: unknown, pointer: string): unknown => {
		if (typeof current === "string") {
			// `replace` with a global pattern starts from the beginning every time; `test` would not.
			let matched = false;
			const replaced = current.replace(PLACEHOLDER, (match, name?: string, fallback?: string) => {
				matched = true;
				if (match === "$$") {
					return "$";
				}

				const found = env[name!];
				if (found !== undefined) {
					return found;
				}

				if (fallback !== undefined) {
					return fallback;
				}

				throw new Error(
					`${describe(pointer)} uses $${name}, which is not set in the environment, .env or .env.local ` +
						`and has no fallback. Set it, or write $\{${name}:-value} to give it one.`,
				);
			});

			if (matched) {
				substituted.add(pointer);
			}

			return replaced;
		}

		if (Array.isArray(current)) {
			return current.map((item, index) => visit(item, `${pointer}/${index}`));
		}

		if (current !== null && typeof current === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(current)) {
				result[key] = visit(item, `${pointer}/${key}`);
			}

			return result;
		}

		return current;
	};

	return { value: visit(value, "") as T, substituted };
}

interface SchemaNode {
	type?: string;
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
}

/**
 * Converts strings sitting where a JSON schema expects a boolean, a number or a list of strings. A
 * value from the environment is always a string, so `"obfuscation": "${OBFUSCATE:-false}"` has to
 * become a boolean before the schema sees it.
 *
 * Booleans accept `true`/`false`/`1`/`0`, case-insensitively. A list splits on commas, trims, and
 * drops empty entries, so an empty string is an empty list. A string that does not parse raises.
 */
export function coerceBySchema<T>(value: T, schema: SchemaNode, describe: (pointer: string) => string): T {
	const visit = (current: unknown, node: SchemaNode | undefined, pointer: string): unknown => {
		if (node === undefined) {
			return current;
		}

		if (typeof current === "string") {
			return coerceString(current, node, () => describe(pointer));
		}

		if (Array.isArray(current)) {
			return current.map((item, index) => visit(item, node.items, `${pointer}/${index}`));
		}

		if (current !== null && typeof current === "object" && node.properties) {
			const result: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(current)) {
				result[key] = visit(item, node.properties[key], `${pointer}/${key}`);
			}

			return result;
		}

		return current;
	};

	return visit(value, schema, "") as T;
}

function coerceString(value: string, node: SchemaNode, where: () => string): unknown {
	switch (node.type) {
		case "boolean": {
			const lowered = value.trim().toLowerCase();
			if (lowered === "true" || lowered === "1") return true;
			if (lowered === "false" || lowered === "0") return false;
			throw new Error(`${where()} is "${value}", which is not a boolean (true, false, 1 or 0).`);
		}

		case "number":
		case "integer": {
			const parsed = Number(value.trim());
			if (value.trim() === "" || Number.isNaN(parsed)) {
				throw new Error(`${where()} is "${value}", which is not a number.`);
			}

			return parsed;
		}

		case "array": {
			if (node.items?.type !== "string") {
				return value;
			}

			return value
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "");
		}

		default:
			return value;
	}
}
