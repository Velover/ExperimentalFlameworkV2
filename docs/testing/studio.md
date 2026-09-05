# Testing v2 in Roblox Studio

The Lune suites (`bun run test`) prove the framework's logic, but they run against this repository's
own `node_modules` and a stub Roblox. Three classes of bug only show up in a real place:

- **Packaging**: the Luau that ships in the packages must reach its dependencies with
  `TS.getModule`, never through another package's `node_modules` folder (see below).
- **Engine behaviour**: deferred signals, replication, streaming, `PreRender` only firing once the
  viewport shows the client, `WaitForChild` yields stalling ignition.
- **Consumer experience**: does a real roblox-ts game compile, sync through Rojo and start.

This page describes the battletest that covers them. It was first run on 2026-09-05 against the
`CommisionTemplate` project and found three bugs the Lune suites could not (recorded at the end).

## What the battletest consists of

The template project (`E:/Projects/TS/Flamework/CommisionTemplate`) carries a set of **test
providers and components** under `src/{server,client,shared}/Features/Testing`. They run once on
start and print one line per check:

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
| `ui` | client | The React tree renders with the module supplied through `FlameworkModuleContext`. |
| `streaming` | client | Reports `StreamingEnabled`, how many `FwTestStreamPart` parts are visible and how many got components; asserts the expectation for the current mode (see the matrix). |

The server spawns the parts it needs under `Workspace.FwTestParts` at runtime; nothing is saved into
the place.

## Prerequisites

1. **Studio** with the place open (`Place1` in the runs so far) and *MCP server* enabled in its
   Assistant settings. The MCP proxy is `%LOCALAPPDATA%\Roblox\Versions\version-*\StudioMCP.exe`;
   the first proxy becomes a hub on a local port and every later proxy joins it, so any number of
   clients can talk to the same Studio.
2. **Rojo** serving the template (`rojo serve` in `CommisionTemplate`, default port 34872) and the
   Rojo plugin connected in that Studio window.
3. **The template built against the packages under test.** From this repository:

   ```console
   bun run build
   cd packages/core       && bun pm pack --destination ../../../CommisionTemplate/vendor/flamework-v2
   cd ../components       && bun pm pack --destination ../../../CommisionTemplate/vendor/flamework-v2
   cd ../networking       && bun pm pack --destination ../../../CommisionTemplate/vendor/flamework-v2
   cd ../transformer      && bun pm pack --destination ../../../CommisionTemplate/vendor/flamework-v2
   cd ../../../CommisionTemplate
   bun remove @flamework/core @flamework/components @flamework/networking rbxts-transformer-flamework
   bun add ./vendor/flamework-v2/flamework-core-2.0.0-alpha.0.tgz ./vendor/flamework-v2/flamework-components-2.0.0-alpha.0.tgz ./vendor/flamework-v2/flamework-networking-2.0.0-alpha.0.tgz
   bun add -d ./vendor/flamework-v2/rbxts-transformer-flamework-2.0.0-alpha.0.tgz
   bun run build
   ```

   Tarballs rather than `bun link`: symlinked packages drag this repository's `node_modules` layout
   into the template. The `remove`/`add` pair is only needed the first time. After **every later
   repack** run

   ```console
   bun update @flamework/core @flamework/components @flamework/networking rbxts-transformer-flamework
   ```

   which re-extracts the changed tarballs and refreshes their integrity in the lockfile. Skipping it
   leaves a plain `bun install` failing with `IntegrityCheckFailed`, and bun's cache (keyed by name
   and version) can otherwise hand back the previous contents. Then check one shipped file actually
   changed, for example
   `grep -c "HasTag(instance, tag)" node_modules/@flamework/components/out/components.luau`.

   **Reinstalling replaces `node_modules/@flamework`, and Rojo stops watching a folder that was
   deleted and recreated.** Restart `rojo serve` and reconnect the plugin after every reinstall, or
   copy the rebuilt `packages/*/out` over the installed `out` folders in place, which keeps the
   watch alive:

   ```console
   cp -r packages/components/out/. ../CommisionTemplate/node_modules/@flamework/components/out/
   ```

4. The template's `flamework.config.json` enables `networking.serialization`, so every `[FWTEST]`
   networking check runs over serialized payloads; flip it to `false` and rebuild to test the plain
   path. The runtime sections it declares reach the packages through `include/flamework/config.json`.
5. The place needs `ReplicatedStorage.Assets` and `SoundService.Sounds`; the template's
   `default.project.json` now creates both. Without them two shared modules `WaitForChild` forever
   at require time and ignition never finishes -- the symptom is an "Infinite yield possible"
   warning and no `[FWTEST]` lines at all.

## Running the generalized tests

`scripts/studio/run-studio-tests.mjs` drives Studio through the MCP proxy: it starts a play session,
waits for the providers, prints every `[FWTEST]` line, stops the session and exits non-zero on a
`FAIL` or a missing realm summary.

```console
node scripts/studio/run-studio-tests.mjs                          # current Workspace settings
node scripts/studio/run-studio-tests.mjs --streaming off          # flips StreamingEnabled, restores it after
node scripts/studio/run-studio-tests.mjs --streaming on --wait 40
node scripts/studio/run-studio-tests.mjs --studio "Dive In"       # another open Studio window
```

`scripts/studio/mcp.mjs` is the lower-level driver: `--studios`, `--tools`, `<tool> '<json>'`, and
`--luau <Edit|Client|Server> <file.luau>` to run a snippet in one data model (the Edit model is only
available while not playing; Client and Server only while playing). Use it to inspect the synced
tree or the console when a run does not behave.

If an MCP-aware client (Claude Code, VS Code) has the `Roblox_Studio` server configured for this
directory, the same tools are available directly; the scripts exist so the run does not depend on that.

## The matrix

Each cell is one `run-studio-tests.mjs` invocation. Everything in the first two rows is automated.

| Scenario | How | Expected |
|---|---|---|
| Streaming on (default radii) | `--streaming on` | `visibleTagged=1 components=1`; `streaming(on)` check passes because the far parts sit 6000 units out, beyond `StreamingTargetRadius` (1024 by default). |
| Streaming off | `--streaming off` | `visibleTagged=4 components=4`; `streaming(off)` check passes. |
| Streaming on, large radius | set `Workspace.StreamingTargetRadius` ≥ 8500 by hand, then `--streaming on` | `streaming(on)` **fails by design** (`visible=4`): the check encodes the default radius. Read the INFO line instead. |
| Server-only (Run mode) | Studio's *Run* button; the scripts cannot start it | Server lines only; client lines absent. Confirms nothing server-side depends on a client. |
| Team Test / multiple clients | Studio's *Team Test* with two clients | Both clients print their own summaries; the server's `Ping`/`Bump` handlers serve each. |
| Play Solo focus | run with the Studio window minimised | `onRender fires on the client` may take longer: `PreRender` only fires while Studio renders the client viewport, which is why that check waits up to 15 s. |

Add a row whenever a scenario needs a property changed by hand; keep the automated rows to what the
script can set and restore itself.

## Adding checks

Add `FwTest.check(name, condition, detail?)` calls to `FwTestService` (server) or
`FwTestController` (client), or new components under the `Testing/Components` folders (they are
registered by `ComponentPlugin.fromPath` in the two entry points). Keep names as
`group: what it proves`, and put anything that may legitimately differ between scenarios in an
`INFO` line rather than a check. Rebuild the template; Rojo syncs `out/` on its own.

## Reading a failure

- **No `[FWTEST]` lines at all**: ignition stalled. Look for "Infinite yield possible" (a module
  waits for something the place lacks) or a red error from `getClassesInPath` naming the module that
  failed to load.
- **Only server lines**: the client crashed or never started; the console shows the error.
- **A `components` check with a `log:` detail**: `FwTestPartComponent.log` lists every construction
  (`+Name`) and destruction (`-Name`), which is how the stale-tag bug below was diagnosed.
- **"is not a valid member of Folder ... core"**: a shipped package requires through another
  package's `node_modules`. `bun test tests/packaging` catches this without Studio; see below.

## What the first battletest found (2026-09-05)

All three were invisible to the Lune suites and are fixed, each with a test that fails without it.

1. **Shipped Luau required `@rbxts/t` through `@flamework/core/node_modules`** (networking's
   `errors.luau` and `createFunctionSender.luau`). With bun's isolated linker, roblox-ts first meets
   `t.d.ts` through core's declaration files and maps it back through the `@flamework/core` symlink.
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
   both CollectionService handlers check `HasTag` and `Parent` before acting. Reproduced in Lune with
   `__harness.deferTags`, which queues tag signals and delivers them in order.

Not bugs, but worth knowing: `PreRender` starts a few seconds after the LocalScripts in Play Solo,
so render checks need a longer window; and the template's shared modules yield at require time for
`Assets`/`Sounds`, which is why the Rojo project now creates those folders.
