# 6. Networking

You declare two interfaces: one for what the server receives and one for what the client receives.
From them, Flamework generates the remotes, the **guards** that check incoming arguments, and the
typed handlers.

```sh
npm install @flamework-experimental/networking
```

Map it in your Rojo project next to `core` ([Getting started › Rojo](01-getting-started.md#rojo)).

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

The usual shape is one provider per realm that holds the handler:

```ts
@Provider()
export class MatchService implements OnStart {
    private events = GlobalEvents.createServer({});

    public onStart() {
        this.events.setReady.connect((player, ready) => this.setReady(player, ready));
    }
}
```

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

The encoding is generated **at each call site**. For example, `Events.X.fire(value, where)` compiles
to `buffer.create(20)`, four writes at literal offsets and `Events.X._fire(payload)`, right where the
call was. A function callback is registered with a generated packer for its result type. The packer
runs after the middleware, so the result is sent packed.

Apart from those result packers, no encoder exists as a value anywhere in the output. So an exploiter
has nothing to call to forge a valid request or event payload: the only way to produce one is the
code that legitimately sends it.

Decoding is generated once per event and function, into the `createServer` / `createClient`
metadata, because a payload has to be unpacked before the guards and middleware see it. Nothing in
the output describes the type: there is no schema table and no runtime library.

The transformer finds call sites by their type. Send and register callbacks through the handler's
own type: `Events.X.fire(...)`, a typed reference to `Events.X`, or a helper generic over the event
name. Don't go through a hand-written interface that widens `fire` to `(...args: unknown[])`. Such a
call is left alone and sends unpacked values, which the peer drops as malformed. A handler reached
through `?.` (`this.events?.X.fire(...)`) is packed like any other, behind the same short-circuit.
`predict` takes plain values and needs no typing, and `connect` is left as it is.

The same generator is available on its own as `Flamework.createSerializer<T>()`; see
[Macros](07-macros.md#serializers).

### What each type costs

Sizes follow the types:

- A `number` is eight bytes. A `boolean` is one byte, and so is an `"idle" | "walk" | "run"`.
- An object is its fields in declaration order, with nothing spent on names.
- A `Vector3` is three floats.
- Counts and lengths (of arrays, sets, maps, strings and buffers) are varints: one byte below 128,
  two below 16384, up to five.

To pick a number's width, use a brand. `Serialization.u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `f32`,
`f64` and `varint` from `@flamework-experimental/core` are `number & { __brand: "u8" }`-style types.
Any brand with one of those literal names counts, so branded types you already have keep working.
`Serialization.string8` / `string16` / `string32` (and `buffer16` / `buffer32`) give a string or
buffer a fixed-width length instead.

Each union value carries a one-byte tag: its member's position as written. In
`{ Coins: number } | { Items: string[] }`, Coins is 0 and Items is 1. In `number | string`, the
number is 0. A union with `number` has one more tag, after its members, for a whole number from 0
up to 2^35 - 1, which is then sent as a varint. So in `number | string`, 3 is the tag 2 and one
byte, and 2.5 is the tag 0 and eight bytes. Array indices sent as `string | number` map keys stay
small that way. A `number` that is not in a union is always eight bytes.

"As written" means at the declaration the value is reached through: the parameter, property, return
type or tuple element, including inside arrays, sets, maps and Promises. So `a(x: string | number)`
and `b(x: number | string)` number their members differently, even though they are one TypeScript
type. Both sides agree, because both read the same declaration. A union that is not spelled out
where it is reached keeps TypeScript's order, which is the same everywhere in a program. One example
is a union that only arrives as a generic's type argument, as in `Box<A | B>`. If the order matters
to you, declare an alias for it.

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
- A blob that takes anything, such as `unknown`, goes last.

So `Partial<Crate> | None` sends a `None` as `None` whichever way round it is written. When the last
member tried is an object or a collection without a test of its own, it is only checked to be a
table.

Values that have no buffer representation travel next to the buffer, in a **blob list**. These are
Instances, `unknown`, `object`, `defined`, class instances, EnumItems, and the Roblox datatypes
without a layout (anything roblox-ts declares, or anything with a `_nominal_` marker). The buffer
holds each one's index in that list as a u32. So a nil where an Instance was expected costs four
bytes and shifts nothing, and the receiving guard rejects it like any other wrong value. The blob
list is `nil` when the types have no such values, and a table (possibly empty) when they do.

Collections nest freely: a `Map<Instance, Array<Set<string>>>` is a varint count of blob keys, each
followed by its array.

Only a value that a remote cannot carry at all is a compile error. The message gives the path
through the type. These are functions, Promises outside a function's result, symbols, bigint,
`never`, and `LuaTuple` (several values at runtime, not a table; declare a tuple type such as
`[A, B]` instead).

An argument list that carries nothing (`bump(): void`) sends nothing. No buffer is allocated on
either side, and the remote fires with no arguments at all.

### Payloads that cannot be decoded

A payload that cannot be decoded (truncated, the wrong shape, or hostile) is dropped and reported
through `onBadRequest` with `argIndex: -1`. A function reply that cannot be decoded rejects with
`InvalidResult` and fires `onBadResponse`.

Decoding never trusts a count or a length it reads. One that announces more elements, or more
bytes, than the buffer could hold is refused before anything is allocated. Elements that take no
bytes (a lone literal, `undefined`, an object of only literals) cannot be limited that way, so a
payload may announce at most 65535 of them in total, however they are nested.

Nothing checks a value before it is sent: it is written as its declared type says. Most values that
do not match raise an error at the sender while they are written, such as a table where a number
was declared, or a value that fits no member of a union. Some do not:

- A string that Luau reads as a number (`"5"`, `"0x10"`) is written as that number.
- A `boolean` is written as whether the value is truthy.
- An object is written field by field, so the fields its type does not declare are dropped. Any
  table fits an object whose fields are all optional.
- The last member tried in a union may only be checked to be a table (see above). A table of the
  wrong shape is then written as that member as far as it goes: a set sends every value as
  `true`, and a tuple drops what is past its length.
- An array with holes is written without an error. The receiver then rejects the payload as
  malformed.
- A guard rejects NaN in a `number` field, so in a union such a value can pass to a later member:
  `{ v: number } | { v: boolean }` sends `{ v = NaN }` as `{ v = false }`.

A value that does not match its type is a bug in the caller, not in the peer.

### Opting out per event

```ts
interface ClientEvents {
    position: Networking.RawUnreliable<(position: Vector3) => void>;
    chat: Networking.RawReliable<(text: string) => void>;
}

interface ServerFunctions {
    lookup: Networking.Raw<(id: string) => Entry | undefined>;
}
```

A raw member's values are sent as they are, and the generated guards still run on arrival. Use it
for an event whose payload is already a buffer of your own, or to compare the two formats on the
wire. `RawUnreliable` also puts the event on an `UnreliableRemoteEvent`, like `Unreliable`.

## Middleware

A middleware is a factory. It receives `processNext` (which calls the next link in the chain) and
the event's info, and returns the handler for its own link.

```ts
const rateLimit = (perSecond: number): Networking.EventMiddleware<[ready: boolean]> => {
    return (processNext, event) => {
        return (player, ready) => {
            if (isOverBudget(player, perSecond)) {
                return; // not calling processNext drops the event
            }

            return processNext(player, ready);
        };
    };
};
```

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

`event`, the second factory argument, carries the event's `name`, `globalName` and `eventType`. With
it you can write generic logging or metrics middleware.

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
- **Guards are incoming-only.** Nothing checks what you send, only what you receive. With
  serialization on, most values that do not match their type raise while they are written; see
  [Payloads that cannot be decoded](#payloads-that-cannot-be-decoded) for the ones that do not.
- **Serialization is all or nothing per project.** Both realms build from the same
  `flamework.config.json`, so they always agree on the wire format. A client built without it cannot
  talk to a server built with it.
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
