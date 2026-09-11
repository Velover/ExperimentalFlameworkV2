# 10. Migrating from v1

v2 is not a drop-in upgrade. The core change is that the implicit global container became an explicit
one, and everything that used to be built into it is now a plugin.

## At a glance

| v1 | v2 |
|---|---|
| `@Service()` / `@Controller()` | `@Provider()` on both realms |
| `Flamework.addPaths("src/services")` | `.registerProviders("src/services")` |
| `Flamework.addPathsGlob("src/**/services")` | `.registerProvidersGlob("src/**/services")` / `ComponentPlugin.fromGlob(...)` |
| `@Optional()` / `includeOptionalClass` | `@Provider({ lazy: true })`, constructed when first resolved |
| `flamework.json` `profiling` | `flamework.config.json` `core.profiling`, or `createLifecyclePlugin({ profiling })` per module |
| Transformer options inline in `tsconfig.json` | the `transformer` section of `flamework.config.json` (inline still works and wins) |
| Values sent as-is over remotes | unchanged by default; `networking.serialization` packs them into buffers with generated code |
| `OnInit` | unchanged |
| `Modding.createDecorator` / `getDecorators` | your own decorator + `@metadata reflect` + `Reflect`; see below |
| `Modding.getObjectFromId`, `Reflect.idToObj` | gone; there is no global registry |
| `Flamework.ignite()` | `Flamework.createModule()…​.ignite()` |
| Lifecycle events built in | still on: `LifecyclePlugin` is an ordinary plugin every module starts with; `disableDefaultLifecycle()` opts out |
| `Dependency<T>()` | unchanged; answers from the first module ignited, or the one ignited with `{ default: true }`. `Dependency<T>(module)` answers from a given one |
| `Flamework.registerExternalClass(C)` | `.registerClassProvider(C)` |
| `Flamework.createDependency(C)` | `module.createClassInstance(C)` with `@Injectable()` |
| `Modding.onListenerAdded<T>(cb)` | `target.observe<T>({ onAdded, onRemoved })` in a plugin |
| Components auto-registered | `.includePlugin(ComponentPlugin.fromPath(…))` |
| `Components` injected globally | `Components` is provided by the component plugin; inject it as before |
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
import { ComponentPlugin } from "@flamework-experimental/components";
import { Flamework } from "@flamework-experimental/core";

Flamework.createModule()
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

### 3. Lifecycle events are still on

`OnInit`, `OnStart`, `OnTick`, `OnPhysics` and `OnRender` work as they did. They are provided by
`LifecyclePlugin`, an ordinary plugin every module starts with, so there is nothing to add. `OnInit`
still runs after construction, in dependency order, may return a Promise, and everything after it
waits; `onPhysics` still receives `(dt, time)`. The signals are v1's too: `onTick` on `Heartbeat`,
`onPhysics` on `PreSimulation` (v1 called it `Stepped`), `onRender` on `PreRender`.

`OnRender` only connects on the client; a provider implementing it on the server is simply inert.

### 4. `Dependency<T>()` still works

It answers from the **default module**: the first root ignited in the realm, which for a game is the
one the entry point ignites. Nothing to change, though constructor injection is still the better
shape inside a provider:

```ts
// still fine, anywhere
const economy = Dependency<Economy>();

// better, inside a provider
constructor(private economy: Economy) {}
```

If a realm ignites more than one root -- tests, tools -- pass `{ default: true }` to the one
`Dependency<T>()` should answer from, or use `module.resolveDependency<T>()` on the handle.

### 5. Update components

Register them through `ComponentPlugin`, and get `Components` by injection rather than globally:

```ts
// v1
constructor(private components: Components) {} // worked because Components was a global service

// v2 -- the same code, but it works because ComponentPlugin provides Components
constructor(private components: Components) {}
```

The component API itself is largely unchanged. What is new:

- `ComponentMetadata` must be the first constructor parameter if a component declares its own
  constructor.
- Component-to-component dependencies work: declare the other component as a parameter and Flamework
  waits for it.
- `ComponentStreamingMode` controls whether instance guards are re-run as the tree streams in.
- Attributes are writable again, as they were in v1: `this.attributes.speed = 32` writes back to the
  instance. Alpha releases before this made them `Readonly`.
- An attribute or a child typed as an Instance or as a component becomes a
  [link](05-components.md#links): Flamework resolves the `InstanceHandle`, waits for it, and exposes
  the components through `childComponents` and `attributeComponents`. In v1 an Instance attribute was
  yours to resolve.
- **An optional child is now rejected.** `BaseComponent<{}, Model & { Head?: BasePart }>` compiled in
  v1 and left `this.instance.Head` raising whenever the child was absent, because Roblox errors on
  indexing a child that does not exist. Require the child, type it as a component -- an optional
  child link is watched, and read through `childComponents` -- or drop it from the tree and use
  `FindFirstChild`. Optional attributes are unaffected.

### 6. Replace `Modding.onListenerAdded`

The listener-observation API is now a plugin interface:

```ts
// v1
Modding.onListenerAdded<OnPlayerJoined>((listener) => listeners.add(listener));
Modding.onListenerRemoved<OnPlayerJoined>((listener) => listeners.delete(listener));

// v2
Flamework.createPlugin("PlayerListeners", (target) => {
    target.observe<OnPlayerJoined>({
        onAdded: (value) => listeners.add(value),
        onRemoved: (value) => listeners.delete(value),
    });
});
```

See [Plugins](08-plugins.md) for the full shape.

### 7. Custom decorators

v1's `Modding.createDecorator`, `createMetaDecorator`, `getDecorators`, `getDecorator`,
`getPropertyDecorators` and `Reflect.decorate` are gone, along with the global class registry behind
them (`Reflect.idToObj`, `Modding.getObjectFromId`). A decorator is now an ordinary function whose
JSDoc tells the transformer which metadata to attach, and which records whatever it wants on the
class with `Reflect`:

```ts
/**
 * @metadata reflect identifier flamework:implements
 */
export function Command(name: string) {
    return (ctor: object) => {
        Reflect.defineMetadata(ctor, "myGame:command", name);
    };
}
```

Discovery is path-based, exactly like providers. Where v1 offered `Modding.getDecorators<typeof Command>()`,
walk a folder and filter on your own metadata:

```ts
import { getClassesInPath } from "@flamework-experimental/core";

for (const ctor of getClassesInPath(path)) {
    const name = Reflect.getOwnMetadata<string>(ctor, "myGame:command");
    if (name !== undefined) register(name, ctor);
}
```

`getClassesInPath` takes the Rojo path array the `path` intrinsic produces; wrap it in a macro of
your own (see [Macros](07-macros.md)) so callers can pass `"src/server/commands"`. Property and method
decorators work the same way, with `Reflect.defineMetadata(ctor, key, value, propertyName)`.

### 8. Removed without replacement

- **Primitive dependencies.** v1 could inject a string or number literal type (`$ps:`/`$pn:` ids).
  Register a function provider under an interface instead.
- **`Modding.registerDependency`.** Use a function or alias provider on the module.
- **`Modding.onListenerAdded` without an id** (every listener). Register an interface per event.
- **`Flamework.hash`.** `Modding.Target.Hash` still exists for writing a macro of your own.

### 9. Externally created classes

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

- Did you call `disableDefaultLifecycle()` anywhere? It is now the only way lifecycle events go
  missing, `onInit` included, and components stop ticking with them.
- Did anything rely on `@Optional`? Replace it with `@Provider({ lazy: true })`.
- Did anything rely on `Modding.getDecorators`? Replace it with path scanning and your own metadata.
- Are your component folders registered with `ComponentPlugin`, not `registerProviders`?
- Did any `@Service` rely on being server-only? Providers are not realm-gated; the module decides.
- Did anything rely on `loadOrder`? Replace it with a dependency.
- Do any constructors yield? They used to be tolerable; now they stall ignition.
- Is there exactly one `ignite()` per realm? Two containers do not share providers, and
  `Dependency<T>()` answers from the first.

---

Previous: [Project structure](09-project-structure.md) · Back to the [index](../README.md)
