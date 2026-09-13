# Running the tests: Studio first, the cloud second

The `flamework-test` CLI, which ships with `@flamework-experimental/testing`, runs the `defineTests`
sections of [Testing in the place](../guide/12-testing.md) where the engine is real, from a terminal or CI.
First, and by default, in Roblox Studio on this machine; second, when asked, in a real Roblox
server through the Open Cloud Luau Execution API. Both take the place Rojo built, both give back
the same result table, and both can lay the build over a copy of the original place first.

```console
rojo build -o place.rbxl && bunx flamework-test test place.rbxl            # Studio, both realms
rojo build -o place.rbxl && bunx flamework-test test place.rbxl --cloud    # a real server, server realm
```

## In Studio, on this machine

`test <file>` launches Roblox Studio on the file, waits for the window to connect, starts a play
session, invokes `Workspace.FlameworkTests` in the server's data model and then in the client's,
prints each realm's summary, stops the session and closes the window. Every realm runs even when
one fails; the exit code is the worst of them. Nothing is uploaded and no account is involved:
the place runs itself, exactly as a Play in Studio would, and the client's sections run too, which
the cloud cannot do.

```console
bunx flamework-test test place.rbxl --realm client         # one realm
bunx flamework-test test place.rbxl --sections economy     # a section, or economy/buys
bunx flamework-test test place.rbxl --list                 # what would run
bunx flamework-test test place.rbxl --keep                 # leave Studio and the play session open
```

It needs Studio installed with "MCP server" enabled in its Assistant settings, which is what lets
the CLI drive a window; a window with it disabled is invisible to it. The place has to be built
with the `testing` scope active (`FLAMEWORK_SCOPES=testing` in `.env`), or the test providers are
not registered and `Workspace.FlameworkTests` never appears.

A window that already has a file of the same name open is from an earlier build and would test
stale code, so `test` closes it before opening the fresh file. `--keep` leaves the window and the
session for a look around; the next `test` closes it.

Both realms share the one play session, so the client's sections run against a server whose own
tests have already run. A RemoteEvent message fired at a client before it connected
`OnClientEvent` is queued by the engine and delivered on the first connection, so a server test
that predicts with the real player and gets an answer fired back leaves that answer waiting for the
client's tests. Predict with a stand-in and skip it in the answering handler; see
[both realms in one session](../guide/12-testing.md#both-realms-in-one-session).

The pieces `test` is made of are commands of their own, for driving a window by hand: `studio
open [file]`, `studio close`, `studio status`, `studio play`, `studio stop`, `studio exec --code`
and `studio run [--realm server|client|both]`, which runs the tests in whatever window has the
testing place open without opening or closing anything. See the package's
[README](../../packages/testing/README.md) for each.

## In the cloud

`test <file> --cloud` (or `cloud test <file>`) publishes the build to a testing place as a Saved
version and runs the server's sections in a real server through the Luau Execution API. It is the
path for a machine without Studio, and for a real server rather than Play Solo. Client sections
cannot run there: there is no client.

### What a cloud task can and cannot do

A Luau execution task loads the place into a fresh server and runs the script you submit. That
is all it runs: **the place's own Scripts do not execute** (verified with a sentinel Script on
2026-09-11), `RunService:IsRunning()` is false, `RunService:Run()` and the other plugin-level
calls raise, and no client ever joins. `task.wait` works and `IsServer()` is true, so a Flamework
module ignited from the task behaves as it would on a server, with one difference in what fires
per frame (the probe of 2026-09-11, counts over one second):

| Signal | Fires |
|---|---|
| `Heartbeat` | 60 |
| `PostSimulation`, `PreSimulation`, `Stepped`, `PreAnimation` | 0 |
| `PreRender` | raises |

`onTick` hangs off `Heartbeat`, so it runs in a task; `onPhysics` (`PreSimulation`) and
`onRender` never do, and a test that waits for either times out.

### Why the cloud needs `testing.entry`

Since none of the place's Scripts run, nothing ignites the game in a task. Something in the task
has to, and the runner cannot guess which module: that is `testing.entry`, the ModuleScript that
exports `ignite()`. The runner package ships a fixed cloud module for it; the script the CLI
submits imports it through roblox-ts's runtime and nothing else:

```lua
local include = game:GetService("ReplicatedStorage").rbxts_include
local TS = require(include.RuntimeLib)
local cloud = include.node_modules["@flamework-experimental"].testing.out.cloud
-- `script` is nil in a task; the import only needs a key for its cycle detection.
return TS.import(script or {}, cloud).run(FILTER, OPTIONS)
```

`run` looks for `Workspace.FlameworkTests`. When it is not there, it requires the ModuleScript
that `testing.entry` names, calls its exported `ignite()`, waits for the bindable, invokes it and
returns the result as JSON. The game therefore needs its server entry as a ModuleScript exporting
`ignite()`, with the usual entry Script calling it:

```ts
// src/server/main.ts
export function ignite() {
    return Flamework.createModule()
        .includePlugin(LifecyclePlugin)
        .registerProviders("src/server/services")
        .registerProviders("src/server/Tests", { activeIn: ["testing"] })
        .includePlugin(TestingPlugin)
        .ignite();
}
```

```ts
// src/server/runtime.server.ts
import { ignite } from "./main";
ignite();
```

```jsonc
// flamework.config.json
"testing": { "entry": "src/server/main" }
```

In Studio the entry Script runs and the module is up before the tests are invoked, so a project
that only runs its tests locally never sets `entry`. A cloud command checks for it before it
publishes anything.

### Setup

1. A *testing* experience and place. Never the original: everything the CLI takes is named
   `testing...` so the two cannot be confused.
2. An API key from the Creator Dashboard with, for that experience, `universe-places:write`
   (publishing) and `universe.place.luau-execution-session:read` and `:write` (tasks). Two
   settings cause most 401s: an IP allowlist narrower than `0.0.0.0/0`, and an expiry date.
3. The key in the environment, never in a file that is committed:

   ```ini
   # .env.local (gitignored)
   ROBLOX_API_KEY=...
   ```

4. The testing place in `flamework.config.json`, or as `TESTING_UNIVERSE_ID` and
   `TESTING_PLACE_ID` in the same `.env.local`. This section is read by the CLI only and is
   never compiled into the place:

   ```jsonc
   "cloud": {
     "testingUniverseId": "10765968722",
     "testingPlaceId": "108973151455286",
     "apiKey": "${ROBLOX_API_KEY}",
     "originalPlace": "places/original.rbxl"   // optional, see below
   }
   ```

### Commands

```console
bunx flamework-test cloud publish place.rbxl         # upload as a Saved version; keeps the number
bunx flamework-test cloud run [--sections a,b]       # run the tests against that version
bunx flamework-test cloud test place.rbxl            # publish, then run
bunx flamework-test cloud run --list                 # what would run
bunx flamework-test cloud run --code "return 1 + 1"  # any Luau, for a hypothesis about a real server
bunx flamework-test cloud probe                      # what the task environment reports
```

The key and the ids come from flags (`--key`, `--testing-universe`, `--testing-place`), else
the shell, else `.env` and `.env.local` next to the config file, else the `cloud` section; a
`.env.local` with `ROBLOX_API_KEY`, `TESTING_UNIVERSE_ID` and `TESTING_PLACE_ID` needs no
config section at all.

`cloud run` prints every log line the task produced, then a summary per section with each
failure's message, and exits non-zero when a test failed, a filter entry matched nothing, or the
task itself failed. `--json` prints the raw result table instead.

A version is published as `Saved`, which uploads it and gives it a number without making it live,
and the tests run against that number. Nothing here publishes to players. The place has to be
closed in Studio while `cloud publish` runs: Roblox refuses to save a version of an open place.

### Limits

| Limit | Value |
|---|---|
| Task creations | 5 per minute per key owner, whatever the number of keys |
| Task reads and log reads | 45 per minute |
| Concurrent tasks | 10 per place |
| Task duration | 300 seconds |

One task per run, so a test suite has to fit in five minutes of server time, and a loop that runs
the suite more often than every 12 seconds is throttled.

## The original place's assets

A Rojo build holds the code and whatever the project file declares, and nothing a game keeps only
in its place: models, terrain, sounds, the map. Tests that need those run against a copy of the
original with the build laid over it. Save one from Studio (File > Save to File), name it with
`--original`, `ORIGINAL_PLACE` or `cloud.originalPlace`, and `test` and `cloud publish` patch it
before running or uploading; `patch` writes the result without doing either.

What the patch replaces is read from the project file, so it is exactly what a build changes: a
node with `$path` is replaced by the build's (the fresh code, whatever the original had under that
name), a node with only `$className` keeps the original's instance and everything in it, and
`$properties` are applied. Everything else in the original stays. The patch prints each change
and stamps the place with the name of the project it followed. It runs under Lune; without
`lune` on the path a command given an original stops before running or uploading anything.

## Workspace settings no script can change

Some of what a test needs to run under is not a script's to set: `Workspace.SignalBehavior`
decides whether a `ChildAdded` handler runs inside the write that parented the child or on the
next resumption, and the streaming radii decide what a client has at all. Once the game runs those
properties are `NotScriptable`: a script cannot read them, let alone write them. A place file
takes them, though, and the patch writes place files. So they come from the Rojo project's
`$properties`, and a project chosen for a run puts them in effect before Studio opens the place.
Verified on 2026-09-13 with Lune 0.10.5, in a play session the CLI started:

| `Workspace` property | Values | In the session |
|---|---|---|
| `SignalBehavior` | `Default`, `Immediate`, `Deferred`, `AncestryDeferred` | `Deferred` measured: `ChildAdded`, `Name`, attribute and BindableEvent signals all fire after `task.wait()`, none inside the write. `Default` in a fresh place is `Immediate`: all inside the write. |
| `StreamingEnabled` | boolean | The one that can be read back; a client under it holds only what is near. |
| `StreamingTargetRadius` | studs | 256 measured: a part 600 studs out never reaches the client, where the default 1024 would send it. |
| `ModelStreamingBehavior` | `Legacy`, `Default`, `Improved` | `Improved` measured: a far Model is absent on the client entirely; `Default` sends its empty container. |
| `StreamingMinRadius` | studs | Written; cannot be read back, and a small place does not tell it from the target radius. |
| `StreamingIntegrityMode` | `Default`, `MinimumRadiusPause`, `PauseOutsideLoadedArea`, `Disabled` | Written; `PauseOutsideLoadedArea` did not pause a character teleported onto a platform that streamed in within the frame. |

Every other property the reflection database knows takes the same route, `Gravity` and
`PhysicsSteppingMethod` included, on any service or container the project declares. Rojo itself
accepts the same `$properties`, so such a project is also a valid `rojo build` / `rojo serve`
project for a look in Studio by hand.

### Several projects, one suite

Write one project file per setup, differing from `default.project.json` in its `$properties`:

```jsonc
// tests/deferred.project.json: default.project.json with
"Workspace": { "$className": "Workspace", "$properties": { "SignalBehavior": "Deferred" } }
```

```jsonc
// tests/streaming.project.json: default.project.json with
"Workspace": {
  "$className": "Workspace",
  "$properties": { "StreamingEnabled": true, "StreamingMinRadius": 64, "StreamingTargetRadius": 256 }
}
```

and name them on the run, repeated or comma-separated, or as `ROJO_PROJECT` in `.env`:

```console
bunx flamework-test test place.rbxl --project tests/deferred.project.json
bunx flamework-test test place.rbxl --project tests/deferred.project.json,tests/streaming.project.json
```

```ini
# .env
ROJO_PROJECT=default.project.json,tests/deferred.project.json,tests/streaming.project.json
```

Each project is a run of both realms in a place of its own name (`place.deferred.rbxl`, laid
over the original when one is named, else the build with the project's properties set on it),
under a heading with the project's name, every one of them even after one fails, and a line at the
end:

```
=== deferred: tests/deferred.project.json ===
...
2 passed, 0 failed in 340ms (server, project deferred)
...
projects: default passed, deferred passed, streaming FAILED
```

The exit code is the worst of them; `--timeout` and the hang report apply to each project's run.
Without a project named, the run is the plain one, and `ROJO_PROJECT=` turns a listed set off
again. A chosen project needs `lune` even without an original: the build came from `rojo build`
with `default.project.json`, so its properties are set on a copy first. The tree still comes from
the build, since the CLI does not wrap `rojo build`: a project chosen for a run changes what the
place's services are set to, not what Rojo synced; a project with a different tree is built with
`rojo build tests/big.project.json -o big.rbxl` and that file is run.

A test learns which project it runs under from `getProject()`, the name of the project file
(`deferred`; `default` for the default project when an original was patched; `undefined` in a
place the CLI did not make, such as one opened from Rojo by hand). The run result carries it as
`project`. Assert per project, or return early under the others:

```ts
import { defineTests, expectEqual, expectTrue, getProject, test } from "@flamework-experimental/testing";

defineTests("signals", () => {
    test("ChildAdded is deferred past the write", () => {
        if (getProject() !== "deferred") return;
        const folder = new Instance("Folder");
        let fired = false;
        folder.ChildAdded.Connect(() => (fired = true));
        new Instance("Part").Parent = folder;
        expectEqual(fired, false);
        task.wait();
        expectTrue(fired);
    });
});
```

`flamework-test patch place.rbxl --project tests/deferred.project.json` makes the same place
without running it, `place.deferred.rbxl`, to open in Studio and look at.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `RobloxStudioBeta.exe was not found` | Studio is not installed here; set `ROBLOX_STUDIO_EXE`, or run with `--cloud`. |
| `... never showed up on the MCP proxy` | The window opened but "MCP server" is disabled in Studio's Assistant settings. |
| `Workspace.FlameworkTests did not appear` | The build was made without the `testing` scope active (`FLAMEWORK_SCOPES` in `.env`), so the plugin stayed inert. |
| `the client's run did not finish within 120s (--timeout)` | A test is stuck past `testing.timeout`, or the host never started. The next line names the last test that reported in Studio's output; the one after it in that section is the hanging one. |
| `lune is needed to set the properties of the project ...` | A chosen `--project` sets its `$properties` on a copy of the build under Lune; install it or set `LUNE_EXE`. |
| `the Rojo project ... does not exist` / `two projects are both named ...` | A `--project` or `ROJO_PROJECT` entry names no file, or two files share a name; both are checked before the first run. |
| `skipped Workspace.X (not a property the reflection database knows)` | Not a property of that class in Lune's reflection database; check the spelling against the Properties window. |
| `a cloud run needs "testing": { "entry": ... }` | The cloud has to ignite the game itself; give the config the ModuleScript that exports `ignite()`. |
| `403 PERMISSION_DENIED ... luau-execution-session ... missing` | The key lacks the task scopes for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio. Close it; the upload succeeds at once afterwards. |
| `429` | The five-per-minute creation limit. |
| Task `FAILED` with `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| Task `COMPLETE` but `ok` is false with `unknown` names | A `--sections` entry matched no section or test. |
