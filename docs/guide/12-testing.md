# 12. Testing in the place

`@flamework-experimental/testing` runs tests inside a real place: in Studio, in a live server, or
in an Open Cloud task. Tests are plain functions grouped into **sections**. Providers define them,
so they get their dependencies injected like any other code. They are tied to a
[scope](11-scopes.md), so a build that did not ask for them does not register them.

```ts
// src/server/Tests/economy.ts
import { OnStart, Provider } from "@flamework-experimental/core";
import { defer, defineTests, expectEqual, test } from "@flamework-experimental/testing";
import { Shop } from "server/services/shop";

@Provider({ activeIn: ["testing"] })
export class EconomyTests implements OnStart {
    constructor(private readonly shop: Shop) {}

    onStart() {
        defineTests("economy", () => {
            test("buying deducts the price", () => {
                const wallet = this.shop.open("test");
                defer(() => this.shop.close("test"));

                this.shop.buy("test", "sword");
                expectEqual(wallet.balance, 90);
            });
        });
    }
}
```

```ts
// src/server/main.ts
Flamework.createModule()
    .registerProviders("src/server/services")
    .registerProviders("src/server/Tests", { activeIn: ["testing"] })
    .includePlugin(TestingPlugin)
    .ignite();
```

```jsonc
// flamework.config.json
"scopes": { "active": "${FLAMEWORK_SCOPES:-}" }
```

In a build with `FLAMEWORK_SCOPES=testing` (the test script below sets it), the test providers
register like any other and define their sections as they start. The plugin creates
`Workspace.FlameworkTests` and waits. Nothing runs until something invokes it:

```lua
-- the Studio command bar, a debug UI, or `flamework-test` from a terminal
local result = workspace.FlameworkTests:Invoke()          -- every section
local result = workspace.FlameworkTests:Invoke("economy") -- one section
```

Without the scope, the `Tests` folders are skipped entirely. A folder registration whose own
condition does not hold does not look the folder up or require anything in it. No test class is
loaded or constructed, the plugin does nothing, and no instance is made. One switch,
`FLAMEWORK_SCOPES`, turns on both the tests and the host that runs them. Keeping the files out of a
release place altogether is Rojo's job; see [shipping](#shipping).

## Setting up

Everything a project needs, in the order it is needed:

1. The package: `npm install @flamework-experimental/testing`. It brings the roblox-ts side and the
   `flamework-test` CLI, nothing else. A Rojo project that maps the whole
   `node_modules/@flamework-experimental` folder in one line, as in
   [Getting started › Rojo](01-getting-started.md#rojo), takes it in with nothing to add; one that
   maps the packages by name needs a `testing` entry next to `core`. The CLI runs on
   [Bun](https://bun.sh), whatever installed it: npm's and pnpm's `flamework-test` command starts
   `bun`, and without it on the `PATH` fails with `'"bun"' is not recognized`.
2. The switch: the `scopes` line above in `flamework.config.json`, and the scope in neither `.env`
   nor `.env.local`. Every build reads both files: `.env` is committed
   ([Project structure › What to commit](09-project-structure.md#what-to-commit)), and `.env.local`
   is read by every build on your machine, release builds included. A scope in either ships the
   test host and its remote with those builds. Set the variable for the one build that needs it
   instead, as the test script below does.

   To have the tests in a place you sync with `rojo serve`, give the watcher the scope in its own
   environment, and nothing else: a `watch:tests` script like the test script, which runs
   `rbxtsc -w` with `FLAMEWORK_SCOPES: "testing"`. Once you stop it, `out/` still holds the test
   host, so compile once without the scope (`npm run build`) before you build a place to ship.
3. A `Tests` folder per realm, registered under the scope, and `TestingPlugin` in each realm's
   module. The server is shown above; the client is the same shape:

   ```ts
   // src/client/runtime.client.ts
   Flamework.createModule()
       .registerProviders("src/client/controllers")
       .registerProviders("src/client/Tests", { activeIn: ["testing"] })
       .registerProviders("src/shared/Tests", { activeIn: ["testing"] }) // sections both realms run
       .includePlugin(TestingPlugin)
       .ignite();
   ```

   A shared folder registered by both modules gives sections that run in both realms, one copy in
   each. The component specs of this repository's test place,
   [`tests/place`](../../tests/place/README.md), live in such a folder.
4. A script that compiles with the scope, builds the place, runs the tests, and then compiles again
   without the scope, whatever happened, so that `out/` never keeps a build with the test host in
   it. The rebuild sets the variable to nothing rather than leaving it out, so that a scope in
   `.env.local` cannot come back through it. It exits with the tests' code:

   ```js
   // scripts/test.mjs: run it as `npm test` or `bun run test`, which put node_modules/.bin on the
   // PATH (`bun scripts/test.mjs` on its own finds no rbxtsc). Arguments go to flamework-test.
   function run(command, env = process.env) {
       try {
           return Bun.spawnSync(command, { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
       } catch {
           console.error(`${command[0]} could not be started: is it installed?`);
           return 127;
       }
   }

   let code = run(["rbxtsc"], { ...process.env, FLAMEWORK_SCOPES: "testing" });
   if (code === 0) code = run(["rojo", "build", "-o", "test.rbxl"]);
   if (code === 0) code = run(["flamework-test", "test", "test.rbxl", ...process.argv.slice(2)]);

   console.log("rebuilding out/ without the testing scope...");
   const rebuild = run(["rbxtsc"], { ...process.env, FLAMEWORK_SCOPES: "" });
   process.exit(code !== 0 ? code : rebuild);
   ```

   ```jsonc
   // package.json
   "scripts": { "test": "bun scripts/test.mjs" }
   ```

   `test.rbxl` has a name of its own, so the place a release is built into never holds the tests.
   Ignore it with the other built places, `/*.rbxl` at the root. Besides the build, a run leaves:
   - the places `flamework-test` makes beside the build (`test.patched.rbxl` with an original
     place, `test.<project>.rbxl` under `--project`), which the same line covers;
   - `build/version.json`, which `cloud publish` writes, and so `cloud test` and `test --cloud`;
   - Studio's lock file beside a place it has open, `test.rbxl.lock`. `flamework-test` removes the
     lock of a window it ends, but one left by a Studio closed any other way stays, so ignore
     `*.rbxl.lock` too.

   The files a patch needs while it runs go to a folder of the system's temp directory, one per
   run, removed when the patch is done.
5. Roblox Studio with "MCP server" enabled in its Assistant settings, which is what lets the CLI
   open a window, run the tests in it and close it again.

`npm test` (or `bun run test`) then prints one summary per realm. That is the whole setup for
Studio. Running in the cloud also needs an API key and a testing place; see
[Running the tests](../testing/place.md).

## Where tests live

`defineTests` is an ordinary function, so anything may call it. A provider's `onStart` is the
natural place, since by then every provider is constructed and every `onInit` has run. Put the scope
condition on the folder registration (`registerProviders("src/server/Tests", { activeIn: ["testing"] })`),
on the class (`@Provider({ activeIn: ["testing"] })`), or on both. These are the usual
[scope rules](11-scopes.md), nothing specific to testing.

Only the condition on the folder registration keeps the folder from loading in a build without the
scope. A release place that leaves the folder out needs that. A condition on the class is read after
its file has loaded.

Client tests have the same shape, in a client provider, with the plugin included in the client
module. Each realm has its own host.

## Sections and tests

`defineTests(name, body)` runs `body` at once. Inside it, `test(name, fn)` registers a test, and
`beforeEach` / `afterEach` register hooks. `name` may be `undefined`, which means the section
`"default"`. The same section name used by several providers is one section, so a feature's tests
can be spread over several files. Sections do not nest, and a name may not contain `/`.

The body receives a context with the section's `name` and the `module` that was igniting when the
section was defined:

```ts
defineTests("components", ({ module }) => {
    test("finds the tagged part", () => {
        const components = module!.resolveDependency<Components>();
        // ...
    });
});
```

Define sections before the first yield of `onStart`. `onStart` runs on its own thread, and the
module is only marked current until ignition finishes. A section defined after a `task.wait` still
registers, but without a module. Few tests need the module: a provider already has what it
injected.

A test may yield (`task.wait`, `WaitForChild`, a signal), and a Promise it returns is awaited.
Each test runs on its own thread, with a timeout of `testing.timeout` seconds (30 by default). A
test that runs over is cancelled and counted as failed, and the run moves on.

## Cleanup

Tests in a place leave things behind unless they clean up, and the next test would run against
whatever was left. There are three cleanup tools, and all of them run whether the test passed,
failed or timed out:

| Tool | Does |
|---|---|
| `defer(fn)` | Registers cleanup for the running test: a connection to disconnect, an instance to destroy, a state to restore. Runs in reverse order after the test. |
| `scratch()` | A Folder in Workspace for whatever the test builds, made on first use and destroyed with everything in it afterwards. |
| `afterEach(fn)` | A section-level hook, run after every test of the section. |

A cleanup that raises fails the test, since whatever it was meant to remove is still there.

## Assertions

`expectEqual`, `expectTrue`, `expectFalse`, `expectDefined`, `expectThrows`, `expectNoThrow`,
`expectArrayEqual`, `expectResolves`, `expectRejects` and `fail` raise a one-line message that
becomes the test's failure. `eventually(predicate, what?, timeout?)` checks `predicate` every frame,
for something the engine delivers later: a deferred signal, a replicated instance, a component built
on the next resumption. Any other assertion library works too: a test fails when its body raises an
error.

## Running

| From | How |
|---|---|
| A terminal, in Studio on this machine | `npm test`, the script in [Setting up](#setting-up): its `flamework-test test test.rbxl` opens the build in Studio, runs both realms, closes it; see [Running the tests](../testing/place.md) |
| A terminal, under another Rojo project | `npm test -- --project tests/deferred.project.json`: the same, in a place with that project's `$properties` set, `Workspace.SignalBehavior` and the streaming radii included; one run per `--project`, see [Workspace settings no script can change](../testing/place.md#workspace-settings-no-script-can-change) |
| A terminal, in the cloud | `npm test -- --cloud`: publishes to a testing place and runs the server's sections in a real server; needs `testing.entry`, see below |
| The realm's own code | `Testing.run(filter?)` and `Testing.list(filter?)` |
| Anything with the DataModel | `Workspace.FlameworkTests:Invoke(filter?, options?)` |
| A client, for the server's tests | `Testing.runOnServer(filter?)`, over `Workspace.FlameworkTestsServer` |
| Start-up | `"autoRun": true` in the config runs everything right after ignition |

A filter is nothing (every section), one section name, one `section/test` name, or a list of
those; `--sections a,b` on the command line. Passing `{ list = true }` as the options reports the
selection without running it. In one realm, an entry that names nothing there makes the run fail.
When `flamework-test` runs both realms, an entry only one realm has is fine: the other realm lists it
as `not among the client's sections: coin`, and the run fails only on an entry that no realm has
(`MISS matched nothing in any realm: coins`). So `--sections coin` runs a server-only section without
`--realm server`. The result is a plain table, the same whether it came back from an invoke, a
remote or `Testing.run`:

```lua
{ ok = true, realm = "server", passed = 12, failed = 0, durationMs = 340,
  sections = { { name = "economy", passed = 12, failed = 0,
                 tests = { { name = "buying deducts the price", ok = true, durationMs = 3 }, ... } } },
  unknown = {} }  -- filter entries that named nothing in this realm; any makes ok false
```

Every test also prints one line, such as
`[FWTEST] server economy/buying deducts the price: PASS (3ms)`, and the run ends with a summary
line. So the Output window and a task's log show the same as the table.

A place made by `flamework-test` knows which Rojo project it was made under. `getProject()` returns
that project's name: `deferred` for `tests/deferred.project.json`, and `undefined` in a place opened
by hand. The result carries it as `project`. A test that only holds under one project's `Workspace`
settings (`SignalBehavior`, say) checks it and returns early under the others; see
[several projects, one suite](../testing/place.md#several-projects-one-suite).

A BindableFunction's callback is set per realm, so the one `Workspace.FlameworkTests` serves both.
A client with the plugin answers on it for its own tests, and reaches the server's tests through
`FlameworkTestsServer`. A second invoke while a run is in progress raises an error.

### Both realms in one session

`flamework-test test` runs the server's sections and then the client's, in the same play session.
So the client's tests run against a server whose own tests have already run, and they see whatever
those tests left on the wire.

One engine fact matters here. A RemoteEvent message fired at a client before it has connected
`OnClientEvent` is not dropped: the engine queues it and delivers it the first time anything
connects. Say a server test calls `predict` with the real player, through a handler that answers
with `fire(player, ...)`. That leaves a reply waiting, and the reply lands in the middle of the
client's tests as an answer nobody asked for.

So predict with a stand-in that is not a `Player` (`scratch()` will do), and have the answering
handler skip it:

```ts
function fromPlayer(player: Player) {
    return typeIs(player, "Instance") && player.IsA("Player");
}
server.setScore.connect((player, score) => {
    if (fromPlayer(player)) server.scoreChanged.fire(player, score);
});

test("accepts a message through its guards", () => {
    server.setScore.predict(scratch() as unknown as Player, 5);
});
```

The `networking` sections of this repository's test place ([`tests/place`](../../tests/place/README.md))
are written this way.

## Configuration

```jsonc
"testing": {
  "activeIn": ["testing"],     // scopes under which the plugin attaches: any of them; the default
  "inactiveIn": [],            // scopes under which it never does
  "enabled": true,             // when set, overrides the two above in either direction
  "autoRun": false,            // run everything right after ignition
  "timeout": 30,               // seconds per test
  "entry": "src/server/main"   // cloud runs only: the ModuleScript exporting ignite()
}
```

`entry` exists for one reason. An Open Cloud task loads the place but runs none of its Scripts, so
nothing ignites the game there. The runner has to require a ModuleScript and call its `ignite()`
itself, and `entry` names that ModuleScript. In Studio, the place runs its own Scripts, and the
module is up before anything invokes the tests. So a project that only runs its tests locally never
sets `entry`. A cloud command refuses to publish without it.

`activeIn` and `inactiveIn` follow the same rules as everywhere else: `activeIn` needs at least one
of its names active, `inactiveIn` needs none of its names active, and an empty `activeIn` is no
constraint. `TestingPlugin` is the plugin with the file's settings. `createTestingPlugin({ ... })`
overrides them for one plugin, which is what a test harness of your own would use.

## Shipping

Never ship a build with tests on: the remote lets any client run the server's tests. Keep the
`testing` scope out of `.env` and `.env.local` altogether, since every build reads them; the test
script in [Setting up](#setting-up) sets the scope for its own build and compiles again with it set
to nothing afterwards, so `out/` is never left with the host in it. After a watcher that ran with
the scope, compile once without it before you build a place to ship.

Without the scope, the test files still compile and are still copied into the place. A `Tests`
folder registered under the scope is never loaded, though. To leave the files out of the place as
well, give the release build a Rojo project that ignores the folders:

```jsonc
// release.project.json, otherwise identical to default.project.json
"globIgnorePaths": ["**/package.json", "**/tsconfig.json", "**/Tests"]
```

`**/Tests` drops every folder with that name, at any depth (`**/Tests/**` would leave empty folders
behind).

Register such a folder by its own path only with the scope condition on the registration itself, as
in [Setting up](#setting-up): `registerProviders("src/server/Tests", { activeIn: ["testing"] })`.
The release build does not have the scope, so the folder is never looked up. Without that
condition on the registration, the folder is looked up in every build that runs it. That includes
`registerProviders("src/server/Tests")` with the condition only on the classes, and
`ComponentPlugin.fromPath` with the condition only on `includePlugin`. The transformer resolves the
path against the project file without regard to `globIgnorePaths`, so a registered folder that is
not in the place stalls ignition: the registration waits for it, and warns after five seconds that
it is `still waiting for its folder`.

---

Previous: [Scopes](11-scopes.md) · See also: [Running the tests](../testing/place.md), [Testing in Studio](../testing/studio.md)
