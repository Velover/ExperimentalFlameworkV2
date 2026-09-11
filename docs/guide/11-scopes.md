# 11. Scopes

A scope is a name a build is compiled with. Providers, components, registrations, plugin inclusions
and whole modules can be told to exist only in builds with certain scopes active, or never in builds
with others. That is how a repository carries test scenarios, debug tooling and stand-ins for
production code without any of it registering in a build that did not ask for it.

## Naming the active scopes

The active set is `scopes.active` in `flamework.config.json`, and it is meant to come from the
environment:

```jsonc
// flamework.config.json
{ "scopes": { "active": "${FLAMEWORK_SCOPES:-}" } }
```

```ini
# .env.local
FLAMEWORK_SCOPES=components,collections
```

The variable is split on commas. An empty value activates nothing; `*` activates every scope. See
[values from the environment](09-project-structure.md#values-from-the-environment) for how the
file reads `.env`, and [watching](09-project-structure.md#watching) for what a running `rbxtsc -w`
does with a change: it reports it and keeps the set it started with, so restart the watcher to
switch scopes.

At runtime, `Flamework.activeScopes()` is the list as configured, and `Flamework.isScopeActive(name)`
answers for one scope, `*` included.

## Conditions

A condition has two lists:

| Field | Holds when |
|---|---|
| `activeIn` | at least one of the names is active, or the list is empty |
| `inactiveIn` | none of the names is active |

Conditions can be set at four levels, and they combine by AND. A class is registered only when
every condition that applies to it holds:

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
`components.streaming` are active. A class narrows the condition of whatever registered it and never
widens it: there is no way for a class inside a `components` module to exist without `components`.
If one should, it belongs in another module or registration.

A module whose own condition does not hold still ignites. It holds no providers and no components,
its plugins are set up, and `Dependency<T>(module)` raises for anything it would have had.

## What being left out means

A class whose conditions do not hold is **not registered**. It is not constructed, it receives no
lifecycle events, `resolveDependency` does not find it, and a component is never attached to a tagged
instance. Anything active that depends on it fails at ignition with the reason:

```
module 'Game' could not resolve dependency 'server/Testing/Probe@Probe': it is registered but
inactive (activeIn [components]; active scopes [])
```

`getComponent` on a left-out component says the same. A lazy provider that was left out reports it
the first time something resolves it.

## Standing in for production code

Two registrations may share an id when their conditions keep at most one of them in any one build.
That is how a fake takes a real provider's place, in the same module the real one lives in, so that
everything injecting it gets the fake:

```ts
Flamework.createModule()
	.registerClassProvider(CollectionHandler, { inactiveIn: ["collections"] })
	.registerProvider<CollectionHandler>({ type: "class", value: FakeCollectionHandler, activeIn: ["collections"] })
	.ignite();
```

With `collections` active the fake is registered under the real one's id and the real one is not.
Both being kept in one build is refused at ignition, as any duplicate id is.

`inactiveIn` on its own is for production code that a test replaces or must not run alongside: a
real game loop, or a component whose tag a test rig reuses.

## Where scopes are decided

Every condition is judged once, at ignition, against the active set the build was compiled with. A
change to `.env` needs a rebuild, a watcher restart if one is running, and, in Studio, a stop and
play. There is no runtime override:
which scopes a place runs with is a property of the build, so that a test scope cannot be switched
on in a published game.

## Caveats

- **Conditions narrow, never widen.** A class cannot opt out of its module's or registration's
  condition. Move it instead.
- **A module's condition does not stop its plugins.** They are set up so that the module is whole;
  what they register is judged like everything else. Scope the inclusion to leave a plugin out.
- **`*` turns every `inactiveIn` off.** Running every scope at once is running every replacement at
  once; two tests that replace the same thing collide, and ignition says so.
- **Plugins with a registry of their own must ask.** The components plugin filters its classes with
  `target.isActive(...)`; a plugin that keeps its own list of classes has to do the same, or its
  classes ignore the module's condition. See [plugins](08-plugins.md#what-a-plugin-can-do).
