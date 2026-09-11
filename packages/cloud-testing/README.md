# @flamework-experimental/cloud-testing

Runs a place's Flamework tests where the engine is real, from a terminal or CI. Two ways:

- **Cloud**: publishes what Rojo built to a *testing place* and runs the tests inside a real
  Roblox server through the Open Cloud Luau Execution API.
- **Studio**: opens that testing place in Roblox Studio on this machine and runs the tests there,
  server or client, driving Studio through its own MCP proxy.

The tests are `defineTests` sections from [`@flamework-experimental/testing`](../testing); this is
the CLI that gets them run and reads the result back. A copy of the original place can be patched
with the build first, so the tests see the assets that exist only in the original.

```console
bun add -d @flamework-experimental/cloud-testing
rojo build -o place.rbxl && bunx flamework-cloud test place.rbxl
```

Building is Rojo's job, so the CLI takes the file Rojo produced and does not wrap `rojo build`.
(Rojo does not create a missing output directory, hence a file in the project root; add
`*.rbxl` to `.gitignore`.)

## Settings

Flags first, then the shell environment, then `.env` and `.env.local` next to the nearest
`flamework.config.json`, then that file's `cloud` section, read the way the transformer reads it
(so it may use `${NAME}` itself). A `.env.local` holding `ROBLOX_API_KEY`, `TESTING_UNIVERSE_ID`
and `TESTING_PLACE_ID` is enough on its own; the section below is the same thing spelled in the
config. Everything is named *testing* so nothing confuses it with the original place.

```jsonc
"cloud": {
  "testingUniverseId": "10765968722",
  "testingPlaceId": "108973151455286",
  "apiKey": "${ROBLOX_API_KEY:-}",
  "originalPlace": "places/original.rbxl"   // optional, see Patching
}
```

```ini
# .env.local (gitignored)
ROBLOX_API_KEY=...
```

The key needs `universe-places:write` and `universe.place.luau-execution-session:read` and
`:write` for the testing experience. This section is read by this CLI only and is never compiled
into the place. `--testing-universe`, `--testing-place`, `--key`, `--original` and the variables
`TESTING_UNIVERSE_ID`, `TESTING_PLACE_ID`, `ROBLOX_API_KEY` and `ORIGINAL_PLACE` override it;
prefer the environment for the key, a flag lands in the shell history.

## Cloud commands

| Command | Does |
|---|---|
| `publish <file> [--published] [--original <rbxl>]` | Uploads the place Rojo built (patched first when an original is named) to the testing place as a Saved version, and records the version number in `build/version.json`. |
| `run [--version N] [--sections a,b] [--list] [--timeout 120s] [--json]` | Submits the test shim against the recorded version, waits, prints the task's log and a summary, exits non-zero on any failure. |
| `run --code "<luau>"` / `run --script <file>` | Runs arbitrary Luau instead of the shim and prints what it returned: a hypothesis about a real server, answered in a minute. |
| `test <file> [--original <rbxl>]` | `publish` the file, then `run`. |
| `patch <file> --original <rbxl> [--out <path>]` | Lays the build over a copy of the original and writes the result, without publishing. |
| `probe` | Reports what the task environment looks like from the inside. |

`--dry-run` prints the request a command would send, key never included. Flags may come before
or after the command.

## Studio commands

Every one of these needs "MCP server" enabled in Studio's Assistant settings, which is what makes
a window appear on the proxy. They drive the window that has the *testing place* open, found by
its place id; with none, the only window with a local place file open, which is what
`studio open <file>` leaves; `--studio <name|id>` names any window instead. When nothing
matches they say so, and list what is open.

| Command | Does |
|---|---|
| `studio open [file]` | Opens the testing place from the cloud in a new Studio window and waits for it to connect; with a file, opens that local place instead. |
| `studio close` | Closes the window that has the testing place open. |
| `studio status` | Edit or play, and which data models exist. |
| `studio play` / `studio stop` | Starts or ends a play session. |
| `studio exec --code "<luau>"` / `--script <file>` `[--realm edit\|server\|client]` | Runs Luau in the chosen data model and prints what it returned. |
| `studio run [--realm server\|client] [--sections a,b] [--list] [--json] [--keep]` | Runs the tests in a play session, starting one if needed and stopping it afterwards unless `--keep`, and reports like `run`. |

```console
bunx flamework-cloud studio open                    # the testing place, from the cloud
bunx flamework-cloud studio run                     # the server's sections
bunx flamework-cloud studio run --realm client      # the client's, which the cloud cannot reach
bunx flamework-cloud studio close

bunx flamework-cloud patch place.rbxl --original original.rbxl
bunx flamework-cloud studio open place.patched.rbxl # the patched place, locally, no publish
bunx flamework-cloud studio run --sections assets
```

The place must be closed in Studio while `publish` runs: Roblox refuses to save a version of a
place that is open (`409 Server is busy`).

## Patching a copy of the original place

A game's assets often live only in the place itself, and a Rojo build has none of them. Save a
copy of the original from Studio (File > Save to File) and name it with `--original`,
`ORIGINAL_PLACE` or `cloud.originalPlace`; `publish` and `test` then lay the build over a copy of
it and upload that. `patch` does the same without uploading, so the result can be opened with
`studio open <file>`.

What the patch does is read from the Rojo project file (`--project`, default
`default.project.json`), so it changes exactly what a build would:

| In the project file | In the patched place |
|---|---|
| A node with `$path` | The build's instance replaces the original's, whatever was under it. That is the fresh code. |
| A node with only `$className` | The original's instance is kept, with everything it holds. When the original has none, the build's is taken. |
| `$properties` | Applied, typed from the reflection database: booleans, numbers, strings, enums, `Vector3`, `Vector2`, `Color3`. |
| Everything else in the original | Untouched. |

The patch prints one line per change it made and anything it skipped. It runs under
[Lune](https://lune-org.github.io/docs), which reads and writes place files; without `lune` on the
path (or `LUNE_EXE`) a command given an original stops before uploading anything.

## What runs in the cloud

A task loads the place but runs none of its Scripts, so the shim requires the testing package's
own cloud module, which ignites the game from the ModuleScript `testing.entry` names in the
config, waits for `Workspace.FlameworkTests`, invokes it and returns the result as JSON. See
[Testing in the cloud](../../docs/testing/place.md) for the setup on the game's side, the
limits, and what each error means.

## Limits

Five task creations a minute per key owner, 45 task and log reads a minute, ten concurrent
tasks per place, 300 seconds per task. One task per run.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 PERMISSION_DENIED` naming a scope | The key lacks that scope for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio; `studio close` it and publish again. |
| `429` | The creation limit. |
| Task `FAILED`: `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| Task `COMPLETE` but `Workspace.FlameworkTests did not appear` | The place was built without the `testing` scope active (`FLAMEWORK_SCOPES` in `.env`), so the plugin stayed inert. |
| `no Studio window has the testing place ... open` | Nothing has it open, or the window has "MCP server" disabled and so is not listed. |
| `lune is needed to patch the original place` | Install Lune (rokit or aftman) or set `LUNE_EXE`. Nothing was uploaded. |

## Development

`bun test tests` runs the suite with a mocked `fetch`, a fake Studio proxy and fake processes;
nothing reaches the network, Studio or Lune. `bun run typecheck` runs `tsc --noEmit`. The CLI
runs under Bun.
