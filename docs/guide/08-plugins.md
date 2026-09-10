# 8. Plugins

A plugin is a function that sets a module up before it ignites. `LifecyclePlugin` and
`ComponentPlugin` are both ordinary plugins with no special access -- anything they do, you can do.

Reach for one when you want behaviour that applies to *whatever providers happen to exist*, rather
than to a specific class.

## A minimal plugin

```ts
import { Flamework } from "@flamework/core";

export const MetricsPlugin = Flamework.createPlugin("Metrics", (target) => {
    const metrics = new Metrics();

    target.provideInstance(metrics); // providers can now inject Metrics
    target.onPostIgnite(() => metrics.start()); // once every provider exists
});
```

```ts
Flamework.createModule().includePlugin(MetricsPlugin).ignite();
```

The setup function runs **once per ignition** of every module that includes the plugin, and it is
handed the module being set up. Anything it creates -- the `metrics` above -- belongs to that one
ignition: two modules including `MetricsPlugin` get one `Metrics` each, and so do two ignitions of one
definition. Nothing is shared unless you close over something outside the function on purpose.

The name is for error messages.

## What a plugin can do

Everything is a method on `target`, and everything registers into the module being set up.

| Method | Does |
|---|---|
| `provideInstance(value)` | Hands the module an object under its type's id. Providers inject it; `resolveDependency` finds it. |
| `registerClassProvider(Class)` | Registers a provider, exactly as the module builder would. |
| `registerProvider<T>(config)` | The same, for a function or alias provider. |
| `includePlugin(plugin)` | Includes another plugin, set up now, before this one continues. |
| `onPreIgnite(cb, options?)` | Runs `cb` before the module's providers are constructed. |
| `onPostIgnite(cb, options?)` | Runs `cb` after every provider has been constructed. |
| `onExtinguished(cb, options?)` | Runs `cb` when the module extinguishes. |
| `observe<T>({ onAdded, onRemoved })` | Tells the plugin about every object implementing `T`. |
| `module` | The module itself, for the hooks to close over. It cannot resolve anything until it ignites. |

Every hook receives the module: `target.onPostIgnite((module) => module.resolveDependency<Shop>())`.

## Hooks

| Hook | Runs |
|---|---|
| `onPreIgnite` | After every plugin has been set up, **before** the module's providers are constructed. |
| `onPostIgnite` | After every provider has been constructed. |
| `onExtinguished` | When `extinguish()` runs, before the providers are released. |

`onPreIgnite` is for registering state that providers will look at while being constructed.
`onPostIgnite` is for anything that needs the providers to exist.

**Nothing can be resolved during setup or `onPreIgnite`** -- providers do not exist yet, and trying
raises `module is in pre-ignite phase, dependency cannot be resolved`.

### Ordering

Hooks of the same phase run in `priority` order, lowest first, then in registration order:

```ts
target.onPostIgnite(() => {}, { priority: HookPriority.First });
```

`HookPriority.First` is `-1000`, `Normal` is `0` (the default), `Last` is `1000`. They are
conventions, not an enum -- any number works. They exist so two plugins can order themselves against
each other without agreeing on magic numbers.

## Observing interfaces

`observe` lets a plugin see every object implementing a type -- providers, and anything from
`createClassInstance` or `listen`.

```ts
interface OnPlayerJoined {
    onPlayerJoined(player: Player): void;
}

export const PlayerPlugin = Flamework.createPlugin("Players", (target) => {
    const listeners = new Set<OnPlayerJoined>();

    target.observe<OnPlayerJoined>({
        onAdded: (value) => listeners.add(value),
        onRemoved: (value) => listeners.delete(value),
    });

    target.onPostIgnite(() => {
        Players.PlayerAdded.Connect((player) => {
            for (const listener of listeners) listener.onPlayerJoined(player);
        });
    });
});
```

Now any provider can opt in:

```ts
@Provider()
class Greeter implements OnPlayerJoined {
    public onPlayerJoined(player: Player) {}
}
```

`onAdded` fires as each implementing object is constructed; `onRemoved` fires when it is released or
its module extinguishes. Both are optional, and both get a second argument saying what kind of
object it was: `"provider"` for one the module constructed or a plugin provided, `"instance"` for one
attached through `createClassInstance` or `listen`.

Matching is structural, using metadata the transformer attached from the class's `implements` clause
-- which is why the class needs a Flamework decorator for this to work.

Several plugins may observe the same interface; each is told, in inclusion order.

## Plugins that need other plugins

A plugin includes what it depends on, and the dependency is set up first:

```ts
export const DatabasePlugin = Flamework.createPlugin("Database", (target) => {
    target.registerClassProvider(Connection);
});

export const InventoryPlugin = Flamework.createPlugin("Inventory", (target) => {
    target.includePlugin(DatabasePlugin); // Connection is registered before this line returns
    target.registerClassProvider(InventoryService);
});
```

A plugin reached more than once in one ignition -- by the module, by two plugins, or both -- is set
up **once**. `InventoryPlugin` and `ShopPlugin` both including `DatabasePlugin` get one `Connection`.
Identity is the plugin object, so two libraries that each build their own database plugin get two.

## Patterns

**Observe plus hook** is the standard shape: the observer collects implementers, the hook starts
whatever drives them. This is exactly how `LifecyclePlugin` is built.

**Provide what consumers should reach.** `ComponentPlugin` provides `Components`, so any provider in
the module can inject it.

**Clean up in `onExtinguished`.** Disconnect anything the plugin connected, so a module that
extinguishes leaves nothing running. This is not automatic.

**A plugin is the right answer when the alternative is a global registry.** If you find yourself
writing `SomeRegistry.add(this)` in every provider's constructor, that is `observe`.

## Caveats

- **No resolving during setup or `onPreIgnite`.** Hold `target.module` for the hooks that run later.
- **Setup runs per ignition.** State at module level is shared by every module that includes the
  plugin; state inside the setup function is not. Put it where you mean it.
- **Interfaces need decorated classes.** A plain class with no Flamework decorator carries no
  `implements` metadata and will never match.
- **`onRemoved` fires on extinguish** for every object the plugin was told about. Keep it idempotent.
- **A provider registered by a plugin collides like any other.** `provider ID was registered more
  than once` names the id; the module and a plugin, or two plugins, registered the same thing.
- **Hook order across *different* modules is not something you control** -- priority orders hooks
  within one module.

---

Previous: [Macros](07-macros.md) · Next: [Project structure](09-project-structure.md)
