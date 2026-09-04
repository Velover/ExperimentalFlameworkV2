# 10. Migrating from v1

v2 is not a drop-in upgrade. The core change is that the implicit global container became an explicit
one, and everything that used to be built into it is now a plugin.

## At a glance

| v1 | v2 |
|---|---|
| `@Service()` / `@Controller()` | `@Provider()` on both realms |
| `Flamework.addPaths("src/services")` | `.registerProviders("src/services")` |
| `Flamework.ignite()` | `Flamework.createModule()…​.ignite()` |
| Lifecycle events built in | `.includePlugin(LifecyclePlugin)` |
| `Dependency<T>()` | `module.resolveDependency<T>()` or constructor injection |
| `Flamework.registerExternalClass(C)` | `.registerClassProvider(C)` |
| `Flamework.createDependency(C)` | `module.createClassInstance(C)` with `@Injectable()` |
| `Modding.onListenerAdded<T>(cb)` | `.registerInterface<T>({ onAdded, onRemoved })` on a plugin |
| Components auto-registered | `.includePlugin(ComponentPlugin.fromPath(…))` |
| `Components` injected globally | `Components` is a provider of the component plugin |
| `Flamework.implements` | unchanged |
| `Flamework.id`, `createGuard` | unchanged |
| `Networking.createEvent` | unchanged |

## Step by step

### 1. Replace the entry point

```ts
// v1
import { Flamework } from "@flamework/core";

Flamework.addPaths("src/server/services");
Flamework.addPaths("src/server/components");
Flamework.ignite();
```

```ts
// v2
import { ComponentPlugin } from "@flamework/components";
import { Flamework, LifecyclePlugin } from "@flamework/core";

Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .includePlugin(ComponentPlugin.fromPath("src/server/components"))
    .registerProviders("src/server/services")
    .ignite();
```

Note that components and providers are now registered separately -- `registerProviders` only picks up
`@Provider()` classes, and `registerComponents` only picks up `@Component()` ones.

### 2. Rename the decorators

`@Service()` and `@Controller()` both become `@Provider()`. Nothing about a provider is
realm-specific any more; which realm gets it is decided by which entry point registers its folder,
so keep the folders separate.

If you had a class used on both realms with different behaviour, that is now two classes in two
folders, or one class registered by both.

`loadOrder` is gone. Ordering comes from dependencies: if `A` must exist before `B`, inject `A` into
`B`.

### 3. Include the lifecycle plugin

`OnStart`, `OnTick`, `OnPhysics` and `OnRender` are no longer built in. Without
`.includePlugin(LifecyclePlugin)` they silently never fire. This is the most common thing to miss.

`OnInit` has no direct equivalent -- constructors run in dependency order and serve the same purpose,
but they must not yield. Move yielding setup into `onStart`.

### 4. Replace `Dependency<T>()`

There is no global container to reach into, so the singleton accessor is gone.

```ts
// v1
const economy = Dependency<Economy>();

// v2, inside a provider
constructor(private economy: Economy) {}

// v2, at a boundary
const economy = module.resolveDependency<Economy>();
```

For the boundary case, keep a reference to the module your entry point ignited:

```ts
export const gameModule = Flamework.createModule()…​.ignite();
```

### 5. Update components

Register them through `ComponentPlugin`, and get `Components` by injection rather than globally:

```ts
// v1
constructor(private components: Components) {} // worked because Components was a global service

// v2 -- the same code, but it works because ComponentPlugin exports Components
constructor(private components: Components) {}
```

The component API itself is largely unchanged. What is new:

- `ComponentMetadata` must be the first constructor parameter if a component declares its own
  constructor.
- Component-to-component dependencies work: declare the other component as a parameter and Flamework
  waits for it.
- `ComponentStreamingMode` controls whether instance guards are re-run as the tree streams in.

### 6. Replace `Modding.onListenerAdded`

The listener-observation API is now a plugin interface:

```ts
// v1
Modding.onListenerAdded<OnPlayerJoined>((listener) => listeners.add(listener));
Modding.onListenerRemoved<OnPlayerJoined>((listener) => listeners.delete(listener));

// v2
Flamework.createPlugin(pluginModule)
    .registerInterface<OnPlayerJoined>({
        onAdded: (context, value) => listeners.add(value),
        onRemoved: (context, value) => listeners.delete(value),
    })
    .build();
```

See [Plugins](08-plugins.md) for the full shape.

### 7. Externally created classes

```ts
// v1
Flamework.registerExternalClass(SomeClass);

// v2 -- as a provider
.registerClassProvider(SomeClass)

// v2 -- as a one-off instance with injection but no registration
@Injectable()
class SomeClass {}

module.createClassInstance(SomeClass);
```

## What did not change

The transformer, and everything that depends on it, works the same way: `Flamework.id`,
`Flamework.implements`, `Flamework.createGuard`, `Modding.inspect`, `Modding.Caller`,
`Modding.Target`, and writing your own macros with `@metadata macro`.

Networking's public API is unchanged -- `createEvent`, `createFunction`, middleware, `Networking.Skip`
and the error values all behave as they did.

## Things to check after migrating

- Did you include `LifecyclePlugin`? Missing it fails silently.
- Are your component folders registered with `ComponentPlugin`, not `registerProviders`?
- Did any `@Service` rely on being server-only? Providers are not realm-gated; the module decides.
- Did anything rely on `loadOrder`? Replace it with a dependency.
- Do any constructors yield? They used to be tolerable; now they stall ignition.
- Is there exactly one `ignite()` per realm? Two containers do not share providers.

---

Previous: [Project structure](09-project-structure.md) · Back to the [index](../README.md)
