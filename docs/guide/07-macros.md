# 7. Macros

A **macro** is a function with some arguments that the transformer fills in when you build, from
the place where the function is called (the **callsite**). Macros are why `Flamework.id<Shop>()`
knows about `Shop` at runtime, and why `registerProviders("src/services")` knows where that folder
ends up in the DataModel.

This matters for one practical reason: **when a macro does not fire, you get `nil`, not an error.**

## What you already used

```ts
Flamework.id<Shop>();                     // the type's generated identifier, as a string
Flamework.implements<OnTick>(value);      // does this object implement the interface?
Flamework.createGuard<{ x: number }>();   // a `t` guard generated from the type
Flamework.env("BUILD_CHANNEL", "dev");    // an environment variable, inlined as a string literal
Modding.inspect<Array<"a" | "b">>();      // ["a", "b"] at runtime
```

`Flamework.env` reads the variable from `.env`, `.env.local` and the process environment when
`rbxtsc` starts (see
[values from the environment](09-project-structure.md#values-from-the-environment)). It replaces
the call with the value, so nothing is looked up at runtime:

```ts
const channel = Flamework.env("BUILD_CHANNEL", "dev");   // string: the fallback is inlined if unset
const tests = Flamework.env("TESTS_ENABLED");            // string | undefined: nil if unset
```

```lua
local channel = "dev"
local tests = "true"
```

The value is always the string as written in `.env`, so compare or convert it yourself. The
fallback has to be a string literal, since it is inlined too. Use `Flamework.env` for deployment
values, such as a place id, a channel or a version. Don't use it for secrets: the value ends up in
the emitted Luau, where anyone with the place can read it.

`Modding.inspect` is the general way to get a type as a value:

```ts
Modding.inspect<{ label: "hello"; count: 3 }>(); // { label: "hello", count: 3 }
Modding.inspect<[1, "two", true]>();             // { 1, "two", true }
Modding.inspect<Array<"a" | "b">>();             // { "a", "b" } -- a union becomes an array
```

## Writing your own

Add `@metadata macro` to the function's JSDoc, and make the generated parameters **optional**.
Flamework fills them in at each callsite. Where you use one, the `!` (as in `guard!` below) tells
TypeScript it will be there.

```ts
import { Modding } from "@flamework-experimental/core";

/** @metadata macro */
export function logHere(message: string, line?: Modding.Caller.Line, text?: Modding.Caller.Text) {
    print(`${line}: ${text} -- ${message}`);
}

logHere("hello");
// 42: logHere("hello") -- hello
```

Ordinary parameters come first, generated ones after. A caller passes only the ordinary ones.

### Callsite information

`Modding.Caller.*` describes where the call is written:

| Type | Is |
|---|---|
| `Line` | The line number in the TypeScript source, from 1. |
| `Character` | The column, from 1. |
| `Width` | The width of the call expression. |
| `Text` | The source text of the call. |
| `Uuid` | A string that is unique to each callsite and the same in every build of the same source. With obfuscation on, it changes with every plain build; a running watcher and an incremental build keep it ([Obfuscation](09-project-structure.md#obfuscation)). |

`Networking.createEvent` uses `Uuid` to give each network object its own name, without you naming
it.

`Modding.Caller.Constant<T>` generates its metadata **once per callsite**, and every call from that
callsite gets the same table. So you can use it as a cache key:

```ts
/** @metadata macro */
function cached<T>(options?: Modding.Caller.Constant<Modding.Emit<{ marker: true }>>) {
    return cache.get(options!) ?? cache.set(options!, expensive()).get(options!);
}
```

### Type information

`Modding.Target.*` describes a type argument:

| Type | Is |
|---|---|
| `Id<T>` | The generated identifier. |
| `Text<T>` | The type rendered as TypeScript would show it. |
| `Guard<T>` | A `t` guard for the type. |
| `Dependency<T>` | The dependency info: id plus any metadata on the type. |
| `Labels<T>` | The parameter names of a tuple. |
| `Hash<T, C>` | A hash of a string literal type, under an optional context. |
| `Obfuscate<T, C>` | The same, but only when obfuscation is enabled. |

```ts
/** @metadata macro */
export function validate<T>(value: unknown, guard?: Modding.Target.Guard<T>): value is T {
    return guard!(value);
}

if (validate<{ x: number }>(payload)) {
    payload.x;
}
```

### Emitting a type as a value

`Modding.Emit<T>` turns a type into runtime data. Objects become tables, tuples become arrays, and
`Array<T>` becomes an array of `T`'s union members.

```ts
/** @metadata macro */
export function keysOf<T>(keys?: Modding.Emit<Array<keyof T>>) {
    return keys!;
}

keysOf<{ a: 1; b: 2 }>(); // { "a", "b" }
```

### Paths

Core has one path macro built in besides `registerProviders`: `requireModules`. It requires every
ModuleScript in a folder, for what the modules do as they load. This is what v1's
`Flamework.addPaths` did for a folder of modules that register themselves with a library, such as
commands:

```ts
import { requireModules } from "@flamework-experimental/core";

requireModules("src/server/commands");
```

```lua
requireModules("src/server/commands", { "ServerScriptService", "TS", "commands" })
```

- It takes the same source paths as `registerProviders`, and works in any module of your game: an
  entry point, a provider's `onStart`.
- It requires the ModuleScripts at and under the folder, in tree order. It returns what they
  export, leaving out the ones that export nothing.
- Each module runs once. Calling it again returns the same exports.
- A folder inside a folder that `registerProviders` registers needs no call: registration already
  requires every ModuleScript under it.
- A folder that is not in the place raises `requireModules("..."): the folder is not in the place`,
  and the message names the part of the path that is missing. The folder gets five seconds to
  appear first, once the place has loaded.
- A folder of the other realm raises at once and says so: a server folder required on a client, or
  a client folder required on the server.

A macro of your own can take a source path too. Give it a parameter typed
`Modding.Intrinsic<"path", [T], string[]>`. That parameter receives the folder the caller's string
literal `T` names, as a Rojo path: an array of instance names from the root of the tree.

To use the path, core exports the functions `registerProviders` and `requireModules` are built on:

- `requireModulesInPath(path)` requires every ModuleScript at and under the path, and returns what
  they export.
- `getClassesInPath(path)` returns the Flamework classes those ModuleScripts define.

This macro finds the command classes in a folder by metadata of your own (see
[custom decorators](10-migrating-from-v1.md#8-custom-decorators)):

```ts
import { getClassesInGlob, getClassesInPath, Modding, Reflect } from "@flamework-experimental/core";

/**
 * The classes under a source folder that carry a command name, by name.
 *
 * @metadata macro
 */
export function commandsIn<T extends string>(_path: T, path?: Modding.Intrinsic<"path", [T], string[]>) {
    const commands = new Map<string, object>();
    for (const ctor of getClassesInPath(path!)) {
        const name = Reflect.getOwnMetadata<string>(ctor, "myGame:command");
        if (name !== undefined) commands.set(name, ctor);
    }
    return commands;
}

commandsIn("src/server/commands");
```

```lua
commandsIn("src/server/commands", { "ServerScriptService", "TS", "commands" })
```

`Modding.Intrinsic<"pathglob", [T], string>` does the same for a glob. The glob is matched against
your source when you build, and the parameter receives the glob string (obfuscated when obfuscation
is on). Pass it to `getGlobPaths(glob)` for the Rojo paths it matched, or to
`getClassesInGlob(glob)` for the classes found under them:

```ts
/**
 * Every Flamework class the modules under the folders a glob matches define.
 *
 * @metadata macro
 */
export function classesIn<T extends string>(_glob: T, glob?: Modding.Intrinsic<"pathglob", [T], string>) {
    return getClassesInGlob(glob!);
}

classesIn("src/*/commands");
```

```lua
classesIn("src/*/commands", "src/*/commands")
```

The rules are the same as for `registerProviders`:

- The argument must be a string literal naming a source path (a file path like `src/...`), not a
  Rojo path.
- A `path` folder must be in your Rojo project. Otherwise you get
  `Could not find Rojo data for '...'`.
- A `path` is resolved in the project that compiles the call, with that project's Rojo file. So a
  path macro called inside a published package (`requireModules`, `registerProviders`, one of your own)
  gets a path in the package's own project, such as `{ "out", "commands" }`. A game's place has no
  such path, so the call fails when it runs. A package without a Rojo project fails to build
  instead, with `No Rojo project file was found`.
- What a glob matched is written to `include/flamework/globs.json`, which only a game project gets.
  So a glob macro called from a published package raises
  `Flamework has no paths for the glob '...'` when it runs.

`Modding.Intrinsic` is marked `@hidden` in core's declarations. That tag is for documentation
generators, and TypeScript ignores it. It is the same type that `registerProviders`,
`ComponentPlugin.fromPath` and a plugin target's `registerProviders` declare.

### Serializers

`Flamework.createSerializer<T>()` generates encode and decode code for `T` at the call site:

```ts
interface Snapshot {
    id: Serialization.u16;
    position: Vector3;
    tags: string[];
    mode: "idle" | "walk";
    owner: Instance; // travels alongside the buffer
}

const snapshots = Flamework.createSerializer<Snapshot>();
const [payload, blobs] = snapshots.serialize(snapshot);
const back = snapshots.deserialize(payload, blobs); // raises on malformed input
```

The output is plain buffer code. Each field is a `buffer.write*` at an offset the transformer
computed, with fixed-size types at literal offsets, and the decoder mirrors it. Fields go in
declaration order. Counts and lengths are varints, and `Serialization.varint` does the same for an
integer of your own. Named types with a variable size are moved out into `s_`, `w_` and `r_`
functions (size, write, read), placed ahead of the statement, once per statement. That is also how
recursive types work. There is no runtime library behind it, and nothing in the output describes the
type.

- Wrap `deserialize` in `pcall` for untrusted input.
- Create serializers at the top level of a file (module scope). One built inside a function is
  rebuilt on every call.

The same generator powers [networking serialization](06-networking.md#serialization), which lists
what each kind of type costs and what travels as a blob.

## When a macro does not fire

Learn to recognise this failure, because it is silent.

If Flamework does not recognise a parameter's type as a macro type, it generates **no argument**.
The parameter is `nil`, your `!` was wrong, and you get "attempt to index nil" or "attempt to call a
nil value" somewhere unrelated. Nothing warns when you build.

Causes, most likely first:

1. **The transformer is not configured.** Without `@flamework-experimental/transformer` in
   `tsconfig.json`, *no* macro fires, Flamework's own included.
2. **`@metadata macro` is missing** from the function's JSDoc, or the JSDoc is not directly attached
   to the declaration.
3. **The parameter is not optional.** A required parameter is one the caller is expected to pass.
4. **The type is not a macro type.** A plain `string` parameter is an ordinary string.
5. **A type alias hid the marker.** Macro types are intersections with a marker. An alias that widens
   the type or strips the marker loses it.

The quickest check is to read the emitted Luau. If the call has fewer arguments than you expect,
the macro did not fire.

`Flamework.implements` fails differently. It is `declare`d, so it has no runtime value of its own:
the transformer rewrites it into a real call. If its macro does not fire, you get
`attempt to call a nil value` on the call itself, not a `nil` argument.

## Patterns

**A macro is a compile-time constant.** Put `Flamework.id<T>()` in a `const` rather than calling it
in a loop. It emits the same string either way, but the intent is clearer.

**Wrap `Modding.Target.Guard` for validation at boundaries.** A one-line `validate<T>` macro is often
simpler than importing `t` and writing the guard out.

**Use `Uuid` when you need an identity but don't want to name it.** Anything that needs a stable,
unique key per callsite (caches, network objects, hooks) can take one instead of asking the caller
for a string.

## Caveats

- **Generated parameters must be optional**, and by convention come last.
- **String arguments to path macros must be literals.** `registerProviders(path)`, where `path` is a
  variable, fails to compile.
- **A macro does not fire without the transformer.** You get a silent `nil`, not an error.
- **`Line` and `Character` are numbers**, not strings, even though they describe the callsite's text.
- **`Line` is the TypeScript line.** For the line in the emitted Luau (what the console and
  tracebacks report), call `debug.info(1, "l")` yourself where you need it.
- **Macros are resolved at each callsite.** A wrapper function around a macro captures *the
  wrapper's* callsite, not its caller's. To get the caller's, take the metadata as a parameter and
  pass it through.

---

Previous: [Networking](06-networking.md) · Next: [Plugins](08-plugins.md)
