# 1. Getting started

By the end of this page you will have a provider (what v1 called a service or a controller) running
on the server and on the client. Flamework finds and registers it for you, so there is no wiring to
write by hand.

## Install

```sh
npm install @flamework-experimental/core
npm install -D @flamework-experimental/transformer
```

Add the transformer to `tsconfig.json`. **Nothing in these docs works without it.** Most of
Flamework's API is made of *macros*: functions with some arguments that the transformer fills in
when you build. Without the transformer, those arguments are missing at runtime.

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "transform": "@flamework-experimental/transformer"
      }
    ]
  }
}
```

Also add the `@flamework-experimental` npm scope to `typeRoots`, next to `@rbxts`. roblox-ts only
accepts imports from the scopes listed there:

```jsonc
"typeRoots": ["node_modules/@rbxts", "node_modules/@flamework-experimental"]
```

(TypeScript treats every package under a `typeRoots` directory as a type library. That is why the
transformer and the CLI ship an empty declaration file.)

That is all the configuration you need. Optional settings go in a `flamework.config.json` next to
`tsconfig.json`, with one section per package. They never go on the tsconfig entry: the build fails
if the entry sets one. See [Project structure](09-project-structure.md#configuration).

You don't have to write that file to see what you can set. With `tsconfig.json` at the root of your
package, as here, your first build creates it, holding just a `$schema` line. It also adds the line
to a file that lacks it. With that line, your editor lists every option with its description and
its default.

## Rojo

Your Rojo project file has to map two things: the folders you register from, and the packages.

When you build, Flamework turns each source folder you register from into a **Rojo path**: the
instance path the folder ends up at, such as `ServerScriptService/TS/services`. So the folders you
register from have to be in the project file. A default roblox-ts project maps all of `out/`, which
covers them.

The packages are ModuleScripts like any `@rbxts` package. They live next to the `@rbxts` packages,
under `ReplicatedStorage.rbxts_include.node_modules`. Map the whole `@flamework-experimental` folder
there, in one line:

```json
{
  "name": "my-game",
  "globIgnorePaths": ["**/package.json", "**/tsconfig.json"],
  "tree": {
    "$className": "DataModel",
    "ServerScriptService": {
      "TS": { "$path": "out/server" }
    },
    "ReplicatedStorage": {
      "rbxts_include": {
        "$path": "include",
        "node_modules": {
          "$className": "Folder",
          "@rbxts": { "$path": "node_modules/@rbxts" },
          "@flamework-experimental": { "$path": "node_modules/@flamework-experimental" }
        }
      },
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

Each package you install arrives in the place with its `out` folder: `core`, and `components`,
`networking` and `testing` when you install them. `core` also ships this guide, as Markdown, which
Rojo skips; its two folders arrive as empty Folders, `core.docs` and `core.docs.guide`. The
transformer is installed in the same folder, and it arrives as one empty Folder: it ships a
`default.project.json`, which Rojo uses in place of the package's folder. Two entries are the same as
in the roblox-ts template:

- `include` holds the roblox-ts runtime and the files Flamework generates when you build
  (`include/flamework`).
- `globIgnorePaths` stops each package's `package.json` from becoming a ModuleScript.

**The one line needs `@flamework-experimental/transformer` 2.0.0-alpha.5 or later.** An older
transformer ships no `default.project.json`, so Rojo would copy it into `ReplicatedStorage`, which
replicates to every client. Rojo skips its JavaScript, but its folders arrive as empty Folders and
its three JSON schemas arrive as ModuleScripts (`flamework-schema`, `flamework.config.schema`,
`rojo-schema`). With an older transformer, map each runtime package by name instead. This form works
with every version:

```json
"@flamework-experimental": {
  "$className": "Folder",
  "core": { "$path": "node_modules/@flamework-experimental/core" },
  "components": { "$path": "node_modules/@flamework-experimental/components" },
  "networking": { "$path": "node_modules/@flamework-experimental/networking" }
}
```

`core` is always needed. Add `components`, `networking` and `testing` when you install them, and
leave out the ones you do not use.

If a folder you register from is not in the project file, the build fails with `Could not find Rojo
data for 'src/...'`. If a package your code imports is not mapped, roblox-ts fails the build with
`Could not find Rojo data. There is no $path in your Rojo config that covers ...`, naming a file of
that package.

## Your first provider

A **provider** is usually a class that Flamework creates once per module: a singleton. Mark it with
`@Provider()` and export it:

```ts
// src/server/services/greeter.ts
import { OnStart, Provider } from "@flamework-experimental/core";

@Provider()
export class Greeter implements OnStart {
    public onStart() {
        print("hello from the server");
    }
}
```

## Igniting

Your entry point creates a **module**, registers your providers in it, and **ignites** it, which
starts everything:

```ts
// src/server/runtime.server.ts
import { Flamework } from "@flamework-experimental/core";

Flamework.createModule()
    .registerProviders("src/server/services")
    .ignite();
```

Two calls do the work:

1. **`registerProviders("src/server/services")`** finds every `@Provider()` class defined in the
   files under that folder, exported or not. You do not list them by hand. See
   [Providers](03-providers.md#registration) for how this works and when it does not.
2. **`ignite()`** constructs every provider, injects their dependencies, runs every `onInit` in
   dependency order, and then runs `onStart`.

`onStart` runs because every module includes `LifecyclePlugin` from the start. A **plugin** adds
features to a module. `LifecyclePlugin` is an ordinary one: `disableDefaultLifecycle()` on the
builder leaves it out, and including one built with `createLifecyclePlugin({ … })` replaces it. See
[Lifecycle events](04-lifecycle-events.md).

The client entry point looks the same:

```ts
// src/client/runtime.client.ts
import { Flamework } from "@flamework-experimental/core";

Flamework.createModule()
    .registerProviders("src/client/controllers")
    .ignite();
```

There is no `@Service` / `@Controller` split in v2. The module that registers a provider decides
which realm gets it. That is why the two entry points register different folders.

## Adding a dependency

Flamework resolves constructor parameters by their type: each parameter gets what the module
provides for that type, usually another provider. There are no tokens, no strings and no decorators
on the parameters:

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

Both files are under `src/server/services`, so the same `registerProviders` call registers both.
`Shop` gets the module's single `Economy` instance.

## Sharing code between realms

Put anything both realms need in a shared folder, and register that folder from both entry points.
Or wrap it in a plugin that both include; see [Plugins](08-plugins.md).

## Caveats

- **`disableDefaultLifecycle()` is silent.** With it, `onStart` never runs, and nothing warns you.
- **The path must be a string literal.** `registerProviders(SOME_CONSTANT)` fails to compile with
  `Path is invalid, expected string literal`.
- **The path is a source path, not a Rojo path.** Write `"src/server/services"`, not
  `"ServerScriptService/TS/services"`.
- **The path is resolved in the project that compiles the call**, with that project's Rojo file. So
  a published package cannot register its own folders: its `registerProviders("src/...")` gets a path
  in the package's project, which a game's place does not have, and fails at runtime. In a package,
  register classes one by one with `registerClassProvider`.
- **Providers are found where they are defined.** Registration requires each ModuleScript under the
  folder. It takes every class the ModuleScript defines at its top level, exported or not, as v1
  did. A class declared inside a function is found only if its file exports it.
- **`@Provider()` metadata must exist on both realms.** It is written when the decorator runs, and
  none of it depends on the realm. So a class shared between realms behaves the same on both.

### Errors you may hit

| Message | Cause |
|---|---|
| `Could not find Rojo data for 'src/...'` | The folder is not mapped in your Rojo project file. |
| `Could not find Rojo data. There is no $path in your Rojo config that covers ...` (roblox-ts) | The file it names belongs to a package your code imports, and your Rojo project file does not map that package. See [Rojo](#rojo). |
| `Path is invalid, expected string literal and got: string` | The path argument is not a literal. |
| `class 'X' is missing the @Provider() decorator` | `registerClassProvider`/`registerProvider` was given an undecorated class. |
| `class 'X' is missing the @Provider() decorator: it inherits one from a parent class` | The class extends a provider but is not decorated itself. |
| `Flamework has no paths for the glob '...'` | A glob registration (`registerProvidersGlob`, `ComponentPlugin.fromGlob`, ...) in a package, the include directory not in the Rojo project, a string passed to `getGlobPaths`/`getClassesInGlob` that no glob macro made, or a `globs.json` from another build. A glob that matches no files does not raise this. It registers nothing, and the build prints a warning where it is used. |
| `ServerScriptService.TS.services.X failed to load (Nms): ...` | A ModuleScript under a registered path, or under a folder given to `requireModules`, raised an error while being required. |
| `requireModules("..."): the folder is not in the place` | The folder has no modules, so roblox-ts emitted nothing for it; or it was moved or renamed after the build; or the Rojo project the place was built from leaves it out. The message names the part of the path that is missing. See [Macros › Paths](07-macros.md#paths). |
| `module '...' has been extinguished, cannot ...` | Something resolved from, or created an instance on, a module after `extinguish()`. |
| `provider ID was registered more than once: ...` | The same class was registered twice, often by two overlapping `registerProviders` paths. Raised at ignition. |
| `could not resolve dependency '...': it is registered but inactive` | The class is tied to a [scope](11-scopes.md) that this build does not have active. |
| `could not resolve dependency 'X': 'X' (...) is under registerProviders("..."), which is left out by its scope` | The class is under a folder whose registration has a [scope](11-scopes.md) condition this build does not meet, so the folder was never loaded. `getComponent` gives the same reason, starting `component '...' could not be found:`. |
| `could not resolve dependency '...': nothing registers it. Left out by their scope, without loading their folders: ...` | The module found nothing for the id, and some folder registrations were left out by their scope. If the class is under one of them, change the build's scopes or stop depending on it. |
| `could not resolve dependency 'X': 'X' (...) is a component (@Component), not a provider` | `Dependency<X>()`, `resolveDependency` or a constructor asked for a component. Components are built by `Components`: get one with `getComponent`, or make the class a `@Provider()`. The transformer refuses the plain `Dependency<X>()` and a provider's constructor parameter when you build. |
| `could not resolve dependency 'X': 'X' (...) is a @Provider() that nothing in this module registers or provides` | The class has loaded, but no path, registration, plugin or import of this module brings it in. |
| `module could not resolve dependency 'X'` | A constructor parameter's type is not registered in this module or any module it includes. |
| `'X' is a component (@Component), not a provider` (compile error) | `Dependency<X>()`, `resolveDependency<X>()` or a provider's constructor names a component. |
| `@Provider() on 'X': loadOrder must be a finite number` | `loadOrder` is `math.huge`, NaN or not a number. Raised when the ModuleScript that defines the class loads. |

---

Next: [Modules](02-modules.md)
