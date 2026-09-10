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
    modules/                   reusable ModuleDefinitions
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

## Choosing how many modules

**One module per realm** is the default and is right for most games. Everything is in one container,
anything can inject anything, and you never think about it again.

Add a second module when there is a boundary you actually want enforced:

| Situation | Shape |
|---|---|
| Shared code both realms need | A `ModuleDefinition` in `shared/modules`, included by both entry points. |
| A library you publish | Its own definition, exporting only its public providers. |
| A feature you want isolated | Its own definition; the root includes it and only sees its exports. |
| Tests | Build the definition once, ignite per case, extinguish after. |

```ts
// src/shared/modules/core.ts
export const CoreModule = Flamework.createModule()
    .registerProviders("src/shared/services")
    .exportProviders<Config | Logger>()
    .build();
```

```ts
// both entry points
.includeModule(CoreModule)
```

Each realm ignites its own copy, which is correct -- they are different processes.

## Where things go

| Thing | Where | Why |
|---|---|---|
| `createEvent` / `createFunction` | `shared/` | Both realms import the same object; its identity is generated from the callsite. |
| Components used on both realms | `shared/components` | Registered by both entry points. |
| Components for one realm | `<realm>/components` | Same tag, different class per realm, is a normal pattern. |
| Interfaces for plugin dispatch | `shared/` | Both the plugin and the implementers need them. |
| `ModuleDefinition`s | `shared/modules` | Not `shared/services`, or path registration will pick up their providers too. |

That last row is a real trap: `registerProviders("src/shared/services")` requires **every** module
under that folder. If a `ModuleDefinition` lives there, building it runs as a side effect of
registration.

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
  "components": { "warningTimeout": 5, "attributeWarningTimeout": 5, "streamingMode": "Contextual" }
}
```

| Section | Key | Effect |
|---|---|---|
| `transformer` | `hashPrefix` | Prefix for generated ids. Defaults to the package name; set a short one in a game. |
| | `obfuscation` | Obfuscates identifiers: random remote names, shuffled metadata, short ids. Game projects only. |
| | `idGenerationMode` | `"full"` (default), `"short"`, `"tiny"` or `"obfuscated"`. Only shorten in a game. |
| | `plugins` | Transformer plugins; see [transformer plugins](../reference/transformer-plugins.md). |
| | `salt`, `noSemanticDiagnostics`, `optimizations` | Hash salt, skipping semantic diagnostics, [guard deduplication](#guard-deduplication). |
| `core` | `profiling` | Default for `LifecyclePlugin` profiling; `createLifecyclePlugin({ profiling })` overrides it per module. |
| `networking` | `serialization` | Serializes every event and function payload into a buffer with code generated at compile time; see [Networking](06-networking.md#serialization). |
| `components` | `warningTimeout`, `attributeWarningTimeout`, `streamingMode` | Defaults for components that do not set their own. |

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

The file is read once per compilation. `rbxtsc -w` does not watch it, so restart the watcher after
editing it.

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

For networking, `predict` runs a receiving handler locally, guards and middleware included, without
a remote:

```ts
events.setReady.predict(player, true);
```

Flamework's own runtime specs use exactly this shape; see
[`packages/testing`](../../packages/testing) if you want a worked example.

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
