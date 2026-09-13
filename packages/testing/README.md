# @flamework-experimental/testing

Tests that run inside a real place, and the CLI that runs them. Two halves in one package:

- **The roblox-ts side** (`out/`): `defineTests`, `test`, `defer`, `scratch`, the `expect*`
  assertions, and `TestingPlugin`, which hosts the sections on `Workspace.FlameworkTests` (a
  BindableFunction) and `Workspace.FlameworkTestsServer` (a RemoteFunction) under the `testing`
  scope. How to write the tests is in the guide's [Testing in the place](../../docs/guide/12-testing.md).
- **`flamework-test`** (`cli/`, the package's `bin`): runs those sections where the engine is
  real, from a terminal or CI. First and by default in Roblox Studio on this machine: it opens the
  place Rojo built, runs the tests in a play session on the server and the client, reports, and
  closes it again; no account, no upload, no key. Second, when asked, in the cloud: it publishes
  the build to a *testing place* and runs the server's tests inside a real Roblox server through
  the Open Cloud Luau Execution API. A copy of the original place can be patched with the build
  first either way, so the tests see the assets that exist only in the original.

```console
bun add @flamework-experimental/testing
rojo build -o place.rbxl && bunx flamework-test test place.rbxl
```

Building is Rojo's job, so the CLI takes the file Rojo produced and does not wrap `rojo build`.
(Rojo does not create a missing output directory, hence a file in the project root; add
`*.rbxl` to `.gitignore`.) The rest of this file is the CLI.

## `test`: Studio on this machine

```console
bunx flamework-test test place.rbxl                       # both realms
bunx flamework-test test place.rbxl --realm client        # one of them
bunx flamework-test test place.rbxl --sections economy    # a section, or economy/buys
bunx flamework-test test place.rbxl --keep                # leave Studio and the play session open
```

It needs Roblox Studio installed with "MCP server" enabled in its Assistant settings, which is
what lets the CLI drive a window. `test` launches Studio on the file, waits for the window to
connect, starts a play session, invokes `Workspace.FlameworkTests` in the server's data model and
then the client's, prints each realm's summary, stops the session and closes the window. Every
realm runs even when one fails; the exit code is the worst of them. A window that already has a
file of the same name open is from an earlier build and would test stale code, so it is closed
first.

| Command | Does |
|---|---|
| `test <file> [--realm server\|client\|both] [--sections a,b] [--list] [--json] [--keep] [--original <rbxl>]` | The above. |
| `test <file> --project <a.project.json> [--project <b.project.json>]` | The above once per project, each in a place made under that project's `$properties`; see [Running under several Rojo projects](#running-under-several-rojo-projects). |
| `test <file> --cloud` | The cloud run instead, see below. |
| `patch <file> --original <rbxl> [--out <path>]` | Lays the build over a copy of the original and writes the result, without running anything. |
| `patch <file> --project <file> [--out <path>]` | Sets the project's `$properties` on the build and writes that, `place.<project>.rbxl`; with an original, patches a copy of it under that project. |

## Studio commands

The pieces `test` is made of, for driving a window by hand. They act on the window that has the
*testing place* open (found by its place id); with none, the only window with a local place file
open; or whatever `--studio <name|id>` names. When nothing matches they say so and list what is
open.

| Command | Does |
|---|---|
| `studio open [file]` | Opens the testing place from the cloud in a new Studio window and waits for it to connect; with a file, opens that local place instead. |
| `studio close` | Closes that window. |
| `studio status` | Edit or play, and which data models exist. |
| `studio play` / `studio stop` | Starts or ends a play session. |
| `studio exec --code "<luau>"` / `--script <file>` `[--realm edit\|server\|client]` | Runs Luau in the chosen data model and prints what it returned. |
| `studio run [--realm server\|client\|both] [--sections a,b] [--list] [--json] [--keep]` | Runs the tests in a play session, starting one if needed and stopping it afterwards unless `--keep`, without opening or closing anything. |

```console
bunx flamework-test studio open                     # the testing place, from the cloud
bunx flamework-test studio run --realm client       # the client's sections in it
bunx flamework-test studio close
```

## Cloud commands

Needs a testing experience and an Open Cloud key (see Settings). The server's sections only: a
Luau execution task has no client.

| Command | Does |
|---|---|
| `cloud publish <file> [--published] [--original <rbxl>]` | Uploads the place Rojo built (patched first when an original is named) to the testing place as a Saved version, and records the version number in `build/version.json`. |
| `cloud run [--version N] [--sections a,b] [--list] [--timeout 120s] [--json]` | Submits the test shim against the recorded version, waits, prints the task's log and a summary, exits non-zero on any failure. |
| `cloud run --code "<luau>"` / `--script <file>` | Runs arbitrary Luau instead of the shim and prints what it returned: a hypothesis about a real server, answered in a minute. |
| `cloud test <file>` | `cloud publish` the file, then `cloud run`. The same as `test <file> --cloud`. |
| `cloud probe` | Reports what the task environment looks like from the inside. |

`--dry-run` prints the request a command would send, key never included. Flags may come before
or after the command.

**Why the cloud needs `testing.entry` and Studio does not.** A Luau execution task loads the place
but runs none of its Scripts, so nothing ignites the game: the shim has to require the
ModuleScript that exports `ignite()` and call it, and `"testing": { "entry": "src/server/main" }`
in `flamework.config.json` is how it knows which one. In Studio the place's own Scripts run and
the module is up before the tests are invoked. A cloud command checks for the entry before it
publishes anything. See [Running the tests](../../docs/testing/place.md) for the setup.

The place must be closed in Studio while `cloud publish` runs: Roblox refuses to save a version of
a place that is open (`409 Server is busy`).

## Settings

Flags first, then the shell environment, then `.env` and `.env.local` next to the nearest
`flamework.config.json`, then that file's `cloud` section, read the way the transformer reads it
(so it may use `${NAME}` itself). Everything is named *testing* so nothing confuses it with the
original place. A Studio run needs none of this beyond, optionally, the original place.

```jsonc
"cloud": {
  "testingUniverseId": "10765968722",
  "testingPlaceId": "108973151455286",
  "apiKey": "${ROBLOX_API_KEY:-}",
  "originalPlace": "places/original.rbxl"   // optional, see Patching
},
"testing": { "entry": "src/server/main" }    // cloud runs only
```

```ini
# .env.local (gitignored)
ROBLOX_API_KEY=...
```

The key needs `universe-places:write` and `universe.place.luau-execution-session:read` and
`:write` for the testing experience. The `cloud` section is read by this CLI only and is never
compiled into the place. `--testing-universe`, `--testing-place`, `--key`, `--original` and the
variables `TESTING_UNIVERSE_ID`, `TESTING_PLACE_ID`, `ROBLOX_API_KEY` and `ORIGINAL_PLACE`
override it; prefer the environment for the key, a flag lands in the shell history. The projects
a run follows are `--project` or `ROJO_PROJECT`, see [Running under several Rojo
projects](#running-under-several-rojo-projects).

## Patching a copy of the original place

A game's assets often live only in the place itself, and a Rojo build has none of them. Save a
copy of the original from Studio (File > Save to File) and name it with `--original`,
`ORIGINAL_PLACE` or `cloud.originalPlace`; `test` and `cloud publish` then lay the build over a
copy of it and run or upload that. `patch` does the same without running anything.

What the patch does is read from the Rojo project file (`--project`, default
`default.project.json`), so it changes exactly what a build would:

| In the project file | In the patched place |
|---|---|
| A node with `$path` | The build's instance replaces the original's, whatever was under it. That is the fresh code. |
| A node with only `$className` | The original's instance is kept, with everything it holds. When the original has none, the build's is taken. |
| `$properties` | Applied, typed from the reflection database: booleans, numbers, strings, enums, `Vector3`, `Vector2`, `Color3`. |
| Everything else in the original | Untouched. |

The patch prints one line per change it made and anything it skipped, and stamps the place with
the name of the project it followed (`Workspace`'s `FlameworkTestProject` attribute, `default` for
`default.project.json`). It runs under [Lune](https://lune-org.github.io/docs), which reads and
writes place files; without `lune` on the path (or `LUNE_EXE`) a command given an original stops
before running or uploading anything.

## Running under several Rojo projects

A place file takes any property, including the ones no script may set once the game runs. So a
project's `$properties` on `Workspace` are how a test run gets a `SignalBehavior` or a streaming
setup: the patch writes them into the place before Studio opens it, and the play session honours
them. Verified on 2026-09-13 with Lune 0.10.5 and Rojo 7.7.0:

| `Workspace` property | Values | Set by the patch | In the play session |
|---|---|---|---|
| `SignalBehavior` | `Default`, `Immediate`, `Deferred`, `AncestryDeferred` | yes | `Deferred` measured: no signal fires inside the write, all after `task.wait()`; `Default` in a fresh place behaves as `Immediate` |
| `StreamingEnabled` | boolean | yes | readable, and far content stays off the client |
| `StreamingTargetRadius` | studs | yes | 256 measured: a part 600 studs out never reaches the client, which the default 1024 would send |
| `ModelStreamingBehavior` | `Legacy`, `Default`, `Improved` | yes | `Improved` measured: a far Model is absent on the client entirely, where `Default` sends the empty container |
| `StreamingMinRadius` | studs | yes | written to the file; not readable and not told apart from the target radius in a small place |
| `StreamingIntegrityMode` | `Default`, `MinimumRadiusPause`, `PauseOutsideLoadedArea`, `Disabled` | yes | written to the file; `PauseOutsideLoadedArea` did not pause a teleported character in the time it took the far area to stream in |

Only `StreamingEnabled` can be read back from a script; the other five are `NotScriptable` and
show only in what the engine does. Any other property the reflection database knows takes the
same route: `Workspace.Gravity`, `PhysicsSteppingMethod`, `Lighting`'s, `SoundService`'s.

To test under one of these, write a project file that differs from `default.project.json` in its
`$properties` and name it on the run. `tests/deferred.project.json`:

```jsonc
{
  "name": "flamework-game",
  "tree": {
    // the same tree as default.project.json, with:
    "Workspace": { "$className": "Workspace", "$properties": { "SignalBehavior": "Deferred" } }
  }
}
```

```console
bunx flamework-test test place.rbxl --project tests/deferred.project.json
bunx flamework-test test place.rbxl --project tests/deferred.project.json --project tests/streaming.project.json
```

Each project is one run of every realm in a place of its own name, `place.deferred.rbxl`, under a
heading, every one of them even after one fails, with `projects: deferred passed, streaming FAILED`
at the end and the worst exit code. `--project` may be repeated or comma-separated;
`ROJO_PROJECT=tests/deferred.project.json,tests/streaming.project.json` in `.env` is the same
without the flags, and `ROJO_PROJECT=` turns it off again. With no project named, the run is the
plain one: the build as it is, or laid over the original when one is named, following
`default.project.json`. A chosen project needs `lune` even without an original, since the build
was made by `rojo build` from `default.project.json` and its properties have to be set on a copy.
`--timeout`, the hang report and every other flag apply to each project's run.

The tree still comes from the build: a project chosen for a run changes what the place's services
and containers are *set to*, not what Rojo synced into it. To test a different tree, build with
that project (`rojo build tests/big.project.json -o big.rbxl`) and run that file.

Inside the place, `getProject()` from `@flamework-experimental/testing` is the name of the project
the place was made under (`deferred`), `undefined` in a place the CLI did not make, so a test can
assert what that project changes or return early under the others; the run result carries it as
`project` and the summary line prints it. The `patch` command makes the same place without running
it, for a look in Studio: `flamework-test patch place.rbxl --project tests/deferred.project.json`.

## What runs in the cloud

A task loads the place but runs none of its Scripts, so the shim requires the testing package's
own cloud module, which ignites the game from the ModuleScript `testing.entry` names in the
config, waits for `Workspace.FlameworkTests`, invokes it and returns the result as JSON. See
[Running the tests](../../docs/testing/place.md) for the setup on the game's side, the
limits, and what each error means.

## Limits

Five task creations a minute per key owner, 45 task and log reads a minute, ten concurrent
tasks per place, 300 seconds per task. One task per run.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `RobloxStudioBeta.exe was not found` / `StudioMCP.exe was not found` | Studio is not installed here; set `ROBLOX_STUDIO_EXE` / `STUDIO_MCP_EXE`, or run in the cloud with `--cloud`. |
| `... never showed up on the MCP proxy` | The window opened but "MCP server" is disabled in Studio's Assistant settings. |
| `Workspace.FlameworkTests did not appear within 30 seconds` | The place was built without the `testing` scope active (`FLAMEWORK_SCOPES` in `.env`), so the plugin stayed inert. |
| `the client's run did not finish within 120s (--timeout)` | A test is stuck past `testing.timeout`, or the host never started; the next line names the last test that reported, and the one after it in that section is the hanging one. |
| `no Studio window has the testing place ... open` | Nothing has it open, or the window has "MCP server" disabled and so is not listed. |
| `a cloud run needs "testing": { "entry": ... }` | The cloud needs the ModuleScript that ignites the game; Studio does not. |
| `403 PERMISSION_DENIED` naming a scope | The key lacks that scope for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio; `studio close` it and publish again. |
| `429` | The creation limit. |
| Task `FAILED`: `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| `lune is needed to patch the original place` / `to set the properties of the project ...` | Install Lune (rokit or aftman) or set `LUNE_EXE`. Nothing was run or uploaded. |
| `the Rojo project ... does not exist` | A `--project` or `ROJO_PROJECT` entry names no file; every project is checked before the first run. |
| `two projects are both named ...` | Runs, files and the place's attribute are named after the project file, so `tests/a.project.json` and `other/a.project.json` cannot both be in one run. |
| `skipped Workspace.X (not a property the reflection database knows)` | The name is not a property of that class in Lune's reflection database; check the spelling against the Studio Properties window. |

## Development

`bun test cli/tests` runs the CLI suite with a mocked `fetch`, a fake Studio proxy and fake processes;
nothing reaches the network, Studio or Lune. `bun run typecheck` runs `tsc -p cli --noEmit`; `bun run build` is
the roblox-ts side. The CLI runs under Bun. The Luau it submits or runs lives in `cli/tasks/*.lune`, imported
as text: a game's Rojo project syncs `node_modules/@flamework-experimental` into the place, and Rojo would
make ModuleScripts of `.luau` files.
