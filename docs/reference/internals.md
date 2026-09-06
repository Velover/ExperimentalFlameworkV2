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

The DataModel is what a tag is announced by, so the DataModel is what the three places that weigh a
tag ask about: the added handler ignores an instance that is not in it, the removed handler stands by
a removal for one that has left it however tagged it still is, and `canCreateComponentEager` refuses
to build for one outside it. `IsDescendantOf(game)` rather than `Parent`, because those are not the
same question: a descendant of a tree that has been pooled by unparenting still has a parent, and it
is announced as untagged along with its ancestor. Reading `Parent` there left such a descendant
holding a component nothing would ever take away -- the tree could then be destroyed outside the
DataModel, where CollectionService announces nothing at all -- and let `getComponent` build a fresh
one for it.

The interesting part is `ComponentTracker`
([`componentTracker.ts`](../../packages/components/src/componentTracker.ts)). Rather than checking
whether an instance qualifies at a point in time, a tracker holds a set of *unmet criteria* per
instance -- the tag, the instance guard, and each component dependency -- and notifies its listeners
whenever that set becomes empty or stops being empty. `Components` registers one listener that adds
the component when the instance qualifies and removes it when it stops.

This is what makes dependencies and streaming work with one mechanism:

- A component that depends on another registers a listener on the dependency's tracker, so it
  qualifies only once the dependency does, in either tag order.
- Under `Watching` (or `Contextual` on a client), the tracker subscribes to the instance's descendant
  signals and re-runs the instance guard on a deferred task, flipping the criterion as the tree fills
  in or breaks apart. Atomic models are exempt under `Contextual` because they replicate whole.

Only one of those two signals is connected at a time: a guard that fails can only be met by the tree
gaining something, and one that passes can only be broken by it losing something. Which of them is
live is derived from the criterion rather than remembered beside it, so every path that writes the
criterion re-points the poll with it -- the poll's own handler, and the re-read a tag performs when
it arrives at an entry a link opened. They are one fact in two places, and writing only the criterion
would leave the poll waiting for the change that has already happened: a guard recorded as failing
while the tree is still watched for a removal can only ever be told that it broke again, so the
component would never be built, and a guard recorded as passing while the tree is still watched for
an addition would leave the component attached to a tree that stopped matching it. The handler is the
same on both connections for the same reason -- it re-reads the guard rather than being told what
moved, so a poll re-pointed while its deferred task was already queued still reports the tree that
task finds.

**Links** are the criteria that reach outside the instance. `BaseComponent` carries its type
parameters on three `declare`d properties -- the attributes as declared, the tree as declared, and
the attributes as *written* -- so the transformer can read each for a different purpose: guards come
from the written shape, where an instance-valued attribute is an `InstanceHandle`, and links come
from the declared one, where it is still the Instance or component type it was named as. The
declared-tree property doubles as the brand that tells a component type apart from an Instance type.

Each link is emitted into the decorator config as `{ kind, name, optional, guard?, component? }`.
At runtime `Components` supplies the tracker with two callbacks: `checkLinks`, for an instance
nobody is tracking, where there is nothing watching and nothing to wait on; and `watchLinks`, which
subscribes per link and reports it as met or lost. An attribute link resolves through
`InstanceHandle:Get`, and parks a thread in `InstanceHandle:Wait` when it is empty. A component link
subscribes to the linked component's tracker on the *target* instance, plus that component's
added and removed signals. The criterion itself is `canCreateComponentEager`, the question
`getComponent` asks on the way in -- the predicate and the ancestry, rather than only the tracker --
with `checkAncestors` on top, because the ancestor lists gate construction Flamework drives and a
link is Flamework driving it. `getComponent` passes it without them, which is what keeps its answer
the same for an instance whether or not a link is watching. Neither excludes a component that is
already attached: the criterion is met by `hasComponent` first, and only asks whether one could be
built when there is none.

`checkLinks` and `linksMet` are the same function, `areLinksMet`, for the same reason: whether
something happens to be tracking an instance must not change the answer given for it. They used to
differ -- an untracked instance's links had to name a component that already existed, rather than one
Flamework would build -- and that is what made `getComponent` refuse a freshly tagged tree while
`resolveLinks`, reading the same tree in the same resumption, built both halves of it. Tag
announcements are deferred, so "tagged but not yet announced" is the ordinary state a spawner leaves
its tree in, and it is exactly the state that answer was wrong for.

Asking whether a link's component could be built can come back round to the question it started
from, because that component's own links are asked in turn: a ring of links, of which one naming its
own component on its own instance is the shortest. `areLinksMet` therefore records the (instance,
component) pairs it is in the middle of, and answers `false` where one arrives a second time --
nothing in such a ring exists yet, so none of it can be built out of nothing. It is the untracked
counterpart of the provisional tracker entry below, which answers the same question the same way for
an instance that has one.

That answer is also what every path a link constructs *through* goes by. Resolving a component for a
link -- filling `attributeComponents` as an attribute is written or re-pointed, and resolving the
links of a component about to be built -- goes through `resolveLinkedComponent`, which takes an
attached component if there is one and otherwise builds one only where `canCreateComponentEager`
with `checkAncestors` says a link may. Reaching for `getComponent` there instead would build the
component the criterion had just refused, under the very ancestor the lists exist to keep it out of.

The guard is part of the criterion rather than a question asked once on the way in: it carries the
whole shape the target has to have, and a target can gain that shape -- or lose it -- long after the
attribute naming it was written. So a link with a guard subscribes to the target's `DescendantAdded`
and `DescendantRemoving` and re-reads the criterion on a deferred task, the same shape the instance
guard's own poll has. This is how a link to a component whose tree fills in late is ever met: without
it the target would have nothing watching it at all, because a failing guard is what kept the
subscription to the linked component's tracker from being made in the first place. Only attribute
links carry a guard; a child's shape is already part of its owner's instance guard.

Removal is announced once the component is out of both lookups, which mirrors an addition being
announced only after it is in them. A link that names the departing component reacts to the
announcement by taking its own component down, and a cycle of links would otherwise come back round
and remove the component the announcement came from a second time, or without end. The engine defers
these signals, so the maps are clear by the time a handler runs there anyway. That deferral is also
why the removed signal identifies the departing component by its class rather than by looking it up:
a component announces its removal under every id it inherits, so a subclass leaving would otherwise
read as its parent leaving.

The same deferral is why the announcement is weighed against the target as it stands when it
arrives, rather than acted on as read. A removal by hand leaves the tag and every criterion alone, so
the resumption that made it can ask for the component again and be handed a new one; the removal is
then delivered about a component that has already been replaced, and the link it claims to have lost
is, on the instance itself, still met. Acting on it takes the other side of a ring down, the rebuild
that follows takes this side down, and each round queues the next -- a place that never settles. So a
link acts on a removal only while the target still carries no component of the class it names, and
`refreshLinkedComponent` moves the owner's `childComponents` or `attributeComponents` entry onto the
component that is there now when the added announcement behind it arrives. Every other path here is
keyed on the *target instance* changing, which this case never does.

Leaving those lookups is only half of "the component has gone", because the eager path would put one
straight back: a removal by hand touches neither the tag nor the tracker, so every criterion still
qualifies while the component is being taken apart. The component is therefore marked as *removing*
for the length of the removal, and `getComponent` and `canCreateComponentEager` answer for it the
way they already answer for one that is still constructing. Without that, a handler reaching for the
component it was just told about is handed a second, freshly built one -- announced to nobody, and
not the one any earlier `getComponent` returned -- and `removeComponent` returns with a component
still attached to the instance it was asked to clear.

A child link re-resolves only when the component re-reads its tree at all, which is the same
`typeGuardPoll` the instance guard uses: a child is part of the tree, while an attribute is not and
is followed regardless. Each link remembers the instance it resolved to and reports itself lost
whenever that changes, undefined at either end included, which is what rebuilds a component around a
swapped child and what keeps an optional link's `childComponents` in step with the tree.

What it starts from is read out of the component, not out of the instance, because a component
outlives the watcher that follows its tree. `getComponent` builds one the moment it is asked for,
while the tag that creates the tracker entry -- and with it these watchers -- is announced a
resumption later, and the tree can move in between. Reading the tree at that point records the swap
as the state the component was built from, and the component runs on against a tree it was never
built out of; the child it holds in `childComponents` is what it *was* built with, so that is the
baseline. A link that does not re-read its tree keeps the child it was built with whatever happens,
so it is seeded with nothing and has nothing to notice.

The other half of that window belongs to the tracker, because an entry is set up before its first
listener is added. A criterion lost while nothing is registered to hear it reaches nobody, and the
listener arriving next is handed the current answer -- "qualified" -- which it answers by handing
back the component that is already there. So an entry remembers a loss nobody heard and replays it to
that listener ahead of the current answer, in the order the two happened: the stale component is
taken down and built again out of the tree as it now stands.

A link attribute's `defaults` entry is read in two places, and only one of them is about the value.
`resolveLinkTarget` falls back to it so that a **required** link resolves at all before the component
exists -- `getAttributes` only runs once one is being built, and a required link would hold that up
forever. `getAttributes` then writes it to the instance as a handle, which is what the component and
every later read see. An optional link needs no standing in, because it holds nothing up, so the
fallback is skipped for it: `nil` on an instance means both "never written" and "cleared", and
answering with the default either way would make clearing an optional link impossible. The write in
`getAttributes` is not conditional on the guard failing for the same reason -- an optional link's
guard accepts a missing attribute, so nothing else would ever write it, and the component's view
would hold a default the instance knew nothing about.

A link attribute the component writes itself goes through the same refresh, because attribute
signals are deferred and the component would otherwise not see its own write until the next
resumption. `refreshAttributes: false` silences the announcement there as it does everywhere else:
the write still lands in `this.attributes` and `attributeComponents`, exactly as a plain attribute's
own write does, and fires no `onAttributeChanged`. It is the only path that could still announce one
with tracking off -- the external re-point is already silent, and the instance's own attribute signal
is not even connected.

What a link reports is a subscription's answer, and a subscription only knows about the changes it
was told about. The engine defers the child signals, so one link can be asked to rebuild the
component while the signal that would have unmet another is still queued behind it; a child renamed
rather than moved fires no signal at all; and a component that does not poll its tree has no
subscription there in the first place. So qualification is *gated* on reading every link again from
the instance -- `linksMet`, which asks per link exactly what `refresh` does, and which the tracker
consults on the flip to qualified. Only then is the component built. That is what makes "never
reports a link met and then fails to build it" true rather than nearly true: `resolveLinks` reads
the same tree a moment later, and raises on any difference.

It is a gate rather than a criterion of its own for two reasons. A criterion it added could only be
cleared by the reading running again, and the reading only runs while the set is empty, so the
component would never come back. And the answer stops mattering the moment the component exists,
which is what leaves a component whose tree is read once still holding the child it was built with
however that tree moves afterwards -- the gate is only ever asked on the way up.

An entry answers `false` while it is still being set up. It starts out qualified and is corrected as
each criterion subscribes, so a question that arrives before that has finished is a question the
setup asked itself: a link naming the very component the entry is for, on the very instance it is
for -- which is what a link attribute pointing at its own instance is. Handing that question the
verdict the entry has not reached yet is exactly the case the gate exists to rule out, one step
earlier: the criterion is met from a value that only means "nothing has said no yet", `resolveLinks`
then asks for a component that is at that moment constructing, and the construction raises out of
the CollectionService handler that started it. Answered `false`, the link is merely unmet.

The subscription tracks the target with `observeOnly`, which keeps the linked component's tracker
from warning about an instance it is not itself waiting for; the owner's own warning names the link
instead. It is passed down to that component's own dependencies as well, which are watched rather
than waited for through the same entry.

A tracker entry therefore separates the listeners that wait from the listeners that only watch, and
the warning belongs to the first group alone. It is armed by the first listener that waits rather
than by whichever one created the entry -- otherwise a link observing an instance first would
silence the warning for the tag that follows it -- and cancelled again as soon as the last of them
goes, however many observers are left holding the entry open. The thread is released as the warning
is said rather than left behind, so an instance that is tagged, untagged and tagged again waits, says
nothing, and waits again.

Arming and disarming both walk the dependency chain, and each entry remembers the listener it
registered on every dependency so that the walk can move that listener between the two groups. A wait
that starts at the top of a chain therefore makes everything under it wait, and a wait that ends
takes the whole chain out of waiting again. Only the arming half would leave the warning of a
component one instance further down the chain announcing what a tag that has since gone was waiting
for, because a link holding the entry open keeps the cleanup that would have unsubscribed from ever
running.

The first listener that waits also re-reads the criteria, when the entry it arrives at had nobody
waiting. Without a link watching, there would be no entry at all and every criterion would be read
then, for the first time; an entry a link created must not answer differently. It is what keeps an
instance guard that failed while the tree was still filling in from being frozen by whoever happened
to look first, on a realm where nothing polls the tree, and therefore what keeps `getComponent`'s
answer the same whether or not something is watching. On a realm that does poll it, the same re-read
is also what re-points the poll: the entry has to keep answering for itself afterwards, not only for
the moment the tag arrived. A tag reaching an entry whose guard started passing unannounced -- a
child renamed rather than moved, which fires no signal at all -- would otherwise leave the poll still
waiting for that child to arrive, and the component attached through every later break in its tree.

`setHasTag` is recorded before the predicate and the ancestor lists rather than after them: the
criterion is a cache of `HasTag` that every entry is answered from, including one a link created for
an instance this component may never be constructed on. Skipping it for a filtered instance is what
would leave such an entry stale, and `getComponent` is then answered from that stale entry.

The tag is not the only criterion an entry caches, so recording it is only half of that job. A
tagged instance the predicate or the ancestor lists turn away never reaches `trackInstance`, and the
re-read above therefore never runs for it: the entry a link created goes on answering with the
instance guard's verdict from before the tree was finished, and on a realm that does not poll the
tree nothing will ever ask again. So both filtered paths re-read the entry themselves before they
return. That is what keeps a link watching an instance under a blocked ancestor from changing
`getComponent`'s answer there -- and with it the escape hatch the ancestor lists leave open, where a
component built on a blocked instance by a `getComponent` of your own satisfies the link that the
lists refused to build one for.

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
materialises a position variable where a variable-size value forces one. Exactly one party moves the
cursor past a union: with a position variable, each branch advances it on its way out, and the
enclosing layout adds nothing; without one, the branches write at literal offsets and the layout
steps over the union itself. Doing both puts everything after the union a union's worth too far
along -- which is what a union whose members all carry nothing (`true | None`, the shape a synced
`Set` takes) used to do inside a collection. A field's name becomes the local its value is read
into, unless that name means something globally: `readonly CFrame: CFrame` would otherwise emit
`const CFrame = new CFrame(...)`, correct once lowered to Luau but rejected by the check the emit
goes through first. Counts and lengths are
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

**`@rbxts/signal` is deferred in the engine, and on request here.** The library wraps a
BindableEvent, so every dispatch through it -- `onComponentAdded`, `onComponentRemoved`,
`onAttributeChanged` -- arrives at the end of the resumption in a real place, and inline in this
harness. Anything a handler reads about the state that fired it may therefore have moved on by the
time the engine delivers it: a link telling its own component's removal from a subclass's has to
identify the component by its class rather than by looking it up, because the lookup only still finds
it here, and a removal can arrive about a component the instance has already replaced.

`__harness.deferSignals(callback)` switches to the engine's behaviour for the duration of the
callback: every BindableEvent fire inside it is queued, and delivered afterwards in order, with fires
made by the queued handlers themselves joining the back of the batch rather than nesting. That last
part is the whole point -- it is what lets a spec show a ring of links removing and rebuilding itself
one round per delivery. It covers `@rbxts/signal` and the harness's own BindableEvents; the tag and
tree signals join the same batch through controls of their own, below.

**One batch, three controls.** The engine has a single deferred queue, and so does the harness: tree
signals, tag signals and BindableEvent dispatch all join it in the order they are raised, and the
batch is delivered once the outermost control returns. Nesting the three is how a spec opens a
resumption's worth of a place -- and the interleaving across categories is the point, because a tag
announcement and the child signal for the same move reach their handlers one after the other, in the
order a place raises them. Draining a queue per category at a scope exit cannot show that at all,
and it is what a place's own sequences are made of: `getComponent` builds a component out of a tree
that then moves, and the tag that starts Flamework watching it is delivered after both. Everything
the batch deferred stays deferred while it is delivered. A batch that will not settle is a place that
never settles, which in Roblox is a frozen server rather than an error, so delivery gives up after
200 dispatches and raises; a spec asserts that its block does *not* raise.

**Tree signals are deferred in the engine, and on request here.** ChildAdded, ChildRemoved and the
descendant pair fire inline in this harness, so a spec's own moves arrive one at a time, in the
order it made them -- which hides every case where a handler runs against a tree that has already
finished moving. `__harness.deferTree(callback)` switches to the engine's behaviour for the duration
of the callback: every tree signal fired inside it joins the batch. It is the counterpart of
`__harness.deferTags`, and it is what lets a spec put a link's rebuild in front of the signal that
would have unmet a different link. An error raised by a queued handler does not stop the rest, and
the first one is re-raised once they have all run, so a spec can assert on what would be a red error
in the output rather than only on the state left behind. It covers the tree signals and nothing else;
`__harness.deferTags` and `__harness.deferSignals` cover the other two categories of the same batch.

**Ancestry announces tags.** CollectionService announces a tag when the instance carrying it enters
the DataModel and again when it leaves, which is a second way for a component to come and go, and one
the harness had no answer for at all: a tagged instance parented out stayed attached here and lost
its component in a real place, so two link specs asserted the opposite of what a place would show.
`instance.luau` now tells each realm's CollectionService which instances crossed the boundary -- the
whole subtree, not only the instance that moved -- and `collection.luau` fires the added or removed
signal for every tag they carry. The order is the engine's: the tag is announced as gone before the
old parent's `ChildRemoved` and as arriving before the new parent's `ChildAdded`, with the move
already applied, so every handler reads the tree as it now stands. A service is the root that marks
the DataModel, which is what tells "parented into Workspace" apart from "parented into a folder
nothing holds"; moving within the DataModel announces nothing, and neither does tagging something
that is not in it. The tag itself never moves -- an instance keeps it through all of this -- so
parenting it back in builds the component again.

**Tags belong to the DataModel, not to the runtime's filters.** `AddTag` and `RemoveTag` announce
nothing for an instance the DataModel does not hold, and `GetTagged` does not list one, which is what
a place does. The harness used to announce them regardless, and only the parentless case was masked,
by a `Parent` check in the runtime -- so a tag applied to a *descendant* of a detached tree built a
component here that a place would not have built, and the specs that looked like they were testing
the rule were testing that filter instead. `Instance:Clone` carries the source's tags across for the
same reason: a tagged template cloned into Workspace is how most tagged instances come to exist, and
dropping the tags made that case untestable. `Instance:Destroy` follows the engine's order too --
`Destroying`, then the parent is nilled (announcing the subtree's tags as gone), then every
connection on the instance is dropped, and only then do the children come apart -- so none of a
destroyed instance's own tree signals reach a handler. Running them, as the harness used to, put a
component's `ChildRemoved` and `DescendantRemoving` handlers against a half-dismantled tree that no
place ever shows them.

**Clean up a tag that can never qualify.** Specs leave their instances in the world on purpose, which
is harmless for anything that qualifies. An instance tagged for a component it can never satisfy is
not: every later spec builds a module that rediscovers it, arms a warning timer for it and cancels
that timer on `extinguish`. Lune holds a cancelled `task.delay` until its deadline, and enough of
them stall the process long after the last spec has passed -- the suite prints its summary and then
hangs, with no failure to point at. A spec that tags something which never qualifies should destroy
it before it ends.

## Rough edges

- roblox-ts 3.0.0 bundles TypeScript 5.5.3 while the transformer is authored against 5.9.3, so every
  build prints a version warning and compiles with 5.5.3. Harmless -- the declared internals exist in
  both -- but it means the transformer is not actually exercised against the compiler it targets.
- There is no v1 → v2 migration codemod; see [migrating from v1](../guide/10-migrating-from-v1.md).
- `scripts/copy-readme.mjs` copies the root README into every package at publish time, and the root
  README now documents the monorepo's development workflow rather than the framework.
- The plugin host loads plugins with `require` at transform time. A plugin that throws takes the
  build with it, which is intended, but there is no isolation if one misbehaves.
