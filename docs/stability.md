# Stability

What a Flamework 2.x release keeps from the one before it, and what it may change.

From **2.0.0-beta.0** on, everything under [Covered](#covered) changes only in a major release
(3.0). During the beta, a change to it needs a strong reason: a bug, or a design flaw that beta users
run into. Each such change is listed under the changelog's **Upgrade notes** with what to do.
Additions are always allowed: a new export, option, config key, flag, overload or width.
Everything under [Not covered](#not-covered) may change in any release, and the changelog says so
when it does.

The alphas before 2.0.0-beta.0 promised none of this.

## One version for every package

Every `@flamework-experimental` package is released at the same version, the unchanged ones
included: install the same version of all of them. The transformer refuses to build when one of
them was built by another version, and names each one, both versions and the fix. The promise below
is between releases, not between packages of different releases installed side by side.

A library of your own, or a third party's, that is compiled with Flamework and published (its Luau
and its `flamework.build`) keeps working under a later 2.x: that is what the package ids, the
emitted code and the runtime names below are frozen for. The transformer reads such a package's
`flamework.build` whatever 2.x version built it.

## Covered

- **Names that are exported and documented.** What each package's entry exports
  (`@flamework-experimental/core`, `components`, `networking`, `testing`, `transformer-plugin`), as
  the [guide](README.md#guide) documents it: namespaces, functions, macros, decorators, classes and
  their public members, interfaces, types and enums, with their parameters, options and what they
  return. This includes `Modding.Intrinsic` with the intrinsic names `path`, `pathglob`, `env` and
  `plugin` ([Macros](guide/07-macros.md)), though core's declarations mark it `@hidden`, and the
  `@metadata macro` and `@metadata reflect` tags.
- **Config keys.** Every key of `flamework.config.json` (the `transformer`, `serialization`, `core`,
  `networking`, `components`, `scopes`, `testing` and `flameworkTest` sections), its meaning and
  its default; the `${NAME}` and `${NAME:-fallback}` substitution and the files it reads; and the
  keys of the transformer's `tsconfig.json` entry ([Project structure](guide/09-project-structure.md)).
- **flamework-test's commands, flags and variables.** Every command, flag and environment variable
  [Testing in the place](guide/12-testing.md) and the CLI's usage text name, and its exit codes.
- **Package ids.** The transformer names a class or interface a package declares by where the
  package declares it: `$:lifecycle/lifecycleInterfaces@OnStart`, `$c:components@Components`, with
  the prefixes `$` (core), `$c` (components), `$n` (networking) and `$T` (testing). A library
  compiled against one 2.x release holds these strings, and a later one has to answer them, so no
  2.x release moves or renames a declaration that has one. `tests/packaging/abi.test.ts` lists them.
- **The code the transformer emits, and the runtime names it calls.** Code compiled by one 2.x
  transformer runs on the packages of a later 2.x. The runtime names that code imports or calls are
  frozen with it:
  - `Reflect.defineMetadata` and `Flamework._implements`, from core's entry;
  - `t`, from `@flamework-experimental/core/out/prelude`;
  - `SYMBOL_ATTRIBUTE_SETTER`, from `@flamework-experimental/components/out/baseComponent`;
  - a networking handler's `_fire`, `_except`, `_broadcast`, `_invoke`, `_invokeWithTimeout` and
    `_setCallback`;
  - the metadata keys emitted classes carry and the runtime reads: `identifier`,
    `flamework:implements`, `flamework:dependencies`, `flamework:parameters` and
    `flamework:module`;
  - what the transformer passes to a macro's generated parameters.

  `tests/packaging/abi.test.ts` pins the names; a moved file or a renamed helper fails it.
- **Stored `createSerializer` layouts.** No 2.x release changes the bytes a serializer writes for a
  type that already serializes, or what goes into its layout hash, so a buffer stored under one 2.x
  release reads the same under every later one, and a versioned serializer's header check keeps
  passing. New types and widths may be added. A layout change ships only behind an option you turn
  on, or in 3.0 ([Macros › Versions](guide/07-macros.md#versions)). The golden layout test
  (`bun run test:runtime`, its `golden layouts` suite) holds every layout, and passing it unchanged
  is a condition of every release.
- **Documented behaviour.** What the guide says a feature does. A change to it fixes a bug, and is
  listed in the upgrade notes.

## Not covered

- Anything whose name starts with `_` (except the runtime names above, which emitted code calls),
  and anything marked `@hidden` or `@internal` in the declarations (except `Modding.Intrinsic`,
  above). `@internal` declarations are left out of the typings.
- Anything documented as unstable or experimental, such as
  `transformer.optimizations.guardGenerationDedupLimit`.
- The helpers Flamework's packages share with each other, which core's entry exports for
  components and testing: `explainLeftOut`, `leftOutRegistration`, `LeftOutRegistration`,
  `describeConditions` and `importModule`. They are typed, since the other packages import them, and
  marked `@hidden`.
- The constructors of `ModuleDefinition` (made by `ModuleBuilder.build()`) and `Components` (made by
  `ComponentPlugin`), and the `instanceShape` and `links` the transformer writes into a component's
  config.
- Every path under a package's `out/` other than its entry, for your own imports: the two that
  emitted code imports (above) stay where they are, but only for that code.
- The intrinsic names other than `path`, `pathglob`, `env` and `plugin`, and the `intrinsic-*` JSDoc
  tags.
- The wording of errors, warnings and other console output, including the `[FWTEST]` lines, unless
  a page says a format is stable. The exit codes of flamework-test are covered.
- The shape of the generated Luau beyond the names it calls: how guards, serializers and packing are
  written, the locals they use, and the names of remotes and of the folders that hold them (which
  change from build to build under obfuscation anyway). Client and server always come from one
  build.
- The transformer's own JavaScript, other than its `tsconfig.json` entry: nothing but roblox-ts loads
  it.
- The Lune harness and the test place in this repository.
