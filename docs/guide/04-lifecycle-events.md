# 4. Lifecycle events

Lifecycle events are methods, such as `onStart` and `onTick`, that Flamework calls at set points:
on your providers, and also on components and on objects you attach by hand (both covered below).
They come from `LifecyclePlugin`, which every module includes from the start:

```ts
Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();
```

It is an ordinary plugin with no special access. `disableDefaultLifecycle()` on the builder leaves
it out, for a module that wants no per-frame work at all. Including one built with
`createLifecyclePlugin({ … })` replaces it, rather than adding a second.

## The events

Implement the interface, and the plugin finds your class.

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
| `OnInit` | `onInit()` | Once, during ignition, in dependency order and then `loadOrder`, before any `onStart`. May return a Promise. |
| `OnStart` | `onStart()` | Once, at the end of ignition, in `loadOrder`. |
| `OnTick` | `onTick(dt)` | `RunService.Heartbeat` |
| `OnPhysics` | `onPhysics(dt, time)` | `RunService.PreSimulation`; `time` is the elapsed game time. |
| `OnRender` | `onRender(dt)` | `RunService.PreRender` -- client only |
| `OnExtinguished` | `onExtinguished()` | `module.extinguish()` |

The three per-frame events repeat in a fixed cycle: `onPhysics`, then `onTick`, then `onRender`, then
`onPhysics` again. This follows Roblox's task scheduler: `PreSimulation` fires before the physics
simulation, `Heartbeat` after it, and, on the client, `PreRender` before the frame is rendered.

In a running game, `Heartbeat` fires at the same point of the frame as `PostSimulation`. Flamework
uses `Heartbeat` because it also fires where nothing is simulated, such as an edit-mode plugin or an
Open Cloud task, so `onTick` keeps working there. `PreSimulation` has no such alias, so `onPhysics`
does not fire in those environments.

There is nothing to register. Flamework checks each constructed object against the interfaces that
plugins have claimed. The check goes by name, not by shape: a class matches the interfaces listed in
its `implements` clause, which the transformer records as metadata on the class. A class that only
has the method, without `implements OnTick`, is not matched. The metadata is why the class must
carry a Flamework decorator for this to work at all. A parent class's `implements` clause counts
too, but only if the parent carries a Flamework decorator as well. See
[Plugins](08-plugins.md#observing-interfaces).

## `onInit` in detail

`onInit` is the setup step. It runs in order, and it can be awaited. It runs once per provider,
after every provider has been constructed, **in dependency order**, and everything after it waits
for it:

```ts
@Provider()
class Database implements OnInit {
    public async onInit() {
        await this.connect(); // the next provider's onInit waits for this
    }
}
```

A rejected Promise fails ignition with `onInit failed for '<id>': <reason>`. Because `onInit` blocks,
use it only for setup that other providers really depend on. Anything else belongs in `onStart`.

### Across an import

Most of this section only matters when one module imports another (see
[Modules](02-modules.md#importing-a-module)).

A provider can take a lazy provider of a module it imports while that lazy provider is still running
its `onInit`. This happens in two ways:

- Nothing had resolved the lazy provider until this provider's constructor did. The import then
  initialises it on a *turn* of its own: a separate batch in which the lifecycle plugin runs the
  `onInit`s, then the `onStart`s, of lazy providers resolved too late to join ignition's own
  `onInit` step.
- It was resolved earlier and is still loading.

The order is kept for what a constructor takes **directly**. The provider's `onInit` waits for the
lazy provider's `onInit` to finish, and the ignition waits with it, as it does for an `onInit` that
yields. A provider without an `onInit` waits the same way, before its `onStart` and per-frame events.
Providers that take nothing still initialising do not wait.

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

The wait is not transitive: Flamework does not follow a provider in between that has no pending
`onInit` of its own. Say `PlayerInventory` takes `InventoryService`, which has no `onInit` and takes
the loading `DataStore`. Then `PlayerInventory` does not wait for `DataStore`. There are two fixes:

- Give `InventoryService` an `onInit`. An empty one will do: `InventoryService` then waits for
  `DataStore`, and `PlayerInventory` waits for `InventoryService`.
- Have `PlayerInventory` take `DataStore` directly.

```ts
@Provider({ lazy: true })
class InventoryService implements OnInit {
    constructor(private data: DataStore) {}

    public onInit() {} // makes whatever takes this service wait for DataStore too
}
```

If the import begins to extinguish during the wait, the ignition fails without running that `onInit`
(`'<id>' takes a provider of a module that was extinguished while this module was igniting`).

The wait happens wherever the ignition runs, including in Promise work (a profile load's `andThen`,
an `async` handler).

**The one exception: an import's own `onInit` that ignites this module.** This applies when the
`onInit` ignites the module before it yields, or from a thread it started and has not got back
from. The ignition then does not wait for:

- what that `onInit` is itself initialising, since the `onInit` cannot finish before the ignition
  does;
- a lazy provider of the import first resolved there, which joins the `onInit`'s turn.

After the `onInit` yields (an `async` `onInit` after an `await`, or a Promise callback), Flamework
cannot tell such an ignition apart from one started by unrelated Promise work, so it waits. A module
that takes a provider whose `onInit` ignites it, or a provider that joins that `onInit`'s turn, then
waits for itself. If such a wait lasts more than a few seconds, Flamework warns once, naming the
provider that waits and the one it waits for. The warning can also come for an ordinary wait on a
load that takes that long. Ignite such a module from `onStart` or a `PlayerAdded` handler instead.

## `onStart` in detail

`onStart` runs once per provider, at the end of ignition, **on its own thread**. Two consequences:

- **It may yield.** `task.wait`, `WaitForChild` and network calls are fine. They do not stop other
  providers from starting.
- **Order between providers is their `loadOrder`**, and otherwise the order they were constructed in.
  Each one starts on its own thread, so one runs up to its first yield before the next one starts,
  and nothing waits for one that yields. If a provider needs another one *initialised*, inject it:
  the injected provider's `onInit` always finishes first.

Constructors run during ignition, in dependency order, and must **not** yield. A yielding
constructor stalls ignition.

```ts
@Provider()
class Matchmaker implements OnStart {
    // runs first, synchronously, in dependency order
    constructor(private economy: Economy) {}

    // runs last, on its own thread, in loadOrder
    public onStart() {}
}
```

## Load order

`@Provider({ loadOrder })` orders `onInit` and `onStart` among the providers one ignition constructs.
Lower values go first. The default is `1`, as in v1.

- **Construction and `onInit`.** The module constructs its providers in ascending `loadOrder`, each
  one after what its constructor takes, and `onInit` runs in that order. Dependency order wins: a
  provider's dependencies are initialised before it, even when their `loadOrder` is higher. So a low
  `loadOrder` pulls what the provider needs forward with it. Providers with the same `loadOrder` keep
  their registration order.
- **`onStart`** runs in ascending `loadOrder` alone, whatever the dependencies. Among providers with
  the same `loadOrder`, the order is the same as for `onInit`. Each one runs on its own thread up to
  its first yield before the next one starts. So the synchronous setup of a lower `loadOrder` is done
  before a higher one begins, which is what v1 did.
- **Per-frame events** (`onTick`, `onPhysics`, `onRender`) are not ordered. The listener set is
  unordered, and sorting it would cost time every frame.
- **Lazy providers** are not part of the order. A lazy provider starts when it is first resolved,
  and its `loadOrder` is ignored.
- **One module at a time.** An imported module ignites, and starts, before the module that imports
  it, whatever their `loadOrder`s.

```ts
@Provider({ loadOrder: 10 })
class Heavy implements OnInit, OnStart {
    public onInit() {}
    public onStart() {}
}

@Provider({ loadOrder: 0 })
class Needy implements OnInit, OnStart {
    constructor(private heavy: Heavy) {}

    public onInit() {} // after Heavy's: it needs Heavy initialised
    public onStart() {} // first
}

@Provider()
class Plain implements OnInit, OnStart {
    public onInit() {}
    public onStart() {}
}

// onInit:  Heavy, Needy, Plain
// onStart: Needy, Plain, Heavy   (loadOrder alone)
```

## Ad-hoc listeners

For something that is not a provider, such as a UI component or a temporary system, `module.listen`
attaches a listener. It returns a function that detaches the listener again.

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

`listen` attaches *after* ignition, so `onStart` is **not** replayed for a listener attached with it.
Per-frame events start at once.

The same applies to anything built with `createClassInstance`. It is attached to the lifecycle
events it implements, and detached by `removeClassInstance` or when the module extinguishes. Once
detached, it gets no further events, `onExtinguished` included. So an instance that an earlier
`onExtinguished` handler removes is not told.

`onInit` and `onStart` belong to providers. The plugin never runs them for an instance, before or
after ignition. Whoever created the instance is in charge of initialising and starting it.

## Lazy providers

A [lazy provider](03-providers.md#lazy-providers) is different from an instance: it is a provider.
So when it is first resolved after ignition, the plugin runs its `onInit` and then its `onStart`, at
the next resume point.

The plugin runs lazy providers in *turns*. A turn works the way ignition does for eager providers:
it runs every `onInit` in the order the providers were resolved, each one finished before the next
begins, and then every `onStart`. The cases below say which turn a lazy provider joins, what it
waits for, and what happens when something goes wrong:

- **Resolved together.** A lazy provider and the lazy providers its constructor takes share a turn,
  a dependency first.
- **Resolved by one of the turn's `onInit`s.** It joins that turn, whether the `onInit` is sync or
  `async`, and before or after the `onInit` yields. That covers a lazy provider resolved:
  - on the `onInit`'s own thread;
  - on a thread the `onInit` started and has not yet got back from;
  - while a Promise the `onInit` returned is pending, on a thread running Promise work (an `async`
    body, a Promise executor, an `andThen` callback). This counts any Promise's work, since
    Flamework cannot tell which Promise a thread works for.
- **Resolved anywhere else meanwhile.** It gets its own turn. A thread that an `onInit` spawned
  counts as "anywhere else" once it has yielded. Its `onInit` (or, without one, its `onStart` and
  per-frame events) waits only for the `onInit`s still running of the providers its constructor
  takes directly. So if another turn is still initialising one of those dependencies, this provider
  is initialised once that dependency's `onInit` has finished, and never sees it half-initialised.
  The wait is not transitive; see [Across an import](#across-an-import).
- **Waiting in a circle.** A dependency that is itself waiting for what depends on it hangs both, as
  with eager providers.
- **An `onInit` that raises.** The error is reported, and that provider never ticks and is never
  started. The providers after it, or waiting for it, carry on.
- **Resolved while the module is still igniting**, by a plugin's `onPostIgnite` hook that runs after
  the lifecycle plugin's. It waits for ignition to finish, and gets neither `onInit` nor `onStart` if
  the ignition fails. Its per-frame events wait for that too: it does not tick before its `onInit`
  has finished.
- **Once the module has begun to extinguish**, neither `onInit` nor `onStart` runs for a lazy
  provider that has not had them yet, whenever it was resolved. One first resolved by an
  `onExtinguished` handler is told `onExtinguished`, and that is all it hears.

## Components

Components are constructed through the module that includes `ComponentPlugin`. So they get their
per-frame events from **that module's** lifecycle plugin: the default one, unless the module
disabled it, in which case components do not tick. `onInit` and `onStart` are the exceptions:
`Components` calls both itself, so they work either way.

- `onInit` runs synchronously, right after construction, before the component can be seen anywhere:
  before `getComponent` hands it back, before another component receives it through a link, and
  before an added listener hears of it. A Promise it returns is not awaited. If it raises, the
  component stays in place but is invalid, hidden from everything until the tracker rebuilds it.
- `onStart` runs on its own thread once the component is attached, and not before ignition has
  finished. So a component built from a provider's `onInit` starts once every provider has started.

See [Components](05-components.md#lifecycle).

## Profiling

In Studio, every per-frame callback runs under `debug.profilebegin` and `debug.setmemorycategory`,
labelled with the provider's id. So providers show up by name in the MicroProfiler and the memory
view. To force profiling on or off, build the plugin with options instead of using the default:

```ts
import { createLifecyclePlugin } from "@flamework-experimental/core";

Flamework.createModule()
    .includePlugin(createLifecyclePlugin({ profiling: false }))
    .ignite();
```

Including a configured plugin replaces the default, so the module still runs exactly one. The
project-wide default is `core.profiling` in `flamework.config.json`. This option overrides it for one
module.

The id each object is profiled under is looked up once, and remembered until the object leaves its
last lifecycle event. So components that come and go leave nothing behind.

## Asking what is attached

The plugin provides its `LifecycleProvider`, so you can ask a module what it is currently running:

```ts
import { LifecycleProvider } from "@flamework-experimental/core";

const lifecycle = module.resolveDependency<LifecycleProvider>();
print(lifecycle.onTick.size(), "objects are ticking");
```

`onStart`, `onTick`, `onPhysics`, `onRender` and `onExtinguished` are the live sets, one per module.
They are there to be read. The plugin fills and empties them from the interfaces a class implements.
To attach something by hand, use `listen`.

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
nothing else there. Put anything that yields, waits on replication or touches the world in
`onStart`.

**Keep `OnRender` on the client.** `PreRender` does not fire on the server, so a provider
implementing `OnRender` does nothing there. Still, it is clearer to register it only in the client
module.

**Clean up in `OnExtinguished`.** If a provider opens connections that outlive it (signals, threads,
Instances), close them there. Then a module that extinguishes leaves nothing behind.

```ts
@Provider()
class Broadcaster implements OnExtinguished {
    private connection = someSignal.Connect(() => {});

    public onExtinguished() {
        this.connection.Disconnect();
    }
}
```

**One listener, many objects.** If you have hundreds of short-lived objects that need a tick, use one
provider that loops over them rather than hundreds of `listen` calls.

## Caveats

- **`disableDefaultLifecycle()` is silent.** Nothing warns you that `onStart` never ran.
- **One lifecycle plugin per module.** Including a configured one on the builder replaces the
  default. A plugin that includes a second one is refused at ignition, so include it on the module
  instead.
- **Per-frame events are unordered.** `loadOrder` orders `onInit` and `onStart` only; the per-frame
  listener set is unordered.
- **`listen` does not replay `onStart`.** It attaches from that moment on.
- **Extinguishing disconnects everything.** The plugin disconnects its `RunService` connections and
  releases the providers, so a module that has been extinguished stops ticking. (This was once a
  bug; a spec covers it now.) Nothing ticks or starts from the moment `extinguish()` is called. That
  includes the time while the modules importing it go down first, whose `onExtinguished` handlers
  may yield.
- **A failing `onExtinguished` does not abort extinguish.** Flamework warns about it, and the
  remaining handlers still run, so the module cannot get stuck half-extinguished. The same goes for
  a plugin's extinguished hook.
- **A failing ignition is extinguished.** An error raised during ignition (in a constructor, an
  `onInit` or a plugin's hook) first runs the extinguished hooks for what had been set up, so nothing
  keeps ticking. Then the error comes out of `ignite()`.
- **`onInit` blocks.** A yielding `onInit` delays every provider after it. A rejected Promise fails
  ignition.
- **A yielding constructor stalls ignition**, because construction is synchronous. Yield in
  `onStart`.

---

Previous: [Providers](03-providers.md) · Next: [Components](05-components.md)
