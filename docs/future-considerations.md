# Future considerations

Possible directions for Flamework v2, collected after the September 2026 find-and-fix rounds. Nothing
here is decided or scheduled; each item says what it would change and why it came up.

The main concern behind all of them: **a game should not pay, in performance or memory, for a feature
it does not use.** Runtime extinguishing, lazy providers, links and the like are rare in real games,
yet several fixes made the common path do a little more work so those rare cases stay correct.

## 1. Performance and memory cost of each feature

An estimate from reading the code (September 2026), not a measurement: nothing was run, and the
microsecond and kilobyte figures are rough, order-of-magnitude numbers. It assumes a typical game with a
few hundred providers, 1–5k tagged component instances with streaming bursts, a few dozen busy remotes
and 20–50 players. It read core's lifecycle and module code as committed before the lazy-provider
dependency waiting (rule A) was added. The first step before acting on any of it is a benchmark place
that measures the per-frame loop at 1,000 listeners, the time per received event, add and remove time
for a 1,000-instance burst, and Lua heap per tracked instance. Benchmark with `core.profiling: false`:
Studio profiles by default, so Studio frame times overstate the loops.

### Ranked by impact, highest first

| # | Feature | Estimated cost | Paid when the feature is unused? |
| --- | --- | --- | --- |
| 1 | Per-frame events (`onTick` / `onPhysics` / `onRender`, ticking components included) | ~0.5–1.2 µs per listener per frame (~0.5–1.2 ms per frame at 1,000 listeners); ~70–100 B of garbage per listener per frame from the set copy and a closure | Partly: the set copy and the extinguish and late-provider checks (~15–25% of the loop) serve runtime extinguish and lazy providers |
| 2 | Receiving an event (guard, middleware chain, dispatch) | 3 Promises, 5 coroutines and a BindableEvent dispatch before user code: ~15–40 µs and ~10–12 KB of garbage per event | Yes: mostly Promise plumbing, even with no user middleware |
| 3 | Adding a component (tag, stream-in, eager `getComponent`) | ~10 engine calls and 50–70 tables, ~15–40 µs per add; ~3–6 KB of Lua heap per instance (~15–30 MB at 5k instances) | Partly (see the next table) |
| 4 | Attribute tracking | One `AttributeChanged` connection per instance that fires for any attribute, plus one connection per declared attribute | Yes, even when every attribute has a default and can never go invalid |
| 5 | Removing a component | ~8–20 µs, including scans of the lifecycle plugin's provider lists, which components are never in | Partly |
| 6 | Tree watching (`Watching`, or client `Contextual` for non-atomic models) | 2 connections and ~0.5–1 KB per watched node | No (off by default on the server) |
| 7 | "Waiting for criteria" warning timers | One `task.delay` thread (~1–1.5 KB) per unqualified instance for up to 5 s; streaming bursts pay it for most instances | Yes: a diagnostic that runs in production |
| 8 | Remote function round trip | ~14 Promises, ~50–150 µs and ~40 KB of garbage across both ends | Partly |
| 9 | Polymorphic index (`getComponents` / `getAllComponents` by class or interface) | A Map and 2–4 Sets per instance (~0.3–0.5 KB) | Yes, if those APIs are never called |
| 10 | Links | Every add or remove of class X runs the handler of every link that watches X, anywhere: O(links × adds); ~2–4 KB per link per owner | No |
| 11 | Component constructor dependencies | An observer per dependency per instance (~0.3–0.5 KB) | Partly: every tracker entry carries the holder tables and every add/remove copies them |
| 12 | Re-entrancy guards (Immediate signal behaviour, user re-entry) | About one Set and ~8 hash operations per add or remove (under 1 µs); under Immediate, a `task.defer` per destroyed or unparented tagged instance | Partly: Deferred games pay the table operations, no threads |
| 13 | Observer attachment and refusal rollback | ~1–2 µs per attachment | Yes, for the rollback list |
| 14 | Dependency resolution misses (function providers, imports) | An O(providers) walk per miss (~5–20 µs at 300 providers); function providers are never cached | No |
| 15 | Provider `onInit` / `onStart` machinery | A thread and two wait-map operations per provider `onInit`, ~2–5 µs per provider, once at ignition | Partly: the thread and wait map serve extinguish cycle detection |
| 16 | Ignition | Dominated by requiring the registered ModuleScripts; provider construction is O(providers²) finds (~2–5 ms at 300) | Scopes and imports are nearly free |
| 17 | Component signals (`onComponentAdded` / `onComponentRemoved` / `onAttributeChanged` / `waitForComponent`) | A dispatch per connection; `onAttributeChanged` creates one BindableEvent per component per attribute | No |
| 18 | Sending an event | ~0.5–1 µs on top of the engine's fire; `except` is O(players²) | Argument trimming is ~0.1–0.3 µs |
| 19 | Rename following (`watchRenames`) | O(children) per child added, O(n²) when a model's children stream in one at a time | No (off by default) |
| 20 | Profiling | ~0.5–1 µs per listener per frame | No on live servers |

Considered and negligible: runtime extinguish, imports and lazy providers when unused (only the per-frame
checks in row 1); scopes (judged at ignition); `Dependency<T>()`; serialization off; obfuscation
(compile time only); the testing plugin with its scope off; links, dependencies and rename following
when unused; Immediate handling in a Deferred game (no threads); per-player bookkeeping; per-remote
setup; `createClient`.

### Paid without using the feature, with the cheapest change

| # | Cost | Cheapest change |
| --- | --- | --- |
| 1 | Promise plumbing on every received event or request | When a remote has no user middleware, don't build a middleware processor: run the generated guard as a plain loop and call the final step directly. Removes 3 Promises and 5 coroutines per event. |
| 2 | Set copy and checks in the per-frame loops | A cached array per event, rebuilt only when membership changes; check extinguishing once per frame; skip the late-provider check when there are none. |
| 3 | The attribute criterion | Don't connect it when every guarded attribute has a default; otherwise check only the attribute that changed, synchronously. |
| 4 | `GetFullName` and `GetAttributes` on every add | Build error text only inside the error handler; skip `GetAttributes` when the component declares no attribute guards. |
| 5 | Link and dependency tables in every tracker entry (~0.5 KB per instance) | Allocate them on first use; skip the holders copy when there are none. |
| 6 | The per-instance polymorphic index | Answer lookups from the instance's active components and each class's ids; build global entries lazily. |
| 7 | Metadata walks on every add and remove | Cache attribute guards and implemented interfaces per class. |
| 8 | Warning timers in production | Default `warningTimeout` to 0 outside Studio, or one shared sweeper thread. |
| 9 | Provider-list scans when a component is removed | Return early for components in the lifecycle plugin's remove path. |
| 10 | The observer rollback list | Count successful attachments instead of recording them. |

## 2. Deferred signal behaviour only

Immediate signal behaviour runs every handler inside the write that fired it (`SetAttribute`, `AddTag`,
`RemoveTag`, a `Parent` change), so Flamework's own code is re-entered in the middle of constructing,
removing or announcing a component. Five of the components bugs found in Studio happened only under
Immediate, and one contract (`onComponentRemoved` before or after `destroy`) differs between the modes.
Roblox recommends Deferred.

Its runtime cost is small (read from the code, not measured): a few table operations per component
add or remove, no per-frame work, and no memory that outlives the call. Under Immediate, every real
`Destroy` or unparent of a tagged instance also takes a `task.defer` re-check, one deferred thread per
removal, which only matters in a burst of thousands. Dropping Immediate mainly buys simpler code and
half the test matrix; most guards stay anyway, because user code re-entering from `onStart` or
`destroy` needs them under both modes.

What dropping Immediate could look like:

- **Detect it at ignition.** A script cannot read `workspace.SignalBehavior`, and `Default` still
  behaves as Immediate in existing places. Firing a private `BindableEvent` and checking whether its
  handler has already run when `Fire` returns tells the two apart. Warn once: Flamework supports
  Deferred only.
- **Docs and tests become Deferred-only.** Remove the `immediate` project from the template's test
  matrix and the Immediate model from the Lune harness.
- **Keep the existing guards at first.** They are harmless under Deferred, and some also protect
  against re-entry from user code (a component removing itself from `onStart` re-enters under both
  modes). Remove one only once a measurement shows it costs something and a Studio run shows it is no
  longer needed.
- **One contract per API.** For example, `onComponentRemoved` runs after `destroy`.

A further step, if Immediate must keep working: Flamework defers its own reactions (tag, attribute and
tree handlers only record the change and schedule the work), so it behaves the same under both modes.
That redesigns the components event flow and delays add and remove by one resumption under Immediate.

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
  its end). With an *eager* provider there is no `Module` handle until `ignite()` returns;
  `extinguish()` through an injected `Module` mid-load raises "invalid state … got 'Igniting'" and the
  module stays ignited, and `onStart` runs for a player who already left. Load per-player data from a
  lazy provider, or make the load reject when the player leaves (then `ignite()` raises and the module
  is released).
- **core:** a thread doing an unrelated Promise's work can join a lazy-provider batch: with two
  `async` lazy `onInit`s pending in separate turns, a provider one of them resolves can join the other's
  batch. A lazy provider resolved from any `async` function while another's `async` `onInit` is pending
  waits for that whole `onInit`, and hangs if that `onInit` waits for it.
- **components:** after a linked component is removed by hand, a child that moves elsewhere while its
  owner is down stays watched until a new child of that name arrives.
- **components:** the removal of an invalid component (its `onInit` raised) is not announced, so an
  owner that cleared its own optional link from its constructor is not covered.
- **networking:** a sender created inside the leaving player's own `PlayerRemoving` handler never
  settles an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- **testing:** with obfuscation on, the template's own tests that look events up by their plain names
  fail. The tests are at fault, not the packages.
- **harness:** `ValueBase.Value` and its `Changed` are not modelled; `typeof` of an enum item is
  `"table"`; `GetAttribute` returns the same handle each read; a `task.defer` chain outside a deferred
  batch is not capped at 80.
- **docs:** the harness sections of `docs/reference/internals.md` still describe the old harness.
