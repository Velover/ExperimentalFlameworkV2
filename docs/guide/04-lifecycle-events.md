# 4. Lifecycle events

Lifecycle events come from `LifecyclePlugin`, and every module starts with it included:

```ts
Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();
```

It is an ordinary plugin with no special access. `disableDefaultLifecycle()` on the builder leaves
it out, for a module that wants no per-frame work at all, and including one built with
`createLifecyclePlugin({ … })` takes its place rather than adding a second.

## The events

Implement the interface; the plugin finds you.

```ts
import { OnStart, OnTick, Provider } from "@flamework-experimental/core";

@Provider()
export class Spawner implements OnStart, OnTick {
    public onStart() {
        print("ignited");
    }

    public onTick(dt: number) {
        // every frame, after physics
    }
}
```

| Interface | Method | Fires on |
|---|---|---|
| `OnInit` | `onInit()` | Once, during ignition, in dependency order, before any `onStart`. May return a Promise. |
| `OnStart` | `onStart()` | Once, at the end of ignition. |
| `OnTick` | `onTick(dt)` | `RunService.Heartbeat` |
| `OnPhysics` | `onPhysics(dt, time)` | `RunService.PreSimulation`; `time` is the elapsed game time. |
| `OnRender` | `onRender(dt)` | `RunService.PreRender` -- client only |
| `OnExtinguished` | `onExtinguished()` | `module.extinguish()` |

Within a frame the order is `onPhysics`, then `onTick`, then `onRender`, matching Roblox's own
signal order. `Heartbeat` is the same point of the frame as `PostSimulation` in a running game; it
is used because it also fires where nothing is simulated -- an edit-mode plugin, an Open Cloud
task -- so `onTick` keeps working there. `PreSimulation` has no such alias, so `onPhysics` is
silent in those environments.

There is nothing to register. Flamework checks each constructed object against the interfaces
plugins have claimed, structurally, using metadata the transformer attached -- which is why the
class must carry a Flamework decorator for this to work at all.

## `onInit` in detail

`onInit` is the ordered, awaitable setup step. It runs after every provider has been constructed,
once per provider, **in dependency order**, and everything after it waits:

```ts
@Provider()
class Database implements OnInit {
    public async onInit() {
        await this.connect(); // the next provider's onInit waits for this
    }
}
```

A rejected Promise fails ignition with `onInit failed for '<id>': <reason>`. Because it blocks, keep
it to setup that other providers genuinely depend on; anything else belongs in `onStart`.

Across an import, the order is kept for what a constructor takes **directly**. A provider can take
a lazy provider of a module it imports that is still running its `onInit` -- one that nothing had
resolved until this provider's constructor did, which the import initialises on a turn of its own,
or one resolved earlier that is still loading. Its `onInit` then waits for that one's to finish,
and the ignition waits with it, as for an `onInit` that yields; a provider without an `onInit`
waits the same way, before its `onStart` and per-frame events. Providers that take nothing still
initialising do not wait. If the import begins to extinguish meanwhile, the ignition fails without
running that `onInit` (`'<id>' takes a provider of a module that was extinguished while this module
was igniting`). This
holds wherever the ignition runs, Promise work included (a profile load's `andThen`, an `async`
handler). The one exception is an import's own `onInit` that ignites this module before it yields,
or from a thread it started and has not got back from: what it is itself initialising is not
waited for, since that `onInit` cannot finish before the ignition does, nor a lazy provider of the
import first resolved there, which joins its turn. After it yields -- an `async` `onInit` after an
`await`, a Promise callback -- such an ignition cannot be told apart from one started by unrelated
Promise work, so it waits, and a module that takes a provider whose `onInit` ignites it, or one
that joins that `onInit`'s turn, waits for itself. Such a wait that lasts more than a few seconds
is warned about, once, naming the provider that waits and the one it waits for; the warning can
also come for an ordinary wait on a load that takes that long. Ignite such a module from `onStart`
or a `PlayerAdded` handler instead.

```ts
// in the game module
@Provider({ lazy: true })
class GameStore implements OnInit {
    public async onInit() {
        await this.load();
    }
}

// in a module ignited per player, importing the game module
@Provider()
class PlayerData implements OnInit {
    constructor(private store: GameStore) {}

    public onInit() {
        // GameStore's onInit has finished
    }
}
```

The wait is not transitive: a provider in between that has no pending `onInit` of its own is not
followed. If `PlayerInventory` takes `InventoryService`, which has no `onInit` and takes the
loading `DataStore`, `PlayerInventory` does not wait for `DataStore`. Give the service in between
an `onInit` -- an empty one will do: it waits for `DataStore`, and `PlayerInventory` waits for it --
or have `PlayerInventory` take `DataStore` directly.

```ts
@Provider({ lazy: true })
class InventoryService implements OnInit {
    constructor(private data: DataStore) {}

    public onInit() {} // makes whatever takes this service wait for DataStore too
}
```

## `onStart` in detail

`onStart` runs once per provider, at the end of ignition, **on its own thread**. Two consequences:

- **It may yield.** `task.wait`, `WaitForChild` and network calls are fine; they will not block other
  providers from starting.
- **Order between providers is unspecified.** Do not rely on one provider's `onStart` running before
  another's. If you need ordering, either inject the dependency (its constructor runs first by
  definition) or do the work in a constructor.

Constructors run during ignition, in dependency order, and must **not** yield -- a yielding
constructor stalls ignition.

```ts
@Provider()
class Matchmaker implements OnStart {
    // runs first, synchronously, in dependency order
    constructor(private economy: Economy) {}

    // runs last, on its own thread, order between providers unspecified
    public onStart() {}
}
```

## Ad-hoc listeners

For something that is not a provider -- a UI component, a temporary system -- `module.listen`
attaches a listener and returns a destructor.

```ts
// Full form: an object implementing the interface
const stop = module.listen<OnTick>({
    onTick(dt) {
        print(dt);
    },
});

// Shorthand: a bare function, for single-method interfaces
const stop = module.listen<OnTick>((dt) => print(dt));

stop();
```

`listen` attaches *after* ignition, so `onStart` does **not** fire retroactively for a listener
registered with it. Per-frame events start immediately.

The same applies to anything built with `createClassInstance`: it is attached to the lifecycle
events it implements, and detached by `removeClassInstance` or when the module extinguishes.
Detached means no further event, `onExtinguished` included: an instance that an earlier
`onExtinguished` handler removes is not told.
`onInit` and `onStart` are a provider's: the plugin never runs them for an instance, before or after
ignition; whoever created the instance owns its initialisation and its start.

A **lazy provider** is different: it is a provider, so when it is first resolved after ignition the
plugin runs its `onInit` and `onStart` for it, on the next resume point, in that order. Several
resolved together -- one, and the lazy providers its constructor takes -- go the way eager providers
do: every `onInit` in the order they were resolved, a dependency first, each finished before the
next begins, then every `onStart`. One that one of those `onInit`s resolves, sync or `async`, before
or after it yields, joins them: one resolved on the `onInit`'s own thread, on a thread it started and
has not yet got back from, or, while a Promise the `onInit` returned is pending, on a thread running
Promise work (an `async` body, a Promise executor, an `andThen` callback -- any Promise's, since
which one a thread works for cannot be told). One resolved anywhere else meanwhile -- a thread an
`onInit` spawned counts, once it has yielded -- gets its own turn, and its `onInit` (or, without
one, its `onStart` and per-frame events) waits for
nothing but the `onInit`s still running of the providers its constructor takes directly: one taking a
dependency that another turn is still initialising is initialised once that dependency's `onInit`
has finished, so it never sees that dependency half-initialised (the wait is not transitive; see
`onInit` in detail above). A dependency waiting in turn for what depends on
it hangs both, as with eager providers. One whose `onInit` raises is reported, never ticks and is
never started, and the ones after it, or waiting for it, carry on. One first
resolved while the module is still igniting, by a plugin's `onPostIgnite` hook after the lifecycle
plugin's, waits for ignition to finish, and hears neither if the ignition fails. Its
per-frame events wait for that too: it does not tick before its `onInit` has finished. Once the
module has begun to extinguish neither runs: one first resolved by an `onExtinguished` handler is
told `onExtinguished`, and that is all it hears.

## Components

Components are constructed through the module that includes `ComponentPlugin`, so they take their
per-frame events from **that module's** lifecycle plugin -- the default one, unless the module
disabled it, in which case components do not tick. `onInit` and `onStart` are the exceptions:
`Components` calls both itself, so they work either way. `onInit` runs synchronously, right after
construction and before the component can be seen anywhere -- before `getComponent` hands it back,
before another component receives it through a link, before an added listener hears of it -- and a
Promise it returns is not awaited; a raise leaves the component in place but invalid, hidden from
everything until the tracker rebuilds it. `onStart` runs on its own thread once the component is
attached, and not before ignition has finished: a component built from a provider's `onInit` starts
once every provider has. See [Components](05-components.md#lifecycle).

## Profiling

In Studio, every per-frame callback runs under `debug.profilebegin` and `debug.setmemorycategory`
with the provider's identifier, so providers show up by name in the MicroProfiler and the memory
view. To force it on or off, build the plugin with options instead of using the default:

```ts
import { createLifecyclePlugin } from "@flamework-experimental/core";

Flamework.createModule()
    .includePlugin(createLifecyclePlugin({ profiling: false }))
    .ignite();
```

Including a configured plugin takes the default's place; the module still runs exactly one. The
project-wide default lives in `flamework.config.json` as `core.profiling`; this option overrides it
for one module.

The identifier each object is profiled under is looked up once and remembered until the object
leaves its last lifecycle event, so components that come and go leave nothing behind.

## Asking what is attached

The plugin provides its `LifecycleProvider`, so a module can be asked what it is currently running:

```ts
import { LifecycleProvider } from "@flamework-experimental/core";

const lifecycle = module.resolveDependency<LifecycleProvider>();
print(lifecycle.onTick.size(), "objects are ticking");
```

`onStart`, `onTick`, `onPhysics`, `onRender` and `onExtinguished` are the live sets, one per module.
They are there to be read: the plugin fills and empties them from the interfaces a class implements,
and `listen` is how you attach something by hand.

```ts
@Injectable()
class Countdown implements OnTick {
    public onTick(dt: number) {}
}

const countdown = module.createClassInstance(Countdown); // starts ticking
module.removeClassInstance(countdown); // stops
```

## Patterns

**Constructor for wiring, `onStart` for work.** Take your dependencies in the constructor and do
nothing else there; put anything that yields, waits on replication or touches the world in
`onStart`.

**Guard `OnRender` to the client.** `PreRender` does not fire on the server, so a provider
implementing `OnRender` is simply inert there -- but it is clearer to register it only in the client
module.

**Clean up in `OnExtinguished`.** If a provider opens connections that outlive it -- signals, threads,
Instances -- close them there, so a module that extinguishes leaves nothing behind.

```ts
@Provider()
class Broadcaster implements OnExtinguished {
    private connection = someSignal.Connect(() => {});

    public onExtinguished() {
        this.connection.Disconnect();
    }
}
```

**One listener, many objects.** If you have hundreds of short-lived objects that need a tick, prefer
one provider iterating them over hundreds of `listen` calls.

## Caveats

- **`disableDefaultLifecycle()` is silent.** Nothing complains that `onStart` never ran.
- **One lifecycle plugin per module.** Including a configured one on the builder replaces the
  default; a plugin that includes a second one is refused at ignition, so include it on the module.
- **Order between providers is unspecified** for every event, not just `onStart`. The listener set is
  unordered.
- **`listen` does not replay `onStart`.** It attaches from that moment on.
- **Extinguishing disconnects everything.** The plugin disconnects its `RunService` connections and
  releases the providers, so a dead module stops ticking. This was a bug once; it is covered by a
  spec now. Nothing ticks or starts from the moment `extinguish()` is called, either: not while the
  modules importing it go down first, whose `onExtinguished` handlers may yield.
- **A failing `onExtinguished` does not abort extinguish.** It is warned about and the remaining
  handlers still run, so the module cannot get stuck half-extinguished. The same goes for a
  plugin's extinguished hook.
- **A failing ignition is extinguished.** A raise during ignition -- a constructor, an `onInit`, a
  plugin's hook -- runs the extinguished hooks for what had been set up, so nothing keeps ticking,
  and then comes out of `ignite()`.
- **`onInit` blocks.** A yielding `onInit` delays every provider after it; a rejected Promise fails
  ignition.
- **A yielding constructor stalls ignition**, because construction is synchronous. Yield in
  `onStart`.

---

Previous: [Providers](03-providers.md) · Next: [Components](05-components.md)
