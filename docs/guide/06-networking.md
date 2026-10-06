# 6. Networking

You declare two interfaces: one for what the server receives and one for what the client receives.
From them, Flamework generates the remotes, the **guards** that check incoming arguments, and the
typed handlers.

```sh
npm install @flamework-experimental/networking
```

A Rojo project that maps the whole `node_modules/@flamework-experimental` folder in one line, as in
[Getting started › Rojo](01-getting-started.md#rojo), takes it in with nothing to add; one that maps
the packages by name needs a `networking` entry next to `core`.

## Declaring a network

Put this in shared code, so both realms import the same object.

```ts
// src/shared/network.ts
import { Networking } from "@flamework-experimental/networking";

interface ServerEvents {
    setReady(ready: boolean): void;
}

interface ClientEvents {
    matchStarted(map: string): void;
}

export const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();
```

The first type parameter is what the **server receives**. The second is what the **client
receives**. The rest follows from that: the server can `connect` to `ServerEvents` and `fire`
`ClientEvents`, and the client does the opposite.

## Using it

```ts
// server
const events = GlobalEvents.createServer({});

events.setReady.connect((player, ready) => print(player, ready));
events.matchStarted.fire(player, "Sandbox");
```

```ts
// client
const events = GlobalEvents.createClient({});

events.matchStarted.connect((map) => print(map));
events.setReady.fire(true);
```

Call `createServer` on the server and `createClient` on the client. Calling the wrong one **returns
nothing** instead of raising an error. A stray `createServer()` on the client gives you a `nil` that
you trip over later.

Once a message has passed the guards and middleware, each handler passed to `connect` runs at once,
on a thread of its own. The newest connection runs first. A handler that yields holds up nothing,
and a handler that raises has its error printed while the others still run. Every handler gets the
same argument values, not copies, so a decoded `Map` or `Set` arrives intact.

`connect` returns a `Networking.Connection`, with `Connected`, `Disconnect()` and `Destroy()` (for
maids and janitors). It is networking's own type, not an engine `RBXScriptConnection`.

### Where to create the handlers

Create each realm's handlers once, in a `network.ts` of that realm, and import them where they are
used. The first `createServer` or `createClient` call wins: later calls return the same handler and
ignore their config, middleware included. A second call in some provider would drop its middleware
without a word.

```ts
// src/server/network.ts
import { GlobalEvents, GlobalFunctions } from "shared/network";
import { throttle } from "./middleware/throttle";

export const Events = GlobalEvents.createServer({
    middleware: { setReady: [throttle(1)] },
});
export const Functions = GlobalFunctions.createServer({});
```

```ts
// src/client/network.ts
import { GlobalEvents, GlobalFunctions } from "shared/network";

export const Events = GlobalEvents.createClient({});
export const Functions = GlobalFunctions.createClient({});
```

Providers import the realm's file and connect in `onStart`:

```ts
import { Events } from "server/network";

@Provider()
export class MatchService implements OnStart {
    public onStart() {
        Events.setReady.connect((player, ready) => this.setReady(player, ready));
    }
}
```

Each realm's `createServer` or `createClient` call then sits in that realm's own file, where the
wrong one (which returns nothing) stands out. `throttle` is the middleware from
[Middleware](#middleware).

### Sending

| Method | Realm | Sends to |
|---|---|---|
| `fire(player, ...)` | server | One player. |
| `fire([a, b], ...)` | server | Each player in the list. |
| `broadcast(...)` | server | Everyone. |
| `except(player, ...)` | server | Everyone but that player (or list). |
| `fire(...)` | client | The server. |

`predict(...)` runs the *receiving* side locally, guards and middleware included, without using a
remote. It is meant for client prediction. It is also the easiest way to test a handler: by the time
`predict` returns, the handlers have been called, unless a middleware yields.

In a test, if the handler answers with `fire(player, ...)`, call `predict` with a stand-in instead
of a real player. The engine queues a message fired at a client that has not connected yet, and
delivers it once the client connects. The reply would then show up later, in that client's own
tests. See [both realms in one session](12-testing.md#both-realms-in-one-session).

## Functions

Same idea, but the call returns a value.

```ts
interface ServerFunctions {
    buy(itemId: string): boolean;
}

export const GlobalFunctions = Networking.createFunction<ServerFunctions, {}>();
```

```ts
// server
GlobalFunctions.createServer({}).buy.setCallback((player, itemId) => shop.buy(player, itemId));

// client
const bought = await GlobalFunctions.createClient({}).buy.invoke("sword");
```

`invoke` returns a Promise. It times out after `defaultTimeout` seconds: **30 on the client, 10 on
the server**. `invokeWithTimeout(timeout, ...)` sets a different timeout for one call.

A rejection is always a `NetworkingFunctionError`:

| Value | Means |
|---|---|
| `Timeout` | No response in time. |
| `Cancelled` | Middleware returned `Networking.Skip`, the callback or a middleware returned a promise that was cancelled, or the player left. |
| `BadRequest` | The arguments failed the generated guards. |
| `Unprocessed` | The other realm has not called `setCallback`. |
| `InvalidResult` | The response failed the return type's guard. |

```ts
GlobalFunctions.createClient({})
    .buy.invoke("sword")
    .catch((reason: unknown) => {
        if (reason === NetworkingFunctionError.Timeout) warn("server did not answer");
    });
```

Return values are checked too. When a callback returns the wrong type, the value is not delivered:
the caller's Promise rejects with `InvalidResult`.

## Namespaces

Nest an object to group events. Each gets its own remote, named after the path:

```ts
interface ServerEvents {
    stats: {
        report(value: number): void;
    };
}

events.stats.report.connect((player, value) => {});
```

Middleware nests the same way.

## Unreliable events

```ts
interface ClientEvents {
    position: Networking.Unreliable<(position: Vector3) => void>;
}
```

These use an `UnreliableRemoteEvent`, on a channel of their own. Their messages may be dropped or
arrive out of order, so send **state, not deltas**: a position, not "moved by 3 studs".

## Configuration

```ts
const events = GlobalEvents.createServer({
    disableIncomingGuards: false,
    warnOnInvalidGuards: true,
    middleware: {
        setReady: [rateLimit(5)],
    },
});
```

| Option | Default | Effect |
|---|---|---|
| `disableIncomingGuards` | `false` | Skips generated argument validation entirely. |
| `warnOnInvalidGuards` | `RunService.IsStudio()` | Warns when a guard rejects something. |
| `middleware` | `{}` | Per-event middleware. |
| `defaultTimeout` | 30 client / 10 server | Functions only. |

**The config object must be written inline.** The transformer reads it when you build, so passing a
variable gives `Flamework expected this argument to be a literal expression`. The same goes for the
`middleware` object.

## Serialization

With `"networking": { "serialization": true }` in `flamework.config.json`, every event argument list,
and every function request and result, is packed into a `buffer` before it is sent and unpacked when
it arrives. The code that does it is plain buffer code, generated from the declared types. Nothing
about the API changes, and the guards still run on the decoded values.

The switch covers every member. A member can opt in or out on its own: see
[Opting in and out per event](#opting-in-and-out-per-event).

The encoding is generated **at each call site**. For example, `Events.X.fire(value, where)` compiles
to `buffer.create(20)`, four writes at literal offsets and `Events.X._fire(payload)`, right where the
call was. A function callback is registered with a generated packer for its result type. The packer
runs after the middleware, so the result is sent packed.

That code sits among the caller's own declarations. A local that hides a global it uses is fine for
`buffer` (say, `for (const [player, buffer, blobs] of updates)`): the code then reaches the global
through an alias at the top of the file. So is a send inside `catch (error)` or `catch (math)`,
the only places those two can be hidden, since roblox-ts refuses a local or a parameter with either
name: `math` goes through an alias too, and `error` is raised as `assert(false, message)`, which
gives the same message from the same line (inside a `catch (assert)` nested in it, `error` takes an
alias as well, one more local at the top of the file). A type the code names (`Map`, `defined`,
`buffer` and the like) is reached through `globalThis` where a declaration of yours hides it, so
`type Map<K, V> = globalThis.Map<K, V>` is fine as well. The guards `createServer` and
`createClient` build for incoming arguments still name such a type plainly, so a different `Map`
type of your own in the module that calls them can break the build there, as it always could.

Four things are build errors that name the global and the declaration, and ask you to rename the
declaration:

- hiding any other global the code needs at the call site: `typeIs` and the constructors of
  `Array`, `Map` and `Set` (which roblox-ts only knows by their own names), `Enum` and the like;
- declaring `buffer` at the top of the module itself, where no alias can help;
- declaring `warn` there in a file whose width checks warn, since their helper calls it from the top
  of the file (a local `warn` is fine);
- hiding `globalThis` itself, through which those types are reached.

What roblox-ts emits by itself is another matter, packed or not: inside `catch (table)` or
`catch (type)`, its own `table.insert` and `type(...)` reach the caught value.
Fields and types may have any name, `arguments`, `class`, `end` or `1st` included. A local the
code names after one that no local can have is named `v_arguments` instead.

Apart from those result packers and the code inlined at each call site, no function in the output
encodes an event's or a request's argument list. A file's shared `codec` table does keep a writer for each named or repeated type the
file reaches (`codec.w_Item`), even in a file that only decodes, and each writes one value into a
buffer it is given. The format follows from the types, so a payload can be forged; the decoder and
the guards are what check it.

Decoding is generated once per event and function, into the `createServer` / `createClient`
metadata, because a payload has to be unpacked before the guards and middleware see it. Nothing in
the output describes the type: there is no schema table and no runtime library.

The transformer finds call sites by their type. Send and register callbacks through the handler's
own type: `Events.X.fire(...)`, a typed reference to `Events.X`, or a helper generic over the event
name. Such a helper must not return members that are packed differently, such as a `Serialized`
member and a plain one while `networking.serialization` is off, or a `Raw` member and a packed one:
a call through it is packed one way, so the build refuses it. It refuses packed members whose
argument lists (for `setCallback`, results) are not laid out and checked alike, for the same
reason: even one TypeScript type spelled two ways, `a(x: string | number)` and
`b(x: number | string)` (see [What each type costs](#what-each-type-costs)), or a
`Serialization.u8` against a `Serialization.Implicit.u8`, one byte either way but by default
checked only as the second. Members laid out and checked alike are packed together, whatever
their types.
Don't go through a hand-written interface that widens
`fire` to `(...args: unknown[])`. Such a call is left alone and sends unpacked values, which the peer drops as malformed. A handler reached
through `?.` (`this.events?.X.fire(...)`) is packed like any other, behind the same short-circuit.
`predict` takes plain values and needs no typing, and `connect` is left as it is.

The same generator is available on its own as `Flamework.createSerializer<T>()`; see
[Macros](07-macros.md#serializers).

### What each type costs

Sizes follow the types:

- A `number` is eight bytes. A `boolean` is one byte, and so is an `"idle" | "walk" | "run"`: the
  value's place among the union's values sorted. `false`, `true`, `""` and `0` come first, then the
  names `typeof` returns (`"string"`, `"number"`, `"bigint"`, `"boolean"`, `"symbol"`,
  `"undefined"`, `"object"`, `"function"`, in that order), then the other numbers by size, each
  before its negative (`1`, `-1`, `2`), then strings by their character codes: in
  `"number" | "string"`, `"string"` is 0. A TypeScript `enum`'s members, all of them or some, keep
  the order the enum declares them in, after any plain values in the same union; the members of
  several enums go by the enum's name. Roblox enum items go last, by name.
- An object is its fields in declaration order, with nothing spent on names. A mapped type over
  another type's fields, such as `Partial<T>`, `Readonly<T>` or `{ readonly [P in keyof T]?: ... }`,
  keeps `T`'s order, and a `Record` over a TypeScript enum the order the enum declares its members
  in. A mapped type over other keys (`Record<"speed" | "power", number>`, `Pick`, `Omit`) sends its
  fields in the order of its keys, sorted as a literal union's values are: `power`, then `speed`.
- A `Vector3` is three floats.
- Counts and lengths (of arrays, sets, maps, strings and buffers) are varints: one byte below 128,
  two below 16384, up to five.

To pick a number's width, use a brand. `Serialization.u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `f32`,
`f64` and `varint` from `@flamework-experimental/core` are `number & { __brand: "u8" }`-style types.
Any brand with one of those literal names counts, so branded types you already have keep working.
`Serialization.string8` / `string16` / `string32` (and `buffer16` / `buffer32`) give a string or
buffer a fixed-width length instead.

A brand is a cast: `7 as Serialization.u16`. By default nothing checks a cast value, so a number
that does not fit its width wraps when it is written: 70000 sent as a `u16` arrives as 4464, -1 as
65535, and 2.7 as 2. For values you would rather not cast, use the implicit widths below.

Each union value carries a one-byte tag: its member's position as written. In
`{ Coins: number } | { Items: string[] }`, Coins is 0 and Items is 1. In `number | string`, the
number is 0. A union with `number` has one more tag, after its members, for a whole number from 0
up to 2^35 - 1, which is then sent as a varint. So in `number | string`, 3 is the tag 2 and one
byte, and 2.5 is the tag 0 and eight bytes. Array indices sent as `string | number` map keys stay
small that way. A `number` that is not in a union is always eight bytes.

"As written" means at the declaration the value is reached through: the parameter, property, return
type or tuple element, including inside arrays, sets, maps and Promises. So `a(x: string | number)`
and `b(x: number | string)` number their members differently, even though they are one TypeScript
type. Both sides agree, because both read the same declaration. A union written as a member of
another (`type Choice = Pair | Gamma`, or in parentheses) keeps its own written order there, but
its built-in types, `boolean`, and its literal values `false`, `true`, `""`, `0` and the names
`typeof` returns go first, in TypeScript's fixed order given below, whatever order it writes them
in: with `type Id = number | string`, `Id | Alpha` numbers the string 0 and the number 1, and with
`type ItemOrNumber = Item | "number"`, `ItemOrNumber | Alpha` numbers `"number"` 0. A TypeScript
enum written as one keeps the order it declares its members in.

A union that is not spelled out where it is reached numbers its members by their types instead,
after any members that are written out: `boolean` first, then the built-in types in a fixed order
(`string`, then `number`, then `object`), then the other types, then whole Roblox enums by name,
then the literal values. Among the other types, the one that nests type arguments less deeply
goes first, so a type goes ahead of the types made from it (`Item` before `Item[]` and
`Box<Item>`), and `Zed` ahead of `Alpha[]` too; then a named type goes by its name (`Alpha` before
`Beta`) and anything else by its structure. A TypeScript enum with computed members
(`C = "abc".size()`) numbers those first, as declared, then its values. One example is a union
that only arrives as a generic's type argument, as in `Box<A | B>`, whose `value: T` names only
`T`; another is a property typed as an enum; a third is an optional property, parameter or tuple
element typed as an alias of a union without `undefined`, as in `reward?: Reward`: TypeScript makes
it a new union with `undefined`, which no longer carries the alias, so it goes by these rules and
not by the alias's written order, as `reward: Reward` does. An alias whose union holds `undefined`
itself (`type MaybeReward = ItemReward | CurrencyReward | undefined`) stays the alias, and its
written order numbers it. A member written as a union that is not spelled out
itself, such as `Prims[keyof Prims]` in `Prims[keyof Prims] | Alpha`, numbers its parts the same
way, except that `boolean` and the literal values `false`, `true`, `""`, `0` and the names `typeof`
returns go among the built-in types, in TypeScript's fixed order: `string`, `number`, `boolean` (or
`false`, then `true`), `object`, `""`, `0`, then `"string"`, `"number"` and the other names in the
order above. Two members that only TypeScript's internal ids could tell apart, such as two
interfaces of one name from two files, stop the build. Declare an alias for the union and use it
where the value is declared, and its written order numbers them.

None of these orders depends on what TypeScript happened to check first in a build. So a watcher's
rebuild, which compiles a sender without its receiver, and a buffer stored with
`Flamework.createSerializer` read the same layout as a full build.

Object members of a union are told apart by a shared discriminant (`kind: "a"` against
`kind: "b"`) or by a key only one of them has, so no guard is generated for them. A union with more
than 255 members travels whole, as a blob (see below).

The written order numbers the members. It is also the order most members are tried in, with these
exceptions:

- Members with a test of their own go first: a type, a literal, a discriminant or a key only they
  have. A branded number member (`Serialization.u16`) only takes a number that fits its width, so
  70000 in `u16 | number` is sent as the `number`. An integer width checks the range and that the
  number is whole; `f32` checks the range only, and rounds what it takes.
- The other members are checked by a guard: arrays, sets, maps, tuples, and objects without a key
  of their own. A guard checks a value's shape, but not the keys an object does not declare, at any
  depth. So one member can take another member's value and send it without those keys. Flamework
  compares the members' types, nested ones included, and tries a member that would do that after
  the member whose values it would take. So `Point | Map<string, number>` sends
  `{ x: 1, y: 2, z: 3 }` as the map, which keeps `z`.
- When two members would each take part of the other's values, the written order stands, and
  objects whose fields are all optional go last. The build warns, once for each union in a file (a
  union spelled through another alias or a generic is warned again): a value that fits both may be
  sent as the first, without what only the other declares. A third member that takes such values
  whole can make the warning more cautious than needed.
- A blob that takes anything, such as `unknown` or a struct the Roblox API declares (`GroupInfo`,
  `UserInfo`), goes last.

So `Partial<Crate> | None` sends a `None` as `None` whichever way round it is written. When the last
member tried is an object or a collection without a test of its own, it is only checked to be a
table.

Values that have no buffer representation travel next to the buffer, in a **blob list**. These are
Instances, `unknown`, `object`, `defined`, class instances, EnumItems, and the Roblox datatypes
without a layout (anything roblox-ts declares, or anything with a `_nominal_` marker). The buffer
holds each one's index in that list as a u32. So a nil where an Instance was expected costs four
bytes and shifts nothing, and the receiving guard rejects it like any other wrong value. The remote
carries the blob list only when it holds something. When the types have no such values, or the
values sent fill none of their slots (an optional Instance left out, an empty `defined[]`), the
buffer is sent alone: a missing argument costs nothing, where an empty table costs two bytes and a
`nil` one. `Flamework.createSerializer`'s `serialize` returns the list as its second value: `nil`
when the types have no such values, and a table (possibly empty) when they do.

Collections nest freely: a `Map<Instance, Array<Set<string>>>` is a varint count of blob keys, each
followed by its array.

Only a value that a remote cannot carry at all is a compile error. The message gives the path
through the type. These are functions, Promises outside a function's result, symbols, bigint,
`never`, and `LuaTuple` (several values at runtime, not a table; declare a tuple type such as
`[A, B]` instead).

An argument list that carries nothing (`bump(): void`) sends nothing. No buffer is allocated on
either side, and the remote fires with no arguments at all. An array rest parameter
(`many(...values: number[])`) is sent as a count and the values, however many a call passes.

### Implicit widths and checks

`Serialization.Implicit` has a twin of every brand: `Implicit.u8`, `i8`, `u16`, `i16`, `u32`,
`i32`, `f32`, `f64`, `varint`, `string8`, `string16`, `string32`, `buffer16` and `buffer32`. An
implicit width takes a plain value, so no cast is needed:

```ts
interface Tile {
    x: Serialization.Implicit.u16;
    y: Serialization.Implicit.u16;
    name: Serialization.Implicit.string8;
}

const tile: Tile = { x: column, y: row, name }; // plain numbers and a plain string
```

It is written exactly as its strict twin, the same bytes on the wire. What differs is that its values
are checked where they are written. With the defaults, a value that does not fit raises right there,
so nothing is sent:

```
[Flamework] u16 cannot hold 70000, at Tile.x
```

The message names the width, the value (for a string or a buffer, its length: `300 bytes`), and
where the value sits in the type. That is a field path from the serialized type (`Tile.x` for a
named object, union or tuple, `value.x` otherwise), an argument of a call and the event or function
it goes through (`'place' [0].x`, numbered from 0), or a function's `result`. An element of an array
or a set is `[]`, and a map's keys and values are `<key>` and `<value>`. So are the arguments a call
spreads into a rest parameter (`fire(...values)`), whose places are only known when it runs:
`'many' []`. Under obfuscation the event or function is not named.

A named object, union or tuple whose size varies, and any other type of varying size a file reaches
more than once (an array, a set or a map included), has code of its own that its file shares (see
[Serializers](07-macros.md#serializers)). A type of a fixed size never has: it is written where it
is reached, and its path goes on from there. A path goes on through shared code from where the value
was sent, but a shared type inside another one starts from the outer type's name
(`Tile.items[].id`), which keeps the writes from building strings. An outer type with no name starts
from how TypeScript prints it, in parentheses: `({ pos: { x: i16; }; items: Item[]; }).items[].id`,
or `(u16[])[]`.

Implicit widths behave like plain numbers, strings and buffers. They mix with each other and take
any strict width of their kind: an `Implicit.u8` goes into an `Implicit.u16` and back, and a strict
`Serialization.u32` goes into either. What is checked is the width a value is written as, so 300
held in an `Implicit.u16` and sent as an `Implicit.u8` fails the `u8` check. As with a plain
`number`, going into a strict width takes a cast, and a number never goes into a string width.

Each implicit width's brand is an optional property of its own
(`number & { readonly _flamework_u16?: "u16" }`): optional to let a plain value in, and one per
width to let the widths mix. Each strict width carries its twin's property as well, next to its
required `__brand`, which makes it a subtype of the twin: a strict value and an implicit one
together (`[strict, implicit]`, `flag ? strict : implicit`, or both passed as one generic `T`) are
inferred as the implicit twin, as a plain `number` and an implicit one are inferred as `number`.

A type of your own with an optional brand (`number & { __brand?: "u16" }`) counts as implicit too.
Types of your own that share one property, such as `__brand?: "u8"` and `__brand?: "u16"`, do not
mix with each other, nor take a strict width other than their own, which uses `__brand` too. Give
each width a property of its own, as `Implicit` does, to make them mix. A brand of your own on
`__brand`, strict or optional (`number & { __brand: "u16" }` or `{ __brand?: "u16" }`), is not a
subtype of `Implicit.u16`, so it and an implicit value together are not inferred as the twin:
`[own, implicit]` is a union of the two, which `createSerializer<typeof value>()` writes with a
tag, and a generic `T` or a `Map` literal given both does not compile. Give it the twin's property
too (`_flamework_u16?: "u16"`), or use `Serialization.u16`. A type that names two different widths, such as
`Serialization.u16 & Serialization.Implicit.u8`, fails the build. The same width named twice is
that width, and strict if either brand is required.

Use an implicit width where a value comes from arithmetic or from outside, such as a count, a
coordinate or a player's input, and you would rather hear about a value that does not fit than send
it wrapped. Keep a cast where the value is known to fit: nothing is checked on that path.

What each width checks:

| Width | Check |
|---|---|
| `u8`, `i8`, `u16`, `i16`, `u32`, `i32` | A whole number in range. |
| `varint` | A whole number from 0 to 2^35 - 1. |
| `f32` | Not a finite number past its range. NaN and the infinities are written as they are. |
| `string8`, `string16` | At most 255 or 65535 bytes. |
| `buffer16` | At most 65535 bytes. |
| `f64`, `string32`, `buffer32` | Nothing: they hold every value. |

An integer width costs three comparisons and a modulo per value (`n >= 0 and n <= 65535 and
n % 1 == 0`), an `f32` two comparisons of `math.abs(n)`, and a string or a buffer one comparison of
the length it takes anyway. A value that is more than a name, such as a field, is read once into a
local, in a block of its own with its check and its write, so a function that writes many checked
values holds no more locals than it would unchecked (Luau allows 200). A value that fails calls a
helper its file shares, kept in the file's `codec` table (`codec.checkWidth`). A file that has
that table pays no local for it; one that has none gets the table, one local at the top of the file,
which a file already at Luau's 200 cannot take. A number literal is judged when you build: one that
fits needs no check. Reading needs none either, since a decoded value always fits its width.

The checks are set in `flamework.config.json`, in a section of their own, since
`Flamework.createSerializer` checks the same way:

```jsonc
"serialization": {
  "checks": { "category": "implicit", "mode": "assert", "side": "both", "types": false }
}
```

| Key | Values | Default |
|---|---|---|
| `category` | `"implicit"`: values typed with an implicit width. `"all"`: strict widths too. `"none"`: nothing, so an implicit value is written as a strict one is and wraps. | `"implicit"` |
| `mode` | `"assert"`: raise, so nothing is sent. `"warn"`: warn with the same message, then write the value as it is, so 70000 as a `u16` arrives as 4464. | `"assert"` |
| `side` | The realm whose writes are checked: `"server"`, `"client"` or `"both"`. A module both realms run is checked only where it runs in that realm. Elsewhere its values are written unchecked. | `"both"` |
| `types` | `true`: test the type of every value written as well, whatever `category` says; see [Type checks](#type-checks). | `false` |

A string or a buffer longer than its length prefix is refused in every case, strict widths included,
as it always has been (`string is longer than its u8 length prefix allows`). The receiver would read
every value after it wrong. So under `warn` it is warned about and then refused, and under `none` it
is still refused. A `varint` has no wrapped form either: under `warn` a fraction is written rounded
down, but a negative or NaN one can make the receiver misread or drop the payload, and one of 2^35
or more raises a buffer error where it is written, as a strict `varint` always has.

In a union, a member with a width only takes a number that fits it (see
[What each type costs](#what-each-type-costs)). A number that fits no member of
`Serialization.Implicit.u16 | string` fails the check of the members with a width, `u16` here, and
follows `mode`: it raises, or it is warned about and written as the first checked member. A union
with a plain `number` takes every number, so `Implicit.u16 | number` sends 70000 as the `number`,
with no warning. Where nothing is checked (a strict width, `"none"`, the other realm), such a number
raises `value matches none of the union's members`, as it always has.

The checks are compiled into the code that writes values, so change them with a plain build. A
running watcher keeps the values it started with ([Watching](09-project-structure.md#watching)).

### Type checks

A value of the wrong type, such as a string in a `number` field after an `as any` somewhere, fails
where it is written with the buffer library's own error, which does not say which value it was:

```
invalid argument #3 to 'writef64' (number expected, got string)
```

With `"types": true` under `serialization.checks`, every value is tested to be of its declared type
before it is written. One that is not raises with what was expected, what came, and the path a width
check gives, so nothing is sent:

```
[Flamework] number expected, got string, at 'move' [0].pos.x
```

| Declared type | Tested to be |
|---|---|
| `number` and every number width | a number (`type(v) == "number"`), ahead of the width's range |
| `string`, `boolean`, `buffer` and their widths | that type |
| an object, an array, a `Set`, a `Map`, a tuple | a table, and then each value in it |
| `Vector3`, `CFrame` and the other datatypes with a layout | that datatype (`typeof(v)`) |
| an enum (`Enum.Material`) | an EnumItem of that enum |
| a literal or a union of literals (`"a" \| "b"`, `Enum.Material.Plastic`) | one of them, and the message shows the value: `"a" \| "b" expected, got "c"`, `Enum.Material.Plastic expected, got Enum.Material.Wood` |
| an Instance, a bare `EnumItem`, a `Font`, the engine's other types that `typeof` names | that type, or nil, which is written as nil as always |
| an optional | nil, or its type |
| a union | one of its members: `number \| string expected, got boolean`, or with an alias, `Shape expected, got table` |
| `unknown`, `any`, `object`, a class instance, a struct the Roblox API declares (`GroupInfo`, a plain table in the engine) | nothing: they take any value |

`Flamework.createSerializer` tests the same way, and its paths start from `value` or the type's name
(`Entity.name`). `category` does not apply: every value is tested, whatever its width. `side` does,
as for the widths: in the other realm the values are still tested, but one of the wrong type raises
nothing and is written as it would be without the checks. A value of the wrong type cannot be
written, so `"warn"` raises all the same, with one exception: a value declared `boolean`, which is
warned about and then written as whether it is truthy, as it is without the checks. A lone literal
type (`true`, `"circle"`) is no exception: under `"warn"` it raises like the rest.

A test is a `type` or `typeof` call and a comparison per value (an enum's reads its `EnumType` as
well), one to three nanoseconds in Lune: a send of a list of ten `{ x, y }` costs about 13% more, one
of an object of ten values about 5%. A literal union and a union cost nothing more, since they look
their value up anyway and only name it once nothing matched, except that a union of tables told
apart by a key (`kind`) first tests that its value is a table. A value whose size varies (a string, a
buffer, a `varint`, a table) is tested while the payload is measured, the pass that reads it first;
one of a fixed size where it is written. A union member is written only once the union's test found
its type, so only the values inside it are tested again. A literal argument is judged when you
build: a `3` for a number is not tested, while an `undefined` for a `boolean`, which a project
without `strictNullChecks` can pass, fails as any value of the wrong type does. With the type checks
on, a type with code of its own is also measured with where the value was sent, so its paths start
there in both passes (`'move' [1].name`), and so does a hole that measuring finds (see below). Where
it was sent takes one more of the 200 locals Luau allows a function, so with the checks on, the
code that writes a field or a tuple element goes in a block of its own where it needs locals, and
the function holds the locals of one at a time: a type that loads without the checks, even one at
that limit, loads with them. Off, which is the default, nothing is generated: the code is the same
as without the option.

### Payloads that cannot be decoded

A payload that cannot be decoded (truncated, the wrong shape, or hostile) is dropped and reported
through `onBadRequest` with `argIndex: -1`. A function reply that cannot be decoded rejects with
`InvalidResult` and fires `onBadResponse`.

Decoding never trusts a count or a length it reads. One that announces more elements, or more
bytes, than the buffer could hold is refused before anything is allocated. Elements that take no
bytes (a lone literal, `undefined`, an object of only literals) cannot be limited that way, so a
payload may announce at most 65535 of them in total, however they are nested.

Apart from the [width checks](#implicit-widths-and-checks) and, when you turn them on, the
[type checks](#type-checks), nothing checks a value before it is sent: it is written as its declared
type says. Most values that do not match raise an error at the
sender while they are written, such as a table where a number was declared, or a value that fits no
member of a union. Some do not:

- A string that Luau reads as a number (`"5"`, `"0x10"`) is written as that number. A checked
  width changes that for the integers: their check raises Luau's own `attempt to compare number <=
  string`. A `varint` raises `attempt to compare string < number` before its check, when it is
  measured, and an `f32` takes the string as its number: it passes the check and is written. The
  type checks refuse such a string: `number expected, got string`.
- A `boolean` is written as whether the value is truthy. The type checks raise instead, or under
  `"warn"` warn first.
- An object is written field by field, so the fields its type does not declare are dropped. Any
  table fits an object whose fields are all optional.
- The last member tried in a union may only be checked to be a table (see above). A table of the
  wrong shape is then written as that member as far as it goes: a set sends every value as
  `true`, and a tuple drops what is past its length.
- A guard rejects NaN in a `number` field, so in a union such a value can pass to a later member:
  `{ v: number } | { v: boolean }` sends `{ v = NaN }` as `{ v = false }`.

A value that does not match its type is a bug in the caller, not in the peer.

An array is written by index, up to its length (`#`). A nil inside it is written as a nil where
the element type takes one (`Array<T | undefined>`, `unknown[]`), and read back in its place;
a remote's guard still turns such a list down on arrival, as it does one sent unpacked (`t.array`
takes no gap). Where the element type takes no nil, there is nothing to write, so the sender raises,
whatever `serialization.checks` says, and nothing is sent:

```
[Flamework] the array has no value at 'place' [0][2]
```

The index counts from 0, and the path is the one a width check gives, except in a type with code of
its own, where it starts from the type's name: `Holder.list[1]`, `(string[])[2]`. That holds even
next to the type's own width checks, which start where the value was sent (`Tagged.names[1]` next
to `'tagged' [0].id`): a hole among elements whose size varies is found while the payload is
measured, and that pass is not told where the value was sent, unless the [type checks](#type-checks)
are on: then it is, and such a hole starts there too. Only in a type with checks of its own (width
checks, or type checks of values of a fixed size) does a hole among elements of a fixed size, which is
found while writing, start where the value was sent, as the checks do: `'tagged' [0].list[1]`. A tuple's rest element is written the
same way (`the tuple has no value at ...`, and `the argument list` for arguments spread into a rest
parameter). Sets and maps have no holes: Luau keeps no nil in a table's
keys or values. Luau's `#` is not reliable around a hole, though: it may count past it or stop at
it. So a hole near the end can still shorten the list, without an error.

### Opting in and out per event

A marker on a member overrides the switch for that member alone. The plain name is for functions;
the `Reliable` and `Unreliable` forms are for events.

| Markers | Values travel |
|---|---|
| `Raw`, `RawReliable`, `RawUnreliable` | As they are, whatever the switch says. |
| `Serialized`, `SerializedReliable`, `SerializedUnreliable` | Packed, whatever the switch says. |

```ts
interface ServerEvents {
    // Packed, even with networking.serialization off.
    saveBuild: Networking.SerializedReliable<(build: BuildData) => void>;
}

interface ClientEvents {
    position: Networking.RawUnreliable<(position: Vector3) => void>;
    chat: Networking.RawReliable<(text: string) => void>;
    // An unreliable event that is packed. These three spellings are one type:
    snapshot: Networking.SerializedUnreliable<(state: State) => void>;
    // snapshot: Networking.Unreliable<Networking.Serialized<(state: State) => void>>;
    // snapshot: Networking.Serialized<Networking.Unreliable<(state: State) => void>>;
}

interface ServerFunctions {
    lookup: Networking.Raw<(id: string) => Entry | undefined>;
    loadPlot: Networking.Serialized<(plotId: number) => PlotData>;
}
```

`SerializedUnreliable<T>` is `Unreliable<Serialized<T>>`, and the order does not matter. The same
goes for `RawUnreliable`. The unreliable forms put the event on an `UnreliableRemoteEvent`, like
`Unreliable`.

A raw member's values are sent as they are, and the generated guards still run on arrival. Use it
for an event whose payload is already a buffer of your own, or to compare the two formats on the
wire.

A serialized member is packed exactly as the switch would pack it: the encoding at each call site,
the decoding in the handler metadata, and a function's result after the middleware. With the switch
on, `Serialized` changes nothing on the wire (its type still differs from a plain member's). With
it off, it lets a game pack only its heavy remotes.

`Raw` and `Serialized` on the same member is a build error, which names the member.

Changing a member's marker changes its wire format. The server and the client must come from the
same build, as they must for the switch.

### Size on the wire

Roblox compresses the `buffer` values a remote carries, and nothing else (measured on 2026-09-29).
Each buffer is compressed on its own, not together with the rest of the call or the packet, with
Zstd at about level 1, and the compressed form is kept only when it is smaller. Tables, strings,
numbers and datatypes such as `Vector3` and `CFrame` go out as they are, however repetitive. So
packing saves twice: the buffer is smaller than the values it replaces, and, being a buffer, it is
the one part of the payload the engine compresses. These are bytes per message, measured in Studio
on 2026-09-28:

| Payload | Plain tables | `Serialized` |
|---|---|---|
| A small event: a number, a `Vector3` and a boolean | 35 B | 35 B |
| An inventory of 500 items (id, name, count, rarity, equipped) | 35.0 KB | 3.1 KB |
| A 32 by 32 tile map, `Map<string, Tile>` | 46.7 KB | 3.4 KB |
| A 128 by 128 tile map | 774 KB | 67 KB |

Packed, the buffers are 21 B, 13.7 KB, 15.7 KB and 267 KB; the engine shrinks them from there.
Packing was faster at both ends too: sending the inventory took 126 µs instead of 560, and receiving
it 342 µs instead of 678. Compressing the packed buffer again with Zstd at level 3 saved at most 4%
more, and made the small event, the inventory and the 32 by 32 map larger. Level 19 saved 26% on the
128 by 128 map, and took 111 ms to compress it.

**Unreliable events** drop a message whose payload is over about 1000 bytes, counted after the
engine's compression. A buffer that does not compress arrives up to 996 bytes, or 988 with a blob
list next to it. A packed list counts at its compressed size: 120 of the inventory's items went
through, and 150 did not. As plain tables, 10 did.

## Middleware

A middleware is a factory. It receives `processNext` (which calls the next link in the chain) and
the event's info, and returns the handler for its own link.

Type it for any event with a type parameter, so one limiter serves every event:

```ts
// src/server/middleware/throttle.ts
import { Networking } from "@flamework-experimental/networking";
import { Players } from "@rbxts/services";

/** Whether a player's message may pass: false when it comes less than `seconds` after the last. */
function createLimiter(seconds: number) {
    const lastAccepted = new Map<Player, number>();
    Players.PlayerRemoving.Connect((player) => lastAccepted.delete(player));

    return (player: Player) => {
        const now = os.clock();
        const last = lastAccepted.get(player);
        if (last !== undefined && now - last < seconds) return false;

        lastAccepted.set(player, now);
        return true;
    };
}

/** Drops a player's event when it comes less than `seconds` after their last accepted one. */
export function throttle<T extends unknown[]>(seconds: number): Networking.EventMiddleware<T> {
    return (processNext) => {
        const accept = createLimiter(seconds);
        // Not calling processNext drops the event.
        return (player, ...args) => {
            if (player === undefined || accept(player)) return processNext(player, ...args);
        };
    };
}
```

`player` may be `undefined` in the type because the client shares it. On the server there is always
one.

The same for a function returns `Networking.Skip` for a call it drops, and the caller's Promise then
rejects with `Cancelled` at once:

```ts
export function throttleFunction<T extends unknown[], O>(seconds: number): Networking.FunctionMiddleware<T, O> {
    return (processNext) => {
        const accept = createLimiter(seconds);
        return (player, ...args) => {
            if (player === undefined || accept(player)) return processNext(player, ...args);
            return Networking.Skip;
        };
    };
}
```

Each goes in the `middleware` of the handler's config, as in [Where to create the
handlers](#where-to-create-the-handlers): `getCoins: [throttleFunction(0.5)]`.

Things to know:

- **Order is registration order.** The first factory in the array is the outermost link.
- **Generated guards always run first**, ahead of all user middleware, so your middleware never sees
  a payload that failed validation.
- **You can rewrite arguments** by passing different ones to `processNext`.
- **`processNext` returns the next link's result**, not a Promise. For an event that is nothing; for
  a function it is the value (or `Networking.Skip`). The chain is plain calls in the thread that
  received the message, so a middleware can read what the handler answered, time the call, or wrap
  it in `pcall`.
- **A middleware may yield or return a Promise.** A yield holds up only the message it is
  processing. A returned Promise is waited for, and `processNext` in the link that called it returns
  the Promise's value. A cancelled Promise reads as `Networking.Skip` in a function's chain (and as
  nothing in an event's). A rejected one raises an error.

Function middleware can also return `Networking.Skip` to cancel the request. The caller's Promise
then rejects with `Cancelled`:

```ts
const requireAdmin: Networking.FunctionMiddleware<[itemId: string], boolean> = (processNext) => {
    return (player, itemId) => (isAdmin(player) ? processNext(player, itemId) : Networking.Skip);
};
```

The value `processNext` returns is the one the caller will receive, so a middleware can inspect or
replace it:

```ts
const logPurchases: Networking.FunctionMiddleware<[itemId: string], boolean> = (processNext, fn) => {
    return (player, itemId) => {
        const bought = processNext(player, itemId);
        print(`${player} ${fn.name} ${itemId}:`, bought);
        return bought;
    };
};
```

In the earlier API, `processNext` returned a Promise, and a middleware used
`processNext(...).andThen(f)`. That becomes `f(processNext(...))`. A middleware that only returns
`processNext(...)` needs no change.

`event`, the second factory argument, is a `Networking.NetworkInfo`: the event's `name`,
`globalName` and `eventType`. With it you can write generic logging or metrics middleware. A unit
test can build one link by hand:

```ts
const info: Networking.NetworkInfo = { name: "spawnCoin", globalName: "test", eventType: "Event" };
let passed = 0;
const link = throttle<[]>(1)(() => {
    passed += 1;
}, info);

link(player);
link(player); // within the second: dropped, so `passed` is 1
```

## Observing rejections

```ts
GlobalEvents.registerHandler("onBadRequest", (player, data) => {
    warn(`${player} sent bad ${data.networkInfo.name} arg #${data.argIndex}:`, data.argValue);
});
```

Functions also have `onBadResponse`, for a response that failed its return guard. Both are useful
for tracking exploit attempts.

## Patterns

**One network object per area of the game.** For example, `GlobalEvents` for gameplay and another
for chat. Each gets its own folder of remotes, and the interfaces stay readable.

**Handlers in providers, logic elsewhere.** Connect in `onStart`, and have the handler call into
other code right away. The handler is a boundary, not a place for game rules.

**Trust nothing from the client.** The guards check *shapes*, not values: `buy(itemId: string)`
guarantees a string, not that the player can afford it.

**Use middleware only for concerns that cut across many events**: rate limits, admin checks,
logging. Game rules belong in the handler, where you can test them.

## Caveats

- **`createServer` on the client returns nothing** (and vice versa), without an error. Outside a
  running game both calls work, so the mistake shows up at runtime, not in Studio's editor.
- **Config and middleware must be object literals.**
- **The first `createServer`/`createClient` call wins.** The handler is cached per network object.
  Later calls return the same one and ignore their config, so configure it once.
- **Guards are incoming-only.** Nothing checks what you send, only what you receive. For a packed
  member, most values that do not match their type raise while they are written; see
  [Payloads that cannot be decoded](#payloads-that-cannot-be-decoded) for the ones that do not.
- **The server and the client must come from the same build.** The switch is per project and the
  markers are per member, and both realms read the same `flamework.config.json` and the same types,
  so one build always agrees with itself. A client built without the switch, or with a member marked
  differently, cannot talk to a server built with it.
- **Two members whose types differ only in how a union is spelled are one type to TypeScript.**
  Plain `a(x: string | number)` and `b(x: number | string)` lay `x` out differently, but a
  conditional over them (`flag ? Events.a : Events.b`) or a helper's inferred return type keeps only
  one of them, and the call is packed as that one; the other's receiver then reads it wrong, and the
  build cannot see it. Spell such members' unions alike, or make the call where the member is known.
  Members packed differently (a `Serialized` one with a plain one) stay apart, and their call is
  checked.
- **An ambient enum declared in several declaration files is numbered in the order TypeScript reads
  them.** `declare enum Spread { Q = 9, R = 3 }` in one `.d.ts` file and
  `declare enum Spread { P = 5 }` in another are one enum, and TypeScript lists its members file by
  file, in the order the program loads the files: a `/// <reference>` that loads the second one
  first numbers `P` first (5, 9, 3 rather than 9, 3, 5). Both realms of one build agree, as
  2.0.0-alpha.7's did, but an unrelated edit can renumber it, so a buffer stored with it is not
  safe. Declare such an enum in one file.
- **Unreliable events can be dropped.** Never make later messages depend on an earlier one.
- **An event uses one remote for both directions; a function uses two.** In ReplicatedStorage, a
  function's two remotes share a name and differ only by their `id` attribute (`$name` for one
  direction, `@name` for the other).
- **Unreliable events can be missed by a late listener.** Flamework listens to a remote from the
  first `connect` on, a moment later (a `task.defer`), so every handler connected in that moment
  gets what was waiting. The engine keeps reliable events for a remote nothing listens to yet, up
  to a limit, and hands them to the first connection; past the limit it drops them. It drops
  unreliable ones outright. So an unreliable event sent before the first `connect` is lost. Under
  `Immediate` signal behaviour, so is one that arrives right behind the event whose handler makes
  that first `connect`. Connect handlers for unreliable events before the other side
  can send them.
- **Remote folder names are stable across builds, unless obfuscation is on.** Each network object's
  folder in ReplicatedStorage is named by a callsite id taken from the file and the declaration.
  Without obfuscation, two builds of the same source produce the same tree, so committed output
  does not change from build to build. With obfuscation on, the names change with every plain build;
  a running watcher and an incremental build keep them
  ([Obfuscation](09-project-structure.md#obfuscation)).

---

Previous: [Components](05-components.md) · Next: [Macros](07-macros.md)
