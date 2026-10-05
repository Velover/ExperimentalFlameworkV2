# Flamework v2

Instructions for a coding assistant working in a project on Flamework v2. They ship inside
`@flamework-experimental/core`, in `node_modules/@flamework-experimental/core/docs/ai/`, so they
match the version the project installed. A project loads this file from its `CLAUDE.md`, or its
own assistant's instructions, with one line:

```
@node_modules/@flamework-experimental/core/docs/ai/flamework.md
```

## Which Flamework

- **v2** is the `@flamework-experimental/*` packages: `core`, `components`, `networking` and
  `testing`, plus `transformer`, the tsconfig plugin that fills in the macros. It is alpha, and its
  API changes between releases.
- **v1** is `@flamework/*` and `rbxts-transformer-flamework`. The Flamework website
  (flamework.fireboltofdeath.dev) documents v1. Don't use v1 docs, or v1's API from memory.
- A project pins every `@flamework-experimental/*` package exactly and upgrades them together, to
  one release. The
  [CHANGELOG](https://github.com/Velover/ExperimentalFlameworkV2/blob/HEAD/CHANGELOG.md) heads each
  release with the versions it changed, which differ per package, and lists its upgrade notes. A
  package a release leaves out keeps its earlier version.

## Before you work on

Read the file for the area first. Each is short, and points on to the guides for the rest. They are
in `node_modules/@flamework-experimental/core/docs/ai/`:

| Working on                                                        | Read            |
| ----------------------------------------------------------------- | --------------- |
| a provider, an entry point, a new folder, `flamework.config.json` | `providers.md`  |
| a component, or reading components from a provider                | `components.md` |
| network declarations, a handler, a remote call, middleware        | `networking.md` |
| tests in the place, or running them with `flamework-test`         | `testing.md`    |
| a plugin, or a package that other games install                   | `plugins.md`    |

## The guides

The guides ship next to these files, in `node_modules/@flamework-experimental/core/docs/guide/`,
with an index in `node_modules/@flamework-experimental/core/docs/README.md`. Read the matching guide
before you write Flamework code you are not sure of.

| Guide                     | For                                                                         |
| ------------------------- | --------------------------------------------------------------------------- |
| `01-getting-started.md`   | install, tsconfig, Rojo mapping, entry points, common errors                |
| `02-modules.md`           | modules, ignition, `Dependency<T>()`                                        |
| `03-providers.md`         | `@Provider`, registration by folder, injection, lazy providers, `loadOrder` |
| `04-lifecycle-events.md`  | `onInit`, `onStart`, `onTick`, `onPhysics`, `onRender` and their order      |
| `05-components.md`        | components, attributes, instance trees, links, streaming, `Components`      |
| `06-networking.md`        | events, functions, middleware, serialization                                |
| `07-macros.md`            | `Flamework.id`/`createGuard`/`env`, `requireModules`, macros of your own    |
| `08-plugins.md`           | plugins                                                                     |
| `09-project-structure.md` | layout, `flamework.config.json`, obfuscation, `.env`, what to commit        |
| `10-migrating-from-v1.md` | porting v1 code, or advice written for v1                                   |
| `11-scopes.md`            | build scopes                                                                |
| `12-testing.md`           | tests that run inside the place                                             |

## Rules

- Every singleton is `@Provider()` from core, on both realms. There is no `@Service` or
  `@Controller`: the entry point that registers a folder decides the realm.
- Only classes under a registered folder exist at runtime. A new folder needs its own
  `registerProviders("src/...")` or `ComponentPlugin.fromPath("src/...")` line in the entry point of
  each realm that uses it. The argument is a string literal and a source path, not a Rojo path.
- A registered folder must exist, spelled as on disk (case included), and hold a module. The build
  still passes without one, but warns at the call: `there is no such file or folder`, or
  `nothing in that folder compiles to a module`. A missing folder makes the call wait at runtime,
  warning after 5 s that it `is still waiting for its folder`. An empty folder is copied into the
  place and registers nothing, but git keeps no empty folder, so a fresh clone lacks it and waits.
- Registered folders must not overlap (`src/server` and `src/server/services`): ignition raises
  `provider ID was registered more than once`.
- Registration requires every ModuleScript under a registered folder at startup, and a module that
  errors at its top level fails ignition. Keep modules that are neither providers nor components,
  such as the network declarations and middleware, outside those folders. A plain helper that does
  nothing as it loads and serves only that folder may stay.
- Classes are found whether exported or not, if declared at the top level of a file or namespace.
  Export them anyway when another file, or a test, imports them.
- Inject providers through the constructor. `Dependency<T>()` is for code without a constructor,
  once the module has ignited; never call it at a module's top level.
- Components attach only after every provider's `onStart` has run to its first yield. In a
  provider's `onStart`, `getAllComponents<T>()` finds none yet: use `onComponentAdded<T>()`.
- Settings go in `flamework.config.json`, one section per package. The tsconfig plugin entry holds
  only `"transform"` (and `"configFile"`, to move that file); the build refuses any other key.

## Building

- `rbxtsc` is the check: it must exit 0 and print no `error TS` and no Flamework warning. Colour
  codes can split `error TS` and `[Flamework]` even in a log, so search a log for `error` and
  `Flamework`.
- A watcher (`rbxtsc -w`) keeps the `flamework.config.json` and `.env` it started with: restart it
  after changing either.
- Generated and never edited: `out/`, `include/` (including `include/flamework/`) and
  `flamework.build`. `flamework.config.json` is config: commit it and keep its `$schema` line,
  which makes the editor list every option.
- With `incremental` on, the first build after an upgrade stops with
  `Project was compiled on different version of Flamework` and names the tsbuildinfo to delete:
  delete it and build again.

## How much to test

Match the testing to the change.
- **The build (`rbxtsc`):** takes seconds. Run it after every change.
- **Studio runs (`flamework-test`, or the project's test script):** take minutes. Run only the
  sections the change touches, with `--sections` (and `--realm` when only one realm is involved).
  A change to docs, comments or a name inside one file needs no Studio run.
- **A whole run, several Rojo projects, cloud runs and benchmarks:** only when the user asks, or
  after you suggest it, saying why and how long it takes, and the user agrees.

## Gotchas

- Most of Flamework's API is macros that the transformer fills in. Without the transformer they
  are silently `nil`: read the emitted Luau in `out/` when an argument is unexpectedly missing.
- A Rojo project can map all of `node_modules/@flamework-experimental` in one line (guide 01),
  which needs transformer 2.0.0-alpha.5 or later. The place then gets an empty `transformer`
  Folder, and core's docs as three empty Folders, `core.docs`, `core.docs.ai` and
  `core.docs.guide`: all expected.
- Shared modules run on both realms, and `Players.LocalPlayer` is undefined on the server. Guard
  realm-specific top-level code with `RunService.IsServer()` or `IsClient()`.
