# 9. Project structure

Nothing here is enforced. Flamework only needs the folders you register from to be mapped in your
Rojo project. A class is found in the file that defines it, exported or not. This page shows what
tends to work.

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

The entry points are the only files that know how everything fits together:

```ts
// src/server/runtime.server.ts
import { ComponentPlugin } from "@flamework-experimental/components";
import { Flamework } from "@flamework-experimental/core";

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

`services` and `controllers` are only folder names: v2 has no `@Service`/`@Controller` distinction.
Keeping the folders separate is what keeps server code off the client.

Register only the folders you have. A registered folder that does not exist is not in the place,
and the call waits for it at runtime, warning after five seconds with its own name. One that holds
no module yet (a new game's `shared/components`, say) is copied into the place empty and registers
nothing, but git keeps no empty folder, so a fresh clone has no such folder and waits the same way.
The build warns about both where the path is written
([Getting started › Rojo](01-getting-started.md#rojo)). Add the `fromPath` line with the first
component, or leave a module in the folder. `plugins/` and `types/` are not registered, so they need
nothing.

Each entry point includes two `ComponentPlugin`s. They share the module's one `Components`, so a
server component can link to a shared one ([Components](05-components.md)).

## One module per realm

**One module per realm** is right for every game. Everything is in one container, anything can
inject anything, and you don't have to think about it again. What varies is what goes *into* the
module:

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

Each realm ignites its own module. That is correct: the server and the client are different
processes.

## Where things go

| Thing | Where | Why |
|---|---|---|
| `createEvent` / `createFunction` | `shared/` | Both realms import the same object; its identity is generated from the callsite. |
| Components used on both realms | `shared/components` | Registered by both entry points. |
| Components for one realm | `<realm>/components` | Same tag, different class per realm, is a normal pattern. |
| Interfaces for plugin dispatch | `shared/` | Both the plugin and the implementers need them. |
| Plugins | `shared/plugins` | Not `shared/services`: path registration requires everything under the folder, and a plugin built with `ComponentPlugin.fromPath` registers its folder as a side effect. |

The last row matters because `registerProviders("src/shared/services")` requires **every**
ModuleScript under that folder. Whatever a file there does when it loads happens during
registration.

## Configuration

Every Flamework package reads one file, `flamework.config.json`, next to `tsconfig.json`. Each
package has its own section in the file. The only entry `tsconfig.json` needs is `transform`:

```jsonc
// flamework.config.json
{
  "$schema": "./node_modules/@flamework-experimental/transformer/flamework.config.schema.json",
  "transformer": {
    "obfuscation": false,
    "idGenerationMode": "short",
    "optimizations": { "guardGenerationDedupLimit": 5 },
    "plugins": []
  },
  "serialization": { "checks": { "category": "implicit", "mode": "assert", "side": "both", "types": false } },
  "core": { "profiling": true },
  "networking": { "serialization": true },
  "components": { "warningTimeout": 5, "attributeWarningTimeout": 5, "streamingMode": "Contextual", "watchRenames": false },
  "scopes": { "active": "${FLAMEWORK_SCOPES:-}" }
}
```

| Section | Key | Effect |
|---|---|---|
| `transformer` | `hashPrefix` | Prefix for generated ids. Defaults to the package name in a package, and to none in a game. A game needs none: every package id starts with its package's prefix and a colon (`$c:components@Components`, or the package's name for a package of someone else's), which none of a game's own ids starts with, so they cannot collide. A game may still set one, to mark its ids; the ids change with it, so change it with a plain build. It cannot start with `$`, which Flamework's own packages use. |
| | `obfuscation` | Obfuscates identifiers: random remote names, shuffled metadata, short ids, all different on every plain build. Game projects only; see [obfuscation](#obfuscation). |
| | `idGenerationMode` | `"full"`, `"short"`, `"tiny"` or `"obfuscated"`. Defaults to `"obfuscated"` with obfuscation on, else `"full"`. Only shorten in a game. |
| | `plugins` | Transformer plugins; see [transformer plugins](../reference/transformer-plugins.md). |
| | `salt`, `noSemanticDiagnostics`, `optimizations` | Hash salt, skipping semantic diagnostics, [guard deduplication](#guard-deduplication). |
| `serialization` | `checks`: `category`, `mode`, `side`, `types` | Checks on the values the generated code writes into a buffer (networking's and `Flamework.createSerializer`'s): which values (`Serialization.Implicit` widths by default, strict ones too, or none), whether one that does not fit raises or warns, in which realm, and whether every value's type is tested as well (`types`, off by default; see [Type checks](06-networking.md#type-checks)). Read when you build; see [Implicit widths and checks](06-networking.md#implicit-widths-and-checks). |
| `core` | `profiling` | Default for `LifecyclePlugin` profiling; `createLifecyclePlugin({ profiling })` overrides it per module. |
| `networking` | `serialization` | Serializes every event and function payload into a buffer with code generated at compile time; see [Networking](06-networking.md#serialization). |
| `components` | `warningTimeout`, `attributeWarningTimeout`, `streamingMode`, `watchRenames` | Defaults for components that do not set their own. |
| `scopes` | `active` | The scopes this build is compiled with; see [Scopes](11-scopes.md). |
| `testing` | `activeIn`, `inactiveIn`, `enabled`, `autoRun`, `timeout`, `concurrency`, `entry`, `failOnSkip`, `keepAwake`, `lockTimeout`, `lockHold`, `parallel`, `showWindows` | Tests in the place: the scopes under which the plugin attaches (`["testing"]` by default) and an override, whether tests run at start, the timeout per test, how many concurrent tests run at once, and `entry`, the ModuleScript a cloud task ignites the game from (a cloud task runs none of the place's Scripts; Studio needs no entry); and what only flamework-test reads, which is not compiled into the place: a skip fails the run, a Studio run keeps the display on, how long a command waits for the Studio lock and a window it left open may sit unused, how many Rojo projects' windows a run opens side by side, and whether a test's windows open where they are seen rather than on a hidden desktop. See [Testing in the place](12-testing.md). |
| `cloud` | `testingUniverseId`, `testingPlaceId`, `apiKey`, `originalPlace` | The testing place that `flamework-test` publishes to and runs in for a cloud run, and a copy of the original place to lay the build over (Studio runs use it too). Read by that CLI only, never compiled in. See [Running the tests](../testing/place.md). |

The transformer looks for the file in the tsconfig's directory, then in each parent folder up to the
package root. So a repository with several places can share one file at the root, and a place can
still have its own file, which is used instead.

Comments and trailing commas are allowed. Unknown keys are rejected, with their name in the error,
and so is a value an option does not take. For an option with a fixed set of values, the error lists
them (`must be equal to one of the allowed values: "implicit", "all", "none"`); for a value of the
wrong type, it gives the type (`must be string`).

The `$schema` line gives your editor every option, with its description and its default, and checks
what you write. You don't have to add it yourself. When a game builds, the transformer adds the line
if the file has none. If the game has no `flamework.config.json` yet, it creates one next to
`tsconfig.json` with just that line, but only when `tsconfig.json` is at the package root. A place
in a subfolder gets no file of its own, because that file would hide a shared one you add at the
root later. The transformer does this once, when `rbxtsc` starts, not on a watcher's rebuilds. It
never changes a `$schema` that is already there, and never touches a package's config file.

The tsconfig entry takes only `transform` and, if you need it, `configFile`. To use a different
name or location for the file, set `"configFile": "config/flamework.json"` on the entry. Any other
key on the entry fails the build, and the error names the key. For a transformer option it also
names the file to move it to. For any other key it says to remove it. (Keys that the plugin loader
reads itself, such as `import`, are allowed.)

For a game project, the transformer copies the runtime sections (`core`, `networking`,
`components`, `scopes` and `testing`) into
`include/flamework/config.json`, and the packages read them through `getRuntimeConfig()` from
`@flamework-experimental/core`. `cloud` is not one of them and never reaches the place, and neither
is `serialization`, which is compiled into the code that writes values. A package (a
project with a scoped name) gets no such file: its defaults come from the game that uses it.

**Do not set `idGenerationMode` or `obfuscation` in a published package.** Ids have to be stable,
and must not collide, in every game that uses the package.

### Obfuscation

With `obfuscation` on, every generated name changes with every plain build: a fresh run of `rbxtsc`,
not a watcher's rebuild or an incremental build (both explained below). That includes class ids,
hashed strings, and the callsite uuids that name every remote. A name mapped in one release is
useless against the next. That is the point: a cheat cannot carry a map of your remotes from one
version to another.

Ids declared in a package are the exception. Obfuscation hashes your game's own ids: its classes and
its own interfaces. A package's ids keep the names the package was published with. That covers
Flamework's own (`OnStart`, `OnInit`, `OnTick`, `Components` and the rest) and those of any other
package built with Flamework. The reason: a package is built before your game, and its compiled code
compares those exact strings at runtime. For example, core's lifecycle plugin looks for
`$:lifecycle/lifecycleInterfaces@OnStart`. Your game's build cannot rename them. Renaming them at
runtime would ship the list of new names to the client, next to the package's own readable code, so
it would hide nothing. Flamework v1 worked the same way. A readable package id only reveals which
Flamework events and package types a class uses.

The names come from a hash salt and a build seed, both kept in `flamework.build`. A plain `rbxtsc`
recreates that file, and with it the salt and the seed. A running `rbxtsc -w` keeps reading the
file it started with. So the names stay the same while the watcher runs, and every rebuild agrees
with the files it did not recompile.

Two things keep names the same across builds, and the transformer warns about both:

- **`transformer.salt`**, which fixes the hash the class ids come from. Leave it unset with
  obfuscation on.
- **An incremental build** (`incremental`, with a `tsBuildInfoFile` or TypeScript's default,
  which is `tsconfig.tsbuildinfo` beside `tsconfig.json` when `rootDir` is `src`). It reuses the
  previous `flamework.build`, so that the files it does not recompile still match. Delete the
  tsbuildinfo before a release build; the warning names it.

Without obfuscation the names are stable across builds, which is what you want while debugging.

### Values from the environment

Any string in the file can use environment variables:

- `${NAME}` is the variable's value.
- `${NAME:-fallback}` uses the fallback when the variable is not set.
- `$$` writes a literal dollar sign.

The variables come from `.env` and `.env.local` next to `flamework.config.json`, and from the
process environment. A shell variable wins over `.env.local`, which wins over `.env`. Commit `.env`
with the defaults, and git-ignore `.env.local` for personal overrides. `.env.local` is read by every
build on your machine, the ones you ship included, so a scope that adds test or debug code does not
belong there when you build a place to publish; give it to the one build that needs it instead
([Testing in the place › Setting up](12-testing.md#setting-up)).

A variable is always a string. Where the file expects a boolean, a number or a list, the string is
converted: `"obfuscation": "${OBFUSCATE:-false}"` becomes a boolean, and
`"active": "${FLAMEWORK_SCOPES:-}"` is split on commas into a list (an empty value gives an empty
list). A variable that is not set and has no fallback fails the build, with an error naming the
variable and the key that used it.

```ini
# .env
FLAMEWORK_SCOPES=
OBFUSCATE=false

# .env.local (ignored by git)
FLAMEWORK_SCOPES=components,collections
```

`Flamework.env("NAME", fallback?)` reads the same environment, and inlines the value into code as a
string literal when you build. Its type is `string | undefined` on its own, and `string` with a
fallback. Use it for deployment values, never for secrets: the value is written into the emitted
Luau. See [Macros](07-macros.md#what-you-already-used).

### Watching

The file and the environment are read once, when `rbxtsc` starts. A watcher keeps what it read for
as long as it runs. The reason: a watcher only recompiles the files that changed, but much of the
config is compiled into every file (ids, serialization codecs, `Flamework.env` values). Taking up a
change halfway would leave the output disagreeing with itself.

Under `rbxtsc -w`, a change to `flamework.config.json`, `.env` or `.env.local` is noticed on the
next rebuild and reported: `flamework.config.json or .env changed since the watcher started`. The
watcher keeps using the values it started with until you restart it. A plain build reads everything
fresh. Changing `idGenerationMode` or `obfuscation` also regenerates every identifier, which the
next plain build does on its own.

## What to commit

What a game commits and what it ignores. The build creates `flamework.config.json` once, when it is
missing, and that file is yours from then on: commit it. Everything else the build writes is
written again by every plain build (`rbxtsc`), so none of it is committed:

| File | Commit | Why |
|---|---|---|
| `flamework.config.json` | yes | Your settings. The `$schema` line in it is a relative path into `node_modules`, the same on every machine, so it goes with the file. |
| `.env` | yes | The defaults the config reads, with nothing secret in it. Leave build switches such as `FLAMEWORK_SCOPES` empty here: every plain build, the release one included, reads this file. |
| `.env.local` | no | Your own overrides, and secrets such as `ROBLOX_API_KEY`. It wins over `.env`. |
| `flamework.build` | no | The ids, the hash salt and the build seed. Every plain build writes it anew, even over one cut short or holding a merge conflict; only an incremental build or a watcher reads the old one, and stops on one it cannot use with a message that names the file and what to do. |
| `include/`, `include/flamework/` | no | roblox-ts copies its runtime into `include/` on every build, and the transformer writes `include/flamework/` (paths, globs, the runtime config) on every build of a game. roblox-ts's template already ignores `/include`. |
| `out/`, `*.tsbuildinfo` | no | The compiled Luau, and an incremental build's record. |
| Place files the build makes (`rojo build -o place.rbxl`, and the `place.patched.rbxl` or `place.<project>.rbxl` that `flamework-test` writes beside it) | no | Rebuilt from the sources. Ignore `/*.rbxl` at the root rather than every `*.rbxl`, so a place you keep in a folder on purpose, such as a test place saved from Studio, can still be committed. |
| `*.rbxl.lock`, `*.rbxlx.lock` | no | Studio's lock beside a place it has open. `flamework-test` removes the lock of a window it ends; one left by a Studio closed any other way stays behind. |
| `build/` | no | `flamework-test` records the version it published in `build/version.json`: `cloud publish` does, and so `cloud test` and `test --cloud`. |

```gitignore
/node_modules
/out
/include
/flamework.build
*.tsbuildinfo
.env.local
/*.rbxl
/*.rbxlx
*.rbxl.lock
*.rbxlx.lock
/build
```

## Testing

For tests that run inside the place (in Studio, in a live server, or in an Open Cloud task), use
[`@flamework-experimental/testing`](12-testing.md): sections of tests loaded by a plugin, run
through a bindable, with cleanup that always runs.

This section covers the other kind. A module is a container you can build fresh, so you can test
Flamework code without a mocking framework that works through injection:

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

Ignite the *definition* once per test case, not the module: a `Module` cannot be ignited again.

For scenarios that run inside a place, such as a test rig or a debug world, keep them in their own
folder and tie them to a [scope](11-scopes.md), so they only exist in builds that ask for them.
Give them a module of their own that [imports](02-modules.md#importing-a-module) the game's module:

```ts
if (Flamework.isScopeActive("components")) {
    Flamework.createModule()
        .registerProviders("src/server/Testing/components")
        .includePlugin(ComponentPlugin.fromPath("src/server/Testing/components"))
        .ignite({ activeIn: ["components"], imports: [game] });
}
```

A provider in that folder takes the game's providers in its constructor like any other.
`game.extinguish()` takes the rig down first.

For networking, `predict` runs a receiving handler locally, guards and middleware included, without
a remote:

```ts
events.setReady.predict(player, true);
```

Flamework's own runtime specs use this shape; see [`packages/specs`](../../packages/specs) for a
worked example.

## Studio plugins and models

A place is a `DataModel` tree, so a registered path starts at a service.
`registerProviders("src/server/services")` becomes `ServerScriptService/TS/services`, and the
runtime walks there from `game`. A Studio plugin or a model is a tree of its own: a `Folder` at the
top of `default.project.json`, with nothing above it. Its paths are relative to that root instead.

Nothing changes in what you write. It works like this:

1. The transformer emits every path relative to the tree's root.
2. It records in `include/flamework/paths.json` how far below that root the include folder sits.
3. The first time a path is resolved, the runtime climbs up from the include folder to find the
   root.

So a Studio plugin registers folders and globs exactly as a place does, and `@Provider` has no
notion of a realm to get in the way. For a plugin of your own that resolves paths by hand,
`getPathRoot()` from `@flamework-experimental/core` returns that root instance, and
`resolveRbxPath(path)` walks a compile-time path from it.

The only requirement is the usual one: the include directory has to be in the Rojo tree, as it is
in every roblox-ts template.

## Caveats

- **Overlapping registration paths raise.** `registerProviders("src/server")` and
  `registerProviders("src/server/services")` both find the same classes.
- **Path registration requires every ModuleScript under the path**, so import side effects run at
  ignition. A registration whose own scope condition does not hold skips its folder instead
  ([Scopes](11-scopes.md)).
- **Every registered folder must be mapped in Rojo**, or the build fails with
  `Could not find Rojo data`. It must also exist under its exact name and hold a module, or the
  build warns: a folder the place lacks is waited for at runtime, and an empty one registers
  nothing.
- **`ModuleDefinition`s in a registered folder get built as a side effect.** Keep them out of
  `services`.
- **The entry point should be the only file that ignites.** A second `ignite()` elsewhere builds a
  second, unrelated container, and dependencies will not resolve across them.

## Guard deduplication

Large guards can repeat the same nested type many times. Set
`"optimizations": { "guardGenerationDedupLimit": N }` in the transformer options, and any object or
union type that occurs at least `N` times inside one generated guard is emitted once, as a local,
and referenced from there. This shrinks the output and the work `t` does per check.

Guards with more than two members always use `t.unionList`, `t.intersectionList` and
`t.literalList`, so there is no argument limit to hit.

When your project resolves a different `@rbxts/t` than `@flamework-experimental/core` does,
generated guards import `t` through `@flamework-experimental/core/out/prelude`. That way they run
against the version core was built with.

---

Previous: [Plugins](08-plugins.md) · Next: [Migrating from v1](10-migrating-from-v1.md)
