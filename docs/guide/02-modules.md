# 2. Modules

A module is two things at once:

1. **A dependency-injection container.** It holds a set of providers, resolves their dependencies
   from each other, and decides which of them the outside world can see.
2. **A lifecycle unit.** It ignites as a whole and extinguishes as a whole.

In v1 there was exactly one, global and implicit. In v2 you create it, which is what makes tests,
tools and libraries possible -- but **most games have exactly one module and never extinguish it**.
If that is you, this page's second half is optional reading.

## The one-module case

```ts
Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .registerProviders("src/server/services")
    .ignite();
```

That is the whole story for a typical game. You do not need `includeModule`, you do not need
`exportProviders`, and you never call `extinguish`.

## The builder

`Flamework.createModule()` returns a `ModuleBuilder`. Every method returns the builder, so it chains.

| Method | Does |
|---|---|
| `registerProviders(path)` | Registers every exported `@Provider()` class under a source folder. |
| `registerClassProvider(Class)` | Registers one class explicitly. |
| `registerProvider<T>(config, id?)` | Registers a class, function or alias provider. |
| `includePlugin(plugin)` | Adds a plugin, which can hook into this module. |
| `includeModule(definition)` | Makes another module's **exported** providers resolvable here. |
| `exportProviders<T \| U>()` | Marks providers as visible to modules that include this one. |
| `setDebugName(name)` | Names the module in error messages. |
| `apply(fn)` | Runs `fn(builder)` without breaking the chain. |
| `build()` | Finalises into a `ModuleDefinition`. |
| `ignite()` | Shorthand for `.build().ignite()`. |

### `build()` vs `ignite()`

`ignite()` is `build().ignite()`. Use `build()` when the module is going to be included in another
one, or ignited later, or ignited more than once:

```ts
// Full form
const definition = Flamework.createModule().registerClassProvider(Economy).build();
const module = definition.ignite();

// Shorthand, when you do not need the definition
const module = Flamework.createModule().registerClassProvider(Economy).ignite();
```

A definition can be ignited repeatedly, and **each ignition gets its own provider instances**. That
is what makes a module a clean unit for tests: build the definition once, ignite a fresh one per
test.

## What ignition does

In order:

1. Included modules are instantiated.
2. Plugins are instantiated -- one plugin module per module that includes it -- and their hooks and
   interfaces are collected.
3. `PreIgnite` hooks run.
4. Every registered provider is constructed, resolving its constructor dependencies.
5. `PostIgnite` hooks run. `LifecyclePlugin` starts its `RunService` connections here, and calls
   `onStart` on everything that implements it.

Providers are constructed lazily *within* step 4 -- resolving a dependency constructs it if it does
not exist yet -- so a provider's constructor can safely use anything injected into it.

## Resolving by hand

```ts
const shop = module.resolveDependency<Shop>();
```

Use this at the boundary between Flamework and code that is not managed by it. Inside a provider,
take a constructor parameter instead.

A provider can also inject the module itself:

```ts
@Provider()
class Registry {
    constructor(private module: Module) {}

    public spawnSession() {
        return this.module.createClassInstance(Session);
    }
}
```

## Tearing down

```ts
module.extinguish();
```

This releases the instances the module created, unregisters them from every plugin that claimed them
(so a lifecycle plugin stops ticking dead providers), runs `Extinguished` hooks, and extinguishes the
modules **it** created -- not the ones it merely included, which may be shared.

Games rarely call this. Tests, plugins, and UI that mounts and unmounts do.

## Several modules

Reach for a second module when you have a genuine boundary:

- **A library** that ships its own providers and wants to expose two of them, not eight.
- **Tests**, where each case needs a fresh container.
- **A tool or plugin** with a lifetime shorter than the game's.
- **Feature isolation**, where you want a compile error if the matchmaking code touches the shop's
  internals.

If none of those apply, one module is the right answer.

### Including and exporting

```ts
const database = Flamework.createModule()
    .registerClassProvider(Connection)
    .registerClassProvider(QueryCache) // not exported: private to this module
    .exportProviders<Connection>()
    .build();

const game = Flamework.createModule()
    .includeModule(database)
    .registerProviders("src/server/services")
    .ignite();

game.resolveDependency<Connection>(); // fine
game.resolveDependency<QueryCache>(); // raises: not exported
```

Export several at once with a union:

```ts
.exportProviders<Connection | Session | Migrations>()
```

Anything in `src/server/services` can now take a `Connection` constructor parameter. Nothing there
can reach `QueryCache`.

### Sharing

An included module is **shared** between everything that includes it under the same root. Two
services that both include `database` get the same `Connection`:

```ts
const a = Flamework.createModule().includeModule(database).build();
const b = Flamework.createModule().includeModule(database).build();

const root = Flamework.createModule().includeModule(a).includeModule(b).ignite();
// one Connection, not two
```

Ignite two separate roots and you get two independent trees, each with its own `Connection`.

## Patterns

**A shared module for cross-realm code.** Build one definition in a shared folder and include it from
both entry points. Each realm ignites its own copy, which is what you want -- they are different
processes.

```ts
// src/shared/coreModule.ts
export const CoreModule = Flamework.createModule()
    .registerProviders("src/shared/services")
    .exportProviders<Config | Logger>()
    .build();
```

**A module per test.** Build the definition once, ignite per case, extinguish after:

```ts
const definition = Flamework.createModule().includePlugin(LifecyclePlugin).registerClassProvider(Shop).build();

const module = definition.ignite();
// ...assert...
module.extinguish();
```

**`apply` for conditional wiring**, so the chain stays readable:

```ts
Flamework.createModule()
    .apply((builder) => (RunService.IsStudio() ? builder.registerClassProvider(DebugTools) : builder))
    .ignite();
```

## Caveats

- **Ignition is a state machine and it is strict.** Igniting a `Module` twice, or extinguishing
  twice, raises `module is in invalid state when transitioning to '...'`. Ignite the *definition*
  again instead if you want a second container.
- **You cannot resolve during `PreIgnite`.** Providers do not exist yet;
  `module is in pre-ignite phase, dependency cannot be resolved` tells you a hook tried. Register
  state in `PreIgnite` and resolve in `PostIgnite`.
- **Exports are per-module, not transitive.** If `a` includes `b`, `a` does not automatically
  re-export `b`'s exports. Include `b` where you need it.
- **`extinguish` does not touch included modules.** They may be shared, so only the modules this one
  created are torn down with it.
- **Duplicate registration raises.** `provider ID was registered more than once` usually means two
  `registerProviders` paths overlap, or a class is registered both by path and by hand.
- **Exporting the same provider twice warns** rather than raising:
  `module already exports the provider '...'`.

---

Previous: [Getting started](01-getting-started.md) · Next: [Providers](03-providers.md)
