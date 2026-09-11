# 2. Modules

A module is two things at once:

1. **A dependency-injection container.** It holds a set of providers and resolves their
   dependencies from each other.
2. **A lifecycle unit.** It ignites as a whole and extinguishes as a whole.

In v1 there was exactly one, global and implicit. In v2 you create it, which is what makes tests and
tools possible -- but **most games have exactly one module per realm and never extinguish it**. If
that is you, this page's second half is optional reading.

## The one-module case

```ts
Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();
```

That is the whole story for a typical game. You never call `build()` or `extinguish`, and
`Dependency<T>()` reaches this module from anywhere.

## The builder

`Flamework.createModule()` returns a `ModuleBuilder`. Every method returns the builder, so it chains.

| Method | Does |
|---|---|
| `registerProviders(path)` | Registers every exported `@Provider()` class under a source folder. |
| `registerProvidersGlob(glob)` | The same, for every folder a compile-time glob matches. |
| `registerClassProvider(Class)` | Registers one class explicitly. |
| `registerProvider<T>(config, id?)` | Registers a class, function or alias provider. |
| `includePlugin(plugin)` | Adds a plugin, which can hook into this module. |
| `disableDefaultLifecycle()` | Leaves out the `LifecyclePlugin` every module starts with. |
| `setDebugName(name)` | Names the module in error messages. |
| `apply(fn)` | Runs `fn(builder)` without breaking the chain. |
| `build()` | Finalises into a `ModuleDefinition`. |
| `ignite(options?)` | Shorthand for `.build().ignite()`. `{ default: true }` makes this the module `Dependency<T>()` answers from. |

### `build()` vs `ignite()`

`ignite()` is `build().ignite()`. Use `build()` when the module is going to be ignited later, or more
than once:

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

1. Plugins are set up -- each one's setup function runs against this module, registering providers,
   hooks and observers into it. A plugin reached twice is set up once.
2. `onPreIgnite` hooks run.
3. Every registered provider is constructed, resolving its constructor dependencies.
4. `onPostIgnite` hooks run. `LifecyclePlugin` starts its `RunService` connections here, and calls
   `onStart` on everything that implements it.

Providers are constructed lazily *within* step 3 -- resolving a dependency constructs it if it does
not exist yet -- so a provider's constructor can safely use anything injected into it.

## Resolving by hand

```ts
const shop = module.resolveDependency<Shop>();
```

Use this at the boundary between Flamework and code that is not managed by it. Inside a provider,
take a constructor parameter instead.

When there is no module handle to hand -- a UI component, a script, a callback registered with
something outside Flamework -- `Dependency<T>()` resolves against the **default module**:

```ts
import { Dependency } from "@flamework-experimental/core";

const shop = Dependency<Shop>();
```

The first root module ignited in a realm is the default, which for a game is the one the entry point
ignites. Pass `{ default: true }` to make a later one the default instead:

```ts
const module = definition.ignite({ default: true });
```

Extinguishing the default releases it, so the next root ignited claims it -- a test that ignites and
extinguishes per case never leaks one into the next. With no default, `Dependency<T>()` raises
`Dependency<T>() was called before any module was ignited`.

With more than one module live, pass the one to resolve from. It is `module.resolveDependency<T>()`
for code that has the handle but prefers the global's shape:

```ts
const shop = Dependency<Shop>(worldModule);
```

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

This runs `onExtinguished` hooks, releases the instances the module created, and unregisters them
from every plugin observing them, so a lifecycle plugin stops ticking dead providers.

Games rarely call this. Tests, and tools that mount and unmount, do.

## More than one module?

A second module is a second container: nothing in one can inject anything from the other unless it
imports it, and `Dependency<T>()` answers from only one of them. Reach for one only when that
separation is the point:

- **Tests**, where each case wants a fresh container. Build the definition once, ignite per case.
- **A tool** with a lifetime shorter than the game's, extinguished when it closes.
- **A scenario** that runs against the game -- a test rig, a debug world -- and is torn down on its
  own. It imports the game module, below.

### Importing a module

A module ignited with `imports` can inject and resolve the providers of the modules it names, after
its own:

```ts
const game = Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();

const rig = Flamework.createModule()
    .registerProviders("src/server/Testing/rig")
    .ignite({ imports: [game] });
```

A provider in `rig` takes `DataService` in its constructor like any provider in `game` does.
Resolution looks in `rig` first, then in each import in order, each through its own imports, and a
miss names the imports it searched. Nothing is copied: the import keeps its providers, their
lifecycle, their observers and their extinguish, and `rig` only resolves them. A lazy provider of
the import is constructed by the import, the first time either module asks.

Every import has to be ignited already. `ignite()` is synchronous, so in one entry script that is
the order of the lines; getting it wrong raises `imported module '...' is not ignited` before
anything in the importer is constructed.

Two rules decide what happens when both modules register the same id:

- **The same class is shared.** An own registration of a class an import already resolves to is
  dropped, and the import's instance answers, so a folder matched by both modules' paths does not
  produce two of everything. `registerClassProvider(Class, { isolated: true })` keeps an own
  instance instead.
- **A different class wins.** `rig.registerProvider<DataService>({ type: "class", value: FakeDataService })`
  is kept and answers ahead of the import's, which is how a scenario stands a fake in for one of
  the game's providers, for itself only. The game keeps the real one.

Extinguishing an import extinguishes every module that imports it first, deepest first, so
`game.extinguish()` takes `rig` down before the game. An importer extinguished on its own detaches,
and the import carries on.

What used to be a reason for a second module -- a library that ships providers, code both realms
share -- is a [plugin](08-plugins.md): its setup registers the providers into whichever module
includes it, and a plugin two others both include is set up once.

```ts
// src/shared/plugins/core.ts
export const CorePlugin = Flamework.createPlugin("Core", (target) => {
    target.registerProviders("src/shared/services");
});

// both entry points
.includePlugin(CorePlugin)
```

Each realm ignites its own module, which is what you want -- they are different processes.

## Patterns

**A module per test.** Build the definition once, ignite per case, extinguish after:

```ts
const definition = Flamework.createModule().registerClassProvider(Shop).build();

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
- **You cannot resolve during plugin setup or `onPreIgnite`.** Providers do not exist yet;
  `module is in pre-ignite phase, dependency cannot be resolved` tells you a plugin tried. Register
  state early and resolve in `onPostIgnite`.
- **`Dependency<T>()` answers from one module.** The first root ignited, unless a later one was
  ignited with `{ default: true }`. A realm with two live roots -- tests, tools -- should say which,
  or resolve through the handle.
- **Duplicate registration raises at ignition.** `provider ID was registered more than once` usually
  means two `registerProviders` paths overlap, or a class is registered both by path and by hand --
  or by the module and by a plugin. Two registrations whose [scope conditions](11-scopes.md) keep
  at most one of them are fine.
- **Imports are one way.** A module sees its imports' providers; an import never sees the
  importer's. A fake registered in the importer replaces nothing in the import.

---

Previous: [Getting started](01-getting-started.md) · Next: [Providers](03-providers.md)
