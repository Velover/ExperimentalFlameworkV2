# How Flamework works

This is the implementation companion to [the guide](../README.md). It describes what the transformer
does to your code, what the runtime does with the result, and why the pieces are shaped the way they
are. Read it if you are changing Flamework, debugging something that only fails at runtime, or
writing a transformer plugin.

- [Layout](#layout)
- [The transformer](#the-transformer)
- [Macros](#macros)
- [Identifiers and guards](#identifiers-and-guards)
- [The plugin host](#the-plugin-host)
- [The module runtime](#the-module-runtime)
- [Components](#components)
- [Networking](#networking)
- [The test harness](#the-test-harness)
- [Rough edges](#rough-edges)

## Layout

| Package | Contents |
|---|---|
| `packages/transformer` | The roblox-ts transformer. Everything compile-time. |
| `packages/transformer-plugin` | The public API third-party transformer plugins are written against. |
| `packages/core` | Modules, dependency injection, plugins, lifecycle events, reflection. |
| `packages/components` | CollectionService components, built on core's plugin system. |
| `packages/networking` | Remote events and functions. |
| `packages/testing` | Runtime specs, compiled by `rbxtsc` like any other consumer. |

Build order matters and is fixed in [`scripts/build.mjs`](../../scripts/build.mjs): the transformer
plugin API, then the transformer, then the packages that compile with it. Everything after
`transformer` is built by `rbxtsc` running the transformer that was just built, so a broken
transformer breaks the build of everything downstream rather than producing bad output quietly.

## The transformer

Entry point is [`src/transformer.ts`](../../packages/transformer/src/transformer.ts), which roblox-ts
loads as a TypeScript transformer plugin. It builds a `TransformState`
([`src/classes/transformState.ts`](../../packages/transformer/src/classes/transformState.ts)) holding
the program, the type checker, the Rojo resolver, path translation, the build info cache and the
plugin host, then walks each source file.

The walk is a straightforward recursive descent -- `transformFile` → `transformStatementList` →
`transformStatement` / `transformExpression` → `transformNode` -- with handler tables per syntax
kind under `transformations/statements` and `transformations/expressions`. A handler either rewrites
the node or returns it unchanged.

Two pieces of state matter while transforming a file:

- **File imports.** `state.addFileImport(file, "@rbxts/t", "t")` returns an identifier for a module,
  adding the import if it is not already there. Generated code uses this rather than assuming
  anything is in scope.
- **Root statements.** `state.nextRootStatements` collects statements to prepend at the file root.
  This is how hoisted macro metadata and plugin results get their own top-level locals.

Because the transformer is authored against a newer TypeScript than roblox-ts bundles, it declares
the compiler internals it uses itself, in
[`src/types/tsInternals.d.ts`](../../packages/transformer/src/types/tsInternals.d.ts), with the two
non-public `TypeFlags` read through
[`src/util/tsInternals.ts`](../../packages/transformer/src/util/tsInternals.ts). That replaced
`ts-expose-internals`, which stopped tracking TypeScript at 5.6.3 and capped the repo to a 2024
compiler.

## Macros

A macro is a function whose declaration carries `@metadata macro` in its JSDoc. When a call to one
is transformed, [`transformUserMacro.ts`](../../packages/transformer/src/transformations/transformUserMacro.ts)
inspects each parameter the caller left out and generates an argument for it.

The parameter's *type* says what to generate. Every macro type is a marker intersection -- a real
type intersected with a hidden property the transformer looks for:

| Marker | Declared as | Produces |
|---|---|---|
| `_flamework_macro_many` | `Modding.Emit<T>` | A runtime value for the type: objects, tuples, unions via `Array<T>`. |
| `_flamework_macro_caller` | `Modding.Caller.*` | Callsite information: line, character, width, text, uuid; `luauLine` reads `debug.info(1, "l")` at the callsite instead of a constant. |
| `_flamework_macro_generic` | `Modding.Target.*` | Information about a type argument: id, text, guard, dependency info. |
| `_flamework_macro_shared_ref` | `Modding.Caller.Constant<T>` | The nested metadata, hoisted to one shared table per callsite. |
| `_flamework_macro_tuple_labels` | `Modding.Target.Labels<T>` | The parameter names of a tuple. |
| `_flamework_macro_hash` | `Modding.Target.Hash` / `Obfuscate` | A hash of a string literal type. |
| `_flamework_intrinsic` | `Modding.Intrinsic<N, M, T>` | Dispatches to a named intrinsic; see below. |

Detection starts at `getUserMacroOfType`, which enters the recursive `getUserMacroOfMany` for `Emit`
types and the shared-ref marker, and otherwise falls through to `getBasicUserMacro` for the caller,
generic and intrinsic markers. The result is a `UserMacro` tree, which `buildUserMacro` turns into
an expression.

Three details are easy to get wrong when changing this:

- **Every argument has to be visited**, not just the ones up to the last generated parameter.
  Arguments beyond it can contain macros of their own; `highestParameterIndex` only decides how far
  to pad with `nil` so a generated parameter lands at the right index.
- **`intrinsic-flamework-rewrite`** redirects the emitted call to a real implementation. It is what
  makes `Flamework.implements`, which is `declare`d and has no runtime value, compile into a call to
  `Flamework._implements`. A `declare`d macro whose macro does not fire compiles cleanly and dies at
  runtime with "attempt to call a nil value" -- that failure mode has accounted for most of the bugs
  found in this area.
- **`Modding.Caller.Constant`** hoists to a file-root local named after the callsite's line, so two
  callsites get two tables and every invocation of one callsite shares a table. Its marker is checked
  before `Emit`'s, because `Constant<Emit<T>>` carries both and finding `Emit` first dropped the
  `Constant`. `Constant` around a basic macro changes nothing, and around `LuauLine` it is an error,
  since that value is read each time the call runs.

### Intrinsics

Intrinsics come in two families that are easy to confuse, because both are called intrinsics and
both live in [`transformations/macros/intrinsics`](../../packages/transformer/src/transformations/macros/intrinsics).

**Type intrinsics** are requested by a parameter's type through `Modding.Intrinsic<N, M, T>` and
dispatched on `macro.id`. They generate the argument:

| Intrinsic | Generates |
|---|---|
| `path` / `pathglob` | Rojo instance path segments for a string-literal directory, which is how `registerProviders("src/services")` finds classes. |
| `obfuscate-obj` | An object whose keys are hashed under the given context. |
| `shuffle-array` | An array with its order randomised at compile time. |
| `tuple-guards` | The fixed and rest guards for a tuple, used for networking argument validation. |
| `plugin` | Whatever a transformer plugin returns; see [The plugin host](#the-plugin-host). |

**Declaration intrinsics** are written in the macro's JSDoc as
`{@link parameterOrTarget intrinsic-name}` and read through `nodeMetadata.getSymbol`. They change
how the call itself is emitted:

| Intrinsic | Does |
|---|---|
| `inline` | Emits the macro's result in place of the call rather than as an argument. |
| `flamework-rewrite` | Redirects the call to a named export of `@flamework/core`, which is what gives a `declare`d macro a runtime target. |
| `const` | Rejects an argument that is not a literal, because the transformer reads it at compile time. |
| `component-config` | Rewrites a `@Component` decorator's config with generated attribute and instance guards, and with the links read off the component's type parameters. |
| `middleware` | Obfuscates event names inside a networking middleware object. |

## Identifiers and guards

**Identifiers** ([`src/util/uid.ts`](../../packages/transformer/src/util/uid.ts)) are how Flamework
names a type at runtime: dependency injection keys, component ids, `Flamework.id<T>()`. An id is
derived from the declaration's file path and name plus a salted hash, with the format controlled by
`idGenerationMode`: `full` (default), `short`, `tiny` and `obfuscated`. Packages must stay on `full`
so their ids do not collide with a game's; only game projects should shorten.

**Guards** ([`src/util/functions/buildGuardFromType.ts`](../../packages/transformer/src/util/functions/buildGuardFromType.ts))
compile a type into a `@rbxts/t` check. Unions become `t.union` (`t.unionList` past two members), tuples `t.strictArray`, arrays
`t.array`, objects `t.interface`, literals `t.literal`, and Roblox datatypes map to their `t` alias.
Types `t` has no alias for compile to `t.typeof("Name")` -- `RBX_TYPES_NEW` is that list, and a type
missing from it silently falls through to the generic object branch and emits a table check, which
is a guard that can never pass.

An instance type intersected with an object type is read as required children:
`Model & { Humanoid: Humanoid }` becomes
`t.intersection(t.instanceIsA("Model"), t.children({ Humanoid: t.instanceIsA("Humanoid") }))`.

## The plugin host

Transformer plugins register additional macro types. A plugin is a CommonJS module that calls
`registerPlugin`; the transformer loads it with `require` and drains a registry keyed by a global
symbol, so two copies of `rbxts-transformer-flamework-plugin` still share registrations.

The host ([`transformations/plugins/pluginHost.ts`](../../packages/transformer/src/transformations/plugins/pluginHost.ts))
gives plugins two facades rather than raw compiler objects:

- [`typeFacade.ts`](../../packages/transformer/src/transformations/plugins/typeFacade.ts) wraps
  `ts.Type` in a small stable API -- fields, call signatures, union members, literal kinds -- cached
  per type.
- [`nodeFactory.ts`](../../packages/transformer/src/transformations/plugins/nodeFactory.ts) builds
  expressions and statements through opaque handles, so a plugin never touches `ts.factory`.

Results are cached per `(macro name, type)` and, unless the result is trivially duplicable, hoisted
to a file-root local, so a macro used twice in a file emits one table and two references to it.

This used to run inside an `isolated-vm` isolate with every compiler object proxied across the
boundary. That was dropped: `isolated-vm` no longer builds against current Node on Windows, and a
transformer plugin is developer-supplied code that already runs with the compiler's privileges, so
the isolate bought no security it did not already have. The API is unchanged; only the serialisation
is gone.

## The module runtime

A module is described by a `ModuleState` -- providers, included modules, plugins, exported ids --
built by `ModuleBuilder` and frozen into a `ModuleDefinition`. Igniting a definition calls
`createModuleInstantiation`, which is a closure, not a class: the `Module` interface is a table of
functions over private state.

### Ignition

Ignition is a state machine (`Created → PreIgniting → Igniting → Ignited`, and
`Extinguishing → Extinguished`) whose transitions are checked, so a re-entrant ignite fails loudly
rather than half-working.

1. Included modules are instantiated. They are keyed by `ModuleState` in a context map shared by the
   whole tree, so including the same definition twice yields one instance.
2. Plugins are instantiated -- one plugin module per module that includes it -- and their hooks and
   interfaces are collected.
3. `PreIgnite` hooks run, sorted by priority and then registration order. This is where a plugin
   registers state that providers will resolve during construction.
4. Every provider is resolved, which constructs it.
5. `PostIgnite` hooks run.

### Resolution

`tryResolveDependency` walks: this module's own providers, then the exports of included modules.
Class providers are constructed by reading `flamework:parameters` off the class, resolving each id,
and calling the constructor. Function providers are invoked with an `InjectionContext` naming the
requesting module and origin class. Alias providers forward to another id.

Resolution during `PreIgniting` is refused: providers do not exist yet, and allowing it would make
construction order depend on hook order.

Every constructed object is passed to `registerClassInterfaces`, which checks its
`flamework:implements` metadata against the interfaces plugins have registered and calls `onAdded`.
`createClassInstance` and `listen` go through the same path, which is why a lifecycle listener does
not have to be a provider.

### Extinguishing

`extinguish` releases the temporary instances the module created, unregisters every provider from
the interfaces it was added to, runs `Extinguished` hooks, and extinguishes the submodules this
module created -- tracked separately from the ones it merely included, so a shared module is not
torn down by whichever includer dies first.

### Reflection

[`reflect.ts`](../../packages/core/src/reflect.ts) is a `WeakMap` from object to property to key to
value, with a `NO_PROP_MARKER` for unscoped metadata. `getOwn*` reads one object; the unprefixed
functions walk the prototype chain via `getmetatable(obj).__index`. `getMetadatas` collects every
value up the chain, nearest first, which is what makes `flamework:implements` aggregate across a
class hierarchy.

The transformer writes this metadata from a decorator's `@metadata reflect ...` list. Which keys a
decorator reflects matters: `Components` reads `flamework:parameters` to discover component
dependencies, so a decorator that does not emit it disables that feature silently.

## Components

`ComponentPlugin` builds a module containing `Components` and a `ComponentModuleConfig` listing the
registered classes, includes `LifecyclePlugin`, and registers a `PostIgnite` hook that calls
`startCollectionService` once the parent module has ignited.

The interesting part is `ComponentTracker`
([`componentTracker.ts`](../../packages/components/src/componentTracker.ts)). Rather than checking
whether an instance qualifies at a point in time, a tracker holds a set of *unmet criteria* per
instance -- the tag, the instance guard, and each component dependency -- and notifies its listeners
whenever that set becomes empty or stops being empty. `Components` registers one listener that adds
the component when the instance qualifies and removes it when it stops.

This is what makes dependencies and streaming work with one mechanism:

- A component that depends on another registers a listener on the dependency's tracker, so it
  qualifies only once the dependency does, in either tag order.
- Under `Watching` (or `Contextual` on a client), the tracker subscribes to `DescendantAdded` and
  re-runs the instance guard on a deferred task, flipping the criterion as the tree fills in or
  breaks apart. Atomic models are exempt under `Contextual` because they replicate whole.

**Links** are the criteria that reach outside the instance. `BaseComponent` carries its type
parameters on three `declare`d properties -- the attributes as declared, the tree as declared, and
the attributes as *written* -- so the transformer can read each for a different purpose: guards come
from the written shape, where an instance-valued attribute is an `InstanceHandle`, and links come
from the declared one, where it is still the Instance or component type it was named as. The
declared-tree property doubles as the brand that tells a component type apart from an Instance type.

Each link is emitted into the decorator config as `{ kind, name, optional, guard?, component? }`.
At runtime `Components` supplies the tracker with two callbacks: `checkLinks`, for an instance
nobody is tracking, where a linked component has to already exist; and `watchLinks`, which
subscribes per link and reports it as met or lost. An attribute link resolves through
`InstanceHandle:Get`, and parks a thread in `InstanceHandle:Wait` when it is empty. A component link
subscribes to the linked component's tracker on the *target* instance, plus that component's
added and removed signals -- removal is announced before the component leaves the active map, so the
removed signal marks the criterion unmet outright rather than asking again. A child link re-resolves
only when the component re-reads its tree at all, which is the same `typeGuardPoll` the instance
guard uses: a child is part of the tree, while an attribute is not and is followed regardless. The subscription tracks
the target with `observeOnly`, which keeps the linked component's tracker from warning about an
instance it is not itself waiting for; the owner's own warning names the link instead.

Polymorphic lookup is a pair of maps from id to component set -- one keyed by instance, one global.
The ids come from `getPolymorphicIds`, which walks the class's parents plus its
`flamework:implements` list, so a component is registered under its own id, every superclass id and
every interface it implements.

## Networking

Networking is two layers, and the split is deliberate:

- `event/` and `function/` are the **primitives**. `createEvent` owns exactly one remote plus its
  middleware processor; `createFunctionSender` and `createFunctionReceiver` implement the
  request/response protocol over two of those events.
- `events/` and `functions/` are the **namespace API** built on top: they take the generated
  metadata, walk it, and build a handler object whose members are the methods you actually call.

### Serialization

With `networking.serialization` enabled in the project config, sending and receiving are asymmetric
on purpose. Sending is a call-site transform (`transformer/src/transformations/transformNetworkingCall.ts`):
a call to `fire`/`except`/`broadcast`/`invoke`/`invokeWithTimeout` (or the handler's call signature)
on a member whose type carries the hidden `_flamework_send` marker has its argument list packed
inline, ahead of the statement, and is rewritten to the member's hidden `_fire`/`_invoke`
counterpart with `(payload, blobs?)`; `setCallback` on a member with `_flamework_result` gets its
callback wrapped so a successful result (a Promise's resolved value included) returns `[payload,
blobs?]`, registered through `_setCallback`. Receiving is metadata: the `network-decoder` intrinsic
resolves to a decoder function per event and function (arguments, results for `predict`, responses);
`createEvent` decodes under `pcall` before the middleware chain, so guards and middleware see plain
values, and a decode failure is reported through `onMalformed`. Functions keep the request id and
process result as plain arguments and pack only the payload after them. No encoder exists as a
runtime value; only decoders do, and a decoder is useless for forging traffic.

The generator is `transformer/src/util/functions/buildSerializerFromType.ts`. It classifies a type
into a kind (number with a width, string with a length prefix, object, union, ...), computes its
layout (fixed size or not, minimum size, whether it has blob slots) and then emits three things:
a size expression, writes and reads. A cursor folds constant offsets at compile time and only
materialises a position variable where a variable-size value forces one. Counts and lengths are
LEB128 varints through three helpers (`vsize`, `vwrite`, `vread`) hoisted once per file. Blobs are
addressed by a u32 index written into the buffer, never by their position in the list; what counts
as a blob is decided structurally (declared by `@rbxts/types`, a `_nominal_` marker, `unknown`,
`object`, a class, an empty object type), not by a list of names. Union members are numbered in
the order they were written: the generator keeps the `UnionTypeNode` it saw a union declared with
(an alias's declaration, or the first property, parameter or type argument) and reads the member
order off it, since TypeScript's own order is by internal type id. Result decoders take the
function type (`network-result-decoder`) so the declared return type node is available for that.
Members declared `Networking.Raw*` get handler types without the hidden markers and `undefined`
decoders through a type-level conditional. `core/src/serialization/types.ts` holds only types: the
brands and the `Serializer`/`Decoder` shapes. `Flamework.createSerializer<T>()` exposes the same
generator through the `serializer` intrinsic.

### Remote ids

The generated metadata carries `incomingIds` and `outgoingIds` per realm, so each side knows what it
receives and what it sends. `createRemoteInstance` finds or creates a folder per global name under
ReplicatedStorage and a remote per id inside it, matching on an `id` attribute rather than the name
-- names are for debugging and may be obfuscated or duplicated.

An **event** uses one remote for both directions, so its id is the bare event name. A **function**
needs two channels, because a request and its response travel over the same remote in opposite
directions, so ids are prefixed: the server receives on `$name` and sends on `@name`, and the client
is the mirror image. Nested namespaces prefix the path (`stats/report`), and unreliable events get
their own `unreliable:` channel on an `UnreliableRemoteEvent`.

The server creates the tree; the client waits for it to replicate, matching by attribute.

### Middleware

`createMiddlewareProcessor` folds a list of factories into a chain, from the back, ending in a
finalize step that fires the handler's BindableEvent. Each factory receives the next processor and
the event's `NetworkInfo` and returns the handler for its link.

Generated argument validation is itself middleware, `unshift`ed to the front of the list, so user
middleware never observes a payload that failed its guards. On an event a rejected payload is simply
dropped; on a function the guard middleware returns `SkipBadRequest`, a distinct sentinel that
`getProcessResult` maps to a `BadRequest` rejection. `Networking.Skip` maps to `Cancelled`.

### The function protocol

A request is `(requestId, ...args)` on the sender's channel. The receiver runs the middleware chain,
then answers `(requestId, processResult, value)` on the same channel in the opposite direction --
`processResult` is `true`, or the error to reject with. The sender keeps a map of pending request ids
per player, resolves the matching promise, and races the whole thing against `Promise.delay` for the
timeout. Return values are validated on the sender's side, which is what produces `InvalidResult`.

When a player leaves, `Players.PlayerRemoving` cancels every request outstanding for them.

## The test harness

The runtime specs run compiled Flamework under [Lune](https://lune-org.github.io/docs), which means
the harness has to be enough of Roblox for the emitted code to run.

**Module loading.** roblox-ts emits `local TS = _G[script]` plus
`TS.import(script, base, ...parts)`, where `base` is an Instance. `harness.luau` models that tree
over the filesystem: every directory and `.luau` file is a node, `TS.import` resolves a node to a
file and loads it with `script` bound in its environment. The tree is built eagerly, because Lune's
`fs` yields and a metamethod cannot. Package manifests are read for `main`, and `types` is aliased
onto it -- roblox-ts derives a nested import path from `types` (`lib/t.d.ts` → `lib.t`) while the
module lives at `main` (`lib/ts.lua`).

**Roblox globals.** `roblox.luau` builds one realm's world: services, `Enum`, `task`, an Instance
emulation with attributes, ancestry and signals, CollectionService, RemoteEvents, Players. `typeof`
is shadowed, because `t.instanceIsA` gates on `typeof(value) == "Instance"` and the harness's
instances are tables. A Heartbeat pump drives `Promise.delay`, which every request timeout is built
on.

**Two graphs.** `harness.create()` returns an independent module graph and `roblox.create(realm)` an
independent world, which is what lets `replication.luau` hold a real server and a real client in one
process. `bridge.luau` mirrors the server's ReplicatedStorage into the client graph and routes
remote traffic between them, deferred like Roblox, with the ability to drop an unreliable message.
The filesystem tree stays shared, so both graphs load byte-identical output and therefore have to
agree on generated remote ids -- identical remote trees on both sides is the assertion that
replication works.

`main.luau` runs the single-realm suites once per realm in separate processes, because a graph
caches realm-dependent decisions at require time.

## Rough edges

- roblox-ts 3.0.0 bundles TypeScript 5.5.3 while the transformer is authored against 5.9.3, so every
  build prints a version warning and compiles with 5.5.3. Harmless -- the declared internals exist in
  both -- but it means the transformer is not actually exercised against the compiler it targets.
- There is no v1 → v2 migration codemod; see [migrating from v1](../guide/10-migrating-from-v1.md).
- `scripts/copy-readme.mjs` copies the root README into every package at publish time, and the root
  README now documents the monorepo's development workflow rather than the framework.
- The plugin host loads plugins with `require` at transform time. A plugin that throws takes the
  build with it, which is intended, but there is no isolation if one misbehaves.
