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
        .includePlugin(TestingPlugin.fromPath("src/server/Tests"))
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
"testing": { "enabled": "${FLAMEWORK_TESTS:-false}", "entry": "src/server/main" }
```

Client tests cannot run in the cloud; there is no client. They run in Studio, through the same
bindable, with `scripts/studio/luau-tests.mjs --mode client`.

## Setup

1. An experience and a place to test in. Use a place of its own, never the live one.
2. An API key from the Creator Dashboard with, for that experience, `universe-places:write`
   (publishing) and `universe.place.luau-execution-session:read` and `:write` (tasks). Two
   settings cause most 401s: an IP allowlist narrower than `0.0.0.0/0`, and an expiry date.
3. The key in the environment, never in a file that is committed:

   ```ini
   # .env.local (gitignored)
   ROBLOX_API_KEY=...
   ```

4. The place and the project in `flamework.config.json`. This section is read by the CLI only
   and is never compiled into the place:

   ```jsonc
   "cloud": {
     "universeId": "10765968722",
     "placeId": "108973151455286",
     "apiKey": "${ROBLOX_API_KEY}",
     "project": "default.project.json"
   }
   ```

## Commands

```console
bunx flamework-cloud build                      # rojo build <project> -> build/place.rbxl
bunx flamework-cloud publish                    # upload as a Saved version; keeps the number
bunx flamework-cloud run [--sections a,b]       # run the tests against that version
bunx flamework-cloud test                       # the three above
bunx flamework-cloud run --list                 # what would run
bunx flamework-cloud run --code "return 1 + 1"  # any Luau, for a hypothesis about a real server
bunx flamework-cloud probe                      # what the task environment reports
```

`run` prints every log line the task produced, then a summary per section with each failure's
message, and exits non-zero when a test failed, a filter entry matched nothing, or the task
itself failed. `--json` prints the raw result table instead.

A version is published as `Saved`, which uploads it and gives it a number without making it live,
and the tests run against that number. Nothing here publishes to players.

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
| Task `FAILED` with `@flamework-experimental/testing is not in this place` | The build was made with `FLAMEWORK_TESTS` unset, or the package is not installed. |
| Task `FAILED` with `... has no testing.entry` | The game's entry is a Script; give the config the ModuleScript that exports `ignite()`. |
| Task `COMPLETE` but `ok` is false with `unknown` names | A `--sections` entry matched no section or test. |
