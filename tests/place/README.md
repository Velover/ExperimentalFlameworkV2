# The Studio test place

A small roblox-ts game that exists to run Flamework's in-place test suite against this repository's
own package builds, in Roblox Studio (both realms) or in a real server through Open Cloud. It is
what the Lune suites under [`tests/runtime`](../runtime) cannot be: a real engine, with replication,
streaming, deferred signals and a Rojo-built place.

It is a workspace member of the repository, so `@flamework-experimental/core`, `components`,
`networking`, `testing` and `transformer` are links to `packages/*`: whatever `bun run build` last
wrote to their `out` folders is what the place compiles against and Rojo puts in the place. Nothing
is packed or copied.

## Running it

From the repository root:

```console
bun run test:place                                                    # build the packages, then everything below
bun run test:place --project tests/deferred.project.json              # one project (paths are relative to tests/place)
bun run test:place --project tests/deferred.project.json --realm client --sections components
bun run test:place --cloud                                            # a real server through Open Cloud, server realm
```

From here, once the packages are built:

```console
bun run test          # rbxtsc, rojo build, make original.rbxl if missing, flamework-test test place.rbxl
bun run test:cloud    # the same build, published to the testing place and run there
bun run original      # remake original.rbxl, the stand-in for a game's own place file
bun run studio        # open the testing place from the cloud in Roblox Studio
bun run test:studio   # run the server's sections in whatever window has it open; add --realm client
bun run build         # rbxtsc only; bun run watch to keep compiling
```

`bun run test` opens each build in Roblox Studio, runs the server's sections and then the
client's in one play session, and closes the window again. It needs Roblox Studio with "MCP
server" enabled in its Assistant settings, [Rojo](https://rojo.space) 7.7 and
[Lune](https://lune-org.github.io/docs) on `PATH`. The root `bun run test` never runs this place.

`flamework-test` is not tied to this place: any roblox-ts game with `@flamework-experimental/testing`
installed runs its sections the same way. The CLI, the cloud setup and the troubleshooting table
are in [`packages/testing/README.md`](../../packages/testing/README.md) and
[`docs/testing/place.md`](../../docs/testing/place.md).

## What is in it

| Path | What it is |
|---|---|
| `src/{server,client,shared}/Tests` | The suite: `defineTests` sections, one provider per file, registered only under the `testing` scope. `shared/Tests/components.ts` (with its one server-only case in `server/Tests/components.ts`) and the `networking` files are the Lune `components` and `networking` suites run against the engine in both realms; the rest cover paths, modules, the duplicate provider id error, scopes, lifecycle, serialization, modding, DI, the Rojo projects, streaming and the assets patched in from the original place. |
| `src/{server,client,shared}/Features/Testing` | What the suite leans on: the test components (registered with `ComponentPlugin.fromPath`), the providers the DI and lifecycle cases inject, the payload types, and the older self-check battletest, which prints one `[FWTEST] <realm> <check>: PASS\|FAIL` line per check on start-up (see [`docs/testing/studio.md`](../../docs/testing/studio.md)). |
| `src/server/Core/main.ts` | Builds and ignites the server module and exports `ignite()`, which a cloud task calls through `testing.entry`; `runtime.server.ts` calls it in Studio. |
| `src/client/Core/runtime.client.ts` | Ignites the client module. |
| `src/*/Core/network.ts` | The `FwTest` events and functions the self-checks and the `client` section use. |
| `default.project.json`, `tests/*.project.json` | The Rojo projects, see below. |
| `flamework.config.json` | `networking.serialization` on, the `testing` scope from `FLAMEWORK_SCOPES`, `testing.entry`, and the `cloud` section. |
| `.env` | `FLAMEWORK_SCOPES=testing`, `ORIGINAL_PLACE=original.rbxl`, `ROJO_PROJECT` (the four projects). No secrets. The scope is in the committed `.env` because this place exists only to run the suite and is never shipped. A game does the opposite and keeps the scope out of `.env` and `.env.local`, which every build reads; see [guide 12](../../docs/guide/12-testing.md#setting-up). |
| `scripts/fabricate-original.luau` | Makes `original.rbxl` from a build: an `Assets` model, a `Sounds` folder, a marker in Workspace and a stale folder the patch has to replace, which is what the `assets` section checks. |

## One suite, four Rojo projects

Some of what the suite has to run under is not a script's to set: `Workspace.SignalBehavior`
decides whether a signal's handler runs inside the write or after the thread yields, and the
streaming radii decide what a client has at all. A place file takes them, so they come from a
Rojo project's `$properties`, and `ROJO_PROJECT` in `.env` lists the projects `bun run test` runs
the whole suite under, one run of both realms each, in a place of its own name
(`place.deferred.rbxl`), with a `projects: ...` line at the end and the worst exit code:

| Project | `Workspace` | Why |
|---|---|---|
| `default.project.json` | as shipped: `SignalBehavior = Default`, streaming off | The place as it is; `Default` is `Immediate` in this engine. |
| `tests/immediate.project.json` | `SignalBehavior = Immediate` | Pinned, so the run keeps meaning the same thing when Roblox changes what `Default` is. |
| `tests/deferred.project.json` | `SignalBehavior = Deferred` | Every signal delivered after the thread yields, which is what the Lune harness models: the `components` cases that depend on it run in the Lune order here. |
| `tests/streaming.project.json` | `StreamingEnabled`, `StreamingMinRadius = 64`, `StreamingTargetRadius = 256`, `ModelStreamingBehavior = Improved`, `StreamOutBehavior = Opportunistic` | The smallest radii that keep the spawn-side fixtures in reach; `Improved` keeps a far model off the client entirely, and `Opportunistic` streams it back out when the character leaves, so the client's `streaming` section can watch both. |

The three under `tests/` are `default.project.json` with `$path` rebased to that directory. Keep
their trees identical to the default's: the CLI takes the tree from the build and only applies a
chosen project's `$properties` (through Lune), so a tree change belongs in `default.project.json`
and then in each copy. In a test, `getProject()` from `@flamework-experimental/testing` is the
project's name; the `projects` section asserts that what each project sets is in effect, and the
`components` cases whose expectations depend on signal ordering branch on what they measure
(`src/shared/Tests/signalBehavior.ts`) rather than on the name.

The Rojo projects declare no `ReplicatedStorage.Assets` or `SoundService.Sounds`: those stand for
what only a game's own place file holds, and come from `original.rbxl`, laid over each build
before it runs (`ORIGINAL_PLACE`). That is what the `assets` section proves.

## In the cloud

`bun run test:cloud` publishes each build to the *testing place* as a Saved version and runs the
server's sections in a real server (a Luau execution task has no client, so the client's sections
and anything that needs `onRender` or `onPhysics` do not run there). The testing experience and
place ids are in `flamework.config.json`'s `cloud` section. The key is not: put it in a
gitignored `.env.local` next to `flamework.config.json`,

```ini
ROBLOX_API_KEY=...
```

with `universe-places:write` and `universe.place.luau-execution-session:read` and `:write` for the
testing experience; `TESTING_UNIVERSE_ID` and `TESTING_PLACE_ID` there override the config's ids.
The place must be closed in Studio while a version is published. The setup and every error are in
[`docs/testing/place.md`](../../docs/testing/place.md#in-the-cloud).

## How the packages reach the place

- **roblox-ts** compiles against the links in `node_modules/@flamework-experimental`, which
  `typeRoots` lists. Every package there has its own `node_modules` holding links to the same
  packages, and roblox-ts turns an imported file's real path back into a `node_modules` path
  through the first link TypeScript met; `paths` in `tsconfig.json` pins each import the place
  compiles to the place's own link, or the build fails with `Could not find Rojo data ...
  networking\node_modules\@flamework-experimental\core\...`.
- **Rojo** maps each package's `out` folder by name rather than `node_modules/@flamework-experimental`
  whole: a link is the package's whole directory, sources, CLI and its own `node_modules`
  included (TypeScript's JSON files would become ModuleScripts), where an installed package holds
  only `out`. The place gets exactly what a consumer's install gives it.
- The `@rbxts` modules the packages' Luau loads (`t`, `services`, `maid`, `signal`) are
  dependencies of the place too. The packages find them with `TS.getModule`, which falls back to
  `rbxts_include.node_modules.@rbxts`; an npm install hoists them there, the workspace's isolated
  linker does not. (`@rbxts/object-utils`, which core and networking also declare, is used by
  neither's shipped Luau, so the place leaves it out.)

After `bun install` or anything else that recreates `node_modules`, restart a running `rojo serve`:
Rojo stops watching a folder that was deleted and recreated.
