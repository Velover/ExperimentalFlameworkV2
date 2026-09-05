# 6. Networking

You declare two interfaces -- what the server receives, and what the client receives -- and Flamework
generates the remotes, the argument validation and the typed handlers from them.

```sh
npm install @flamework/networking
```

## Declaring a network

Put this in shared code; both realms import the same object.

```ts
// src/shared/network.ts
import { Networking } from "@flamework/networking";

interface ServerEvents {
    setReady(ready: boolean): void;
}

interface ClientEvents {
    matchStarted(map: string): void;
}

export const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();
```

The first type parameter is what the **server receives**; the second is what the **client receives**.
Everything else follows from that: the server gets `connect` for `ServerEvents` and `fire` for
`ClientEvents`, and the client gets the mirror image.

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
nothing** rather than raising, so a stray `createServer()` on the client gives you a `nil` you will
trip over later.

The idiomatic shape is a provider per realm holding the handler:

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

`predict(...)` runs the *receiving* half locally, middleware and guards included, without touching a
remote. It is meant for client prediction, and it is also the easiest way to test a handler.

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

`invoke` returns a Promise. It times out after `defaultTimeout` seconds -- **30 on the client, 10 on
the server** -- and `invokeWithTimeout(timeout, ...)` overrides it per call.

A rejection is always a `NetworkingFunctionError`:

| Value | Means |
|---|---|
| `Timeout` | No response in time. |
| `Cancelled` | Middleware returned `Networking.Skip`, or the player left. |
| `BadRequest` | The arguments failed the generated guards. |
| `Unprocessed` | The other realm has not called `setCallback`. |
| `InvalidResult` | The response failed the return type's guard. |

```ts
GlobalFunctions.createClient({})
    .buy.invoke("sword")
    .catch((reason) => {
        if (reason === NetworkingFunctionError.Timeout) warn("server did not answer");
    });
```

Return values are validated too: a callback that returns the wrong type rejects the caller with
`InvalidResult` rather than delivering it.

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

These get an `UnreliableRemoteEvent` on their own channel. They may be dropped or arrive out of
order, so send **state, not deltas** -- a position, not "moved by 3 studs".

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

**The config object must be written inline.** The transformer reads it at compile time, so a variable
gets you `Flamework expected this argument to be a literal expression`. The same goes for the
`middleware` object.

## Serialization

With `"networking": { "serialization": true }` in `flamework.config.json`, every event argument list
and every function request and result is packed into a `buffer` before it leaves and unpacked when
it arrives, and the code that does it is plain buffer code generated from the declared types.

The encoding is generated **at each call site**: `Events.X.fire(value, where)` compiles to
`buffer.create(20)`, four writes at literal offsets and `Events.X._fire(payload)`, right where the
call was. A function callback is wrapped the same way so that its result leaves packed. No encoder
exists as a value anywhere in the output, so there is nothing for an exploiter to call to forge a
valid payload; the only way to produce one is the code path that legitimately sends it. Decoding is
generated once per event and function into the `createServer` / `createClient` metadata, because a
payload has to be unpacked before the guards and middleware see it. Nothing describes the type in
the output, no schema table, no runtime library. Nothing about the API changes; the guards still run
on what was decoded.

Call sites are found by type. Send and register callbacks through the handler's own type
(`Events.X.fire(...)`, a typed reference to `Events.X`, a helper generic over the event name), not
through a hand-written interface that widens `fire` to `(...args: unknown[])`: such a call is left
alone and sends unpacked values, which the peer drops as malformed. `predict` takes plain values
and needs no typing; `connect` is untouched.

Sizes are what the types say: a `number` is eight bytes, a `boolean` one, an
`"idle" | "walk" | "run"` one, an object is its fields in name order with nothing spent on names,
a `Vector3` is three floats. Widths come from brands: `Serialization.u8`, `i16`, `f32` and friends
from `@flamework/core` are `number & { __brand: "u8" }`-style types, and any brand with one of
those literal names counts, so existing branded types keep working. `Serialization.string8` /
`string16` shorten a string's length prefix from four bytes to one or two.

Values with no buffer representation travel alongside it: Instances, `unknown`, EnumItems and the
Roblox datatypes without a layout ride in a blob list. The buffer holds each one's index in that
list, so a nil where an Instance was expected costs two bytes and shifts nothing; the receiving
guard rejects it like any other wrong value. The blob list is `nil` when the types have no such
values and a table (possibly empty) when they do. Functions, Promises, classes and symbols are
compile errors, with the path through the type in the message.

A payload that cannot be decoded (truncated, wrong shape, hostile) is dropped and reported through
`onBadRequest` with `argIndex: -1`; a function reply that cannot be decoded rejects with
`InvalidResult` and fires `onBadResponse`. Decoding never trusts a count it reads: one that
announces more elements than the buffer could hold is refused before anything is allocated.
Sending a value that does not match its declared type raises at the sender, which is a bug in the
caller, not in the peer.

The same generator is available on its own as `Flamework.createSerializer<T>()`; see
[Macros](07-macros.md#serializers).

## Middleware

A middleware is a factory: it receives the next processor and the event's info, and returns the
handler for its link in the chain.

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

Three things to know:

- **Order is registration order.** The first factory in the array is the outermost link.
- **Generated guards always run first**, ahead of all user middleware, so your middleware never sees
  a payload that failed validation.
- **You can rewrite arguments** by passing different ones to `processNext`.

Function middleware can additionally return `Networking.Skip` to cancel the request, which rejects
the caller with `Cancelled`:

```ts
const requireAdmin: Networking.FunctionMiddleware<[itemId: string], boolean> = (processNext) => {
    return (player, itemId) => (isAdmin(player) ? processNext(player, itemId) : Networking.Skip);
};
```

`event` (the second factory argument) carries the event's `name`, `globalName` and `eventType`, which
is what makes generic logging or metrics middleware possible.

## Observing rejections

```ts
GlobalEvents.registerHandler("onBadRequest", (player, data) => {
    warn(`${player} sent bad ${data.networkInfo.name} arg #${data.argIndex}:`, data.argValue);
});
```

Functions also have `onBadResponse`, for a response that failed its return guard. Both are useful
for exploit telemetry.

## Patterns

**One network object per domain.** `GlobalEvents` for gameplay, another for chat -- each gets its own
folder of remotes, and the interfaces stay readable.

**Handlers in providers, logic elsewhere.** Connect in `onStart`, then immediately delegate. The
handler is a boundary, not a place for rules.

**Trust nothing from the client.** The guards check *shapes*, not values: `buy(itemId: string)`
guarantees a string, not that the player can afford it.

**Middleware for cross-cutting concerns only** -- rate limits, admin checks, logging. Business rules
belong in the handler where they are testable.

## Caveats

- **`createServer` on the client returns nothing** (and vice versa), silently. Both work outside a
  running game, so this bites at runtime, not in Studio's editor.
- **Config and middleware must be object literals.**
- **The first `createServer`/`createClient` call wins.** The handler is cached per network object;
  later calls return the same one and ignore their config. Configure it once.
- **Guards are incoming-only.** Nothing validates what you send, only what you receive. With
  serialization on, the generated encoder does refuse a value that does not match its type.
- **Serialization is all or nothing per project.** Both realms compile from the same
  `flamework.config.json`, so they always agree on the wire format; a client built without it cannot
  talk to a server built with it.
- **Unreliable events can be dropped.** Never make later messages depend on an earlier one.
- **An event uses one remote for both directions; a function uses two.** If you are inspecting
  ReplicatedStorage, a function's two remotes share a name and differ only by their `id` attribute
  (`$name` for one direction, `@name` for the other).
- **Remote wiring is deferred by one frame.** Connecting and immediately firing in the same frame can
  miss.
- **Remote folder names are stable across builds.** Each network object's folder in ReplicatedStorage
  is named by a callsite id derived from the file and declaration, so two compilations of the same
  source produce the same tree and committed output does not churn.

---

Previous: [Components](05-components.md) · Next: [Macros](07-macros.md)
