# 7. Macros

A macro is a function whose arguments the compiler fills in from the callsite. It is why
`Flamework.id<Shop>()` knows about `Shop` at runtime, and why `registerProviders("src/services")`
knows where that folder ends up in the DataModel.

Understanding this matters for one practical reason: **when a macro does not fire, you get `nil`, not
an error.**

## What you already used

```ts
Flamework.id<Shop>();                     // the type's generated identifier, as a string
Flamework.implements<OnTick>(value);      // does this object implement the interface?
Flamework.createGuard<{ x: number }>();   // a `t` guard generated from the type
Modding.inspect<Array<"a" | "b">>();      // ["a", "b"] at runtime
```

`Modding.inspect` is the general "give me this type as a value" escape hatch:

```ts
Modding.inspect<{ label: "hello"; count: 3 }>(); // { label: "hello", count: 3 }
Modding.inspect<[1, "two", true]>();             // { 1, "two", true }
Modding.inspect<Array<"a" | "b">>();             // { "a", "b" } -- a union becomes an array
```

## Writing your own

Add `@metadata macro` to the JSDoc and make the generated parameters **optional**. Flamework fills
them in at each callsite; the `!` is how you tell TypeScript they will be there.

```ts
import { Modding } from "@flamework/core";

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
| `Uuid` | A string, unique between callsites and identical across compilations of the same source. |

`Uuid` is what `Networking.createEvent` uses to give each network object a distinct name without you
naming it.

`Modding.Caller.Constant<T>` generates its metadata **once per callsite** and shares that one table
between every invocation, which makes it usable as a cache key:

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

The output is plain buffer code: each field is a `buffer.write*` at an offset the transformer
computed, fixed-size types at literal offsets, and the decoder mirrors it. Fields go in declaration
order; counts and lengths are varints; `Serialization.varint` does the same for an integer of your
own. Named types with a variable size are hoisted into `s_`, `w_` and `r_` functions (size, write,
read) ahead of the statement, once per statement, which is also how recursive types work. There is
no runtime library behind it and nothing in the output describes the type. Wrap `deserialize` in
`pcall` for untrusted input. Create serializers at module scope: one built inside a function is
rebuilt on every call. This is also what powers [networking serialization](06-networking.md#serialization),
which lists what each kind of type costs and what travels as a blob.

## When a macro does not fire

This is the failure mode to recognise, because it is silent.

If Flamework does not recognise a parameter's type as a macro type, it generates **no argument**.
The parameter is `nil`, your `!` lied, and you get "attempt to index nil" or "attempt to call a nil
value" somewhere unrelated. Nothing warns at compile time.

Causes, in rough order of likelihood:

1. **The transformer is not configured.** No `rbxts-transformer-flamework` in `tsconfig.json` means
   *no* macro fires -- Flamework's own included.
2. **`@metadata macro` is missing** from the function's JSDoc, or the JSDoc is not directly attached
   to the declaration.
3. **The parameter is not optional.** A required parameter is one the caller is expected to pass.
4. **The type is not a macro type.** A plain `string` parameter is just a string.
5. **A type alias hid the marker.** Macro types are marker intersections; aliasing through something
   that widens or strips the marker loses it.

The quickest diagnosis is to read the emitted Luau. If the call has fewer arguments than you expect,
the macro did not fire.

`Flamework.implements` is worth knowing about here: it is `declare`d, so it has no runtime value of
its own and is rewritten by the transformer into a real call. If its macro does not fire you get
`attempt to call a nil value` on the call itself rather than a `nil` argument.

## Patterns

**A macro is a compile-time constant.** Prefer hoisting `Flamework.id<T>()` into a `const` over
calling it in a loop -- it emits the same string either way, but the intent is clearer.

**Wrap `Modding.Target.Guard` for validation at boundaries.** A one-line `validate<T>` macro is often
nicer than importing `t` and writing the guard out.

**Use `Uuid` for identity you do not want to name.** Anything needing a stable, unique key per
callsite -- caches, network objects, hooks -- can take one instead of asking the caller for a string.

## Caveats

- **Generated parameters must be optional**, and are conventionally last.
- **String arguments to path macros must be literals.** `registerProviders(path)` where `path` is a
  variable fails to compile.
- **A macro does not fire without the transformer**, which is a silent `nil` rather than an error.
- **`Line` and `Character` are numbers**, not strings, despite being callsite "text" information.
- **`Line` is the TypeScript line.** For the line in the emitted Luau -- what the console and
  tracebacks report -- call `debug.info(1, "l")` yourself where you need it.
- **Macros are resolved at each callsite.** A wrapper function around a macro captures *the
  wrapper's* callsite, not its caller's -- if you want the caller's, take the metadata as a parameter
  and pass it through.

---

Previous: [Networking](06-networking.md) · Next: [Plugins](08-plugins.md)
