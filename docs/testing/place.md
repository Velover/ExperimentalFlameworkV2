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

Any Roblox place built from a roblox-ts project with `@flamework-experimental/testing` installed
works this way. This repository runs its own suite in [`tests/place`](../../tests/place/README.md),
a workspace member linked to the packages' builds: `bun run test:place` from the root builds the
packages and runs the place under its four Rojo projects, and `bun run test:place --cloud` takes
the cloud route below.

## In Studio, on this machine

`test <file>` launches Roblox Studio on the file, waits for the window to connect, starts a play
session, invokes `Workspace.FlameworkTests` in the server's data model and then in the client's,
prints each realm's summary, stops the session and closes the window. Every realm runs even when
one fails, its tests or the call itself; the exit code is the worst of them. A `--sections` entry
only one realm has does not fail the other; one no realm has fails the run. Nothing is uploaded and
no account is involved:
the place runs itself, exactly as a Play in Studio would, and the client's sections run too, which
the cloud cannot do.

```console
bunx flamework-test test place.rbxl --realm client         # one realm
bunx flamework-test test place.rbxl --sections economy     # a section, or economy/buys
bunx flamework-test test place.rbxl --list                 # what would run
bunx flamework-test test place.rbxl --keep                 # leave Studio and the play session open
bunx flamework-test test place.rbxl --fail-on-skip         # a skipped test fails the run
bunx flamework-test test place.rbxl --keep-awake           # keep the display on while it runs
bunx flamework-test test place.rbxl --concurrency 1        # concurrent tests one at a time
```

It needs Studio installed with "MCP server" enabled in its Assistant settings, which is what lets
the CLI drive a window; a window with it disabled is invisible to it. The CLI runs on Bun, however
the package was installed. The place has to be built with the `testing` scope active
(`FLAMEWORK_SCOPES=testing` for that build, as guide 12's
[test script](../guide/12-testing.md#setting-up) sets it, never in `.env` or `.env.local`, which
every build reads), or the test providers are not registered and `Workspace.FlameworkTests` never
appears.

Studio may run the Luau its MCP server executes in a sandboxed thread (it did from 2026-10-01; on
2026-10-05 it did not), and the host and the CLI work either way. A sandboxed thread may only
invoke a bindable that is Sandboxed itself and has no capability the thread lacks. So the host
makes `Workspace.FlameworkTests` Sandboxed, with no capabilities. That
decides only who may call it: the callback runs with the capabilities of the script that set it,
so the tests keep `require`, `_G` and everything else. A place built with 2.0.0-alpha.5 or earlier
has a bindable that is not Sandboxed. The CLI marks it before the invoke for as long as Studio
lets sandboxed code do that; once Studio refuses, rebuild the place (see
[Troubleshooting](#troubleshooting)).

A window whose title shows that very file (Studio titles a local file's window with its full
path) is from an earlier build and would test stale code, so `test` closes it before opening the
fresh file: it asks that window to close, and ends it after ten seconds. The title alone decides.
Windows of other files are never touched, whatever their names, and neither is a window started on
the file and since saved elsewhere or published (it shows its new name) or one whose title has
changed (it is not certainly that file). The window `test` opens is known by the process it
started, and that process is what it closes, by ending it without asking: Studio marks a place file
as changed as soon as it has loaded it, so asking only raises its save prompt (measured on
2026-09-28 with a window that had done nothing but load). A window is only reported closed once its
process is gone. One that is still running after that fails the run, named by its PID and title.
A window the run gives up on, one that never connected to the proxy, say, is closed the same way.
`--keep` leaves the window and the session for a look around; the next `test` closes it. The
proxy lists a local file's window by its file name alone, so runs of same-named files started at
once take turns to open theirs: a run waits, saying so, until the other's window is listed or the
other has given up on it (closing it, unless `--keep`). Any other window showing a file of that name must be
on the proxy before the run looks; one that is still opening (a double-click, `studio open`) could
own the entry the run is waiting for, so the run waits for it, and refuses, closing its own window,
when it cannot tell the two apart.

One flamework-test run at a time opens Studio windows on the machine, across projects and agents
(with `--parallel`, several of its projects' windows at once): `test` takes the Studio lock before
it launches Studio, holds it across all its projects, and waits (300 seconds, `--lock-timeout`)
while another project's run or window holds it, saying whose. A window left open (`--keep`, `studio
open`) holds the lock until it closes, or until it has sat unused past its hold (15 minutes,
`--hold`), when the next command closes it. The lock lives in `%LOCALAPPDATA%\flamework-test` on
Windows, shared by every project and agent. See the package's
[README](../../packages/testing/README.md#the-studio-lock).

Both realms share the one play session, so the client's sections run against a server whose own
tests have already run. A RemoteEvent message fired at a client before it connected
`OnClientEvent` is queued by the engine and delivered on the first connection, so a server test
that predicts with the real player and gets an answer fired back leaves that answer waiting for the
client's tests. Predict with a stand-in and skip it in the answering handler; see
[both realms in one session](../guide/12-testing.md#both-realms-in-one-session).

The pieces `test` is made of are commands of their own, for driving a window by hand: `studio
open [file]`, `studio close`, `studio status`, `studio play`, `studio stop`, `studio exec --code`
and `studio run [--realm server|client|both]`, which runs the tests in the window without opening
or closing anything. `studio call <tool>` calls any of Studio's MCP tools (`studio tools` lists
them), `studio list` lists the windows, and `studio lock` shows who holds the lock. The commands
that change a window act only on the one flamework-test opened for this project, unless
`--any-window`, and not while another process's command of this project is running in it (a
`test`, `test --keep`, `studio open`). See the package's [README](../../packages/testing/README.md)
for each.

### Skipped tests

A test that calls `skip(reason)`, or is registered with `test.skip` (see
[Skipping a test](../guide/12-testing.md#skipping-a-test)), is reported as skipped. That is not a
failure, so the run stays green, but every skip is shown: each realm's summary counts the skips
and lists each one with its reason, in the order the tests ran, beside the failures:

```
PASS client  11 passed, 0 failed, 1 skipped
       - onRender fires on the client, where the server sees nothing (skipped): RenderStepped doesn't fire: the display may be asleep
...

181 passed, 0 failed, 2 skipped in 28159ms (client, project default)
PASS
```

A run under several projects counts them on its last line too:
`projects: default passed (1 skipped), deferred passed`.

`--fail-on-skip` makes any skip fail the run, for a CI job that must run everything: a section with
a skip then heads `FAIL` (`FAIL client  11 passed, 0 failed, 1 skipped`), the realm's summary ends
`1 skipped, which fails the run under --fail-on-skip` and `FAIL`, and the exit code is 1. The same
comes from `FAIL_ON_SKIP=true` in the shell, `.env` or `.env.local`, or from
`"testing": { "failOnSkip": true }` in `flamework.config.json`, in that order after the flag;
`--fail-on-skip=false` turns it off for one run. `test`, `studio run`, `cloud run` and
`cloud test` take it. `--list` marks a test registered with `test.skip`
(`economy/refunds  (skipped: marked with test.skip)`) and is never failed by one, since nothing ran.
`--json` prints each test's `status` and `skipReason` as the place gave them, and the place's `ok`,
which no skip makes false; a run its skips fail under `--fail-on-skip` says so in one line on
stderr, outside the JSON: `1 skipped on the client, which fails the run under --fail-on-skip ...`.

Across versions: a place built with 2.0.0-alpha.5 or earlier has no skips to report, and
`--fail-on-skip` passes it with a note saying so in the summary (`--json` prints none). An older
`flamework-test` against a newer place reads each skip as a test that did not fail and leaves it out
of its counts: skips neither fail its run nor show in its summary.

### Unattended runs: keep the display on

The engine renders no frame while the PC's display is off. `RenderStepped` and `PreRender` stop,
Flamework's `onRender` never fires, and a client test that waits for a frame fails, in a run
nobody watches once the screen has gone to sleep. A minimized or unfocused Studio window still
renders, at about 60 frames a second: only the display matters.

`--keep-awake` asks Windows to keep the display on, and the machine awake, from the start of the
run to its end, through `SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED |
ES_SYSTEM_REQUIRED)`. It is a request of the CLI's own process, not a change to the power settings,
and the run lets go of it when it ends, whether it passed, failed or was stopped by Ctrl+C (whose
last line then names `let the display sleep again`). A second Ctrl+C exits at once without it, and
Windows lets go of a process's request when the process exits, so nothing is left either way. It
is off by default; `KEEP_AWAKE=true` or `"testing": { "keepAwake": true }` turn it on, with the
same order as `--fail-on-skip`. `test` and `studio run` take it; a cloud run has no display on
this machine, so `--cloud` refuses the flag and leaves the setting alone. On Linux and macOS the
flag is accepted and does nothing, and says so in one line.

This repository's place tells the two cases apart: its client `onRender` test checks, with a plain
`RenderStepped` connection, whether the engine renders at all, and skips with
`RenderStepped doesn't fire: the display may be asleep` when it does not, while an engine that
renders and an `onRender` that does not fire still fail it.

### Ctrl+C

Ctrl+C stops a run where it is and cleans up what the run started, through the same steps a run
that finishes takes: the play session it started is stopped, the window it opened is closed by the
process it started (never a window it did not open), its window-name claim is released and the
Studio lock freed, the patch's temp folder is removed, lune and the MCP proxy are stopped, and the
`--keep-awake` request is let go. Nothing new starts afterwards: the other realm and the other
projects are not run. The CLI then exits 130 (but see [the exit code](#the-exit-code-and-the-prompt)
for what a shell sees), ending on one line that says what it cleaned up and what it left:

```
Ctrl+C: stopping, and cleaning up what this run started (Ctrl+C again exits at once)
play session stopped (--keep leaves it running)
closed place.rbxl (PID 38332)
interrupted by Ctrl+C: cleaned up: stopped the play session it started; closed the Studio window it opened (PID 38332, place.rbxl); closed the MCP proxy (StudioMCP.exe, PID 35580); released the Studio lock
```

A Ctrl+C while Studio starts the play session (which takes it about five seconds) stops waiting for
the start at once, but Studio refuses to stop a session it is still starting (`Start play hasn't
finished yet`), so the stop is tried again, half a second apart, until the start has finished:
`the play session is still starting; it is stopped once it has`. After 30 seconds of refusals (40
at most, when the last stop is slow to answer) the stop gives up and says why; `test` then closes
its window all the same, and the session ends with it.

`--keep` keeps the window and the session then too, and the line names them as left. A Ctrl+C
during the cleanup a finished run does anyway (stopping the session, closing the window) lets it
finish, and the run still exits 130. A second Ctrl+C exits at once, however soon it comes after the
first, naming what may be left (`may be left: the Studio window it opened (PID 11348, place.rbxl); the
play session it started`); the next `test` of that file closes such a window as one left from an
earlier build. The line leaves out what ends with the CLI's process anyway (Bun ends the child
processes it started when it exits: lune, the MCP proxy, a close script), and names a close the
second Ctrl+C cut short: a window left from an earlier build is asked to close first, and may be left
showing its save prompt. `studio run` stops the session it started; `studio open` stops waiting and
leaves the window, which is what it was asked for; `studio exec` stops waiting, and its Luau runs on
in Studio, which has no way to stop it.

Ctrl+Break does the same as Ctrl+C, and exits 149. Windows has no SIGTERM for the CLI to hear:
ending its process there (`taskkill /F`, or `process.kill` with SIGINT, SIGTERM or SIGKILL) ends it
at once, with no cleanup. On Linux and macOS, where only the cloud commands run, SIGTERM does the
same as Ctrl+C, and exits 143.

#### The exit code and the prompt

130 is the exit code of the CLI's own process, which is not what a shell sees through the
`flamework-test` bin, the way a terminal or a package script runs it. Bun's bin shim
(`node_modules/.bin/flamework-test.exe`) is ended by the Ctrl+C itself, at once, so the shell gets
the shim's status back, or `bun run`'s around it, the same value (0xC000013A, which cmd and
PowerShell show as -1073741510), and its prompt, while the CLI goes on cleaning up in the same
console and prints its last lines after the prompt, a few seconds later (measured with Bun 1.4.0,
through the bin, `bun run` and `bun run test:place` alike).

To have the terminal wait for the cleanup and get 130, run the CLI's file with `bun` yourself:
`bun node_modules/@flamework-experimental/testing/cli/src/cli.ts test place.rbxl`. Not from a
package script, though: `bun run` ends a child it started that way the moment Ctrl+C reaches it, so
the CLI loses its cleanup altogether, while through the bin the shim stands between them and the CLI
survives it. Package scripts call the bin, as the scripts here do.

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
failure's message and each skip's reason, and exits non-zero when a test failed, a filter entry
matched nothing, the task itself failed, or, under `--fail-on-skip`, a test skipped. `--json`
prints the raw result table instead.

A version is published as `Saved`, which uploads it and gives it a number without making it live,
and the tests run against that number. Nothing here publishes to players. The place has to be
closed in Studio while `cloud publish` runs: Roblox refuses to save a version of an open place.

Ctrl+C stops a cloud run from waiting, and undoes what is on this machine (the patch's temp folder,
lune), but not what has reached Roblox. An upload it cuts short may still have made a version, and
`build/version.json` is then not written. A task already created runs on until it finishes or its
own timeout ends it, since the Luau Execution API has no way to cancel one; the run's last line
names its path, which `GET /cloud/v2/<path>` reads afterwards. It counts against the 10 concurrent
tasks of the place meanwhile.

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
end, which counts each project's skips:

```
=== deferred: tests/deferred.project.json ===
...
2 passed, 0 failed, 0 skipped in 340ms (server, project deferred)
...
projects: default passed (1 skipped), deferred passed, streaming FAILED
```

The exit code is the worst of them; `--timeout` and the hang report apply to each project's run.

`--parallel` runs two projects' windows side by side (`--parallel 3`: three, at most 4), the next
project starting as one's window closes. Each project's lines are still printed together, in
project order, and short lines on stderr say how the ones waiting to print are getting on. Each
window takes about 3 GB; `FLAMEWORK_TEST_PARALLEL` or `"testing": { "parallel": 2 }` set it too.
See the package's [README](../../packages/testing/README.md#side-by-side).

```console
bunx flamework-test test place.rbxl --project default.project.json,tests/deferred.project.json --parallel
```
Without a project named, the run is the plain one, and `ROJO_PROJECT=` turns a listed set off
again. A chosen project needs `lune` even without an original: the build came from `rojo build`
with `default.project.json`, so its properties are set on a copy first. The tree still comes from
the build, since the CLI does not wrap `rojo build`: a project chosen for a run changes what the
place's services are set to, not what Rojo synced; a project with a different tree is built with
`rojo build tests/big.project.json -o big.rbxl` and that file is run.

A test learns which project it runs under from `getProject()`, the name of the project file
(`deferred`; `default` for the default project when an original was patched; `undefined` in a
place the CLI did not make, such as one opened from Rojo by hand). The run result carries it as
`project`. Assert per project, or skip under the others, which the summary then lists with the
reason (a plain `return` would count as a pass):

```ts
import { defineTests, expectEqual, expectTrue, getProject, skip, test } from "@flamework-experimental/testing";

defineTests("signals", () => {
    test("ChildAdded is deferred past the write", () => {
        if (getProject() !== "deferred") skip("only the deferred project defers signals");
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
| `the server's run failed: Workspace.FlameworkTests did not appear` | The build was made without the `testing` scope active (`FLAMEWORK_SCOPES=testing` for that build), so the plugin stayed inert. The client's run follows, and says the same. |
| `the server's run failed: The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has additional values for the Capabilities property: ...` | Studio ran MCP code sandboxed, as it may, and the place was built with `@flamework-experimental/testing` 2.0.0-alpha.5 or earlier, whose host does not make its bindable Sandboxed (see [In Studio](#in-studio-on-this-machine)). A later CLI marks it before the invoke while Studio allows that; this error means it could not, or the CLI is that old too. Update the package and rebuild the place. A later CLI says so under the error. |
| `MISS matched nothing in any realm: ...` | A `--sections` entry named no section or test in any realm that ran. |
| `the client's run did not finish within 120s (--timeout)` | A test is stuck past `testing.timeout`, or the host never started. The next line names the last test that reported in Studio's output (its `PASS`, `FAIL` or `SKIP` line); the one after it in that section is the hanging one, or, if that section runs concurrent tests, which report as each ends, any of them that has not reported. |
| `- onRender fires on the client, where the server sees nothing (skipped): RenderStepped doesn't fire: the display may be asleep` | The PC's display was off during the run, so the engine rendered nothing. Run with `--keep-awake` (see [unattended runs](#unattended-runs-keep-the-display-on)), or keep the screen on. |
| `1 skipped, which fails the run under --fail-on-skip` (with `--json`, on stderr: `1 skipped on the client, which fails the run ...`) | A test skipped while `--fail-on-skip`, `FAIL_ON_SKIP` or `testing.failOnSkip` was on; the lines above it name the test and its reason, under its section's `FAIL` (with `--json`, the JSON's `status` and `skipReason` do). |
| `note: this place's runner predates skips ...` | The place was built with `@flamework-experimental/testing` 2.0.0-alpha.5 or earlier, which has no skips, so `--fail-on-skip` had nothing to fail on. |
| `FAIL_ON_SKIP must be true or false` / `KEEP_AWAKE must be true or false` | The variable holds something else; `true`, `false`, `1`, `0`, `yes`, `no`, `on` and `off` are read, and empty is off. |
| `--keep-awake is for Studio runs` | A cloud run has no display on this machine to keep on; drop the flag. `KEEP_AWAKE` is left alone there. |
| `warning: Windows refused to keep the display on` | `SetThreadExecutionState` returned 0; the run went on without the request. |
| `lune is needed to set the properties of the project ...` | A chosen `--project` sets its `$properties` on a copy of the build under Lune; install it or set `LUNE_EXE`. |
| `the Rojo project ... does not exist` / `two projects are both named ...` | A `--project` or `ROJO_PROJECT` entry names no file, or two files share a name; both are checked before the first run. |
| `skipped Workspace.X (not a property the reflection database knows)` | Not a property of that class in Lune's reflection database; check the spelling against the Properties window. |
| Ctrl+C under `bun run` left the window open and printed no `interrupted by Ctrl+C` line | The script runs the CLI's file with `bun` directly, and `bun run` ends that process at once; call the `flamework-test` bin instead (see [Ctrl+C](#ctrlc)). The next `test` of that file closes the window. |
| After Ctrl+C the prompt came back at once, and the `interrupted by Ctrl+C` line came after it | Expected through the bin: its shim ends at once, and the CLI cleans up after it (see [the exit code](#the-exit-code-and-the-prompt)). Run the CLI's file with `bun` to wait for it. |
| `a cloud run needs "testing": { "entry": ... }` | The cloud has to ignite the game itself; give the config the ModuleScript that exports `ignite()`. |
| `403 PERMISSION_DENIED ... luau-execution-session ... missing` | The key lacks the task scopes for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio. Close it; the upload succeeds at once afterwards. |
| `429` | The five-per-minute creation limit. |
| Task `FAILED` with `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| Task `COMPLETE` but `ok` is false with `unknown` names | A `--sections` entry matched no section or test. |
