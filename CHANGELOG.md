# Changelog

Notable changes to the `@flamework-experimental` packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Upgrade notes

- **`studio close`, `play`, `stop`, `exec` and `run` act only on the window flamework-test opened
  for this project.** Any other window is refused before anything is sent to it, naming the window
  and `--any-window`: a window the user opened (the testing place's included), one opened by
  flamework-test 2.0.0-alpha.6 or earlier, and another project's flamework-test window. A script
  that drives such a window needs `--any-window`. Without `--studio` they act on this project's
  window, and with none of this project's open they say so, where 2.0.0-alpha.6 took the window
  with the testing place open, or the only one with a local place file open (`studio status` still
  does).
- **This project's own window is refused while another process's command of this project uses
  it.** `studio close`, `play`, `stop`, `exec`, `run` and `call` refuse, naming that run, while a
  `test`, `test --keep` or `studio open` run by another process (another agent, a second shell) is
  running in the window or between two of its windows, where 2.0.0-alpha.6 acted on it mid-run.
  Once that run has ended, the window it left open (`--keep`, `studio open`) is this project's to
  use. `--any-window` acts on it anyway.
- **`studio close` ends this project's Studio process without asking.** 2.0.0-alpha.6 asked the
  window to close (`CloseMainWindow`) and ended it only when it did not close within ten seconds;
  now the window flamework-test opened is ended at once, by its Studio process, as `test` ends its
  own: asking only ever raised Studio's "Save changes?" prompt, and nothing a run makes is kept. A
  change made by hand in that window is lost without a prompt. A window closed with `--any-window`
  is still asked first.
- **`studio open` takes only the window it launched.** A window of that place or file listed before
  the launch is never taken for it, where the first one listed was before. A window that never
  shows up on the MCP proxy is closed again (it was left open), and a second `studio open` while
  this project's window is open refuses, naming it.
- **Studio runs of two projects on one machine take turns.** `test` and `studio open` wait up to 300
  seconds for the Studio lock while another project's window holds it, then fail naming it;
  `--lock-timeout 0` fails at once instead. `test --keep` under several projects is refused: one
  window is kept at a time.
- **`testing.lockTimeout` and `testing.lockHold` need the next transformer.** Its schema has them;
  2.0.0-alpha.7 refuses a `flamework.config.json` with them. The flags and the variables need
  nothing.
- **The window-name claims moved out of the temp folder,** to the per-user folder the Studio lock
  lives in (`%LOCALAPPDATA%\flamework-test` on Windows). A claim 2.0.0-alpha.6 left in
  `<temp>/flamework-test` is not looked at; only alpha.6 reads it, and takes it over once its process
  has gone. Running alpha.6 and this version side by side is not supported: alpha.6 takes no lock.
- **`studio call` of a tool whose arguments have no `studio_id` needs `--any-window`,** except
  `list_roblox_studios`, which acts on no window: which window such a tool acts on cannot be told.
- **`testing.concurrency` needs the next transformer.** Its schema has it; 2.0.0-alpha.7 refuses a
  `flamework.config.json` with it. `--concurrency` and a run's `concurrency` option need nothing.
- **`testing.parallel` needs the next transformer.** Its schema has it; 2.0.0-alpha.7 refuses a
  `flamework.config.json` with it. `--parallel` and `FLAMEWORK_TEST_PARALLEL` need nothing.
- **`test` no longer shows its Studio windows (Windows).** It opens them on a hidden desktop of
  their own, so a run never pops up a window or takes the focus. `--show`, `FLAMEWORK_TEST_SHOW=1`
  or `"testing": { "showWindows": true }` opens them where they are seen, as before. `test --keep`
  leaves its window hidden, driven by the studio commands; `--show --keep` keeps one to look at.
  `studio open` still shows its window.
- **`testing.showWindows` needs the next transformer.** Its schema has it; 2.0.0-alpha.7 refuses a
  `flamework.config.json` with it. `--show` and `FLAMEWORK_TEST_SHOW` need nothing.
- **A window that will not close keeps its place.** A run of several projects whose window would not
  close no longer opens the next project's window beside it: the projects that would need one more
  window than the run opens at once (one, or `--parallel`'s n) are not run, and fail saying why.
- **Packed layouts change for some types** (with `networking.serialization`, for `Serialized`
  members, and in `Flamework.createSerializer`): every order on the wire now follows from the types
  alone.
  - A literal union's values are numbered in sorted order: numbers by value, then strings, then
    `false` and `true`, then Roblox enum items by name. That includes a union of some of a Roblox
    enum's items.
  - A TypeScript `enum` keeps its 2.0.0-alpha.7 layout: its members, the whole enum or some of them
    (`Rarity.Epic | Rarity.Rare`), are numbered in the order the enum declares them, which is the
    order they already had. Only a union that mixes them with plain literals, or the members of
    several enums, changes: the plain literals come first, sorted, then each enum's members as
    declared, the enums by name.
  - An object made by a mapped type (`Record`, `Pick`, `Omit`, `Partial`, `Readonly`, `Required`,
    `{ [K in U]: ... }`), or holding a field one made, sends its fields in name order.
  - The members of a union that is not written out where the value is reached (a generic's type
    argument, as in `Box<A | B>`, or a generic alias's instance) are numbered by their types, after
    the written ones. A union written as a member of another (`type Choice = Pair | Gamma`) keeps
    its own written order there.

  A server and its client build together, so a game only has to rebuild. A buffer stored with
  `createSerializer` under 2.0.0-alpha.7 or earlier, in a DataStore say, that holds one of these
  types may read wrong or not at all. Read such data with the old build and save it again with the
  new one, or store a version next to each buffer and keep the old reader for the old version.
  Before this release these orders could already change between two builds after an unrelated edit
  (they followed whichever literal or type TypeScript happened to create first), so a stored buffer
  holding them was never safe across builds.
- **A union whose members only TypeScript's internal ids could put in an order stops the build,**
  such as two interfaces of one name from two files, imported under other names and reached through
  a generic (`Box<SameA | SameB>`). Declare an alias for the union where the value is declared, and
  its written order numbers them.

### core

#### Added

- **Instructions for a coding assistant ship in core,** in `docs/ai/`, next to the guide, so they
  match the installed version. `flamework.md` holds the rules every project follows. A project's
  `CLAUDE.md` loads it, in every session, with the line
  `@node_modules/@flamework-experimental/core/docs/ai/flamework.md`. It sends the assistant to the
  file for an area before it works there: `providers.md`, `components.md`, `networking.md`,
  `testing.md` and `plugins.md`, the last for a plugin or a package that other games install. A
  place gets one more empty Folder for them, `core.docs.ai`, as it does for the guide.
- **`TestingRuntimeConfig.concurrency`,** the type of the compiled `testing.concurrency` key that
  testing reads.

### testing

#### Added

- **The Studio lock: one `flamework-test` command uses Studio at a time on the machine,** across
  projects and agents, with its one window or a `test --parallel`'s several. `test` and `studio
  open` take it before they launch Studio. It is a folder in a per-user folder every project and
  agent shares, never the temp folder, which an agent's harness may set per agent:
  `%LOCALAPPDATA%\flamework-test` on Windows (`~/Library/Application Support/flamework-test` on
  macOS, `$XDG_STATE_HOME/flamework-test` elsewhere), or `FLAMEWORK_TEST_STATE_DIR`, which every
  project must agree on: set it in the shell, never in a project's `.env` (Bun loads the `.env` of
  the folder a command runs in, which would move the lock for the commands run from there). It holds
  who took it: the CLI's PID, the project, the command, since when, and every window the command has
  open or is opening (its place, its Studio PID, its MCP id), each judged on its own. A command that
  finds it held says whose once and then every minute, and waits up to `--lock-timeout` seconds
  (`FLAMEWORK_TEST_LOCK_TIMEOUT`, `testing.lockTimeout`; 300 by default), then fails naming the
  holder and how it is freed; Ctrl+C during the wait exits 130 holding nothing. A command holds it
  while it runs: `test` across all its projects, freeing it once its last window has closed (Ctrl+C
  included); `test --keep` and `studio open` leave it to the window they leave open, until `studio
  close`. A lock whose command has ended and whose Studio process has exited, or whose PID is
  another process now (by name and start time), is taken over with one line; Studio's own lock file
  beside the place, when it names that dead window, is removed, and the owner's next command says
  its window has closed (closed by hand, or Studio exited) and who took the lock over. A window a
  command cut short left open is closed by the next taker at once. Every change to the lock is made
  under a short sub-lock of its own, so a renewal never lands on another command's record; the
  sub-lock names its process and is broken only once that process has gone, so a slow holder is
  waited for, never overwritten. What a killed process left set aside beside the lock is removed by
  the next taker.
- **A hold on a window left open.** It may sit unused for 15 minutes (`--hold <minutes>` on `studio
  open` and `test --keep`, one at least; `FLAMEWORK_TEST_LOCK_HOLD`, `testing.lockHold`), renewed
  by every command that uses it and all along a running `test`. Past it, the next command that
  opens a window closes it, by the Studio process flamework-test launched and never another, says so
  in one line, and takes the lock; the owner's next command on that window says it was closed, after
  how long idle, and to open it again. Such a note is shown until the project takes the lock again.
- **`studio open` prints the window's MCP id** on a line of its own, `studio_id=<id> pid=<pid>`, and
  as JSON with `--json`; `test --keep` prints the same line.
- **`studio list`**: the windows the MCP proxy reaches, with each one's id and place, whether
  flamework-test opened it and for which project, and whether it holds the lock. Studio processes
  the proxy reaches none of are named, with the setting that is probably off.
- **`studio tools [name]`**: the MCP proxy's tools, read live (`tools/list`); with a name, its whole
  description and input schema. `--json` for both.
- **`studio call <tool> [json-args | --args-file <file>]`**: calls any of Studio's MCP tools, with
  `studio_id` filled in from `--studio` (else this project's window); a `studio_id` in the arguments
  names the window the same way and is refused the same way. A tool whose arguments have no
  `studio_id` is sent without a window only when it is known to act on none (`list_roblox_studios`,
  tried again while a new proxy joins the hub), else only with `--any-window`. Text is printed;
  images (`screen_capture`) are written to files (`--out <dir>`, by default
  `<temp>/flamework-test/captures`, outside the project) and their paths printed; `--json` prints
  the raw answer. A tool's error exits 1 with its message, without the Studio Assistant's own
  locations; a snippet that Studio's sandbox refused (Studio may run MCP code sandboxed; it did from
  2026-10-01) gets a line saying so, through `studio exec` too. `studio call <tool> --help` is
  `studio tools <tool>`. So an agent without Studio's MCP server in its own harness can use every
  tool.
- **lune is given a timeout:** `lune --version` one minute, the patch five. A lune that hangs is
  stopped, and the run fails saying so, rather than holding the run (and, between two projects, the
  Studio lock) for as long as the CLI lives.
- **`studio lock` and `studio unlock`.** `studio lock` names the holder (project, command, since,
  last use, when its hold runs out, and each of its windows: place, Studio PID, MCP id), whether its
  command and each window's Studio process still run, and whether the lock is live, expired or
  stale; `--check-window` also asks the MCP proxy whether each window is on it, which is not done
  unasked, since starting a proxy joins the hub other clients share. `studio unlock` frees a stale
  or expired lock, closing an expired window; a live one is refused, naming the holder and when its
  hold runs out, unless `--force`, which closes that window (flamework-test's only).
- **Concurrent tests, opt-in.** `test.concurrent(name, body)` registers a test that may run
  alongside others, and `defineTests(name, { concurrent: true }, body)` makes every test that body
  registers concurrent (`defineTests(name, body)` is unchanged). Tests start in the order they were
  declared (a `--sections` list naming a section's tests in another order runs them in its own);
  consecutive concurrent tests in a section run together, up to `testing.concurrency` at once (4 by
  default; `RunOptions.concurrency` and `flamework-test --concurrency` override it for a run, and 1
  runs every test alone). A plain test is a barrier: it waits for the tests before it, runs alone,
  and the ones after it wait for it, as does the end of a section. A test marked with `test.skip`
  holds nothing up. Each test keeps its own timeout, scratch folder, `defer` order and `afterEach`
  hooks: one that fails fails alone, and one that overruns holds up only its own slot, until its
  timeout. `PASS`, `FAIL` and `SKIP` lines print as each test ends; the result keeps the tests in
  the order they started (declaration order, or a filter's), marks a concurrent test's result
  `concurrent: true`, and carries the run's limit as `concurrency`.
- **The test's context, `t`,** passed to every test body and `beforeEach` and `afterEach` hook:
  `t.name`, `t.section`, `t.concurrent`, and `t.defer`, `t.scratch` and `t.skip`, bound to that
  test, so they work from any thread it starts and raise once it is over. `defer`, `scratch` and
  `skip` work as before in a plain test, and raise in a concurrent one (whatever the limit), naming
  the context's: the runner cannot tell which test a thread belongs to. Exported types
  `TestContext`, `TestHook` and `SectionOptions`, and `DEFAULT_CONCURRENCY`.
- **`flamework-test --concurrency <n>`** (`test`, `studio run`, `cloud run`, `cloud test`): sent to
  the place as the run's `concurrency` option, a whole number, 1 or more, checked before anything
  opens. `--list` marks concurrent tests and counts them with the run's limit; the summaries and
  `--json` keep the order the tests started in. Against a place built before concurrent tests,
  which ignores the option, the summary says so (on stderr with `--json`); an older CLI against a
  newer place reads its results as before. A run that does not answer in time names the last test
  that reported, and adds that among concurrent tests the hanging one may be any that has not
  reported. It leaves that out only where the CLI knows none were in flight: under
  `--concurrency 1`, or for a realm after one that answered from a place before concurrent tests,
  or with a concurrency of 1 (the place's own `testing.concurrency`). Before any realm of the run
  has answered, it cannot know the place, and adds it.
- **`flamework-test test --parallel [n]`**: a run of several Rojo projects (`--project`,
  `ROJO_PROJECT`) runs up to n of their Studio windows side by side (`--parallel` alone: 2), in
  project order, a project starting as another's window closes; this repository's four projects took
  about 5 min rather than 7 min 20 s. At most 4 at once, and no more than there are projects (each
  window takes about 3 GB with its play session); also `FLAMEWORK_TEST_PARALLEL` and
  `testing.parallel`, after the flag, checked before anything opens; 1 by default. Each project's
  lines, lune's included, are printed together, in project order, as one after another prints them,
  with short progress lines on stderr for the projects waiting to print; what taking the Studio lock
  says is among the lines of the project that took it; `--json` prints the same stdout. A project
  that fails fails alone; the `projects:` line and the exit code are as ever. One run holds the
  Studio lock for all its windows, and Ctrl+C closes every one. `--keep` under several projects is
  still refused, and so is `--parallel` with `--cloud` (one testing place); the variable and the key
  are not a cloud run's.
- **Hidden windows: on Windows, `flamework-test test` opens Studio on a desktop of its own,**
  `flamework-test`, so a run never shows a window, a splash or a dialog, and never takes the focus;
  every run and project uses that one desktop, `--parallel` windows included. The launch calls
  `CreateDesktopW` and `CreateProcessW` through `bun:ffi` and returns the Studio PID as before. The
  MCP proxy reaches a hidden window as any other, and its client renders, at the same cost as a
  shown window (both at Studio's own frame-rate cap: about 1.2 cores while a play session idles, 3.1
  to 3.3 GB). Nothing on the user's desktop sees such a window, so each is found by its PID and the
  command line it was started with, its title read from the hidden desktop; it is closed by its
  process without asking, and the close of a window left from an earlier build matches a hidden one
  by its command line too. `studio lock` and `studio list` say which windows are hidden. A hidden
  window that never connects may be showing a dialog nobody can see, and the error says so, with
  `--show`. `--show` (`FLAMEWORK_TEST_SHOW`, `testing.showWindows`, after the flag; refused with
  `--cloud`, whose run reads neither) opens the windows where they are seen. `test --keep` leaves
  its window hidden, where `studio exec`, `call screen_capture` and `close` reach it. `studio open`
  always shows its window. Anywhere but Windows nothing is hidden.

#### Changed

- **A window that will not close keeps its place among a run's windows.** It is still open, so a run
  of several projects opens no other in its stead: no more windows are open at once than the run
  opens (one, or `--parallel`'s n), and the projects left that would need another are not run, each
  failing with `not run: the Studio window of <project> would not close`. Before, the next project
  opened its window beside the one that would not close.
- **Commands that change a window act only on the one flamework-test opened for this project**
  (`close`, `play`, `stop`, `exec`, `run`, `call`), compared by the project directory the lock
  records: the nearest folder holding a `flamework.config.json`, else the nearest holding a
  `package.json`, else where the command runs. The window is known by its MCP id and the place it
  was launched on, so an id the proxy has since given another window is not taken for it.
  `--any-window` acts on another. The refusal comes before any call to that window, names it and
  the flag, and says to ask the user before using the flag on a window they have open. This
  project's window is refused too while a command of this project run by another process (`test`,
  `test --keep`, `studio open`) is running in it or between two of its windows. With none of this
  project's open, they say so instead of taking another window to refuse. `status`, `list`,
  `tools` and `lock` read, and work on any window.
- **The MCP proxy is let go of in order:** its stdin is ended first, which ends an MCP stdio server,
  and its process only after two seconds if it has not exited, so that it can leave the hub other
  clients' proxies share.
- **The messages for Studio's "MCP server" setting are written for an agent.** A window
  flamework-test launched that never shows up on the proxy, and Studio running with no window on the
  proxy, both say the setting is probably off, to ask the user to turn it on in Studio's Assistant
  settings, and to retry. `StudioMCP.exe` not found says what the file is, where it was looked for,
  and to install Studio or set `STUDIO_MCP_EXE`.

### transformer

#### Added

- `testing.lockTimeout` and `testing.lockHold` in `flamework.config.json`'s schema: the Studio
  lock's wait (seconds) and hold (minutes), read by `flamework-test` alone and left out of the
  place's config, as `failOnSkip` and `keepAwake` are.
- `testing.concurrency` in `flamework.config.json`'s schema: the most concurrent tests that run at
  once, a whole number, 1 or more (4 by default). A key of the place's, compiled into
  `include/flamework/config.json` as `timeout` is.
- `testing.parallel` in `flamework.config.json`'s schema: how many Rojo projects' Studio windows
  `flamework-test test` runs side by side, a whole number, 1 or more (1 by default), read by
  `flamework-test` alone and left out of the place's config, as `lockTimeout` is.
- `testing.showWindows` in `flamework.config.json`'s schema: `flamework-test test` opens its Studio
  windows where they are seen rather than on a hidden desktop (false by default), read by
  `flamework-test` alone and left out of the place's config, as `keepAwake` is.
- **A build-time self-check of the generated serializer code.** A file whose code calls a field of
  its `codec` table that it never defines stops the build, naming the type (`Flamework's generated
  code for the type 'Pair' calls 'codec.w_Pair', which this file never defines.`), where the call
  would have failed at runtime as a call of nil. TypeScript does not see it: the table has an index
  signature.

#### Fixed

- **A watcher's rebuild on a roblox-ts newer than 3.0.0 no longer emits serializer code that uses
  `codec`, `vsize`, `vwrite` and `vread` without declaring them** (TS2304), nor crashes the watcher
  in `ts.copyComments`. Such a roblox-ts (`3.0.0-dev`, from master) hands a rebuild the same
  `SourceFile` for a file whose text did not change, and the serializer's generator, kept per
  `SourceFile`, took the earlier rebuild's table and helpers for emitted. Generators, `NodeMetadata`
  and the decorator cache are kept per transform pass now. roblox-ts 3.0.0 makes new `SourceFile`s
  for every rebuild and was not affected.
- **A sender and its receiver no longer disagree on a layout after a partial rebuild.** A literal
  union's indices, a mapped type's fields and the members of a union nothing spells out followed
  TypeScript's internal type ids, which follow whatever the checker happened to create first in a
  compilation. A watcher's rebuild, or an incremental build, that recompiles a call site without the
  files that decode it could then send `"rare"` as the index its receiver reads as `"common"`, or swap
  the fields of a `Record<"speed" | "power", number>`. On roblox-ts 3.0.0 a
  `const STARTER: Gear = { id: "starter", rarity: "rare" }` added to the call site's file was enough.
  See the upgrade notes.
- **A call whose target may be several packed members is refused when their argument lists (for
  `setCallback`, their results) are laid out differently on the wire,** naming two of them, such as
  `a(x: string | number)` and a `Serialized` `b(x: number | string)`: one TypeScript type, but each
  member's receiver numbers the union as its own declaration spells it. Such a call used to be packed
  as whichever member TypeScript listed first, since the types were assignable both ways, and the
  other member's receiver read the tags wrong. The layouts are what is compared now, so members laid
  out alike are packed together even when their types differ (`number & { unit?: "meters" }` against
  `number & { unit?: "seconds" }`, both eight bytes). Two members packed the same way whose types
  differ only in how a union is spelled are still one type to TypeScript, which keeps one of them in
  a conditional or a helper's inferred return type, so the build cannot see that case (guide 06,
  Caveats).
- A type whose hoisted functions fail to build is no longer left recorded, half built, for the file's
  next value to call, and the varint and check helpers count as there only once they are built. A
  build that met this already failed with the type's error.
- What a file's failed last statement hoisted no longer lands at the top of the next file
  transformed. Only `--writeTransformedFiles` showed it, on a build that failed anyway.

## 2026-10-02: core, networking and testing 2.0.0-alpha.6; transformer 2.0.0-alpha.7

Unchanged in this release: components 2.0.0-alpha.5 and transformer-plugin 2.0.0-alpha.3.

### Upgrade notes

- **Rebuild a place you test in Studio with testing alpha.6.** Since 2026-10-01 Roblox runs the
  Luau of Studio's MCP server sandboxed, and sandboxed code may only invoke a Sandboxed bindable,
  which the test host of a place built with alpha.5 or earlier is not: every Studio run of
  `flamework-test` failed with `cannot invoke 'FlameworkTests'`. A place built with alpha.6 makes
  it Sandboxed. Against an older build, the new CLI marks the bindable itself before invoking it,
  for as long as Studio allows that, and says to rebuild when it cannot.
- **Skips are counted apart from passes.** A test that calls the new `skip(reason)`, or is
  registered with `test.skip`, counts in `skipped`, not in `passed` (`RunResult.passed`,
  `SectionResult.passed`), and keeps `ok` true; a test that returns early still counts as passed.
  The `[FWTEST]` SUMMARY line reads `N passed, M failed, K skipped (…ms)`, where it read
  `N passed, M failed (…ms)`, and so do `flamework-test`'s section and realm summaries: anything
  that parses them, or reads `passed` as the tests that did not fail, takes `skipped` in.
- **`test` is a callable table**, since it carries `test.skip`. Calling it is unchanged; where only
  a function will do (`task.spawn(test, ...)`, `coroutine.wrap`), wrap it in one.
- **Transformer errors are labelled `@flamework-experimental/transformer`**
  (`error TS @flamework-experimental/transformer:`, was `@flamework-experimental/core`): a script
  that matches on the old label needs the new one.
- **A full build no longer reads the project's own `flamework.build`.** It only ever replaced it,
  so one cut short or holding a merge conflict is written anew instead of stopping the build. An
  incremental build still reads it, and stops on a broken one with a message saying what to do.
- **The new settings need transformer alpha.7.** `serialization.checks.types`,
  `testing.failOnSkip` and `testing.keepAwake` are in its schema; alpha.6 refuses a
  `flamework.config.json` with a key it does not know, so upgrade the transformer with the runtime
  packages.
- **A packed message with no Instance or blob in it leaves the empty list out.** An event sends
  `(payload)` instead of `(payload, {})`, and a function's request and result likewise. Both realms
  are built together and Flamework reads a missing list as empty, so nothing is needed; code of
  your own that reads a packed member's remote directly (a remote spy, a test counting arguments)
  sees one argument fewer.
- **Union members told apart by an enum item are tried in their written order**, and no longer
  warned about as members a value cannot tell apart. Each value is still written under its own
  member's tag, so nothing changes on the wire.

### core

#### Changed

- `provider ID was registered more than once` names both registrations, one per line below the
  id: what each is (`registerClassProvider(Shop)`, `registerProvider({ type: "function" })`,
  `provideInstance(value: Metrics)`, `class Shop, found by registerProviders("src/server")`), the
  module builder or the plugin, by name, that made it, the script and line that made it
  (`ServerScriptService.TS.main:12`; core's own frames are skipped), and its own scope
  conditions. A hint follows: for an id of `@rbxts/compiler-types` (`Set`, `Map`, `Array`, ...) it
  says that an id ignores type arguments, so `Set<A>` and `Set<B>` share one, and how to give one a
  type or an id of its own; otherwise it fits the two registrations (overlapping folders, a class
  registered twice, a value provided twice, two scoped registrations both kept). The line is taken
  with `debug.info` once per registration, at startup.

### transformer

#### Added

- `serialization.checks.types` (off by default): every value written at a packed call site or by
  `Flamework.createSerializer`'s `serialize` is tested to be of its declared type first. One that is
  not raises `[Flamework] number expected, got string, at 'move' [0].pos.x` instead of the buffer
  library's error with no field name; literals and enum items show the value
  (`Enum.Material.Plastic expected, got Enum.Material.Wood`). It follows `mode` and `side`. Under
  `"warn"` a wrong type still raises, except a value declared `boolean`, which is warned about and
  written as whether it is truthy. With it on, each field's write gets a block of its own, so a
  type at Luau's 200-local limit still loads. Off, the generated code is unchanged.

#### Fixed

- A union with a struct the Roblox API declares (`GroupInfo | number`) no longer fails the build
  with TS2345 at `typeIs(v, "GroupInfo")`: the member takes any value, as the type does alone, and
  is tried last.
- Union members told apart by an enum item (`{ key: Enum.KeyCode.A; … } | { key: Enum.KeyCode.B; … }`)
  are no longer warned about as members a value cannot tell apart, nor tried out of their written
  order. The union warning names an item as `Enum.KeyCode.A`, not `#212`.
- A literal empty list passed as a packed argument (`fire([])`, `invoke(player, [])`,
  `except([], [])`) no longer fails a strict build with TS7034/TS7005: it is bound as `never[]`,
  and so is an empty players list, which was bound with its parameter's type.
- A `flamework.build` that cannot be used no longer ends the build with a stack trace. An
  incremental build, a watcher's rebuild, or a package's file that is cut short, empty, not JSON or
  of the wrong shape stops the build with a message naming the file, what is wrong with it and what
  to do. A full build no longer reads the project's own `flamework.build`, which it only replaced,
  so one cut short or holding a merge conflict is simply written anew.
- Mistakes in the project's Flamework configuration stop the build with their message and no stack
  trace: a `flamework.config.json` that does not parse or validate, an unset variable, a value that
  does not convert, a `$` hash prefix in a game, and, on the tsconfig plugin entry, an option other
  than `transform` and `configFile`, or a `configFile` that is not a string or names no file.

#### Changed

- Transformer errors are labelled `error TS @flamework-experimental/transformer:` (was
  `error TS @flamework-experimental/core:`).

### networking

#### Changed

- A packed member (`networking.serialization`, or `Networking.Serialized*`) no longer sends an
  empty blob list. When the argument types can hold an Instance or another blob but the values sent
  hold none (an optional Instance left out, an empty `defined[]`), the event, the function request
  and the function's result carry the buffer alone (an event sends `(payload)` instead of
  `(payload, {})`; a request `(id, payload)`, a result `(id, true, payload)`), which saves the two
  bytes the empty table cost on every such message. Receivers already read a missing list as
  empty, and `Flamework.createSerializer`'s `serialize` still returns the list.

### testing

#### Added

- `skip(reason)`, called in a test's body or a `beforeEach`, stops the test and reports it as
  skipped with the reason: for what rules a test out only at run time (the realm, the project, a
  display that is asleep). `defer` callbacks and `afterEach` hooks still run, and one that raises
  fails the test. A `pcall` in the test that catches skip()'s error does not undo the skip. Calling
  it outside a running test, or from cleanup, is an error. Call it from the test's own flow: a
  thread that outlives its test and calls it marks whichever test is running then.
- `test.skip(name, body)` registers a test that is reported as skipped without running (reason
  "marked with test.skip"). It is listed and selected by filters like any other test.
- `TestResult.status` (`"passed" | "failed" | "skipped"`) and `skipReason`, a `skipped` count on
  `SectionResult` and `RunResult`, and the types `TestStatus` and `TestFunction`. A skip keeps `ok`
  true and leaves `RunResult.ok` alone.
- A `[FWTEST] <realm> <section>/<test>: SKIP (Nms): <reason>` line per skipped test.
- `flamework-test` shows skips: each realm's summary counts them and lists each skipped test with
  its reason, in Studio and cloud runs; a multi-project run's last line counts each project's
  skips, and `--list` marks `test.skip` entries.
- `--fail-on-skip` (or `FAIL_ON_SKIP`, `testing.failOnSkip`) on `test`, `studio run`, `cloud run`
  and `cloud test` makes any skip fail the run, and a section with a skip heads `FAIL`. With
  `--json`, which prints the place's result as it is (its `ok` counts no skip as a failure), one
  line on stderr, outside the JSON, says the skips failed the run. A place built with
  2.0.0-alpha.5 or earlier passes it, with a note in the summary (none under `--json`).
- `--keep-awake` (or `KEEP_AWAKE`, `testing.keepAwake`) on `test` and `studio run` asks Windows to
  keep the display on from the start of the run to its end: RenderStepped stops while the display
  sleeps, which fails `onRender` tests in unattended runs. Off by default; it changes no power
  setting, and is released at the end, on a failure and on Ctrl+C (and by Windows when the process
  exits). Other systems accept the flag and do nothing; `--cloud` refuses it. `testing.failOnSkip`
  and `testing.keepAwake` are read by the CLI only and are not compiled into the place.

#### Fixed

- `flamework-test`'s report of a run that hangs names the last test that reported even when its
  name has spaces (it said no test had reported), and counts SKIP lines.
- `flamework-test` runs a place's tests in Studio again. Since 2026-10-01, Studio runs the Luau of
  its MCP server (and its Assistant) sandboxed, and a sandboxed thread may only invoke a bindable
  that is Sandboxed itself, so every run failed with `cannot invoke 'FlameworkTests' since
  'FlameworkTests' has additional values for the Capabilities property`. The test host now makes
  `Workspace.FlameworkTests` Sandboxed with no capabilities; its callback keeps the host's own, so
  the tests run as before. For a place built with 2.0.0-alpha.5 or earlier, the CLI marks the
  bindable itself before invoking it, for as long as Studio allows that; when it cannot, the run
  says under the error to rebuild the place with this version.
- `flamework-test`: Ctrl+C (and Ctrl+Break) no longer leaves the Studio window it opened, its play
  session, the window-name claim in `%TEMP%\flamework-test`, the patch's temp folder or its child
  processes behind. The run stops waiting, cleans up through its normal end-of-run steps (`--keep`
  keeps the window and session; a session Studio is still starting is stopped once the start has
  finished) and ends on one line saying what it cleaned up and what it left. The CLI's own process
  exits 130 (149 for Ctrl+Break); through the bin the shell gets the shim's status at once and the
  cleanup's lines follow the prompt. A second Ctrl+C exits at once, naming what may be left. A cloud
  task already created runs on (Open Cloud cannot cancel one), and the line names it. A window that
  had already closed is named so, and a stop Studio keeps refusing gives up after about 40 seconds.

#### Changed

- `flamework-test` starts the MCP proxy and its PowerShell window scripts hidden in consoles of
  their own, and no longer blocks while closing or listing Studio windows.
- A run's `passed` counts passes alone (a skip is counted in `skipped`), and the `[FWTEST]` SUMMARY
  line and `flamework-test`'s section and realm summaries read `N passed, M failed, K skipped`,
  where they read `N passed, M failed`.

### Docs

- Guide 06, size on the wire: corrected. Roblox compresses only the `buffer` values a remote
  carries, each on its own; tables, strings, numbers and datatypes go out as they are. The alpha.4
  and alpha.5 guides said it compressed everything a remote carries.
- Guide 07, Serializers: rewritten for the current serializer (what `createSerializer` returns, the
  per-file `codec` table, what `deserialize` checks and what it does not).
- Guides 05, 06 and 12: the Rojo step matches the one-line mapping of the whole scope.
- The docs index describes guides 6, 7 and 9 as they are now.
- The package READMEs no longer carry the root README's paragraph for contributors, and the testing
  README's links point at GitHub, so they work on npm.

## 2026-10-01: core, components, networking and testing 2.0.0-alpha.5; transformer 2.0.0-alpha.6

### Upgrade notes

- **An optional brand of your own now selects its width.** `number & { __brand?: "u16" }` was
  written as an f64 without a word. It is now written at its width and checked like
  `Serialization.Implicit.u16`, which by default raises for a value that does not fit. A buffer
  `Flamework.createSerializer` wrote for such a type with an earlier release no longer reads.
  Brands of your own that share one property (`__brand?: "u8"` and `__brand?: "u16"`) do not mix
  with each other; give each width a property of its own, as `Serialization.Implicit` does. A brand
  of your own on `__brand`, strict or optional, is not a subtype of its `Serialization.Implicit`
  twin: the two inferred together (`[own, implicit]`) are a union, which
  `Flamework.createSerializer<typeof value>()` writes with a tag ahead of each value, and a generic
  `T` or a `Map` literal given both does not compile. Give the brand the twin's property too
  (`_flamework_u16?: "u16"`), or use the `Serialization` types.
- **A type that names two widths fails the build.** `number & { a: "u8"; b: "u16" }`, or
  `Serialization.u8 & Serialization.u16`, was written at whichever width the transformer found
  first (here a u8), without a word. It is now a build error naming the type and both widths: keep
  the width you mean. The same width named twice (`Serialization.u16 &
  Serialization.Implicit.u16`) is still that width.
- **A packed array is written by index, and a hole in it is refused.** Before, the count was
  `#array` but every nil was skipped: elements of a fixed size arrived one place early, with a zero
  (nil for a blob) in the last place, and elements whose size varies made a malformed payload the
  receiver dropped. An element type that takes nil (`Array<T | undefined>`, `unknown[]`) now writes
  the hole in its place; one that takes none raises at the sender, whatever `serialization.checks`
  says: `[Flamework] the array has no value at 'place' [0][2]`. A tuple's rest element works the
  same way.

### core

#### Added

- `Serialization.Implicit`: a twin of each of the 14 widths (`Implicit.u8` … `Implicit.buffer32`).
  It takes a plain value with no cast, is written exactly as its strict twin, and is checked where it
  is written. Implicit widths behave like plain numbers, strings and buffers: they mix with each
  other and take any strict width of their kind (an `Implicit.u8` goes into an `Implicit.u16` and
  back, and a strict `u32` goes into either), and a value is checked at the width it is written as.
  Like a plain value, an implicit one goes into a strict width only through a cast.

#### Changed

- Each width's brand is an optional property of its own (`_flamework_u16?: "u16"`), which each
  strict width carries next to its `__brand` as well: a strict value and an implicit one inferred
  together (`[strict, implicit]`, `flag ? strict : implicit`, one generic `T`) are the implicit
  twin, as a plain `number` and an implicit one are `number`. Hovers and `Modding.Target.Text` of
  an intersection that spells a strict width out show the extra property, and a macro reading the
  brand object's fields sees one more optional field.

### components, networking, testing

- Version only (no changes).

### transformer

#### Added

- `serialization.checks` in flamework.config.json: `category` (`"implicit"`, the default; `"all"`;
  `"none"`), `mode` (`"assert"`, the default, or `"warn"`, which writes the value anyway) and
  `side` (`"both"`, `"server"` or `"client"`). A value that does not fit is reported with its
  width, value and place: `[Flamework] u16 cannot hold 70000, at Tile.x` or `'place' [0].x`. Every
  generated write is covered: call sites, callback results, `Flamework.createSerializer` and the
  shared `codec` writers. A string or buffer longer than its length prefix is refused as it always
  was, under `warn` and `none` too. A failure calls one helper per file, kept in the file's `codec`
  table; a file without that table gets it, which is one local at the top of the file. With the
  defaults, a program without an implicit width compiles as before.

#### Changed

- An enum option given another value lists the allowed ones (`must be equal to one of the allowed
  values: "implicit", "all", "none"`).
- A declaration that hides a global the generated code cannot reach another way is now a build error
  naming the global and the declaration, instead of a TypeScript error in generated code or a silent
  call of the project's own value. This covers `typeIs`, the `Array`/`Map`/`Set` constructors and
  `Enum` at a call site, `buffer` declared at the top of the module, a module-level `warn` under
  `mode: "warn"`, and a hidden `globalThis`.
- A type that names two different widths (`Serialization.u16 & Serialization.Implicit.u8`,
  `number & { a: "u8"; b: "u16" }`, two implicit widths, or a brand of your own next to one) is a
  build error naming the type, as written where the serializer reaches its declaration
  (`'Serialization.u8 & Serialization.u16' names two widths, u8 and u16`, for a type TypeScript
  prints as `never`); before, the first brand found was used (see the upgrade notes). The same
  width named twice is that width, strict when any of its brands is required.

#### Fixed

- An optional brand was written as an f64 (see the upgrade notes).
- A networking argument typed `Serialization.buffer16` or `buffer32` was rejected by the receiving
  guard every time.
- TS2352 in generated code for a readonly tuple or an object with an index signature packed at a
  call site ("Conversion of type 'GridCoord' to type 'unknown[]' may be a mistake").
- A local named `buffer` around a send (`for (const [player, buffer, blobs] of …)`) broke the
  generated code (TS2339). The code now reaches the global through a module-level alias.
- A send inside `catch (error)` or `catch (math)` did not compile when its code called them
  (TS18046): unions, literals, fixed-length strings, decoders, `f32` union members and tuple rest
  counts. `math` now goes through an alias, and `error` is raised as `assert(false, message)`,
  with the same message from the same line.
- A project's own type named after a global type the generated code names (`Map`, `Set`,
  `defined`, `buffer`, `EnumItem`, `LuaTuple`, `CFrame`, the datatypes) took its place in that
  code; it now names the global through `globalThis`. A project's own `Record` or `Callback` type
  is no longer in the way.
- Field or type names no local can have (`arguments`, `eval`, `class`, `end`, `1st`) broke the
  generated code (TS1215, TS1389, syntax errors). Such a local is now `v_arguments`, and a
  deduplicated guard named after a global type no longer hides it.
- An array rest parameter (`many(...values: number[])`) could not be packed ("more arguments than
  the list has elements"). It is now sent as a count and the values, with any number of arguments,
  spread or not.
- An array with a hole was sent without it (see the upgrade notes).
- A brand literal named like an `Object.prototype` member (`toString`, `constructor`, `valueOf`,
  `hasOwnProperty`, …) was taken for a string width, in every published release: on a string or a
  buffer (`string & { __brand: "toString" }`) it crashed the build ("Cannot read properties of
  undefined (reading 'kind')"), and next to a number's brand it hid it
  (`number & { kind: "toString"; __brand: "u16" }` went out as an f64).
- A width literal of another kind no longer hides the width next to it: a number's brand is read
  among the number widths only, and likewise for strings and buffers.
  `number & { a: "u8_string"; b: "u16" }` was an f64 and is a u16;
  `string & { a: "u8"; b: "u16_string" }` had a varint length and is a string16.
- A second serializer error in one file listed the first error's "Reached through" chain ahead of
  its own.

## 2026-09-29: core, components, networking and testing 2.0.0-alpha.4; transformer 2.0.0-alpha.5; transformer-plugin 2.0.0-alpha.3

### Upgrade notes

- **A union with `number` has a new tag for whole numbers.** In such a union, a value from 0 to
  2^35 - 1 is written as a varint under a tag after the members. Both realms are built together, so
  remotes need nothing. A buffer that `Flamework.createSerializer` writes in this release raises
  "malformed payload" when an older build reads it. Buffers written by earlier releases still read.

### core

#### Added

- `requireModules("src/server/commands")`, a built-in macro for v1's `Flamework.addPaths` on a folder
  of modules that do their work as they load, such as commands that register themselves with a
  library. It requires every ModuleScript at and under the folder, in tree order, and returns what
  they export, leaving out the ones that export nothing; each module runs once, however often it is
  required. It takes the same source paths as `registerProviders` and works in any module of a game.
  A folder inside a registered folder needs no call: registration already requires every
  ModuleScript under it. A folder missing from the place raises
  `requireModules("..."): the folder is not in the place`, naming the part of the path that is
  missing, after waiting five seconds once the place has loaded; a folder of the other realm (a
  server folder on a client, a client folder on the server) raises at once and says which realm to
  call it from.
- The guide ships in the package, for the installed version: `docs/README.md` (the index) and
  `docs/guide/*.md`. Links between the pages stay relative; links to the rest of the repository
  (reference, testing docs, changelog, packages) point at GitHub. core's `prepack` makes the copy,
  so every `npm pack`, `bun pm pack` and publish carries the docs as they are. Rojo skips the
  Markdown, and a place gets two empty Folders for it, `core.docs` and `core.docs.guide`.

#### Changed

- A path registration whose folder is not there after five seconds (on a client, once the place has
  loaded) warns once per path, naming the registration and the missing child, and keeps waiting:
  `registerProviders("src/shared/components") is still waiting for its folder: the build put it at
  ReplicatedStorage/TS/components, and ReplicatedStorage.TS has no child named 'components' after 5
  seconds. ...`. `ComponentPlugin.fromPath`, `registerComponents` and a plugin's
  `registerProviders` name themselves the same way. `resolveRbxPath(path, caller?)` and
  `getClassesInPath(path, caller?)` take the call's name for macros of your own; without it the
  warning names no call.
- `requireModules("..."): the folder is not in the place` also names a misspelled path, one that
  differs in case from the folder, and an empty folder a clone does not have, as causes.

### networking

#### Added

- `Networking.Serialized<T>` (functions), `SerializedReliable<T>` and `SerializedUnreliable<T>`
  (events) pack one member into a buffer whatever `networking.serialization` says, exactly as the
  switch would: the encoding at each call site, the decoding in the handler metadata, a function's
  result after the middleware. With the switch on they change nothing on the wire.
  `Unreliable<Serialized<T>>` and `Serialized<Unreliable<T>>` are `SerializedUnreliable<T>`.
- `Networking.NetworkInfo`, the type of a middleware factory's second argument.

#### Fixed

- A call that may reach several members packed differently, through a helper that returns a member
  by name or through a conditional, was sent unpacked with no build error, so the peer dropped it. A
  function request was answered `BadRequest`, and a callback's result rejected with `InvalidResult`.
  - This happened with a `Serialized` member next to a plain one while `networking.serialization`
    was off, and with a packed member next to a `Raw` one, which also left the `Serialized` member
    unpacked with the switch on.
  - The cause: TypeScript reduced such a union to the one member type the others extend.
  - Senders and function receivers now carry how they are packed as a type argument of their own
    (the hidden `_flamework_packing`), so the union keeps each member and the transformer refuses
    the call. Members packed the same way still pack as one.
- An argument list with parameters after its rest (`(...args: [number, ...string[], boolean])`) was
  guarded as if they came before it, so a valid call with a non-empty rest was rejected. The generated guards now carry
  the parameters after the rest, and the runtime checks them against the last arguments.

### testing

#### Added

- The package ships a `default.project.json` that maps its `out` folder alone, so the CLI's sources
  it ships no longer arrive in every place as three empty Folders (`testing.cli`, `cli.src`,
  `cli.tasks`), under the whole-scope mapping and the per-package one alike.

#### Changed

- `flamework-test test` judges `--sections` across the realms it runs: an entry only one realm has
  no longer fails the other (`not among the client's sections: coin`), and an entry no realm has
  fails every realm and the run (`MISS matched nothing in any realm: coins`). Each realm's summary
  is printed once every realm has answered, so none says PASS for a run that then fails on its
  filter. With `--realm`, the one realm judges alone, as before.
- A realm whose call fails, such as a place without the test host, no longer stops the run: the
  other realm still runs, as the README always said. The error is printed as the snippet raised it
  (`the server's run failed: Workspace.FlameworkTests did not appear within 30 seconds: ...`),
  without the Studio Assistant's own locations in front of it; `studio exec` prints errors the same
  way.
- The window a run opened is closed by ending its Studio process at once. Asking never closed it:
  Studio marks a place file it opens as changed as soon as it has loaded it, so the ask only raised
  its save prompt, and every run waited ten seconds and printed `did not close when asked`. A window
  the run did not open (one left from an earlier build) is still asked first. Studio's lock file
  beside the place (`place.rbxl.lock`), which an ended Studio cannot remove, is removed when it names
  the process that was ended.
- A patch's plan and its Lune task go to a folder of the system's temp directory made for that patch
  alone and removed when it is done, instead of the game's `build/`: two patches started together in
  one folder read each other's plan, and applied the wrong project's properties without a word.
  What the CLI still writes into the project: the places it makes beside the build, and
  `build/version.json` from `cloud publish` (and so `cloud test` and `test --cloud`).
- `studio close`, `status`, `play`, `stop`, `exec` and `run` no longer demand the testing universe
  and place ids when the window is named with `--studio`, or is the only one with a local place file
  open.

### transformer, transformer-plugin

#### Added

- Each package ships a `default.project.json` that maps it to an empty Folder, so a game can map the
  whole `node_modules/@flamework-experimental` folder in one line
  (`"@flamework-experimental": { "$path": "node_modules/@flamework-experimental" }`): the
  transformer's three JSON schemas no longer arrive in the place as ModuleScripts. With an older
  transformer, keep mapping the runtime packages by name.

### transformer

#### Added

- A build warning when a union has members a value cannot tell apart: two members that could each
  take part of the other's values, such as two patches whose fields are all optional. It is given
  once per union type and file, where the union is first written, in the empty-glob warning's form,
  and names the union and the members. A union spelled through another alias or a generic is warned
  again. A value that fits both may be written as the first of them in the warning's order, without
  the parts only the others declare.
- A build warning at every path macro whose path the place will not have, or will have with no
  module in it (`registerProviders`, `ComponentPlugin.fromPath`, `registerComponents`,
  `requireModules`, a plugin's `registerProviders` and a game's own `Modding.Intrinsic<"path">`
  macros). Such a path compiled all the same, and the call waited for it at runtime with only the
  engine's "Infinite yield possible" to go on. The warning names the file, the line, the call and the
  path: `src/server/main.server.ts:6:3 - registerProviders("src/shared/nothing-here"): there is no
  such file or folder, so the place will not have it, and the call waits for it at runtime`, or, for
  `requireModules`, that the call raises after waiting five seconds. It is judged the way Rojo builds
  the place: from the deepest `$path` of the project that covers the path (a `$path` nested inside an
  out-mapped folder included), by the sources for a folder inside `out`, with names matched exactly
  below the `$path`, so a path that differs from the folder only in case is caught too and the
  warning gives the name on disk. A folder whose files are none of the modules Rojo makes (`.ts`,
  `.tsx`, `.lua`, `.luau`, `.json`, `.toml`, `.yaml`, `.yml`, model files) gets `nothing in that
  folder compiles to a module`: it arrives in the place empty, and a clone, which has no empty
  folder, lacks it. It is judged on every build and every rebuild of a watcher, as the empty-glob
  warning is, and never fails the build.
- A build error for a networking member declared both `Raw` and `Serialized`. It names the member,
  and is given wherever the member is sent or its callback registered, and in the metadata of any
  handler of its network.
- A build error for a networking call that may reach members packed differently. That is:
  - `Serialized` with plain, while `networking.serialization` is off;
  - `Raw` with a packed member;
  - packed members whose argument lists (for `setCallback`, whose results) are not the same type.

  The error names the call.

#### Changed

- Serialization: which union member a value is written as no longer depends on the written order
  alone. The members are tried in this order:
  - Members with a test of their own go first, in written order: a type, a literal, a discriminant,
    a key only they have.
  - The members checked by a guard follow. A member whose guard would take another member's value
    and write it without part of it (a key it does not declare, at any depth) goes after that member.
    Where two would each do that to the other, the written order stands, with objects whose fields
    are all optional last, and the build warns.
  - A blob that takes anything goes last.

  The tag is still the member's written position. When the last member tried is an object or a
  collection without a test of its own, it is only checked to be a table. So a charm-sync patch no
  longer walks its guard: a small patch serializes in about 5.5 µs instead of 10.
- Serialization: a branded number member of a union (`Serialization.u16` and the other widths, and
  `varint`) only takes a number that fits its width: in range and whole for an integer width, in
  range for `f32`. Any other number goes to the next member.
- Serialization: in a union with `number`, a whole number from 0 to 2^35 - 1 is a varint under a tag
  of its own, after the members. So 3 in `string | number` takes 2 bytes instead of 9, and so do
  array indices sent as map keys. Other numbers, and a `number` outside a union, stay f64.
- Serialization: a type with no name of its own that a file's values reach more than once now gets
  size, write and read functions, as a named type does, instead of being written out at every place.
  This covers objects, unions, tuples, arrays, sets and maps: a mapped or conditional type's instance,
  an object literal type, `string[]`, `Map<string, number>`. The bytes sent are the same. A
  game's charm-sync payload went from 5,277 lines (166 KB) to 3,367 lines (108 KB).
- Serialization: the size, write and read functions of every hoisted type in a file are fields of one
  table, `codec`, instead of three locals each.
- `Could not find Rojo data for '...'` adds what the path compiles to and that no `$path` in the Rojo
  project covers it, or that no Rojo project file was found.
- `TypeScript version differs` no longer tells you to run npm: it says to pin the version roblox-ts
  uses in your devDependencies (`"typescript": "5.5.3"`). The messages of a TypeScript mismatch that
  stops the build no longer name npm or npx either.
- `Project was compiled on different version of Flamework` names the tsbuildinfo to delete
  (`Delete out/tsconfig.tsbuildinfo and build again`) instead of the out directory, which did not
  help when the tsbuildinfo lives elsewhere, with forward slashes on every platform.
  `Flamework cannot be built in a dirty environment` names the file too, and is now a message like
  the version check's rather than an uncaught error with a stack trace.
- The `hashPrefix` description in the config schema says a game needs none: every package id starts
  with its package's prefix and a colon, which none of a game's own ids starts with.

#### Fixed

- Serialization: `Partial<Crate> | None` wrote every removal as an empty patch, so the receiver kept
  what was removed. The patch, whose fields are all optional, was written ahead of charm-sync's
  removal marker. A union member written ahead of another whose values its guard accepts lost data
  the same way:
  - a list or a map taken by a patch;
  - a map's value taken by an object;
  - `{ pos: { x, y, z } }` taken by `{ pos: { x, y } }` or by a map of `{ x }`;
  - `{ a, b }` taken by `{ a }`.
- Serialization: `u16 | number` wrote 70000 as a u16, which arrived as 4464.
- Serialization: a file with more than about 66 hoisted types compiled but did not load, because it
  went past Luau's limit of 200 locals.
- Serialization: a recursive type with no name of its own, such as a conditional patch type over a
  recursive interface, overflowed the stack at build time.
- An incremental build without a `tsBuildInfoFile` reuses `flamework.build`. TypeScript builds such a
  project incrementally into its default tsbuildinfo (`tsconfig.tsbuildinfo` beside the config with
  `"rootDir": "src"`), but Flamework only looked for `tsBuildInfoFile`, took every such build for a
  clean one, and made a fresh `flamework.build`: in the `short`, `tiny` and `obfuscated` id modes, a
  recompiled file then named a class of a file left alone by a new id (`alpha@Alpha{gj}` where
  `alpha.luau` still declares `alpha@Alpha{b5}`), and the dependency never resolved. Such a build
  now also stops after a Flamework upgrade, naming the tsbuildinfo to delete, as one with
  `tsBuildInfoFile` does.
- The guard of a tuple with a rest element, such as `[number, ...string[]]`, took the rest as one more
  element (`t.strictArray`), so it refused `[1]` and `[1, "a", "b"]`: a networking parameter of that
  type dropped valid calls, and next to an object whose fields are all optional in a serialized union
  such a value was sent as `{}`. It now takes the elements before the rest, any number of rest
  elements, and the ones after it.
- A tuple with elements after its rest element (`[number, ...string[], boolean]`,
  `[...string[], boolean]`) was serialized with those elements in the rest's place, and any non-empty
  rest raised. This affected `Flamework.createSerializer` and packed networking calls. The tuple is
  now written as the elements before the rest, then a count and the rest, then the elements after it.

### core, components, networking, transformer, transformer-plugin

#### Changed

- The README each package ships points its links to files the package does not ship at GitHub, so
  they work from `node_modules` and on npm; core's link to its own `docs/README.md` stays relative.

### core, components, networking, testing, transformer, transformer-plugin

#### Changed

- Each package.json links this repository, with the package's folder, plus its homepage and issues, so
  npm shows them on the package page. core and transformer pointed at the original v1 repositories.

### Docs

- Guide 06:
  - "Opting out per event" is "Opting in and out per event": the `Serialized` markers, their nested
    forms, the conflict with `Raw`, and the same-build rule;
  - size on the wire: Roblox already compresses what a remote carries, so packing is where the size
    win is, with Studio measurements; the unreliable limit is counted after that compression;
  - where to create the handlers: one `network.ts` per realm;
  - a throttle middleware typed for any event, and its function form returning `Networking.Skip`;
  - `Networking.NetworkInfo` in a middleware's unit test;
  - a helper that returns one of several members must not mix members packed differently;
  - which encoders the output holds (the `codec` table's writers).
- Guides 01, 03, 04, 05, 07, 09, 10 and 12:
  - when components attach (after every provider's `onStart`), and a component's own cleanup
    (`override destroy()`);
  - what a game commits and what it ignores;
  - pinning TypeScript to the version roblox-ts uses, and incremental builds across Flamework
    upgrades;
  - bun and pnpm work too;
  - a game needs no `hashPrefix`;
  - lookups take a decorated superclass only;
  - path registrations that wait or warn;
  - guide 12's test setup: the test script sets the scope, never `.env`, and rebuilds without it
    afterwards.
- Internals:
  - serialization per member and the marker check;
  - union call sites and `_flamework_packing`;
  - which receivers carry `_flamework_fn`;
  - the `tuple-guards` entry for elements after a rest;
  - the path checks, build info and the testing package.
- Guide 06:
  - how the union member a value is sent as is chosen, and when the build warns;
  - branded number members;
  - whole numbers in a union with `number`;
  - which wrong values raise at the sender and which do not: numeric strings, booleans, undeclared
    keys, a table sent as a union's last member, an array with holes, and NaN in a guarded number
    field;
  - in place of "Remote wiring is deferred by one frame", what a late listener misses:
    - a reliable event only past the engine's queue limit;
    - an unreliable one sent before the first `connect`;
    - under `Immediate` signals, one arriving right behind the event whose handler makes that first
      `connect`.

### Tests

- `Serialized` members:
  - in the Lune specs, in both builds of the specs (`FLAMEWORK_SPECS_SERIALIZATION`);
  - round trips between two realms;
  - the place's `packing` sections on both realms under every project.

  The place's switch can be flipped for a run with `FLAMEWORK_SERIALIZATION=false`, and the
  transformer fixture's with `FLAMEWORK_FIXTURE_SERIALIZATION=false`.
- Union call sites, for every mix of Raw, plain and Serialized members, with the switch on and off.
- Tuples with a rest element first, last and in the middle, round-tripped through `createSerializer`
  and through networking members, as one argument and as the argument list, in both builds of the
  specs.
- Path warnings for missing, empty, types-only and wrong-case folders, and silence for valid setups:
  - nested `$path`s;
  - a prefix that differs only in case;
  - JSON-only folders.
- Late folders in Studio.
- The incremental id fix.
- The testing CLI's section filter, realm failures, window close, lock removal and per-patch temp
  folders.
- The Studio place pins what a late listener misses, in both directions and under every project:
  reliable events wait for the first connection, unreliable ones are dropped, and one more is missed
  because Flamework starts listening a moment late under `Immediate` signals.

## 2026-09-27: core, components, networking and testing 2.0.0-alpha.3; transformer 2.0.0-alpha.4; transformer-plugin 2.0.0-alpha.2

### Upgrade notes

- **Path registration takes every class a module defines, exported or not, as v1 did.** A `@Provider()`
  or `@Component()` class declared at the top level of a module under a registered folder is now
  registered even if the module does not export it. Move a decorated class that must stay out of the
  module to a folder no module registers, or into the function that uses it. `core` and `transformer`
  have to come from this release together: with an older one of either, only exported classes are found.
- **`Dependency<T>()`, `module.resolveDependency<T>()` and a provider's constructor refuse a component
  at compile time.** v1 built any decorated class on demand; v2 resolves registered providers only.
  Make such a class a `@Provider()` (`{ lazy: true }` keeps v1's "built when first asked for"), or get
  the component from `Components`.
- **A path or glob registration whose own scope condition does not hold no longer loads its
  folder.** `registerProviders(path, { activeIn })`, the glob forms, a plugin target's forms and
  `ComponentPlugin.fromPath`/`fromGlob`/`registerComponents*` return before looking the folder up,
  so the top-level code of the ModuleScripts under it no longer runs in a build where the condition
  fails. A condition on the class or the module still lets the folder load, and so does one on
  `includePlugin` around `ComponentPlugin.fromPath`/`fromGlob`/`registerComponents*`: put it on the
  registration itself.
- **Transformer options go in `flamework.config.json` only.** The tsconfig entry takes `transform`
  and `configFile`, plus the plugin loader's own keys such as `import`; any other key fails the
  build, naming the key and saying to move it to the file or to remove it. Before, an option on the
  entry won over the file, so a game with `obfuscation: true` in the file and `false` on the entry
  (as a v1 entry often had) built unobfuscated. Move every transformer option on the entry
  (`obfuscation`, `hashPrefix`, `idGenerationMode`, `salt`, `noSemanticDiagnostics`,
  `optimizations`, `plugins`) to the `transformer` section, and remove v1's `preloadIds`.
- **A game's build writes to its `flamework.config.json` once.** It adds a `$schema` line when the
  file has none, and creates the file with only that line when `tsconfig.json` is at the package
  root and there is no file. Commit the change; after that the build leaves the file alone.

### core

#### Added

- `@Provider({ loadOrder })`, v1's ordering of `onInit` and `onStart` within one ignition: lower first,
  default 1, registration order among equals. A provider's dependencies are still constructed and
  initialised before it, whatever their `loadOrder`; `onStart` follows `loadOrder` alone, each on its
  own thread up to its first yield before the next. Lazy providers ignore it, per-frame events stay
  unordered, and an imported module still ignites first. A value that is not a finite number raises
  when the class's module loads.
- Path registration (`registerProviders`, `registerProvidersGlob`, the plugin target's forms,
  `getClassesInPath`, `getClassesInGlob`) finds the classes a module defines at its top level whether
  or not it exports them, each once. Classes are tied to the ModuleScript that defines them, so this
  holds in every `idGenerationMode` and with obfuscation on. A class declared inside a function is
  found only through its module's exports.
- A failed resolution of a class that has loaded says what the class is, where it is defined and what
  to do: a component (get it from `Components`, or make it a `@Provider()`), a `@Provider()` that
  nothing in the module registers or provides, or a class that is not a provider.
- `explainLeftOut`, `leftOutRegistration` and the `LeftOutRegistration` type, beside the other
  path-registration utilities: what a plugin that registers folders under a scope condition uses to
  say why a class under a left-out folder cannot be found.

#### Changed

- `getClassesInPath` also returns the classes a module does not export: each module's classes in
  definition order, then what it exports. `requireModulesInPath` is unchanged.
- Eager providers are constructed in ascending `loadOrder`; with none set, the order is unchanged.
- A path or glob registration whose own scope condition does not hold no longer touches its folder.
  `registerProviders`, `registerProvidersGlob` and a plugin target's forms of both return before
  looking the folder up (no `WaitForChild`) or requiring anything under it. The active scopes are the
  compiled `scopes.active`, so this leaves out exactly what ignition would have left out. A build can
  now drop such a folder from the place: a release build without its `Tests` folders, registered
  under `activeIn: ["testing"]` as the testing guide sets them up, no longer waits for them forever.
  The registration is recorded, and a lookup that misses a class under it names it:
  `'X' (...) is under registerProviders("..."), which is left out by its scope (...)`. When the class
  has not loaded, the message lists the module's left-out registrations.
- `getGlobPaths`'s error names its real causes: the include folder not in the Rojo project, a glob
  used inside a package, a string that did not come from a glob macro, or `globs.json` from another
  build. A glob that matched no files never raised it; it resolves to no paths.

#### Fixed

- `getClassesInPath` over a package folder returned a class twice when the package also re-exported
  it (`Components` from the components package).
- `out/index.d.ts` re-exported the stripped `@internal` hooks `__setActiveScopes` and
  `__setPathRoot`, so a plain `tsc` without `skipLibCheck` failed inside the package (TS2724). The
  re-exports are stripped as well; the Luau still exports them.

### transformer

#### Added

- Records each class with a Flamework identifier that is declared at the top level of its file, or of
  a namespace in it, against its module (`flamework:module`), for path registration.
- A compile error for `Dependency<T>()`, `module.resolveDependency<T>()` and a `@Provider()`
  constructor parameter whose type is a `@Component()` class that is not a provider.
- A build warning at every use of a glob that matches no files (`registerProvidersGlob`,
  `ComponentPlugin.fromGlob`, `registerComponentsGlob`, a plugin target's glob form, or a
  `Modding.Intrinsic<"pathglob">` macro), naming the glob and its file, line and column. The build
  still passes and the glob still resolves to no paths. A watcher checks again on every rebuild.
- A game's build gives its `flamework.config.json` a `$schema` line when it has none, so an editor
  lists every option with its description and default. The path is relative to the file and goes
  through the project's `node_modules/@flamework-experimental/transformer`. The line is added as the
  first key and every other byte is kept (indentation, line endings, comments). A game without the
  file gets one holding just the line, but only when its tsconfig is at the package root: below it, a
  created file would hide a shared one added there later. It happens when `rbxtsc` starts, not on a
  watcher's rebuilds; it never replaces an existing `$schema` and never runs for a package. A file
  that cannot be written gets a warning.
- Every option in `flamework.config.schema.json` states its default, and fixed defaults carry
  `default` (`plugins` and `optimizations` gained one).

#### Changed

- The tsconfig entry is checked, and the options come from `flamework.config.json` alone (no longer
  merged). Besides `configFile`, only the plugin loader's keys are allowed: roblox-ts's `transform`,
  `import`, `type`, `after`, `afterDeclarations`, and ts-patch's `name`, `transformProgram`,
  `isEsm`, `tsConfig`, `resolvePathAliases`. A transformer option on the entry fails with
  `Move '<key>' to the "transformer" section of <file>`; any other key with
  `Remove '<key>': not a transformer option`; a `configFile` that is not a string fails too.

#### Fixed

- `flamework.config.json` rejected `components.watchRenames`, which guide 09 documents and the
  components package reads; the schema now accepts a boolean.
- A macro call written directly as an argument of another macro call (for example
  `Dependency<T>(undefined, Flamework.id<T>())`) was emitted untransformed, as a call to a function
  that does not exist at runtime ("attempt to call a nil value"). Macro arguments are now transformed
  like any call's, at any depth.
- The schema's and `TransformerConfig`'s `idGenerationMode` default said `"full"`, which is wrong with
  obfuscation on (`"obfuscated"`); `components.attributeWarningTimeout`'s said 5, where it follows
  `warningTimeout`; `hashPrefix` said it defaults to the package name, where a game gets no prefix
  (it also says now that a prefix cannot start with `$`).

### components

#### Fixed

- Several `ComponentPlugin`s in one module -- a `fromPath` per folder as guide 09 shows, a `fromGlob`, a
  built one, in any mix -- raised `provider ID was registered more than once: $c:components@Components`
  at ignition. They now share one `Components` per module: every registration ends up in it, a
  component can link to one registered by another plugin, and `Dependency<Components>()` and
  constructor injection get that one. A module that imports another keeps its own `Components` when it
  includes a component plugin, and resolves the import's when it does not.
- `ancestorBlacklist`'s doc comment named two default services. The default is ServerStorage,
  ReplicatedStorage, StarterPack, StarterGui and StarterPlayer.

#### Changed

- `fromPath`, `fromGlob`, `registerComponents` and `registerComponentsGlob` register components their
  modules do not export (see core).
- A link to an unregistered component now raises `… not registered in any ComponentPlugin of this module`.
- `ComponentPlugin.fromPath`, `fromGlob`, `registerComponents` and `registerComponentsGlob` whose own
  scope condition does not hold no longer look their folder up, as in core. `getComponent` on a component
  under such a folder says `component '...' could not be found: ... is under
  ComponentPlugin.fromPath("..."), which is left out by its scope (...)`. A condition given to
  `includePlugin` does not stop `fromPath` from looking its folder up, because `fromPath` looks it
  up when it is called; put the condition on `fromPath` itself.

### testing

#### Fixed

- `out/index.d.ts` re-exported the stripped `@internal` hooks `__resetTests` and `__isAttached`, so a
  plain `tsc` without `skipLibCheck` failed inside the package (TS2305). The re-exports are stripped
  as well; the Luau still exports them.

### core, components, networking, testing

#### Changed

- Built with their id prefixes (`$`, `$c`, `$n`, `$T`) in a `flamework.config.json` instead of on the
  tsconfig entry, which also drops the dead v1 key `$rbxpackmode$`. The published `out` and
  `flamework.build` are byte-identical, ids included.

### components, networking, testing

#### Fixed

- The peer dependency on `@flamework-experimental/core` (and testing's on
  `@flamework-experimental/transformer`) was `*`, which matches no prerelease, so every install of an
  alpha warned about an incorrect peer dependency. It is `^2.0.0-alpha.0` now.

### Docs

- Getting started: the Rojo section maps each runtime package under `@flamework-experimental` by
  name and says why not the whole folder -- the transformer is installed there too, and its folders
  and three JSON schemas would be copied into ReplicatedStorage -- with the `globIgnorePaths` line
  that leaves it out instead; the components, networking and testing pages point to it from their
  install steps.
- Migrating from v1: a first step for the packages, `tsconfig.json`, `flamework.json` →
  `flamework.config.json`, the Rojo mapping and clearing v1's `out/`; `Flamework.resolveDependency(id)`'s
  replacement, and rows for the other v1 `Modding` functions (`createDependency`,
  `createDeferredDependency`, `resolveSingleton`, `addListener`); that components now attach after
  every provider's `onStart` and that an attribute its guard rejects removes the component;
  subscribing to implementers after ignition (a plugin for providers, `Components` for components);
  the macro type renames (`Generic` → `Target.*`, `Many` → `Emit`, `Caller<M>` → `Caller.*`, ...)
  and what else changed with them (the `path` intrinsic's value, `Caller.Uuid`), which the guide had
  listed as unchanged; and the networking changes (`processNext`, `Networking.Connection`, handlers
  no longer tied to the connecting script), which it had called unchanged. Step 12 no longer names
  `Flamework.registerExternalClass` and `Flamework.createDependency`, which v1 1.3.2 does not have.
- Macros: writing a path or glob macro of your own with `Modding.Intrinsic<"path">` /
  `Modding.Intrinsic<"pathglob">`; `Caller.Uuid` changes with every clean build under obfuscation.
- Every guide page, the README and the testing package's README are reworded in plainer language:
  shorter sentences, terms defined where they first appear, steps and rules as lists. Code examples
  are unchanged. Facts corrected along the way: interfaces match through a class's `implements`
  clause (a parent's only if it is decorated too), not by shape; remote folder names and
  `Caller.Uuid` change with every plain build under obfuscation, not with a watcher's rebuild or an
  incremental build; only the runtime sections of `flamework.config.json` reach the place (`cloud`
  never does); `Flamework.env` reads the environment when `rbxtsc` starts; a child's `Name` is
  followed only with `watchRenames`; migrating step 6 no longer suggests an optional child typed as a
  component, which the transformer rejects; `build()` and `ignite()` do not return the builder; a
  table in the components guide that rendered in two pieces is whole.
- Testing: the shipping advice is reversed. A `Tests` folder is registered by its own path with the
  scope condition on the registration, which a release build without the folder now skips (see core).
- Project structure: the tsconfig entry takes only `transform` and `configFile`; the `$schema` line
  and when the build adds or creates it; the `hashPrefix` and `idGenerationMode` defaults; the example
  config's `"hashPrefix": "$g"`, which failed a game build, is now `"g"`; under obfuscation, ids
  declared in a package (`OnStart`, `OnInit`, `Components`, ...) keep their names, and why that only
  reveals which Flamework events and package types a class uses. Getting started, Migrating from v1,
  Transformer plugins and Internals follow.

### Tests

- The Studio test place lives in the repository (`tests/place`), linked to the packages' own builds:
  `bun run test:place` builds the packages and runs its suite in Studio under the default,
  immediate, deferred and streaming projects.
- The Lune harness's module tree answers `IsA`, `GetChildren`, `GetDescendants`, `FindFirstChild`,
  `WaitForChild` and `GetFullName`, so specs can register a folder by path.
- The place's providers that cases register in modules of their own moved out of the registered
  `Tests` folders into `src/server/Fixtures`.
- `tests/packaging/typings.test.ts` type-checks every published declaration file without
  `skipLibCheck` and checks that none exports a `__` name. New scope specs and place cases cover
  left-out folder registrations, and new transformer tests cover the empty-glob warning and nested
  macro calls.
- Transformer tests for the tsconfig entry check (each option, unknown keys, loader keys,
  `configFile`, a real rbxtsc build) and for the `$schema` line (layouts, CRLF, BOM, comments,
  creation at the package root and none below it, packages, watcher rebuilds, unwritable files), a
  test that every schema option states a default, and packaging tests that pin each package's id
  prefix and the ids games compare against. The fixture's probe files are removed before a run.

## 2026-09-26: core, components, networking and testing 2.0.0-alpha.2; transformer 2.0.0-alpha.3

### Upgrade notes

- **Release `core`, `components` and `testing` together.** `core` now starts providers from a new
  `onIgnited` plugin hook, and `components` and `testing` rely on it. A new `core` with an older
  `components` or `testing` (or the reverse) misbehaves.
- **Rebuild networking code with the matching transformer.** The transformer emits a new
  `_setCallback(callback, pack)` shape for receiving functions.
- **Deploy server and client from the same build.** Function remote ids changed for one-way
  functions (see networking below).
- **Networking middleware: `processNext` returns the next link's result, not a Promise.** A
  middleware that only returns `processNext(...)`, or `await`s it, needs no change. One that chains
  on it, `processNext(...).andThen(f)` (or `.then(f)`), becomes `f(processNext(...))`. An error
  further down is raised through `processNext` rather than rejecting a Promise, so a `.catch` or
  `.finally` becomes a `try`/`catch` or `try`/`finally` around the call. For an event `processNext`
  returns nothing; for a function it returns the value or `Networking.Skip`.
- **Networking handlers are no longer tied to the script that connected them.** `connect` and
  `registerHandler` no longer go through a BindableEvent, so the engine does not disconnect a handler
  along with the script that connected it. A roblox-ts project does not destroy its scripts, so
  nothing changes for a normal project. (Corrected after release: this note first said a destroyed
  script's handlers pile up.)
- **Networking connections have their own type, `Networking.Connection`.** Code that stores what
  `connect` or `registerHandler` returns as `RBXScriptConnection` still compiles, because the shape
  matches, but it should name `Networking.Connection`, which also offers `Destroy()`. A runtime check
  such as `typeIs(connection, "RBXScriptConnection")` is false for these connections; `typeOf` gives
  `"table"`.

### core

#### Added

- `PluginTarget.onIgnited(callback, options?)`: runs once the module is fully ignited, after every
  `onPostIgnite` hook and after its imports know about it. Providers' `onStart` now runs here.
- A warning when a provider has waited 5 seconds for an `onInit` that may be waiting on that very
  ignition (an `onInit` that, after it has yielded, ignites a module taking what it initialises),
  naming both providers.

#### Changed

- `onStart` runs only once the module is ignited. Inside it `isIgnited()` is true, `extinguish()`
  works, and modules that import this one can be ignited.
- Providers stop getting `onTick`/`onPhysics`/`onRender` from the moment `extinguish()` is called.
- `extinguish()` on an import waits for an importer that is still extinguishing on another thread,
  so importers finish before the import is released. A wait that would close a cycle, or wait on a
  thread that was cancelled, returns at once instead of deadlocking.
- Lazy providers resolved after ignition get `onInit` and `onStart` only once the module is ignited
  and never after extinguish has begun. Several resolved together (one, and the lazy providers its
  constructor takes) run `onInit` in dependency order, and one resolved from inside one of their
  `onInit`s, sync or `async`, joins them. One resolved anywhere else meanwhile gets its own turn:
  its `onInit` waits only for the pending `onInit`s of the providers its constructor takes, and for
  nothing else. A lazy provider whose `onInit` raises never ticks or starts.
- An import that is extinguished while an importer is still igniting now fails that importer's
  ignition (`imported module '…' was extinguished while this module was igniting`).
- Per-frame events (`onTick`/`onPhysics`/`onRender`) walk their listener sets in place and call each
  listener without creating a closure. At 1,000 listeners a frame takes about 30% less time in Studio
  (about 780 → 530 µs, profiling off) and allocates nothing (about 80 KB per frame before, about
  140 KB with profiling on). Delivery rules are unchanged: a listener attached during a frame starts
  on the next, and one detached before its turn is not called.
- What a class implements is computed once per class and cached; this is used on every attach and
  detach and by `Flamework.implements`. Attaching an object no longer records an undo list. Attach
  plus detach allocates about 60% less, and `Flamework.implements` on an instance allocates nothing.

#### Fixed

- A listener attached during a frame made other listeners tick twice or not at all.
- A lazy provider ticked before its `onInit` had finished.
- With profiling on, a provider's memory category leaked onto the thread that called `ignite()`.
- A lazy provider refused by an observer stayed cached and was handed out with no lifecycle events.
- An importer stayed ignited forever when its import was extinguished during its ignition.
- An import was released while an importer's yielding `onExtinguished` was still using it.
- Deadlocks between concurrent extinguishes along an import chain, with a cancelled extinguish
  thread, and when an `onInit` (sync or `async`) extinguished an import during an ignition started
  from `onExtinguished`.
- A lazy provider first resolved during extinguish was released without `onExtinguished`, and could
  get `onInit`/`onStart` after it; an object refused during extinguish was told `onExtinguished`.
- `release` skipped or doubled providers resolved while it ran.
- An object provided under two ids got every event twice.
- A failed ignition sent `onRemoved` for provided instances that never joined.
- Cancelled threads left entries behind in the module-level wait map.
- An eager provider whose constructor takes an import's lazy provider that is not initialised yet
  (resolved for the first time by that constructor, or still loading) ran `onInit` and `onStart`
  before that provider's `onInit` had finished, including when its module was ignited from Promise
  work (an `andThen` callback or an `async` function). Its `onInit` now waits for it, and ignition
  waits with it; if the import begins to extinguish meanwhile, the ignition fails without running
  that `onInit` (`'…' takes a provider of a module that was extinguished while this module was
  igniting`).
- A provider without an `onInit` (eager or lazy) got `onStart` and per-frame events before the
  pending `onInit` of a provider its constructor takes had finished; they now wait for it, as an
  `onInit` does.
- A per-frame callback that kept its thread (`coroutine.running()`) and cancelled it after returning
  broke `onTick`/`onPhysics`/`onRender` for every module for good (`cannot spawn non-suspended
  coroutine with arguments`). The recycled thread is now reused only while it is parked.

### components

#### Changed

- `onComponentRemoved` runs before `destroy` under Immediate signal behaviour and after it under
  Deferred. The docs said "before" in both; the behaviour is unchanged.
- Removing a dependency by hand, tagged or not, takes its dependents down until the next one is
  built.
- When Flamework removes a component on its own (tree, link, attribute or dependency lost) and its
  `destroy` raises, the error is a warning (`[Flamework] Failed to remove '…' from …`). A hand
  `removeComponent` still raises.
- `getComponent` builds nothing and returns `undefined` once the module has begun to extinguish.
- Under Immediate, `getComponent` for a component still being constructed (e.g. from a handler
  fired by its default-attribute write) returns `undefined`.
- With `watchRenames` on, children ahead of a resolved required child are followed too (one `Name`
  connection each), because a rename there changes which child the name resolves to.
- `getComponents` no longer keeps a lookup per instance: it reads the instance's own components
  against each class's ids, worked out once at registration. Results are the same, in no particular
  order, as before.
- Adding a component allocates and keeps less: attribute guards, the instance check, inherited
  config and whether a class implements `OnInit`/`OnStart` are read once per class; tracker entries
  make their sets on first use; a class with no links of a kind shares one frozen empty
  `childComponents`/`attributeComponents`; `onStart` runs on a recycled thread and its failure
  message is only built on a raise; constructor dependencies resolve through one shared resolver;
  attributes keep no per-component copy of old values. For an instance with two components:
  6.4 → 4.0 KB kept, 14.6 → 8.1 KB allocated per add, adds about 25–35% faster.

#### Fixed

- A subclass that re-declares its parent's interface was announced twice to `onComponentAdded` /
  `onComponentRemoved`.
- A component that removed itself in `onStart` leaked its maid, was announced as added after its
  removal and was handed to waiters already destroyed; a later waiter could get a component an
  earlier waiter had removed.
- Child links: a child renamed and then removed was missed; with `watchRenames` on, a sibling
  renamed into a taken name was never heard; a replaced child never rebuilt its owner under the
  server's default mode or `Disabled`; a long chain taken down under Deferred left its tail attached.
- Optional attribute links with an Instance default reported themselves met and then raised in
  construction, and their watcher went stale when the owner was taken down.
- Dependencies Flamework will never build (predicate, no tag) counted as met and made construction
  raise; a dependency removed by hand left its dependent holding it; a dependency whose setup raised
  was never released; a dependent's raising `destroy` kept its dependency attached; re-adding a
  component from `onComponentRemoved` left its dependents down.
- A handler fired by a default-attribute write could build a second copy of the component.
- Removing a component's tag during its `onInit` left it attached for good.
- Hand-written `t` instance guards were re-checked only in one direction; their queued poll could
  run after extinguish and raise.
- `getComponent` raised after the module had extinguished.
- Under Immediate, re-adding a tag from `onComponentRemoved` during that tag's own removal left the
  instance tagged with no component; dependents now see a dependency as missing while its removal
  runs, and are rebuilt around the new one when it ends.
- A hand `removeComponent` of a dependency whose own `destroy` raises left its dependent holding it.
- Removing components was quadratic in the number attached (each removal counted every id's global
  set): at 5,000 instances a removal cost about 300 µs, now about 10–20 µs.
- Under Immediate signal behaviour, an `onAttributeChanged` handler that wrote the same attribute
  was told a stale old value for that change and the next.

### networking

#### Changed

- Every function remote id carries its direction prefix (`$` / `@`), one-way functions included.
- `Cancelled` also answers a request whose callback or middleware promise was cancelled.
- Invoking a player who has left rejects with `Cancelled` at once, with any timeout.
- A timeout of `math.huge` never fires.
- **Breaking:** middleware `processNext` returns the next link's result instead of a Promise (see
  the upgrade notes). A middleware may still yield or return a Promise; it is waited for in the
  thread handling the message. For a function, a cancelled one reads as `Networking.Skip`.
- Receiving no longer uses Promises: decoding, guards, middleware and the handler or callback run as
  plain calls in the thread that received the message. An event with no middleware costs about 3 µs
  and 80 bytes instead of about 20 µs and 18 KB; a function request costs the server about 6 µs and
  0.4 KB instead of about 50 µs and 46 KB.
- A function call makes a single Promise, the one `invoke`/`invokeWithTimeout` returns. Its timeout
  is a `task.delay`, cancelled when the answer arrives.
- Event handlers run on networking's own signal instead of `@rbxts/signal`:
  - each handler runs at once on a thread of its own, newest connection first, rather than through
    a BindableEvent (which the engine defers under `SignalBehavior.Deferred`);
  - an event's `predict` has called its handlers by the time it returns, unless a middleware yields;
  - `@rbxts/signal` is no longer a dependency of `networking`.
- `connect` and `registerHandler` return `Networking.Connection` (`Connected`, `Disconnect()`,
  `Destroy()`), networking's own connection, not an engine `RBXScriptConnection`.

#### Fixed

- Event arguments are delivered by reference, so decoded Maps and Sets with non-string keys (players,
  numbers, Vector3s, enums, booleans) reach `connect` intact.
- Argument lists with `undefined` gaps and a trailing `undefined` lost values after the gap, including
  through middleware that names its parameters.
- Under serialization, middleware that returned a plain value broke the call.
- Functions declared to return `Promise<T>` always failed their result guard.
- `predict` before any `connect` threw.
- Invoking a player who had already left kept that Player in memory for good.
- Two concurrent `createClient` calls built two handlers on the same remotes; a cancelled
  `createClient` blocked every later one.
- A one-way function named `$name` shared a remote with a two-way `name`, so both callbacks ran and
  callers got each other's answers.
- A predicted function whose callback Promise was cancelled never settled.

### testing

#### Fixed

- `flamework-test` no longer reports a Studio window closed while it is still open, or closes a
  window it did not open. `test` closes the window it opened by the process it started, not by a
  title suffix, which could also match another directory's same-named file and end that window
  instead. It checks the process is gone after the polite and the forced close, and fails with the
  window's PID and title when it is not. It drives only the window it launched: a same-named window
  already listed by the MCP proxy is ignored, and runs of same-named files take turns to open
  theirs. A run that cannot tell its window from another of the same name that is still opening
  refuses and closes its own. A window the run gave up on (e.g. one that never connected) is closed
  unless `--keep`. The earlier-build close only matches a window whose title shows that very file,
  compared ordinally ignoring case, so "Straße" is not "Strasse". Paths and titles reach PowerShell
  as data, so any character in them, including ‘ ’, is taken literally. `studio close` closes
  nothing when several windows share the title.

### transformer

#### Changed

- Receiving networking functions compile to `_setCallback(callback, pack)`; the result is packed after
  the middleware chain. `incomingResults` is gone from the generated metadata.
- The result guard of a function returning `Promise<T>` checks `T`.

### Tests

- The Lune runtime harness now behaves as Roblox Studio does for everything the specs rely on,
  measured in Studio under Immediate and Deferred: signal and tag order, handler errors (printed and
  collected through `__harness.errors()` / `clearErrors()`, and a case fails on an uncleared one),
  deferral and re-entrancy limits, frame order, Bindable argument copying, attribute validation and
  `task` timing.

### Known issues

- core: dependency waiting is not transitive. A provider waits for the pending `onInit` of the
  providers its constructor takes directly; a provider in between with no pending `onInit` of its
  own (e.g. a lazy service without `onInit` that takes a lazy store still loading) is not followed.
  Give that service an `onInit` (an empty one is enough) or take the store directly.
- core: an `onInit` that, after it has yielded, ignites a module taking the provider it initialises
  makes that ignition wait for itself until the import is extinguished (the warning above names
  it). Ignite such modules from `onStart` or a `PlayerAdded` handler.
- core: the `async` `onInit` deadlock fix lets an unrelated thread's `extinguish()` of an import skip
  waiting for an importer that is waiting on a pending `onInit` Promise.
- core: while a lazy provider's `onInit` Promise is pending, a lazy provider resolved on any thread
  running Promise work joins its batch, an unrelated Promise's too; one resolved by a thread the
  `onInit`'s executor spawned, after that thread yielded, gets its own turn.
- core, components, networking: per-frame callbacks, component `onStart`s and networking handlers
  run on recycled threads. Code that keeps the thread it ran on (`coroutine.running()`) and cancels
  or resumes it later can cut short or wake another callback that is reusing that thread.
- networking: a sender created inside the leaving player's own `PlayerRemoving` handler never settles
  an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- docs: the harness sections of `docs/reference/internals.md` still describe the old harness.
