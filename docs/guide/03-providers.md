# 3. Providers

A **provider** is usually a class that its module creates once: a singleton within that module.
(Other kinds are covered under [Other kinds of provider](#other-kinds-of-provider).) You write most
of your game as providers.

```ts
import { Provider } from "@flamework-experimental/core";

@Provider()
export class Economy {
    public balance = 0;
}
```

`@Provider()` does two things. It marks the class as a provider, and it tells the transformer to
attach the metadata that dependency injection needs: the class's identifier (id), its constructor
parameter types, and the interfaces it implements.

## Registration

**You do not list your providers by hand.** `registerProviders` takes a folder:

```ts
Flamework.createModule().registerProviders("src/server/services").ignite();
```

This is v2's version of v1's `Flamework.addPaths(...)`. Use it for ordinary game code.

### How it actually works

It helps to know this, because the caveats follow from it:

1. **At compile time**, the transformer uses your Rojo project file to turn `"src/server/services"`
   into the Rojo path that the folder ends up at. This is why the argument must be a string literal,
   and why the folder must be mapped.
2. **At runtime**, Flamework finds that instance with `WaitForChild` and requires every
   `ModuleScript` under it. It collects every Flamework class those ModuleScripts define, **exported
   or not**. It also collects anything they export that carries Flamework metadata, such as a
   re-export of a class from elsewhere. A registration whose own scope condition does not hold
   skips this step: the folder is not looked up and nothing is required. See [Scopes](11-scopes.md).
3. It keeps the classes marked as providers, and registers each one once under its generated id,
   however many ways it was found.

So registration means "require everything in this folder and see what comes out", as it did in v1.

Unexported classes are found because the transformer records each class against the ModuleScript
that defines it (`script`). The id plays no part in this, so it works in every `idGenerationMode`
and with obfuscation on.

Only a class that the ModuleScript creates once, as it loads, is recorded: one declared at the top
level of the file, or at the top level of a namespace in it. A class declared inside a function is
created again by every call, so it is never recorded. That way, a later path registration never
picks up a class that belongs to a test case or a factory. Such a class is found only if its file
exports it.

Only classes that carry `@Provider()` **themselves** are registered. Metadata is inherited through
the class hierarchy, but an exported, undecorated subclass of a provider is still skipped, rather
than registered under its parent's id. Registering one explicitly raises an error.

### Registering by glob

When your providers are spread over folders whose paths share a pattern, a glob saves listing each
folder:

```ts
Flamework.createModule().registerProvidersGlob("src/server/**/services").ignite();
```

The glob is resolved at **compile time** against your source tree, and the matching Rojo paths are
written to `include/flamework/globs.json`, which the runtime reads. Two consequences: the include
directory must be part of your Rojo project (it is in a default roblox-ts project), and only game
projects emit the file -- a published package cannot use globs. This is v1's `Flamework.addPathsGlob`.

A glob that matches no files is not an error, since a folder can be empty on purpose. It registers
nothing, and the build prints a warning with the glob and the file and line that use it.

### Explicit registration

To register one specific class, such as a library's provider, a test double or something
conditional:

```ts
// Shorthand: uses the class's generated identifier
.registerClassProvider(Economy)

// Full form: the same thing spelled out
.registerProvider<Economy>({ type: "class", value: Economy })
```

Both raise `class 'X' is missing the @Provider() decorator` if the class is not decorated itself,
even when it inherits the decorator from a parent class.

## Dependency injection

Constructor parameters are resolved by type:

```ts
@Provider()
export class Shop {
    constructor(
        private economy: Economy,
        private logger: Logger,
    ) {}
}
```

There is nothing to annotate. The transformer records each parameter's id, and the module resolves
them, constructing anything that does not exist yet.

Resolution looks in the module first: its own providers, and whatever its plugins registered or
provided. Then it looks in the modules this one imports, in order (see
[Importing a module](02-modules.md#importing-a-module)). Nothing else is searched.

You can also inject `Module` (the module doing the resolving) and anything a plugin provided. See
[Plugins](08-plugins.md).

### Outside a provider

Code with no constructor, such as a UI component, a script or a signal handler, reaches a provider
through `Dependency<T>()`. It resolves against the default module: the first one ignited, or the one
ignited with `{ default: true }` (see [Modules](02-modules.md#resolving-by-hand)).

```ts
import { Dependency } from "@flamework-experimental/core";

const economy = Dependency<Economy>();
```

Prefer a constructor parameter wherever you can use one. It declares the dependency where readers can
see it, and it makes the module construct the dependency first. `Dependency<T>()` inside a
provider's constructor works, as it did in v1, but the module cannot see that dependency.

### Circular dependencies

Two providers that inject each other cannot both be constructed first, and Flamework will not
untangle this for you. Break the cycle: inject `Module` into one of them, and resolve the other
lazily, only when it is used:

```ts
@Provider()
class A {
    constructor(private module: Module) {}

    private get b() {
        return this.module.resolveDependency<B>();
    }
}
```

Better still, look for the third provider: a cycle usually means one is trying to exist.

### Asking for something that is not a provider

`Dependency<T>()`, `resolveDependency<T>()` and constructor injection resolve only **providers**. v1
built any decorated class on demand, but v2 does not. Asking for a class that is not a provider
fails:

- **A component** (`@Component()`) is built by `Components` on the instances it is attached to, never
  by a module. When you build, the transformer refuses `Dependency<T>()`,
  `module.resolveDependency<T>()` and a `@Provider()`'s constructor parameter when the type is a
  component: `'QuestsUI' is a component (@Component), not a provider`. Make it a `@Provider()`: a
  provider cannot extend `BaseComponent`, so move what callers need into a provider. Or get the
  component from the instance: `components.getComponent<QuestsUI>(instance)`.
- **A `@Provider()` that nothing registers** raises at runtime. The error says so, and says where the
  class is defined: `'Shop' (ServerScriptService.TS.shop) is a @Provider() that nothing in this
  module registers or provides`. Register its folder, register the class, include the plugin that
  provides it, or import a module that has it.
- **An `@Injectable()` class** is built with `createClassInstance`, never resolved:
  `'Session' (...) is not a provider`.

The check made when you build covers only what the type makes certain. It never refuses:

- an id passed by hand (`Dependency<T>(undefined, id)`)
- an interface or abstract class, since a function or alias provider may stand behind it
- `Dependency<Components>()`, and anything else a plugin provides
- a `@Provider()` class
- a macro of your own that takes a `Modding.Target.Dependency<T>`

A component's own constructor may take another component: that is a component dependency. An
`@Injectable()`'s constructor may take one too, and `overrideDependency` can answer it. At runtime,
the full explanation is given only for a class that has loaded and was defined at the top level of
its file. Anything else gets the plain `could not resolve dependency 'X'`.

## Other kinds of provider

A provider does not have to be a class.

### Function providers

The callback is called on **every** resolution: once per constructor parameter that asks for it, and
once per `resolveDependency`. Nothing is cached for you, so if you want a singleton, cache it in the
callback:

```ts
interface Config {
    readonly maxPlayers: number;
}

.registerProvider<Config>({
    type: "function",
    callback: () => ({ maxPlayers: 8 }),
})
```

The callback receives an `InjectionContext` describing *who asked*:

| Field | Is |
|---|---|
| `injectionId` | The id being resolved. |
| `dependencyInfo` | The id plus any metadata carried on the type. |
| `module` | The module resolving the dependency. |
| `origin` | The class being constructed, if any. |

`origin` lets you give each consumer its own logger:

```ts
.registerProvider<Logger>({
    type: "function",
    callback: (context) => new Logger(tostring(context.origin)),
})
```

Every class that injects a `Logger` gets one tagged with its own name. That is why the callback runs
on every resolution. For a shared value, create it outside the callback and close over it:

```ts
const config = { maxPlayers: 8 };
.registerProvider<Config>({ type: "function", callback: () => config })
```

### Alias providers

An alias provider resolves one id to another. This is how an interface gets an implementation:

```ts
.registerClassProvider(DataStoreStorage)
.registerProvider<Storage>({ type: "alias", injectionId: Flamework.id<DataStoreStorage>() })
```

Anything that injects `Storage` now gets the `DataStoreStorage` instance: the same instance, not a
second one. In tests, swap the alias to swap the implementation.

### Lazy providers

A provider is normally constructed during ignition, whether or not anything uses it. Mark it lazy to
construct it only when something first resolves it:

```ts
@Provider({ lazy: true })
export class Telemetry implements OnStart {}
```

A lazy provider that nothing ever resolves is never created. One that is resolved after ignition
still gets `onInit` and `onStart`, on the next resume point after it is constructed. From then on it
behaves like any other provider. One resolved during ignition, from another provider's `onInit`, is
initialised in order, before anything starts. This is v1's `@Optional()`. There is no equivalent
of `includeOptionalClass`, because resolving a lazy provider is how you include it.

### Load order

`loadOrder` sets when a provider's `onInit` and `onStart` run, compared with the other providers of
the same ignition, as v1's `@Service({ loadOrder })` did. Lower values go first, and the default is
`1`. Providers with the same value keep the order they would have without one.

```ts
@Provider({ loadOrder: 0 })
export class CameraShake implements OnStart {
    public onStart() {} // started before the providers left at 1
}

@Provider({ loadOrder: 5 })
export class Interface implements OnStart {
    public onStart() {} // started after them
}
```

Dependencies still come first. A provider is constructed and initialised after what its constructor
takes, even when that has a higher `loadOrder`. So a low `loadOrder` pulls the provider's
dependencies forward with it. See [Lifecycle events](04-lifecycle-events.md#load-order) for the
exact order.

`loadOrder` has no effect on a lazy provider, which starts when it is first resolved. It also has no
effect across modules: an imported module ignites, and starts, before the module that imports it.
Any finite number is accepted. Anything else raises an error when the ModuleScript that defines the
class loads.

### Scoped providers

A provider can be tied to the build's *scopes*, the names a build is compiled with. Then a test
scenario or a debug tool exists only in the builds that ask for it:

```ts
@Provider({ activeIn: ["components"] })
export class ComponentProbe {}
```

The same `activeIn`/`inactiveIn` pair also goes on a registration
(`registerProviders(path, { ... })`, `registerClassProvider(Class, { ... })`, or the config of
`registerProvider`) and on `ignite`. The conditions combine by AND: all of them must hold. A
provider that is left out is not registered at all. A path or glob registration whose own
condition does not hold does not even load its folder. See [Scopes](11-scopes.md).

## Classes that are not providers

Sometimes you want dependency injection for a class you create yourself, such as a session, a
request or a per-player object. You do not want it to be a singleton, or to be picked up by
`registerProviders`. Use `@Injectable()`:

```ts
import { Injectable } from "@flamework-experimental/core";

@Injectable()
class Session {
    constructor(private economy: Economy) {}
}
```

```ts
const session = module.createClassInstance(Session);
```

`@Injectable()` attaches the same metadata as `@Provider()`, but does **not** mark the class as a
provider. So path registration skips it, and it cannot be resolved by id.

The module owns the instance. The instance is attached to any lifecycle events it implements, and
released when the module extinguishes or when you release it yourself:

```ts
module.removeClassInstance(session);
```

Removing twice is safe and does nothing the second time.

### Passing arguments

`createClassInstance` resolves every constructor parameter through the module, so there is no
argument list to pass. To hand the instance something of your own, declare it as a parameter and
intercept its id:

```ts
interface SessionContext {
    readonly player: Player;
}

@Injectable()
class Session {
    constructor(
        private economy: Economy,
        private context: SessionContext,
    ) {}
}

const session = module.createClassInstance(Session, {
    overrideDependency: (info) => (info.id === Flamework.id<SessionContext>() ? { player } : undefined),
});
```

Returning `undefined` falls back to the module's normal resolution, so you intercept only what you
mean to. This is how `@flamework-experimental/components` gives every component its `instance` and
`attributes`.

## Realms

There is no `@Service` / `@Controller` split. A provider is not bound to a realm. The module that
registers it decides:

```ts
// server entry point
.registerProviders("src/server/services")

// client entry point
.registerProviders("src/client/controllers")
```

Shared providers go in a shared folder registered by both, or in a shared plugin included by both.

## Patterns

**Interface plus alias for swappable implementations.** Declare the interface, register the concrete
class, and alias the interface to it. Tests register a different class under the same alias.

**A config provider at the top.** A function provider returning a frozen object is the simplest way
to get configuration into everything without a global.

**Factories over service locators.** If a provider needs to make many short-lived objects, inject
`Module` and use `createClassInstance` rather than passing the module around.

## Caveats

- **Path registration takes every provider a file defines, exported or not.** Sometimes a
  `@Provider()` class must stay out of the module that registers its folder, such as a fixture that
  a test registers in a module of its own. Put that class in a folder no module registers, or inside
  the function that uses it. A class declared inside a function is found only through its file's
  exports.
- **Path registration requires every ModuleScript in the folder**, so their import side effects
  run. A ModuleScript that throws while loading fails the ignition with its path and error, as in v1.
  Otherwise, a provider that silently failed to register would only show up later, as a missing
  dependency. A registration whose own scope condition does not hold requires nothing.
- **Subclasses need their own decorator.** `class Fake extends Economy {}` without `@Provider()` is
  not a provider; registering it explicitly raises, and path registration skips it.
- **`WaitForChild` yields.** If the folder has not replicated yet, ignition waits.
- **Overlapping paths raise.** Registering `src/server` and `src/server/services` will hit
  `provider ID was registered more than once`.
- **`@Injectable()` classes are not resolvable.** `resolveDependency<Session>()` will not find one.
  That is the point of the decorator.
- **A missing dependency is a runtime error, not a compile error.** The exception is a component,
  which the transformer refuses. `module could not resolve dependency 'X'` means the type was never
  registered in this module or in anything it includes. For a class that has loaded, the message goes
  on to say what the class is and what to do.
- **Constructor injection only.** There is no property or method injection.

---

Previous: [Modules](02-modules.md) · Next: [Lifecycle events](04-lifecycle-events.md)
