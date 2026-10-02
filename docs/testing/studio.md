# Testing v2 in Roblox Studio

The Lune suites (`bun run test`) prove the framework's logic, but they run against this repository's
own `node_modules` and a stub Roblox. Three classes of bug only show up in a real place:

- **Packaging**: the Luau that ships in the packages must reach its dependencies with
  `TS.getModule`, never through another package's `node_modules` folder (see below).
- **Engine behaviour**: deferred signals, replication, streaming, `PreRender` only firing once the
  viewport shows the client, `WaitForChild` yields stalling ignition.
- **Consumer experience**: does a real roblox-ts game compile, sync through Rojo and start.

This page describes the battletest that covers them. It was first run on 2026-09-05 against the
game template this repository's test place was later cut from, and found three bugs the Lune
suites could not (recorded at the end).

## What the battletest consists of

The test place, [`tests/place`](../../tests/place/README.md), is a small roblox-ts game in this
repository whose `@flamework-experimental/*` packages are workspace links to `packages/*`. Besides
the in-place suite (see [Running the generalized tests](#running-the-generalized-tests)) it carries
a set of **test providers and components** under `src/{server,client,shared}/Features/Testing`.
They run once on start and print one line per check:

```
[FWTEST] <server|client> <group>: <name>: PASS|FAIL (detail)
[FWTEST] <server|client> <group>: <name>: INFO <detail>
[FWTEST] <server|client> SUMMARY: <n> passed, <m> failed
```

| Group | Realm | What it proves |
|---|---|---|
| `lifecycle` | both | `onInit` before `onStart`, dependency order, `onTick`/`onPhysics` fire, `onRender` fires on the client and is inert on the server, `module.listen` and its destructor. |
| `di` | both | Injecting `Module`, function providers resolving per request, `@Provider({ lazy: true })` constructed on first resolve and cached, `createClassInstance`. |
| `networking` | client | Event round-trip (`Ping`/`Pong`) and function round-trip (`Echo`) through the generated guards, plus `Bump` which asks the server to change an attribute. |
| `components` | both | Tagged part gets a component, defaults, attributes and `onAttributeChanged`, component DI, ticking through the parent `LifecyclePlugin`, `getComponent`/`getAllComponents`, clones, tag removal destroying exactly one component, replication to the client. |
| `streaming` | client | Reports `StreamingEnabled`, how many `FwTestStreamPart` parts are visible and how many got components; asserts the expectation for the current mode (see the matrix). |
| `links` | both | Server: what the real `InstanceHandle` does, a child and an attribute naming a component, writing an attribute back as a handle, and a linked component going away taking its owner with it. Client: a link attribute naming a part 6000 studs out, which is only built once that part streams in and survives it streaming back out. |

The server spawns the parts it needs under `Workspace.FwTestParts` at runtime; nothing is saved into
the place.

## Prerequisites

1. **Studio** with the place open (`Place1`, then `TestingExperience`, in the runs so far) and *MCP server* enabled in its
   Assistant settings. The MCP proxy is `%LOCALAPPDATA%\Roblox\Versions\version-*\StudioMCP.exe`;
   the first proxy becomes a hub on a local port and every later proxy joins it, so any number of
   clients can talk to the same Studio.
2. **Rojo** serving the place (`rojo serve` in `tests/place`, default port 34872) and the
   Rojo plugin connected in that Studio window.
3. **The place built against the packages under test.** Its `@flamework-experimental/*`
   dependencies are `workspace:*` links to `packages/*`, so what `bun run build` last wrote to a
   package's `out` is what the place compiles against and what Rojo syncs; nothing is packed or
   copied. From the repository root:

   ```console
   bun install                         # once: links the place into the workspace
   bun run build                       # the packages
   cd tests/place && bun run build     # the place (rbxtsc); `bun run watch` keeps it compiling
   ```

   Rojo reads each package's `out` folder through its link (the place's Rojo project maps them by
   name). After a `bun install` that recreates `node_modules`, restart `rojo serve` and reconnect
   the plugin: **Rojo stops watching a folder that was deleted and recreated.** `bun run test`
   builds with `rojo build` and needs no server. How the links are made to work with roblox-ts and
   Rojo (the `paths` pins, the per-package mapping, the packages' runtime dependencies) is in the
   place's [README](../../tests/place/README.md#how-the-packages-reach-the-place).

4. The place's `flamework.config.json` enables `networking.serialization`, so every `[FWTEST]`
   networking check runs over serialized payloads; flip it to `false` and rebuild to test the plain
   path. The runtime sections it declares reach the packages through `include/flamework/config.json`.
5. The `assets` section expects `ReplicatedStorage.Assets` and `SoundService.Sounds`, which the
   place's project file deliberately does not declare: they stand for assets that exist only in the
   original place, and come from `original.rbxl` laid over the build (`bun run original` makes
   one, `bun run test` makes it when it is missing; `ORIGINAL_PLACE` in `.env` names it). Nothing
   in the place waits for them any more (the game template it was cut from had two shared modules
   that did, and stalled ignition without them), so without them only the `assets` cases fail. A
   Rojo-served session needs them added by hand, or a patched place opened instead. A run writes
   one per project in `ROJO_PROJECT`, named after it (`place.default.rbxl`, `place.deferred.rbxl`,
   ...), and `flamework-test patch place.rbxl --project default.project.json` writes one without
   running anything; then `flamework-test studio open place.default.rbxl`. Only with `ROJO_PROJECT`
   empty is the patched file `place.patched.rbxl`.

## Running the generalized tests

For the in-place specs (`defineTests` sections) the CLI does this itself: `rojo build -o place.rbxl
&& flamework-test test place.rbxl` opens the build in Studio, runs both realms in a play session
and closes it again (`studio open` + `studio run [--realm client]` do the same by hand); see
[Running the tests](place.md). For this repository's place that is one command from the root,

```console
bun run test:place                                          # build the packages, then the place's `bun run test`
bun run test:place --project tests/deferred.project.json    # arguments go to flamework-test test, paths relative to tests/place
```

which builds the packages and runs the whole suite in Studio under each of the four Rojo projects in
the place's `ROJO_PROJECT` (default, immediate, deferred, streaming; see the place's
[README](../../tests/place/README.md#one-suite-four-rojo-projects)). The root `bun run test` leaves
it out, since it needs Studio. What follows is the older battletest of `[FWTEST]` lines the place's
providers print on start, which the same proxy drives.

`scripts/studio/run-studio-tests.mjs` drives Studio through the MCP proxy: it starts a play session,
waits for the providers, prints every `[FWTEST]` line, stops the session and exits non-zero on a
`FAIL` or a missing realm summary.

```console
node scripts/studio/run-studio-tests.mjs                          # current Workspace settings
node scripts/studio/run-studio-tests.mjs --streaming off          # flips StreamingEnabled, restores it after
node scripts/studio/run-studio-tests.mjs --streaming on --wait 40
node scripts/studio/run-studio-tests.mjs --studio "Other Place"   # another open Studio window
```

`scripts/studio/mcp.mjs` is the lower-level driver: `--studios`, `--tools`, `<tool> '<json>'`, and
`--luau <Edit|Client|Server> <file.luau>` to run a snippet in one data model (the Edit model is only
available while not playing; Client and Server only while playing). Use it to inspect the synced
tree or the console when a run does not behave.

If an MCP-aware client (Claude Code, VS Code) has the `Roblox_Studio` server configured for this
directory, the same tools are available directly; the scripts exist so the run does not depend on that.

## Testing one hypothesis directly

The battletest above answers "does the framework still work". The other question a real place
answers is "what does the engine actually do here", which comes up constantly while finishing v2:
the Lune stub delivers signals immediately, has no replication and no streaming, so a guess about
ordering is only settled in game. `scripts/studio/luau-tests.mjs` is the runner for that. It takes
Luau snippets, sends them to Studio through the same MCP proxy one at a time, and prints PASS/FAIL
per snippet.

```console
node scripts/studio/luau-tests.mjs --code "return workspace.StreamingEnabled"
node scripts/studio/luau-tests.mjs scripts/studio/cases/deferred-signals.luau
node scripts/studio/luau-tests.mjs scripts/studio/cases --studio TestingExperience
node scripts/studio/luau-tests.mjs scripts/studio/cases --list
```

A case is a `.luau` file (with `-- @mode`, `-- @timeout`, `-- @skip`, `-- @sweep false` headers), a
folder of them, or a `.mjs` exporting an array of `{ name, mode, code | file, timeout, skip, sweep }`
-- useful when one hypothesis should run over several inputs. `--studio` takes a name or an id from
`mcp.mjs --studios`; with exactly one Studio connected it can be left out.

### Realms

| `--mode` | Session | Snippet runs in | What it proves |
|---|---|---|---|
| `console`, `edit` | none | Edit data model | Pure Luau and anything about the edit data model. No engine loop, no `Players`. |
| `server` | Studio's **Run** | Edit data model | Server behaviour with **no client and no player** at all. |
| `client` | Play Solo | Client data model | What a client sees, with a server behind it. |
| `play-server`, `play` | Play Solo | Server data model | Server behaviour with a client connected. |
| `both` | Play Solo | Server, then Client | The same snippet in both realms, reported as two results. |

**Server-only is startable from code.** `start_stop_play` only offers Play Solo, but the MCP's
execution context may call `RunService:Run()`, which is Studio's *Run* button: server scripts start,
`Players` stays empty and `LocalPlayer` is `nil`. Two things about it are worth knowing:

- Run mode uses the **edit data model**, so what a snippet builds during it is still in the place
  after the session stops -- verified by hand, a part made during Run survived the stop. That is why
  the runner sweeps (below).
- `RunService:IsClient()` is **`true`** in Run mode even though no client exists, while in Play Solo
  the two data models report `IsServer`/`IsClient` the way a live game does. Realm detection that
  branches on `IsClient()` alone will take the client path under Run.

There is no client-only session: the closest is Play Solo with `--mode client`.

### Inside a snippet

`check(name, condition, detail?)` records a check and any failing one fails the case; `log(...)`
records a line; `defer(fn)` runs after the body, in reverse order, even when the body errored; and
`scratch()` is a Folder created in Workspace on first use and destroyed afterwards. Whatever the
snippet returns is reported as the case's value, and anything game scripts printed during it is
captured alongside. Yielding is expected -- `task.wait`, signals, `WaitForChild` all work, and the
MCP call only returns once the snippet has stopped yielding, which is what keeps the cases from
overlapping.

Studio runs every snippet sandboxed (since 2026-10-01), without the LoadUnownedAsset, ScriptGlobals,
DataStore and Network capabilities. In a snippet `_G` and `shared` are nil, `require` of one of the
place's ModuleScripts fails, and `DataStoreService` is not there; the place's own scripts are not
affected. A snippet may only invoke or fire a bindable that is Sandboxed itself and has no
capability the snippet lacks, which is why the test host's `Workspace.FlameworkTests` is (see
[Running the tests](place.md#in-studio-on-this-machine)). `RunService:Run()` and a client snippet's
`RemoteFunction:InvokeServer` still work. The runner's prelude and the cases here use none of what
is gone (all of them ran sandboxed on 2026-10-02).

```lua
-- @mode server
-- @timeout 20
local CollectionService = game:GetService("CollectionService")
local seen = {}
local connection = CollectionService:GetInstanceAddedSignal("Probe"):Connect(function(instance)
	table.insert(seen, instance.Name)
end)
defer(function() connection:Disconnect() end)

local part = Instance.new("Part")
part.Parent = scratch()
CollectionService:AddTag(part, "Probe")
check("the added signal is deferred", #seen == 0)
task.wait(0.2)
check("and arrives on the next resumption", #seen == 1, table.concat(seen, " "))
```

### Cleanup and timeouts

Cleanup is not left to the case. Around every snippet the runner notes each direct child of the
usual service containers and every `CollectionService` tag, then afterwards destroys the instances
and removes the tags that appeared, reporting them as `swept`. An error thrown inside a `defer`
fails the case, because the next case would be running against whatever was left. `--keep-leftovers`
reports instead of destroying, and `sweep: false` on one case hands its state to the next -- only
worth doing inside a Play session, which is discarded wholesale anyway.

Each case has a timeout (`--timeout`, `timeout:`, `-- @timeout`; 30s by default). The snippet
watchdogs itself, so a case that exceeds it is cancelled, its cleanup still runs, and the **run is
aborted**: a snippet that hung has likely left the data model in a state the later cases would only
report noise about. Remaining cases are printed as `ABORT` and the exit code is non-zero.

Sessions are started once per group rather than once per case -- all `console` cases first, then the
Run-mode ones, then one Play session for the rest -- and whatever was started is stopped at the end
unless `--keep-open` is passed.

## The matrix

Each cell is one `run-studio-tests.mjs` invocation. Everything in the first two rows is automated.

| Scenario | How | Expected |
|---|---|---|
| Streaming on (default radii) | `--streaming on` | `visibleTagged=1 components=1`; `streaming(on)` check passes because the far parts sit 6000 units out, beyond `StreamingTargetRadius` (1024 by default). |
| Streaming off | `--streaming off` | `visibleTagged=4 components=4`; `streaming(off)` check passes. |
| Streaming on, large radius | set `Workspace.StreamingTargetRadius` ≥ 8500 by hand, then `--streaming on` | `streaming(on)` **fails by design** (`visible=4`): the check encodes the default radius. Read the INFO line instead. |
| Streaming on, small radius | set `StreamingMinRadius`/`StreamingTargetRadius` to 64/128 by hand, then `--streaming on` | Unchanged: every part the checks rely on sits either right by the spawn or 6000 studs out, so no check depends on the radius. Tightening it only makes instances stream out sooner. |
| Server-only (Run mode) | Studio's *Run* button, or `RunService:Run()` from a snippet (see above) | Server lines only; client lines absent. Confirms nothing server-side depends on a client. |
| Team Test / multiple clients | Studio's *Team Test* with two clients | Both clients print their own summaries; the server's `Ping`/`Bump` handlers serve each. |
| Play Solo focus | run with the Studio window minimised | `onRender fires on the client` may take longer: `PreRender` only fires while Studio renders the client viewport, which is why that check waits up to 15 s. |

Add a row whenever a scenario needs a property changed by hand; keep the automated rows to what the
script can set and restore itself.

**The streaming radii cannot be scripted.** `StreamingMinRadius` and `StreamingTargetRadius` are not
scriptable members, so reading or writing them from a snippet raises `is not a valid member of
Workspace`, and Rojo does not apply them from `$properties` either. They can only be set in Studio's
Properties panel. That is why the parts the streaming checks rely on sit 6000 studs out rather than
just beyond a narrowed radius: it makes the automated rows independent of what the place is set to.

## Adding checks

Add `FwTest.check(name, condition, detail?)` calls to `FwTestService` (server) or
`FwTestController` (client), or new components under the `Testing/Components` folders (they are
registered by `ComponentPlugin.fromPath` in the two entry points). Keep names as
`group: what it proves`, and put anything that may legitimately differ between scenarios in an
`INFO` line rather than a check. Rebuild the place (`bun run build` in `tests/place`, or keep
`bun run watch` running); Rojo syncs `out/` on its own.

## Reading a failure

- **No `[FWTEST]` lines at all**: ignition stalled. Look for `is still waiting for its folder` (a
  registration names a folder the place lacks), "Infinite yield possible" (a module waits for
  something the place lacks) or a red error from `getClassesInPath` naming the module that failed
  to load.
- **Only server lines**: the client crashed or never started; the console shows the error.
- **A `components` check with a `log:` detail**: `FwTestPartComponent.log` lists every construction
  (`+Name`) and destruction (`-Name`), which is how the stale-tag bug below was diagnosed.
- **"is not a valid member of Folder ... core"**: a shipped package requires through another
  package's `node_modules`. `bun test tests/packaging` catches this without Studio; see below.

## What the first battletest found (2026-09-05)

All three were invisible to the Lune suites and are fixed, each with a test that fails without it.

1. **Shipped Luau required `@rbxts/t` through `@flamework-experimental/core/node_modules`** (networking's
   `errors.luau` and `createFunctionSender.luau`). With bun's isolated linker, roblox-ts first meets
   `t.d.ts` through core's declaration files and maps it back through the `@flamework-experimental/core` symlink.
   Fix: `components`, `networking` and `testing` pin `@rbxts/t` to their own copy with a `paths`
   entry in `tsconfig.json`; `tests/packaging/packaging.test.ts` greps every shipped file for
   `.node_modules` in an import. A hoisted layout is not an alternative: roblox-ts refuses imports
   outside the project's own `node_modules`.
2. **The transformer skipped the TypeScript hook when `cwd/node_modules` was missing**, which is
   normal for a package inside a workspace, and then failed with "TS version mismatch". Fix in
   `transformer/src/index.ts`: only `tsconfig.json` and `package.json` are required.
3. **A stale deferred `InstanceAdded` rebuilt a component whose tag was already gone** (three
   constructions and two destructions for one part when `waitForComponent` built it eagerly and the
   tag was removed in the same frame). v1 has the same code. Fix in `Components.startCollectionService`:
   both CollectionService handlers check `HasTag` and DataModel membership before acting -- membership
   rather than `Parent`, because a descendant of a tree that has been unparented still has one.
   Reproduced in Lune with `__harness.deferTags`, which queues tag signals and delivers them in order.

Not bugs, but worth knowing: `PreRender` starts a few seconds after the LocalScripts in Play Solo,
so render checks need a longer window; and the game template the place was cut from had shared
modules that yielded at require time for `Assets`/`Sounds`, which stalled ignition in a place without
them. The place carries none of them now, and the two folders come from the original place (see
Prerequisites).
