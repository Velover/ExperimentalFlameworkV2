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
-- the Studio command bar, a debug UI, or scripts/studio/luau-tests.mjs
local result = workspace.FlameworkTests:Invoke()          -- every section
local result = workspace.FlameworkTests:Invoke("economy") -- one section
```

Without the scope, the test providers are not registered (with the condition on the folder
registration, the files are never even required), the plugin is inert, and no instance is made.
One switch, `FLAMEWORK_SCOPES`, turns on both the tests and the host that runs them.

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
  "activeIn": ["testing"],     // scopes under which the plugin attaches: any of them; the default
  "inactiveIn": [],            // scopes under which it never does
  "enabled": true,             // when set, overrides the two above in either direction
  "autoRun": false,            // run everything right after ignition
  "timeout": 30,               // seconds per test
  "entry": "src/server/main"   // ModuleScript exporting ignite(), for cloud tasks
}
```

`activeIn` and `inactiveIn` follow the same rules as everywhere else: at least one active name,
none of the names active, and an empty `activeIn` is no constraint. `TestingPlugin` is the plugin
with the file's settings; `createTestingPlugin({ ... })` overrides them per plugin, which is what
a test harness of your own would use.

Never ship a build with tests on: the remote lets any client run the server's tests. Keep the
`testing` scope out of the release `.env`.

---

Previous: [Scopes](11-scopes.md) · See also: [Testing in Studio](../testing/studio.md), [Testing in the cloud](../testing/place.md)
