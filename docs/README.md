# Flamework documentation

Flamework is a framework for roblox-ts built around **modules**. A module is a dependency-injection
container that you create and start yourself; starting it is called *igniting* it. Everything else
is a plugin or a package built on top of modules: lifecycle events, components and networking.

> These docs cover **v2**, which is still in alpha: its packages are published as `2.0.0-alpha`
> prereleases. The
> [Flamework website](https://flamework.fireboltofdeath.dev/docs/introduction) documents v1, and
> most of it no longer applies. See [migrating from v1](guide/10-migrating-from-v1.md).

## Guide

Read the pages in order the first time. Most pages have a **Caveats** section for their topic, near
the end.

| | Page | Covers |
|---|---|---|
| 1 | [Getting started](guide/01-getting-started.md) | Install, `tsconfig`, Rojo, your first working module on both realms. |
| 2 | [Modules](guide/02-modules.md) | What a module is, igniting and extinguishing it, `Dependency<T>()`, importing one module into another. |
| 3 | [Providers](guide/03-providers.md) | `@Provider`, automatic registration, dependency injection, `@Injectable`. |
| 4 | [Lifecycle events](guide/04-lifecycle-events.md) | `OnStart`, `OnTick` and the other events, and listeners you attach by hand. |
| 5 | [Components](guide/05-components.md) | Classes attached to instances: attributes, guards, streaming, dependencies. |
| 6 | [Networking](guide/06-networking.md) | Events, functions, namespaces, unreliable channels, middleware, and serialization: payloads packed into buffers by generated code (for every member, or per member with `Serialized` and `Raw`), byte widths, implicit widths and their checks, size on the wire. |
| 7 | [Macros](guide/07-macros.md) | What the transformer fills in (ids, guards, paths with `requireModules`, serializers with `Flamework.createSerializer`), and writing macros of your own. |
| 8 | [Plugins](guide/08-plugins.md) | Extending Flamework itself with hooks and interfaces. |
| 9 | [Project structure](guide/09-project-structure.md) | Folder layout, one module or several, `flamework.config.json` and its sections (`transformer`, `serialization`, `core`, `networking`, `components`, `scopes`, `testing`, `cloud`), obfuscation, values from `.env`, watching, what to commit, testing with a fresh module and fakes, Studio plugins and models. |
| 10 | [Migrating from v1](guide/10-migrating-from-v1.md) | What changed, and what to do about it. |
| 11 | [Scopes](guide/11-scopes.md) | Build scopes from `.env`: test scenarios, debug tools and stand-ins that exist only in the builds that ask for them. |
| 12 | [Testing in the place](guide/12-testing.md) | Sections of tests that run inside a real place through a bindable, a remote or a cloud task, with cleanup that always runs. |

## Reference

- [Internals](reference/internals.md) -- what the transformer does to your code, and what the
  runtime does with the result. Read this to change Flamework, or to debug something that only fails
  at runtime.
- [Transformer plugins](reference/transformer-plugins.md) -- adding macro types of your own.
- [Future considerations](future-considerations.md) -- possible future directions, and the known
  limits that were left alone. It covers the estimated cost of each feature, why Immediate signal
  behaviour stays supported, and simpler rules for rare features.

## Testing

- [Testing in Roblox Studio](testing/studio.md) -- the battletest, which runs a real place on the
  packages. It covers setup, the automated matrix, the manual scenarios, and what the first run
  found.
- [Running the tests](testing/place.md) -- `flamework-test`, run from a terminal. It opens the build
  in Roblox Studio and runs it on both realms, or publishes it and runs it in a real server through
  Open Cloud.
- [The test place](../tests/place/README.md) -- the place that this repository's in-place suite runs
  in. It is linked to the packages' own builds. `bun run test:place` builds the packages and runs the
  suite in Studio under four Rojo projects (default, immediate, deferred, streaming).

## I just want to…

| | |
|---|---|
| …get a provider (a v1 service) running | [Getting started](guide/01-getting-started.md), then [Providers](guide/03-providers.md) |
| …run code every frame | [Lifecycle events](guide/04-lifecycle-events.md) |
| …attach a class to an Instance | [Components](guide/05-components.md) |
| …send something to the server | [Networking](guide/06-networking.md) |
| …understand why an argument is `nil` | [Macros › when a macro does not fire](guide/07-macros.md#when-a-macro-does-not-fire) |
| …know what an error means | the **Caveats** section of the guide page for that topic lists them (pages 1–9 and 11 have one) |
