# 8. Plugins

A **plugin** is a function that sets up a module before it ignites (starts). `LifecyclePlugin` and
`ComponentPlugin` are both ordinary plugins with no special access: anything they do, you can do.

Use a plugin when you want behaviour that applies to *whatever providers exist*, not to one specific
class.

## A minimal plugin

```ts
import { Flamework } from "@flamework-experimental/core";

export const MetricsPlugin = Flamework.createPlugin("Metrics", (target) => {
    const metrics = new Metrics();

    target.provideInstance(metrics); // providers can now inject Metrics
    target.onPostIgnite(() => metrics.start()); // once every provider exists
});
```

```ts
Flamework.createModule().includePlugin(MetricsPlugin).ignite();
```

The setup function runs **once per ignition** of every module that includes the plugin. It receives
`target`, which it uses to set up that module. Anything it creates, like `metrics` above, belongs to
that one ignition. Two modules that include `MetricsPlugin` get one `Metrics` each, and so do two
ignitions of one definition. Nothing is shared unless you deliberately use something from outside
the function.

The name (`"Metrics"`) is used in error messages.

## What a plugin can do

Everything is a method on `target`, and everything registers into the module being set up.

| Method | Does |
|---|---|
| `provideInstance(value)` | Hands the module an object under its type's id. Providers inject it; `resolveDependency` finds it. |
| `registerClassProvider(Class, options?)` | Registers a provider, exactly as the module builder would. |
| `registerProvider<T>(config)` | The same, for a function or alias provider. |
| `registerProviders(path, options?)` / `registerProvidersGlob(glob, options?)` | Registers every `@Provider()` class the ModuleScripts under a folder define, exported or not, as the module builder does. How a plugin ships a folder of providers. |
| `includePlugin(plugin, options?)` | Includes another plugin, set up now, before this one continues. |
| `onPreIgnite(cb, options?)` | Runs `cb` before the module's providers are constructed. |
| `onPostIgnite(cb, options?)` | Runs `cb` after every provider has been constructed. |
| `onIgnited(cb, options?)` | Runs `cb` once ignition has completed; the lifecycle plugin starts the providers here. |
| `onExtinguished(cb, options?)` | Runs `cb` when the module extinguishes. |
| `observe<T>({ onAdded, onRemoved })` | Tells the plugin about every object implementing `T`. |
| `isActive(...conditions)` | Whether something with these [scope conditions](11-scopes.md) is registered in this module, the module's own condition included. |
| `module` | The module itself, for the hooks to close over. It cannot resolve anything until it ignites. |
| `scope` | The module's own scope condition, when `ignite` was given one. For messages; `isActive` already folds it in. |

Every hook receives the module: `target.onPostIgnite((module) => module.resolveDependency<Shop>())`.

The `options` on the registrations and on `includePlugin` are a
[scope condition](11-scopes.md#conditions) (`activeIn`, `inactiveIn`). A plugin that keeps its own
registry of classes, as the components plugin does, has to call `target.isActive(condition)` for
each class it holds. Otherwise its classes ignore the module's condition:

```ts
for (const component of registered) {
	if (target.isActive(registrationScopes.get(component), decoratorScope(component))) {
		active.push(component);
	}
}
```

## Hooks

| Hook | Runs |
|---|---|
| `onPreIgnite` | After every plugin has been set up, **before** the module's providers are constructed. |
| `onPostIgnite` | After every provider has been constructed, and `onInit` has run. The module is still igniting, so an error raised here fails the ignition. |
| `onIgnited` | Once ignition has completed and the module is ignited. The lifecycle plugin calls `onStart` here. An error raised here is only warned about. If the module is extinguished (by an `onStart`, say), the hooks after that one do not run. |
| `onExtinguished` | When `extinguish()` runs, before the providers are released. |

Which one to use:

- `onPreIgnite`: registering state that providers look at while they are constructed.
- `onPostIgnite`: anything that needs the providers to exist.
- `onIgnited`: anything that should only start once the module is fully up, after the providers.

**Nothing can be resolved during setup or `onPreIgnite`.** Providers do not exist yet, and trying
raises `module is in pre-ignite phase, dependency cannot be resolved`.

### Ordering

Hooks of the same phase run in `priority` order, lowest first, then in registration order:

```ts
target.onPostIgnite(() => {}, { priority: HookPriority.First });
```

`HookPriority.First` is `-1000`, `Normal` is `0` (the default), `Last` is `1000`. They are
conventions, not an enum: any number works. They let two plugins order their hooks against each
other without agreeing on magic numbers.

## Observing interfaces

`observe` lets a plugin see every object that implements a type: providers, and anything from
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

`onAdded` fires as each implementing object is constructed. `onRemoved` fires when the object is
released or its module extinguishes. Both are optional. Both get a second argument whose `kind` says
what kind of object it was:

- `"provider"`: one the module constructed, or one a plugin provided.
- `"instance"`: one attached through `createClassInstance` or `listen`.

Matching goes by name, not by shape. A class matches the interfaces listed in its `implements`
clause. The transformer records their ids as metadata, but only on a class that carries a Flamework
decorator, which is why the class needs one for this to work. A class it extends counts too, when
that class carries a Flamework decorator as well: each class's ids are recorded on that class. So a
`@Provider()` that extends an undecorated `abstract class Base implements OnPlayerJoined` is not
matched. Neither is a class that only has the method, without `implements OnPlayerJoined`.

Several plugins may observe the same interface. Each of them is told, in the order the plugins were
included.

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

A plugin reached more than once in one ignition (by the module, by two plugins, or both) is set up
**once**. If `InventoryPlugin` and `ShopPlugin` both include `DatabasePlugin`, there is one
`Connection`. Plugins are told apart by the plugin object, so two libraries that each build their
own database plugin get two.

## Patterns

**Observe plus hook** is the standard shape. The observer collects the objects that implement the
interface, and the hook starts whatever drives them. `LifecyclePlugin` is built exactly this way.

**Provide what other code should reach.** `ComponentPlugin` provides `Components`, so any provider
in the module can inject it.

**Clean up in `onExtinguished`.** Disconnect anything the plugin connected, so a module that
extinguishes leaves nothing running. This is not automatic.

**A plugin is the right answer when the alternative is a global registry.** If you find yourself
writing `SomeRegistry.add(this)` in every provider's constructor, use `observe` instead.

## Caveats

- **No resolving during setup or `onPreIgnite`.** Keep `target.module` for the hooks that run later.
- **Setup runs per ignition.** State at the top level of the plugin's file is shared by every module
  that includes the plugin. State inside the setup function is not. Put it where you mean it.
- **Interfaces need decorated classes.** A plain class with no Flamework decorator carries no
  `implements` metadata and will never match.
- **`onRemoved` fires on extinguish** for every object the plugin was told about. Keep it idempotent.
- **A provider registered by a plugin collides like any other.** The error
  `provider ID was registered more than once` names the id: the module and a plugin, or two plugins,
  registered the same thing.
- **You do not control hook order across *different* modules.** Priority orders hooks within one
  module.

---

Previous: [Macros](07-macros.md) · Next: [Project structure](09-project-structure.md)
