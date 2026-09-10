# Flamework documentation

Flamework is a framework for roblox-ts built around **modules**: dependency-injection containers you
ignite explicitly. Everything else -- lifecycle events, components, networking -- is a plugin or a
package layered on top of that.

> These docs cover **v2**, which is unreleased. The
> [Flamework website](https://flamework.fireboltofdeath.dev/docs/introduction) documents v1, and
> most of it no longer applies -- see [migrating from v1](guide/10-migrating-from-v1.md).

## Guide

Read in order the first time. Each page ends with the caveats for that topic.

| | Page | Covers |
|---|---|---|
| 1 | [Getting started](guide/01-getting-started.md) | Install, `tsconfig`, Rojo, your first working module on both realms. |
| 2 | [Modules](guide/02-modules.md) | What a module actually is, ignition and teardown, `Dependency<T>()`. |
| 3 | [Providers](guide/03-providers.md) | `@Provider`, automatic registration, dependency injection, `@Injectable`. |
| 4 | [Lifecycle events](guide/04-lifecycle-events.md) | `OnStart`, `OnTick` and friends, ad-hoc listeners. |
| 5 | [Components](guide/05-components.md) | Instance-bound classes, attributes, guards, streaming, dependencies. |
| 6 | [Networking](guide/06-networking.md) | Events, functions, namespaces, unreliable channels, middleware. |
| 7 | [Macros](guide/07-macros.md) | What the transformer fills in, and writing macros of your own. |
| 8 | [Plugins](guide/08-plugins.md) | Hooks and interfaces: extending Flamework itself. |
| 9 | [Project structure](guide/09-project-structure.md) | Folder layout, one module or several, testing. |
| 10 | [Migrating from v1](guide/10-migrating-from-v1.md) | What changed, and what to do about it. |
| 11 | [Scopes](guide/11-scopes.md) | Build scopes from `.env`: test scenarios, debug tooling and stand-ins that only exist in the builds that ask for them. |

## Reference

- [Internals](reference/internals.md) -- what the transformer does to your code and what the runtime
  does with the result. Read this to change Flamework, or to debug something that only fails at
  runtime.
- [Transformer plugins](reference/transformer-plugins.md) -- adding macro types of your own.

## Testing

- [Testing in Roblox Studio](testing/studio.md) -- the battletest that runs a real place through the
  packages: setup, the automated matrix, the manual scenarios, and what the first run found.

## I just want to…

| | |
|---|---|
| …get a service running | [Getting started](guide/01-getting-started.md), then [Providers](guide/03-providers.md) |
| …run code every frame | [Lifecycle events](guide/04-lifecycle-events.md) |
| …attach a class to an Instance | [Components](guide/05-components.md) |
| …send something to the server | [Networking](guide/06-networking.md) |
| …understand why an argument is `nil` | [Macros › when a macro does not fire](guide/07-macros.md#when-a-macro-does-not-fire) |
| …know what an error means | each guide page has a **Caveats** section listing them |
