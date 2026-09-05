# 5. Components

A component is a class bound to an Instance, usually through a CollectionService tag. Flamework
constructs one per tagged instance, validates its attributes and its instance tree, and destroys it
when the tag goes away.

```sh
npm install @flamework/components
```

## Your first component

```ts
// src/shared/components/vehicle.ts
import { BaseComponent, Component } from "@flamework/components";
import { OnStart } from "@flamework/core";

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
```

`BaseComponent<A, I>` gives you `this.instance` typed as `I` and `this.attributes` typed as
`Readonly<A>`. Both type parameters are read by the transformer, which generates guards from them.

Register the components and include the plugin:

```ts
import { ComponentPlugin } from "@flamework/components";

Flamework.createModule()
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .registerProviders("src/server/services")
    .ignite();
```

Tag a `Model` with `Vehicle` in Studio, set a `speed` attribute, and the component constructs.

### Shorthand vs full form

```ts
// Shorthand: register a folder and build the plugin in one call
ComponentPlugin.fromPath("src/shared/components");

// Full form: the same thing, with room to add more
ComponentPlugin.createPlugin()
    .registerComponents("src/shared/components")
    .registerComponent(SpecialCase)
    .build();
```

Components are constructed through the module that includes `ComponentPlugin`, so they get
`onTick`, `onPhysics` and `onRender` from **that module's** `LifecyclePlugin` -- include it alongside
`ComponentPlugin`, as above. `onStart` is the exception: `Components` calls it itself, so it works
regardless.

Register by glob when the components are spread across feature folders:

```ts
ComponentPlugin.fromGlob("src/**/components");
```

As with providers, only classes decorated with `@Component()` **themselves** are registered; an
exported but undecorated subclass is skipped, and `registerComponent` raises for one.

## Attributes

Attribute guards are generated from the first type parameter. An instance whose attributes do not
match is rejected: the component is not created, and `addComponent` throws
`... has invalid attribute 'speed' for '...'`.

Optional properties are genuinely optional -- `label?: string` accepts a missing attribute.

### Defaults

Rather than rejecting, write a value back to the instance:

```ts
@Component({ tag: "Vehicle", defaults: { speed: 16 } })
```

A missing or invalid `speed` becomes `16`, and the attribute is set on the instance.

### Reacting to changes

Attributes are tracked by default, so `this.attributes` stays current:

```ts
this.onAttributeChanged("speed", (newValue, oldValue) => {
    print(`${oldValue} -> ${newValue}`);
});
```

Only values that pass the guard are applied, so a handler never sees a bad one. Turn tracking off
with `refreshAttributes: false`, which also disables `onAttributeChanged`.

### Overriding a guard

```ts
@Component({
    tag: "Vehicle",
    attributes: { speed: t.numberPositive },
})
```

## Instance guards

The second type parameter generates an instance guard: `BaseComponent<{}, Part>` will not attach to
a Folder. Intersect it with an object type to require children:

```ts
// Requires a Humanoid child before the component is created
@Component({ tag: "Character" })
export class Character extends BaseComponent<{}, Model & { Humanoid: Humanoid }> {}
```

Override it entirely with `instanceGuard` if the generated one is not what you want.

## Where components may attach

| Option | Effect |
|---|---|
| `predicate` | Rejects an instance outright, before anything else runs. |
| `ancestorWhitelist` | Only construct under these ancestors. Takes priority over the blocklist. |
| `ancestorBlacklist` | Never construct under these. Defaults to ServerStorage, ReplicatedStorage, StarterPack, StarterGui and StarterPlayer. |

```ts
@Component({ tag: "Prop", predicate: (instance) => instance.Name !== "Template" })
```

The default blocklist is why tagging a template in ReplicatedStorage does not spawn a component, and
why a tagged instance cloned into Workspace does.

The ancestor lists only gate CollectionService-driven construction, so you can still attach a
component by hand to something in ReplicatedStorage. The `predicate` also gates the eager path in
`getComponent`: an instance it rejects never gets a component unless you call `addComponent`
yourself, which ignores all three.

## Streaming

With StreamingEnabled an instance can arrive before its descendants, so an instance guard that
checks for children may fail and then pass a moment later.

| `ComponentStreamingMode` | Behaviour |
|---|---|
| `Contextual` (default) | Watches on the client; never on the server; skips atomic models, which replicate whole. |
| `Watching` | Always re-runs the instance guard as the tree changes. |
| `Disabled` | Runs the instance guard once. |

```ts
@Component({ tag: "Character", streamingMode: ComponentStreamingMode.Watching })
```

When a watched component's tree breaks apart again, the component is removed. If an instance never
qualifies, Flamework warns after `warningTimeout` seconds (default 5, `0` disables) listing the
criteria it is still waiting on -- that warning is usually the fastest way to find a typo in a tag
or a missing child.

## Component dependencies

A component can depend on another component **on the same instance**. Declare it as a constructor
parameter; `ComponentMetadata` has to come first, because `BaseComponent` takes it:

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

`Car` will not be constructed until `Engine` exists on the same instance, in either tag order. This
is the same criteria mechanism that streaming uses.

## Working with components

`Components` is a provider exported by the plugin, so inject it:

```ts
@Provider()
export class VehicleService {
    constructor(private components: Components) {}
}
```

| Method | Notes |
|---|---|
| `getComponent<T>(instance)` | Exact class only. Constructs eagerly if the instance qualifies. |
| `getComponents<T>(instance)` | Every component on the instance matching a class **or interface**. |
| `getAllComponents<T>()` | The same, across every instance. |
| `addComponent<T>(instance)` | Attaches by hand. Throws if the guards fail. |
| `removeComponent<T>(instance)` | Detaches and destroys. |
| `waitForComponent<T>(instance)` | Promise; resolves immediately if it already exists. |
| `onComponentAdded<T>(cb)` | Fires for every future component of that type. |
| `onComponentRemoved<T>(cb)` | Fires **before** `destroy`. |

`getComponent` needs the exact class. The polymorphic ones -- `getComponents`, `getAllComponents`,
and both listeners -- accept a superclass or an interface:

```ts
// every component on this instance that implements OnTick
for (const component of this.components.getComponents<OnTick>(instance)) {
    component.onTick(dt);
}
```

## Patterns

**Server and client components with the same tag.** Register different classes from the two entry
points; they attach to the same instances and never see each other.

**An interface for cross-cutting behaviour.** Declare `interface Damageable { takeDamage(n): void }`,
implement it on several components, and use `getComponents<Damageable>(instance)` to hit whichever
are present.

**`waitForComponent` at boundaries.** When a service needs a component that may not exist yet,
`await this.components.waitForComponent<Vehicle>(instance)` beats polling.

**Composition over inheritance.** Two components on one instance with a dependency between them is
usually clearer than a deep component hierarchy -- and it is the case Flamework's tracker is built
for.

## Caveats

- **`getComponent` constructs.** It is not a pure lookup: if the instance is tagged, passes the
  predicate and qualifies, it builds the component then and there, ignoring the ancestor lists. Use
  `getAllComponents` when you want to *observe* rather than ensure.
- **`getComponent` returns nothing for a component that is still constructing**, so a constructor
  asking for its own component sees `undefined`. Forcing the construction with `addComponent` from
  inside the constructor raises `component '...' is cyclic`.
- **Extinguishing the module destroys every component** and stops watching the tags. `addComponent`
  on the dead module raises; tagging an instance afterwards does nothing.
- **Per-frame events need `LifecyclePlugin` in the same module** as `ComponentPlugin`.
- **An invalid attribute throws** unless a default is configured.
- **`onComponentRemoved` runs before `destroy`**, so the component is still usable inside it.
- **Attribute tracking is on by default.** `refreshAttributes: false` disables `onAttributeChanged`
  as well as the tracking.
- **A component with no `tag` can only be added by hand.**
- **`@Component` classes are not providers.** They are not picked up by `registerProviders`, and
  `registerComponents` will not pick up providers.
- **Component dependencies are same-instance only.** There is no cross-instance dependency.

---

Previous: [Lifecycle events](04-lifecycle-events.md) · Next: [Networking](06-networking.md)
