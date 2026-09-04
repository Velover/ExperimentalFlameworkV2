# Flamework

Flamework is an extensible framework for roblox-ts designed around portable, isolated and testable modules.

## Documentation

Please refer to the Flamework website for installation and documentation.

https://flamework.fireboltofdeath.dev/docs/introduction

For the v2 transformer plugin API, see [docs/transformer-plugins.md](docs/transformer-plugins.md).

## Development

This repository is a [Bun](https://bun.sh) workspace. It also needs
[Lune](https://lune-org.github.io/docs) on `PATH` to run the runtime specs.

```sh
bun install
bun run build          # builds every package in dependency order
bun run test           # build + transformer tests + runtime specs
bun run lint
```

### Packages

| Package | Description |
|---|---|
| `packages/core` | Modules, dependency injection, plugins and lifecycle events |
| `packages/components` | CollectionService components, built on the core plugin system |
| `packages/networking` | Remote events and functions |
| `packages/transformer` | The roblox-ts transformer |
| `packages/transformer-plugin` | Public API for writing transformer plugins |
| `packages/testing` | Runtime specs, compiled by `rbxtsc` and executed under Lune |

### Tests

Two suites, both run by `bun run test`:

- **Transformer tests** (`bun run test:unit`) compile a fixture project with the real `rbxtsc` and
  assert on the emitted Luau — guard generation, identifiers, nested macros and the plugin system.
- **Runtime specs** (`bun run test:runtime`) execute compiled `@flamework/core`, `components` and
  `networking` under Lune using the harness in [`tests/runtime`](tests/runtime), which models
  roblox-ts's `TS.import` tree over the filesystem and stubs the Roblox API surface Flamework
  touches (Instances, attributes, CollectionService, RemoteEvents, Players, signals, `task`,
  `Enum`, and a `Heartbeat` pump so `Promise.delay` -- and therefore request timeouts -- runs).
  They cover dependency injection, modules, hooks and the per-frame lifecycle events, component
  construction, dependencies and streaming, and both halves of networking: events, functions,
  middleware and the generated guards.

  They run twice, once as `Server` and once as `Client`, because realm-dependent code paths --
  `@Provider`'s metadata, component streaming, and the client/server halves of networking -- differ
  between them. Where a spec asserts something realm-specific, running it from both sides is what
  proves the two agree: a function receives on `$name` and sends on `@name` from the server and the
  mirror image from the client, so the pair of runs pins the wire format down from both ends.

Specs live in [`packages/testing`](packages/testing) and are compiled by `rbxtsc` like any other
Flamework consumer, so they exercise the transformer and the runtime together.
