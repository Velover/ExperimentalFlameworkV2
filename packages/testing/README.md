# @flamework-experimental/testing

Tests that run inside a real place, and the CLI that runs them. Two halves in one package:

- **The roblox-ts side** (`out/`): `defineTests`, `test`, `defer`, `scratch`, the `expect*`
  assertions, and `TestingPlugin`, which hosts the sections on `Workspace.FlameworkTests` (a
  BindableFunction) and `Workspace.FlameworkTestsServer` (a RemoteFunction) under the `testing`
  scope. How to write the tests is in the guide's
  [Testing in the place](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/guide/12-testing.md).
- **`flamework-test`** (`cli/`, the package's `bin`): runs those sections where the engine is
  real, from a terminal or CI. It runs them in one of two places:
  - **Roblox Studio on this machine**, the default. It opens the place Rojo built, runs the tests
    in a play session on the server and the client, reports, and closes the place again. No
    account, upload or key is needed.
  - **The cloud**, when asked. It publishes the build to a *testing place*, and runs the server's
    tests inside a real Roblox server through the Open Cloud Luau Execution API.

  Either way, a copy of the original place can be patched with the build first, so the tests see
  the assets that exist only in the original.

```console
bun add @flamework-experimental/testing
bun run test        # guide 12's test script: compile with the scope, rojo build, flamework-test test
```

The place has to be compiled with the `testing` scope, or it has no test host, so the quick start is
the
[test script](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/guide/12-testing.md#setting-up)
from guide 12, as a package script. It compiles with `FLAMEWORK_SCOPES` set to `testing` in its own
environment, builds the place, runs `flamework-test test test.rbxl`, and compiles again with the
variable set to nothing. Never put the scope in `.env` or `.env.local`: every build on the machine
reads them, the ones you ship included.

**The CLI needs [Bun](https://bun.sh)**, whatever installed the package: its `bin` is TypeScript that
Bun runs as it is. `npm install` and `pnpm add` work too, and their `flamework-test` command starts
`bun`, so `npx flamework-test` works once Bun is on the `PATH`, and says `'"bun"' is not recognized`
otherwise. A Node build of the CLI would need a bundling step and a second runtime to test it under,
for a tool that already needs Studio, Rojo and, for patching, Lune.

Building is Rojo's job, so the CLI takes the file Rojo produced and does not wrap `rojo build`. Rojo
does not create a missing output directory, which is why the file goes in the project root.

What a run leaves in the project, all of it for `.gitignore`:
- the places the CLI makes beside the build (`place.patched.rbxl` with an original place,
  `place.<project>.rbxl` under `--project`), which `/*.rbxl` covers with the build itself;
- `build/version.json`, which `cloud publish` writes, and so `cloud test` and `test --cloud`;
- Studio's `place.rbxl.lock` beside a place it has open. The CLI removes the lock of a window it
  ends, but one left by a Studio closed any other way stays, so ignore `*.rbxl.lock` too.

The patch's own files (its plan and its Lune task) go to a folder of the system's temp directory,
one per run, removed when the patch is done. The rest of this file covers the CLI.

## `test`: Studio on this machine

```console
bunx flamework-test test place.rbxl                       # both realms
bunx flamework-test test place.rbxl --realm client        # one of them
bunx flamework-test test place.rbxl --sections economy    # a section, or economy/buys
bunx flamework-test test place.rbxl --keep                # leave Studio and the play session open
```

It needs Roblox Studio installed, with "MCP server" enabled in its Assistant settings. That setting
is what lets the CLI drive a window. `test` then:

1. launches Studio on the file and waits for the window to connect;
2. starts a play session;
3. invokes `Workspace.FlameworkTests` in the server's data model, then in the client's;
4. prints each realm's summary;
5. stops the session and closes the window.

Every realm runs even when one fails: when its tests fail, when it does not answer within
`--timeout`, and when the call itself fails, such as when the place has no test host. That last
error is printed as the snippet raised it (`the server's run failed: Workspace.FlameworkTests did
not appear within 30 seconds: ...`), without the Studio Assistant's own locations in front of it.
The exit code is the worst of them.

Studio runs the Luau its MCP server executes in a sandboxed thread, and a sandboxed thread may only
invoke a bindable that is Sandboxed itself and has no capability the thread lacks. So the host
makes `Workspace.FlameworkTests` Sandboxed, with no capabilities. That decides only who may call
it: the callback runs with the capabilities of the script that set it, so the tests keep
`require`, `_G` and everything else. A place built with 2.0.0-alpha.5 or earlier has a bindable
that is not Sandboxed; the CLI marks it before the invoke for as long as Studio lets sandboxed code
do that, and once Studio refuses, the place has to be rebuilt (see Troubleshooting).

`--sections` is judged across the realms that run: an entry only the server has is listed for the
client as `not among the client's sections: coin`, which does not fail it, and the run fails only on
an entry no realm has (`MISS matched nothing in any realm: coins`). With `--realm`, the one realm
judges alone.

How `test` handles Studio windows:

- A window whose title shows that very file is from an earlier build and would test stale code, so
  it is closed first: asked, then ended after ten seconds. The title alone decides. A window since
  saved elsewhere or retitled is left open, like every window of another file, whatever its name.
- The window `test` opens is closed by ending the Studio process that `test` started, without
  asking first. Asking never closes it: Studio marks a place file it opens as changed the moment it
  has loaded it, before any play session or Luau, so the ask only raises its "Save changes to
  place.rbxl?" prompt, and nothing a run makes is kept. It is only reported closed once that process
  is gone. A process still running fails the run, named by its PID and title.
- A window the run gives up on (one that never connected, say) is closed too, unless `--keep`.
- Runs of same-named files started at the same time take turns to open their windows, because the
  proxy lists a window by its file name alone. A run that finds another window of a file with that
  name opening alongside its own cannot tell the two apart, so it refuses and closes its own.
- Ctrl+C stops the run and cleans up what it started, through the steps a finished run takes: it
  stops the play session it started (one Studio is still starting is stopped once the start has
  finished) and closes the window it opened (by its process; `--keep` keeps both), releases its
  window-name claim, removes the patch's temp folder and stops lune and the MCP proxy. It runs
  nothing more (not the other realm, not the next project) and ends on one line naming what it
  cleaned up and what it left; the CLI's own process exits 130. A second Ctrl+C exits at once,
  however soon it comes, naming what may be left. Through the `flamework-test` bin (and so
  through a package script) the shell gets its prompt back at once, with the bin's own Ctrl+C
  status rather than 130, and the cleanup's lines follow a few seconds later; to wait for them, run
  `bun node_modules/@flamework-experimental/testing/cli/src/cli.ts ...` yourself (not from a
  package script). See [Ctrl+C](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md#ctrlc).

| Command | Does |
|---|---|
| `test <file> [--realm server\|client\|both] [--sections a,b] [--list] [--json] [--keep] [--original <rbxl>]` | The above. |
| `test <file> --project <a.project.json> [--project <b.project.json>]` | The above once per project, each in a place made under that project's `$properties`; see [Running under several Rojo projects](#running-under-several-rojo-projects). |
| `test <file> --cloud` | The cloud run instead, see below. |
| `patch <file> --original <rbxl> [--out <path>]` | Lays the build over a copy of the original and writes the result, without running anything. |
| `patch <file> --project <file> [--out <path>]` | Sets the project's `$properties` on the build and writes that, `place.<project>.rbxl`; with an original, patches a copy of it under that project. |

## Studio commands

These are the pieces `test` is made of, for driving a window by hand. They act on:

- the window that has the *testing place* open (found by its place id);
- if there is none, the only window with a local place file open;
- or whatever `--studio <name|id>` names.

Only the first needs the testing place's ids, so a window found either other way is driven without
them. When nothing matches, they say so and list what is open. On Ctrl+C, `studio run` stops the
session it started, `studio open` stops waiting and leaves the window, and `studio exec`'s Luau runs
on in Studio.

| Command | Does |
|---|---|
| `studio open [file]` | Opens the testing place from the cloud in a new Studio window and waits for it to connect; with a file, opens that local place instead. |
| `studio close` | Closes that window, found by its title, and checks it is gone. When several windows have that title, none is closed. A window still running after the forced close is reported with its PID, and the command fails. |
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

These need a testing experience and an Open Cloud key (see [Settings](#settings)). They run the
server's sections only, because a Luau execution task has no client. The Luau that `cloud run`
submits to run the tests is called the *shim*. Ctrl+C cannot undo what reached Roblox: an upload it
cuts short may still make a version (and `build/version.json` is not written), and a task already
created runs on until it finishes or its timeout, since the Luau Execution API cannot cancel one;
the run's last line names the task's path.

| Command | Does |
|---|---|
| `cloud publish <file> [--published] [--original <rbxl>]` | Uploads the place Rojo built (patched first when an original is named) to the testing place as a Saved version, and records the version number in `build/version.json`. |
| `cloud run [--version N] [--sections a,b] [--list] [--timeout 120s] [--json]` | Submits the test shim against the recorded version, waits, prints the task's log and a summary, exits non-zero on any failure. |
| `cloud run --code "<luau>"` / `--script <file>` | Runs arbitrary Luau instead of the shim and prints what it returned: a hypothesis about a real server, answered in a minute. |
| `cloud test <file>` | `cloud publish` the file, then `cloud run`. The same as `test <file> --cloud`. |
| `cloud probe` | Reports what the task environment looks like from the inside. |

`--dry-run` prints the request a command would send, without the key. Flags may come before or
after the command.

**Why the cloud needs `testing.entry` and Studio does not.** A Luau execution task loads the place
but runs none of its Scripts, so nothing ignites the game. The shim has to require the ModuleScript
that exports `ignite()` and call it. `"testing": { "entry": "src/server/main" }` in
`flamework.config.json` tells it which one. In Studio, the place's own Scripts run, and the module
is up before the tests are invoked. A cloud command checks for the entry before it publishes
anything. See
[Running the tests](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md)
for the setup.

The place must be closed in Studio while `cloud publish` runs: Roblox refuses to save a version of
a place that is open (`409 Server is busy`).

## Settings

Each setting is taken from the first of these that has it:

1. flags;
2. the shell environment;
3. `.env` and `.env.local` next to the nearest `flamework.config.json`;
4. that file's `cloud` section, read the way the transformer reads it (so it may use `${NAME}`
   itself).

Everything is named *testing*, so nothing confuses it with the original place. A Studio run needs
none of this, except, optionally, the original place.

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

The key needs `universe-places:write`, and `universe.place.luau-execution-session:read` and
`:write`, for the testing experience. The `cloud` section is read by this CLI only, and is never
compiled into the place. The flags `--testing-universe`, `--testing-place`, `--key` and
`--original`, and the variables `TESTING_UNIVERSE_ID`, `TESTING_PLACE_ID`, `ROBLOX_API_KEY` and
`ORIGINAL_PLACE`, override it. Prefer the environment for the key: a flag ends up in the shell
history. The Rojo projects a run follows come from `--project` or `ROJO_PROJECT`; see
[Running under several Rojo projects](#running-under-several-rojo-projects).

## Patching a copy of the original place

A game's assets often live only in the place itself, and a Rojo build has none of them. Save a
copy of the original from Studio (File > Save to File), and name it with `--original`,
`ORIGINAL_PLACE` or `cloud.originalPlace`. `test` and `cloud publish` then lay the build over a
copy of it, and run or upload that. `patch` does the same without running anything.

The patch follows the Rojo project file (`--project`, default `default.project.json`), so it
changes exactly what a build would:

| In the project file | In the patched place |
|---|---|
| A node with `$path` | The build's instance replaces the original's, whatever was under it. That is the fresh code. |
| A node with only `$className` | The original's instance is kept, with everything it holds. When the original has none, the build's is taken. |
| `$properties` | Applied, typed from the reflection database: booleans, numbers, strings, enums, `Vector3`, `Vector2`, `Color3`. |
| Everything else in the original | Untouched. |

The patch prints one line for each change it made and for anything it skipped. It stamps the place
with the name of the project it followed (`Workspace`'s `FlameworkTestProject` attribute; `default`
for `default.project.json`). It runs under [Lune](https://lune-org.github.io/docs), which reads and
writes place files. Without `lune` on the path (or `LUNE_EXE`), a command given an original stops
before running or uploading anything.

## Running under several Rojo projects

A place file can hold any property, including the ones no script may set once the game runs. So a
project's `$properties` on `Workspace` are how a test run gets a `SignalBehavior` or a streaming
setup. The patch writes them into the place before Studio opens it, and the play session honours
them. Verified on 2026-09-13 with Lune 0.10.5 and Rojo 7.7.0:

| `Workspace` property | Values | Set by the patch | In the play session |
|---|---|---|---|
| `SignalBehavior` | `Default`, `Immediate`, `Deferred`, `AncestryDeferred` | yes | `Deferred` measured: no signal fires inside the write, all after `task.wait()`; `Default` in a fresh place behaves as `Immediate` |
| `StreamingEnabled` | boolean | yes | readable, and far content stays off the client |
| `StreamingTargetRadius` | studs | yes | 256 measured: a part 600 studs out never reaches the client, which the default 1024 would send |
| `ModelStreamingBehavior` | `Legacy`, `Default`, `Improved` | yes | `Improved` measured: a far Model is absent on the client entirely, where `Default` sends the empty container |
| `StreamingMinRadius` | studs | yes | written to the file; not readable and not told apart from the target radius in a small place |
| `StreamingIntegrityMode` | `Default`, `MinimumRadiusPause`, `PauseOutsideLoadedArea`, `Disabled` | yes | written to the file; `PauseOutsideLoadedArea` did not pause a teleported character in the time it took the far area to stream in |

Only `StreamingEnabled` can be read back from a script. The other five are `NotScriptable`, and show
only in what the engine does. Any other property the reflection database knows can be set the same
way: `Workspace.Gravity`, `PhysicsSteppingMethod`, and the properties of `Lighting` and
`SoundService`.

To test under one of these, write a project file that differs from `default.project.json` in its
`$properties`, and name it on the run. For example, `tests/deferred.project.json`:

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

Each project gets one run of every realm, in a place named after it (`place.deferred.rbxl`), under
its own heading. Every project runs even after one fails. The output ends with
`projects: deferred passed, streaming FAILED`, and the exit code is the worst of them.

- `--project` may be repeated or comma-separated.
  `ROJO_PROJECT=tests/deferred.project.json,tests/streaming.project.json` in `.env` does the same
  without the flags, and `ROJO_PROJECT=` turns it off again.
- With no project named, the run is the plain one: the build as it is, or laid over the original
  when one is named, following `default.project.json`.
- A chosen project needs `lune` even without an original. The build was made by `rojo build` from
  `default.project.json`, so the project's properties have to be set on a copy.
- `--timeout`, the hang report and every other flag apply to each project's run.

The tree still comes from the build. A project chosen for a run changes what the place's services
and containers are *set to*, not what Rojo synced into them. To test a different tree, build with
that project (`rojo build tests/big.project.json -o big.rbxl`) and run that file.

Inside the place, `getProject()` from `@flamework-experimental/testing` returns the name of the
project the place was made under (`deferred`), or `undefined` in a place the CLI did not make. A test
can use it to assert what that project changes, or to return early under the others. The run result
carries it as `project`, and the summary line prints it. To look at such a place in Studio, the
`patch` command makes the same place without running it:
`flamework-test patch place.rbxl --project tests/deferred.project.json`.

## What runs in the cloud

A task loads the place but runs none of its Scripts. So the shim requires the testing package's own
cloud module, which:

1. ignites the game from the ModuleScript that `testing.entry` names in the config;
2. waits for `Workspace.FlameworkTests`;
3. invokes it, and returns the result as JSON.

See [Running the tests](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md)
for the setup on the game's side, the limits, and what each error means.

## Limits

- Five task creations a minute per key owner.
- 45 task and log reads a minute.
- Ten concurrent tasks per place.
- 300 seconds per task.

A run uses one task.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `RobloxStudioBeta.exe was not found` / `StudioMCP.exe was not found` | Studio is not installed here; set `ROBLOX_STUDIO_EXE` / `STUDIO_MCP_EXE`, or run in the cloud with `--cloud`. |
| `... never showed up on the MCP proxy` | The window opened but "MCP server" is disabled in Studio's Assistant settings. |
| `the server's run failed: Workspace.FlameworkTests did not appear within 30 seconds` | The place was built without the `testing` scope active (`FLAMEWORK_SCOPES=testing` for that build), so the plugin stayed inert. The other realm still runs, and reports the same. |
| `the server's run failed: The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has additional values for the Capabilities property: ...` | Studio runs MCP code sandboxed, and the place was built with 2.0.0-alpha.5 or earlier, whose host does not make its bindable Sandboxed. A later CLI marks it before the invoke while Studio allows that; this error means it could not, or the CLI is that old too. Update the package and rebuild the place; a later CLI says so under the error. |
| `MISS matched nothing in any realm: ...` | A `--sections` entry names no section or test in any realm that ran: a typo, or a section whose provider is not registered. |
| `the client's run did not finish within 120s (--timeout)` | A test is stuck past `testing.timeout`, or the host never started; the next line names the last test that reported, and the one after it in that section is the hanging one. |
| `no Studio window has the testing place ... open` | Nothing has it open, or the window has "MCP server" disabled and so is not listed. |
| Ctrl+C under `bun run` left Studio open and printed no `interrupted by Ctrl+C` line | The script runs the CLI's file with `bun` directly, and `bun run` ends that process at once; call the `flamework-test` bin. The next `test` of that file closes the window. |
| After Ctrl+C the prompt came back at once, and the `interrupted by Ctrl+C` line came after it | Expected through the bin: its shim ends at once and the CLI cleans up after it. Run the CLI's file with `bun` to wait for it. |
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

- `bun test cli/tests` runs the CLI suite with a mocked `fetch`, a fake Studio proxy and fake
  processes. Nothing reaches the network, Studio or Lune.
- The real thing runs in
  [`tests/place`](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/tests/place/README.md),
  the repository's test place. Its dependencies are workspace links to this package and the others.
  `bun run test:place` from the repository root builds the packages and runs the place's suite in
  Studio under four Rojo projects, with no packing or copying.
- `bun run typecheck` runs `tsc -p cli --noEmit`, and `bun run build` builds the roblox-ts side.

The CLI runs under Bun. The Luau it submits or runs lives in `cli/tasks/*.lune`, imported as text.
The reason: a game's Rojo project syncs `node_modules/@flamework-experimental` into the place, and
Rojo would make ModuleScripts of `.luau` files.
