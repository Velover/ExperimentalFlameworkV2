# Using Flamework

Flamework is a framework for roblox-ts built around **modules**: isolated dependency-injection
containers you ignite and extinguish explicitly. Everything else -- lifecycle events, components,
networking -- is a plugin or a package layered on top of that.

This document covers the v2 API. For the transformer plugin API, see
[transformer-plugins.md](transformer-plugins.md); for how any of this works inside, see
[internals.md](internals.md).

- [Setup](#setup)
- [Modules](#modules)
- [Providers and dependency injection](#providers-and-dependency-injection)
- [Composing modules](#composing-modules)
- [Plugins](#plugins)
- [Lifecycle events](#lifecycle-events)
- [Components](#components)
- [Networking](#networking)
- [Macros](#macros)
- [Coming from v1](#coming-from-v1)

## Setup

> v2 is unreleased. Until it is published, consume it from this repository -- see the development
> section of the [README](../README.md).

Install the packages you need and the transformer:

```sh
npm install @flamework/core
npm install -D rbxts-transformer-flamework
```

Flamework is a TypeScript transformer, so it has to be registered in `tsconfig.json`. Nothing in
this document works without it -- most of the API is a macro whose arguments the compiler fills in.

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "transform": "rbxts-transformer-flamework",

        // Lowers the chance of id collisions with other packages. Defaults to the package name.
        "hashPrefix": "$g",

        // Randomises remote names and shortens ids.
        "obfuscation": false,

        // Transformer plugins, which can add macro types of their own.
        "plugins": []
      }
    ]
  }
}
```

## Modules

A module is built with a chained builder and then ignited:

```ts
import { Flamework } from "@flamework/core";

const module = Flamework.createModule()
    .registerClassProvider(PlayerService)
    .registerClassProvider(MatchService)
    .ignite();
```

`ignite()` constructs every provider, runs the hooks, and returns a `Module`. `.build()` stops one
step earlier and returns a `ModuleDefinition`, which can be ignited later or included in another
module. A definition can be ignited more than once, and each ignition gets its own independent set
of provider instances.

`extinguish()` tears the module down: it releases the instances it created, unregisters them from
every plugin that claimed them, runs the `Extinguished` hooks, and extinguishes the modules it
created in turn.

```ts
module.extinguish();
```

Most games have exactly one module and never extinguish it. Tests, tools and UI code are where the
lifecycle earns its keep.

## Providers and dependency injection

A provider is a singleton within its module. Mark the class with `@Provider()` and register it:

```ts
import { Provider } from "@flamework/core";

@Provider()
export class Economy {
    public balance = 0;
}

@Provider()
export class Shop {
    // Resolved from the module by type; no tokens, no strings.
    constructor(private economy: Economy) {}
}

const module = Flamework.createModule()
    .registerClassProvider(Economy)
    .registerClassProvider(Shop)
    .ignite();
```

Registering a class that is missing `@Provider()` raises at build time, and registering two
providers under the same id raises at ignition.

To pull a dependency out by hand rather than through a constructor:

```ts
const shop = module.resolveDependency<Shop>();
```

### Registering by path

`registerProviders` takes a directory and registers every exported `@Provider()` class beneath it.
The path is resolved at compile time, so it must be a string literal.

```ts
Flamework.createModule().registerProviders("src/server/services").ignite();
```

### Other kinds of provider

Besides classes, a provider can be a factory or an alias for another id:

```ts
interface Config {
    readonly maxPlayers: number;
}

Flamework.createModule()
    // A function provider is called once, when the dependency is first resolved.
    .registerProvider<Config>({ type: "function", callback: () => ({ maxPlayers: 8 }) })
    // An alias resolves to another provider, which is how an interface gets an implementation.
    .registerProvider<Storage>({ type: "alias", injectionId: Flamework.id<DataStoreStorage>() })
    .ignite();
```

A function provider receives an `InjectionContext` describing what asked for it -- the requesting
module, the dependency info, and the class it is being injected into. That last one is what makes a
per-consumer logger possible:

```ts
.registerProvider<Logger>({
    type: "function",
    callback: (context) => new Logger(tostring(context.origin)),
})
```

### Injecting into a class that is not a provider

`@Injectable()` gives a class the metadata dependency injection needs without registering it as a
provider, so it is not picked up by path-based registration:

```ts
import { Injectable } from "@flamework/core";

@Injectable()
class Session {
    constructor(private economy: Economy) {}
}

const session = module.createClassInstance(Session);
```

The instance is owned by the module: it is attached to any lifecycle events it implements, and
released when the module is extinguished or when you call `module.removeClassInstance(session)`.

## Composing modules

Modules can include other modules. An included module is shared between every module that includes
it under the same root, and only its **exported** providers are visible to the includer:

```ts
const database = Flamework.createModule()
    .registerClassProvider(Connection)
    .registerClassProvider(QueryCache) // private to this module
    .exportProviders<Connection>()
    .build();

const game = Flamework.createModule().includeModule(database).registerClassProvider(Shop).ignite();

game.resolveDependency<Connection>(); // fine
game.resolveDependency<QueryCache>(); // raises: not exported
```

`exportProviders` takes a union to export several at once: `exportProviders<Connection | Session>()`.

## Plugins

A plugin is a module that can also modify the modules it is included in. It is built from a module
definition and can register hooks and interfaces:

```ts
import { Flamework, HookType } from "@flamework/core";

const metricsModule = Flamework.createModule().registerClassProvider(Metrics).build();

export const MetricsPlugin = Flamework.createPlugin(metricsModule)
    .registerHook({
        type: HookType.PostIgnite,
        callback: (context) => {
            context.sourceModule.resolveDependency<Metrics>().start(context.targetModule);
        },
    })
    .build();

Flamework.createModule().includePlugin(MetricsPlugin).ignite();
```

`sourceModule` is the plugin's own module; `targetModule` is the module the plugin was included in.
A plugin's module is instantiated once per module that includes it.

### Hooks

| Hook | When |
|---|---|
| `HookType.PreIgnite` | After included modules and plugins have ignited, before this module's providers are constructed. Register state that providers will resolve during construction here. |
| `HookType.PostIgnite` | After every provider has been constructed. |
| `HookType.Extinguished` | When `extinguish()` runs. |

Hooks of the same type on the same module run in `priority` order, lowest first, and in registration
order within a priority. `HookPriority.First`, `Normal` and `Last` are conventional anchors so that
plugins can order themselves without agreeing on magic numbers.

```ts
.registerHook({ type: HookType.PostIgnite, callback: ..., priority: HookPriority.First })
```

### Interfaces

An interface lets a plugin observe every provider that implements a given type. This is how
lifecycle events are implemented.

```ts
interface OnPlayerJoined {
    onPlayerJoined(player: Player): void;
}

Flamework.createPlugin(module)
    .registerInterface<OnPlayerJoined>({
        onAdded: (context, value) => listeners.add(value),
        onRemoved: (context, value) => listeners.delete(value),
    })
    .build();
```

`onAdded` fires for every provider the module constructs that structurally implements the interface,
and for anything passed to `createClassInstance` or `listen`. `onRemoved` fires when the instance is
released or the module is extinguished.

## Lifecycle events

`LifecyclePlugin` provides the per-frame events. Include it and implement the interfaces:

```ts
import { Flamework, LifecyclePlugin, OnStart, OnTick } from "@flamework/core";

@Provider()
class Spawner implements OnStart, OnTick {
    public onStart() {}
    public onTick(dt: number) {}
}

Flamework.createModule().includePlugin(LifecyclePlugin).registerClassProvider(Spawner).ignite();
```

| Interface | Fires on |
|---|---|
| `OnStart` | Once, after the module ignites. Runs on its own thread. |
| `OnTick` | `RunService.PostSimulation` |
| `OnPhysics` | `RunService.PreSimulation` |
| `OnRender` | `RunService.PreRender` (client only) |
| `OnExtinguished` | `extinguish()` |

For a one-off listener that is not a provider, `module.listen` takes an object or, for
single-method interfaces, a bare function. It returns a destructor:

```ts
const stop = module.listen<OnTick>((dt) => print(dt));
stop();
```

## Components

A component is a class bound to an Instance, usually through a CollectionService tag.

```ts
import { BaseComponent, Component, ComponentPlugin, Components } from "@flamework/components";
import { Flamework, OnStart } from "@flamework/core";

interface Attributes {
    speed: number;
    label?: string;
}

@Component({ tag: "Vehicle" })
export class Vehicle extends BaseComponent<Attributes, Model> implements OnStart {
    public onStart() {
        print(this.instance.Name, this.attributes.speed);
    }
}

const module = Flamework.createModule().includePlugin(ComponentPlugin.fromPath("src/components")).ignite();
```

`ComponentPlugin.fromPath` registers every component under a directory. To register explicitly:

```ts
const plugin = ComponentPlugin.createPlugin().registerComponent(Vehicle).build();
```

### Attributes and guards

The attribute guards and the instance guard are both generated from the type parameters. An instance
whose attributes do not match is rejected, unless a default is configured:

```ts
@Component({ tag: "Vehicle", defaults: { speed: 16 } })
```

`BaseComponent<A, I>`'s second parameter also generates an instance guard. Intersecting it with an
object type requires those children to exist:

```ts
// Requires a `Humanoid` child before the component is created.
class Character extends BaseComponent<{}, Model & { Humanoid: Humanoid }> {}
```

Attribute changes are tracked by default; `onAttributeChanged` reports the old and new value.

```ts
this.onAttributeChanged("speed", (newValue, oldValue) => print(oldValue, "->", newValue));
```

Pass `refreshAttributes: false` to stop tracking, which also disables `onAttributeChanged`.

### Configuration

| Option | Effect |
|---|---|
| `tag` | The CollectionService tag to bind to. Without one, the component can only be added manually. |
| `attributes` | Override the generated guard for specific attributes. |
| `defaults` | Substitute a value instead of rejecting an instance whose attribute fails its guard. |
| `instanceGuard` | Override the generated instance guard. |
| `predicate` | Reject an instance outright, before anything else runs. |
| `refreshAttributes` | Whether to track attribute changes. Defaults to `true`. |
| `ancestorWhitelist` | Only construct under these ancestors. Takes priority over the blocklist. |
| `ancestorBlacklist` | Never construct under these. Defaults to ServerStorage, ReplicatedStorage, StarterPack, StarterGui and StarterPlayer. |
| `warningTimeout` | How long an instance may fail its criteria before a warning. `0` disables. |
| `streamingMode` | See below. |

The ancestor lists only gate CollectionService-driven construction. `addComponent` and the eager
path in `getComponent` deliberately ignore them.

### Streaming

With StreamingEnabled, an instance can arrive before its descendants do, so an instance guard that
checks for children may fail and then pass moments later.

| `ComponentStreamingMode` | Behaviour |
|---|---|
| `Contextual` (default) | Watches on the client, except for atomic models, which arrive whole. Never watches on the server. |
| `Watching` | Always re-runs the instance guard as the tree changes. |
| `Disabled` | Runs the instance guard once. |

When a watched component's tree breaks apart again, the component is removed.

### Component dependencies

A component can depend on another component on the same instance. Declare it as a constructor
parameter -- `ComponentMetadata` has to come first, because `BaseComponent` takes it:

```ts
import { BaseComponent, Component, ComponentMetadata } from "@flamework/components";

@Component({ tag: "Car" })
export class Car extends BaseComponent<{}, Model> {
    constructor(
        metadata: ComponentMetadata,
        private engine: Engine,
    ) {
        super(metadata);
    }
}
```

`Car` will not be constructed until `Engine` exists on the same instance, whichever order the tags
are added in.

### Working with components

`Components` is a provider, so inject it or resolve it from the module:

```ts
const components = module.resolveDependency<Components>();

components.getComponent<Vehicle>(instance);      // exact type, constructs eagerly if it qualifies
components.getComponents<OnTick>(instance);      // every component on the instance implementing OnTick
components.getAllComponents<OnTick>();           // across every instance
components.addComponent<Vehicle>(instance);
components.removeComponent<Vehicle>(instance);
components.waitForComponent<Vehicle>(instance);  // Promise
components.onComponentAdded<Vehicle>((component, instance) => {});
components.onComponentRemoved<Vehicle>((component, instance) => {});
```

`getComponent` needs the exact class. `getComponents`, `getAllComponents` and the listeners are
polymorphic: they accept a superclass or an interface the component implements.

## Networking

Networking is declared as a pair of interfaces -- what the server receives, and what the client
receives -- and everything else is generated from them.

```ts
import { Networking } from "@flamework/networking";

interface ServerEvents {
    setReady(ready: boolean): void;
}

interface ClientEvents {
    matchStarted(map: string): void;
}

export const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();
```

Each realm creates its own handler. The other realm's factory returns nothing, so guard it:

```ts
// server
const events = GlobalEvents.createServer({});
events.setReady.connect((player, ready) => print(player, ready));
events.matchStarted.fire(player, "Sandbox");
events.matchStarted.broadcast("Sandbox");
events.matchStarted.except(player, "Sandbox");

// client
const events = GlobalEvents.createClient({});
events.matchStarted.connect((map) => print(map));
events.setReady.fire(true);
```

`fire` also accepts an array of players. `predict` runs the receiving half locally, middleware and
all, which is useful for client prediction and for tests.

### Functions

```ts
interface ServerFunctions {
    buy(itemId: string): boolean;
}

export const GlobalFunctions = Networking.createFunction<ServerFunctions, {}>();

// server
GlobalFunctions.createServer({}).buy.setCallback((player, itemId) => shop.buy(player, itemId));

// client
const bought = await GlobalFunctions.createClient({}).buy.invoke("sword");
```

`invoke` returns a Promise and times out after `defaultTimeout` seconds -- 30 on the client, 10 on
the server. `invokeWithTimeout` overrides it per call. A rejection is a `NetworkingFunctionError`:

| Value | Meaning |
|---|---|
| `Timeout` | No response within the timeout. |
| `Cancelled` | Middleware returned `Networking.Skip`, or the player left. |
| `BadRequest` | Arguments failed the generated guards. |
| `Unprocessed` | The other realm has no callback set. |
| `InvalidResult` | The response failed the return type's guard. |

### Namespaces

Nest an object in the interface to group events. It gets its own remote, named after the path:

```ts
interface ServerEvents {
    stats: { report(value: number): void };
}

events.stats.report.connect((player, value) => {});
```

### Unreliable events

```ts
interface ClientEvents {
    position: Networking.Unreliable<(position: Vector3) => void>;
}
```

Unreliable events get an `UnreliableRemoteEvent` on their own channel. They may be dropped, so never
send state that later messages depend on.

### Configuration and middleware

```ts
const events = GlobalEvents.createServer({
    // Skip generated argument validation entirely.
    disableIncomingGuards: false,
    // Warn when a guard rejects something. Defaults to RunService.IsStudio().
    warnOnInvalidGuards: true,
    middleware: {
        setReady: [rateLimit(5)],
    },
});
```

The config, including the middleware object, has to be written inline: the transformer reads it at
compile time.

A middleware is a factory that receives the next processor and the event's `NetworkInfo`, and
returns the handler:

```ts
const rateLimit = (perSecond: number): Networking.EventMiddleware<[ready: boolean]> => {
    return (processNext, event) => {
        return (player, ready) => {
            if (isOverBudget(player, perSecond)) {
                return; // not calling processNext drops the event
            }

            return processNext(player, ready);
        };
    };
};
```

Middleware runs in the order it is registered, and the generated guards always run before all of it,
so user middleware never sees a payload that failed validation. Function middleware can additionally
return `Networking.Skip` to cancel the request, which rejects the caller with `Cancelled`.

To observe rejections:

```ts
GlobalEvents.registerHandler("onBadRequest", (player, data) => {
    warn(player, data.networkInfo.name, data.argIndex, data.argValue);
});
```

Functions also have `onBadResponse`, for a response that failed its return guard.

## Macros

Much of Flamework's API is a macro: the compiler fills in a parameter from the type arguments at the
callsite. The ones you are most likely to reach for:

```ts
Flamework.id<Shop>();                      // the type's generated identifier
Flamework.implements<OnTick>(value);       // does this object implement the interface?
Flamework.createGuard<{ x: number }>();    // a `t` guard generated from the type
Modding.inspect<Array<"a" | "b">>();       // ["a", "b"] at runtime
```

### Writing your own

Add `@metadata macro` to the declaration and make the generated parameters optional. Flamework fills
them in at each callsite:

```ts
import { Modding } from "@flamework/core";

/** @metadata macro */
export function logHere(message: string, line?: Modding.Caller.Line, text?: Modding.Caller.Text) {
    print(`${line}: ${text} -- ${message}`);
}

logHere("hello"); // prints e.g. "42: logHere("hello") -- hello"
```

`Modding.Caller` describes the callsite: `Line`, `Character` (both numbers), `Width`, `Text` and
`Uuid`, which is stable per callsite and unique across them. `Modding.Caller.Constant<T>` generates
the metadata once per callsite and shares it between invocations, which makes it usable as a cache
key.

`Modding.Target` describes a type argument: `Id`, `Text`, `Guard`, `Dependency`, `Labels` for tuple
parameter names, and `Hash`/`Obfuscate` for string literals.

```ts
/** @metadata macro */
export function validate<T>(value: unknown, guard?: Modding.Target.Guard<T>): value is T {
    return guard!(value);
}
```

`Modding.Emit<T>` emits a runtime value for a type -- objects, tuples, and unions via `Array<T>`.

## Coming from v1

- `@Service` and `@Controller` are both `@Provider`. There is no realm gate; register the providers
  the realm should have.
- `Flamework.addPaths(...)` plus `Flamework.ignite()` become
  `Flamework.createModule().registerProviders(path).ignite()`.
- Lifecycle events are no longer built in. Include `LifecyclePlugin`.
- `Flamework.registerExternalClass` and the singleton `Dependency<T>()` are gone; a module is the
  container, so resolve through it.
- Components need `ComponentPlugin`, and `Components` is resolved from the module rather than
  injected from a global.
- `Modding.onListenerAdded` is now a plugin interface: `registerInterface<T>({ onAdded, onRemoved })`.
