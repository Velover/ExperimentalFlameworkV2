# 4. Lifecycle events

Lifecycle events are **not built in**. They come from `LifecyclePlugin`, and if you do not include
it, nothing happens and nothing complains:

```ts
import { Flamework, LifecyclePlugin } from "@flamework/core";

Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .registerProviders("src/server/services")
    .ignite();
```

That is the single most common "why isn't my code running" in v2.

## The events

Implement the interface; the plugin finds you.

```ts
import { OnStart, OnTick, Provider } from "@flamework/core";

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
| `OnStart` | `onStart()` | Once, at the end of ignition. |
| `OnTick` | `onTick(dt)` | `RunService.PostSimulation` |
| `OnPhysics` | `onPhysics(dt)` | `RunService.PreSimulation` |
| `OnRender` | `onRender(dt)` | `RunService.PreRender` -- client only |
| `OnExtinguished` | `onExtinguished()` | `module.extinguish()` |

Within a frame the order is `onPhysics`, then `onTick`, then `onRender`, matching Roblox's own
signal order.

There is nothing to register. Flamework checks each constructed object against the interfaces
plugins have claimed, structurally, using metadata the transformer attached -- which is why the
class must carry a Flamework decorator for this to work at all.

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

- **No `LifecyclePlugin`, no events.** Silent failure.
- **Order between providers is unspecified** for every event, not just `onStart`. The listener set is
  unordered.
- **`listen` does not replay `onStart`.** It attaches from that moment on.
- **Extinguishing disconnects everything.** The plugin disconnects its `RunService` connections and
  releases the providers, so a dead module stops ticking. This was a bug once; it is covered by a
  spec now.
- **`onExtinguished` fires for every provider the plugin knows about**, not only the module being
  extinguished, when several modules share one plugin instance. Keep the handler idempotent.
- **A yielding constructor stalls ignition**, because construction is synchronous. Yield in
  `onStart`.

---

Previous: [Providers](03-providers.md) · Next: [Components](05-components.md)
