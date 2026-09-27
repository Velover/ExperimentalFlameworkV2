# 11. Scopes

A **scope** is a name that a build is compiled with. You can tell providers, components,
registrations, plugin inclusions and whole modules to exist only in builds with certain scopes
active, or never in builds with others. That way a repository can hold test scenarios, debug tooling
and stand-ins for production code, and none of it registers in a build that did not ask for it.

## Naming the active scopes

The active scopes are `scopes.active` in `flamework.config.json`. The list is meant to come from the
environment:

```jsonc
// flamework.config.json
{ "scopes": { "active": "${FLAMEWORK_SCOPES:-}" } }
```

```ini
# .env.local
FLAMEWORK_SCOPES=components,collections
```

The variable is split on commas. An empty value activates nothing, and `*` activates every scope.
[Values from the environment](09-project-structure.md#values-from-the-environment) explains how the
file reads `.env`. A running `rbxtsc -w` reports a change but keeps the scopes it started with, so
restart the watcher to switch scopes (see [watching](09-project-structure.md#watching)).

At runtime, `Flamework.activeScopes()` returns the list as configured.
`Flamework.isScopeActive(name)` tells you whether one scope is active, and is always true when `*`
is.

## Conditions

A condition has two lists:

| Field | Holds when |
|---|---|
| `activeIn` | at least one of the names is active, or the list is empty |
| `inactiveIn` | none of the names is active |

You can set conditions at four levels: the module, a registration, a plugin inclusion and the class
itself. They combine by AND: a class is registered only when every condition that applies to it
holds.

```ts
// The module: everything it registers is subject to this.
Flamework.createModule()
	// A registration: everything under the folder gets this on top.
	.registerProviders("src/server/Testing/components", { activeIn: ["components"] })
	// A plugin inclusion: skipped entirely, hooks and all, unless it holds.
	.includePlugin(ComponentPlugin.fromPath("src/server/Testing/components"), { activeIn: ["components"] })
	.ignite({ activeIn: ["components"] });
```

```ts
// The class itself.
@Provider({ activeIn: ["components.streaming"] })
export class StreamingProbe {
	constructor(private readonly data: DataService) {}
}

@Component({ tag: "TestRig", activeIn: ["components"] })
export class TestRig extends BaseComponent<{}, Model> {}
```

`StreamingProbe`, inside the module above, is registered only when both `components` and
`components.streaming` are active. A class can narrow the condition of whatever registered it, but
never widen it. A class inside a `components` module cannot exist without `components`. If it
should, put it in another module or registration.

A module whose own condition does not hold still ignites. It holds no providers and no components,
but its plugins are set up. `Dependency<T>(module)` raises an error for anything it would have had.

A path or glob registration whose own condition does not hold skips its folder entirely. It does not
look the folder up or load anything in it, so the folder does not have to be in the place. This
applies to `registerProviders`, `registerProvidersGlob`, `ComponentPlugin.fromPath` and `fromGlob`,
`registerComponents` and `registerComponentsGlob`, and a plugin's own `registerProviders` and
`registerProvidersGlob`.

The other levels work differently:

- The module's condition and the class's condition are checked at ignition, after the folder has
  loaded.
- A plugin inclusion whose condition does not hold skips the plugin's setup. So the registrations a
  plugin makes in its setup never run, and their folders are not looked up.

`ComponentPlugin.fromPath` and `fromGlob` look their folder up when you call them, before
`includePlugin` sees its condition. Put the condition on `fromPath` itself.

In the example above, `registerProviders` loads its folder only when `components` is active.
`ComponentPlugin.fromPath` loads its folder in every build.

## What being left out means

A class whose conditions do not hold is **not registered**. It is not constructed, it receives no
lifecycle events, and `resolveDependency` does not find it. A component that is left out is never
attached to a tagged instance. Anything active that depends on a left-out class fails at ignition,
with the reason:

```
module 'Game' could not resolve dependency 'server/Testing/Probe@Probe': it is registered but
inactive (activeIn [components]; active scopes [])
```

`getComponent` on a left-out component says the same. A lazy provider that was left out reports it
the first time something resolves it.

A class under a folder whose registration was left out is different. That folder was never loaded,
so the class was never registered at all. The error names the registration instead:

```
module 'Game' could not resolve dependency 'server/Testing/Probe@Probe': 'Probe'
(ServerScriptService.TS.Testing.Probe) is under registerProviders("src/server/Testing"), which is
left out by its scope (activeIn [components]; active scopes []): nothing under it is registered.
Change the build's scopes so that the condition holds, or do not depend on it in this build
```

This needs the class to be loaded, for example by a file that imports it as a value. If nothing has
loaded it, the error lists every registration that the module left out this way, since the class
may be under any of them. `getComponent` does the same for the registrations of the module's component plugins.

## Standing in for production code

Two registrations may share an id if their conditions keep at most one of them in any one build.
That is how a fake takes a real provider's place, in the same module as the real one, so everything
that injects it gets the fake:

```ts
Flamework.createModule()
	.registerClassProvider(CollectionHandler, { inactiveIn: ["collections"] })
	.registerProvider<CollectionHandler>({ type: "class", value: FakeCollectionHandler, activeIn: ["collections"] })
	.ignite();
```

With `collections` active, the fake is registered under the real one's id, and the real one is not.
If both are kept in one build, ignition refuses it, as it does for any duplicate id.

Use `inactiveIn` on its own for production code that a test replaces or must not run alongside: a
real game loop, or a component whose tag a test rig reuses.

## Where scopes are decided

Every condition is checked against the scopes the build was compiled with. It is checked at
ignition. A path or glob registration's own condition is also checked when the registration is
made, so that a left-out folder is never loaded. Both checks give the same answer. After a change to
`.env`, rebuild (restart the watcher if one is running) and, in Studio, stop and play again. There
is no runtime override. The scopes a place runs with are part of the build, so a test scope cannot
be switched on in a published game.

## Caveats

- **Conditions narrow, never widen.** A class cannot opt out of its module's or registration's
  condition. Move it instead.
- **A module's condition does not stop its plugins.** They are set up so that the module is
  complete, and what they register is checked like everything else. To leave a plugin out, put the
  condition on its inclusion.
- **`*` turns every `inactiveIn` off.** Running every scope at once runs every replacement at once.
  Two tests that replace the same thing collide, and ignition says so.
- **Plugins with a registry of their own must ask.** The components plugin filters its classes with
  `target.isActive(...)`. A plugin that keeps its own list of classes has to do the same, or its
  classes ignore the module's condition. See [plugins](08-plugins.md#what-a-plugin-can-do).

---

Previous: [Migrating from v1](10-migrating-from-v1.md) · Next: [Testing in the place](12-testing.md)
