# @flamework-experimental/cloud-testing

Publishes a place and runs its Flamework tests inside a real Roblox server, through the Open
Cloud Luau Execution API, from a terminal or CI. The tests are `defineTests` sections from
[`@flamework-experimental/testing`](../testing); this is the CLI that gets them run in the cloud
and reads the result back.

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
(so it may use `${NAME}` itself). A `.env.local` holding `ROBLOX_API_KEY`, `UNIVERSE_ID` and
`PLACE_ID` is enough on its own; the section below is the same thing spelled in the config.

```jsonc
"cloud": {
  "universeId": "10765968722",
  "placeId": "108973151455286",
  "apiKey": "${ROBLOX_API_KEY:-}"
}
```

```ini
# .env.local (gitignored)
ROBLOX_API_KEY=...
```

The key needs `universe-places:write` and `universe.place.luau-execution-session:read` and
`:write` for the experience. This section is read by this CLI only and is never compiled into
the place. `--universe`, `--place`, `--key` and the variables `UNIVERSE_ID`, `PLACE_ID` and
`ROBLOX_API_KEY` override it; prefer the environment for the key, a flag lands in the shell
history.

## Commands

| Command | Does |
|---|---|
| `publish <file> [--published]` | Uploads the place Rojo built as a Saved version, and records the version number in `build/version.json`. |
| `run [--version N] [--sections a,b] [--list] [--timeout 120s] [--json]` | Submits the test shim against the recorded version, waits, prints the task's log and a summary, exits non-zero on any failure. |
| `run --code "<luau>"` / `run --script <file>` | Runs arbitrary Luau instead of the shim and prints what it returned: a hypothesis about a real server, answered in a minute. |
| `test <file>` | `publish` the file, then `run`. |
| `probe` | Reports what the task environment looks like from the inside. |

`--dry-run` prints the request a command would send, key never included. Flags may come before
or after the command.

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
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio; close it and publish again. |
| `429` | The creation limit. |
| Task `FAILED`: `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| Task `COMPLETE` but `Workspace.FlameworkTests did not appear` | The place was built without the `testing` scope active (`FLAMEWORK_SCOPES` in `.env`), so the plugin stayed inert. |
| Task `FAILED`: `... has no testing.entry` | The game's entry is a Script; the config needs the ModuleScript that exports `ignite()`. |

## Development

`bun test tests` runs the suite with a mocked `fetch`; nothing reaches the network.
`bun run typecheck` runs `tsc --noEmit`. The CLI runs under Bun.
