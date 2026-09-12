# 12. Testing in the place

`@flamework-experimental/testing` runs tests inside a real place: in Studio, in a live server, or
in an Open Cloud task. Tests are plain functions grouped into **sections**; they are defined by
providers, so they get their dependencies injected like any other code, and they are tied to a
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

With `FLAMEWORK_SCOPES=testing` in `.env`, the test providers register like any other, define
their sections as they start, and the plugin creates `Workspace.FlameworkTests` and waits.
Nothing runs until something invokes it:

```lua
-- the Studio command bar, a debug UI, or `flamework-test` from a terminal
local result = workspace.FlameworkTests:Invoke()          -- every section
local result = workspace.FlameworkTests:Invoke("economy") -- one section
```

Without the scope, the test providers are skipped at ignition: their files are still required (a
folder registration requires everything under it before it looks at any condition), but no test
class is constructed, the plugin is inert, and no instance is made. One switch, `FLAMEWORK_SCOPES`,
turns on both the tests and the host that runs them; keeping the files out of a release place
altogether is Rojo's job, see [shipping](#shipping).

## Setting up

Everything a project needs, in the order it is needed:

1. The package: `bun add @flamework-experimental/testing`. It brings the roblox-ts side and the
   `flamework-test` CLI, nothing else.
2. The switch: the `scopes` line above in `flamework.config.json`, and `FLAMEWORK_SCOPES=testing`
   in `.env`. A release build leaves the variable out and gets no tests and no host.
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

   A shared folder registered by both modules gives sections that run in both realms, one copy
   each; the component specs of the template live there.
4. A script that builds and runs, with `*.rbxl` in `.gitignore`:

   ```jsonc
   // package.json
   "scripts": { "test": "rojo build -o place.rbxl && flamework-test test place.rbxl" }
   ```

5. Roblox Studio with "MCP server" enabled in its Assistant settings, which is what lets the CLI
   open a window, run the tests in it and close it again.

`bun run test` then prints one summary per realm. That is the whole setup for Studio; the cloud
route needs an API key and a testing place on top, see [Running the tests](../testing/place.md).

## Where tests live

`defineTests` is an ordinary function, so anything may call it; a provider's `onStart` is the
natural place, since by then every provider is constructed and every `onInit` has run. The scope
condition goes on the class, `@Provider({ activeIn: ["testing"] })`, or on the folder registration,
`registerProviders("src/server/Tests", { activeIn: ["testing"] })`, or both; these are the usual
[scope rules](11-scopes.md), nothing testing-specific.

Client tests are the same shape in a client provider, with the plugin included in the client
module; each realm has its own host.

## Sections and tests

`defineTests(name, body)` runs `body` at once; inside it, `test(name, fn)` registers a test and
`beforeEach` / `afterEach` register hooks. `name` may be `undefined`, which is the section
`"default"`. The same section name from several providers is one section, so a feature's tests
can sit in several files. Sections do not nest, and a name may not contain `/`.

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

`onStart` runs on its own thread and the module is only marked current until ignition finishes,
so define sections before the first yield of `onStart`; a section defined after a `task.wait`
still registers, but without a module. Few tests need it: a provider already has what it
injected.

A test may yield (`task.wait`, `WaitForChild`, a signal), and a Promise it returns is awaited.
Each test runs on its own thread with a timeout, `testing.timeout` seconds (30 by default): one
that overruns is cancelled and counted as failed, and the run moves on.

## Cleanup

Tests in a place leave things behind unless they clean up, and the next test would run against
whatever was left. Three tools, all of which run whether the test passed, failed or timed out:

| Tool | Does |
|---|---|
| `defer(fn)` | Registers cleanup for the running test: a connection to disconnect, an instance to destroy, a state to restore. Runs in reverse order after the test. |
| `scratch()` | A Folder in Workspace for whatever the test builds, made on first use and destroyed with everything in it afterwards. |
| `afterEach(fn)` | A section-level hook, run after every test of the section. |

A cleanup that raises fails the test, since whatever it was meant to remove is still there.

## Assertions

`expectEqual`, `expectTrue`, `expectFalse`, `expectDefined`, `expectThrows`, `expectNoThrow`,
`expectArrayEqual`, `expectResolves`, `expectRejects` and `fail` raise a one-line message that
becomes the test's failure. `eventually(predicate, what?, timeout?)` polls every frame for
something the engine delivers later: a deferred signal, a replicated instance, a component built
on the next resumption. Any other assertion library works too; a test fails when its body raises.

## Running

| From | How |
|---|---|
| A terminal, in Studio on this machine | `rojo build -o place.rbxl && flamework-test test place.rbxl`: opens the build in Studio, runs both realms, closes it; see [Running the tests](../testing/place.md) |
| A terminal, in the cloud | `flamework-test test place.rbxl --cloud`: publishes to a testing place and runs the server's sections in a real server; needs `testing.entry`, see below |
| The realm's own code | `Testing.run(filter?)` and `Testing.list(filter?)` |
| Anything with the DataModel | `Workspace.FlameworkTests:Invoke(filter?, options?)` |
| A client, for the server's tests | `Testing.runOnServer(filter?)`, over `Workspace.FlameworkTestsServer` |
| Start-up | `"autoRun": true` in the config runs everything right after ignition |

A filter is nothing, one section name, one `section/test` name, or a list of those. `{ list =
true }` as the options reports the selection without running it. The result is a plain table,
the same whether it came back from an invoke, a remote or `Testing.run`:

```lua
{ ok = true, realm = "server", passed = 12, failed = 0, durationMs = 340,
  sections = { { name = "economy", passed = 12, failed = 0,
                 tests = { { name = "buying deducts the price", ok = true, durationMs = 3 }, ... } } },
  unknown = {} }  -- filter entries that named nothing; any makes ok false
```

Every test also prints one line, `[FWTEST] server economy/buying deducts the price: PASS (3ms)`,
and the run ends with a summary line, so the Output window and a task's log read the same as
the table.

Each realm has its own instance callback: a client with the plugin answers on the same
`Workspace.FlameworkTests` for its own tests, and `FlameworkTestsServer` is how it reaches the
server's. A second invoke while a run is in progress raises.

### Both realms in one session

`flamework-test test` runs the server's sections and then the client's in the same play session,
so the client's tests run against a server whose own tests have already run, and they see
whatever those left on the wire. One engine fact matters there: a RemoteEvent message fired at a
client before it has connected `OnClientEvent` is not dropped, the engine queues it and delivers
it the first time anything connects. A server test that `predict`s with the real player, through
a handler that answers with `fire(player, ...)`, therefore leaves a reply waiting, and it lands in
the middle of the client's cases as an answer nobody asked for. Predict with a stand-in that is
not a `Player` (`scratch()` will do) and have the answering handler skip it:

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

The template's `networking` sections are written this way.

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

`entry` exists for one reason: an Open Cloud task loads the place but runs none of its Scripts,
so nothing ignites the game there. The runner has to require a ModuleScript and call its
`ignite()` itself, and `entry` names it. In Studio the place runs its own Scripts and the module is
up before anything invokes the tests, so a project that only ever runs its tests locally never sets
it. A cloud command refuses to publish without it.

`activeIn` and `inactiveIn` follow the same rules as everywhere else: at least one active name,
none of the names active, and an empty `activeIn` is no constraint. `TestingPlugin` is the plugin
with the file's settings; `createTestingPlugin({ ... })` overrides them per plugin, which is what
a test harness of your own would use.

## Shipping

Never ship a build with tests on: the remote lets any client run the server's tests. Keep the
`testing` scope out of the release `.env`. The test files themselves still compile and load
without the scope, since a folder registration requires everything under it; to leave them out of
the place, give the release build a Rojo project that ignores the folders:

```jsonc
// release.project.json, otherwise identical to default.project.json
"globIgnorePaths": ["**/package.json", "**/tsconfig.json", "**/Tests"]
```

`**/Tests` drops every folder of that name at any depth (`**/Tests/**` would leave empty folders
behind). Never register such a folder by its own path, `registerProviders("src/server/Tests")`:
the transformer resolves the path against the project file without regard to `globIgnorePaths`,
and a registered folder that is not in the place stalls ignition in `WaitForChild`. Let the
registration of the folder above it find the tests, with the scope condition on the classes.

---

Previous: [Scopes](11-scopes.md) · See also: [Running the tests](../testing/place.md), [Testing in Studio](../testing/studio.md)
