# 9. Project structure

Nothing here is enforced. Flamework only cares that the folders you register from are mapped in your
Rojo project and that your classes are exported. This is what tends to work.

## A layout that scales

```
src/
  server/
    runtime.server.ts          entry point: builds and ignites the server module
    services/                  @Provider classes, registered by path
      economy.ts
      matchmaking.ts
    components/                server-side components
  client/
    runtime.client.ts          entry point: builds and ignites the client module
    controllers/               @Provider classes, registered by path
    components/                client-side components
  shared/
    network.ts                 Networking.createEvent / createFunction
    components/                components that exist on both realms
    plugins/                   plugins both entry points include
    types/
```

The entry points are the only files that know how everything is wired:

```ts
// src/server/runtime.server.ts
import { ComponentPlugin } from "@flamework/components";
import { Flamework } from "@flamework/core";

Flamework.createModule()
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .includePlugin(ComponentPlugin.fromPath("src/server/components"))
    .registerProviders("src/server/services")
    .ignite();
```

```ts
// src/client/runtime.client.ts
Flamework.createModule()
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .includePlugin(ComponentPlugin.fromPath("src/client/components"))
    .registerProviders("src/client/controllers")
    .ignite();
```

`services` and `controllers` are just names -- there is no `@Service`/`@Controller` distinction in v2.
Keeping the folders separate is what keeps server code off the client.

## One module per realm

**One module per realm** is right for every game. Everything is in one container, anything can
inject anything, and you never think about it again. What varies is what goes *into* it:

| Situation | Shape |
|---|---|
| Shared code both realms need | A plugin in `shared/plugins`, included by both entry points. |
| A library you publish | A plugin; its setup registers the library's providers. |
| Tests | Build the definition once, ignite per case, extinguish after. |

```ts
// src/shared/plugins/core.ts
export const CorePlugin = Flamework.createPlugin("Core", (target) => {
    target.registerProviders("src/shared/services");
});
```

```ts
// both entry points
.includePlugin(CorePlugin)
```

Each realm ignites its own module, which is correct -- they are different processes.

## Where things go

| Thing | Where | Why |
|---|---|---|
| `createEvent` / `createFunction` | `shared/` | Both realms import the same object; its identity is generated from the callsite. |
| Components used on both realms | `shared/components` | Registered by both entry points. |
| Components for one realm | `<realm>/components` | Same tag, different class per realm, is a normal pattern. |
| Interfaces for plugin dispatch | `shared/` | Both the plugin and the implementers need them. |
| Plugins | `shared/plugins` | Not `shared/services`: path registration requires everything under the folder, and a plugin built with `ComponentPlugin.fromPath` registers its folder as a side effect. |

That last row matters because `registerProviders("src/shared/services")` requires **every** module
under that folder, so whatever a file there does at load time happens during registration.

## Configuration

Every Flamework package reads one file, `flamework.config.json`, next to `tsconfig.json`. The only
entry the tsconfig needs is `transform`; each package has its own section in the file:

```jsonc
// flamework.config.json
{
  "$schema": "./node_modules/rbxts-transformer-flamework/flamework.config.schema.json",
  "transformer": {
    "hashPrefix": "$g",
    "obfuscation": false,
    "idGenerationMode": "short",
    "optimizations": { "guardGenerationDedupLimit": 5 },
    "plugins": []
  },
  "core": { "profiling": true },
  "networking": { "serialization": true },
  "components": { "warningTimeout": 5, "attributeWarningTimeout": 5, "streamingMode": "Contextual" },
  "scopes": { "active": "${FLAMEWORK_SCOPES:-}" }
}
```

| Section | Key | Effect |
|---|---|---|
| `transformer` | `hashPrefix` | Prefix for generated ids. Defaults to the package name; set a short one in a game. |
| | `obfuscation` | Obfuscates identifiers: random remote names, shuffled metadata, short ids, all different on every build. Game projects only; see [obfuscation](#obfuscation). |
| | `idGenerationMode` | `"full"` (default), `"short"`, `"tiny"` or `"obfuscated"`. Only shorten in a game. |
| | `plugins` | Transformer plugins; see [transformer plugins](../reference/transformer-plugins.md). |
| | `salt`, `noSemanticDiagnostics`, `optimizations` | Hash salt, skipping semantic diagnostics, [guard deduplication](#guard-deduplication). |
| `core` | `profiling` | Default for `LifecyclePlugin` profiling; `createLifecyclePlugin({ profiling })` overrides it per module. |
| `networking` | `serialization` | Serializes every event and function payload into a buffer with code generated at compile time; see [Networking](06-networking.md#serialization). |
| `components` | `warningTimeout`, `attributeWarningTimeout`, `streamingMode` | Defaults for components that do not set their own. |
| `scopes` | `active` | The scopes this build is compiled with; see [Scopes](11-scopes.md). |

The transformer looks for the file in the tsconfig's directory, then in each parent up to the
package root, so a repository with several places can share one at the root and override it per
place. Comments and trailing commas are allowed, unknown keys are rejected with their name, and the
`$schema` line gives your editor completion and validation. To use a different name or location,
set `"configFile": "config/flamework.json"` on the tsconfig entry.

The `transformer` section can also be written inline on the tsconfig entry, where it **overrides** the
file; the other sections cannot. For a game project the transformer copies those runtime sections
into `include/flamework/config.json`, which the packages read through `getRuntimeConfig()` from
`@flamework/core`. A package (a scoped name) gets no such artifact: its defaults come from the game
that uses it.

**Do not set `idGenerationMode` or `obfuscation` in a published package.** Ids have to be stable and
collision-free across every consumer.

### Obfuscation

With `obfuscation` on, every generated name -- class ids, hashed strings, and the callsite uuids
that name every remote -- is different on every build. A name mapped in one release is worthless
against the next, which is the point: a cheat cannot carry a map of your remotes from one version
to another.

What makes that hold is `flamework.build`. A plain `rbxtsc` recreates it, and with it the hash salt
and the build seed the names come from. A running `rbxtsc -w` keeps reading the file it started
with, so the names hold for the watcher's lifetime and every rebuild agrees with the files it did
not recompile. Two things keep names the same across builds, and the transformer warns about
both:

- **`transformer.salt`**, which fixes the hash the class ids come from. Leave it unset with
  obfuscation on.
- **An incremental build** (`incremental` with a `tsBuildInfoFile`), which reuses the previous
  `flamework.build` so that the files it does not recompile still match. Delete the tsbuildinfo
  before a release build.

Without obfuscation the names are stable across builds, which is what you want while debugging.

### Values from the environment

Any string in the file can reference the environment: `${NAME}` is the variable's value, and
`${NAME:-fallback}` uses the fallback when it is not set. `$$` writes a literal dollar. The
environment is `.env` and then `.env.local` next to `flamework.config.json`, with the process
environment on top of both, so a shell variable wins over `.env.local`, which wins over `.env`.
Commit `.env` with the defaults and ignore `.env.local` for personal overrides.

A variable is always a string, so a string sitting where a boolean, a number or a list is expected
is converted: `"obfuscation": "${OBFUSCATE:-false}"` becomes a boolean, and
`"active": "${FLAMEWORK_SCOPES:-}"` splits on commas into a list, with an empty value giving an
empty list. A variable that is not set and has no fallback fails the build, naming the variable and
the key that used it.

```ini
# .env
FLAMEWORK_SCOPES=
OBFUSCATE=false

# .env.local (ignored by git)
FLAMEWORK_SCOPES=components,collections
```

The same environment is what `Flamework.env("NAME", fallback?)` inlines into code, as a string
literal, at compile time. Use it for deployment values, never for secrets: the value is written
into the emitted Luau. See [Macros](07-macros.md#what-you-already-used).

### Watching

The file and the environment are read once, when `rbxtsc` starts, and a watcher keeps what it
read for as long as it runs. A watcher only recompiles the files that changed, and much of the
config is compiled into every file -- ids, serialization codecs, `Flamework.env` values -- so a
change taken up halfway would leave the output disagreeing with itself.

Under `rbxtsc -w`, a change to `flamework.config.json`, `.env` or `.env.local` is noticed on the
next rebuild and reported: `flamework.config.json or .env changed since the watcher started`. The
values it started with stay in use until you restart it. A plain build reads everything fresh.
Changing `idGenerationMode` or `obfuscation` also regenerates every identifier, which the next
full build does on its own.

## Testing

A module is a container you can build fresh, which is what makes Flamework code testable without
mocks-by-injection frameworks:

```ts
const definition = Flamework.createModule()
    .registerClassProvider(Shop)
    // swap the real implementation for a fake under the same id
    .registerProvider<Storage>({ type: "function", callback: () => new FakeStorage() })
    .build();

const module = definition.ignite();
const shop = module.resolveDependency<Shop>();

// ...assert...

module.extinguish();
```

Ignite the *definition* per case, not the module -- a `Module` cannot be re-ignited.

For scenarios that run inside a place -- a test rig, a debug world -- keep them under their own
folder and tie them to a [scope](11-scopes.md), so that they only exist in builds that ask for
them, and give them a module of their own that [imports](02-modules.md#importing-a-module) the
game's:

```ts
if (Flamework.isScopeActive("components")) {
    Flamework.createModule()
        .registerProviders("src/server/Testing/components")
        .includePlugin(ComponentPlugin.fromPath("src/server/Testing/components"))
        .ignite({ activeIn: ["components"], imports: [game] });
}
```

A provider in there takes the game's services in its constructor like any other, and
`game.extinguish()` takes the rig down first.

For networking, `predict` runs a receiving handler locally, guards and middleware included, without
a remote:

```ts
events.setReady.predict(player, true);
```

Flamework's own runtime specs use exactly this shape; see
[`packages/testing`](../../packages/testing) if you want a worked example.

## Studio plugins and models

A place is a `DataModel` tree, so a registered path starts at a service: `registerProviders("src/server/services")`
becomes `ServerScriptService/TS/services` and the runtime walks there from `game`. A Studio plugin
or a model is a tree of its own -- a `Folder` at the top of `default.project.json`, with nothing
above it -- and its paths are relative to that root instead.

Nothing changes in what you write. The transformer emits every path relative to the tree's root,
records in `include/flamework/paths.json` how far below that root the include folder sits, and the
runtime climbs from the include folder to find the root the first time a path is resolved. A
plugin therefore registers folders and globs exactly as a place does, and `@Provider` has no
notion of a realm to get in the way. `getPathRoot()` from `@flamework/core` is that instance, and
`resolveRbxPath(path)` walks a compile-time path from it, for a plugin of your own that resolves
paths by hand.

The one requirement is the usual one: the include directory has to be in the Rojo tree, as it is
in every roblox-ts template.

## Caveats

- **Overlapping registration paths raise.** `registerProviders("src/server")` and
  `registerProviders("src/server/services")` both find the same classes.
- **Path registration requires every module under the path**, so import side effects run at ignition.
- **Every registered folder must be mapped in Rojo**, or the build fails with
  `Could not find Rojo data`.
- **`ModuleDefinition`s in a registered folder get built as a side effect.** Keep them out of
  `services`.
- **The entry point should be the only file that ignites.** A second `ignite()` elsewhere builds a
  second, unrelated container, and dependencies will not resolve across them.

## Guard deduplication

Large guards can repeat the same nested type many times. With
`"optimizations": { "guardGenerationDedupLimit": N }` in the transformer options, any object or
union type that occurs at least `N` times inside one generated guard is emitted once as a local and
referenced, which shrinks the output and the work `t` does per check. Guards with more than two
members always use `t.unionList`, `t.intersectionList` and `t.literalList`, so there is no argument
limit to hit.

When your project resolves a different `@rbxts/t` than `@flamework/core` does, generated guards
import `t` through `@flamework/core/out/prelude` so they run against the version core was built with.

---

Previous: [Plugins](08-plugins.md) · Next: [Migrating from v1](10-migrating-from-v1.md)
