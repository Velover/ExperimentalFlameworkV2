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

A **lazy provider** is different: it is a provider, so when it is first resolved after ignition the
plugin runs its `onInit` and `onStart` for it, on the next resume point, in that order.

## Components

Components are constructed through the module that includes `ComponentPlugin`, so they take their
per-frame events from **that module's** lifecycle plugin -- the default one, unless the module
disabled it, in which case components do not tick. `onStart` is the one exception: `Components`
calls it itself, so it works either way.

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
  spec now.
- **A failing `onExtinguished` does not abort extinguish.** It is warned about and the remaining
  handlers still run, so the module cannot get stuck half-extinguished.
- **`onInit` blocks.** A yielding `onInit` delays every provider after it; a rejected Promise fails
  ignition.
- **A yielding constructor stalls ignition**, because construction is synchronous. Yield in
  `onStart`.

---

Previous: [Providers](03-providers.md) · Next: [Components](05-components.md)
