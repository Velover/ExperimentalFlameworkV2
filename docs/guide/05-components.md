# 5. Components

A **component** is a class attached to an Instance, usually through a CollectionService tag.
Flamework constructs one for each tagged instance, checks its attributes and its instance tree, and
destroys it when the tag is removed.

```sh
npm install @flamework-experimental/components
```

A Rojo project that maps the whole `node_modules/@flamework-experimental` folder in one line, as in
[Getting started › Rojo](01-getting-started.md#rojo), takes it in with nothing to add; one that maps
the packages by name needs a `components` entry next to `core`.

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

`BaseComponent<A, I>` gives you `this.instance`, typed as `I`, and `this.attributes`, typed as
`Readonly<A>`. The transformer reads both type parameters and generates *guards* from them: checks
that run at runtime.

Register the components and include the plugin:

```ts
import { ComponentPlugin } from "@flamework-experimental/components";

Flamework.createModule()
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .registerProviders("src/server/services")
    .ignite();
```

Tag a `Model` with `Vehicle` in Studio, set a `speed` attribute, and the component is constructed.

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

### Lifecycle

Components are constructed through the module that includes `ComponentPlugin`. So they get
`onTick`, `onPhysics` and `onRender` from **that module's** lifecycle plugin, which every module
starts with. `onInit` and `onStart` are the exceptions: `Components` calls both itself, so they work
even with `disableDefaultLifecycle()`. In order:

| Step | When |
|---|---|
| constructor | Dependencies are injected. `this.instance`, `this.attributes` and every link are already resolved. |
| `onInit()` | Runs synchronously, right after construction, **before the component can be seen**: `getComponent` has not handed it back yet, no other component holds it in `childComponents` or `attributeComponents`, and no `onComponentAdded` listener has heard of it. A Promise it returns is not awaited. If it raises, the component is **invalid** (see below). |
| attached | `getComponent` answers, links resolve to it, added listeners fire. |
| `onStart()` | Runs on its own thread, after the component is attached, and not before ignition has finished. So a component built from a provider's `onInit` starts once every provider has started. A component that removes itself here is announced as added and then as removed, and no `waitForComponent` is resolved with it. |
| per-frame events | From the module's lifecycle plugin. |
| `destroy()` | When the component is removed. `BaseComponent`'s own releases only the `onAttributeChanged` handlers; see [Cleaning up](#cleaning-up). |

Put the setup that anything else may rely on in `onInit`. Another component that links to this one
(see [Links](#links)) receives it already initialised, whichever of the two was tagged first.

**Tagged instances get their components once the module has ignited**, after every provider's
`onStart` has been called and has run up to its first yield: the plugin starts watching tags in its
`onIgnited` hook, after the lifecycle plugin has started the providers. So a provider's `onStart`
finds none of them with `getAllComponents<T>()` or `getComponents<T>(instance)`, and
`onComponentAdded<T>(cb)` connected there hears about each one as it is built. That listener never
replays components that already exist, so a listener connected later (after a yield, from a lazy
provider, from an event handler) reads `getAllComponents<T>()` first. `getComponent` is the
exception: it builds a qualifying component on demand, at any time. See
[Lifecycle events › Components](04-lifecycle-events.md#components).

### Cleaning up

`BaseComponent.destroy()` releases only what Flamework connected for the component, the handlers
behind `onAttributeChanged`. Removing the tag, or `removeComponent`, leaves the instance where it
is, so a connection of your own keeps firing into a component that has gone. Disconnect it in
`destroy`, and call `super.destroy()`:

```ts
@Component({ tag: "Coin" })
export class Coin extends BaseComponent<{}, BasePart> implements OnStart {
    private touched?: RBXScriptConnection;

    public onStart() {
        this.touched = this.instance.Touched.Connect((part) => this.collect(part));
    }

    public override destroy() {
        this.touched?.Disconnect();
        super.destroy();
    }

    private collect(part: BasePart) {}
}
```

`destroy` also runs for every component when the module extinguishes. A `destroy` that raises does
not hold up the teardown (see [Caveats](#caveats)).

**Removing the component from its own constructor or `onInit`** undoes the construction as it
finishes. This covers `removeComponent`, and taking its tag away where the place delivers signals
immediately. The component is destroyed, and never attached, started or announced.

**An `onInit` that raises** does not take the component away, and does not build another one. The
component stays where it is, marked invalid:

- it gets no `onStart` and no per-frame events;
- it is absent from `getComponent`, `getComponents`, `getAllComponents` and `waitForComponent`;
- no added listener hears of it;
- a component that links to it keeps waiting. The warning says
  `carries an invalid '...', whose onInit raised: ...`.

It still holds its place. Nothing is built on top of it until the *tracker* takes it down for a
reason of its own: the tag goes, the tree breaks, a link is lost. (The tracker is the part of
Flamework that watches instances and builds and removes their components.) The component built once
that reason has passed is a fresh one, with its own `onInit`.

The failure is reported in two ways. For a tagged instance, Flamework warns
(`Failed to instantiate ...`). `addComponent` by hand raises
`component '...' failed to initialise for ...`, and raises again, with `waiting to be removed`,
while the invalid component is there. `removeComponent` clears it.

Register by glob when the components are spread across feature folders:

```ts
ComponentPlugin.fromGlob("src/**/components");
```

A module may include several component plugins, in any mix: a `fromPath` per folder, a `fromGlob`,
one built by hand. They share **one** `Components` for that module:

- every class any of them registers ends up in it;
- a component in one can link to a component in another;
- `Dependency<Components>()` and constructor injection get that one `Components`.

A class that two plugins register is registered once, and kept when either registration's scope
holds. A module that imports another keeps its own `Components` if it includes a component plugin of
its own. If it includes none, it resolves the import's `Components`.

```ts
Flamework.createModule()
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .includePlugin(ComponentPlugin.fromPath("src/server/components"))
    .ignite();
```

Path and glob registration find every component defined in the files there, exported or not, the
way `registerProviders` finds providers ([Providers](03-providers.md#how-it-actually-works)).

As with providers, only classes decorated with `@Component()` **themselves** are registered. An
exported but undecorated subclass is skipped, and `registerComponent` raises an error for one.

## Attributes

Attribute guards are generated from the first type parameter. An instance whose attributes do not
match is rejected: the component is not created, and `addComponent` throws
`... has invalid attribute 'speed' for '...'`.

Optional properties really are optional: `label?: string` accepts a missing attribute.

Attribute names are strings, as the engine stores them. Declare a name that looks like a number
with a string key (`"10": number`, read as `this.attributes["10"]`): a number key (`10: number`)
type-checks, but `this.attributes[10]` reads nil, since roblox-ts indexes by the number.

### Defaults

Instead of rejecting the instance, you can write a default value back to it:

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

A value that fails the guard is never applied:

- With no `defaults` entry for the attribute, the component is removed. Once the attribute is valid,
  the component is built again, reading the attributes afresh.
- With a `defaults` entry, the component keeps its last good value.

Turn tracking off with `refreshAttributes: false`, which also disables `onAttributeChanged`. The
validity of the attributes is watched either way. Like the instance tree, it is a *criterion*: a
condition the component needs in order to exist.

### Writing an attribute

Assigning to `this.attributes` writes the value back to the instance:

```ts
this.attributes.speed = 32;
this.attributes.speed += 8;
this.attributes.speed++;
delete this.attributes.label;
```

The write has to be spelled `<component>.attributes.<name>`, because that is the shape the
transformer rewrites. The component does not have to be `this`: a component reached through
`getComponent` is written the same way. A write through a local
(`const attributes = this.attributes; attributes.speed = 32`) is an ordinary table write, and the
instance never hears about it. A read-modify-write (`+=`, `++`, `--`) evaluates the component
expression a second time for the value it computes, so keep side effects out of that expression.

Every write is checked against the same guard the attribute was accepted with, and raises an error
if it fails. This catches a write that a cast let through:

```ts
// Raises: 'fast' is not a valid value for attribute 'speed' of '...'
this.attributes.speed = someString as unknown as number;
```

Without the check, the component would hold a value that its own declared type says is impossible.
The instance would carry it too, and reject the component the next time one is built. Writing
`undefined` to a required attribute raises for the same reason. An optional attribute accepts
`undefined`, and the attribute is cleared.

### Overriding a guard

To use your own guard for an attribute instead of the generated one, pass it in `attributes`:

```ts
@Component({
    tag: "Vehicle",
    attributes: { speed: t.numberPositive },
})
```

## Instance guards

The second type parameter is the instance tree. `BaseComponent<{}, Part>` will not attach to a
Folder. To require children, intersect it with an object type, as deep as you like:

```ts
// Requires a Humanoid child, and a Head with a Face, before the component is created
@Component({ tag: "Character" })
export class Character extends BaseComponent<{}, Model & { Humanoid: Humanoid; Head: BasePart & { Face: Decal } }> {}
```

The transformer writes the tree down as data: the classes each instance may be, and the children it
must have, by name. Flamework reads the tree the way your code reads `this.instance.Head`: with
`FindFirstChild`, which returns the first child of that name. So a second child with the same name
is not an error, and it is not the one that is checked. It can come and go without the component
noticing.

A child may be a union of classes (`Texture | Decal`). A union of whole trees, such as
`(Model & { Root: Part }) | (Folder & { Core: Folder })`, cannot be written down this way. It gets a
`t` guard instead, which can only be re-run whole.

A mismatch is named. `addComponent` raises with `child 'Head.Face' is missing (expected Decal)` or
`child 'Head' is a Folder, expected BasePart`, and the warning for a tagged instance that never
qualifies says the same (see [Streaming](#streaming)).

A child cannot be optional, and Flamework rejects one when you build:

```ts
// Rejected: `this.instance.Head` would error whenever the child is missing
export class Character extends BaseComponent<{}, Model & { Head?: BasePart }> {}
```

`this.instance.Head` indexes the instance itself, and Roblox raises an error for a child that is not
there, rather than returning nothing. Even the `if (this.instance.Head)` you would write to check
for it raises. So the optional type would promise a read that cannot be made. Either require the
child, or leave it out of the tree and get it with `FindFirstChild`. A child that names a
**component** is no exception: name a component that may or may not be there with an optional link
attribute, or look it up with `getComponent`. See [links](#links).

Attributes work differently and stay optional: a missing one reads back as `undefined`, so
`label?: string` is fine.

If the generated guard is not what you want, replace it entirely with `instanceGuard`. A guard
written by hand can only say that it failed, and it can only be re-run whole when the tree changes.

## Links

A **link** is an attribute or a child that names another instance. Flamework waits for the named
instance, keeps the link resolved, and takes the component down again if the instance goes away. A
link can name an instance, or a component on an instance.

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
names has streamed in at least once. So under StreamingEnabled, a far-away target keeps the
component waiting. Once the target has streamed in, the handle stays resolved, even if the target
streams back out.

Assigning to the attribute writes a fresh handle, after checking the instance the same way the link
was resolved:

```ts
this.attributes.Target = otherPart;
```

The check is the whole guard, structure included. A link to a component that declares
`Model & { Root: BasePart }` only accepts a model that has that child. Assigning an instance that
could never be right raises an error.

An attribute typed `InstanceHandle` is left alone: you get the handle, and nothing waits. Use this
when you want to do the resolving yourself.

`defaults` works here as it does elsewhere. Give an instance as the default, and an attribute that
was never written is filled in with a handle for it, instead of keeping the component waiting. That
holds for an optional link too, whose guard would accept the attribute being missing. The default is
written to the instance either way, so the component and the instance never disagree about what the
link names. The default stands in for an attribute the component was **built** without, not for one
the component has since cleared. Clearing an optional link clears it, and the default is
applied again the next time a component is built.

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

`this.instance` still holds instances: `this.instance.EffectHandler` is the part the component is
attached to, and that is what the generated instance guard checks. The components themselves live in
`childComponents` and `attributeComponents`. Their fields are readonly: Flamework owns them, and
reassigning one would only put it out of step with the instance.

The tree *under* a child that names a component is that component's business, not the owner's. The
owner's shape stops at the child's class. Whether the rest is there is decided by the linked
component's own tracker, under its own streaming mode. (A component type cannot be intersected with
a tree of its own, since `Handler & { Root: Part }` is not a type, so there is nothing the owner
could add.)

`Turret` is not constructed until `EffectHandler` exists **and** carries its component, in either
tag order. It is removed again if that component goes away. This uses the same criteria mechanism
as component dependencies and streaming, so the warning that lists what a component is waiting for
names the link.

A link resolves the class it names and **nothing else**. A subclass does not stand in for its
parent. An instance carrying several components hands back the one the link names, not whichever
came first, so there is no ambiguity to resolve. This works in both directions: another component
leaving the linked instance changes nothing, even a subclass of the one the link names. The guard
is the whole shape too: a link to a component declaring `Model & { Root: BasePart }` only accepts a
model that has that child.

A link waits for what `getComponent` would hand back, and on top of that it respects the ancestor
lists (see [Where components may attach](#where-components-may-attach)). If a `predicate` refuses
the linked component, or its instance sits under a blocked ancestor, the link stays unmet and the
component is not built. A link never reports itself met and then fails to build the component. It
also never builds the linked component there itself: pointing a link attribute at a tagged instance
under a blocked ancestor leaves the link unmet, rather than constructing the component the ancestor
lists refused. The ancestor lists gate *construction*, not the link. So a component that is already
attached to a blocked instance (added by hand, or built by a `getComponent` of your own) does
satisfy the link.

"What `getComponent` would hand back" is the whole rule. A link is met by an instance that already
carries the component, **or** by one that Flamework would build it on. The answer is the same
whether or not anything is tracking that instance yet. So a spawner can tag a whole tree and ask for
its component straight away. Tag announcements arrive a resumption later, and `getComponent` builds
the link's component on the way to building yours, rather than refusing because the announcement
has not arrived yet.

A link that names its own component on its own instance is unmet for the same reason. It is the one
link that can never be met on the way in, because the component would already have to exist to be
built. So the component is not built, and the link reports this instead of raising an error out of
the tag that asked for it. Point the attribute somewhere else (or, if it is optional, clear it) and
the component is built. Pointing it back at its own instance afterwards resolves to the component
that is now there. A ring of links works the same way, however many instances it goes round: none of
it can be built from nothing, so the ring stays unmet until something in it exists for another
reason.

That promise covers a rebuild as well. Roblox delivers the tree's signals a resumption late, so a
change that takes a component down and a change that should keep it down can arrive one after the
other. That is why every link is read from the instance again on the way in, rather than trusted to
still be what it last reported. A component is built only when the tree agrees.

The guard is also kept current, not read once when the attribute is written. A link to a component
declaring `Model & { Root: BasePart }` is unmet while the model it names has no `Root`, and becomes
met when one is parented in. So an attribute may be written before the instance it names is
finished, and the component is built once that instance is finished.

A component can only be named as a **direct** member of the tree. One further down is a compile
error, because `this.instance` would have nowhere to put it. Declare it on the component attached to
that child instead, or look it up with `getComponent`.

A child naming a component cannot be optional, just as a plain child cannot: `this.instance.Core`
still indexes the instance, and raises while the child is missing. Name a component that may or may
not be there through an [attribute](#instance-attributes) instead, which can be optional, or look it
up with `getComponent` when you need it.

#### Writing one

Sometimes you assign an instance that is the right shape but does not carry the component **yet**.
That is a matter of timing, not a bad value, so it does not raise. But writing it would make the
component doing the writing stop qualifying, and destroy it in the middle of a method. So instead,
the write is refused and Flamework warns. Wait for the component first:

```ts
// Components has to be injected for this; ComponentMetadata comes first.
const [ok] = this.components.waitForComponent<Rig>(target).timeout(5).await();
if (!ok) return warn("that instance never got its component");

this.attributes.Rigged = target;
```

The resolved attribute type already asks for the linked component's instance type, so most mistakes
here are compile errors. The guard catches the ones a cast let through.

Writing an instance under a blocked ancestor is handled the same way, because a link never builds a
component where the ancestor lists keep one out. The write is refused with a warning, whether or not
that instance is tagged.

### What takes a component down again

| Change | Effect |
|---|---|
| The tag is removed | Removed. |
| The instance leaves the DataModel (unparented, destroyed, or an **ancestor** of it unparented) | Removed. CollectionService announces the tag as gone for the whole subtree that left, and announces it again when it is parented back in, so the components come back with it. Moving an instance *within* the DataModel announces nothing and changes nothing. |
| The component a link names is destroyed | Removed, whatever the streaming mode: that is a lifecycle event, not the tree moving. |
| Some **other** component on a linked instance is destroyed | **Kept**, including a subclass of the one the link names. |
| A link attribute is re-pointed at something that fails its guard | Removed, and built again if it is pointed back at something valid. |
| The instance a **plain** link attribute names stops passing its guard | Removed, and built again once it passes. The guard carries the whole shape, so a linked model losing the child the link asked for counts, whatever the streaming mode: the target's tree is not this component's tree. |
| The tree under a linked **component** breaks | Depends on that component's own streaming mode, since its tree is its business. Under `Watching` it goes and takes this component with it. Under `Disabled` it stays, and so does this one. |
| A required link attribute is cleared from outside | Removed. |
| A plain attribute is changed to a value its guard rejects | Removed, and built again once it is valid. The warning names it: `invalid attribute 'speed' ("fast")`. With a `defaults` entry for it, **kept** with its last good value, and `onAttributeChanged` does not fire. |
| A child a link names is replaced by another instance of the same name | Removed and built again around the new one, so it never holds a child that has left. |
| The instance tree stops matching (a child goes, including one a link names) | Follows `streamingMode` (below). |

Swaps need a note, because signals are deferred. When a child is parented out and its replacement is
parented in within one resumption, they arrive as a single change: the child of that name is now a
different instance. There is never a moment with no child at all. It is still a different tree, so
the component is still rebuilt.

This holds even when the swap happens before Flamework starts watching. `getComponent` builds a
component the moment you ask for it, but the tag that makes Flamework follow its tree is announced a
resumption later. If the tree changes in between, Flamework compares it with the child the component
was actually built with, not with whatever the tree holds when Flamework first looks.

The streaming mode only affects the last row, because that is the only row about the tree rather
than about another object's lifetime:

| `ComponentStreamingMode` | A child, or a child link, going away |
|---|---|
| `Contextual` (default) | Re-checked on a client, ignored on a server. |
| `Watching` | Re-checked, so the component goes and comes back with its tree. |
| `Disabled` | Read once and kept. The component stays, still holding the child it resolved to. |

`Disabled` reads the *tree* once, not the components in it. A child that moves elsewhere in the
DataModel keeps its tag and its components, and that is the case where `Disabled` keeps the
component. A child that is unparented or destroyed loses its own components on the way out. So a
link naming one of them falls under the "component a link names is destroyed" row of the previous
table, not under streaming at all: the owner goes with it whatever the mode.

`Disabled` applies to the component that was built, not to the next one. Something else can take
that component down, say a link attribute re-pointed at an instance its guard refuses. The build
that follows reads the tree as it is then. So if the tree no longer holds the child a child link
names, the component stays down until it does. While the component is down, a child link looks its
child up again whenever a child of that name arrives, and whenever the child it holds loses its
component. So if a linked child is destroyed and replaced by another that carries the component, the
component comes back around the new one. This happens under `Disabled`, and under `Contextual` on a
server.

### Waiting and warnings

| Option | Effect |
|---|---|
| `warningTimeout` | Seconds before Flamework says what a component is still waiting for, links included. |
| `attributeWarningTimeout` | Seconds before it says an attribute's instance has not streamed in. Defaults to `warningTimeout`. |

```ts
@Component({ tag: "Turret", attributeWarningTimeout: 10 })
```

Both default to 5, and `0` disables them. Keep instances that an attribute names somewhere that is
always loaded, such as ReplicatedStorage or inside the same model, and the wait never happens.

The warning explains why, criterion by criterion, and follows a link into the linked component's own
reasons:

```
Waiting for component 'Turret'
Waiting for the following criteria: instance guard (child 'Barrel' is missing (expected BasePart)),
  child 'EffectHandler' with component 'EffectHandlerComponent' (Workspace.Turret.EffectHandler is
  waiting for: CollectionService tag), attribute 'Owner' with component 'PlayerComponent' (the
  attribute names nothing that has streamed in)
```

Writing a link attribute reports problems the same way. An instance that could never carry the
component it names raises an error with that component's reason:
`did not pass the guard for attribute 'Rig' of 'Turret': instance guard (child 'Root' is missing (expected BasePart))`.
An instance of the right shape that just has no component yet is refused with a warning, and the
attribute is left alone.

A warning is only ever about something that is **waiting**. A link watches the instance it names
without waiting for it, so it neither starts a warning nor keeps one going. If you untag an
instance, the warning goes with the tag, however many links are still watching, and tagging it
again starts the wait over. The same goes down the chain, in both directions. The components a
watched component depends on are watched too, and report nothing until something asks for the
component itself. When the tag that was asking goes, their warnings go with it.

The warning also comes again after every loss. A component that goes down (its tree broke, a link
was lost, an attribute went bad) and stays down for `warningTimeout` seconds warns just like one that
never came up, with the reason.

## Where components may attach

| Option | Effect |
|---|---|
| `predicate` | Rejects an instance outright, before anything else runs. |
| `ancestorWhitelist` | Only construct under these ancestors. Takes priority over the blocklist. |
| `ancestorBlacklist` | Never construct under these. Defaults to ServerStorage, ReplicatedStorage, StarterPack, StarterGui and StarterPlayer. |

```ts
@Component({ tag: "Prop", predicate: (instance) => instance.Name !== "Template" })
```

The default blocklist is why a tagged template in ReplicatedStorage gets no component, while a
tagged instance cloned into Workspace does.

The ancestor lists only gate construction that Flamework drives: a tag, or a link to the component.
So you can still attach a component by hand to something in ReplicatedStorage. The `predicate` also
gates the eager path in `getComponent`: an instance it rejects never gets a component unless you call
`addComponent` yourself. `addComponent` ignores all three options.

A component can also be tied to the build's scopes with `activeIn` and `inactiveIn`, on the
decorator or on the registration (`registerComponent(Class, { ... })`, `fromPath(path, { ... })`).
A component left out by scope is not registered in the plugin at all. It is never attached, and
`getComponent` on it raises an error with the reason. See [Scopes](11-scopes.md).

When the condition on `fromPath`, `fromGlob`, `registerComponents` or `registerComponentsGlob` does
not hold, the folder is not loaded at all, so it can be missing from the place. The error from
`getComponent` then names that registration. A condition on `includePlugin` does not stop
`fromPath` from loading its folder: `fromPath` looks the folder up when you call it.

## Streaming

With StreamingEnabled, an instance can arrive before its descendants. So an instance tree that
requires children may be incomplete at first, and complete a moment later.

| `ComponentStreamingMode` | Behaviour |
|---|---|
| `Contextual` (default) | Watches on the client; never on the server; skips atomic models, which replicate whole. |
| `Watching` | Always follows the tree as it changes. |
| `Disabled` | Reads the tree once. |

```ts
@Component({ tag: "Character", streamingMode: ComponentStreamingMode.Watching })
```

Watching uses one watcher per required child. It does not re-check the whole tree. For
`Model & { Root: Part & { Texture: Texture } }`, it listens for children arriving and leaving on the
model and, once `Root` has resolved, on `Root`. With `watchRenames` on (below), it also follows the
`Name` of each resolved child. A `Texture` arriving three levels down re-resolves only that one
slot. A child that is not in the tree, or a second child with a required name, changes nothing
however often it moves.

Renames are not followed unless the component asks for it with `watchRenames: true` (or
`components.watchRenames` in `flamework.config.json`). A child is rarely renamed, and only the
renamed child announces a rename. So following names costs a connection on each resolved child.
While a required child is missing, it also costs one on every other child, since that is the only
way to hear a sibling being renamed to the required name. Once the required child resolves, the
children ahead of it in child order stay followed: `FindFirstChild` reads the first child of a name,
so one of them renamed to that name becomes the one read.

With `watchRenames` left off, a rename is noticed only the next time that slot is read. That covers
a child renamed away, and a sibling renamed to a required name. The slot is read when a child of
that name arrives, when the child it resolved to leaves, or when the tag arrives.

A guard written by hand with `instanceGuard` has no such structure. It is re-run whole on every
descendant change, and hears no rename at all.

When a watched component's tree breaks apart again, the component is removed. That holds however the
component came to qualify. For example, a tag arriving at an instance that another component's link
was already watching re-reads the tree, and what it reads is what is watched from then on. So the
component still goes and comes back with its tree afterwards.

If an instance never qualifies, Flamework warns after `warningTimeout` seconds (default 5, `0`
disables) and lists the criteria it is still waiting on, such as
`instance guard (child 'Root.Texture' is missing (expected Texture))`. This is usually the fastest
way to find a typo in a tag or a missing child.

## Component dependencies

A component can depend on another component **on the same instance**. Declare it as a constructor
parameter. `ComponentMetadata` has to come first, because `BaseComponent` takes it:

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

`Car` is not constructed until `Engine` exists on the same instance, in either tag order. This is
the same criteria mechanism that streaming uses. Some `Engine`s Flamework never builds by itself: one
with no tag, or one its predicate refuses on this instance. Such an `Engine` counts once you add it
with `addComponent`. Removing an `Engine` by hand takes `Car` down with it, tagged or not. `Car`
comes back with the next `Engine`: one you add, or one that `getComponent` builds on the
still-tagged instance.

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
| `waitForComponent<T>(instance)` | Promise; resolves immediately if it already exists. A waiter whose handler removes the component leaves the others waiting for the next one. |
| `onComponentAdded<T>(cb)` | Fires for every future component of that type. |
| `onComponentRemoved<T>(cb)` | Fires after the component has left the lookups: before `destroy` where the place delivers signals immediately, after it where they are deferred. |

`getComponent` needs the exact class. The polymorphic ones (`getComponents`, `getAllComponents`,
and both listeners) accept an interface the component implements, or a superclass that is itself
decorated with `@Component()` (an abstract base with no `tag`, say). The ids a component answers to
are read from Flamework's metadata, which only a decorated class carries. So a base class without
its own decorator is not looked up: asking for it finds nothing, and so does asking for an
interface only such a base class declares. The same rule decides which `implements` clauses count
for lifecycle events ([Lifecycle events](04-lifecycle-events.md#the-events)).

```ts
// every component on this instance that implements OnTick
for (const component of this.components.getComponents<OnTick>(instance)) {
    component.onTick(dt);
}
```

## Patterns

**Server and client components with the same tag.** Register different classes from the two entry
points. They attach to the same instances and never see each other.

**An interface for shared behaviour.** Declare `interface Damageable { takeDamage(n): void }`,
implement it on several components, and use `getComponents<Damageable>(instance)` to reach whichever
are present.

**`waitForComponent` at boundaries.** When a provider needs a component that may not exist yet,
`await this.components.waitForComponent<Vehicle>(instance)` is better than polling.

**Composition over inheritance.** Two components on one instance with a dependency between them are
usually clearer than a deep component hierarchy. It is also the case Flamework's tracker is built
for.

## Caveats

- **`getComponent` constructs.** It is not a pure lookup. If the instance is in the DataModel,
  tagged, passes the predicate and qualifies, `getComponent` builds the component then and there,
  ignoring the ancestor lists. The instance must be in the DataModel because that is what announces
  the tag: an instance sitting in a pool, or a template being assembled, gets nothing until it is
  parented in. Whether some other component's link happens to be watching that instance makes no
  difference to the answer. That includes a link that watched it while its instance guard was still
  failing. It also includes an instance under a blocked ancestor, where `getComponent` is the only
  way in and a link watching it is not allowed to build the component there. This stays true as the
  tree goes on moving: a watched component still comes and goes with its tree on an instance a link
  found first. Use `getAllComponents` when you want to *observe* rather than ensure.
- **`getComponent` returns nothing for a component that is still constructing.** So a constructor
  asking for its own component gets `undefined`. So does an attribute-changed handler that runs
  inside the write of one of the component's `defaults`, where the place delivers signals
  immediately. Forcing the construction with `addComponent` from inside the constructor raises
  `component '...' is cyclic`.
- **Extinguishing the module destroys every component** and stops watching the tags. `addComponent`
  on the extinguished module raises, and tagging an instance afterwards does nothing. `getComponent`
  builds nothing from the moment the extinguish begins: it answers `undefined` for a still-tagged
  instance.
- **A `destroy` that raises does not hold up the teardown.** Whatever Flamework attached for the
  component (the attribute-changed connections behind `onAttributeChanged`) is released either way,
  so nothing keeps firing into a component that has gone.
  - On extinguish, the failure is warned about and the remaining components still come down, so one
    component cannot leave a module half-extinguished.
  - A removal Flamework makes on its own (a tree, a link, an attribute or a dependency lost) warns
    the same way, and the change that caused it still finishes. For example, a dependent whose
    `destroy` raises does not keep its dependency attached after the dependency's tag has gone.
  - A `removeComponent` you call by hand still re-raises the error, since you asked for the removal.
- **Per-frame events come from the module's lifecycle plugin.** `disableDefaultLifecycle()` on the
  module that includes `ComponentPlugin` stops components ticking. `onStart` still runs.
- **An invalid attribute throws** unless a default is configured.
- **`onComponentRemoved` runs when the engine delivers it.** The announcement is a BindableEvent, so
  when the callback runs depends on how the place delivers signals:
  - **Immediately.** The callback runs inside the removal, before `destroy`, so the component is
    still usable inside it. But it has already left `getComponent` and `getComponents` by then, and
    nothing builds a replacement while the removal is running. So the value the callback is handed
    is the only way to reach it. An `addComponent` of your own from the callback still attaches a
    new one, and the dependents holding the old one are rebuilt around it once the removal is over.
  - **Deferred.** The callback runs once the thread yields. The removal has finished and `destroy`
    has already run, and asking a still-tagged instance for the component there builds a new one.

  A removal by hand leaves the tag alone. So asking a still-tagged instance for the component
  *after* `removeComponent` has returned builds a new one, as it always has. That is also what keeps
  two components whose links name each other from removing one another twice: taking one down takes
  the other with it, once each.

  The announcement is delivered a resumption late, so a link compares it with the instance as it
  stands when it arrives. Sometimes the instance has since replaced the component, because that same
  resumption asked for it again. Then the removal leaves the link alone, and updates
  `childComponents` and `attributeComponents` to the component that is there now. Otherwise a cycle
  would remove and rebuild itself for as long as the place is running.
- **Attribute tracking is on by default.** `refreshAttributes: false` disables `onAttributeChanged`
  as well as the tracking. It does not turn off the watch on the attributes' validity: an attribute
  changed to a value its guard rejects still takes the component down.
- **A component with no `tag` can only be added by hand.**
- **`@Component` classes are not providers.** They are not picked up by `registerProviders`, and
  `registerComponents` will not pick up providers. `Dependency<T>()` and a provider's constructor
  cannot take one either: the transformer refuses both. Get it from `Components` instead.
- **Component dependencies are same-instance only.** There is no cross-instance dependency. A link
  is how you reach another instance.
- **A linked component must be registered in the same module**, by any of its component plugins.
  Igniting raises if it is not.
- **`addComponent` will not wait.** By hand, a link that has not resolved raises instead of
  yielding. Through a tag, the component is not created until the link has resolved.
- **A link is only kept current for a tag-driven component.** One added by hand is resolved once,
  like its instance guard.
- **`refreshAttributes: false` freezes link attributes too.** Re-pointing one stops updating
  `this.attributes` and `attributeComponents`, and `onAttributeChanged` does not fire for them
  either. Only the component's *view* is frozen, not the criterion behind it: a re-point that the
  guard refuses still takes the component down, as it would with tracking on. The component's own
  writes still land, in both `this.attributes` and `attributeComponents`, and, as for a plain
  attribute, they announce nothing.
- **Clearing a required link raises.** Only an optional one can be set back to `undefined`.
- **A write that fails its guard raises**, so an attribute never holds a value its type forbids.
- **A link write to an instance without the component warns and is refused**, rather than raising or
  destroying the component that wrote it. Await the component first.

---

Previous: [Lifecycle events](04-lifecycle-events.md) · Next: [Networking](06-networking.md)
