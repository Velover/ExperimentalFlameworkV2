# Changelog

Notable changes to the `@flamework-experimental` packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Upgrade notes

- **Release `core`, `components` and `testing` together.** `core` now starts providers from a new
  `onIgnited` plugin hook, and `components` and `testing` rely on it. A new `core` with an older
  `components` or `testing` (or the reverse) misbehaves.
- **Rebuild networking code with the matching transformer.** The transformer emits a new
  `_setCallback(callback, pack)` shape for receiving functions.
- **Deploy server and client from the same build.** Function remote ids changed for one-way
  functions (see networking below).

### core

#### Added

- `PluginTarget.onIgnited(callback, options?)`: runs once the module is fully ignited, after every
  `onPostIgnite` hook and after its imports know about it. Providers' `onStart` now runs here.

#### Changed

- `onStart` runs only once the module is ignited. Inside it `isIgnited()` is true, `extinguish()`
  works, and modules that import this one can be ignited.
- Providers stop getting `onTick`/`onPhysics`/`onRender` from the moment `extinguish()` is called.
- `extinguish()` on an import waits for an importer that is still extinguishing on another thread,
  so importers finish before the import is released. A wait that would close a cycle, or wait on a
  thread that was cancelled, returns at once instead of deadlocking.
- Lazy providers resolved after ignition get `onInit` and `onStart` only once the module is ignited
  and never after extinguish has begun. Several resolved together run `onInit` in dependency order.
  A lazy provider whose `onInit` raises never ticks or starts.
- An import that is extinguished while an importer is still igniting now fails that importer's
  ignition (`imported module '…' was extinguished while this module was igniting`).

#### Fixed

- A listener attached during a frame made other listeners tick twice or not at all.
- A lazy provider ticked before its `onInit` had finished.
- With profiling on, a provider's memory category leaked onto the thread that called `ignite()`.
- A lazy provider refused by an observer stayed cached and was handed out with no lifecycle events.
- An importer stayed ignited forever when its import was extinguished during its ignition.
- An import was released while an importer's yielding `onExtinguished` was still using it.
- Deadlocks between concurrent extinguishes along an import chain, with a cancelled extinguish
  thread, and when an `onInit` (sync or `async`) extinguished an import during an ignition started
  from `onExtinguished`.
- A lazy provider first resolved during extinguish was released without `onExtinguished`, and could
  get `onInit`/`onStart` after it; an object refused during extinguish was told `onExtinguished`.
- `release` skipped or doubled providers resolved while it ran.
- An object provided under two ids got every event twice.
- A failed ignition sent `onRemoved` for provided instances that never joined.
- Cancelled threads left entries behind in the module-level wait map.

### components

#### Changed

- `onComponentRemoved` runs before `destroy` under Immediate signal behaviour and after it under
  Deferred. The docs said "before" in both; the behaviour is unchanged.
- Removing a dependency by hand, tagged or not, takes its dependents down until the next one is
  built.
- When Flamework removes a component on its own (tree, link, attribute or dependency lost) and its
  `destroy` raises, the error is a warning (`[Flamework] Failed to remove '…' from …`). A hand
  `removeComponent` still raises.
- `getComponent` builds nothing and returns `undefined` once the module has begun to extinguish.
- Under Immediate, `getComponent` for a component still being constructed (e.g. from a handler
  fired by its default-attribute write) returns `undefined`.
- With `watchRenames` on, children ahead of a resolved required child are followed too (one `Name`
  connection each), because a rename there changes which child the name resolves to.

#### Fixed

- A subclass that re-declares its parent's interface was announced twice to `onComponentAdded` /
  `onComponentRemoved`.
- A component that removed itself in `onStart` leaked its maid, was announced as added after its
  removal and was handed to waiters already destroyed; a later waiter could get a component an
  earlier waiter had removed.
- Child links: a child renamed and then removed was missed; with `watchRenames` on, a sibling
  renamed into a taken name was never heard; a replaced child never rebuilt its owner under the
  server's default mode or `Disabled`; a long chain taken down under Deferred left its tail attached.
- Optional attribute links with an Instance default reported themselves met and then raised in
  construction, and their watcher went stale when the owner was taken down.
- Dependencies Flamework will never build (predicate, no tag) counted as met and made construction
  raise; a dependency removed by hand left its dependent holding it; a dependency whose setup raised
  was never released; a dependent's raising `destroy` kept its dependency attached; re-adding a
  component from `onComponentRemoved` left its dependents down.
- A handler fired by a default-attribute write could build a second copy of the component.
- Removing a component's tag during its `onInit` left it attached for good.
- Hand-written `t` instance guards were re-checked only in one direction; their queued poll could
  run after extinguish and raise.
- `getComponent` raised after the module had extinguished.
- Under Immediate, re-adding a tag from `onComponentRemoved` during that tag's own removal left the
  instance tagged with no component; dependents now see a dependency as missing while its removal
  runs, and are rebuilt around the new one when it ends.
- A hand `removeComponent` of a dependency whose own `destroy` raises left its dependent holding it.

### networking

#### Changed

- Every function remote id carries its direction prefix (`$` / `@`), one-way functions included.
- `Cancelled` also answers a request whose callback or middleware promise was cancelled.
- Invoking a player who has left rejects with `Cancelled` at once, with any timeout.
- A timeout of `math.huge` never fires.

#### Fixed

- Event arguments are delivered by reference, so decoded Maps and Sets with non-string keys (players,
  numbers, Vector3s, enums, booleans) reach `connect` intact.
- Argument lists with `undefined` gaps and a trailing `undefined` lost values after the gap, including
  through middleware that names its parameters.
- Under serialization, middleware that returned a plain value broke the call.
- Functions declared to return `Promise<T>` always failed their result guard.
- `predict` before any `connect` threw.
- Invoking a player who had already left kept that Player in memory for good.
- Two concurrent `createClient` calls built two handlers on the same remotes; a cancelled
  `createClient` blocked every later one.
- A one-way function named `$name` shared a remote with a two-way `name`, so both callbacks ran and
  callers got each other's answers.

### transformer

#### Changed

- Receiving networking functions compile to `_setCallback(callback, pack)`; the result is packed after
  the middleware chain. `incomingResults` is gone from the generated metadata.
- The result guard of a function returning `Promise<T>` checks `T`.

### Tests

- The Lune runtime harness now behaves as Roblox Studio does for everything the specs rely on,
  measured in Studio under Immediate and Deferred: signal and tag order, handler errors (printed and
  collected through `__harness.errors()` / `clearErrors()`, and a case fails on an uncleared one),
  deferral and re-entrancy limits, frame order, Bindable argument copying, attribute validation and
  `task` timing.

### Known issues

- core: the `async` `onInit` deadlock fix lets an unrelated thread's `extinguish()` of an import skip
  waiting for an importer that is waiting on a pending `onInit` Promise.
- core: a lazy provider resolved on its own can wait behind another lazy provider's yielding `onInit`,
  and hang if that `onInit` waits for it.
- networking: a sender created inside the leaving player's own `PlayerRemoving` handler never settles
  an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- docs: the harness sections of `docs/reference/internals.md` still describe the old harness.
