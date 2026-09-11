# Testing in the cloud

`@flamework-experimental/cloud-testing` publishes a place and runs its Flamework tests inside a
real Roblox server through the Open Cloud Luau Execution API, from a terminal or CI, with no
Studio involved. It is the cloud half of [Testing in the place](../guide/12-testing.md): the
tests are the same `defineTests` sections, and what the CLI gets back is the same result table.

## What a cloud task can and cannot do

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

So something in the task has to start the game. The runner package ships a fixed cloud module
for that; the script the CLI submits imports it through roblox-ts's runtime and nothing else:

```lua
local include = game:GetService("ReplicatedStorage").rbxts_include
local TS = require(include.RuntimeLib)
local cloud = include.node_modules["@flamework-experimental"].testing.out.cloud
-- `script` is nil in a task; the import only needs a key for its cycle detection.
return TS.import(script or {}, cloud).run(FILTER, OPTIONS)
```

`run` looks for `Workspace.FlameworkTests`. When it is not there, it requires the ModuleScript
that `testing.entry` names in `flamework.config.json`, calls its exported `ignite()`, waits for
the bindable, invokes it and returns the result as JSON. The game therefore needs its server
entry as a ModuleScript exporting `ignite()`, with the usual entry Script calling it:

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
"scopes":  { "active": "${FLAMEWORK_SCOPES:-}" },
"testing": { "entry": "src/server/main" }
```

The place has to be built with the `testing` scope active (`FLAMEWORK_SCOPES=testing` in `.env`),
or the test providers are not registered and the plugin stays inert.

Client tests cannot run in the cloud; there is no client. They run in Studio, through the same
bindable: `flamework-cloud studio run --realm client` (see [Studio](#studio) below).

## Setup

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

## Commands

Building the place is Rojo's job; the CLI takes the file it produced:

```console
rojo build -o place.rbxl                        # the place, from your project file (gitignore *.rbxl)
bunx flamework-cloud publish place.rbxl         # upload it as a Saved version; keeps the number
bunx flamework-cloud run [--sections a,b]       # run the tests against that version
bunx flamework-cloud test place.rbxl            # publish, then run
bunx flamework-cloud run --list                 # what would run
bunx flamework-cloud run --code "return 1 + 1"  # any Luau, for a hypothesis about a real server
bunx flamework-cloud probe                      # what the task environment reports
bunx flamework-cloud patch place.rbxl --original original.rbxl   # the build laid over a copy of the original
```

The key and the ids come from flags (`--key`, `--testing-universe`, `--testing-place`), else
the shell, else `.env` and `.env.local` next to the config file, else the `cloud` section; a
`.env.local` with `ROBLOX_API_KEY`, `TESTING_UNIVERSE_ID` and `TESTING_PLACE_ID` needs no
config section at all.

`run` prints every log line the task produced, then a summary per section with each failure's
message, and exits non-zero when a test failed, a filter entry matched nothing, or the task
itself failed. `--json` prints the raw result table instead.

A version is published as `Saved`, which uploads it and gives it a number without making it live,
and the tests run against that number. Nothing here publishes to players.

## The original place's assets

A Rojo build holds the code and whatever the project file declares, and nothing a game keeps only
in its place: models, terrain, sounds, the map. Tests that need those run against a copy of the
original with the build laid over it. Save one from Studio (File > Save to File), name it with
`--original`, `ORIGINAL_PLACE` or `cloud.originalPlace`, and `publish` and `test` patch it
before uploading; `patch` writes the result without uploading.

What the patch replaces is read from the project file, so it is exactly what a build changes: a
node with `$path` is replaced by the build's (the fresh code, whatever the original had under that
name), a node with only `$className` keeps the original's instance and everything in it, and
`$properties` are applied. Everything else in the original stays. The patch prints each change.
It runs under Lune; without `lune` on the path a command given an original stops before
uploading anything.

## Studio

The same CLI opens the testing place in Roblox Studio on this machine and runs the tests there,
which is how the client's sections run and how a run can be watched:

```console
bunx flamework-cloud studio open                # from the cloud; or: studio open place.patched.rbxl
bunx flamework-cloud studio run                 # the server's sections, in a play session it starts and stops
bunx flamework-cloud studio run --realm client  # the client's
bunx flamework-cloud studio exec --code "return workspace.FlameworkTests:Invoke('economy').passed" --realm server
bunx flamework-cloud studio status | play | stop | close
```

It drives Studio through Roblox's own MCP proxy, so "MCP server" has to be enabled in Studio's
Assistant settings; a window without it is not listed. The commands drive the window with the
testing place open, or the only one with a local place file open (what `studio open <file>`
leaves), or whatever `--studio <name|id>` names, and say so when nothing matches. The place has to be closed in Studio while `publish`
runs, since Roblox refuses to save a version of an open place.


## Limits

| Limit | Value |
|---|---|
| Task creations | 5 per minute per key owner, whatever the number of keys |
| Task reads and log reads | 45 per minute |
| Concurrent tasks | 10 per place |
| Task duration | 300 seconds |

One task per run, so a test suite has to fit in five minutes of server time, and a loop that runs
the suite more often than every 12 seconds is throttled.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 PERMISSION_DENIED ... luau-execution-session ... missing` | The key lacks the task scopes for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio. Close it; the upload succeeds at once afterwards. |
| `429` | The five-per-minute creation limit. |
| Task `FAILED` with `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| Task `FAILED` with `Workspace.FlameworkTests did not appear` | The build was made without the `testing` scope active (`FLAMEWORK_SCOPES` in `.env`), so the plugin stayed inert. |
| Task `FAILED` with `... has no testing.entry` | The game's entry is a Script; give the config the ModuleScript that exports `ignite()`. |
| Task `COMPLETE` but `ok` is false with `unknown` names | A `--sections` entry matched no section or test. |
