# Flamework v2: networking

For anything not covered here, read
`node_modules/@flamework-experimental/core/docs/guide/06-networking.md`. Step 10 of
`node_modules/@flamework-experimental/core/docs/guide/10-migrating-from-v1.md` lists what changed
since v1.

## Declaring

- One shared module declares everything (`src/shared/network.ts` in the Flamework template):
  `GlobalEvents = Networking.createEvent<A, B>()` and
  `GlobalFunctions = Networking.createFunction<A, B>()`. `A` is what the **server receives**, `B`
  what the client receives. Name the interfaces for the direction: `ClientToServerEvents`,
  `ServerToClientEvents`, `ClientToServerFunctions`.
- Use an event for a one-way message, and a function only when the caller needs an answer. Avoid
  server-to-client functions: a client can stall or lie.
- Group a feature's members under a key (`shop: { buy(itemId: string): void }`). Middleware nests
  the same way.
- `Networking.Unreliable<(...) => void>` for frequent state that may be dropped, such as positions.
  Send state, not deltas.

## Using

- Each realm has its own module that creates its handlers once (`src/server/network.ts` and
  `src/client/network.ts` in the template): `export const Events = GlobalEvents.createServer({...})`
  on the server, `createClient` on the client; the wrong one returns `nil` instead of raising.
  Import `Events` and `Functions` from there, never `GlobalEvents` or `GlobalFunctions`. The first
  `createServer` or `createClient` call wins, and later calls silently ignore their config and
  middleware.
- The config and the `middleware` tree must be object literals written inline: the transformer
  reads them when you build.
- Server: `Events.x.fire(player, ...)`, `.fire([a, b], ...)`, `.broadcast(...)`,
  `.except(player, ...)`; receive with `Events.y.connect((player, ...) => {})`;
  answer with `Functions.z.setCallback((player, ...) => value)`.
- Client: `Events.y.fire(...)`, `Events.x.connect((...) => {})`, and `Functions.z.invoke(...)`,
  which returns a Promise (30 s timeout, or `invokeWithTimeout`). Handle its rejection.
- Connect in a provider's `onStart`. `connect` returns a `Networking.Connection`, not an
  `RBXScriptConnection`.

## Trust

- The parameter types become guards, and a call whose arguments fail them is dropped. Guards check
  the shape, not the meaning: the handler still checks ownership, cost, cooldown and distance.
  Never trust what a client sends.
- Rate-limit every client-to-server member with middleware in the server's `createServer` config.
  Guide 06, "Middleware", writes a `throttle`; the template ships `throttle(seconds)` for an event
  and `throttleFunction(seconds)` for a function in `src/server/middleware/throttle.ts`. Game rules
  belong in the handler, not in middleware.

## Writing middleware

- A middleware is a factory `(processNext, event) => (player, ...args) => result`, typed
  `Networking.EventMiddleware<Args>` or `Networking.FunctionMiddleware<Args, Result>`.
- `processNext(player, ...args)` returns the next link's result directly, not a Promise. To drop an
  event, return without calling it. A function middleware returns `Networking.Skip` instead, and
  the caller's Promise rejects with `Cancelled`.
- `player` is optional in the type because the client shares it; on the server it is always there.
- Keep middleware modules outside the folders an entry point registers, since registration
  requires every module in them.

## Config

- `networking.serialization` in `flamework.config.json` packs every payload into a buffer, with
  code generated from the parameter types. It is off by default. Both realms build from one config,
  so they always agree on the format.
- To pack one heavy member with the switch off, mark it: `Networking.SerializedReliable<...>` or
  `SerializedUnreliable<...>` for an event, `Networking.Serialized<...>` for a function (`Raw*`
  does the opposite). The build refuses a call that may reach members packed differently, such as
  a helper returning either a `Serialized` member or a plain one.
- Anything that holds one of several members' senders (a variable, parameter, field, array,
  `Record` or `Map`) must be typed as all of them: `let send: typeof Events.setA |
  typeof Events.setB = ...`. Each sender's type names its member, so `let send = Events.setA`
  refuses a later `send = Events.setB`, and the build checks the union's members pack alike.
- Packed values are not type-tested before they are written. A value of the wrong type (after an
  `as any`, say) fails with the buffer library's own error, which names no field:
  `invalid argument #3 to 'writef64' (number expected, got string)`. `"types": true` under
  `serialization.checks` tests every value and names the field instead, for a few percent per send
  (guide 06, "Type checks"). It is off by default; ask before turning it on in a project.
- With `transformer.obfuscation` on, remote names change with every build: never look a remote up
  by name.
