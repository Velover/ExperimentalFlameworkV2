import ts from "typescript";

/**
 * Names that cannot be a local in the code Flamework generates, which roblox-ts compiles as a module
 * in strict mode and then to Luau:
 * - JavaScript's reserved words, strict mode's (`let`, `static`, `yield`, `implements`, ...), `await`
 *   (reserved in modules), and `arguments` and `eval`, which strict mode does not let a binding take;
 * - Luau's keywords, which roblox-ts refuses as identifiers ("Invalid Luau identifier!");
 * - the Luau globals roblox-ts reserves for the code it emits ("Cannot use identifier reserved for
 *   compiler internal usage.").
 */
const UNUSABLE = new Set([
	// JavaScript, reserved
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	// JavaScript, reserved in strict mode and modules, or refused as a binding there
	"await",
	"implements",
	"interface",
	"let",
	"package",
	"private",
	"protected",
	"public",
	"static",
	"yield",
	"arguments",
	"eval",
	// Luau keywords
	"and",
	"elseif",
	"end",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"then",
	"until",
	// Luau globals roblox-ts reserves
	"_G",
	"TS",
	"assert",
	"bit32",
	"coroutine",
	"error",
	"exports",
	"game",
	"getmetatable",
	"ipairs",
	"math",
	"next",
	"pairs",
	"pcall",
	"require",
	"script",
	"select",
	"self",
	"setmetatable",
	"string",
	"table",
	"tostring",
	"type",
	"unpack",
	"utf8",
]);

/** What Luau takes as an identifier, which is narrower than what TypeScript does. */
const LUAU_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a name has to mean globally for a generated local to have to avoid it. */
const GLOBAL_MEANING = ts.SymbolFlags.Value | ts.SymbolFlags.Namespace;

/**
 * A name taken from the project's code (a field, a type) made into one a generated local can have: its
 * characters past what Luau allows as `_`, and `v_` ahead of it when it is still no name a local can
 * take (a reserved word, `arguments`, a Luau keyword, one that starts with a digit, nothing at all) or
 * when it names a global, which a local of that name would hide from the generated code after it.
 *
 * Generated locals are unique names, which the printer renames when the file already uses the name, but
 * a name the file does not use is kept as it is. A field declared in another file (`arguments` in a
 * library's type, say) therefore came out as `const arguments = ...`, which does not compile. A global
 * is declared elsewhere too: a field named after its own datatype -- `readonly CFrame: CFrame` -- would
 * read back as `const CFrame = new CFrame(...)`, which lowers to correct Luau, but the intermediate
 * TypeScript is checked first, and a `const` in its own initializer is an error there. The same goes for
 * a field named `buffer` or `Map`, which the reads that follow it would resolve to instead of the global.
 */
export function localName(typeChecker: ts.TypeChecker, hint: string): string {
	const name = hint.replace(/\W/g, "_");
	if (!LUAU_IDENTIFIER.test(name) || UNUSABLE.has(name)) return `v_${name}`;

	const global = typeChecker.resolveName(name, undefined, GLOBAL_MEANING, false);
	return global !== undefined ? `v_${name}` : name;
}
