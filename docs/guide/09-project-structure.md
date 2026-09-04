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
import { Flamework, LifecyclePlugin } from "@flamework/core";

Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .includePlugin(ComponentPlugin.fromPath("src/shared/components"))
    .includePlugin(ComponentPlugin.fromPath("src/server/components"))
    .registerProviders("src/server/services")
    .ignite();
```

```ts
// src/client/runtime.client.ts
Flamework.createModule()
    .includePlugin(LifecyclePlugin)
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

## Transformer options

The only required entry is `transform`. The rest, in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "transform": "rbxts-transformer-flamework",

        // Prefixes generated ids. Defaults to the package name; set it in a game to keep ids short
        // and to avoid colliding with a package.
        "hashPrefix": "$g",

        // Randomises remote names and shortens ids. Game projects only.
        "obfuscation": false,

        // "full" (default), "short", "tiny" or "obfuscated". Only shorten in a game -- a published
        // package must stay on "full" so its ids do not collide with its consumers'.
        "idGenerationMode": "full",

        // Transformer plugins; see reference/transformer-plugins.md
        "plugins": [],

        // Salt for generated hashes. Defaults to a random 64-byte salt.
        "salt": "…",

        // Skips TypeScript's semantic diagnostics. Faster, but you lose type errors.
        "noSemanticDiagnostics": false
      }
    ]
  }
}
```

**Do not set `idGenerationMode` or `obfuscation` in a published package.** Ids have to be stable and
collision-free across every consumer.

## Testing

A module is a container you can build fresh, which is what makes Flamework code testable without
mocks-by-injection frameworks:

```ts
const definition = Flamework.createModule()
    .includePlugin(LifecyclePlugin)
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

---

Previous: [Plugins](08-plugins.md) · Next: [Migrating from v1](10-migrating-from-v1.md)
