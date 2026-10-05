# Flamework v2: tests in the place

For anything not covered here, read
`node_modules/@flamework-experimental/core/docs/guide/12-testing.md`,
`node_modules/@flamework-experimental/core/docs/guide/11-scopes.md` for the `testing` scope, and
`node_modules/@flamework-experimental/testing/README.md` for every flag of `flamework-test`.

## Writing one

```ts
import { OnStart, Provider } from "@flamework-experimental/core";
import { defineTests, expectEqual, test } from "@flamework-experimental/testing";

@Provider({ activeIn: ["testing"] })
export class ShopTests implements OnStart {
	constructor(private readonly shop: ShopService) {}

	onStart() {
		defineTests("shop", () => {
			test("buying takes the price", () => {
				expectEqual(this.shop.price("sword"), 10);
			});
		});
	}
}
```

- **Where:** a tests folder per realm (`src/server/tests`, `src/client/tests`), plus a shared one
  registered by both realms for sections that run once in each. The entry points register them
  with a scope condition, `.registerProviders("src/server/tests", { activeIn: ["testing"] })`, and
  include `TestingPlugin`. Only the condition on the registration keeps a build without the scope
  from loading the folder; a new test folder needs it too.
- **Shape:** a test file is a provider that injects what it tests, and defines its sections in
  `onStart`, before any yield. The same section name in several files is one section. A section
  name may not contain `/`.
- **Cleanup:** build instances under `scratch()`, a Workspace folder destroyed after each test, and
  undo anything else with `defer(fn)`. Tests share the server, so compare with the value before
  rather than assume a fresh one (`before + 3`).
- **Assertions:**
  - `expectEqual`, `expectArrayEqual`, `expectTrue`/`expectFalse`, `expectDefined`,
    `expectThrows`/`expectNoThrow`, `expectResolves`/`expectRejects` and `fail`;
  - `eventually(predicate, what)` polls every frame, for 5 seconds by default, for what the engine
    delivers later: deferred signals, replication, per-frame work.
  - A test times out after 30 seconds (`testing.timeout`).
- **Skipping:** `skip(reason)`, from the test's body or a `beforeEach`, ends the test as skipped,
  for what rules it out only at run time (the realm, the Rojo project from `getProject()`, a
  display that is asleep). A plain `return` would count as a pass. `test.skip(name, body)` parks a
  test without running it. Cleanup still runs after a skip. Keep `skip` out of `pcall`,
  `expectThrows` and threads that outlive the test: guide 12, "Skipping a test".
- **Concurrent:** independent tests that mostly wait can overlap:
  `test.concurrent(name, (t) => ...)`, or `defineTests(name, { concurrent: true }, ...)` for a
  section; a plain `test` runs alone. In one, use `t.defer`, `t.scratch`, `t.skip` (the bare ones
  raise) and share no state: guide 12.
- `test` is a callable table: where only a function will do (`task.spawn`, `coroutine.wrap`), wrap
  it in one.

## Players, networking, components

- **Players:** sending to a player needs a real one: wait for `Players.GetPlayers()[0]` in a
  helper (the template's `waitForPlayer()`). What the server sends that player during a test
  reaches the client in the same session. Where a player is only a key or an argument, use a
  stand-in, `scratch() as unknown as Player`; firing at a stand-in raises.
- **Networking:** `Functions.x.predict(player, ...)` and `Events.x.predict(player, ...)` run the
  server's side of a call here, with its guards and middleware. Predict with a stand-in, not the
  real player, and have a handler that answers skip non-players: a reply fired at the real client
  before its tests connect is queued and lands in the middle of them (guide 12, "Both realms in
  one session"). A middleware can also be tested on its own: call the factory with a spy for
  `processNext`.
- **Components:** tag a part under `scratch()`. `components.getComponent<T>(part)` builds the
  component at once and returns it. Removals and other signals arrive a frame later under
  Deferred: use `eventually`.

## The scope and shipping

- Tests and their host exist only in a build with the `testing` scope:
  `"scopes": { "active": "${FLAMEWORK_SCOPES:-}" }` in `flamework.config.json`, and
  `FLAMEWORK_SCOPES=testing` for that one build.
- Never put the scope in `.env` or `.env.local`: every build reads them, release builds included,
  and a shipped test host lets any client run the server's tests.
- Guide 12's test script (the template's `bun run test`) compiles with the scope, builds
  `test.rbxl` with Rojo, runs `flamework-test`, and compiles again with `FLAMEWORK_SCOPES` set to
  nothing, whatever happened. Ctrl+C skips that last build, so `out/` keeps the test host: build
  again before serving or building a place to ship.

## Running

- `flamework-test test test.rbxl` opens the build in Roblox Studio, runs the server's sections and
  then the client's in one play session, prints a summary per realm, and closes its window. It
  needs Studio with "MCP server" on in its Assistant settings, Bun on the `PATH`, and Lune to lay
  the build over an original place (`--original tests/place.rbxlx`).
- Flags: `--sections shop` (or `shop/<test name>`, comma-separated), `--realm server|client`,
  `--fail-on-skip` (a skip fails the run), `--keep-awake` (Windows: keeps the display on, since
  while it sleeps RenderStepped stops and `onRender` tests fail), `--list`, `--keep`, `--timeout`,
  `--concurrency 1` (concurrent tests one at a time).
- `--parallel [n]` runs a run of several Rojo projects with that many windows side by side (each
  about 3 GB). Add it only when the user wants a multi-project run anyway: it is no reason to run
  more.
- `--sections` is judged across both realms: an entry only one realm has is listed for the other
  as `not among the client's sections: ...` without failing, and an entry no realm has fails the
  run with `MISS matched nothing in any realm: ...`. With `--realm`, the one realm judges alone.
- Each realm's summary reads `N passed, M failed, K skipped` and lists every skip with its reason;
  every test also prints `[FWTEST] <realm> <section>/<test>: PASS|FAIL|SKIP` in the Output window.
  A failure exits non-zero; a skip does not, unless the run has `--fail-on-skip`.
- In Studio without the CLI: `workspace.FlameworkTests:Invoke()` (or `:Invoke("shop")`) from the
  command bar during a play session, or `"autoRun": true` under `testing` in the config, which
  runs every section after ignition. Don't combine `autoRun` with `flamework-test`: the tests would
  run twice, and an invoke during a run raises.
- `the server's run failed: Workspace.FlameworkTests did not appear within 30 seconds`: the place
  was built without the `testing` scope. `cannot invoke 'FlameworkTests' since 'FlameworkTests'
  has additional values for the Capabilities property`: the place was built with testing
  2.0.0-alpha.5 or earlier, from before Studio first ran MCP code sandboxed; rebuild it with a
  newer testing.

## Driving Studio

- `flamework-test` keeps one Studio window open at a time on the machine, across projects: `test`
  and `studio open` wait for the Studio lock while another project's window holds it, saying whose
  (300 seconds, `--lock-timeout`). Never close a window you did not open; `studio lock` shows the
  holder.
- `flamework-test studio open [file]` opens a window of your own and prints
  `studio_id=<id> pid=<pid>`. Then `studio list` (the windows, and which is yours), `studio tools
  [name]` (Studio's MCP tools, read live), `studio call <tool> --studio <id> --args-file args.json`
  (any tool; images are written to files whose paths it prints), and `studio close`, which frees the
  lock. A window left unused for 15 minutes (`--hold <minutes>`) may be closed for another project.
- `refusing to ... the Studio window ...`: it is not the window flamework-test opened for this
  project. `--any-window` acts on it anyway: on a window the user has open, only after asking.
  `` ... this project's Studio window ...: `test` is running in it `` (or `test --keep`, `studio
  open`): another process's run uses it; wait for it to end. `no Studio window flamework-test opened
  for this project is open`: open one with `studio open`; a note says when another project closed
  yours, or found it closed.
- `"MCP server" setting is probably off`: ask the user to turn it on in Studio's Assistant settings,
  then retry.
- Studio may run `execute_luau` sandboxed (it did from 2026-10-01): then no `require` of the
  place's modules, no `_G`, `shared` or DataStore; the CLI says so under such a refusal.
