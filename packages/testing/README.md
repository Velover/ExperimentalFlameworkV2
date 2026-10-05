# @flamework-experimental/testing

Tests that run inside a real place, and the CLI that runs them. Two halves in one package:

- **The roblox-ts side** (`out/`): `defineTests`, `test`, `test.skip` and `test.concurrent`,
  `defer`, `scratch`, `skip`, the `expect*` assertions, and `TestingPlugin`, which hosts the
  sections on `Workspace.FlameworkTests` (a BindableFunction) and `Workspace.FlameworkTestsServer`
  (a RemoteFunction) under the `testing` scope. How to write the tests is in the guide's
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
bunx flamework-test test place.rbxl --show                # open Studio where you can see it
bunx flamework-test test place.rbxl --fail-on-skip        # a skipped test fails the run
bunx flamework-test test place.rbxl --keep-awake          # keep the display on while it runs
bunx flamework-test test place.rbxl --concurrency 1       # concurrent tests one at a time
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

Studio may run the Luau its MCP server executes in a sandboxed thread (it did from 2026-10-01; on
2026-10-05 it did not), and the host and the CLI work either way. A sandboxed thread may only
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

A skipped test (`skip(reason)` or `test.skip`) is not a failure, and is shown all the same: each
realm's summary counts it (`9 passed, 0 failed, 1 skipped`) and lists it with its reason
(`- name (skipped): reason`), and a run under several projects ends with each project's count
(`projects: default passed (1 skipped), ...`). `--fail-on-skip` makes any skip fail the run, for
CI that must run everything: a section with a skip heads `FAIL`, and with `--json`, whose `ok` no
skip makes false, one line on stderr says the skips failed the run. A place built with
2.0.0-alpha.5 or earlier reports no skips, and `--fail-on-skip` then passes it with a note in the
summary (none under `--json`); an
older CLI against a newer place leaves skips out of its summary, and never fails on one. See
[Skipped tests](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md#skipped-tests).

Tests marked concurrent (`test.concurrent`, or a section defined with `{ concurrent: true }`) run
alongside each other in the place, up to `testing.concurrency` at once (4 by default); a plain test
always runs alone. `--concurrency <n>` overrides that limit for a run (`1` runs every test alone).
The summaries and `--json` keep the tests in the order they started (declaration order, or a
`--sections` list's), and `--list` marks the concurrent ones. A place built before concurrent tests
ignores the flag, and the summary says so.
See [Concurrent tests](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/guide/12-testing.md#concurrent-tests).

`--keep-awake` asks Windows to keep the display on from the start of the run to its end, and lets
go when the run ends, Ctrl+C included. While the display is off the engine renders nothing:
`RenderStepped` stops, and with it `onRender`, which fails client tests that wait for a frame in a
run nobody watches. A minimized Studio window still renders. It is off by default, changes no power
setting, and does nothing (saying so) anywhere but Windows. See
[Unattended runs](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md#unattended-runs-keep-the-display-on).

### Hidden windows

On Windows, `test` opens Studio on a hidden desktop of its own, `flamework-test`, so a run never
shows a window or takes the focus: not its splash, not its main window, not a dialog. Every run and
project uses that one desktop, `--parallel` windows included. `--show` opens the windows on your
desktop as before, and so do `FLAMEWORK_TEST_SHOW=1` and `"testing": { "showWindows": true }`,
after the flag. `studio open` always shows its window, since looking at it is what it is for.
Anywhere but Windows nothing is hidden, and the flag changes nothing.

- **The same run.** The MCP proxy reaches a hidden window as any other, the play session runs, and
  the client renders: a screen capture of one shows the scene. A hidden window costs what a shown
  one does. Both render at Studio's own frame-rate cap (240 frames a second, measured on a 144 Hz
  display), with about 1.2 cores busy while a play session idles, 0.8 to 0.9 in edit mode, a fifth
  of the GPU's 3D engine, and 3.1 to 3.3 GB at most (2026-10-05). A minimized window would render
  at 60 and cost about half, but it draws no 3D scene, which a test could tell, so nothing is
  minimized.
- **A window that never connects** may be showing a dialog nobody can see there (a login, an
  update, a crash report). The error says so: run again with `--show` to see it.
- **`--keep` leaves the window hidden.** Windows moves no window from one desktop to another, and a
  window is kept mostly to be driven: `studio exec`, `run`, `call screen_capture` and the rest
  reach it there, and `studio close` closes it. To look at a kept window, run with `--show --keep`.
- `studio lock` and `studio list` say which windows are on the hidden desktop. The desktop is
  Windows' to remove once its last window has closed and no flamework-test holds it.

How `test` handles Studio windows:

- It takes the [Studio lock](#the-studio-lock) before it launches Studio, so that one
  flamework-test command uses Studio at a time on this machine (its one window, or a
  `--parallel` run's several), and waits while another project's window or run holds it. It holds
  the lock across all its projects, and frees it once its last window has closed.
- A window whose title shows that very file is from an earlier build and would test stale code, so
  it is closed first: asked, then ended after ten seconds. The title decides. A window since saved
  elsewhere or retitled is left open, like every window of another file, whatever its name. A
  window on the hidden desktop, which only flamework-test opens, is matched by the command line it
  was started with too, and ended without asking.
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
  window-name claim, frees the Studio lock, removes the patch's temp folder, stops lune and the MCP
  proxy, and lets go of the `--keep-awake` request. A Ctrl+C while it waits for the lock leaves
  nothing to clean up. It runs
  nothing more (not the other realm, not the next project) and ends on one line naming what it
  cleaned up and what it left; the CLI's own process exits 130. A second Ctrl+C exits at once,
  however soon it comes, naming what may be left. Through the `flamework-test` bin (and so
  through a package script) the shell gets its prompt back at once, with the bin's own Ctrl+C
  status rather than 130, and the cleanup's lines follow a few seconds later; to wait for them, run
  `bun node_modules/@flamework-experimental/testing/cli/src/cli.ts ...` yourself (not from a
  package script). See [Ctrl+C](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/docs/testing/place.md#ctrlc).

| Command | Does |
|---|---|
| `test <file> [--realm server\|client\|both] [--sections a,b] [--list] [--json] [--keep [--hold <minutes>]] [--show] [--original <rbxl>] [--concurrency <n>] [--fail-on-skip] [--keep-awake] [--lock-timeout <seconds>]` | The above, on the hidden desktop unless `--show`. `--keep` prints the window's `studio_id=<id> pid=<pid>` line, and keeps one project's window only. |
| `test <file> --project <a.project.json> [--project <b.project.json>]` | The above once per project, each in a place made under that project's `$properties`; see [Running under several Rojo projects](#running-under-several-rojo-projects). |
| `test <file> --project <a> --project <b> --parallel [n]` | Up to n projects' windows side by side (no number: 2; at most 4, and no more than there are projects), each project's lines printed together, in project order; see [Side by side](#side-by-side). |
| `test <file> --cloud` | The cloud run instead, see below. |
| `patch <file> --original <rbxl> [--out <path>]` | Lays the build over a copy of the original and writes the result, without running anything. |
| `patch <file> --project <file> [--out <path>]` | Sets the project's `$properties` on the build and writes that, `place.<project>.rbxl`; with an original, patches a copy of it under that project. |

## Studio commands

These are the pieces `test` is made of, for driving a window by hand, and a way to call any of
Studio's MCP tools. They act on:

- the window flamework-test opened for this project (`studio open`, `test --keep`);
- if there is none, for `studio status` only, the window that has the *testing place* open (found
  by its place id), and if there is none, the only window with a local place file open;
- or whatever `--studio <name|id>` names.

A command that changes a window, with none of this project's open, says so (and, when another
project closed this project's last window, or found it closed, what became of it) rather than take
another window only to refuse it. Only the testing-place lookup needs the testing place's ids. When
nothing matches, they say so and list what is open. On Ctrl+C, `studio run` stops the session it
started, `studio open` stops waiting and leaves the window, and the Luau of `studio exec` or a
`studio call` runs on in Studio.

**Which windows a command may change.** `close`, `play`, `stop`, `exec`, `run` and `call` act
only on the window flamework-test opened for this project, the one the [Studio lock](#the-studio-lock)
records. The project is the nearest folder holding a `flamework.config.json`, else the nearest
holding a `package.json`, else where the command runs, so every folder of a game speaks for it. The
window is known by its MCP id and the place it was launched on (its file's name, or the testing
place's id), so an id the proxy has since given another window is not taken for it. Any other window
is refused before anything is sent to it, naming the window and `--any-window`: the user's own
windows, one opened by hand or by an older flamework-test, and another project's flamework-test
window, whose run or agent may still be using it. This project's window is refused too while a
command of this project run by another process is running in it (`test`, `test --keep`, a
`studio open` still waiting for its window to connect), or between two of its windows, naming that
run: `test` closes its window when it ends, and `test --keep` and `studio open` leave it to this
project then. `--any-window` acts on the window anyway; use it on a window the user has open only
once the user has said so. `status`, `list`, `tools` and `lock` read, and work on any window.

| Command | Does |
|---|---|
| `studio open [file] [--hold <minutes>] [--json]` | Takes the Studio lock, opens the testing place from the cloud in a new Studio window (with a file, that local place) and waits for it to connect. Prints its MCP id on a line of its own, `studio_id=<id> pid=<pid>`, or JSON with `--json`. A window that never connects is closed again. While this project's window is open, it refuses, naming that window: use it, or `studio close` it first. |
| `studio close` | Closes the window flamework-test opened for this project, by its Studio process (even when the proxy no longer lists it), without asking, as `test` closes its own (asking only raises a save prompt), checks it is gone, and frees the Studio lock. While a command of this project run by another process (`test`, `test --keep`, `studio open`) is using that window, it refuses, naming that run. With `--any-window`, another window, found by its title: when several windows have that title, none is closed. A window still running after the forced close is reported with its PID, and the command fails. |
| `studio status` | Edit or play, and which data models exist. |
| `studio play` / `studio stop` | Starts or ends a play session. |
| `studio exec --code "<luau>"` / `--script <file>` `[--realm edit\|server\|client]` | Runs Luau in the chosen data model and prints what it returned. |
| `studio run [--realm server\|client\|both] [--sections a,b] [--list] [--json] [--keep] [--concurrency <n>] [--fail-on-skip] [--keep-awake]` | Runs the tests in a play session, starting one if needed and stopping it afterwards unless `--keep`, without opening or closing anything. |
| `studio list [--json]` | The windows the MCP proxy reaches: each one's id and place, whether flamework-test opened it (and for which project), whether it holds the Studio lock, and whether it is on the hidden desktop, under a line on the lock. Studio processes the proxy reaches none of are named, with the setting that is probably off. |
| `studio tools [name] [--json]` | The tools Studio's MCP proxy offers, read live from it, so the list is what this Studio has: each one's name and the first line of its description. With a name, its whole description and its arguments (a JSON schema). |
| `studio call <tool> [json-args \| --args-file <file>] [--studio <id>] [--out <dir>] [--json]` | Calls any tool. `studio_id`, which every tool but `list_roblox_studios` takes, is filled in from `--studio` (else this project's window); a `studio_id` in the arguments names the window the same way, and is refused the same way. A tool whose arguments have no `studio_id` is sent without a window only when it is known to act on none (`list_roblox_studios`), else only with `--any-window`, since which window it acts on cannot be told. Text is printed; images are written to files in `--out`, by default `<temp>/flamework-test/captures`, named by their type (`screen_capture` answers a JPEG: `.jpg`), and each path printed; `--json` prints the raw answer. A tool's error exits 1 with its message, without the Studio Assistant's own locations. `studio call <tool> --help` is `studio tools <tool>`. |
| `studio lock [--json] [--check-window]` | Who holds the Studio lock (project, command, since, last use, when its hold runs out), whether its command still runs, each window it has open or is opening (place, Studio PID, whether that process still runs, whether it is on the hidden desktop, MCP id), and whether the lock is live, expired or stale. With `--check-window`, whether each window is on the MCP proxy too: not asked unless wanted, since starting a proxy joins the hub other clients share. |
| `studio unlock [--force]` | Frees a stale lock, and an expired one, closing its window (flamework-test's only). Refuses a live one, naming the holder and when its hold runs out; `--force` closes that window too. |

```console
bunx flamework-test studio open                     # the testing place, from the cloud
bunx flamework-test studio run --realm client       # the client's sections in it
bunx flamework-test studio close
```

Studio may run `execute_luau` sandboxed, through `studio exec` or `studio call` alike (it did from
2026-10-01; on 2026-10-05 it did not). Sandboxed, a snippet has no `require` of the place's
modules, no `_G` or `shared`, no DataStore; under a refusal of that kind (`lacking capability`, a
bindable that is not Sandboxed) the CLI adds a line saying the snippet ran sandboxed. Code that
reaches the game through a Sandboxed bindable, as the test host does, works either way.

## The Studio lock

One flamework-test command uses Studio at a time on this machine, across projects and agents: its
one window, or the several of a `test --parallel`. `test` and `studio open` take the lock before
they launch Studio; a cloud run opens no window and takes nothing. The lock is a folder,
`studio-lock`, in a per-user folder every project and agent shares: `%LOCALAPPDATA%\flamework-test`
on Windows (`~/Library/Application Support/flamework-test` on macOS,
`$XDG_STATE_HOME/flamework-test` or `~/.local/state/flamework-test` elsewhere), never the temp
folder, which an agent's harness may set per agent. `FLAMEWORK_TEST_STATE_DIR` moves it. Every
project has to agree on it, so set it in the shell, never in a project's `.env`: flamework-test does
not read it from the `.env` files next to `flamework.config.json`, but Bun loads a `.env` (and
`.env.local`) from the folder a command runs in before flamework-test starts, and one there would
move the lock for the commands run from it. The folder holds a record of who took it: the CLI's PID,
the project directory, the command, since when, its last use and when its hold runs out, and every
window the command has open or is opening, each with its place, its Studio PID once launched and its
MCP id. The window-name claims live beside it, and the notes of windows closed for another project.

- **How long.** A command holds it while it runs, window or not: `test` keeps it from its first
  project's window to its last (with `--parallel`, several of them open at once), and frees it once
  it has closed its last window, and so does its Ctrl+C cleanup. `test --keep` and `studio open`
  leave the window open on purpose, holding the lock, until `studio close`, or until the window
  closes any other way. A window that a command did not mean to leave open (a second Ctrl+C, a
  killed process) is closed by the next command that opens a window, at once, and that command says
  so.
- **The hold.** A window flamework-test left open may sit unused for 15 minutes (`--hold <minutes>`
  on `studio open` and `test --keep`, `FLAMEWORK_TEST_LOCK_HOLD`, `testing.lockHold`). Every
  command that uses it renews that: `studio status`, `play`, `stop`, `exec`, `run` and `call`, and
  a running `test` all along. Once the hold has run out, the next command that opens a window, or
  `studio unlock`, closes it the way flamework-test closes its own (by the Studio process it
  launched, never another), says so in one line, and takes the lock. The owner's next command on
  that window says it was closed after so many minutes idle, and to open it again.
- **Stale.** A lock whose command has ended and whose Studio process has exited (closed by hand,
  say), or whose PID is another process now (told by its name and start time), or whose command
  ended with no window open, is taken over by the next command, which says so in one line. No
  command is needed to free it. Studio's own lock beside the place file (`place.rbxl.lock`), which
  a Studio that was ended leaves behind, is removed when it names that window's process, and the
  owner gets a note: its next command says its window has closed, and to open it again, rather than
  not finding it.
- **Waiting.** A command that finds the lock held says once who holds it (project, command, place,
  PID, since), then again about every minute, and waits up to 300 seconds (`--lock-timeout
  <seconds>`, `FLAMEWORK_TEST_LOCK_TIMEOUT`, `testing.lockTimeout`; 0 does not wait). Then it
  exits 1, naming the holder and how the lock gets freed. Ctrl+C during the wait exits 130, holding
  nothing. 300 seconds outlast another agent's test run, and leave room for a run of its own within
  the ten minutes an agent's tool call allows at most.
- **This project's own window.** A window this project's `studio open` or `test --keep` left open:
  `test` of the very file it has open closes it, as a window left from an earlier build, and takes
  the lock. Anything else that would open a window while it is open refuses at once, naming it,
  rather than wait for itself. While a command of this project is still running in another process
  (another agent's `test`, say), a command that would open a window waits for it instead, as for
  any other project.
- **Seeing it.** `studio lock` says who holds it and whether it is live, expired or stale;
  `studio list` heads with it.
- **Several windows.** A `test --parallel` holds the lock for every window it opens, in one record.
  `studio lock` lists each (`window 1 of 2:`, with its place, Studio PID and MCP id, and
  `--check-window` asks the proxy about each), and `studio list` marks each as holding the lock.
  Every rule holds per window: the lock is stale only once every window it names has gone; a run
  cut short leaves its windows to the next taker, which closes every one of them (and removes the
  `.rbxl.lock` Studio left beside each one already gone); a window that would not close stays in
  the record, by its own Studio process and place file, for the next taker to close. `studio
  close` closes all of this project's, or the one `--studio <id>` names.
- **Older CLIs.** A window opened by flamework-test 2.0.0-alpha.6 or earlier, or by hand, holds no
  lock: a command does not wait for it, and it is not this project's window. 2.0.0-alpha.6 kept its
  window-name claims in `<temp>/flamework-test`; this version keeps them in the folder above and
  does not look there, so an alpha.6 run and this one opening a file of the same name at the same
  moment do not see each other's claim. A claim alpha.6 left behind is harmless: only alpha.6 reads
  it, and takes it over once its process has gone.

## From a coding agent

Every tool of Studio's MCP server is reachable through the CLI, with no MCP server configured in the
agent's own harness:

```console
bunx flamework-test studio open place.rbxl          # prints: studio_id=<id> pid=<pid>
bunx flamework-test studio list                     # the windows, and which one is this project's
bunx flamework-test studio tools                    # what Studio offers; studio tools <name> for one
bunx flamework-test studio call get_studio_state --studio <id>
bunx flamework-test studio call screen_capture --studio <id> --args-file capture.json
bunx flamework-test studio close                    # closes it and frees the Studio lock
```

- Put a tool's arguments in a file and pass `--args-file`: a shell may strip the quotes inside an
  argument (Windows PowerShell does).
- `test` opens its window on a hidden desktop (Windows): nothing shows, and the user's focus is
  left alone. `test --keep` leaves it there, where the studio commands drive it (`studio call
  screen_capture` included). `studio open` shows its window.
- `refusing to ... the Studio window ...` means the window is not the one flamework-test opened for
  this project. Open your own with `studio open`. Use `--any-window` on a window the user has open
  only after asking the user. ``refusing to ... this project's Studio window ...: `test` is running
  in it`` (or `test --keep`, `studio open`) means another process's run is using it: wait for that
  run to end. `no Studio window flamework-test opened for this project is open` means what it says:
  `studio open` one.
- `waiting for the Studio lock` means another project's window is open; the line says whose, and
  until when its hold runs. Never close a window you did not open: ask the user, or wait.
- `... "MCP server" setting is probably off` means Studio runs but its MCP server does not: ask the
  user to turn it on in Studio's Assistant settings, then retry.

### How much to run

A Studio run takes minutes, and every project on the machine queues behind it for the Studio
lock. Run what the change can break:
- **Docs, comments, a name inside one file:** the build (`rbxtsc`), and no Studio run.
- **One feature:** its sections only: `--sections <section>`, plus `--realm` when one realm is
  enough.
- **Shared code:** the sections of that code and of what uses it directly.
- **The whole run, every Rojo project (`--project`), cloud runs and benchmarks:** only when the user
  asks, or after you suggest it, saying why and how long it takes, and the user agrees.

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
| `cloud run [--version N] [--sections a,b] [--list] [--timeout 120s] [--json] [--concurrency <n>] [--fail-on-skip]` | Submits the test shim against the recorded version, waits, prints the task's log and a summary, exits non-zero on any failure (and, with `--fail-on-skip`, on a skip). |
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
4. that file's `cloud` section, and the CLI's own keys in its `testing` section, read the way the
   transformer reads them (so they may use `${NAME}` themselves).

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

Two switches, off by default, follow the same order: `--fail-on-skip`, `FAIL_ON_SKIP`, then
`"testing": { "failOnSkip": true }`; and `--keep-awake`, `KEEP_AWAKE`, then
`"testing": { "keepAwake": true }`. A variable reads `true` or `false` (`1`, `0`, `yes`, `no`, `on`,
`off`; empty is off), and `--fail-on-skip=false` or `--keep-awake=false` turns one off for a run.
The [Studio lock](#the-studio-lock)'s two numbers do too: `--lock-timeout`,
`FLAMEWORK_TEST_LOCK_TIMEOUT`, then `"testing": { "lockTimeout": 300 }` (seconds); and `--hold`,
`FLAMEWORK_TEST_LOCK_HOLD`, then `"testing": { "lockHold": 15 }` (minutes, one at least: a window in
use renews its hold every 30 seconds). So do `--parallel`: `FLAMEWORK_TEST_PARALLEL`, then
`"testing": { "parallel": 2 }` (a whole number, 1 or more), and `--show`: `FLAMEWORK_TEST_SHOW`,
then `"testing": { "showWindows": true }` (a switch, as above; see [Hidden
windows](#hidden-windows)). A cloud run reads neither variable nor key. Only the CLI reads them; the
place ignores them. The four config keys need a `@flamework-experimental/transformer` released after
2.0.0-alpha.7, whose schema has them.

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
before running or uploading anything. A lune that hangs is stopped, saying so: `lune --version`
after a minute, the patch after five.

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
its own heading. Every project runs even after one fails, but for a window that would not close: it
is still open, and keeps its place among the windows the run has open at once (one, or
`--parallel`'s n), so the projects that would need another are not run, and fail saying why. The
output ends with `projects: deferred passed, streaming FAILED`, and the exit code is the worst of
them.

- `--project` may be repeated or comma-separated.
  `ROJO_PROJECT=tests/deferred.project.json,tests/streaming.project.json` in `.env` does the same
  without the flags, and `ROJO_PROJECT=` turns it off again.
- With no project named, the run is the plain one: the build as it is, or laid over the original
  when one is named, following `default.project.json`.
- A chosen project needs `lune` even without an original. The build was made by `rojo build` from
  `default.project.json`, so the project's properties have to be set on a copy.
- `--timeout`, the hang report and every other flag apply to each project's run.

### Side by side

`--parallel [n]` runs up to n projects' windows at once (`--parallel` alone: 2), started in
project order, the next as soon as a project's window has closed. A framework tested under several
configurations then costs about what the slowest windows do, not the sum: this repository's four
projects took 7 min 20 s one after another and about 5 min with `--parallel 2` (2026-10-05).

- Each window takes about 3 GB with its play session, which runs a server and a client (2.8 to 3.1
  GB measured): two windows need about 6 GB free, four about 12. At most 4 run at once, whatever is
  asked (saying so), and never more than there are projects. `FLAMEWORK_TEST_PARALLEL`, then
  `"testing": { "parallel": 2 }`, set it after the flag; 1, the default, runs them one after
  another.
- The lines read as a run one after another prints them: each project's lines together, lune's
  included, in project order. While a later project runs, short lines on stderr say how it is
  getting on (`[deferred] connected: ...`, `[deferred] passed in 2 min; its lines follow
  default's`). `--json` prints on stdout what a run one after another prints, in the same order.
  What taking the Studio lock says (a wait, a window closed) is among the lines of the project that
  took it.
- A project that fails (a window that never connects, a realm that errs or hangs) fails alone,
  among its own lines; the others run on. The `projects:` line and the exit code are as ever.
- One run holds the [Studio lock](#the-studio-lock) for all of its windows, all on the one hidden
  desktop unless `--show`, and Ctrl+C closes every one of them. `--keep` still keeps one project's
  window only, and a cloud run refuses `--parallel`: every project's cloud run publishes to the one
  testing place.
- Windows that share the machine share its time: each project's realms took up to 2.6 s longer than
  one after another (35 to 39 s on the server, 30 to 31 s on the client), its window was open about
  10 % longer, and no test failed in two runs of `--parallel 2` (2026-10-05).

The tree still comes from the build. A project chosen for a run changes what the place's services
and containers are *set to*, not what Rojo synced into them. To test a different tree, build with
that project (`rojo build tests/big.project.json -o big.rbxl`) and run that file.

Inside the place, `getProject()` from `@flamework-experimental/testing` returns the name of the
project the place was made under (`deferred`), or `undefined` in a place the CLI did not make. A test
can use it to assert what that project changes, or to `skip(reason)` under the others, which the
summary lists (a plain `return` would count as a pass). The run result
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
| `RobloxStudioBeta.exe was not found` / `StudioMCP.exe, Roblox Studio's MCP proxy, was not found` | Studio is not installed here; set `ROBLOX_STUDIO_EXE` / `STUDIO_MCP_EXE`, or run in the cloud with `--cloud`. |
| `... never showed up on the MCP proxy` | The window opened but "MCP server" is disabled in Studio's Assistant settings, or, on the hidden desktop, it is showing a dialog nobody can see there (a login, an update, a crash report): run again with `--show` to see which. `studio open` and `test` close it again (`test --keep` leaves it). |
| `could not start ... on the hidden desktop flamework-test (CreateProcessW: error N)` / `could not make the hidden desktop` | Windows refused the hidden launch; `--show` opens Studio on your desktop instead. |
| `Roblox Studio is running (...), but the MCP proxy reaches none of them` | The same setting, off in every running Studio: turn it on, then retry. |
| `waiting for the Studio lock, held by flamework-test for <project> ...` | Another project's flamework-test window is open; the command waits for it (see [The Studio lock](#the-studio-lock)). |
| `the Studio lock is still held after waiting 5 min` | It still was: wait longer (`--lock-timeout`), ask whoever uses it to `studio close` it, or wait for its hold to run out. `studio lock` shows it. |
| `this project's Studio window is still open: ...` | This project's `studio open` or `test --keep` window holds the lock: use it (`--studio <id>`), or `studio close` it first. |
| `refusing to <do something to> the Studio window ...: flamework-test did not open it for this project` | The window is the user's, another project's, or from an older flamework-test. `--any-window` acts on it anyway, with the user's go-ahead. |
| ``refusing to <do something to> this project's Studio window ...: `test` is running in it`` (or `test --keep`, `studio open`; or `is running for this project ... with no window open right now`) | A command of this project, run by another process, is using the window, or is between two of its windows. `test` closes its window when it ends; `test --keep` and `studio open` leave it to this project then. Wait for it; `studio lock` shows it. |
| `no Studio window flamework-test opened for this project is open` | A command that changes a window found none of this project's, and does not take another in its place. `studio open` one; `--studio <id>` names another, which needs `--any-window` and the user's go-ahead. |
| `refusing to call <tool>: it takes no studio_id` | The tool's arguments name no window, so which one it acts on cannot be told. `--any-window` sends it anyway, with the user's go-ahead. |
| `the Studio window flamework-test opened for this project ... was closed at ... after 16 min idle` | Another project took the Studio lock once the window's hold had run out. Open it again; `--hold` keeps a window longer. |
| `the Studio window flamework-test opened for this project ... has closed: closed by hand, or Studio exited; flamework-test for ... found it so` | The window closed (by hand, or Studio crashed) and another project took the lock over. Open it again. |
| `the server's run failed: Workspace.FlameworkTests did not appear within 30 seconds` | The place was built without the `testing` scope active (`FLAMEWORK_SCOPES=testing` for that build), so the plugin stayed inert. The other realm still runs, and reports the same. |
| `the server's run failed: The current thread cannot invoke 'FlameworkTests' since 'FlameworkTests' has additional values for the Capabilities property: ...` | Studio ran MCP code sandboxed, as it may, and the place was built with 2.0.0-alpha.5 or earlier, whose host does not make its bindable Sandboxed. A later CLI marks it before the invoke while Studio allows that; this error means it could not, or the CLI is that old too. Update the package and rebuild the place; a later CLI says so under the error. |
| `MISS matched nothing in any realm: ...` | A `--sections` entry names no section or test in any realm that ran: a typo, or a section whose provider is not registered. |
| `the client's run did not finish within 120s (--timeout)` | A test is stuck past `testing.timeout`, or the host never started; the next line names the last test that reported (`PASS`, `FAIL` or `SKIP`), and the one after it in that section is the hanging one (if that section runs concurrent tests, which report as each ends: any of them that has not reported). |
| `(skipped): RenderStepped doesn't fire: the display may be asleep` | The PC's display was off, so the engine rendered nothing; run with `--keep-awake`. |
| `1 skipped, which fails the run under --fail-on-skip` (with `--json`, on stderr: `1 skipped on the client, ...`) | A test skipped under `--fail-on-skip` (or `FAIL_ON_SKIP`, `testing.failOnSkip`); the summary names it and its reason, under a section that heads `FAIL`. |
| `FAIL_ON_SKIP must be true or false` / `KEEP_AWAKE must be true or false` / `FLAMEWORK_TEST_SHOW must be true or false` | The variable holds something else: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`, or empty for off. |
| `--keep-awake is for Studio runs` / `--show is for Studio runs` | A cloud run has no display or window on this machine; drop the flag. |
| `--parallel is for Studio runs` | Every project's cloud run publishes to the one testing place, so they run one after another; drop the flag. |
| `note: --parallel 6 is more than the 4 Studio windows flamework-test opens at once` | It runs 4 at a time: each window takes about 3 GB. |
| `[deferred] passed in 2 min; its lines follow default's` (stderr) | Not a problem: under `--parallel`, a project that has ended waits for the ones before it to print theirs, so each project's lines stay together. |
| `not run: the Studio window of default would not close, and this run opens no more than one window at once (--parallel)` | That window is still open, after the line naming it (`... is still open`): close it by hand or with `studio close`, then run the projects that were not run. |
| `no Studio window has the testing place ... open` | Nothing has it open, or the window has "MCP server" disabled and so is not listed. `studio list` shows what is. |
| Ctrl+C under `bun run` left Studio open and printed no `interrupted by Ctrl+C` line | The script runs the CLI's file with `bun` directly, and `bun run` ends that process at once; call the `flamework-test` bin. The next `test` of that file closes the window. |
| After Ctrl+C the prompt came back at once, and the `interrupted by Ctrl+C` line came after it | Expected through the bin: its shim ends at once and the CLI cleans up after it. Run the CLI's file with `bun` to wait for it. |
| `a cloud run needs "testing": { "entry": ... }` | The cloud needs the ModuleScript that ignites the game; Studio does not. |
| `403 PERMISSION_DENIED` naming a scope | The key lacks that scope for this experience. |
| `409 Conflict: Save failed. Server is busy` on publish | The place is open in Roblox Studio; `studio close` it and publish again. |
| `429` | The creation limit. |
| Task `FAILED`: `@flamework-experimental/testing is not in this place` | The package is not installed, or nothing the entry module imports includes `TestingPlugin`. |
| `lune is needed to patch the original place` / `to set the properties of the project ...` | Install Lune (rokit or aftman) or set `LUNE_EXE`. Nothing was run or uploaded. |
| ``` `lune --version` did not answer within 1 min ``` / `the patch did not finish within 5 min, and lune was stopped` | lune hung, and was stopped: check that `lune --version` answers in that shell; `flamework-test patch` runs the patch alone. Nothing was run or uploaded. |
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
