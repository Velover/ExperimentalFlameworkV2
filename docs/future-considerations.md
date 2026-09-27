# Future considerations

Possible directions for Flamework v2, collected after the September 2026 find-and-fix rounds. The
top-priority item comes first. Nothing else here is scheduled. Section 2 records a decision (Immediate
signal behaviour stays supported); the rest are open, and each item says what it would change and why
it came up.

The main concern behind all of them: **a game should not pay, in performance or memory, for a feature
it does not use.** Runtime extinguishing, lazy providers, links and the like are rare in real games,
yet several fixes made the common path do a little more work so those rare cases stay correct.

## Top priority: `Networking.Serialized`, opting one member into serialization

**The gap.** Serialization is one switch for the whole game (`"networking": { "serialization": true }`
in `flamework.config.json`, off by default). `Networking.Raw` / `RawReliable` / `RawUnreliable` opt a
member *out* while it is on, but nothing opts a member *in* while it is off. A game that already ships
with it off cannot pack only its heavy remotes: turning the switch on changes the wire format of every
remote at once. Dive In is the case that raised it: about 90 remotes, serialization off, and the
owner wants to pack only some of them.

**The proposal.** The mirror of `Raw`: `Networking.Serialized<T>`, `SerializedReliable<T>` and
`SerializedUnreliable<T>` (the last on an `UnreliableRemoteEvent`, like `Unreliable`). With the switch
off, a member marked this way is packed exactly as it would be with the switch on: the encoder at each
call site, the decoder in the `createServer`/`createClient` metadata, the result packer for a
function. With the switch on, the marker changes nothing, and `Raw` still opts out.

**What it touches.**
- The transformer: where it decides per member whether to generate the codec (today the global
  switch minus `Raw`), it also reads the new marker. The generator itself is unchanged.
- networking's types, next to `NetworkRaw`.
- Guide 06 (Serialization, "Opting out per event" becomes "Opting in and out per event"), the
  CHANGELOG and the migration notes.
- Tests: the packed wire format of a marked member with the switch off equals the switch-on format;
  unmarked members stay unpacked; `Raw` wins over the switch; events, functions and unreliable events;
  Studio round trips on both realms.

**Constraints.** Server and client must come from the same build, as for the switch itself.
Changing a member's marker changes its wire format, so it is a coordinated deploy like any protocol
change.

**Not part of it:** compressing the bytes. That is the next item, and builds on this one.

## Next: compressing payloads with `EncodingService:CompressBuffer`

**The idea.** Serialization already writes a compact encoding (sized numbers, variable-length
integers, no field names), but it does not compress. The engine now can: `EncodingService` has
`CompressBuffer(input, algorithm, compressionLevel?)`, `DecompressBuffer(input, algorithm)` and
`GetDecompressedBufferSize(input, algorithm)`, with `Enum.CompressionAlgorithm.Zstd` as the only
algorithm so far. Networking could run a member's packed buffer through it before sending, and back
after receiving, before the guards and middleware see the values.

**How a game would ask for it** (to decide):
- a marker per member, `Networking.Compressed<T>` (with reliable and unreliable forms), which implies
  serialization for that member, since only a buffer can be compressed;
- or a setting on `createServer`/`createClient` or in `flamework.config.json`, with a size threshold:
  compress a payload only above N bytes, with a leading flag byte saying whether it was, so small
  payloads don't grow by Zstd's frame overhead;
- plus the compression level.

**What must hold.**
- Payloads from clients are untrusted. Before decompressing, check `GetDecompressedBufferSize` against
  a limit and drop the payload when the size is unknown or too large, so a small request cannot
  expand into a huge buffer or cost the server a lot of CPU. A payload that fails to decompress is
  dropped like any malformed payload.
- Values that cannot live in a buffer (Instances, `unknown`) keep travelling alongside it,
  uncompressed.
- Server and client come from the same build, and changing a member's compression changes its wire
  format, as with serialization.

**Worth it only where measured.** Zstd pays off on large or repetitive payloads (inventories, map or
save data, long lists) and costs CPU on both ends. Measure bytes on the wire and time per send and
receive in Studio before recommending it, and document the numbers.

**Tests:** round trips for events, functions and unreliable events; the threshold's flag byte; the
decompressed-size limit and a malformed or oversized compressed payload from a client; the
before/after measurements.

## Next: a presence bitmask for optional fields (and booleans)

**The cost today.** The serializer writes 1 presence byte for every optional field (`x?: T`), present
or not, then the value when present; and 1 byte for every boolean
(`packages/transformer/src/util/functions/buildSerializerFromType.ts`). For whole objects that is
still well under Roblox's own table encoding, which spends each present field's name on the wire.
For a sparse object it is not: a raw table skips an absent field entirely, while the serializer
still pays its byte.

**Where it bites: charm-sync patches.** `SyncPatch` makes every field of the synced state optional.
A patch that changes one field of a 40-field player-data object costs 40 presence bytes plus the
value, where the raw table would send only that one key and value. Dive In's player data is that
case.

**The proposal.** Give each object one bitmask, `ceil(n / 8)` bytes for its `n` optional fields,
written before its fields: bit `i` says whether optional field `i` is present, and absent fields
cost nothing else. The 40-field patch above drops from 40 bytes of presence to 5. Booleans can live
in the same mask, one bit each instead of a byte. A union member index or a `T | undefined` argument
could use it too where they sit in the same object.

**What stays the same.** The layout is still known when the game is built: field order, which bit is
which, and the mask's size are all fixed per object type, so the encoder and decoder remain straight-
line generated code with no runtime library. Guards still run on the decoded values.

**Constraints.** It changes the wire format of every serialized object with optional or boolean
fields, so server and client must come from the same build, like any serialization change. The bit
operations cost a little CPU on both ends; measure it.

**Tests:** objects with 0, 1, 7, 8, 9 and 64 optional fields; all present, none present, and
alternating; booleans mixed in; nested objects and arrays of objects, each with its own mask; the
decoded values and guards unchanged; wire sizes before and after, including a charm-sync patch
against the raw table.

## 1. Performance and memory cost of each feature

The table below started as an estimate from reading the code (September 2026). The rows this release
worked on were then measured in Studio, before and after, with `core.profiling: false` (Studio
profiles by default, so Studio frame times overstate the loops). The other figures are still rough,
order-of-magnitude estimates. It assumes a typical game with a few hundred providers, 1–5k tagged
component instances with streaming bursts, a few dozen busy remotes and 20–50 players.

### Ranked by impact, highest first

| # | Feature | Cost | Paid when the feature is unused? |
| --- | --- | --- | --- |
| 1 | Per-frame events (`onTick` / `onPhysics` / `onRender`, ticking components included) | **Measured.** At 1,000 listeners: about 530 µs per frame and no garbage (before this release: about 780 µs and 80 KB per frame; with profiling on, about 1,450 µs and none, before about 1,900 µs and 144 KB) | Barely: one extinguish check per frame, and the late-provider check only when there are late providers |
| 2 | Receiving an event (guard, middleware chain, dispatch) | **Measured.** About 3 µs and 80 B per event, with or without one middleware (before: about 20 µs and 18.5 KB, or about 35 µs and 30 KB with one middleware) | No: plain calls, no Promise, no extra coroutine |
| 3 | Adding a component (tag, stream-in, eager `getComponent`) | **Measured** for an instance with two components: about 4.0 KB of Lua heap kept per instance and 8.1 KB allocated per tag add (before: 6.4 KB and 14.6 KB); about 50 µs per tag add and 24 µs per hand add at 5k | Partly: see "Still paid" below |
| 4 | Attribute tracking | One `AttributeChanged` connection per instance that fires for any attribute, plus one connection per declared attribute | Yes, even when every attribute has a default and can never go invalid |
| 5 | Removing a component | **Measured** at 5k instances: about 20 µs per tag removal and 10 µs by hand (before: about 300 µs, because each removal counted every id's global set) | Partly: the lifecycle plugin's provider-list scans remain |
| 6 | Tree watching (`Watching`, or client `Contextual` for non-atomic models) | 2 connections and ~0.5–1 KB per watched node | No (off by default on the server) |
| 7 | "Waiting for criteria" warning timers | One `task.delay` thread (~1–1.5 KB) per unqualified instance for up to 5 s; streaming bursts pay it for most instances | Yes: a diagnostic that runs in production |
| 8 | Remote function round trip | **Measured.** The caller makes one Promise, about 7.6 µs and 6 KB per invoke; the server about 6 µs and 0.4 KB per request (before: about 33 µs and 20 KB, and about 50 µs and 46 KB). 2,000 concurrent calls settle in about 250 ms instead of 450–470 ms | No |
| 9 | Polymorphic lookups (`getComponents` / `getAllComponents` by class or interface) | No per-instance index any more; `getComponents` walks the instance's own components (about 0.4–0.5 µs) | No |
| 10 | Links | Every add or remove of class X runs the handler of every link that watches X, anywhere: O(links × adds); ~2–4 KB per link per owner | No |
| 11 | Component constructor dependencies | An observer per dependency per instance (~0.3–0.5 KB); tracker tables are made on first use | No |
| 12 | Re-entrancy guards (user re-entry under both modes, Immediate signal behaviour) | About one Set and ~10 hash operations per add or remove (under 1 µs); under Immediate, a `task.defer` per destroyed or unparented tagged instance, per component class | No: Deferred games need the table operations too (user re-entry), and never take the re-check (section 2) |
| 13 | Observer attachment and refusal rollback | **Measured.** Attach plus detach allocates about 840 B (before about 2.25 KB); `Flamework.implements` allocates nothing | No: the rollback is a count |
| 14 | Dependency resolution misses (function providers, imports) | An O(providers) walk per miss (~5–20 µs at 300 providers); function providers are never cached | No |
| 15 | Provider `onInit` / `onStart` machinery | A thread and two wait-map operations per provider `onInit`, ~2–5 µs per provider, once at ignition; a provider whose constructor took nothing still initialising does not wait | Partly: the thread and wait map serve extinguish cycle detection |
| 16 | Ignition | Dominated by requiring the registered ModuleScripts; provider construction is O(providers²) finds (~2–5 ms at 300) | Scopes and imports are nearly free |
| 17 | Component signals (`onComponentAdded` / `onComponentRemoved` / `onAttributeChanged` / `waitForComponent`) | A dispatch per connection; `onAttributeChanged` creates one BindableEvent per component per attribute | No |
| 18 | Sending an event | ~0.5–1 µs on top of the engine's fire; `except` is O(players²) | Argument trimming is ~0.1–0.3 µs |
| 19 | Rename following (`watchRenames`) | O(children) per child added, O(n²) when a model's children stream in one at a time | No (off by default) |
| 20 | Profiling | See row 1 | No on live servers |

Considered and negligible: runtime extinguish, imports and lazy providers when unused; scopes (judged
at ignition); `Dependency<T>()`; serialization off; obfuscation (compile time only); the testing
plugin with its scope off; links, dependencies and rename following when unused; Immediate handling
in a Deferred game (no threads); per-player bookkeeping; per-remote setup; `createClient`.

### Still paid without using the feature, with the cheapest change

Done in this release: Promise plumbing on received events and requests, the per-frame set copy and
closures, error text and metadata walks on every add, eager tracker tables, the per-instance
polymorphic index, the observer rollback list, and the quadratic removal. What is left:

| # | Cost | Cheapest change |
| --- | --- | --- |
| 1 | The attribute criterion | Don't connect it when every guarded attribute has a default; otherwise check only the attribute that changed, synchronously. |
| 2 | Warning timers in production | Default `warningTimeout` to 0 outside Studio, or one shared sweeper thread. |
| 3 | Provider-list scans when a component is removed | Return early for components in the lifecycle plugin's remove path. |
| 4 | `addComponent`'s `try`/`finally` | It compiles to `TS.try` with two closures per add; a `pcall` of a static function would avoid them. |
| 5 | A Maid per component | Created even when the component has no attribute connections; make it on first use. |
| 6 | Each tracker entry's attribute watch | A `deferOnce` object and closures per entry; share one per class, or make them on first use. |
| 7 | `GetAttributes` on every add | Skip it when the component declares no attribute guards. |

## 2. Immediate signal behaviour: kept

Decided in September 2026: Flamework keeps supporting Immediate signal behaviour.

Dropping it was considered because Immediate runs every handler inside the write that fired it
(`SetAttribute`, `AddTag`, `RemoveTag`, a `Parent` change). Flamework's own code is then re-entered in
the middle of constructing, removing or announcing a component. Five of the components bugs found in
Studio happened only under Immediate, and one contract (`onComponentRemoved` before or after `destroy`)
differs between the modes.

Why it stays:

- **Many games run Immediate without choosing it.** Roblox documents `Default` as "currently
  equivalent to `Immediate`", to switch to Deferred at some later point. Only places created from
  Studio's templates are set to Deferred directly. A Rojo-built place whose project file does not set
  `SignalBehavior` gets `Default`, and that is how most roblox-ts games are built. The `default` and
  `streaming` projects of this repository's test place (`tests/place`) are among them.
- **A Deferred game pays almost nothing for it.** This comes from an analysis of the code; the figures
  are estimates, not measurements.
  - **Nearly all of the re-entrancy guards are needed under Deferred too.** They also protect against
    user code calling back into Flamework synchronously, which happens under both modes: the
    constructor, `onInit`, `onStart` (until it yields), `destroy` and `waitForComponent` callbacks all
    run inside Flamework's own work. They cost about 10 table operations and one small Set per
    component add or remove (0.5–1 µs per add and remove, nothing retained).
  - **Only two pieces exist purely for Immediate:**
    - the `task.defer` re-check when a tagged instance is destroyed or unparented, one thread per
      component class on that instance, which is never taken under Deferred;
    - networking's `departedPlayers` set, one insert per player leaving.
  - **Removing the re-check would make components leak silently under Immediate:** `destroy` never
    runs and the component keeps ticking.
  - **Core has nothing Immediate-specific,** and networking's own signal behaves the same in both
    modes.
- **What dropping would buy is maintenance, not speed:**
  - one contract per API (three differ today);
  - about 60–80 lines of docs and 35 of the Lune harness;
  - half the test place's matrix in `tests/place` (8 realm runs down to 4).

  Against that, 118 of the 135 Lune component cases run on the harness's Immediate model and would
  need rework.

Worth doing anyway, and cheap: recommend Deferred in the getting-started guide, and set
`SignalBehavior` to `Deferred` on `Workspace` in the Rojo project of new places. Games then start on
the behaviour Roblox recommends.

If this is reconsidered, for example once Roblox switches `Default` to Deferred:

- **Detect Immediate at ignition.** A script cannot read `workspace.SignalBehavior`. Instead, fire a
  private `BindableEvent` and check whether its handler has already run when `Fire` returns. This costs
  about 10–30 µs, once.
- **Warn rather than error.** An error would break existing Rojo places on upgrade.
- **Keep the destroy re-check until then.**

Not yet checked in Studio:

- Roblox's docs give a deferred re-entrancy limit of 10, while the harness notes record 80 measured in
  Studio.
- Whether `PlayerRemoving` is deferred.
- Whether `AncestryDeferred` would fool the detection above.

## 3. Simpler rules for rarely used features

Most of the complexity came from a few features, each of which produced several bugs. Possible simpler
rules:

| Feature | Bugs it produced | Simpler rule to consider |
| --- | --- | --- |
| Extinguishing modules at runtime, with imports, yielding hooks and several threads | about 10 | An import cannot be extinguished while an importer is extinguishing (raise a clear error instead of waiting); or extinguish does not wait on yielding hooks. Most games ignite once; per-player modules are the main real use. |
| Lazy providers with a full lifecycle after ignition | about 8 | Lazy providers get `onStart` only, or their `onInit` runs synchronously at construction and may not yield. |
| Component constructor dependencies kept exactly in sync | about 7 | Dependents rebuild lazily on the next `getComponent` instead of being re-driven through every add, remove and re-add. |
| Links (child and attribute links, rename following, optional defaults, long chains) | 6 | Drop optional-link defaults and rename following; child links could become plain `getComponent` lookups. |
| Observers that can refuse an attachment (all-or-nothing rollback) | 3 | Observers cannot refuse; an error in `onAdded` warns instead. |

## 4. Testing

- **Studio is the source of truth for engine behaviour.** The Lune harness now matches Studio for
  everything the specs use, but it is a second engine to keep faithful. Keep Lune for pure logic and
  run anything that depends on signal order, deferral, the tree or replication in Studio.
- **Validator rounds find contrived cases once the real bugs are gone.** Later rounds kept finding
  thread interleavings no game writes, and each fix added machinery the next round could attack. Stop
  earlier, and put such cases in section 5 instead.

## 5. Known limits, not being pursued

Edge cases found and deliberately left alone, because the fix would cost more than the case is worth:

- **core:** an unrelated thread's `extinguish()` of an import can skip waiting for an importer that is
  waiting on a pending `async` `onInit` Promise, so the import is released first.
- **core:** if the thread running an `onInit` is cancelled, the `ignite()` that started it waits
  forever.
- **core:** a lazy provider whose `onInit` waits for one of its own dependents hangs, as it would for
  eager providers.
- **core, per-player modules:** checked in Studio (September 2026). A *lazy* per-player data provider
  whose `async` `onInit` is still loading when the player leaves extinguishes cleanly: `extinguish()`
  returns at once, nothing starts or ticks, nothing is left behind (the async body itself still runs to
  its end). With an *eager* provider there is no `Module` handle until `ignite()` returns, and the
  module also stays Igniting while an import's lazy `onInit` that provider takes is still loading;
  `extinguish()` through an injected `Module` mid-load raises "invalid state … got 'Igniting'" and the
  module stays ignited, and `onStart` can run for a player who already left. Load per-player data from
  a lazy provider, or make the load reject when the player leaves (then `ignite()` raises and the
  module is released).
- **core:** a thread doing an unrelated Promise's work can join a lazy-provider batch: with two
  `async` lazy `onInit`s pending in separate turns, a provider one of them resolves can join the other's
  batch. A lazy provider resolved from any `async` function while another's `async` `onInit` is pending
  waits for that whole `onInit`, and hangs if that `onInit` waits for it.
- **core:** dependency waiting is not transitive. A provider waits for the pending `onInit` of the
  providers its constructor takes directly; a provider in between with no pending `onInit` of its own
  is not followed (give it an `onInit`, even an empty one, or take the store directly). A transitive
  wait was considered: the module would record every provider's constructor dependencies, including
  providers that implement no lifecycle event, and the wait would follow them. Not done, to keep the
  lifecycle's waiting simple.
- **core:** an `onInit` that, after it has yielded (an `async` `onInit` after an `await`, or a Promise
  callback), ignites a module taking the provider it initialises waits for itself until the import is
  extinguished, because such a thread cannot be told apart from unrelated Promise work. After 5 s a
  warning names both providers. An ordinary load that is ambiguous in the same way and lasts longer
  than 5 s also warns once, then completes; a networking function's `predict` runs its callback as
  Promise work, so a module it ignites falls in that case. Before any yield, or from a thread the
  `onInit` resumed, it is exempt.
- **core:** a thread that a provider's `onInit` `task.spawn`s synchronously and does not wait for is
  treated as part of that `onInit`: an eager provider ignited on it does not wait and runs before that
  `onInit` ends.
- **core:** an ignition that an import's lazy `onInit` waits for through a path the wait cannot see
  (for example a `task.defer`red ignition it then waits on) hangs. This is the lazy-dependent hang
  above, now also for eager providers and for providers with only `onStart` or per-frame events.
- **core:** a lazy provider with only per-frame events and a constructor dependency ticks one frame
  later than it used to, because it gets a turn; resolved from Promise work while another lazy
  provider's `async` `onInit` is pending, it joins that turn and does not tick until that load ends.
- **core:** on the late path, a turn stops early when a dependency's own module begins to extinguish
  while this one does not; this needs a dependency from a module that is not an import (a function
  provider handing out another module's lazy provider).
- **core:** the refusal rollback counts the observers it told; an `onAdded` that starts observing an
  interface already walked makes the rollback tell the wrong observers.
- **core:** per-frame callbacks are called with trailing `nil` arguments (`onTick(self, dt, nil, …)`);
  only a vararg callback counting `select("#", ...)` sees them.
- **core:** `postIgnite`'s pass over providers without `onInit` that have dependencies rescans its map
  on each step, quadratic in their number; not measurable at normal sizes.
- **core, components, networking:** per-frame callbacks, component `onStart`s and networking handlers
  run on recycled threads. A thread cancelled or closed while parked is dropped, but code that keeps
  the thread it ran on (`coroutine.running()`) and cancels it while it runs another job cuts that job
  short (a networking function request is then never answered: `Timeout`, or never with
  `math.huge`); a stray resume of a parked thread prints `attempt to call a nil value` and ends.
- **components:** after a linked component is removed by hand, a child that moves elsewhere while its
  owner is down stays watched until a new child of that name arrives.
- **components:** the removal of an invalid component (its `onInit` raised) is not announced, so an
  owner that cleared its own optional link from its constructor is not covered.
- **components:** constructions on different threads share one dependency resolver; if one's
  dependency resolution yields (a lazy provider whose constructor yields), the other can resolve its
  later parameters with the first one's instance and metadata.
- **components:** a class with no links of a kind shares one frozen empty `childComponents` /
  `attributeComponents`; a cast write into it raises.
- **components:** a component that keeps its finished `onStart`'s thread and `task.cancel`s it in
  `destroy`, removed synchronously from inside another component's `onStart` running on that recycled
  thread, raises `cannot cancel thread` from `destroy`.
- **networking, destroyed scripts:** the first `connect` of an event in a realm starts listening to
  its remote in a `task.defer` from the connecting thread, so the listener belongs to that script. If
  that script is destroyed, the event stops for every handler on that side, and connecting again
  does not restart it. roblox-ts projects never destroy their scripts, so this is not pursued.
- **networking:** a sender created inside the leaving player's own `PlayerRemoving` handler never
  settles an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- **networking:** a function or middleware result that is a table with a callable `andThen` but no
  Promise metatable is treated as a Promise; the call raises and the caller gets `Unprocessed`.
- **testing:** with obfuscation on, the tests in `tests/place` that look events up by their plain names
  fail. The tests are at fault, not the packages.
- **testing, `flamework-test` windows:** the MCP proxy names a window by its file name only and
  reports no process, so telling a run's own window apart rests on titles and timing:
  - a registered window of the same file name in another case (`Place.Default.rbxl`) makes a run
    wait out the open timeout and then refuse with "has not registered", which is not true; the
    refusal also lists registered same-named windows as unregistered;
  - a titled same-named window that never registers holds a run for the open timeout before it
    refuses; a stale entry of a window that just exited, at the same moment as another same-named
    window opening, could still be mistaken for the run's own;
  - `studio open` takes no claim, so its "connected:" line can name another same-named window (it
    drives nothing);
  - the claim that makes same-named runs take turns lives in the TEMP folder, so runs with another
    TEMP (another user, CI) do not take turns; a claim holding a reused PID or an empty file makes
    the run wait, naming the wrong process, until the 10-minute refusal; two runs taking over one
    stale claim at nearly the same instant can both fail or both hold it.
- **core, path registration of unexported classes:** only classes at a file's top level or in a
  namespace body are recorded against their module, not ones in a top-level `if` or loop body. A
  module that declares its own top-level `script` records its classes against that value. A cloned
  ModuleScript that is required again records its classes a second time, and the record keeps them.
  A new transformer with an older core, or the reverse, silently falls back to exported classes only.
- **core, the explanation of a failed resolution:** it covers only module-level classes that have
  loaded; any other id keeps the plain message. A component that is registered but scoped out is
  explained as "no ComponentPlugin of this module registers it" (Components' own list of skipped
  classes is not consulted). For a plugin-provided class such as `Components` in a module with no
  component plugin, the advice opens with `registerProviders` / `registerClassProvider`, which cannot
  help; "include the plugin that provides it" is further down the same list. Under Lune, "defined in"
  prints `Instance<name>` rather than a full path.
- **transformer, the component diagnostic:** `Dependency<typeof SomeComponent>()` is refused too. A
  function provider registered under a component class's id is refused for constructor injection,
  which has no escape; `Dependency<T>(undefined, id)` is the escape for the macro.
- **core, `loadOrder`:** objects handed over with `provideInstance` join before any provider, so an
  `onInit`/`onStart` on one (none exists today) would precede every `loadOrder`. A lazy provider
  resolved during ignition runs `onInit` where it was resolved, and `onStart` at the default 1.
- **packaging:** the peer range `^2.0.0-alpha.0` stops matching at the first 2.1.0 prerelease; widen
  it when one ships.
- **core, components, left-out folder registrations:** only a registration's own condition keeps its
  folder from loading (a failing inclusion also skips the registrations a plugin's setup makes); the
  module's `ignite` condition, a class's condition and an `includePlugin`
  condition around `ComponentPlugin.fromPath` do not. The explanation of a miss matches a loaded
  class to a left-out folder by its ModuleScript's ancestor names, so a moved or renamed ModuleScript
  (or StarterCharacterScripts) is not matched. It can mislead in unusual setups: a non-provider under
  a left-out folder is told to change the scopes; with the same folder registered twice, or a parent
  left out and a child kept, a loaded non-provider is told nothing under it is registered; a provider
  only re-exported by a left-out folder is told to add its folder; an alias with a missing target or
  a function provider returning nil, in a module with left-out registrations, is said to be
  registered by nothing. An id nothing has loaded gets the list of every left-out registration. In
  the Lune harness, the scope override in force at the builder call decides.
- **transformer, the empty-glob warning:** it is a logger line, not a TypeScript diagnostic, so it has
  no code frame and, in watch mode, prints after "Found 0 errors". A glob that matches only files
  outside the Rojo tree, or only empty folders, registers nothing without a warning. Several empty
  globs in one chain warn in reverse source order. The warnings also print on a build that fails with
  type errors. An element-access call of a glob macro (`builder["registerProvidersGlob"](...)`) is
  not recognised as a macro at all.
- **transformer:** a computed, key-obfuscated networking handler member passed directly to a macro
  (`pass(server[name])`) is a compile error ("must be accessed directly"), as the same expression is
  anywhere else. Callsite uuids depend on the source file's line endings, so one commit checked out
  with CRLF and with LF emits different remote names.
- **transformer, config file and `$schema` line:** a place whose tsconfig is below the package root
  and that has no config file gets no file and no `$schema` line (by design: a created file there
  would hide a shared root one). Once a root place's first build creates the root file, a place
  below with no file of its own reads `.env` from the root instead of its own folder. A place below
  the root with a runtime section writes `include/flamework/config.json` under the package root's
  `include`, and fails with ENOENT when that folder is missing. The line-adding edit keeps the file
  valid but is naive in rare shapes: an unquoted `$schema` key gets a second, quoted one; a symlinked
  config is written through to its target with a path relative to the link; non-UTF-8 bytes become
  U+FFFD; with CR-only line endings the line lands on the brace line; a first line that opens a
  multi-line block comment is skipped. `flamework-test` ignores a tsconfig entry's `configFile`, and
  `rbxtsc --type package` on an unscoped project counts as a game. A killed transformer test run
  can leave `compileProbe`'s `src/<name>.ts` probe files in the fixture.
- **typings:** `@rbxts/types` 1.0.955 has 14 errors of its own under a plain `tsc` without
  `skipLibCheck`. The test-harness hooks are hidden from the typings but still exported by core's and
  testing's Luau. The transformer's `ComponentsRuntimeConfig` type lacks `attributeWarningTimeout`,
  and the schema's default of 5 for it ignores the fallback to `warningTimeout`.
- **harness:** `ValueBase.Value` and its `Changed` are not modelled; `typeof` of an enum item is
  `"table"`; `GetAttribute` returns the same handle each read; a `task.defer` chain outside a deferred
  batch is not capped at 80.
- **docs:** the harness sections of `docs/reference/internals.md` still describe the old harness.
