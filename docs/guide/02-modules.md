# 2. Modules

A **module** is the object `Flamework.createModule()` builds. It is two things at once:

1. **A dependency-injection container.** It holds a set of providers, and gives each provider the
   other providers it depends on.
2. **A lifecycle unit.** It starts (*ignites*) as a whole and stops (*extinguishes*) as a whole.

In v1 there was exactly one module, and it was global and implicit. In v2 you create it yourself,
which is what makes tests and tools possible. But **most games have exactly one module per realm and
never extinguish it**. If that is your game, the second half of this page is optional reading.

## The one-module case

```ts
Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();
```

That is all a typical game needs. You never call `build()` or `extinguish`, and `Dependency<T>()`
reaches this module from anywhere.

## The builder

`Flamework.createModule()` returns a `ModuleBuilder`. Every method except `build()` and `ignite()`
returns the builder, so those calls chain. `build()` returns a `ModuleDefinition`, and `ignite()`
returns the ignited `Module`.

| Method | Does |
|---|---|
| `registerProviders(path)` | Registers every `@Provider()` class defined in the files under a source folder, exported or not. |
| `registerProvidersGlob(glob)` | The same, for every folder a glob matches, resolved when you build. |
| `registerClassProvider(Class)` | Registers one class explicitly. |
| `registerProvider<T>(config, id?)` | Registers a class, function or alias provider. |
| `includePlugin(plugin)` | Adds a plugin, which can hook into this module. |
| `disableDefaultLifecycle()` | Leaves out the `LifecyclePlugin` every module starts with. |
| `setDebugName(name)` | Names the module in error messages. |
| `apply(fn)` | Runs `fn(builder)` without breaking the chain. |
| `build()` | Finishes the builder and returns a `ModuleDefinition`. |
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

You can ignite a definition many times, and **each ignition gets its own provider instances**. That
makes a module a clean unit for tests: build the definition once, and ignite a fresh module for each
test.

## What ignition does

In order:

1. Plugins are set up. Each plugin's setup function runs against this module and registers
   providers, hooks and observers into it. A plugin reached twice is set up once.
2. `onPreIgnite` hooks run.
3. Every registered provider is constructed, and its constructor dependencies are resolved.
4. `onPostIgnite` hooks run. This is where `LifecyclePlugin` calls `onInit` on everything that
   implements it. An error raised up to this point fails the ignition.
5. The module is now ignited, and `onIgnited` hooks run. This is where `LifecyclePlugin` calls
   `onStart` on everything that implements it, and then starts its `RunService` connections. So an
   `onStart` sees `isIgnited()` return `true`, may `extinguish()` the module, and may ignite a module
   that imports it.

Within step 3, providers are constructed on demand: resolving a dependency constructs it if it does
not exist yet. So a provider's constructor can safely use anything injected into it.

## Resolving by hand

```ts
const shop = module.resolveDependency<Shop>();
```

Use this where Flamework meets code that it does not manage. Inside a provider, take a constructor
parameter instead.

Some code has no module handle at hand: a UI component, a script, a callback registered with
something outside Flamework. There, `Dependency<T>()` resolves against the **default module**:

```ts
import { Dependency } from "@flamework-experimental/core";

const shop = Dependency<Shop>();
```

The first module ignited in a realm is the default. In a game, that is the one the entry point
ignites. To make a later module the default instead, pass `{ default: true }`:

```ts
const module = definition.ignite({ default: true });
```

Extinguishing the default module releases it, and the next module ignited becomes the default. So a
test that ignites and extinguishes a module per case never leaks one into the next. A module that
fails to ignite never becomes the default: if one ignited with `{ default: true }` raises, the
previous default stays as it was. With no default, `Dependency<T>()` raises
`Dependency<T>() was called before any module was ignited`.

With more than one module running, pass the one to resolve from. This is the same as
`module.resolveDependency<T>()`, for code that has the handle but prefers the shape of the global
function:

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

This runs the `onExtinguished` hooks, releases the instances the module created, and unregisters
them from every plugin observing them. So the lifecycle plugin stops ticking providers that are gone.

Games rarely call this. Tests do, and so do tools that mount and unmount.

## More than one module?

A second module is a second container. Nothing in one module can inject anything from the other
unless it imports it, and `Dependency<T>()` answers from only one of them. Use a second module only
when you want that separation:

- **Tests**, where each case wants a fresh container. Build the definition once, and ignite it for
  each case.
- **A tool** that lives for less time than the game, and is extinguished when it closes.
- **A scenario** that runs against the game, such as a test rig or a debug world, and is torn down on
  its own. It imports the game module (see below).

### Importing a module

A module ignited with `imports` can inject and resolve the providers of the modules it lists. It
looks in its own providers first:

```ts
const game = Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();

const rig = Flamework.createModule()
    .registerProviders("src/server/Testing/rig")
    .ignite({ imports: [game] });
```

A provider in `rig` can take `DataService` in its constructor, just as a provider in `game` can.
Resolution looks in `rig` first, then in each import in order, and each import also searches its own
imports. When nothing is found, the error names the imports it searched. Nothing is copied: the
import keeps its providers, their lifecycle, their observers and their extinguish, and `rig` only
resolves them. A lazy provider of the import is constructed by the import, the first time either
module asks for it.

Every import has to be ignited first. `ignite()` is synchronous, so in one entry script this is just
the order of the lines. If you get it wrong, `ignite()` raises `imported module '...' is not ignited`
before anything in the importer is constructed.

Two rules decide what happens when both modules register the same id (the string Flamework uses to
identify a class):

- **The same class is shared.** If the importer registers a class that an import already resolves
  to, the importer's registration is dropped and the import's instance answers. So a folder that
  both modules' paths match does not produce two of everything.
  `registerClassProvider(Class, { isolated: true })` keeps a separate instance in the importer
  instead.
- **A different class wins.** `rig.registerProvider<DataService>({ type: "class", value: FakeDataService })`
  is kept, and answers before the import's `DataService`. This is how a scenario replaces one of the
  game's providers with a fake, for itself only. The game keeps the real one.

Extinguishing an import first extinguishes every module that imports it, deepest first. So
`game.extinguish()` takes `rig` down before the game. An importer extinguished on its own detaches,
and the import keeps running.

Some things that used to need a second module are now a [plugin](08-plugins.md): a library that
ships providers, or code both realms share. A plugin's setup registers the providers into whichever
module includes it. A plugin that two other plugins both include is set up once.

```ts
// src/shared/plugins/core.ts
export const CorePlugin = Flamework.createPlugin("Core", (target) => {
    target.registerProviders("src/shared/services");
});

// both entry points
.includePlugin(CorePlugin)
```

Each realm ignites its own module, which is what you want: the server and the client are different
processes.

## Patterns

**A module per test.** Build the definition once, ignite it for each case, and extinguish it
afterwards:

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

- **A module ignites once and extinguishes once.** Igniting a `Module` twice, or extinguishing it
  twice, raises `module is in invalid state when transitioning to '...'`. If you want a second
  container, ignite the *definition* again.
- **You cannot resolve during plugin setup or `onPreIgnite`.** Providers do not exist yet. The error
  `module is in pre-ignite phase, dependency cannot be resolved` means a plugin tried. Register state
  early, and resolve in `onPostIgnite`.
- **`Dependency<T>()` answers from one module.** It uses the first module ignited, unless a later one
  was ignited with `{ default: true }`. A realm with two running modules (tests, tools) should say
  which one, or resolve through the module handle.
- **Duplicate registration raises at ignition.** `provider ID was registered more than once` usually
  means two `registerProviders` paths overlap. It can also mean a class is registered both by path
  and by hand, or by both the module and a plugin. Two registrations are fine when their
  [scope conditions](11-scopes.md) keep at most one of them.
- **Imports are one way.** A module sees its imports' providers, but an import never sees the
  importer's. A fake registered in the importer replaces nothing in the import.

---

Previous: [Getting started](01-getting-started.md) · Next: [Providers](03-providers.md)
