# 8. Plugins

A plugin is a module that can also modify the modules it is included in. `LifecyclePlugin` and
`ComponentPlugin` are both ordinary plugins with no special access -- anything they do, you can do.

Reach for one when you want behaviour that applies to *whatever providers happen to exist*, rather
than to a specific class.

## The two things a plugin can do

| | Hook | Interface |
|---|---|---|
| Answers | "run something at this point in the module's life" | "tell me about every object implementing this type" |
| Used for | starting connections, wiring, teardown | lifecycle events, registries, collecting listeners |

## A minimal plugin

```ts
import { Flamework, HookType } from "@flamework/core";

const metricsModule = Flamework.createModule().registerClassProvider(Metrics).build();

export const MetricsPlugin = Flamework.createPlugin(metricsModule)
    .registerHook({
        type: HookType.PostIgnite,
        callback: (context) => {
            context.sourceModule.resolveDependency<Metrics>().start();
        },
    })
    .build();
```

```ts
Flamework.createModule().includePlugin(MetricsPlugin).ignite();
```

A plugin is built from a `ModuleDefinition`, which becomes the plugin's own environment. Its
providers are private to it unless exported.

### `sourceModule` vs `targetModule`

Every hook and interface callback gets both, and confusing them is the usual first bug:

- **`sourceModule`** -- the plugin's own module. Resolve the plugin's providers from here.
- **`targetModule`** -- the module the plugin was included in. This is who the plugin is acting on.

A plugin's module is instantiated **once per module that includes it**, so two modules including
`MetricsPlugin` get one `Metrics` each.

Inside the plugin's own providers, `PluginModule` injects the target:

```ts
@Provider()
class Metrics {
    constructor(private parent: PluginModule) {}
}
```

## Hooks

| Type | Runs |
|---|---|
| `HookType.PreIgnite` | After included modules and plugins have ignited, **before** this module's providers are constructed. |
| `HookType.PostIgnite` | After every provider has been constructed. |
| `HookType.Extinguished` | When `extinguish()` runs. |

`PreIgnite` is for registering state that providers will look at while being constructed.
`PostIgnite` is for anything that needs the providers to exist.

**You cannot resolve dependencies during `PreIgnite`** -- providers do not exist yet, and trying
raises `module is in pre-ignite phase, dependency cannot be resolved`.

### Ordering

Hooks of the same type on the same module run in `priority` order, lowest first, then in registration
order:

```ts
.registerHook({
    type: HookType.PostIgnite,
    callback: (context) => {},
    priority: HookPriority.First,
})
```

`HookPriority.First` is `-1000`, `Normal` is `0` (the default), `Last` is `1000`. They are
conventions, not an enum -- any number works. They exist so two plugins can order themselves against
each other without agreeing on magic numbers.

## Interfaces

An interface lets a plugin observe every object implementing a type -- providers, and anything from
`createClassInstance` or `listen`.

```ts
interface OnPlayerJoined {
    onPlayerJoined(player: Player): void;
}

const listeners = new Set<OnPlayerJoined>();

export const PlayerPlugin = Flamework.createPlugin(Flamework.createModule().build())
    .registerInterface<OnPlayerJoined>({
        onAdded: (context, value) => listeners.add(value),
        onRemoved: (context, value) => listeners.delete(value),
    })
    .registerHook({
        type: HookType.PostIgnite,
        callback: () => {
            Players.PlayerAdded.Connect((player) => {
                for (const listener of listeners) listener.onPlayerJoined(player);
            });
        },
    })
    .build();
```

Now any provider can opt in:

```ts
@Provider()
class Greeter implements OnPlayerJoined {
    public onPlayerJoined(player: Player) {}
}
```

`onAdded` fires as each implementing object is constructed; `onRemoved` fires when it is released or
its module extinguishes. Both are optional.

Matching is structural, using metadata the transformer attached from the class's `implements` clause
-- which is why the class needs a Flamework decorator for this to work.

### Holding the set in a provider

The example above uses a module-level `Set`, which is shared by every module that includes the
plugin. Usually you want one per target module, which is what the plugin's own module is for:

```ts
@Provider()
class Listeners {
    public readonly all = new Set<OnPlayerJoined>();
}

const pluginModule = Flamework.createModule().registerClassProvider(Listeners).build();

Flamework.createPlugin(pluginModule)
    .registerInterface<OnPlayerJoined>({
        onAdded: (context, value) => context.sourceModule.resolveDependency<Listeners>().all.add(value),
        onRemoved: (context, value) => context.sourceModule.resolveDependency<Listeners>().all.delete(value),
    })
    .build();
```

This is exactly how `LifecyclePlugin` is built.

## Patterns

**Interface plus hook** is the standard shape: the interface collects implementers, the hook starts
whatever drives them.

**Export the plugin's provider** if consumers should reach it. `ComponentPlugin` exports `Components`
so that any provider in the target module can inject it:

```ts
Flamework.createModule().registerClassProvider(Components).exportProviders<Components>().build();
```

**Clean up in `Extinguished`.** Disconnect anything the plugin connected, so a module that
extinguishes leaves nothing running. This is not automatic.

**A plugin is the right answer when the alternative is a global registry.** If you find yourself
writing `SomeRegistry.add(this)` in every provider's constructor, that is an interface.

## Caveats

- **`sourceModule` is the plugin, `targetModule` is the consumer.** Resolving the plugin's own
  provider from `targetModule` will not find it.
- **No resolving during `PreIgnite`.**
- **One plugin module per including module.** Do not assume the plugin's providers are global.
- **Interfaces need decorated classes.** A plain class with no Flamework decorator carries no
  `implements` metadata and will never match.
- **`onRemoved` fires on extinguish** for every provider the plugin claimed. Keep it idempotent.
- **Hook order across *different* modules is not something you control** -- priority orders hooks
  within one module.

---

Previous: [Macros](07-macros.md) · Next: [Project structure](09-project-structure.md)
