# 12. Testing in the place

`@flamework-experimental/testing` runs tests inside a real place: in Studio, in a live server, or
in an Open Cloud task. Tests are plain functions grouped into **sections**, they live in your
project next to the code they exercise, and nothing about them exists in a build that did not ask
for them.

```ts
// src/server/Tests/economy.ts
import { defer, defineTests, expectEqual, test } from "@flamework-experimental/testing";
import { Dependency } from "@flamework-experimental/core";
import { Shop } from "server/services/shop";

defineTests("economy", () => {
    test("buying deducts the price", () => {
        const shop = Dependency<Shop>();
        const wallet = shop.open("test");
        defer(() => shop.close("test"));

        shop.buy("test", "sword");
        expectEqual(wallet.balance, 90);
    });
});
```

```ts
// src/server/runtime.server.ts
Flamework.createModule()
    .includePlugin(LifecyclePlugin)
    .registerProviders("src/server/services")
    .includePlugin(TestingPlugin.fromPath("src/server/Tests"))
    .ignite();
```

```jsonc
// flamework.config.json
"testing": { "enabled": "${FLAMEWORK_TESTS:-false}" }
```

With `FLAMEWORK_TESTS=true` in `.env`, the plugin loads every module under `src/server/Tests`
once the module has ignited, creates `Workspace.FlameworkTests`, and waits. Nothing runs until
something invokes it:

```lua
-- the Studio command bar, a debug UI, or scripts/studio/luau-tests.mjs
local result = workspace.FlameworkTests:Invoke()          -- every section
local result = workspace.FlameworkTests:Invoke("economy") -- one section
```

With `FLAMEWORK_TESTS` unset the plugin does nothing at all: the test files are never required,
no instance is made, and a release build carries no test code path.

## Sections and tests

`defineTests(name, body)` runs `body` at once; inside it, `test(name, fn)` registers a test and
`beforeEach` / `afterEach` register hooks. `name` may be `undefined`, which is the section
`"default"`. The same section name in several files is one section, so a feature's tests can sit
in several files. Sections do not nest, and a name may not contain `/`.

The body of a section receives a context with the section's `name` and, when the plugin loaded
the file, the `module` it was loaded for:

```ts
defineTests("components", ({ module }) => {
    test("finds the tagged part", () => {
        const components = module.resolveDependency<Components>();
        // ...
    });
});
```

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
| The realm's own code | `Testing.run(filter?)` and `Testing.list(filter?)` |
| Anything with the DataModel | `Workspace.FlameworkTests:Invoke(filter?, options?)` |
| A client, for the server's tests | `Testing.runOnServer(filter?)`, over `Workspace.FlameworkTestsServer` |
| An Open Cloud task | see [Testing in the cloud](../testing/place.md) |
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

## Configuration

```jsonc
"testing": {
  "enabled": "${FLAMEWORK_TESTS:-false}",  // load test folders and create the instances
  "autoRun": false,                          // run everything right after ignition
  "timeout": 30,                             // seconds per test
  "entry": "src/server/main"                 // ModuleScript exporting ignite(), for cloud tasks
}
```

`TestingPlugin.createPlugin({ enabled, autoRun, timeout })` overrides the file per plugin, which is
what a test harness of your own would use. The plugin takes the usual scope condition as its
second argument, `TestingPlugin.fromPath("src/server/Tests", { activeIn: ["qa"] })`, and
`fromGlob` / `registerTestsGlob` take a compile-time glob.

Never ship a build with `enabled` on: the remote lets any client run the server's tests.

---

Previous: [Scopes](11-scopes.md) · See also: [Testing in Studio](../testing/studio.md), [Testing in the cloud](../testing/place.md)
