# 3. Providers

A provider is a singleton within its module. It is the unit you write most of your game in.

```ts
import { Provider } from "@flamework/core";

@Provider()
export class Economy {
    public balance = 0;
}
```

`@Provider()` does two things: it marks the class as a provider, and it tells the transformer to
attach the metadata dependency injection needs -- the class's identifier, its constructor parameter
types, and the interfaces it implements.

## Registration

**No, you do not list your services by hand.** `registerProviders` takes a folder:

```ts
Flamework.createModule().registerProviders("src/server/services").ignite();
```

That is the v2 equivalent of v1's `Flamework.addPaths(...)`, and it is what you should use for
ordinary game code.

### How it actually works

Worth knowing, because the caveats fall out of it:

1. **At compile time**, the transformer turns `"src/server/services"` into the Rojo instance path
   that folder ends up at, using your Rojo project file. This is why the argument must be a string
   literal and why the folder must be mapped.
2. **At runtime**, Flamework walks to that instance with `WaitForChild`, requires every `ModuleScript`
   under it, and collects every exported value carrying Flamework metadata.
3. It then keeps the ones marked as providers and registers each under its generated identifier.

So registration is "require everything in this folder and see what falls out".

### Explicit registration

When you want one specific class -- a library's provider, a test double, something conditional:

```ts
// Shorthand: uses the class's generated identifier
.registerClassProvider(Economy)

// Full form: the same thing spelled out
.registerProvider<Economy>({ type: "class", value: Economy })
```

Both raise `class 'X' is missing the @Provider() decorator` if the class is not decorated.

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

There is nothing to annotate. The transformer records each parameter's identifier, and the module
resolves them, constructing anything that does not exist yet.

Resolution order: this module's own providers first, then the **exported** providers of every module
it includes.

You can also inject:

- `Module` -- the module doing the resolving.
- `PluginModule` -- inside a plugin, the module the plugin was included in. See
  [Plugins](08-plugins.md).

### Circular dependencies

Two providers that inject each other cannot both be constructed first, and Flamework will not
untangle it for you. Break the cycle by injecting `Module` into one of them and resolving lazily:

```ts
@Provider()
class A {
    constructor(private module: Module) {}

    private get b() {
        return this.module.resolveDependency<B>();
    }
}
```

Better, though: the cycle usually means a third provider is trying to exist.

## Other kinds of provider

A provider does not have to be a class.

### Function providers

Called once, the first time the dependency is resolved:

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
| `sourceModule` | The module the provider is registered in. |
| `targetModule` | The module resolving it, which differs when the provider is exported. |
| `origin` | The class being constructed, if any. |

`origin` is what makes a per-consumer logger possible:

```ts
.registerProvider<Logger>({
    type: "function",
    callback: (context) => new Logger(tostring(context.origin)),
})
```

Every class that injects a `Logger` gets one tagged with its own name.

### Alias providers

Resolve one id to another. This is how an interface gets an implementation:

```ts
.registerClassProvider(DataStoreStorage)
.registerProvider<Storage>({ type: "alias", injectionId: Flamework.id<DataStoreStorage>() })
```

Anything injecting `Storage` now gets the `DataStoreStorage` instance -- the same instance, not a
second one. Swap the alias in tests to swap the implementation.

## Classes that are not providers

Sometimes you want dependency injection for a class you create yourself -- a session, a request, a
per-player object -- without it being a singleton or being picked up by `registerProviders`.

```ts
import { Injectable } from "@flamework/core";

@Injectable()
class Session {
    constructor(private economy: Economy) {}
}
```

```ts
const session = module.createClassInstance(Session);
```

`@Injectable()` attaches the same metadata as `@Provider()` but does **not** mark the class as a
provider, so path registration skips it and it cannot be resolved by id.

The instance is owned by the module: it is attached to any lifecycle events it implements, and
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

Returning `undefined` falls back to the module's normal resolution, so you only intercept what you
mean to. This is exactly how `@flamework/components` gives every component its `instance` and
`attributes`.

## Realms

There is no `@Service` / `@Controller` distinction. A provider is not bound to a realm; the module
that registers it decides:

```ts
// server entry point
.registerProviders("src/server/services")

// client entry point
.registerProviders("src/client/controllers")
```

Shared providers go in a shared folder registered by both, or in a shared module included by both.

## Patterns

**Interface plus alias for swappable implementations.** Declare the interface, register the concrete
class, alias the interface to it. Tests register a different class under the same alias.

**A config provider at the top.** A function provider returning a frozen object is the simplest way
to get configuration into everything without a global.

**Factories over service locators.** If a provider needs to make many short-lived objects, inject
`Module` and use `createClassInstance` rather than passing the module around.

## Caveats

- **Registration requires the class to be exported.** Path registration reads a ModuleScript's
  exports; a non-exported class is invisible to it.
- **Path registration requires every module in the folder.** Import side effects run, and a module
  that throws while loading is warned about and skipped rather than failing the ignite.
- **`WaitForChild` yields.** If the folder has not replicated yet, ignition waits.
- **Overlapping paths raise.** Registering `src/server` and `src/server/services` will hit
  `provider ID was registered more than once`.
- **`@Injectable()` classes are not resolvable.** `resolveDependency<Session>()` will not find one;
  that is the point of the decorator.
- **A missing dependency is a runtime error, not a compile error.**
  `module could not resolve dependency 'X'` means the type was never registered in this module or
  anything it includes.
- **Constructor injection only.** There is no property or method injection.

---

Previous: [Modules](02-modules.md) · Next: [Lifecycle events](04-lifecycle-events.md)
