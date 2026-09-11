# 5. Components

A component is a class bound to an Instance, usually through a CollectionService tag. Flamework
constructs one per tagged instance, validates its attributes and its instance tree, and destroys it
when the tag goes away.

```sh
npm install @flamework-experimental/components
```

## Your first component

```ts
// src/shared/components/vehicle.ts
import { BaseComponent, Component } from "@flamework-experimental/components";
import { OnStart } from "@flamework-experimental/core";

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
import { ComponentPlugin } from "@flamework-experimental/components";

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
`onTick`, `onPhysics` and `onRender` from **that module's** lifecycle plugin, which every module
starts with. `onStart` is the exception: `Components` calls it itself, so it works even with
`disableDefaultLifecycle()`.

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

### Writing an attribute

Assigning to `this.attributes` writes the value back to the instance:

```ts
this.attributes.speed = 32;
this.attributes.speed += 8;
this.attributes.speed++;
delete this.attributes.label;
```

The write has to be spelled `<component>.attributes.<name>` -- that is the shape the transformer
rewrites -- but the component does not have to be `this`: one reached through `getComponent` is
written the same way. Through a local (`const attributes = this.attributes; attributes.speed = 32`)
it is an ordinary table write, and the instance never hears about it. A read-modify-write (`+=`,
`++`, `--`) evaluates the component expression a second time for the value it computes, so keep side
effects out of it.

Every write is checked against the same guard the attribute was accepted with, and raises if it
fails. That is there for the write a cast let through:

```ts
// Raises: 'fast' is not a valid value for attribute 'speed' of '...'
this.attributes.speed = someString as unknown as number;
```

Without the check the component would be left holding a value its own declared type says is
impossible, and the instance would carry it too -- rejecting the component the next time one is
built. Writing `undefined` to a required attribute raises for the same reason; an optional one
accepts it and the attribute is cleared.

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

A child cannot be optional, and Flamework rejects one at compile time:

```ts
// Rejected: `this.instance.Head` would error whenever the child is missing
export class Character extends BaseComponent<{}, Model & { Head?: BasePart }> {}
```

`this.instance.Head` is an index into the instance itself, and Roblox raises on a child that is not
there rather than handing back nothing -- the `if (this.instance.Head)` written to check for it
raises too. The optional type would promise a read that cannot be made. Require the child, or leave
it out of the tree and reach for it with `FindFirstChild`. A child naming a **component** is the
exception, because Flamework watches whether it is there; see [links](#links).

Attributes are a different mechanism and stay optional: a missing one reads back as `undefined`, so
`label?: string` is fine.

Override it entirely with `instanceGuard` if the generated one is not what you want.

## Links

An attribute or a child can name another instance, and Flamework will wait for it, keep it resolved,
and take the component down again if it goes away. Two things can be named: an instance, or a
component on one.

### Instance attributes

An attribute typed as an Instance is stored on the instance as an `InstanceHandle`, which is what
Roblox's own instance-valued attributes are:

```ts
interface Attributes {
    Target: BasePart;
    Spare?: BasePart;
}

@Component({ tag: "Turret" })
export class Turret extends BaseComponent<Attributes, Model> {
    public onStart() {
        // The handle is resolved for you; this is the part itself.
        print(this.attributes.Target.Position);
    }
}
```

The component is not constructed until the handle resolves. A handle is empty until the instance it
names has streamed in at least once, so under StreamingEnabled a far-away target keeps the component
waiting -- and once it has streamed in it stays resolved, even if it streams back out.

Assigning writes a fresh handle, after checking the instance the way the link was resolved:

```ts
this.attributes.Target = otherPart;
```

The check is the whole guard, structure included: a link to a component that declares
`Model & { Root: BasePart }` only accepts a model that has that child. An instance that could never
be right raises.

An attribute typed `InstanceHandle` is left alone: you get the handle, and no waiting. That is the
opt-out when you want to do the resolving yourself.

`defaults` works here as it does elsewhere: give an instance and an attribute that was never written
is filled in with a handle for it, rather than keeping the component waiting. That holds for an
optional link too, whose guard would happily accept the attribute being missing: the default is
written to the instance either way, so the component and the instance never disagree about what the
link names. It stands in for an attribute the component was **built** without, not for one it has
since written away -- clearing an optional link clears it, and the default is applied again the next
time a component is built.

### Naming a component

Type an attribute or a child as a **component** rather than an Instance, and the instance it names
has to carry that component:

```ts
interface Tree extends Model {
    EffectHandler: EffectHandlerComponent;
    Barrel: BasePart;
}

@Component({ tag: "Turret" })
export class Turret extends BaseComponent<{ Owner: PlayerComponent }, Tree> {
    public onStart() {
        // `instance` holds instances, and the components sit beside it.
        const part: BasePart = this.instance.EffectHandler;

        this.childComponents.EffectHandler.playEffect();
        this.attributeComponents.Owner.credit();
    }
}
```

`this.instance` keeps holding instances -- `this.instance.EffectHandler` is the part the component is
attached to, which is what the generated instance guard checks. The components themselves live in
`childComponents` and `attributeComponents`, whose fields are readonly: Flamework owns them, and
reassigning one would only put it out of step with the instance.

`Turret` is not constructed until `EffectHandler` exists **and** carries its component, in either tag
order, and it is removed again if that component goes away. This is the same criteria mechanism
component dependencies and streaming use, so the warning that lists what a component is waiting for
names the link.

A link resolves the class it names and **nothing else**. A subclass does not stand in for its
parent, and an instance carrying several components hands back the one the link names rather than
whichever came first -- there is no ambiguity to resolve. That holds in both directions: another
component leaving the linked instance changes nothing, a subclass of the one it names included. The
guard is the whole shape too: a link to a component declaring `Model & { Root: BasePart }` only
accepts a model that has that child.

A link waits for what `getComponent` would hand back, and for the ancestor lists on top of it: a
linked component that a `predicate` refuses, or one whose instance sits under a blocked ancestor,
leaves the link unmet and the component unbuilt. It never reports the link met and then fails to
build it, and it never builds one there itself -- pointing a link attribute at a tagged instance
under a blocked ancestor leaves the link unmet rather than constructing the component the ancestor
lists refused. The ancestor lists gate *construction* rather than the link, so a component that is
already attached to a blocked instance -- added by hand, or built by a `getComponent` of your own --
does satisfy the link.

"What `getComponent` would hand back" is the whole of it: a link is met by an instance that already
carries the component **or** by one Flamework would build it on, and the answer is the same whether
or not anything happens to be tracking that instance yet. So a spawner can tag a whole tree and ask
for its component in the same breath -- tag announcements arrive a resumption later, and
`getComponent` builds the link's component on the way to building yours, rather than refusing
because the announcement has not landed.

A link that names its own component on its own instance is unmet for the same reason, and it is the
one link that can never be met on the way in: the component would have to already exist to be built.
So it is not built, and the link says so rather than raising out of the tag that asked for it. Point
the attribute somewhere else -- or, if it is optional, clear it -- and the component is built;
pointing it back at its own instance afterwards resolves to the component that is now there. A ring
of links reads the same way, however many instances it goes round: none of it can be built out of
nothing, so the ring is unmet until something in it exists for another reason.

That promise covers a rebuild as well. Roblox delivers the tree's signals a resumption late, so a
change that takes a component down and a change that should keep it down can arrive one after the
other; every link is therefore read from the instance again on the way in, rather than trusted to
still be whatever it last reported. A component is built only when the tree agrees.

The guard is kept current too, not read once when the attribute is written. A link to a component
declaring `Model & { Root: BasePart }` is unmet while the model it names has no `Root`, and becomes
met when one is parented in -- so an attribute may be written before the instance it names is
finished, and the component is built when it is.

A component can only be named as a **direct** member of the tree. One further down raises at compile
time, because `this.instance` would have nowhere to put it -- declare it on the component attached to
that child instead, or look it up with `getComponent`.

A child naming a component may be **optional**, which a plain child may not:

```ts
@Component({ tag: "Cannon" })
export class Cannon extends BaseComponent<{}, Folder & { Core?: CoreComponent }> {
    public onStart() {
        // The link is what says whether the child is there.
        this.childComponents.Core?.spin();
    }
}
```

The component builds with or without `Core`, and is built again when it arrives or leaves, so
`childComponents.Core` is either the component or `undefined` for the whole life of one. Read it
there rather than on the instance: `this.instance.Core` is still an index into the instance and
raises while the child is missing.

#### Writing one

Assigning an instance that is the right shape but does not carry the component **yet** is a matter of
timing rather than a bad value, so it does not raise. Writing it would unqualify the component doing
the writing and destroy it mid-method; instead the write is refused and Flamework warns. Wait for the
component first:

```ts
// Components has to be injected for this; ComponentMetadata comes first.
const [ok] = this.components.waitForComponent<Rig>(target).timeout(5).await();
if (!ok) return warn("that instance never got its component");

this.attributes.Rigged = target;
```

The resolved attribute type already asks for the linked component's instance type, so most of the
mistakes here are compile errors; the guard is what catches the ones a cast let through.

An instance under a blocked ancestor reads the same way, because a link never builds a component
somewhere the ancestor lists keep one out of: the write is refused and warned about, whether or not
that instance is tagged.

### What takes a component down again

| Change | Effect |
|---|---|
| The tag is removed | Removed. |
| The instance leaves the DataModel -- unparented, destroyed, or an **ancestor** of it unparented | Removed. CollectionService announces the tag as gone for the whole subtree that left, and announces it again when it is parented back in, so the components come back with it. Moving an instance *within* the DataModel announces nothing and changes nothing. |
| The component a link names is destroyed | Removed, whatever the streaming mode: that is a lifecycle event, not the tree moving. |
| Some **other** component on a linked instance is destroyed | **Kept**, including a subclass of the one the link names. |
| A link attribute is re-pointed at something that fails its guard | Removed, and built again if it is pointed back at something valid. |
| The instance a link attribute names stops passing its guard | Removed, and built again once it passes. The guard carries the whole shape, so a linked model losing the child the link asked for counts, whatever the streaming mode: the target's tree is not this component's tree. |
| A required link attribute is cleared from outside | Removed. |
| A plain attribute is changed to a value its guard rejects | **Kept.** The change is filtered out, `this.attributes` holds its last good value and `onAttributeChanged` does not fire. An attribute guard is a construction check, not a criterion. |
| A child a link names is replaced by another instance of the same name | Removed and built again around the new one, so it never holds a child that has left. |
| The child of an **optional** link arrives, or leaves | Removed and built again, so `childComponents` never names an instance the tree no longer holds. An optional link never holds construction up, but it is still part of the tree. |
| The instance tree stops matching -- a child goes, including one a link names | Follows `streamingMode` (below). |

A swap is worth calling out because signals are deferred: a child parented out and its replacement
parented in within one resumption arrives as a single change with a different instance on the end of
it, never a moment with no child at all. It is still a different tree, so it still rebuilds.

That holds even when the swap happens before Flamework was watching. `getComponent` builds a
component the moment you ask for it, while the tag that starts Flamework following its tree is
announced a resumption later; a tree that moves in between is weighed against the child the component
was actually built with, not against whatever the tree happens to hold once anything looks.

The last row is the only one the streaming mode has a say in, because it is the only one that is
about the tree rather than about another object's lifetime:

| `ComponentStreamingMode` | A child, or a child link, going away |
|---|---|
| `Contextual` (default) | Re-checked on a client, ignored on a server. |
| `Watching` | Re-checked, so the component goes and comes back with its tree. |
| `Disabled` | Read once and kept. The component stays, still holding the child it resolved to. |

`Disabled` reads the *tree* once, not the components in it. A child that moves elsewhere in the
DataModel keeps its tag and its components, and that is the case `Disabled` keeps the component
through. A child that is unparented or destroyed loses its own components on the way out, so a link
naming one of them is the `leaves the DataModel` row of the previous table rather than a streaming
question at all: the owner goes with it whatever the mode.

`Disabled` is about the component that was built, not about the next one. If something else takes
that component down -- a link attribute re-pointed at an instance its guard refuses, say -- the
build that follows reads the tree as it is then, so a child link the tree no longer holds keeps the
component down until it does.

### Waiting and warnings

| Option | Effect |
|---|---|
| `warningTimeout` | Seconds before Flamework says what a component is still waiting for, links included. |
| `attributeWarningTimeout` | Seconds before it says an attribute's instance has not streamed in. Defaults to `warningTimeout`. |

```ts
@Component({ tag: "Turret", attributeWarningTimeout: 10 })
```

Both default to 5 and `0` disables them. Keep instances an attribute names somewhere that is always
loaded -- ReplicatedStorage, or inside the same model -- and the wait never happens.

A warning is only ever about something that is **waiting**. A link watches the instance it names
without waiting for it, so it neither starts a warning nor keeps one alive: untag an instance again
and the warning goes with the tag, however many links are still watching, and tagging it once more
starts the wait over. The same goes down the chain, in both directions -- the components a watched
component depends on are watched too and report nothing until something asks for the component
itself, and when the tag that was asking goes, their warnings go with it.

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

The ancestor lists only gate construction Flamework drives -- a tag, or a link to the component --
so you can still attach a component by hand to something in ReplicatedStorage. The `predicate` also
gates the eager path in `getComponent`: an instance it rejects never gets a component unless you call
`addComponent` yourself, which ignores all three.

A component can also be tied to the build's scopes with `activeIn` and `inactiveIn`, on the
decorator or on the registration (`registerComponent(Class, { ... })`, `fromPath(path, { ... })`).
A component left out by scope is not registered in the plugin at all: it is never attached, and
`getComponent` on it raises with the reason. See [Scopes](11-scopes.md).

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

When a watched component's tree breaks apart again, the component is removed. That holds however the
component came to qualify: a tag arriving at an instance another component's link was already
watching re-reads the instance guard, and what it reads is what the tree is watched for next, so the
component still goes and comes back with its tree afterwards. If an instance never
qualifies, Flamework warns after `warningTimeout` seconds (default 5, `0` disables) listing the
criteria it is still waiting on -- that warning is usually the fastest way to find a typo in a tag
or a missing child.

## Component dependencies

A component can depend on another component **on the same instance**. Declare it as a constructor
parameter; `ComponentMetadata` has to come first, because `BaseComponent` takes it:

```ts
import { BaseComponent, Component, ComponentMetadata } from "@flamework-experimental/components";

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
| `onComponentRemoved<T>(cb)` | Fires **before** `destroy`, and after the component has left the lookups. |

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

- **`getComponent` constructs.** It is not a pure lookup: if the instance is in the DataModel,
  tagged, passes the predicate and qualifies, it builds the component then and there, ignoring the
  ancestor lists. Being in the DataModel is part of it because that is what announces the tag: an
  instance sitting in a pool, or a template being assembled, gets nothing until it is parented in.
  Whether some other component's link happens to be watching that instance makes no difference to
  the answer -- including a link that watched it while its instance guard was still failing, and
  including an instance under a blocked ancestor, where `getComponent` is the only way in and a link
  watching it is not allowed to close that way. It stays true as the tree goes on moving: a watched
  component still comes and goes with its tree on an instance a link found first. Use
  `getAllComponents` when you want to *observe* rather than ensure.
- **`getComponent` returns nothing for a component that is still constructing**, so a constructor
  asking for its own component sees `undefined`. Forcing the construction with `addComponent` from
  inside the constructor raises `component '...' is cyclic`.
- **Extinguishing the module destroys every component** and stops watching the tags. `addComponent`
  on the dead module raises; tagging an instance afterwards does nothing.
- **A `destroy` that raises does not hold up the teardown.** Whatever Flamework attached for the
  component -- the attribute-changed connections behind `onAttributeChanged` -- is released either
  way, so nothing is left firing into a component that has gone. On extinguish the failure is
  warned about and the remaining components still come down, so one component cannot leave a module
  half-extinguished. A hand `removeComponent` still re-raises it, since you asked for the removal.
- **Per-frame events come from the module's lifecycle plugin.** `disableDefaultLifecycle()` on the
  module that includes `ComponentPlugin` stops components ticking; `onStart` still runs.
- **An invalid attribute throws** unless a default is configured.
- **`onComponentRemoved` runs before `destroy`**, so the component is still usable inside it -- but
  it has already left `getComponent` and `getComponents` by then, and nothing builds a replacement
  while the removal is running, so the value the callback is handed is the only way to reach it. A
  hand removal leaves the tag alone, so asking a still-tagged instance for the component *after*
  `removeComponent` has returned builds a new one, the way it always has. That is also what keeps two
  components whose links name each other from removing one another twice: taking one down takes the
  other with it, once each. The announcement is delivered a resumption late, so a link weighs it
  against the instance as it stands when it arrives: a removal about a component the instance has
  since replaced -- because that same resumption asked for it again -- leaves the link alone and
  updates `childComponents` and `attributeComponents` to the component that is there now. Otherwise
  a cycle would remove and rebuild itself for as long as the place is running.
- **Attribute tracking is on by default.** `refreshAttributes: false` disables `onAttributeChanged`
  as well as the tracking.
- **A component with no `tag` can only be added by hand.**
- **`@Component` classes are not providers.** They are not picked up by `registerProviders`, and
  `registerComponents` will not pick up providers.
- **Component dependencies are same-instance only.** There is no cross-instance dependency; a link
  is how you reach another instance.
- **A linked component must be registered in the same plugin.** Igniting raises if it is not.
- **`addComponent` will not wait.** By hand, a link that has not resolved raises instead of yielding;
  through a tag, the component simply is not created until it has.
- **A link is only kept current for a tag-driven component.** One added by hand is resolved once,
  like its instance guard.
- **`refreshAttributes: false` freezes link attributes too**, so re-pointing one stops updating
  `this.attributes` and `attributeComponents`, and `onAttributeChanged` does not fire for them
  either. It is the component's *view* that is frozen, not the criterion behind it: a re-point the
  guard refuses still takes the component down, the same as it would with tracking on. The
  component's own writes still land -- in `this.attributes` and `attributeComponents` both -- and,
  exactly as for a plain attribute, they announce nothing.
- **Clearing a required link raises.** Only an optional one can be set back to `undefined`.
- **A write that fails its guard raises**, so an attribute never holds a value its type forbids.
- **A link write to an instance without the component warns and is refused**, rather than raising or
  destroying the component that wrote it. Await the component first.

---

Previous: [Lifecycle events](04-lifecycle-events.md) · Next: [Networking](06-networking.md)
