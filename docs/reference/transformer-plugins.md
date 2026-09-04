# Transformer plugins

A plugin lets you add your own **macro types** to Flamework's transformer: you receive a reflected
view of a TypeScript type at compile time and return an expression that is inlined at the call site.

Plugins are ordinary CommonJS modules loaded into the compiler process. They are build-time code the
project already trusts, exactly like the transformer itself — the `Type` and `Node` facades exist to
give you an API that survives TypeScript upgrades, not to sandbox you.

## Setup

Install the plugin module as a dev dependency and list your plugin in the transformer options:

```json
{
	"compilerOptions": {
		"plugins": [
			{
				"transform": "rbxts-transformer-flamework",
				"plugins": [{ "path": "./myPlugin.cjs", "options": { "prefix": "fx" } }]
			}
		]
	}
}
```

Each entry is either a bare string (a module specifier or a path relative to the project root) or an
object with `path` and `options`. Paths starting with `.` resolve from the project root; anything
else is resolved as a package.

## Writing a plugin

```js
// myPlugin.cjs
const { registerPlugin } = require("rbxts-transformer-flamework-plugin");

registerPlugin((api) => {
	const expr = api.factory.expr;
	const prefix = api.options.prefix ?? "";

	api.registerMacroType("fieldInfo", (type, context) => {
		if (!type.isObjectLike()) {
			context.error("fieldInfo requires an object type");
		}

		return expr.array(
			type.getFields().map((field) =>
				expr.object({
					name: expr.string(prefix + field.name),
					optional: expr.bool(field.optional),
					readonly: expr.bool(field.readonly),
				}),
			),
		);
	});
});
```

## Exposing it to TypeScript

Declare a user macro whose metadata parameter uses the `plugin` intrinsic. The tuple is
`[macroTypeId, TypeToReflect]`, and the third type argument is what the macro returns:

```ts
import { Modding } from "@flamework/core";

interface FieldInfo {
	name: string;
	optional: boolean;
	readonly: boolean;
}

/** @metadata macro */
export function fieldInfo<T>(meta?: Modding.Intrinsic<"plugin", ["fieldInfo", T], FieldInfo[]>): FieldInfo[] {
	return meta!;
}
```

Call it like any other macro:

```ts
interface PlayerSave {
	coins: number;
	readonly userId: number;
	nickname?: string;
}

const fields = fieldInfo<PlayerSave>();
```

which emits:

```lua
local fieldInfo_1 = {
	{ name = "fxcoins",    optional = false, readonly = false },
	{ name = "fxuserId",   optional = false, readonly = true  },
	{ name = "fxnickname", optional = true,  readonly = false },
}
local fields = fieldInfo(fieldInfo_1)
```

## Caching

Results are cached per file and keyed by (macro type, reflected type). A result that is not
trivially duplicable — anything other than a literal or an identifier — is hoisted into a file-level
constant that every call site shares, so using the same macro at twenty call sites emits one table.

`context.hoist(expression, name?)` does the same thing explicitly and returns the identifier;
`context.hoistStatement(statement)` lifts a statement to the top of the file.

## Diagnostics

`context.error(message)` and `context.warning(message)` report against the macro's call site, so
users get a real TypeScript diagnostic with a source span rather than a stack trace.

## API surface

| | |
|---|---|
| `api.factory.expr` | `string`, `number`, `bool`, `nil`, `identifier`, `array`, `object`, `call`, `new`, `property`, `element`, `binary`, `not`, `conditional`, `arrow`, `parenthesize` |
| `api.factory.stmt` | `variable`, `expression`, `return`, `block`, `if` |
| `api.options` | the `options` object from tsconfig |
| `Type` | `isSubtypeOf`, `isSupertypeOf`, `isEquivalentTo`, `isUnion`, `isIntersection`, `isObjectLike`, `isArray`, `isTuple`, `isLiteral(kind?)`, `isPrimitive`, `isOptional`, `getNonNullable`, `getName`, `toString` |
| `ObjectLikeType` | `getFields`, `getIndexSignatures`, `getCallSignatures`, `getConstructSignatures` |
| `ArrayType` / `TupleArrayType` | `getElementType`, `isReadonly`, `getElements` |
| `UnionOrIntersectionType` | `getConstituents` |
| `LiteralType` | `getLiteralValue` |

## Constraints

- **Plugins must be CommonJS.** They are loaded with `require` during transformer setup, which is
  synchronous; an ESM plugin cannot be loaded from that point.
- **A macro type must return an expression.** The `plugin` intrinsic is used in expression position.
  Use `context.hoistStatement` if you need to emit statements alongside it.
- **Macro type IDs are global.** Registering an ID that another loaded plugin already registered is
  an error rather than a silent override.

A complete worked example lives in
[`packages/transformer/tests/fixture/fieldInfoPlugin.cjs`](../../packages/transformer/tests/fixture/fieldInfoPlugin.cjs),
which is also the fixture the plugin test suite asserts against.
