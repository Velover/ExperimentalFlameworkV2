# Flamework

Flamework is an extensible framework for roblox-ts. It is built around modules that are portable,
isolated and easy to test.

## Documentation

Start with **[docs/](docs/README.md)**. It holds a twelve-part guide, which starts from a working
entry point and builds up to plugins, project layout, scopes and testing. It also holds reference
material:

| | |
|---|---|
| [Guide](docs/README.md#guide) | Getting started, modules, providers, lifecycle events, components, networking, macros, plugins, project structure, migrating from v1, scopes, testing in the place. |
| [Internals](docs/reference/internals.md) | What the transformer does to your code and what the runtime does with the result. |
| [Transformer plugins](docs/reference/transformer-plugins.md) | Adding macro types of your own. |

The guide also ships inside the core package, for the version you installed:
`node_modules/@flamework-experimental/core/docs/README.md` is its index, and the pages are in
`node_modules/@flamework-experimental/core/docs/guide/`. Instructions for a coding assistant can
point there, so that it reads the docs for your version.

The Flamework website documents v1, most of which no longer applies:

https://flamework.fireboltofdeath.dev/docs/introduction

## Development

This repository is a [Bun](https://bun.sh) workspace. It also needs
[Lune](https://lune-org.github.io/docs) on `PATH` to run the runtime specs.

```sh
bun install
bun run build          # builds every package in dependency order
bun run test           # build + transformer tests + runtime specs
bun run lint
bun run test:place     # the in-place suite in Roblox Studio (tests/place); needs Studio, Rojo and Lune
```

### Packages

| Package | Description |
|---|---|
| `packages/core` | Modules, dependency injection, plugins and lifecycle events |
| `packages/components` | CollectionService components, built on the core plugin system |
| `packages/networking` | Remote events and functions |
| `packages/testing` | Tests that run inside a place: sections, cleanup, a bindable and a remote that run them, and a cloud entry point. Also `flamework-test` (`cli/`), the CLI that runs them in Roblox Studio on this machine or through Open Cloud |
| `packages/transformer` | The roblox-ts transformer |
| `packages/transformer-plugin` | Public API for writing transformer plugins |
| `packages/specs` | Runtime specs, built by `rbxtsc` and run under Lune |

### Tests

`bun run test` runs two suites:

- **Transformer tests** (`bun run test:unit`) build a fixture project with the real `rbxtsc` and
  check the Luau it emits: guard generation, identifiers, nested macros and the plugin system.
- **Runtime specs** (`bun run test:runtime`) run the built `@flamework-experimental/core`,
  `components` and `networking` packages under Lune. The harness in [`tests/runtime`](tests/runtime)
  models roblox-ts's `TS.import` tree over the filesystem. It also stubs the parts of the Roblox API
  that Flamework uses: Instances, attributes, CollectionService, RemoteEvents, Players, signals,
  `task`, `Enum`, and a `Heartbeat` pump so that `Promise.delay` runs (and with it, request
  timeouts). The specs cover dependency injection, modules, hooks and the per-frame lifecycle
  events; component construction, dependencies and streaming; and both halves of networking:
  events, functions, middleware and the generated guards.

  The specs run twice, once as `Server` and once as `Client`, because some code paths depend on the
  realm: `@Provider`'s metadata, component streaming, and the client and server halves of
  networking. Running a realm-specific spec from both sides proves that the two sides agree. For
  example, from the server a function receives on `$name` and sends on `@name`, and from the client
  it does the reverse, so the two runs pin down the wire format from both ends.

Specs live in [`packages/specs`](packages/specs). `rbxtsc` builds them like any other project that
uses Flamework, so they test the transformer and the runtime together.

A third suite runs against the real engine, and `bun run test` leaves it out. It lives in the
[test place](tests/place/README.md), a small game linked to the packages' builds.
`bun run test:place` runs its `@flamework-experimental/testing` sections in Roblox Studio, on both
realms, under four Rojo projects (see [Testing in Roblox Studio](docs/testing/studio.md)).
