# 1. Getting started

By the end of this page you will have a service running on the server and on the client, registered
automatically, with no manual wiring.

## Install

```sh
npm install @flamework/core
npm install -D rbxts-transformer-flamework
```

Add the transformer to `tsconfig.json`. **Nothing in these docs works without it** -- most of
Flamework's API is a macro whose arguments the compiler fills in, and without the transformer those
arguments are simply missing at runtime.

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "transform": "rbxts-transformer-flamework"
      }
    ]
  }
}
```

That is the whole required configuration. Everything optional goes in a `flamework.config.json` next
to `tsconfig.json`, one section per package; it is covered in
[Project structure](09-project-structure.md#configuration).

## Rojo

Flamework resolves a source directory into a Rojo instance path at compile time, so your project
file has to map the folders you register from. A default roblox-ts project already does:

```json
{
  "name": "my-game",
  "tree": {
    "$className": "DataModel",
    "ServerScriptService": {
      "TS": { "$path": "out/server" }
    },
    "ReplicatedStorage": {
      "TS": { "$path": "out/shared" }
    },
    "StarterPlayer": {
      "StarterPlayerScripts": {
        "TS": { "$path": "out/client" }
      }
    }
  }
}
```

If a folder is not in the project file you will get `Could not find Rojo data for 'src/...'` at
compile time.

## Your first provider

A **provider** is a singleton. Mark it with `@Provider()` and export it:

```ts
// src/server/services/greeter.ts
import { OnStart, Provider } from "@flamework/core";

@Provider()
export class Greeter implements OnStart {
    public onStart() {
        print("hello from the server");
    }
}
```

## Igniting

The entry point builds a module and ignites it:

```ts
// src/server/runtime.server.ts
import { Flamework, LifecyclePlugin } from "@flamework/core";

Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .registerProviders("src/server/services")
    .ignite();
```

Three things happened:

1. **`registerProviders("src/server/services")`** found every exported `@Provider()` class under that
   folder. You do not list them by hand -- see [Providers](03-providers.md#registration) for exactly
   how this works and when it does not.
2. **`includePlugin(LifecyclePlugin)`** enabled `OnStart`, `OnTick` and the rest. Lifecycle events
   are not built in; if you forget this line, `onStart` never runs and nothing complains.
3. **`ignite()`** constructed every provider, injected their dependencies, ran every `onInit` in dependency
   order, and then ran the hooks.

The client is the same shape:

```ts
// src/client/runtime.client.ts
import { Flamework, LifecyclePlugin } from "@flamework/core";

Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .registerProviders("src/client/controllers")
    .ignite();
```

There is no `@Service` / `@Controller` split in v2. A provider is a provider; *which* realm gets it
is decided by which module registers it, which is why the two entry points point at different
folders.

## Adding a dependency

Constructor parameters are resolved by type. No tokens, no strings, no decorators on the parameters:

```ts
// src/server/services/economy.ts
@Provider()
export class Economy {
    public balance = 0;
}

// src/server/services/shop.ts
@Provider()
export class Shop implements OnStart {
    constructor(private economy: Economy) {}

    public onStart() {
        print(this.economy.balance);
    }
}
```

Both are under `src/server/services`, so both are registered by the same `registerProviders` call and
`Shop` gets the module's single `Economy` instance.

## Sharing code between realms

Put anything both realms need in a shared folder and register it from both entry points, or -- better
-- put it in its own module and include it. That is [Modules](02-modules.md).

## Caveats

- **Lifecycle events need `LifecyclePlugin`.** Forgetting it fails silently: `onStart` simply never
  runs.
- **The path must be a string literal.** `registerProviders(SOME_CONSTANT)` fails to compile with
  `Path is invalid, expected string literal`.
- **The path is a source path, not a Rojo path.** Write `"src/server/services"`, not
  `"ServerScriptService/TS/services"`.
- **Providers must be exported.** Registration works by requiring each ModuleScript and looking at
  its exports; a class that is not exported is invisible.
- **`@Provider()` metadata must exist on both realms.** It is written when the decorator evaluates,
  and nothing about it is realm-specific, so a class shared between realms behaves identically on
  both.

### Errors you may hit

| Message | Cause |
|---|---|
| `Could not find Rojo data for 'src/...'` | The folder is not mapped in your Rojo project file. |
| `Path is invalid, expected string literal and got: string` | The path argument is not a literal. |
| `class 'X' is missing the @Provider() decorator` | `registerClassProvider`/`registerProvider` was given an undecorated class. |
| `class 'X' is missing the @Provider() decorator: it inherits one from a parent class` | The class extends a provider but is not decorated itself. |
| `Flamework has no paths for the glob '...'` | `registerProvidersGlob` in a package, or the include directory is not in the Rojo project, or the glob matched nothing. |
| `ServerScriptService.TS.services.X failed to load (Nms): ...` | A module under a registered path raised while being required. |
| `module '...' has been extinguished, cannot ...` | Something resolved from, or created an instance on, a module after `extinguish()`. |
| `provider ID was registered more than once: ...` | The same class was registered twice, often by two overlapping `registerProviders` paths. |
| `module could not resolve dependency 'X'` | A constructor parameter's type is not registered in this module or any module it includes. |

---

Next: [Modules](02-modules.md)
