# 10. Migrating from v1

v2 is not a drop-in upgrade. The core change is that the implicit global container became an explicit
one, and everything that used to be built into it is now a plugin.

## At a glance

| v1 | v2 |
|---|---|
| `@flamework/core`, `@flamework/components`, `@flamework/networking` | `@flamework-experimental/core`, `components`, `networking` (step 1) |
| `rbxts-transformer-flamework` | `@flamework-experimental/transformer` (step 1) |
| `@Service()` / `@Controller()` | `@Provider()` on both realms |
| `Flamework.addPaths("src/services")` | `.registerProviders("src/services")`; like v1, it finds the classes a module defines whether it exports them or not |
| `Flamework.addPaths(...)` to load a folder for what its modules do as they load | `requireModulesInPath` in a macro of your own; see [Macros › Paths](07-macros.md#paths) |
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
| `Dependency<T>()` | resolves **registered providers** only, from the first module ignited or the one ignited with `{ default: true }`; `Dependency<T>(module)` answers from a given one. v1 built any decorated class on demand: a component or an unregistered class no longer works (see step 5) |
| `Flamework.resolveDependency(id)` | `Dependency<T>(undefined, id)`, or `module.resolveDependency<T>(id)` (step 5) |
| A `@Service()`/`@Controller()` class outside the added paths, a singleton once its module had loaded | `.registerClassProvider(C)` (step 12) |
| `Modding.createDependency(C)` | `module.createClassInstance(C)` with `@Injectable()` (step 12) |
| `Modding.createDeferredDependency(C)` | `module.createClassInstance(C)`; nothing hands out the object before its constructor has run |
| `Modding.resolveSingleton(C)` | `module.resolveDependency<C>()` or `Dependency<C>()`, for a registered provider (step 5) |
| `Modding.addListener(obj)` / `Modding.removeListener(obj)` | `module.listen<T>(obj)` for each interface, which returns the function that detaches it; or build it with `module.createClassInstance(C)` and detach it with `removeClassInstance` |
| `Modding.onListenerAdded<T>(cb)` | `target.observe<T>({ onAdded, onRemoved })` in a plugin; for components, `Components.onComponentAdded<T>(cb)` (step 7) |
| `Modding.Generic`, `Many`, `Caller<M>`, `TupleLabels`, … | `Modding.Target.*`, `Emit`, `Caller.*` (step 9) |
| Components auto-registered | `.includePlugin(ComponentPlugin.fromPath(…))` |
| `Components` injected globally | `Components` is provided by the component plugin; inject it as before |
| Tagged instances get their components in `Components.onStart` (`loadOrder: 0`), before most providers' `onStart` | after every provider's `onStart` (step 6) |
| An attribute changed to a value its guard rejects is ignored | the component is removed until it is valid, unless a `defaults` entry covers it (step 6) |
| `Flamework.implements` | unchanged |
| `Flamework.id`, `createGuard` | unchanged |
| `Networking.createEvent` | unchanged |
| Middleware `processNext(...)` returns a Promise | returns the value (step 10) |
| `connect` returns an `RBXScriptConnection`, tied through a BindableEvent to the script that connected | returns a `Networking.Connection`, not tied to that script's lifetime; nothing changes for a project that does not destroy its scripts (step 10) |

## Step by step

### 1. Swap the packages and the configuration

The packages moved to the `@flamework-experimental` scope, and the transformer moved in with them:

| v1 | v2 |
|---|---|
| `@flamework/core` | `@flamework-experimental/core` |
| `@flamework/components` | `@flamework-experimental/components` |
| `@flamework/networking` | `@flamework-experimental/networking` |
| `rbxts-transformer-flamework` | `@flamework-experimental/transformer` |

```sh
npm uninstall @flamework/core @flamework/components @flamework/networking rbxts-transformer-flamework
npm install @flamework-experimental/core @flamework-experimental/components @flamework-experimental/networking
npm install -D @flamework-experimental/transformer
```

Install the ones you use, and upgrade them together: the [changelog](../../CHANGELOG.md) says which
releases depend on each other. Then:

- **Imports.** `@flamework/core` becomes `@flamework-experimental/core`, and so on for every import.
- **`tsconfig.json`.** The transformer entry becomes
  `{ "transform": "@flamework-experimental/transformer" }`, and `typeRoots` lists
  `node_modules/@flamework-experimental` where it listed `node_modules/@flamework`. Options written
  inline on the entry still work, and win over `flamework.config.json`; v1's `preloadIds` has no
  counterpart.
- **`flamework.json`** becomes `flamework.config.json`, next to `tsconfig.json`, with a section per
  package ([Project structure › Configuration](09-project-structure.md#configuration)). v1's
  `profiling` is `core.profiling`; `logLevel` and `disableDependencyWarnings` have no counterpart
  (v1's warning for `Dependency<T>()` before `ignite()` is an error now; see step 5), and the new
  file rejects keys it does not know. Nothing reads `flamework.json` any more.
- **Rojo.** Where the project file maps `node_modules/@flamework`, map each runtime package under
  `@flamework-experimental` instead -- not the whole folder, which holds the transformer too. See
  [Getting started › Rojo](01-getting-started.md#rojo).
- **Build output.** Delete `out/` before the first v2 build. The roblox-ts template builds
  incrementally, with its `tsbuildinfo` in `out/`, and an incremental build starts from v1's
  `flamework.build`, which the transformer refuses: `Project was compiled on different version of
  Flamework. Please recompile by deleting the out directory`.

A library built on v1 imports `@flamework/core` and does not work with v2 until it is ported --
`@rbxts/flamework-react-utils`, for one, calls `Flamework.resolveDependency`, whose replacement is in
step 5.

### 2. Replace the entry point

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

### 3. Rename the decorators

`@Service()` and `@Controller()` both become `@Provider()`. Nothing about a provider is
realm-specific any more; which realm gets it is decided by which entry point registers its folder,
so keep the folders separate.

If you had a class used on both realms with different behaviour, that is now two classes in two
folders, or one class registered by both.

`loadOrder` moves to `@Provider({ loadOrder })`, with v1's meaning: lower first, default `1`, ordering
`onInit` and `onStart`. One difference: v1 sorted by `loadOrder` before dependencies, so a provider
could be initialised before one it injected; v2 initialises dependencies first and orders what
that leaves free, and `onStart` follows `loadOrder` alone. See
[Lifecycle events](04-lifecycle-events.md#load-order).

### 4. Lifecycle events are still on

`OnInit`, `OnStart`, `OnTick`, `OnPhysics` and `OnRender` work as they did. They are provided by
`LifecyclePlugin`, an ordinary plugin every module starts with, so there is nothing to add. `OnInit`
still runs after construction, in dependency order, may return a Promise, and everything after it
waits; `onPhysics` still receives `(dt, time)`. The signals are v1's too: `onTick` on `Heartbeat`,
`onPhysics` on `PreSimulation` (v1 called it `Stepped`), `onRender` on `PreRender`.

`OnRender` only connects on the client; a provider implementing it on the server is simply inert.

### 5. `Dependency<T>()` still works -- for providers

It answers from the **default module**: the first root ignited in the realm, which for a game is the
one the entry point ignites. For a provider, nothing to change, though constructor injection is
still the better shape inside a provider:

```ts
// still fine, once a module has ignited
const economy = Dependency<Economy>();

// better, inside a provider
constructor(private economy: Economy) {}
```

If a realm ignites more than one root -- tests, tools -- pass `{ default: true }` to the one
`Dependency<T>()` should answer from, or use `module.resolveDependency<T>()` on the handle.

What changed is what it can resolve. v1's `Dependency<T>()` built **any** decorated class as a
singleton the first time it was asked for, registered or not -- a `@Component({})` with no tag
reached only through `Dependency<T>()`, say. v2 resolves the providers a module registers, and
nothing else:

- a **component** is refused at compile time (`'X' is a component (@Component), not a provider`).
  Make it a `@Provider()` -- `@Provider({ lazy: true })` keeps v1's "built when first asked for" --
  or get it from `Components` on its instance;
- a `@Provider()` that no registered folder, registration, plugin or import brings in raises at
  runtime, saying so and naming the module the class is defined in.

See [Providers](03-providers.md#asking-for-something-that-is-not-a-provider).

v1's `Flamework.resolveDependency(id)` took the id as a string, and libraries built on v1 call it --
`useFlameworkDependency` in `@rbxts/flamework-react-utils`, for one. In v2 the id is `Dependency`'s
second argument: `Dependency<T>(undefined, id)` answers from the default module, and
`module.resolveDependency<T>(id)` from a module you hold. A macro of your own takes the id of a type
argument with `Modding.Target.Id<T>`:

```ts
import { Dependency, Modding } from "@flamework-experimental/core";

/** @metadata macro */
export function resolve<T>(id?: Modding.Target.Id<T>): T {
    return Dependency<T>(undefined, id);
}

const economy = resolve<Economy>();
```

An id passed this way is not checked when you compile, as a type argument is: asking for a
component's id raises when the call runs.

### 6. Update components

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

Two things behave differently:

- **Components attach after the providers start.** v1's `Components` was itself a service and a
  controller, with `loadOrder: 0`, and built the components of the instances tagged so far in its
  own `onStart`, before the `onStart` of every provider left at the default `loadOrder`. v2 starts
  watching tags once the module has ignited: after every provider's `onStart` has been called,
  whatever its `loadOrder`, and has run up to its first yield. A provider's `onStart` that reads
  `getAllComponents<T>()` finds none of the instances tagged before ignition; connect
  `onComponentAdded<T>(cb)` there instead, which hears each of them as it is built. (`onInit` saw
  none in v1 either.)
- **An attribute its guard rejects takes the component down.** v1 ignored such a change, and the
  component kept the last good value. v2 removes the component, and builds it again, reading the
  attributes afresh, once the attribute is valid -- unless a `defaults` entry covers that attribute,
  which keeps the component with its last good value, as v1 did. `refreshAttributes: false` does not
  change this: it stops `this.attributes` following the instance and `onAttributeChanged` firing,
  not the check. See [What takes a component down again](05-components.md#what-takes-a-component-down-again).

### 7. Replace `Modding.onListenerAdded`

v1's `Modding.onListenerAdded<T>(cb)` worked from anywhere, at any time: it replayed the providers
and components implementing `T` that already existed, then reported new ones. v2 has no global
registry to ask; what replaces it depends on what you listen for.

**Providers: observe from a plugin.** A plugin's `target.observe<T>` hears every object of the
module that implements `T` -- each provider as it is constructed, and the components and anything
else attached through `createClassInstance` or `listen` -- and hears it again when it goes:

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

`observe` replays nothing, so it belongs in the plugin's setup, before the first provider is
constructed, and only a plugin has it: a provider cannot subscribe to the module it is in. One that
subscribed from its `onStart` in v1 takes the set from the plugin instead, which keeps it and hands
it to the module with `provideInstance`:

```ts
export class PlayerListeners {
    public readonly all = new Set<OnPlayerJoined>();
}

export const PlayerListenersPlugin = Flamework.createPlugin("PlayerListeners", (target) => {
    const listeners = new PlayerListeners();
    target.provideInstance(listeners);
    target.observe<OnPlayerJoined>({
        onAdded: (value) => listeners.all.add(value),
        onRemoved: (value) => listeners.all.delete(value),
    });
});

@Provider()
export class Lobby implements OnStart {
    constructor(private readonly listeners: PlayerListeners) {}

    public onStart() {
        Players.PlayerAdded.Connect((player) => {
            for (const listener of this.listeners.all) listener.onPlayerJoined(player);
        });
    }
}
```

**Components: ask `Components`.** Its polymorphic methods take an interface and answer at any time:
`getAllComponents<T>()` for the components there are, `onComponentAdded<T>(cb)` and
`onComponentRemoved<T>(cb)` for the ones that come and go. `onComponentAdded` does not replay the
ones that exist, as v1's `onListenerAdded` did, so read those first:

```ts
@Provider()
export class PriceTags implements OnStart {
    constructor(private readonly components: Components) {}

    public onStart() {
        for (const tag of this.components.getAllComponents<ShowsPrice>()) this.show(tag);
        this.components.onComponentAdded<ShowsPrice>((tag) => this.show(tag));
        this.components.onComponentRemoved<ShowsPrice>((tag) => this.hide(tag));
    }

    private show(tag: ShowsPrice) {}
    private hide(tag: ShowsPrice) {}
}
```

A generic helper of your own -- an `onListenerAdded<T>` kept for the old call sites, say -- is a
macro that takes `id?: Modding.Target.Id<T>` and passes it on as the last argument:
`getAllComponents<T>(id)`, `onComponentAdded<T>(cb, id)`, `onComponentRemoved<T>(cb, id)`.

See [Plugins](08-plugins.md#observing-interfaces) and
[Working with components](05-components.md#working-with-components).

### 8. Custom decorators

v1's `Modding.createDecorator`, `createMetaDecorator`, `getDecorators`, `getDecorator`,
`getPropertyDecorators` and `Reflect.decorate` are gone, along with the global class registry behind
them (`Reflect.idToObj`, `Modding.getObjectFromId`). A decorator is now an ordinary function whose
JSDoc tells the transformer which metadata to attach, and which records whatever it wants on the
class with `Reflect`:

```ts
import { Reflect } from "@flamework-experimental/core";

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
walk a folder and filter on your own metadata. `getClassesInPath` returns every class with its own
Flamework identifier that the modules under the path define at their top level, exported or not,
plus what they export that carries one, each once -- the classes v1's registry held, scoped to a
folder:

```ts
import { getClassesInPath, Reflect } from "@flamework-experimental/core";

export function findCommands(path: readonly string[], register: (name: string, ctor: object) => void) {
    for (const ctor of getClassesInPath(path)) {
        const name = Reflect.getOwnMetadata<string>(ctor, "myGame:command");
        if (name !== undefined) register(name, ctor);
    }
}
```

`getClassesInPath` takes the Rojo path array the `path` intrinsic produces; wrap it in a macro of
your own so callers can pass `"src/server/commands"` -- [Macros › Paths](07-macros.md#paths) shows
one. A folder v1 loaded with `Flamework.addPaths` only for what its modules do as they load --
modules that register themselves with a library, say -- is `requireModulesInPath` behind the same
kind of macro. Property and method decorators work the same way, with
`Reflect.defineMetadata(ctor, key, value, propertyName)`.

### 9. Rename the macro types

The types a macro's parameters use are grouped now: what describes the callsite is under
`Modding.Caller`, what describes a type argument under `Modding.Target`, and `Many` is `Emit`. The
rename is mechanical, except where the table says what else changed:

| v1 | v2 |
|---|---|
| `Modding.Many<T>` | `Modding.Emit<T>` |
| `Modding.Generic<T, "id">` | `Modding.Target.Id<T>` |
| `Modding.Generic<T, "text">` | `Modding.Target.Text<T>` |
| `Modding.Generic<T, "guard">` | `Modding.Target.Guard<T>` |
| `Modding.GenericMany<T, "id" \| "guard">` | `Modding.Emit<{ id: Modding.Target.Id<T>; guard: Modding.Target.Guard<T> }>` |
| `Modding.Caller<"line">`, and `"character"`, `"width"`, `"text"` | `Modding.Caller.Line`, and `Character`, `Width`, `Text` |
| `Modding.Caller<"uuid">` | `Modding.Caller.Uuid`. v1 generated a random one on every compile; v2 derives it from the callsite, so the same source gives the same one in every build unless obfuscation is on |
| `Modding.CallerMany<"line" \| "text">` | `Modding.Emit<{ line: Modding.Caller.Line; text: Modding.Caller.Text }>` |
| `Modding.TupleLabels<T>` | `Modding.Target.Labels<T>` |
| `Modding.Hash<T, C>`, `Modding.Obfuscate<T, C>` | `Modding.Target.Hash<T, C>`, `Modding.Target.Obfuscate<T, C>` |
| `Modding.Intrinsic<"path", [T]>` | `Modding.Intrinsic<"path", [T], string[]>`: the value is one Rojo path, where v1's was a list holding one (`string[][]`). See [Macros › Paths](07-macros.md#paths) |
| `IntrinsicSymbolId<T>` from `@flamework/core/out/utility` (`Modding.Intrinsic<"symbol-id", [T], string>`) | `Modding.Target.Id<T>` |
| `Modding.Intrinsic<"declaration-uid", [], string>`, the id of the declaration a call sits in | gone; `Modding.Caller.Uuid` identifies the callsite |

```ts
// v1
/** @metadata macro */
export function validate<T>(value: unknown, guard?: Modding.Generic<T, "guard">): value is T {
    return guard!(value);
}

// v2
/** @metadata macro */
export function validate<T>(value: unknown, guard?: Modding.Target.Guard<T>): value is T {
    return guard!(value);
}
```

New in v2 are `Modding.Caller.Constant<T>`, metadata generated once per callsite and shared by
every call, and `Modding.Target.Dependency<T>` and `DependencyConcise<T>`, the id and metadata
dependency injection resolves a type by. See [Macros](07-macros.md).

### 10. Networking

`createEvent`, `createFunction`, namespaces, guards and `Networking.Skip` are as they were. What
changed:

- **`processNext` returns the next link's result, not a Promise**: nothing for an event, the value
  or `Networking.Skip` for a function. A middleware that returns `processNext(...)`, or `await`s it,
  needs no change. One that chained on it, `processNext(...).andThen(f)` (or `.then(f)`), calls `f`
  on the result instead:

  ```ts
  // v1
  const logPurchases: Networking.FunctionMiddleware<[itemId: string], boolean> = (processNext) => {
      return (player, itemId) =>
          processNext(player, itemId).andThen((bought) => {
              print(player, itemId, bought);
              return bought;
          });
  };

  // v2
  const logPurchases: Networking.FunctionMiddleware<[itemId: string], boolean> = (processNext) => {
      return (player, itemId) => {
          const bought = processNext(player, itemId);
          print(player, itemId, bought);
          return bought;
      };
  };
  ```

  An error further down is now raised through `processNext` rather than rejecting a Promise, so a
  `.catch` or `.finally` becomes a `try`/`catch` or `try`/`finally` around the call. See
  [Middleware](06-networking.md#middleware).
- **`connect` and `registerHandler` return a `Networking.Connection`** -- `Connected`,
  `Disconnect()`, and `Destroy()` for maids and janitors -- networking's own rather than an engine
  `RBXScriptConnection`. Code that stores one as `RBXScriptConnection` still compiles, since the
  shape matches; name `Networking.Connection` instead. `typeIs(connection, "RBXScriptConnection")`
  is false for one.
- **Handlers are no longer tied to the lifetime of the script that connected them**, as v1's were
  through a BindableEvent. A roblox-ts project does not destroy its scripts, so nothing changes for
  a normal project.
- **Each handler runs at once, on a thread of its own**, newest connection first, rather than when a
  BindableEvent delivers it, which the engine defers under `SignalBehavior.Deferred`.

### 11. Removed without replacement

- **Primitive dependencies.** v1 could inject a string or number literal type (`$ps:`/`$pn:` ids).
  Register a function provider under an interface instead.
- **`Modding.registerDependency`.** Use a function or alias provider on the module.
- **`Modding.onListenerAdded` without an id** (every listener). Register an interface per event.
- **`Flamework.hash`.** `Modding.Target.Hash` still exists for writing a macro of your own.

### 12. Externally created classes

v1 made a `@Service()` or `@Controller()` class a singleton as soon as its module had loaded,
wherever it sat. v2 registers only what the module is given, so register a provider that no
registered folder holds by hand:

```ts
// v1
Modding.createDependency(Helper); // a one-off instance, with injection

// v2 -- a provider outside the registered folders
.registerClassProvider(SomeService)

// v2 -- a one-off instance with injection but no registration
@Injectable()
class Helper {}

module.createClassInstance(Helper);
```

## What did not change

The transformer works the same way for everything built on it: `Flamework.id`,
`Flamework.implements`, `Flamework.createGuard`, `Modding.inspect`, and writing your own macros with
`@metadata macro` -- with the macro types renamed ([step 9](#9-rename-the-macro-types)).

Networking's `createEvent`, `createFunction`, namespaces, guards, `Networking.Skip` and the error
values are as they were; middleware, connections and handlers changed ([step 10](#10-networking)).

## Things to check after migrating

- Did you call `disableDefaultLifecycle()` anywhere? It is now the only way lifecycle events go
  missing, `onInit` included, and components stop ticking with them.
- Did anything rely on `@Optional`? Replace it with `@Provider({ lazy: true })`.
- Did anything rely on `Modding.getDecorators`? Replace it with path scanning and your own metadata.
- Are your component folders registered with `ComponentPlugin`, not `registerProviders`?
- Did any `@Service` rely on being server-only? Providers are not realm-gated; the module decides.
- Did anything rely on `loadOrder`? Move it to `@Provider({ loadOrder })`; a provider it injected is
  now initialised before it whatever the numbers say.
- Does anything call `Dependency<T>()` on a component, or on a class no folder registers? v1 built
  it on demand; v2 does not.
- Is any decorated class in a registered folder meant to stay out of the module? Unexported classes
  are registered now, as in v1: move it out of the folder, or into the function that uses it.
- Does a provider's `onStart` expect the components of tagged instances to exist already? They are
  built after it now.
- Does anything count on a component surviving an invalid attribute? Give the attribute a
  `defaults` entry.
- Did anything count on a networking handler going away with the script that connected it?
  Handlers are no longer tied to that script's lifetime; a roblox-ts project does not destroy its
  scripts, so nothing changes for a normal project.
- Is the whole `node_modules/@flamework-experimental` folder mapped in your Rojo project? Map the
  runtime packages one by one, or ignore the transformer.
- Do any constructors yield? They used to be tolerable; now they stall ignition.
- Is there exactly one `ignite()` per realm? Two containers do not share providers, and
  `Dependency<T>()` answers from the first.

---

Previous: [Project structure](09-project-structure.md) · Back to the [index](../README.md)
