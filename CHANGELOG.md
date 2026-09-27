# Changelog

Notable changes to the `@flamework-experimental` packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Upgrade notes

- **Path registration takes every class a module defines, exported or not, as v1 did.** A `@Provider()`
  or `@Component()` class declared at the top level of a module under a registered folder is now
  registered even if the module does not export it. Move a decorated class that must stay out of the
  module to a folder no module registers, or into the function that uses it. `core` and `transformer`
  have to come from this release together: with an older one of either, only exported classes are found.
- **`Dependency<T>()`, `module.resolveDependency<T>()` and a provider's constructor refuse a component
  at compile time.** v1 built any decorated class on demand; v2 resolves registered providers only.
  Make such a class a `@Provider()` (`{ lazy: true }` keeps v1's "built when first asked for"), or get
  the component from `Components`.

### core

#### Added

- `@Provider({ loadOrder })`, v1's ordering of `onInit` and `onStart` within one ignition: lower first,
  default 1, registration order among equals. A provider's dependencies are still constructed and
  initialised before it, whatever their `loadOrder`; `onStart` follows `loadOrder` alone, each on its
  own thread up to its first yield before the next. Lazy providers ignore it, per-frame events stay
  unordered, and an imported module still ignites first. A value that is not a finite number raises
  when the class's module loads.
- Path registration (`registerProviders`, `registerProvidersGlob`, the plugin target's forms,
  `getClassesInPath`, `getClassesInGlob`) finds the classes a module defines at its top level whether
  or not it exports them, each once. Classes are tied to the ModuleScript that defines them, so this
  holds in every `idGenerationMode` and with obfuscation on. A class declared inside a function is
  found only through its module's exports.
- A failed resolution of a class that has loaded says what the class is, where it is defined and what
  to do: a component (get it from `Components`, or make it a `@Provider()`), a `@Provider()` that
  nothing in the module registers or provides, or a class that is not a provider.

#### Changed

- `getClassesInPath` also returns the classes a module does not export: each module's classes in
  definition order, then what it exports. `requireModulesInPath` is unchanged.
- Eager providers are constructed in ascending `loadOrder`; with none set, the order is unchanged.

#### Fixed

- `getClassesInPath` over a package folder returned a class twice when the package also re-exported
  it (`Components` from the components package).

### transformer

#### Added

- Records each class with a Flamework identifier that is declared at the top level of its file, or of
  a namespace in it, against its module (`flamework:module`), for path registration.
- A compile error for `Dependency<T>()`, `module.resolveDependency<T>()` and a `@Provider()`
  constructor parameter whose type is a `@Component()` class that is not a provider.

### components

#### Fixed

- Several `ComponentPlugin`s in one module -- a `fromPath` per folder as guide 09 shows, a `fromGlob`, a
  built one, in any mix -- raised `provider ID was registered more than once: $c:components@Components`
  at ignition. They now share one `Components` per module: every registration ends up in it, a
  component can link to one registered by another plugin, and `Dependency<Components>()` and
  constructor injection get that one. A module that imports another keeps its own `Components` when it
  includes a component plugin, and resolves the import's when it does not.

#### Changed

- `fromPath`, `fromGlob`, `registerComponents` and `registerComponentsGlob` register components their
  modules do not export (see core).
- A link to an unregistered component now raises `… not registered in any ComponentPlugin of this module`.

### components, networking, testing

#### Fixed

- The peer dependency on `@flamework-experimental/core` (and testing's on
  `@flamework-experimental/transformer`) was `*`, which matches no prerelease, so every install of an
  alpha warned about an incorrect peer dependency. It is `^2.0.0-alpha.0` now.

### Tests

- The Studio test place lives in the repository (`tests/place`), linked to the packages' own builds:
  `bun run test:place` builds the packages and runs its suite in Studio under the default,
  immediate, deferred and streaming projects.
- The Lune harness's module tree answers `IsA`, `GetChildren`, `GetDescendants`, `FindFirstChild`,
  `WaitForChild` and `GetFullName`, so specs can register a folder by path.
- The place's providers that cases register in modules of their own moved out of the registered
  `Tests` folders into `src/server/Fixtures`.

## 2026-09-26: core, components, networking and testing 2.0.0-alpha.2; transformer 2.0.0-alpha.3

### Upgrade notes

- **Release `core`, `components` and `testing` together.** `core` now starts providers from a new
  `onIgnited` plugin hook, and `components` and `testing` rely on it. A new `core` with an older
  `components` or `testing` (or the reverse) misbehaves.
- **Rebuild networking code with the matching transformer.** The transformer emits a new
  `_setCallback(callback, pack)` shape for receiving functions.
- **Deploy server and client from the same build.** Function remote ids changed for one-way
  functions (see networking below).
- **Networking middleware: `processNext` returns the next link's result, not a Promise.** A
  middleware that only returns `processNext(...)`, or `await`s it, needs no change. One that chains
  on it, `processNext(...).andThen(f)` (or `.then`/`.catch`/`.finally`), becomes
  `f(processNext(...))`. For an event `processNext` returns nothing; for a function it returns the
  value or `Networking.Skip`.
- **Disconnect networking handlers yourself.** `connect` and `registerHandler` no longer go through
  a BindableEvent, so a handler is not disconnected when the script that connected it is destroyed.
  A script that is destroyed and recreated (a reset-on-spawn `LocalScript`, say) must disconnect its
  handlers, or they pile up and keep running.
- **Networking connections have their own type, `Networking.Connection`.** Code that stores what
  `connect` or `registerHandler` returns as `RBXScriptConnection` still compiles, because the shape
  matches, but it should name `Networking.Connection`, which also offers `Destroy()`. A runtime check
  such as `typeIs(connection, "RBXScriptConnection")` is false for these connections; `typeOf` gives
  `"table"`.

### core

#### Added

- `PluginTarget.onIgnited(callback, options?)`: runs once the module is fully ignited, after every
  `onPostIgnite` hook and after its imports know about it. Providers' `onStart` now runs here.
- A warning when a provider has waited 5 seconds for an `onInit` that may be waiting on that very
  ignition (an `onInit` that, after it has yielded, ignites a module taking what it initialises),
  naming both providers.

#### Changed

- `onStart` runs only once the module is ignited. Inside it `isIgnited()` is true, `extinguish()`
  works, and modules that import this one can be ignited.
- Providers stop getting `onTick`/`onPhysics`/`onRender` from the moment `extinguish()` is called.
- `extinguish()` on an import waits for an importer that is still extinguishing on another thread,
  so importers finish before the import is released. A wait that would close a cycle, or wait on a
  thread that was cancelled, returns at once instead of deadlocking.
- Lazy providers resolved after ignition get `onInit` and `onStart` only once the module is ignited
  and never after extinguish has begun. Several resolved together (one, and the lazy providers its
  constructor takes) run `onInit` in dependency order, and one resolved from inside one of their
  `onInit`s, sync or `async`, joins them. One resolved anywhere else meanwhile gets its own turn:
  its `onInit` waits only for the pending `onInit`s of the providers its constructor takes, and for
  nothing else. A lazy provider whose `onInit` raises never ticks or starts.
- An import that is extinguished while an importer is still igniting now fails that importer's
  ignition (`imported module '…' was extinguished while this module was igniting`).
- Per-frame events (`onTick`/`onPhysics`/`onRender`) walk their listener sets in place and call each
  listener without creating a closure. At 1,000 listeners a frame takes about 30% less time in Studio
  (about 780 → 530 µs, profiling off) and allocates nothing (about 80 KB per frame before, about
  140 KB with profiling on). Delivery rules are unchanged: a listener attached during a frame starts
  on the next, and one detached before its turn is not called.
- What a class implements is computed once per class and cached; this is used on every attach and
  detach and by `Flamework.implements`. Attaching an object no longer records an undo list. Attach
  plus detach allocates about 60% less, and `Flamework.implements` on an instance allocates nothing.

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
- An eager provider whose constructor takes an import's lazy provider that is not initialised yet
  (resolved for the first time by that constructor, or still loading) ran `onInit` and `onStart`
  before that provider's `onInit` had finished, including when its module was ignited from Promise
  work (an `andThen` callback or an `async` function). Its `onInit` now waits for it, and ignition
  waits with it; if the import begins to extinguish meanwhile, the ignition fails without running
  that `onInit` (`'…' takes a provider of a module that was extinguished while this module was
  igniting`).
- A provider without an `onInit` (eager or lazy) got `onStart` and per-frame events before the
  pending `onInit` of a provider its constructor takes had finished; they now wait for it, as an
  `onInit` does.
- A per-frame callback that kept its thread (`coroutine.running()`) and cancelled it after returning
  broke `onTick`/`onPhysics`/`onRender` for every module for good (`cannot spawn non-suspended
  coroutine with arguments`). The recycled thread is now reused only while it is parked.

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
- `getComponents` no longer keeps a lookup per instance: it reads the instance's own components
  against each class's ids, worked out once at registration. Results are the same, in no particular
  order, as before.
- Adding a component allocates and keeps less: attribute guards, the instance check, inherited
  config and whether a class implements `OnInit`/`OnStart` are read once per class; tracker entries
  make their sets on first use; a class with no links of a kind shares one frozen empty
  `childComponents`/`attributeComponents`; `onStart` runs on a recycled thread and its failure
  message is only built on a raise; constructor dependencies resolve through one shared resolver;
  attributes keep no per-component copy of old values. For an instance with two components:
  6.4 → 4.0 KB kept, 14.6 → 8.1 KB allocated per add, adds about 25–35% faster.

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
- Removing components was quadratic in the number attached (each removal counted every id's global
  set): at 5,000 instances a removal cost about 300 µs, now about 10–20 µs.
- Under Immediate signal behaviour, an `onAttributeChanged` handler that wrote the same attribute
  was told a stale old value for that change and the next.

### networking

#### Changed

- Every function remote id carries its direction prefix (`$` / `@`), one-way functions included.
- `Cancelled` also answers a request whose callback or middleware promise was cancelled.
- Invoking a player who has left rejects with `Cancelled` at once, with any timeout.
- A timeout of `math.huge` never fires.
- **Breaking:** middleware `processNext` returns the next link's result instead of a Promise (see
  the upgrade notes). A middleware may still yield or return a Promise; it is waited for in the
  thread handling the message. For a function, a cancelled one reads as `Networking.Skip`.
- Receiving no longer uses Promises: decoding, guards, middleware and the handler or callback run as
  plain calls in the thread that received the message. An event with no middleware costs about 3 µs
  and 80 bytes instead of about 20 µs and 18 KB; a function request costs the server about 6 µs and
  0.4 KB instead of about 50 µs and 46 KB.
- A function call makes a single Promise, the one `invoke`/`invokeWithTimeout` returns. Its timeout
  is a `task.delay`, cancelled when the answer arrives.
- Event handlers run on networking's own signal instead of `@rbxts/signal`:
  - each handler runs at once on a thread of its own, newest connection first, rather than through
    a BindableEvent (which the engine defers under `SignalBehavior.Deferred`);
  - an event's `predict` has called its handlers by the time it returns, unless a middleware yields;
  - `@rbxts/signal` is no longer a dependency of `networking`.
- `connect` and `registerHandler` return `Networking.Connection` (`Connected`, `Disconnect()`,
  `Destroy()`), networking's own connection, not an engine `RBXScriptConnection`.

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
- A predicted function whose callback Promise was cancelled never settled.

### testing

#### Fixed

- `flamework-test` no longer reports a Studio window closed while it is still open, or closes a
  window it did not open. `test` closes the window it opened by the process it started, not by a
  title suffix, which could also match another directory's same-named file and end that window
  instead. It checks the process is gone after the polite and the forced close, and fails with the
  window's PID and title when it is not. It drives only the window it launched: a same-named window
  already listed by the MCP proxy is ignored, and runs of same-named files take turns to open
  theirs. A run that cannot tell its window from another of the same name that is still opening
  refuses and closes its own. A window the run gave up on (e.g. one that never connected) is closed
  unless `--keep`. The earlier-build close only matches a window whose title shows that very file,
  compared ordinally ignoring case, so "Straße" is not "Strasse". Paths and titles reach PowerShell
  as data, so any character in them, including ‘ ’, is taken literally. `studio close` closes
  nothing when several windows share the title.

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

- core: dependency waiting is not transitive. A provider waits for the pending `onInit` of the
  providers its constructor takes directly; a provider in between with no pending `onInit` of its
  own (e.g. a lazy service without `onInit` that takes a lazy store still loading) is not followed.
  Give that service an `onInit` (an empty one is enough) or take the store directly.
- core: an `onInit` that, after it has yielded, ignites a module taking the provider it initialises
  makes that ignition wait for itself until the import is extinguished (the warning above names
  it). Ignite such modules from `onStart` or a `PlayerAdded` handler.
- core: the `async` `onInit` deadlock fix lets an unrelated thread's `extinguish()` of an import skip
  waiting for an importer that is waiting on a pending `onInit` Promise.
- core: while a lazy provider's `onInit` Promise is pending, a lazy provider resolved on any thread
  running Promise work joins its batch, an unrelated Promise's too; one resolved by a thread the
  `onInit`'s executor spawned, after that thread yielded, gets its own turn.
- core, components, networking: per-frame callbacks, component `onStart`s and networking handlers
  run on recycled threads. Code that keeps the thread it ran on (`coroutine.running()`) and cancels
  or resumes it later can cut short or wake another callback that is reusing that thread.
- networking: a sender created inside the leaving player's own `PlayerRemoving` handler never settles
  an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- docs: the harness sections of `docs/reference/internals.md` still describe the old harness.
