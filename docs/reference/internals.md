# How Flamework works

This is the implementation companion to [the guide](../README.md). It describes what the transformer
does to your code, what the runtime does with the result, and why the pieces are shaped the way they
are. Read it if you are changing Flamework, debugging something that only fails at runtime, or
writing a transformer plugin.

- [Layout](#layout)
- [The transformer](#the-transformer)
- [Macros](#macros)
- [Identifiers and guards](#identifiers-and-guards)
- [The plugin host](#the-plugin-host)
- [The module runtime](#the-module-runtime)
- [Components](#components)
- [Networking](#networking)
- [The test harness](#the-test-harness)
- [Rough edges](#rough-edges)

## Layout

| Package | Contents |
|---|---|
| `packages/transformer` | The roblox-ts transformer. Everything compile-time. |
| `packages/transformer-plugin` | The public API third-party transformer plugins are written against. |
| `packages/core` | Modules, dependency injection, plugins, lifecycle events, reflection. |
| `packages/components` | CollectionService components, built on core's plugin system. |
| `packages/networking` | Remote events and functions. |
| `packages/testing` | In-place tests: sections, cleanup, the bindable and remote host, the cloud entry. `cli/` is `flamework-test`, the Bun CLI that runs them: opens the build in Roblox Studio and drives it through the MCP proxy, or publishes it and runs it through Open Cloud; reads the `cloud` and `testing.entry` config through the transformer's loader. |
| `packages/specs` | Runtime specs, compiled by `rbxtsc` like any other consumer. |

Build order matters and is fixed in [`scripts/build.mjs`](../../scripts/build.mjs): the transformer
plugin API, then the transformer, then the packages that compile with it. Everything after
`transformer` is built by `rbxtsc` running the transformer that was just built, so a broken
transformer breaks the build of everything downstream rather than producing bad output quietly.

## The transformer

Entry point is [`src/transformer.ts`](../../packages/transformer/src/transformer.ts), which roblox-ts
loads as a TypeScript transformer plugin. It builds a `TransformState`
([`src/classes/transformState.ts`](../../packages/transformer/src/classes/transformState.ts)) holding
the program, the type checker, the Rojo resolver, path translation, the build info cache and the
plugin host, then walks each source file.

The walk is a straightforward recursive descent -- `transformFile` → `transformStatementList` →
`transformStatement` / `transformExpression` → `transformNode` -- with handler tables per syntax
kind under `transformations/statements` and `transformations/expressions`. A handler either rewrites
the node or returns it unchanged.

A build error at a node is a `DiagnosticError` (`classes/diagnostics.ts`), reported as a TypeScript
diagnostic whose code is ` @flamework-experimental/transformer`. TypeScript prints it as
`error TS @flamework-experimental/transformer: ...`, the leading space keeping the name apart from
the `TS`, as roblox-ts does for its own (`error TS roblox-ts: ...`).

Two pieces of state matter while transforming a file:

- **File imports.** `state.addFileImport(file, "@rbxts/t", "t")` returns an identifier for a module,
  adding the import if it is not already there. Generated code uses this rather than assuming
  anything is in scope.
- **Root statements.** `state.nextRootStatements` collects statements to prepend at the file root.
  This is how hoisted macro metadata and plugin results get their own top-level locals.

### Compiler internals

The transformer reaches past TypeScript's public API in a few places. Those are typed by
`@roblox-ts/ts-expose-internals`, the roblox-ts maintained fork of `ts-expose-internals` (upstream
stopped at 5.6.3), which regenerates the compiler's full declarations, `@internal` included, for
every TypeScript release. It is installed under the alias `@types/ts-expose-internals` so the
transformer's `typeRoots` picks it up without being named anywhere, and it is pinned to the exact
`typescript` version: bump the two together. A compile error after a bump is the signal that an
internal changed shape, and that is the point -- 5.9 stopped exporting `isDiagnosticWithLocation`,
which a hand-written declaration would have kept promising until it threw at runtime, so
[`src/transformer.ts`](../../packages/transformer/src/transformer.ts) carries its own copy of the
check.

What is used, for whoever has to find replacements:

- Module functions: `addRelatedInfo`, `copyComments`, `findPackageJson`, `forEachAncestorDirectory`,
  `getEffectiveImplementsTypeNodes`, `getLineOfLocalPosition`, `getNameFromPropertyName`,
  `getPropertyNameForPropertyNameNode`, `getSourceFileOfNode`, `hasStaticModifier`,
  `isAccessExpression`, `isDeclarationReadonly`, `isNamedDeclaration`, `isNamespaceBody`,
  `isSimpleInlineableExpression`, `isSuperKeyword`, `removeAllComments`, `signatureHasRestParameter`,
  `skipAlias`.
- `TypeChecker`: `getTypeOfPropertyOfType`, `getUnionType`, `getElementTypeOfArrayType`,
  `getParameterType`. `Program.getCommonSourceDirectory`. `TransformationContext.addDiagnostic`.
- Members: `Symbol.parent`, `Declaration.symbol`, `TypeReference.resolvedTypeArguments`,
  `IntrinsicType.intrinsicName`, and the `TypeFlags.Intrinsic` and `TypeFlags.DisjointDomains` bits.

The compiler the transformer runs on is whichever one roblox-ts bundles:
[`src/index.ts`](../../packages/transformer/src/index.ts) hooks `require` so that every
`typescript` import inside the transformer resolves to roblox-ts's copy, and warns when the versions
differ. roblox-ts 3.0.0 bundles 5.5.3 while this repo is on 5.9.3, so today every build warns and
runs on 5.5.3; everything listed above exists in both. roblox-ts's next build (`roblox-ts@next`,
3.0.0-dev-1a44d8f at the time of writing) is on 5.9.3, so once that is a release the move is the
`roblox-ts` pin plus a test run.

**TypeScript 7.** The native compiler's stable API is expected with 7.1. Nothing here moves before
roblox-ts does, but when it does the list above is the inventory to work from: each entry has to be
re-found in the new API or replaced, the `ts-expose-internals` approach (a declaration overlay on the
JavaScript compiler's module) does not carry across, and neither does the `require` hook. Plan that
as its own change rather than a version bump.

### Configuration

The tsconfig plugin entry is checked first (`assertTransformerEntry`). It may hold `configFile` and
the keys a plugin loader reads itself (`LOADER_KEYS`: roblox-ts's `transform`, `import`, `type`,
`after`, `afterDeclarations`, and ts-patch's). Anything else raises with the key's name: a
transformer option with the config file to move it to, any other key with an instruction to remove
it. Transformer options come from the file alone.

`flamework.config.json` is read in `util/projectConfig.ts`. After the JSON is parsed, `util/env.ts`
substitutes `${NAME}` and `${NAME:-fallback}` in every string from `.env`, `.env.local` and the
process environment, then walks the schema alongside the value to convert strings sitting in
boolean, number and string-list slots, and only then is the schema validated. The runtime sections
-- `core`, `networking`, `components`, `scopes` -- are written to `include/flamework/config.json`
from `saveArtifacts`.

A mistake in the project's own files is a `ProjectError` (`classes/diagnostics.ts`): a config file
that does not parse or validate, a variable it uses that is not set, a value that does not convert,
an option on the tsconfig entry, a game's `$` hash prefix, a `flamework.build` that cannot be used.
`transformer.ts` catches it around the state's construction, prints it through the logger (its
first line in red) and exits with 1, as the version check does: nothing in it is a bug, so it has no
stack. roblox-ts prints anything else a transformer throws with its stack.

The project's `flamework.build` is read only when the build reuses it: an incremental build that
finds its tsbuildinfo, and a watcher's rebuild. A full build starts a new one without reading the
old, so one cut short or holding a merge conflict is replaced rather than refused. A package's is
read by every build, for the ids of its classes. One that cannot be read, is empty, is not JSON or
does not validate stops the build naming the file and what is wrong with it, then what to do:
delete the tsbuildinfo (an incremental build), restart the watcher, or reinstall the package it
came with.

roblox-ts constructs a fresh transformer state per program, which in watch mode is every rebuild,
but the config and environment are used from the first read only: the process-level `Cache` keeps
that `LoadedProjectConfig` and its `fingerprintProjectConfig` (options, file, and the whole
environment, since `Flamework.env` reads variables the file never names). A later state reads
again, and a different fingerprint prints the restart warning while the first read stays in force,
so that files which do not recompile never disagree with the ones that do. The build info records
`idGenerationMode` and drops its identifier table when the mode changes, since an identifier once
generated is answered from the table without looking at the mode again.

Before the process's first read, a game's build gives its config file a `$schema` line
(`addSchemaReference`). With no file, it creates one holding only that line, but only when the
tsconfig is at the package root: below it, the created file would be found first and shadow a
shared one added at the root later. The path goes through the nearest
`node_modules/@flamework-experimental/transformer` that leads to the running transformer, not its
real path, which a linked install (bun, pnpm) makes version-specific. The line is inserted as text,
so the file keeps every other byte. Doing it before the first read keeps the watcher's fingerprint
unchanged, and later compilations of the process skip it. A package (a scoped name) is left alone.

## Macros

A macro is a function whose declaration carries `@metadata macro` in its JSDoc. When a call to one
is transformed, [`transformUserMacro.ts`](../../packages/transformer/src/transformations/transformUserMacro.ts)
inspects each parameter the caller left out and generates an argument for it.

The parameter's *type* says what to generate. Every macro type is a marker intersection -- a real
type intersected with a hidden property the transformer looks for:

| Marker | Declared as | Produces |
|---|---|---|
| `_flamework_macro_many` | `Modding.Emit<T>` | A runtime value for the type: objects, tuples, unions via `Array<T>`. |
| `_flamework_macro_caller` | `Modding.Caller.*` | Callsite information: line, character, width, text, uuid. |
| `_flamework_macro_generic` | `Modding.Target.*` | Information about a type argument: id, text, guard, dependency info. |
| `_flamework_macro_shared_ref` | `Modding.Caller.Constant<T>` | The nested metadata, hoisted to one shared table per callsite. |
| `_flamework_macro_tuple_labels` | `Modding.Target.Labels<T>` | The parameter names of a tuple. |
| `_flamework_macro_hash` | `Modding.Target.Hash` / `Obfuscate` | A hash of a string literal type. |
| `_flamework_intrinsic` | `Modding.Intrinsic<N, M, T>` | Dispatches to a named intrinsic; see below. |

Detection starts at `getUserMacroOfType`, which enters the recursive `getUserMacroOfMany` for `Emit`
types and the shared-ref marker, and otherwise falls through to `getBasicUserMacro` for the caller,
generic and intrinsic markers. The result is a `UserMacro` tree, which `buildUserMacro` turns into
an expression.

Three details are easy to get wrong when changing this:

- **Every argument has to be visited**, not just the ones up to the last generated parameter.
  Arguments beyond it can contain macros of their own; `highestParameterIndex` only decides how far
  to pad with `nil` so a generated parameter lands at the right index.
- **`intrinsic-flamework-rewrite`** redirects the emitted call to a real implementation. It is what
  makes `Flamework.implements`, which is `declare`d and has no runtime value, compile into a call to
  `Flamework._implements`. A `declare`d macro whose macro does not fire compiles cleanly and dies at
  runtime with "attempt to call a nil value" -- that failure mode has accounted for most of the bugs
  found in this area.
- **`Modding.Caller.Constant`** hoists to a file-root local named after the callsite's line, so two
  callsites get two tables and every invocation of one callsite shares a table. Its marker is checked
  before `Emit`'s, because `Constant<Emit<T>>` carries both and finding `Emit` first dropped the
  `Constant`. `Constant` around a basic macro changes nothing.

### Intrinsics

Intrinsics come in two families that are easy to confuse, because both are called intrinsics and
both live in [`transformations/macros/intrinsics`](../../packages/transformer/src/transformations/macros/intrinsics).

**Type intrinsics** are requested by a parameter's type through `Modding.Intrinsic<N, M, T>` and
dispatched on `macro.id`. They generate the argument:

| Intrinsic | Generates |
|---|---|
| `path` / `pathglob` | Rojo instance path segments for a string-literal directory, which is how `registerProviders("src/services")` finds classes. |
| `obfuscate-obj` | An object whose keys are hashed under the given context. |
| `shuffle-array` | An array with its order randomised at compile time. |
| `tuple-guards` | The fixed and rest guards for a tuple, and the guards of any elements after its rest, used for networking argument validation. |
| `plugin` | Whatever a transformer plugin returns; see [The plugin host](#the-plugin-host). |

**Declaration intrinsics** are written in the macro's JSDoc as
`{@link parameterOrTarget intrinsic-name}` and read through `nodeMetadata.getSymbol`. They change
how the call itself is emitted:

| Intrinsic | Does |
|---|---|
| `inline` | Emits the macro's result in place of the call rather than as an argument. |
| `flamework-rewrite` | Redirects the call to a named export of `@flamework-experimental/core`, which is what gives a `declare`d macro a runtime target. |
| `const` | Rejects an argument that is not a literal, because the transformer reads it at compile time. |
| `component-config` | Rewrites a `@Component` decorator's config with generated attribute and instance guards, and with the links read off the component's type parameters. |
| `middleware` | Obfuscates event names inside a networking middleware object. |

## Identifiers and guards

**Identifiers** ([`src/util/uid.ts`](../../packages/transformer/src/util/uid.ts)) are how Flamework
names a type at runtime: dependency injection keys, component ids, `Flamework.id<T>()`. An id is
derived from the declaration's file path and name plus a salted hash, with the format controlled by
`idGenerationMode`: `full` (the default without obfuscation), `short`, `tiny` and `obfuscated`.
Packages must stay on `full` so their ids do not collide with a game's; only game projects should
shorten. The mode only applies to the project's own declarations. An id declared in a package is
read from that package's `flamework.build`, or formatted from its path with the prefix recorded
there (`getDeclarationUid`), so obfuscation leaves package ids as the package published them: the
package's compiled code compares against those strings. An id names a declaration, never its type
arguments: `Set<A>` and `Set<B>` both get `Set`'s, `@rbxts/compiler-types:types/Set@Set`, and an
alias of a named type (`type Players = Set<Player>`) gets that type's.

**Guards** ([`src/util/functions/buildGuardFromType.ts`](../../packages/transformer/src/util/functions/buildGuardFromType.ts))
compile a type into a `@rbxts/t` check. Unions become `t.union` (`t.unionList` past two members), tuples `t.strictArray` (a tuple with a rest element gets a check of its own: the elements before the rest, then any number of rest elements, then the ones after it), arrays
`t.array`, objects `t.interface`, literals `t.literal`, and Roblox datatypes map to their `t` alias.
Types `t` has no alias for compile to `t.typeof("Name")` -- `RBX_TYPES_NEW` is that list, and a type
missing from it silently falls through to the generic object branch and emits a table check, which
is a guard that can never pass.

An instance type intersected with an object type is read as required children:
`Model & { Humanoid: Humanoid }` becomes
`t.intersection(t.instanceIsA("Model"), t.children({ Humanoid: t.instanceIsA("Humanoid") }))`.

**Keys.** A property roblox-ts keys by a number (`{ 10: v }`, `{ [-1]: v }`, `{ [Level.High]: v }`,
read as `v[10]`) is keyed by that number in generated code too: `t.interface({ [10] = ... })`, the
serializer's `v[10]` and decoded `{ [10] = ... }`, a user macro's `Modding.Emit` table. TypeScript
names every property with a string, so `getPropertyKey`
([`src/util/functions/propertyKey.ts`](../../packages/transformer/src/util/functions/propertyKey.ts))
works the key out as `keyof` does: a mapped or late-bound property carries its key's literal type
(TypeScript's `nameType`: `Record<10, V>`, `Partial<Record<Level, V>>`), any other has its
declaration's name, a number for a numeric literal or a computed number. A key written as a string
(`{ "10": v }`) stays a string, and so do a component's attribute names and an instance's child
names, which the engine keeps as strings.

## The plugin host

Transformer plugins register additional macro types. A plugin is a CommonJS module that calls
`registerPlugin`; the transformer loads it with `require` and drains a registry keyed by a global
symbol, so two copies of `@flamework-experimental/transformer-plugin` still share registrations.

The host ([`transformations/plugins/pluginHost.ts`](../../packages/transformer/src/transformations/plugins/pluginHost.ts))
gives plugins two facades rather than raw compiler objects:

- [`typeFacade.ts`](../../packages/transformer/src/transformations/plugins/typeFacade.ts) wraps
  `ts.Type` in a small stable API -- fields, call signatures, union members, literal kinds -- cached
  per type.
- [`nodeFactory.ts`](../../packages/transformer/src/transformations/plugins/nodeFactory.ts) builds
  expressions and statements through opaque handles, so a plugin never touches `ts.factory`.

Results are cached per `(macro name, type)` and, unless the result is trivially duplicable, hoisted
to a file-root local, so a macro used twice in a file emits one table and two references to it.

This used to run inside an `isolated-vm` isolate with every compiler object proxied across the
boundary. That was dropped: `isolated-vm` no longer builds against current Node on Windows, and a
transformer plugin is developer-supplied code that already runs with the compiler's privileges, so
the isolate bought no security it did not already have. The API is unchanged; only the serialisation
is gone.

## The module runtime

A module is described by a `ModuleState` -- providers and plugins -- built by `ModuleBuilder` and
frozen into a `ModuleDefinition`. Igniting a definition calls
`createModuleInstantiation`, which is a closure, not a class: the `Module` interface is a table of
functions over private state.

`Flamework.createModule()` includes `LifecyclePlugin` before anything else. A `PluginDefinition` may
carry a *slot*, an internal tag at most one plugin fills per module: on the builder, including a
plugin whose slot is taken replaces the plugin in it, in place, which is how
`createLifecyclePlugin({ … })` swaps the default out, and `disableDefaultLifecycle()` removes
whatever fills the lifecycle slot. At ignition a second plugin for a filled slot is refused, so a
plugin cannot bring a second lifecycle plugin in behind the module's back.

### Ignition

Ignition is a state machine (`Created → PreIgniting → Igniting → Ignited`, and
`Extinguishing → Extinguished`) whose transitions are checked, so a re-entrant ignite fails loudly
rather than half-working.

0. Before any state changes, every module in `imports` is checked to be `Ignited`. A module that
   fails here is left as it was, and nothing it names is told about it.
1. Plugins are set up. Each plugin's setup function runs against the module through a
   `PluginTarget`, registering providers, provided instances, hooks and observers into this one
   instantiation, and including further plugins, which are set up first. A plugin reached twice in
   one ignition is set up once; the set that says so is marked before the setup runs, so a ring of
   plugins stops on its second arrival. An inclusion given a scope condition that does not hold is
   skipped outright, setup and all.
2. `onPreIgnite` hooks run, sorted by priority and then registration order. This is where a plugin
   registers state that providers will resolve during construction.
3. The registrations are judged (`activateProviders`). For each, three conditions are read -- the
   module's from `ignite`, the registration's own, and the class decorator's -- and all must hold
   against `scopes.active`; a registration that fails is recorded in `skipped` by id, for the
   message a later miss gets. A class registration that an import already resolves to the same
   class is dropped, unless `isolated`, so the import's instance answers. What is left is checked
   for duplicate ids, which is why the builder no longer checks: two registrations may share an id
   as long as at most one survives. Lists of conditions hold an empty condition rather than
   `undefined`, because an array literal with an `undefined` in it compiles to a table with a hole,
   which Luau can neither measure nor walk.

   A collision, here or at a second `provideInstance`, raises one error that names both
   registrations (`module/duplicateId.ts`). Each registration and each provided id carries a
   `RegistrationSource`, recorded once as it is made: the call, the module builder or the plugin
   (each plugin's setup is handed a `PluginTarget` of its own, so what its hooks register is its
   own too), and the line that made it. The line is the first stack frame outside core
   (`utility/callSite.ts`): `debug.info` walks up from the registration, past C frames and every
   frame whose source starts with core's own folder, read once from the source of `callSite`
   itself, so a folder registration, `apply` or a nested plugin still lands on the user's line. A
   plugin whose setup is core's (the lifecycle plugin) is not walked. The walk runs once per
   registration, at startup, and nothing is recorded per frame; the recorded source is only read
   when the error is raised.
4. Objects the plugins provided join the interfaces they implement, now that every observer is in
   place -- each once, however many ids it was provided under, and it leaves them once on release;
   then every kept provider is resolved, which constructs it -- in ascending `loadOrder`
   (`@Provider({ loadOrder })`, default 1), registration order among equals, each after what its
   constructor takes. That construction order is the order observers are told `onAdded` in, which is
   the order the lifecycle plugin runs `onInit` in, so a low `loadOrder` pulls its dependencies
   forward and dependency order still wins. Each provider's `loadOrder` rides along in the
   `onAdded` context (none for a lazy one), and the lifecycle plugin sorts `onStart` by it, stably,
   once, as it starts the providers.
5. `onPostIgnite` hooks run -- the lifecycle plugin runs `onInit` in its own -- and the imports are
   checked again, since a yielding `onInit` lets another thread extinguish one. Before a provider's
   `onInit`, and before a provider without one is started, the plugin waits for the pending
   `onInit`s of any lazy providers of an import that its constructor took directly.
6. The module is `Ignited` and records itself as an importer on each of its imports; then
   `onIgnited` hooks run, each guarded, stopping if one extinguished the module. The lifecycle
   plugin starts the providers and connects `RunService` in its own, so `onStart` runs on a module
   that is whole: ignited, importable, extinguishable, and past everything that can fail it.

A raise in steps 1 to 5 -- a plugin's setup, a hook, a constructor, `onInit` -- is caught: the
module goes `Extinguishing → Extinguished` through the same release as `extinguish` (below), so
the hooks that ran before the raise are undone by the plugins' `onExtinguished` hooks, and the
error comes out afterwards. Without this the lifecycle plugin's `RunService` connections outlived
a failed ignition, ticking providers of a module stuck in `Igniting` that nothing could extinguish.
The default, claimed before ignition so that `Dependency<T>()` answers inside a constructor, goes
back to the root that had it, if that one is still ignited: a failed ignition leaves it as it was.

### Resolution

`tryResolveDependency` checks the instantiated providers, then the kept registrations, constructing
a class provider on its first resolution, then each import's `tryResolveDependency` in order. Going
through the import's own resolver is what keeps ownership with the import: a lazy provider is
constructed by the module that registered it and joins that module's interfaces, so its lifecycle
plugin starts it and the importer's never sees it. Class providers are constructed by reading
`flamework:parameters` off the class, resolving each id, and calling the constructor. Function
providers are invoked with an `InjectionContext` naming the requesting module and origin class.
Alias providers forward to another id.

A miss consults `skipped`: a registration the scopes left out raises `registered but inactive`
with the conditions and the active set, and every message names the imports that were searched.
Next come the path and glob registrations left out by their own condition, which put nothing in
`skipped` because their folders were never loaded (`utility/leftOut.ts`; the module state's
`leftOut` and a plugin target's). A loaded class whose ModuleScript is under one of them names it,
matched by ancestor names against the recorded Rojo path, or against `globs.json` for a glob. An id
nothing has loaded lists them all. Otherwise the module record (below) is asked whether the id
belongs to a class that has loaded (`utility/explainUnresolved.ts`); one that has says what it is
-- a component, a provider nothing here registers, a class that is not a provider -- where it is
defined, and what to do. The walk is linear over the recorded classes, which only a failing
resolution pays for. `Components`' `missingComponentMessage` does the same with its plugins'
left-out registrations.
`lookupProvider` is the non-constructing form of the same walk, used to decide sharing at ignition.

Resolution during `PreIgniting` is refused: providers do not exist yet, and allowing it would make
construction order depend on hook order.

Every constructed object is passed to `registerClassInterfaces`, which checks its
`flamework:implements` metadata -- own and inherited, each id once, since a subclass may re-declare
what its parent implements -- against the interfaces plugins observe and calls each observer's
`onAdded`. `createClassInstance` and `listen` go through the same path, which is why a lifecycle
listener does not have to be a provider. The attachment is all or nothing: an observer that raises
from `onAdded` has the ones before it told `onRemoved`, and the error comes out of the call, so
`createClassInstance` and `listen` that raise have attached nothing and hold nothing. The list is
walked once per class and kept (`utility/getClassImplements.ts`, cache in
`utility/implementsCache.ts`); an object with metadata of its own, such as a `listen` proxy, is
walked on every call. A refusal is undone from a count of the observers told, found again by the
same walk, so an attachment that goes through builds nothing.

### Extinguishing

`extinguish` first extinguishes every module that imports this one, each of which does the same
before returning, so the deepest importer goes first; then it runs `onExtinguished` hooks, releases
the temporary instances the module created, unregisters every provider from the interfaces it was
added to, and removes itself from its imports' importer sets. An importer extinguished on its own
detaches the same way, so the import carries on. Every step of the release runs under `pcall`: a
hook or removal callback that raises is warned about and the rest still run, the state reaches
`Extinguished` and the default is let go of, so a module cannot get stuck half-extinguished --
held, with everything in it, as the module `Dependency<T>()` answers from.

### Reflection

[`reflect.ts`](../../packages/core/src/reflect.ts) is a `WeakMap` from object to property to key to
value, with a `NO_PROP_MARKER` for unscoped metadata. `getOwn*` reads one object; the unprefixed
functions walk the prototype chain via `getmetatable(obj).__index`. `getMetadatas` collects every
value up the chain, nearest first, which is what makes `flamework:implements` aggregate across a
class hierarchy. Writing or deleting `flamework:implements` on a class whose list is cached, or
resetting it, drops the cached lists.

The transformer writes this metadata from a decorator's `@metadata reflect ...` list. Which keys a
decorator reflects matters: `Components` reads `flamework:parameters` to discover component
dependencies, so a decorator that does not emit it disables that feature silently.

**The module record.** For a class that gets an `identifier` and is declared at the top level of its
file, or of a namespace in it, the transformer also writes
`Reflect.defineMetadata(Class, "flamework:module", script)`. `defineMetadata` hands that key to
`utility/moduleClasses.ts`, a map from the ModuleScript to the classes it defined, in definition
order. It is keyed by the `script` rather than read off the identifier, which says nothing about a
class's module once ids are short, tiny or obfuscated, and it only ever holds classes created once
per load of their module: a class declared inside a function gets no record, so the map cannot grow
with calls and a later path registration never finds a test case's class. It is held for good, as
the require cache holds a module's exports.

### Paths

The `path` intrinsic emits a Rojo path as the resolver gives it, relative to the tree's root: in a
place that starts with a service, in a model or plugin with the root's own children. Neither the
emitted code nor `globs.json` says which, so the runtime cannot start from `game` unconditionally.
`saveArtifacts` writes `paths.json` with the depth of the include folder below the root, and
`utility/pathRoot.ts` finds the root once by climbing that far from the `flamework` metadata
folder's parent; with no metadata to climb from it is `game`. `resolveRbxPath` walks a path from
there, with the `StarterPlayer` rewrite to `PlayerScripts` kept for the `game` case, and
`getClassesInPath` and the glob runtime both go through it. It waits for each child without a limit,
as content still replicating to a client has to be waited for, but a child not there within five
seconds (on a client, counted once the place has loaded) is warned about, once per path, naming the
call that gave the path: the registration forms pass `getClassesInPath` their call as written
(`registerProviders("src/shared/components")`, `ComponentPlugin.fromPath(...)`), which the warning
starts with, where the engine's own infinite-yield warning named neither.

The transformer checks the build side. `buildPathIntrinsic` records every use of the `path`
intrinsic in `flamework.build` (`metadata.paths.uses`, per file, dropped when the file is compiled
again, as glob uses are, with `raises` for core's `requireModules`), and `saveArtifacts` ends with
`warnEmptyPaths`, which looks each path up on every build and rebuild with `findPlaceSource`, the
way Rojo builds the place: it takes the deepest `$path` of the project that covers the Rojo path the
macro compiled to (so a `$path` nested inside an out-mapped folder wins, as it does in the place),
judges a `$path` inside `outDir` by the sources roblox-ts compiles into it and any other by the
disk, and matches every name below the `$path` exactly, whatever the file system allows (Rojo names
instances as the disk does), a last segment also matching a file by its instance name (`commands`
for `commands.ts` or `commands.json`). What counts as a module is what Rojo makes one of: `.ts` and
`.tsx` through roblox-ts, `.lua`, `.luau`, `.json`, `.toml`, `.yaml`, `.yml`, and the model files
that may hold one. A path with nothing there, or a folder with no module at any depth, is warned
about at the call; for a name that differs only in case, the warning gives the name on disk.
Without a Rojo path to go by, `findSourcePath` looks the source path up by itself.

`getClassesInPath` requires every ModuleScript under the path, in tree order, and takes from each
the classes the module record holds for it, then whatever it exports that carries its own
identifier and was not among them (`export =`, a re-export, a class compiled by a transformer that
wrote no record), each class once. `requireModulesInPath` is the loading half and still returns
exports only.

`requireModules` is the game-facing macro over that half: a free function in core's exports whose
`@metadata macro` tag reaches the transformer through core's declarations, as `Dependency`'s does.
It walks the path with `findRbxPath` rather than `resolveRbxPath`: `FindFirstChild` first, then,
once the place has loaded (`game.Loaded` on a client still loading), `WaitForChild` with a
five-second timeout, and a missing segment raises with the source path, the Rojo path and the
instance that lacks the child. Before walking, a path under `game` into the other realm's
containers (`ServerScriptService`/`ServerStorage` on a client, `StarterPlayer` on the server) raises
at once, naming the realm to call it from.

Every path and glob registration form first asks `holdsCondition` of its own options: the module
builder's, a plugin target's and `ComponentPlugin`'s. When the condition does not hold, it records a
`LeftOutRegistration` and returns before `getClassesInPath` or `getClassesInGlob`. The scopes are
the compiled `scopes.active`, so this matches what `activateProviders` (or, for components, the
plugin's own scope check) would decide for those classes. Skipping the lookup is what lets a build
leave the folder out of the place.

## Components

`ComponentPlugin` is a plugin whose setup adds its registered classes (those whose scope holds) to
a registration shared by every component plugin of the module being ignited, kept in a `WeakMap`
keyed by the module. The first one set up registers an `onPreIgnite` hook at `HookPriority.First`
that constructs the one `Components` over everything the plugins registered and provides it --
after every plugin's setup, before any provider exists -- and hooks `onIgnited` to
`startCollectionService` and `onExtinguished` to `stopCollectionService`; the others only add
their classes. Two plugins each providing a `Components` of their own collided on its id. It brings no lifecycle plugin of its own: components are constructed
through the module, so they take their per-frame events from that module's.

The DataModel is what a tag is announced by, so the DataModel is what the three places that weigh a
tag ask about: the added handler ignores an instance that is not in it, the removed handler stands by
a removal for one that has left it however tagged it still is, and `canCreateComponentEager` refuses
to build for one outside it. `IsDescendantOf(game)` rather than `Parent`, because those are not the
same question: a descendant of a tree that has been pooled by unparenting still has a parent, and it
is announced as untagged along with its ancestor. Reading `Parent` there left such a descendant
holding a component nothing would ever take away -- the tree could then be destroyed outside the
DataModel, where CollectionService announces nothing at all -- and let `getComponent` build a fresh
one for it.

The interesting part is `ComponentTracker`
([`componentTracker.ts`](../../packages/components/src/componentTracker.ts)). Rather than checking
whether an instance qualifies at a point in time, a tracker holds a set of *unmet criteria* per
instance -- the tag, the instance guard, each plain attribute whose guard fails with no default to
stand in (`invalid attribute 'speed'`, watched through `AttributeChanged` and read once per burst),
and each component dependency -- and notifies its listeners whenever that set becomes empty or
stops being empty. `Components` registers one listener that adds the component when the instance
qualifies and removes it when it stops. The wait-warning is armed when a listener starts waiting
and again on every loss while one still waits, so a component that goes down and stays down says
why, as one that never came up does.

This is what makes dependencies and streaming work with one mechanism:

- A component that depends on another registers a listener on the dependency's tracker, so it
  qualifies only once the dependency does, in either tag order. A dependency Flamework does not build
  on its own -- one with no tag, or one whose predicate refuses the instance -- counts only while it
  is there (`isRefused`, read by `checkInstance` and by what an observer is told). Its entry
  qualifies either way, so `addComponent` and `removeComponent` tell the dependents themselves
  (`noteProvided`). It used to count as met, and the dependent's construction raised asking for it.
  A removal by hand leaves a tagged dependency's entry qualifying too, so the removal tells every
  dependent the component has gone whatever its tag, and the next build tells it of the next one; a
  dependent used to go on holding the destroyed one for good. The tag path's listener builds nothing
  while a construction by hand of its component is under way, which that telling can qualify it under.
  A component whose removal is running counts as missing to its dependents (`isRemoving`, read
  where `isRefused` is), since `getComponent` answers nothing for it until the removal is over. A
  tag added back from a handler of the removal's announcement, which runs inside it under immediate
  signal behaviour, qualifies the entry again at once, and a dependent built there raised asking for
  it -- out of the tag's announcement, before the tag path had registered, leaving the instance
  tagged with nothing built. A component added back while its removal runs -- by that tag, by an
  `addComponent` from the handler, or by `destroy` -- is told to the dependents as the removal
  finishes. The removal tells them whatever its teardown did: a `destroy` that raised out of a
  removal by hand used to skip the telling, and the dependent held the destroyed component for good.
- The tag path's listener reports a `destroy` that raises rather than raising it into whatever
  handed it the loss. A dependency's tag going hands the loss round to its dependents before the
  dependency's own removal, and a dependent's raise there skipped that removal, leaving the
  dependency attached to an instance without its tag for as long as the module lived.
- Under `Watching` (or `Contextual` on a client), the tracker follows the instance tree and flips the
  criterion as it fills in or breaks apart. Atomic models are exempt under `Contextual` because they
  replicate whole.

How it follows the tree depends on what the transformer could say about it. An instance type that is
only classes and children is written down as an `InstanceShape` (`instanceShape` in the decorator
config, `shape` on an attribute link), and [`instanceTree.ts`](../../packages/components/src/instanceTree.ts)
turns that into a watcher: one slot per required child, resolved with `FindFirstChild` -- what
`this.instance.Root` reads -- and a node per resolved child that has children of its own. A node
connects `ChildAdded` and `ChildRemoved` on its instance and follows the `Name` of each child it
resolved (and, after that child is renamed away, still that child until it leaves the parent, so
renaming it back is noticed). An addition matters only when it changes what a slot's name resolves
to, a removal only when it was the resolved child, so a second child of a required name and anything
outside the tree cost nothing while the tree is whole. Names are followed only under `watchRenames`
(off by default; `components.watchRenames` in the project config sets the default): a rename is
announced by the renamed child alone -- nothing fires on the parent or on the siblings -- so with it
on, each resolved child's `Name` is followed and, while a slot is empty, so is the `Name` of every
child no slot is following (the node's *candidates*, one connection per child, also taken up by a
child arriving under another name); once every slot resolves, only the children ahead of the last
resolved one in child order stay candidates, since `FindFirstChild` reads the first child of a name
and one of them renamed into it becomes the one read: a sibling renamed to the required name is
heard from the sibling, and a child arriving goes last, so a whole tree pays only for the children
ahead of its resolved ones. A rename heard anywhere re-resolves every slot whose name no longer
resolves to what it records, since a child followed for a rename back can take another slot's name
instead. With it off,
a rename is seen by the next `refresh`, or by the child signals of the slot it concerns. Each change re-resolves its own slot, and the tracker's poll, deferred once per burst,
reads the watcher's answer rather than the tree. `testInstance` re-reads through the watcher's
`refresh`, which resolves every slot again, so what the watcher holds and what the tracker recorded
cannot drift. The child link in `watchLink` follows its name the same way: the child it resolved to
(and, renamed away, still that one), plus every other child as a candidate while the name resolves
to nothing, and every child ahead of the one it resolves to otherwise. The same shape is what
`describeShapeMismatch` names a failure by, in `addComponent`'s error and in the tracker's warning.
`t.children`, which the guard used to be built from, refused two
children of one name outright; with the poll re-running the guard whole, a stray second `Root` took
the component down at the next unrelated removal, and the poll then listened only for additions, so
removing the stray one was never seen.

A guard written by hand (`instanceGuard`), or one the transformer fell back to because the type says
more than classes and children (a union of trees), has no structure to follow, so the tracker
watches the whole tree: it subscribes to the instance's `DescendantAdded` and `DescendantRemoving`
and re-runs the guard on a deferred task, once per burst. Both stay connected whatever the guard
answers, because nothing says which change can overturn a guard written by hand: `t.children`
refuses two children of one name, so a removal can meet it and an addition can break it. The poll
used to connect only one of the two -- additions while the guard failed, removals while it passed,
on the reasoning that a failing guard can only be met by the tree gaining something -- and a
component whose duplicate child was removed stayed unbuilt until some unrelated descendant arrived,
while one that gained a duplicate stayed attached. The handler is the same on both connections: it
re-reads the guard rather than being told what moved, and reports the tree it finds, a reading that
matches the record included.

**Links** are the criteria that reach outside the instance. `BaseComponent` carries its type
parameters on three `declare`d properties -- the attributes as declared, the tree as declared, and
the attributes as *written* -- so the transformer can read each for a different purpose: guards come
from the written shape, where an instance-valued attribute is an `InstanceHandle`, and links come
from the declared one, where it is still the Instance or component type it was named as. The
declared-tree property doubles as the brand that tells a component type apart from an Instance type.

Each link is emitted into the decorator config as `{ kind, name, optional, guard?, component? }`.
At runtime `Components` supplies the tracker with two callbacks: `checkLinks`, for an instance
nobody is tracking, where there is nothing watching and nothing to wait on; and `watchLinks`, which
subscribes per link and reports it as met or lost. An attribute link resolves through
`InstanceHandle:Get`, and parks a thread in `InstanceHandle:Wait` when it is empty. A component link
subscribes to the linked component's tracker on the *target* instance, plus that component's
added and removed signals. The criterion itself is `canCreateComponentEager`, the question
`getComponent` asks on the way in -- the predicate and the ancestry, rather than only the tracker --
with `checkAncestors` on top, because the ancestor lists gate construction Flamework drives and a
link is Flamework driving it. `getComponent` passes it without them, which is what keeps its answer
the same for an instance whether or not a link is watching. Neither excludes a component that is
already attached: the criterion is met by `hasComponent` first, and only asks whether one could be
built when there is none. The one attached component that does not count is one whose tag path's
entry has just stopped qualifying (`isLosing`, read by `hasStandingComponent`). An entry's listeners
are called in no particular order, so a link can be told of the loss before the listener that takes
the component down has run; reading the component as still there reported the link met, and the link
then heard of the loss only from the removal announcement -- which, down a chain of links, is fired
from inside its own handler, one level deeper per link, until the engine refuses (about 80 levels
under deferred signal behaviour) and leaves the rest of the chain attached.

`checkLinks` and `linksMet` are the same function, `areLinksMet`, for the same reason: whether
something happens to be tracking an instance must not change the answer given for it. They used to
differ -- an untracked instance's links had to name a component that already existed, rather than one
Flamework would build -- and that is what made `getComponent` refuse a freshly tagged tree while
`resolveLinks`, reading the same tree in the same resumption, built both halves of it. Tag
announcements are deferred, so "tagged but not yet announced" is the ordinary state a spawner leaves
its tree in, and it is exactly the state that answer was wrong for.

Asking whether a link's component could be built can come back round to the question it started
from, because that component's own links are asked in turn: a ring of links, of which one naming its
own component on its own instance is the shortest. `areLinksMet` therefore records the (instance,
component) pairs it is in the middle of, and answers `false` where one arrives a second time --
nothing in such a ring exists yet, so none of it can be built out of nothing. It is the untracked
counterpart of the provisional tracker entry below, which answers the same question the same way for
an instance that has one.

That answer is also what every path a link constructs *through* goes by. Resolving a component for a
link -- filling `attributeComponents` as an attribute is written or re-pointed, and resolving the
links of a component about to be built -- goes through `resolveLinkedComponent`, which takes an
attached component if there is one and otherwise builds one only where `canCreateComponentEager`
with `checkAncestors` says a link may. Reaching for `getComponent` there instead would build the
component the criterion had just refused, under the very ancestor the lists exist to keep it out of.

A plain instance link's guard is part of the criterion rather than a question asked once on the way
in: it carries the whole shape the target has to have, and a target can gain that shape -- or lose
it -- long after the attribute naming it was written. So a link with a shape follows the target one
required child at a time, as the instance guard's own watcher does, and a link with a guard
subscribes to the target's `DescendantAdded` and `DescendantRemoving`; either re-reads the criterion
on a deferred task. A link naming a *component* carries neither: the tree its target has to have is
that component's own shape, checked and watched by that component's tracker under its own streaming
mode, and the link only asks whether the component is there or could be built there. A component
type cannot be intersected with a tree of its own (`Handler & { Root: Part }` is not a type), so
there is nothing a link could add to what the component already says. The owner's shape stops at a
component-typed child's class for the same reason: the tree below it is not the owner's tree, and
what the child's component keeps under `Disabled`, the owner keeps too.

The warning says why. `ComponentTracker.describeUnmet` reads an instance's unmet criteria -- off its
entry, or from the instance when it has none -- and `Components` explains each: the instance guard
with the child that is wrong, a dependency with what it waits for, a link with what its target is
short of, which for a component link is that component's own `describeUnmet` on the target,
followed to a depth of two so that a ring of links ends. The attribute writer uses the same reading
to tell an instance that can never carry the component it names (its guard fails) from one that
merely has no component yet: the first raises with the reason, the second warns and leaves the
attribute alone.

A component's `onInit` runs inside the constructing window -- after `createClassInstance`, before
the component enters any lookup -- so nothing can see it until it has run: `getComponent` is still
on its way in, a link that would resolve to it has not been handed it, and an added listener has not
been told. Asking for the component from inside its own `onInit` raises as cyclic rather than
building a second one. It is synchronous (a Promise is not waited for). A raise does not fail the
construction so much as freeze it: the component keeps its `activeComponents` slot -- so nothing is
built on top of it, by the tracker, by `getComponent` or by a link -- and gets nothing else: no id
mapping and passed over by `getComponents` (so no polymorphic lookup finds it), no `onStart`, no
announcement, and it is detached at
once from the lifecycle events `createClassInstance` attached it to. `invalid` records it with the
error; `hasComponent`, `getComponent`, `canCreateComponentEager`, `resolveLinkedComponent` and
`refreshLinkedComponent` all read it as absent. It leaves only when the tracker takes it down (or
`removeComponent` by hand), without a removal announcement and with its `destroy` under `pcall`;
the next construction on that instance is a fresh one, `onInit` and all. A link that names the
component is told through `componentInvalidatedListeners` the moment the build fails -- its
criterion was met on the strength of a component Flamework would build -- and `resolveLinks`, for
an owner already under construction when that happens, returns nothing rather than raising, so the
owner waits. A construction by hand raises with the reason; Flamework's own paths warn and answer
that there is no component. The lifecycle plugin, for its part, runs `onInit` and `onStart` only
for providers, before and after ignition alike; `Components` starts a component itself, once it is
attached and -- for one built during ignition -- once `startCollectionService` has run at
`onIgnited`, after the lifecycle plugin's own hook there, so it starts after every provider has.

The constructing window opens before anything is read off the instance, because reading it already
runs code written by hand: a default is written back with `SetAttribute`, and where signals are
immediate an attribute-changed handler runs inside that write. A handler asking for the component
there is answered as a constructor asking for its own is -- nothing -- where an empty slot used to
build a second component, which the rest of the construction then overwrote in `activeComponents`,
leaving the first mapped, announced and never removed. A removal that arrives inside the window --
the constructor or `onInit` removing the component, by hand or by taking its tag away where signals
are immediate, which releases the tag path's entry there and then -- has nothing in the lookups to
take down. It marks the construction in `cancelled`, and `addComponent` undoes it as it finishes
(`removeClassInstance`, `destroy` under `pcall`) rather than attaching a component nothing would ever
remove. `onStart` runs after the component is attached and before it is announced, which
`unannounced` records, and it can remove the component as well: `setupComponent` creates the maid
ahead of `onStart` so that the removal has it to release, the removal announces the component as
added and then as removed -- in that order, with a component not yet destroyed -- and
`setupComponent` then attaches nothing more to it and resolves no waiter with it. A waiter's handler
runs inside the resolve and can remove it just the same, so the waiters are taken off their set one
at a time as each is handed the component: the ones after a removal wait on, and a component built in
its place from inside that handler is the one they are handed, by its own `setupComponent`.

Removal is announced once the component is out of both lookups, which mirrors an addition being
announced only after it is in them. A link that names the departing component reacts to the
announcement by taking its own component down, and a cycle of links would otherwise come back round
and remove the component the announcement came from a second time, or without end. The engine defers
these signals, so the maps are clear by the time a handler runs there anyway. That deferral is also
why the removed signal identifies the departing component by its class rather than by looking it up:
a component announces its removal under every id it inherits, so a subclass leaving would otherwise
read as its parent leaving.

The same deferral is why the announcement is weighed against the target as it stands when it
arrives, rather than acted on as read. A removal by hand leaves the tag and every criterion alone, so
the resumption that made it can ask for the component again and be handed a new one; the removal is
then delivered about a component that has already been replaced, and the link it claims to have lost
is, on the instance itself, still met. Acting on it takes the other side of a ring down, the rebuild
that follows takes this side down, and each round queues the next -- a place that never settles. So a
link acts on a removal only while the target still carries no component of the class it names, and
`refreshLinkedComponent` moves the owner's `childComponents` or `attributeComponents` entry onto the
component that is there now when the added announcement behind it arrives. Every other path here is
keyed on the *target instance* changing, which this case never does.

Leaving those lookups is only half of "the component has gone", because the eager path would put one
straight back: a removal by hand touches neither the tag nor the tracker, so every criterion still
qualifies while the component is being taken apart. The component is therefore marked as *removing*
for the length of the removal, and `getComponent` and `canCreateComponentEager` answer for it the
way they already answer for one that is still constructing. Without that, a handler reaching for the
component it was just told about is handed a second, freshly built one -- announced to nobody, and
not the one any earlier `getComponent` returned -- and `removeComponent` returns with a component
still attached to the instance it was asked to clear.

A child link re-resolves only when the component re-reads its tree at all, which is the same
`typeGuardPoll` the instance guard uses: a child is part of the tree, while an attribute is not and
is followed regardless. Each link remembers the instance it resolved to and reports itself lost
whenever that changes, undefined at either end included, which is what rebuilds a component around a
swapped child. While the component is down, a link that does not re-read its tree follows its name
all the same (`followWhileDown`): a child of that name arriving, and the linked component's
removal, resolve it again whenever the name now resolves to a different child. The build that
follows reads the tree as it is then, and nothing else ever told the link: a linked child
destroyed and replaced by another carrying the component left the owner down for good, still
watching the child that left and holding its entry on the linked component's tracker.

What it starts from is read out of the component, not out of the instance, because a component
outlives the watcher that follows its tree. `getComponent` builds one the moment it is asked for,
while the tag that creates the tracker entry -- and with it these watchers -- is announced a
resumption later, and the tree can move in between. Reading the tree at that point records the swap
as the state the component was built from, and the component runs on against a tree it was never
built out of; the child it holds in `childComponents` is what it *was* built with, so that is the
baseline. A link that does not re-read its tree keeps the child it was built with whatever happens,
so it is seeded with nothing and has nothing to notice.

The other half of that window belongs to the tracker, because an entry is set up before its first
listener is added. A criterion lost while nothing is registered to hear it reaches nobody, and the
listener arriving next is handed the current answer -- "qualified" -- which it answers by handing
back the component that is already there. So an entry remembers a loss nobody heard and replays it to
that listener ahead of the current answer, in the order the two happened: the stale component is
taken down and built again out of the tree as it now stands.

A link attribute's `defaults` entry is read in two places, and only one of them is about the value.
`resolveLinkTarget` falls back to it so that a **required** link resolves at all before the component
exists -- `getAttributes` only runs once one is being built, and a required link would hold that up
forever. `getAttributes` then writes it to the instance as a handle, which is what the component and
every later read see. An optional link needs no standing in once the component is built, so the
fallback is skipped for it then: `nil` on an instance means both "never written" and "cleared", and
answering with the default either way would make clearing an optional link impossible. Ahead of
construction it is read for an optional link too, because it is what `getAttributes` writes and
`resolveLinks` then reads: skipping it there reported the link met for a default that cannot carry
the component the link names, and construction raised. Since the fallback turns on whether the
component is built, the component leaving moves a cleared link back to its default with no attribute
signal to say so: `watchLink`, resolved to nothing while the component was built, also listens for
that component's removal and resolves again on it, so it watches the default -- and hears it regain
the component it names -- once the component is down. The write in
`getAttributes` is not conditional on the guard failing for the same reason -- an optional link's
guard accepts a missing attribute, so nothing else would ever write it, and the component's view
would hold a default the instance knew nothing about.

A link attribute the component writes itself goes through the same refresh, because attribute
signals are deferred and the component would otherwise not see its own write until the next
resumption. `refreshAttributes: false` silences the announcement there as it does everywhere else:
the write still lands in `this.attributes` and `attributeComponents`, exactly as a plain attribute's
own write does, and fires no `onAttributeChanged`. It is the only path that could still announce one
with tracking off -- the external re-point is already silent, and the instance's own attribute signal
is not even connected.

What a link reports is a subscription's answer, and a subscription only knows about the changes it
was told about. The engine defers the child signals, so one link can be asked to rebuild the
component while the signal that would have unmet another is still queued behind it; a child renamed
rather than moved fires no signal at all; and a component that does not poll its tree has no
subscription there in the first place. So qualification is *gated* on reading every link again from
the instance -- `linksMet`, which asks per link exactly what `refresh` does, and which the tracker
consults on the flip to qualified. Only then is the component built. That is what makes "never
reports a link met and then fails to build it" true rather than nearly true: `resolveLinks` reads
the same tree a moment later, and raises on any difference.

It is a gate rather than a criterion of its own for two reasons. A criterion it added could only be
cleared by the reading running again, and the reading only runs while the set is empty, so the
component would never come back. And the answer stops mattering the moment the component exists,
which is what leaves a component whose tree is read once still holding the child it was built with
however that tree moves afterwards -- the gate is only ever asked on the way up.

An entry answers `false` while it is still being set up. It starts out qualified and is corrected as
each criterion subscribes, so a question that arrives before that has finished is a question the
setup asked itself: a link naming the very component the entry is for, on the very instance it is
for -- which is what a link attribute pointing at its own instance is. Handing that question the
verdict the entry has not reached yet is exactly the case the gate exists to rule out, one step
earlier: the criterion is met from a value that only means "nothing has said no yet", `resolveLinks`
then asks for a component that is at that moment constructing, and the construction raises out of
the CollectionService handler that started it. Answered `false`, the link is merely unmet.

The subscription tracks the target with `observeOnly`, which keeps the linked component's tracker
from warning about an instance it is not itself waiting for; the owner's own warning names the link
instead. It is passed down to that component's own dependencies as well, which are watched rather
than waited for through the same entry.

A tracker entry therefore separates the listeners that wait from the listeners that only watch, and
the warning belongs to the first group alone. It is armed by the first listener that waits rather
than by whichever one created the entry -- otherwise a link observing an instance first would
silence the warning for the tag that follows it -- and cancelled again as soon as the last of them
goes, however many observers are left holding the entry open. The thread is released as the warning
is said rather than left behind, so an instance that is tagged, untagged and tagged again waits, says
nothing, and waits again.

Arming and disarming both walk the dependency chain, and each entry remembers the listener it
registered on every dependency so that the walk can move that listener between the two groups. A wait
that starts at the top of a chain therefore makes everything under it wait, and a wait that ends
takes the whole chain out of waiting again. Only the arming half would leave the warning of a
component one instance further down the chain announcing what a tag that has since gone was waiting
for, because a link holding the entry open keeps the cleanup that would have unsubscribed from ever
running.

The first listener that waits also re-reads the criteria, when the entry it arrives at had nobody
waiting. Without a link watching, there would be no entry at all and every criterion would be read
then, for the first time; an entry a link created must not answer differently. It is what keeps an
instance guard that failed while the tree was still filling in from being frozen by whoever happened
to look first, on a realm where nothing polls the tree, and therefore what keeps `getComponent`'s
answer the same whether or not something is watching. On a realm that does poll it, the same re-read
is also what brings the tree's watcher back in step: the entry has to keep answering for itself
afterwards, not only for the moment the tag arrived. A tag reaching an entry whose guard started
passing unannounced -- a child renamed rather than moved, which fires no signal at all -- would
otherwise leave a shape's watcher still waiting for that child to arrive, and the component attached
through every later break in its tree.

`setHasTag` is recorded before the predicate and the ancestor lists rather than after them: the
criterion is a cache of `HasTag` that every entry is answered from, including one a link created for
an instance this component may never be constructed on. Skipping it for a filtered instance is what
would leave such an entry stale, and `getComponent` is then answered from that stale entry.

The tag is not the only criterion an entry caches, so recording it is only half of that job. A
tagged instance the predicate or the ancestor lists turn away never reaches `trackInstance`, and the
re-read above therefore never runs for it: the entry a link created goes on answering with the
instance guard's verdict from before the tree was finished, and on a realm that does not poll the
tree nothing will ever ask again. So both filtered paths re-read the entry themselves before they
return. That is what keeps a link watching an instance under a blocked ancestor from changing
`getComponent`'s answer there -- and with it the escape hatch the ancestor lists leave open, where a
component built on a blocked instance by a `getComponent` of your own satisfies the link that the
lists refused to build one for.

Polymorphic lookup starts from the ids a class answers to. They come from `getPolymorphicIds`, which
walks the class's parents plus its `flamework:implements` list, so a component answers to its own
id, every superclass id and every interface it implements; they are worked out once, as the class is
registered, into `polymorphicIds` and a set of the same, `polymorphicIdSet`. `getAllComponents`
reads one global map from id to component set, which an attached component joins under each of its
ids. `getComponents` keeps no such map per instance: it walks the instance's own components in
`activeComponents` -- rarely more than a few -- and keeps those whose class's set has the id,
leaving out an invalid one. Neither answers in any particular order.

What a component's class decides is read once per class rather than on every construction: the
attribute guards (its own and those of the registered classes above it), the instance check,
whether it implements `OnInit` and `OnStart`, whether it has child or attribute links, and the
config as the class reads it -- each key from the nearest registered class that sets it
(`inheritedConfig`, which `getConfigValue` answers from). A class with no link of a kind holds one
shared, frozen empty table as its `childComponents` or `attributeComponents`. Every construction
hands the module the same `overrideDependency` resolver, which answers for the construction in
`resolvingInfo`/`resolvingInstance`/`resolvingMetadata`: `addComponent` sets them before
`createClassInstance` and puts back the ones it found as it ends, so a component built on the way --
a dependency the constructor asks for -- leaves them as they were. `onStart` runs through
`safeCall` on a recycled thread, which a yielding `onStart` keeps while the next start gets another,
and the message a raise is reported with is only built once there is one. The value an
`onAttributeChanged` handler is told an attribute replaced is the one the component held, read
before the change is stored, except after a write the component made itself: that write stores its
value at once and is reported a resumption later where signals are deferred, so it records the
value it replaced (`SYMBOL_ATTRIBUTE_REPLACED`, made by the first such write) for the report.

A tracker entry makes its sets and maps as it first needs them, and reads a missing one as empty:
for a tagged component with no links, dependencies or polled tree, an entry holds its listener set,
its owner set and whatever cleanup its attribute watch needs. The owners wait by being owners, so
`waiting` holds only the observers that wait -- a dependent's listener while its own entry waits --
and the warning is armed while either is non-empty (`isWaiting`).

## Networking

Networking is two layers, and the split is deliberate:

- `event/` and `function/` are the **primitives**. `createEvent` owns exactly one remote plus its
  receive pipeline and signal; `createFunctionSender` and `createFunctionReceiver` implement the
  request/response protocol over two of those events.
- `events/` and `functions/` are the **namespace API** built on top: they take the generated
  metadata, walk it, and build a handler object whose members are the methods you actually call.

### Serialization

A packed member -- every member but the raw ones with `networking.serialization` enabled in the
project config, the ones declared `Networking.Serialized*` otherwise -- is sent and received
asymmetrically on purpose. Sending is a call-site transform (`transformer/src/transformations/transformNetworkingCall.ts`):
a call to `fire`/`except`/`broadcast`/`invoke`/`invokeWithTimeout` (or the handler's call signature)
on a member whose type carries the hidden `_flamework_send` marker has its argument list packed
inline and is rewritten to the member's hidden `_fire`/`_invoke` counterpart with `(payload,
blobs?)`. Senders carry the declared member as `_flamework_fn`, as function receivers do (an event
receiver carries only `_flamework_receive`; a sender of networking 2.0.0-alpha.3 or earlier carries
none and is read as a plain member), and `getNetworkMode`
(`transformer/src/util/functions/networkMode.ts`) reads its markers (`_flamework_raw`,
`_flamework_serialized`) to decide whether the call packs: a plain member only with the switch on, a
serialized one always, a raw one never. A name declared in both directions makes a member that is
a sender and a receiver at once, `Sender<the other direction's declaration> & Receiver<its own>`.
For a function, whose sender and receiver each carry `_flamework_fn`, the one read off the whole is
the intersection of the two declarations: the sender's call signature first, and the markers of
either (an event's receiver carries none, so an event's is its sender's alone). So a call reads it
off the part that carries its own side's marker (`declaredMember`): `_flamework_send` for a send,
`_flamework_receive` for `setCallback`, whose result is then packed as the receiver's own
declaration lays it out, the one its callers decode it with, and each side packs or not as its own
declaration's markers say. A member marked both raw and serialized is a build error
that names it. A target typed as a union of members (a conditional, a helper that returns a member
by name) is taken member by member: the call packs, as its first member would, when every member
packs, and is left alone when none does. Members that disagree are a build error that names the
call, and so are packed members whose argument lists (for `setCallback`, results) are not laid
out and checked alike: `packingKey` gives the generator's `wireKey` of the list each member's
decoder reads (widths, literal tables, field keys and union members in order, and which widths and
lengths are checked), so one TypeScript type spelled two ways (`(x: string | number)`,
`(x: number | string)`) differs, and members laid out and checked alike pack together whatever their
types. The key is stricter than the bytes: `u8` against `Implicit.u8`, or an empty argument list
against one whose only argument is `undefined`, write the same bytes and are still refused.
For the union to hold every member, each sender and function receiver carries two type arguments
of its own, each as a hidden field that is never set. One is how it is packed (`_flamework_packing`,
from `NetworkPacking<F>`): without it TypeScript's subtype reduction, in a conditional or an
inferred return type, would keep only the member type the others extend, a plain member in place
of a `Serialized` one and a `Raw` one in place of any. The other is the member's name after its
namespaces' names (`_flamework_member`, from `NetworkMemberName<P, k>`: `"setA"`,
`"items.setA"`): without it two members packed the same way whose types differ only in such a
spelling, or in the order of an object type's fields, would be one TypeScript type, and the
reduction would keep one of them before the check saw the call. The handler types thread the
namespace path through their recursion (`ServerHandler<E, R, P>`, `P` from `""` to `"items."`).
The name's type parameter defaults to `string`, so a sender type written by hand
(`ClientSender<[number]>`) takes any member's packed as it says (a `Serialized` member's needs its
packing argument, as before); raw senders carry no name, since no call on them
packs. The transformer never reads `_flamework_member`: it only keeps the union apart. Members of
two networks with the same names, namespace paths included, and the same types are still one type
(guide 06, Caveats).
The packing goes ahead of the statement when that runs it exactly when the call would --
once, unconditionally, after nothing with side effects; behind `&&`/`||`/`??` or a conditional, in
a loop condition, after a sibling with side effects, or in an expression-bodied arrow, the call is
wrapped in an immediately invoked function that holds it instead, so an untaken branch packs
nothing and a narrowed argument is read where its narrowing holds. The target is evaluated ahead
of the arguments, bound to a local when it is more than a plain read; a target reached through
`?.` (typed with `undefined` in it, so the marker is looked for on the rest) always gets the
function, which returns where the chain would short-circuit -- testing the operand ahead of each
`?.` when those are references, so the narrowing the chain gave the arguments still holds, else
the bound target. An argument that is more than an identifier or a literal is bound to a local as
well, in call order, since the packing reads it more than once. An empty list (`[]`, a players list
or a packed value) is bound as `never[]`, the type TypeScript gives the literal: roblox-ts checks
the transformed file, where `const arg = []` is an implicit `any[]` that `noImplicitAny` refuses,
and the parameter's own type might name a type the calling file cannot. The packing reads values
through casts, so the annotation leaves the Luau as it was. `setCallback` on a member whose
receiver carries `_flamework_fn` is registered through `_setCallback(callback, pack)`: the callback
as written, and a generated `pack`, built from the receiver's declared result type, that turns a
successful result into `[payload, blobs?]`. The runtime applies `pack`
to what the middleware chain returns (a Promise already followed), so middleware sees plain
results, a value a middleware returns is packed like the callback's own, and `predict` resolves
with the value itself. Receiving is metadata:
the `network-decoder` intrinsic resolves to a decoder function per event and function (arguments,
responses), and to `nil` for a member that is not packed; it takes the member's type and name too,
and checks the markers the same way. An event's unreliable flags come from a `network-unreliable`
intrinsic for the same reason: every member of an event network, in both directions, passes that
check wherever a handler of the network is created, including one the handler only sends;
the receive pipeline decodes under `pcall` before the guards and the middleware chain, so they see
plain values, and a decode failure is reported through `onMalformed`. Functions keep the request id and
process result as plain arguments and pack only the payload after them. A call site hands the runtime
a blob list whenever the types have blob slots, filled or not; the runtime leaves an empty one off
the remote (`next(blobs) == nil`), in `_fire`/`_broadcast`/`_except`, `_invokeWithTimeout` (which
`_invoke` goes through) and a function receiver's packed result, so the remote carries `(payload)`
rather than `(payload, {})`. The receiving side decodes a missing list as an empty one (`NO_BLOBS`
in `middleware/processor.luau`). Only the packed paths do this: a raw member's trailing empty table
is a value, and is sent. Apart from those result packers, no encoder for an argument list exists as
a runtime value. A file's table of hoisted
functions (`codec`, below) still holds the `w_` writer of each type it hoists, even in a file that
only decodes.

The generator is `transformer/src/util/functions/buildSerializerFromType.ts`. It classifies a type
into a kind (number with a width, string with a length prefix, object, union, ...), computes its
layout (fixed size or not, minimum size, whether it has blob slots) and then emits three things:
a size expression, writes and reads. A cursor folds constant offsets at compile time and only
materialises a position variable where a variable-size value forces one. Exactly one party moves the
cursor past a union: with a position variable, each branch advances it on its way out, and the
enclosing layout adds nothing; without one, the branches write at literal offsets and the layout
steps over the union itself. Doing both puts everything after the union a union's worth too far
along -- which is what a union whose members all carry nothing (`true | None`, the shape a synced
`Set` takes) used to do inside a collection. A field's name becomes the local its value is read
into, unless that name means something globally: `readonly CFrame: CFrame` would otherwise emit
`const CFrame = new CFrame(...)`, correct once lowered to Luau but rejected by the check the emit
goes through first. Counts and lengths are
LEB128 varints through three helpers (`vsize`, `vwrite`, `vread`) hoisted once per file. Blobs are
addressed by a u32 index written into the buffer, never by their position in the list; what counts
as a blob is decided structurally (declared by `@rbxts/types`, a `_nominal_` marker, `unknown`,
`object`, a class, an empty object type), not by a list of names. Union members are numbered in
the order they were written: an aliased union reads the order off its own declaration, and an
anonymous one off the spelling the value is reached through -- the parameter, property, return
type or tuple element, walked into array, `Set`, `Map` and `Promise` arguments -- as a union kind
of that spelling's own (`spell`), since TypeScript's own order is by internal type id and it keeps
one type for every spelling of `string | number`. A member written as another union follows that
union's own written order (`orderAlternatives` walks into parentheses and a non-generic alias's
declaration), after its parts the checker creates when it starts, which go first, at their places
(`memberRank`, below), where alpha.7's ids put them whatever order the union wrote them in: with
`type Id = number | string`, `Id | Alpha` numbers `string` 0. The
members no spelling orders -- a union with no node, reached through a generic's type argument, or
the members of a generic alias's instance -- follow the written ones by `alternativeRank` (`byKey`):
first the group `alternativesOf` lists them in, which 2.0.0-alpha.7 numbered them by and which never
depended on ids (`boolean`, the other types, whole Roblox enums, the literal group). The types split
in two. The built-in ones (`string`, `number`, `object`) go first, by their place in
`INTRINSIC_ORDER`: `createTypeChecker` creates them ahead of every other type, in one fixed order,
the same in TypeScript 5.5.3 and 5.9.3, so their ids put them first, in that order, in alpha.7 too.
The list holds their `intrinsicName`s in that order, written out, so it never reads an id and does not
depend on the TypeScript version loaded. The rest go first by `nestingDepth`, how deeply a type
nests type arguments: the checker can only create an array, a tuple, a generic's instance or an
intersection after the types it is made from, so alpha.7's ids put `Item` ahead of `Item[]` and
`Box<Item>` in every build. It ranks by depth whether or not one type is made from the other
(`Zed` before `Alpha[]`), and sees no type arguments in a non-generic alias of a generic alias's
instance (`type AZed = Wrapped<Zed>`), which TypeScript keeps without them. Then by `typeKey`, a text
of the type alone (a named type's name inside its namespaces, with its type arguments; sorted
members and properties otherwise), never `typeToString`, which prints a union's members in id order.
Generated text that never reaches the wire still follows ids, as in alpha.7: the type a check's or
an array hole's message names (`displayName`) and a hoisted function's name (`generatedName`) come
from `typeToString`. A TypeScript enum's computed member, a type of its own, ranks by the enum's
name and its declaration index
(`enumMemberOf`), so a whole enum keeps alpha.7's order, its computed members first; an enum written
as a member goes by its declaration order (`byDeclaration`), as alpha.7's ids put it. Two members
with one rank stop the build. A member written as a union that no spelling orders
(`Prims[keyof Prims]` in `Prims[keyof Prims] | Alpha`) has its parts placed by `memberRank`: alpha.7
put each part where the first of its types came in the member's ids, so a part holding a type the
checker creates when it starts goes at the earliest such place (`startupRank`: a built-in type's place
in `INTRINSIC_ORDER`, `false` and `true` among them, then `""` and `0`, which `createTypeChecker`
creates later in its start, after `{}`, `` `${number}` `` and other types of its own, as
`emptyStringType` and `zeroType`, then the names `typeof` returns, `TYPEOF_NAMES`, which
`createTypeofType` makes next in `typeofNEFacts`' key order: `"string"`, `"number"`, `"bigint"`,
`"boolean"`, `"symbol"`, `"undefined"`, `"object"`, `"function"`, in TypeScript 5.5.3 and 5.9.3).
So `boolean` goes at `false`'s place, after `string` and `number`, not first as in a union with no
node; the other parts follow by `alternativeRank`. A literal group's values start with `false`,
`true`, `""` and `0`, then the
names `typeof` returns, in that order, ahead of every other literal, as alpha.7's ids put them
(`valueRank`): in `"number" | "string"` and in `1 | "string"`, `"string"` is 0. The other numbers
follow by size, each before its negative: `checkPrefixUnaryExpression` checks `1` before it makes
`-1`, in TypeScript 5.5.3 and 5.9.3. Then the strings, then a TypeScript enum's members in the enum's
declaration order, several enums by name, then Roblox enum items by name, which `simplifyUnion` adds
after every other value (`sortLiterals`; a member is a plain value by then, so `simplifyUnion` says
which ones are, in `literalOrigins`). `keyRank` orders a mapped type's keys by the same
`valueRank`. TypeScript creates an enum's member types
together, in declaration order, so that order was already the ids' and an enum kept its 2.0.0-alpha.7
layout. An enum declared in several declaration files lists its members in the
program's file order, as it did in alpha.7, so a `/// <reference>` can renumber it (guide 06,
Caveats). TypeScript's type ids follow what the checker happened to create first in a compilation,
so until 2026-10 a watcher's rebuild, which compiles a call site without the files that decode it,
could number a literal union or lay out a `Record` differently from them. The order
used to be keyed on the type, first spelling wins, which made a sender in one file and a receiver in
another disagree on the tags. Which member a value is
written as is `evaluation`'s. Exact tests go first, in written order: a `type`/`typeof` check (for a
branded number, also that the value fits its width: range and wholeness for an integer width,
range only for `f32`), a literal, a discriminant, a required key no
other member has. The members checked by a `t` guard follow. A guard ignores keys an object does
not declare at any depth, so `fit` compares the members' kinds, nested ones included, and a member
whose guard would take another's values and write them with a loss goes after it, unless the other
would do the same. The written order stands otherwise, with all-optional objects last, and a loss
that remains gets one build warning per union type per file (each alias or generic instantiation is
a type of its own) through `Logger.warn`, in the empty-glob
warning's form. Catch-all blobs go last. When the last member is a guard-checked table kind, it is
only checked to be a table. A plain `number` member also owns the tag after the members, under which
a whole number below 2^35 travels as a varint. Named variable-size objects, unions and tuples get
`s_`/`w_`/`r_` functions; so does any other variable-size structured type that the values built so
far in the file reach more than once (`countUses`), which is also what hoists a recursive type with
no name of its own. The functions are fields of one table per file (`hoistedTable`): three locals
per type ran a file with about 66 hoisted types past Luau's 200 locals, and it no longer loaded.
There is one generator per file and transform pass (`generatorFor`, keyed by the `TransformState`
and then the `SourceFile`): roblox-ts after 3.0.0 hands a watcher's rebuild the same `SourceFile`
for a file whose text did not change, and a generator kept by file alone took the earlier pass's
table and helpers for emitted. `NodeMetadata` and `getFlameworkDecorators` cache per pass for the
same reason. `hoist` records a type before building its functions, so that it can call itself, and
takes it out again, with every type hoisted while it was built, when building throws; the varint,
width-check and type-check helpers count as built only once they are. The generator records each
definition of a table field it makes (`define`) and each call of one (`noteCall`), and at the end of
a file's transform `checkSerializerOutput` stops the build, naming the type, when the file calls a
field whose definition was never handed out (`takeHoisted`); a file that already has an error is
left to it. The table has an index signature, so TypeScript would not notice.
Result decoders take the function type (`network-result-decoder`), so the declared return type
node is available for that.
A count of elements that take no bytes cannot be checked against what is left, so such counts are
tallied in a per-file variable that every decode resets on entry (decoding never yields) and the
tally is capped at 65535, so nesting cannot multiply what one count may announce.
Members declared `Networking.Raw*` alone get handler types without the send and decode markers
(they carry only `_flamework_packing`; `IsRawMember` gives a member also marked serialized the
marked handler, so the transformer meets it and reports the conflict); the decoder intrinsics return `undefined` for them, and for plain
members with the switch off. `core/src/serialization/types.ts` holds the brands, the
`Serializer`/`Decoder` shapes and `SerializerOptions`, and one function, `versionOf`.
`Flamework.createSerializer<T>()` exposes the same generator through the `serializer` intrinsic.

**Versioned serializers.** `createSerializer` has two overloads. The first is the declaration it
always had, so a call without options resolves to it and emits `Flamework.createSerializer({
serialize, deserialize })` byte for byte as before; the second takes `options`
(`Serialization.SerializerOptions`) ahead of the intrinsic and names it with
`{@link options intrinsic-serializer-options}`. `getSerializerVersion`
(`transformations/macros/intrinsics/serializer.ts`) finds that argument through the call's resolved
signature, as `intrinsic-const` finds its own, wants an object literal without spreads, and reads
`version` off its expression's type, which has to be one number literal, a whole one from 0 to 255:
a literal, a `const`, an enum member (a shorthand `{ version }` reads the variable's own type, since
the property's is widened to `number`). The options stay in the emitted call; the runtime function
returns its last argument, and refuses a serializer whose `version` field (which the transformer
adds to a versioned one) is not the options' version, which is what a transformer from before
versions builds: a serializer without a header, whose buffers would only look versioned.

The header is 5 bytes ahead of the payload: the version as a u8 at 0, the layout hash as a u32 at 1
(`HEADER_SIZE`). `encodeInto` creates the buffer 5 bytes longer and writes both, and the payload
starts at 5: the constant offsets of a fixed layout, the start a hoisted `w_`/`r_` is called with,
or an inline layout's position variable. `decodeBody` checks the header before anything else, each
failure with a message of its own: shorter than a header, another version (named, with a pointer to
`Serialization.versionOf`), or this version with another layout hash ("`T`'s layout changed since
this buffer was written as version n; bump the version and keep a reader for the old one"); then
the payload's own checks run as before, the end compared with the whole buffer. `versionOf` reads
the first byte of a buffer of 5 bytes or more, and gives `undefined` below that. The header has no
mark of its own: a magic byte would cost a byte and still let about one unversioned buffer in 256
through (all of them for a type that starts with that byte), so an unversioned buffer's first byte
reads as a version, and the serializer it reaches refuses it by that byte or by the hash, which it
passes once in 2^32.

The layout hash is the first four bytes of the SHA-256 of `flamework layout <LAYOUT_REVISION>\n`
followed by `layoutText` of the spelled type, read as a little-endian u32 so that `buffer.writeu32`
puts the digest's bytes in order (`layoutHash`). `layoutText` is `wireKey` with `bytesOnly`: the
text `packingKey` compares members by, without what changes no byte (the ` checked` mark of an
implicit width, a blob's `typeof`), cached apart from it. So it is a function of the types alone,
like every order on the wire, and never of type ids, paths or generated names, and it changes when
what a buffer's bytes are read as does: widths and lengths, literal tables in order, field keys in
order, union members in tag order, `^n` for a type met again inside itself. A field's key is a
number as JavaScript writes it, `Infinity` and `-Infinity` included, and a string quoted
(`fieldKey`); `JSON.stringify` alone wrote both infinities as `null`, which let `packingKey` take
members keyed `{ 1e999: V }` and `{ [-1e999]: V }` for alike. A change to how some layout is written
that its text would not show has to change that kind's text, or raise `LAYOUT_REVISION`, which
changes every hash; the golden layouts suite refuses to rewrite goldens otherwise (below).

An object's fields go in TypeScript's order where that follows from the types, and sorted where it
followed the ids (`fieldOrder`, `propertyOrder`). `getPropertiesOfType` lists an interface's or an
object type's own properties as declared, then each base type's, and an intersection's part by part.
A mapped type's come from `resolveMappedTypeMembers` (the same in TypeScript 5.5 and 5.9): with a
`keyof T` constraint written in the declaration (`isMappedTypeWithKeyofConstraintDeclaration`:
`Partial`, `Readonly`, `Required`, `{ [P in keyof T]?: ... }`) it walks `getPropertiesOfType` of
the modifiers type `T`, so it keeps `T`'s order, worked out by the same rules (`mappedOrder` reads
`T` off the type's `modifiersType`, and each property's place off its `syntheticOrigin`, which an
`as` clause keeps). Over any other constraint (`Record`, `Pick`, `Omit`, `{ [K in U]: ... }`) it
walks the key union's members, which is id order, so those go by each property's `keyType`
(`keyRank`), sorted as a literal group's values are, which keeps a `Record` over one enum in its
declaration order. A type holding a mapped type's properties among its own (an interface extending a
`Record`) keeps its order and puts that run in the mapped type's; a property with no declaration that
no mapped type made, or an intersection's property among a mapped type's, cannot be placed, and the
type goes by name.

Width checks (`serialization.checks` in the project config, read by the transformer only and
never written to the runtime config) are generated into the writes. `findBrand` reads a brand's
literal through `getNonNullableType`, so an optional brand (`number & { __brand?: "u16" }`, or
`Serialization.Implicit`'s `_flamework_u16?`) is recognised, and marks the kind `implicit`; before, an
optional brand's `"u16" | undefined` was no literal and the value went out as an f64 without a
word. It reads the literals of the value's kind only (a number's widths for a number, and so on),
from every member of the intersection, and fails naming the type when two of them differ
(`Serialization.u16 & Serialization.Implicit.u8`) rather than taking the first; the same width
named twice is implicit only when every property naming it is optional. `Serialization.Implicit`
gives each width an optional property of its own, so the implicit widths are assignable to each
other and take any strict width of their kind, while implicit into strict stays an error, as it
is for a plain `number`. TypeScript's subtype reduction does not merge two implicit widths: a
subtype has to declare the target's optional properties, which one width's type does not for
another's, so an inferred `[a, b]` or `c ? a : b` of an `Implicit.u8` and an `Implicit.u16` stays a
union. Each strict width declares its twin's optional property too (`u8` has `_flamework_u8?` next
to its required `__brand`), which makes it a subtype of the twin: `[strict, implicit]` reduces to
the twin and `same(strict, implicit)` infers it, as when both were on `__brand`, and `findBrand`
reads the width named twice, once required, as strict. The generator reads declared types (a
parameter's, a property's, the type argument of `createSerializer`), so an inferred type reaches it
only where `typeof` makes it the declared one (`createSerializer<typeof x>()`); there a union of a
width and its twin would cost a tag per value. A failed type is named by `typeText`: an
intersection as `spell` saw it written (`writtenAs`), since TypeScript prints one whose brands
conflict (`Serialization.u8 & Serialization.u16`) as `never`. `computeLayout` and `buildHoisted`
pop `trail` in a `finally`, and `layoutOf` clears `visiting` the same way: a file's one generator
goes on after a failed value, and before this the next error's "Reached through" chain began
with the last one's.
`checkedWidth` decides per kind whether a write is checked (`category`: implicit kinds, every
kind with a width, or none) and returns the width's name. A checked number that is more than a plain
name is read once into a local, and the local, its test and its write go in a `do` block of their own
(`writeNumber`): Luau allows 200 locals in a function, and a call site's code lands in the caller's
function, so a local per checked write left in its scope ran a function of 40 sends, or a struct of
250 fields, past it. The test is the negation of `fitsRange` -- the test a branded union member
already used -- and a failure calls `codec.checkWidth(width, value, where, unit?)`, defined once
per file among the tables (so ahead of the `codec` bodies that call it) in the file's `codec` table
rather than a local of its own: a file that has the table pays no local for it, and one that has
none gets the table, one main-chunk local, which a file already at Luau's 200 cannot take (a limit
that `category: "all"` extends to strict programs). That helper holds the
message (`[Flamework] u16 cannot hold 70000, at Entity.id`), the `mode` (`error(message, 2)`, or
`warn` and `true`) and, for a `side` other than `both`, the realm: it asks `RunService` and returns
`false` outside the realm, so a shared module is checked only where the realm says, and only a failed
value pays for the question. A number literal is judged at build time. The path in the message is
built at compile time: `Ctx.path` grows through `within` as `emitWrite` descends (`.field`, `[i]`
for a known position, `[]` for an element, `<key>`/`<value>`), starting from `value` or the named
type in `createSerializer`, `[i]` per argument at a call site (with the member's name from
`transformNetworkingCall`, left out under obfuscation), and `result` for a callback's result. A
hoisted `w_` is shared by every place that reaches its type, so when the type can fail a check
in its own code (`hasChecks`: not in a union member with a range, which takes only what its test
found in range, nor in a named type inside it, which is always hoisted and checks in its own `w_`) it
takes one more parameter, `where`, which its callers fill with that path as a
constant; the checks inside pass `where .. ".id"`, joined only once a check has failed. A `w_` that
calls another type's `w_` passes its own type's name and path (`"Entity.tags"`), not its `where`
joined, so no write builds a string: the outermost place a value is written from reaches one `w_`
deep. A type without checks keeps the signature it always had. A string8,
string16 or buffer16 keeps the refusal it always had (a length past its prefix would shift every
value after it for the reader); the check's call goes in front of it, so `warn` warns and still
refuses. In a union, a ranged member's discriminant already tests the range, so its write is
`unchecked`; a number no member takes reaches an extra branch in front of the "matches none" error,
`type(v) == "number" and checkWidth(...)`, which writes it as the first checked ranged member when
`warn` lets it through (`numericFallback`; the size pass reserves that member's bytes for any
number that gets there). A plain `number`, `f64` or catch-all member takes every number first, so
such a union has no fallback. The fallback's message names each width once, so a strict width and
its implicit twin read `u16`, not `u16 | u16`. With `category: "none"`, and for every strict width under the default,
nothing is generated and the output is the same as before the checks existed.
Type checks (`checks.types`, off by default) test each value's kind before anything reads it.
`typeCheckIn` decides where: in the pass that reads the value first, which is the size pass for a
variable-size layout (it reads a string with `#`, a varint with `vsize`, a table field by field)
and the writes for a fixed-size one. A union member is written with `Place.tested` (its discriminant
or guard found its kind, so its own test is left out; `within` drops the flag a step further in, and
an object member's field that the discriminant compared, `Place.compared`, is not compared again),
and the argument table a spread call gathers (`args`) is roblox-ts's own. `typeExpectation` gives
the message's expected text (`number`, `table`, `Vector3`, `Enum.Material`, a literal union's
members, a union's alias or its members as written) and `typeTest` the test: `typeIs` (`type()` for
a primitive, `typeof()` for a datatype), `enumTest` (shared with `discriminate`), or `~=` for a
lone literal. A blob is tested only when `typeof` names its type, which is when roblox-ts's
`CheckableTypes` has it (`isTypeofName`), the names `typeIs` takes, and nil stays a blob's 0. A
struct the Roblox API declares (`GroupInfo`) is a plain table no name can test, so `classify` gives
it no `typeofName`: a blob that takes anything, as a nominal type is, tried last in a union. It
used to keep its name, and a union with one (`GroupInfo | number`) emitted `typeIs(v,
"GroupInfo")`, which roblox-ts refuses (TS2345), with the checks off too. `literalKey` prints an
enum item, which `getLiteral` builds as `Enum["Material"]["Plastic"]`, as `Enum.Material.Plastic`.
It used to fall through to `printLiteral`, which printed the node's kind, `#212`, for every item:
in a check's message, in the union warning's name for a union without an alias, and in
`primitiveFit`, which took any two items for the same literal, so members told apart by an item
(`{ key: Enum.KeyCode.A; a?: number } | { key: Enum.KeyCode.B; b?: number }`) were warned about
as members a value cannot tell apart, and could be tried in another order than written.
`discriminantOf` still compares `printLiteral`'s text, under which every item is alike, so a key
holding two or more enum items is never a union's discriminant (a lone item against literals of
other kinds still is: `{ key: Enum.KeyCode.A } | { key: "b" }`): such members are told apart by a
key of their own or by their guards, as before.
`emitTypeCheck` judges a literal at build time, tests a plain local as it is, and reads anything
else (a field, an element, a parameter) into a local in a `do` block of its own with its test:
roblox-ts reads whatever else a macro such as `typeIs` takes into a temporary of the function's own,
one more of Luau's 200 locals per value. A number is tested in `writeNumber`'s block, ahead of a
width's range, whose comparisons would raise on a string, and a boolean in `writeTyped`'s own block
with its write; a boolean literal is judged at build time like any literal (`true` passes, and an
`undefined`, which a call can pass where `strictNullChecks` is off, calls the helper as it is); a
literal union and a union in the branch that already raised when nothing matched
(`codec.checkType(...)` ahead of the old `error`, which stays for the other realm); a variable-size
union in the size pass's chain, as a final `else`. A union whose members are all
tables and that tells one apart by a key without a table test (`v.kind == "a"`) tests `type(v) ==
"table"` once in front (`tablePrecheck`), since indexing a number raises first. The helper,
`codec.checkType(expected, value, where, show?)`, is defined once per file next to `checkWidth`: for
a `side` other than `both` it asks the realm and returns `false` outside it, it builds `[Flamework]
<expected> expected, got <typeof(value)>, at <where>` (`show`, for a literal or an enum, prints a
string, number, boolean or EnumItem as itself), and raises at level 2; under `mode: "warn"` only
`expected == "boolean"` warns and returns `true`, since nothing else of the wrong type can be
written; a lone literal type, `true` included, has its literal as `expected` and raises. A hoisted
type's `s_` takes `where` too when its own code tests a value (`Hoisted.sizeChecks`, from
`hasTypeChecks(type, "size")`), and `hasChecks` counts the write pass's type checks for the `w_`;
callers pass `passedWhere` to both. That `where` is one more of the function's locals, so a type at
Luau's 200 without the checks (sixteen CFrames, twelve locals each, three Vector3s and a string)
would no longer load with them: under type checks, `emitScopedWrite` puts the write of each object
field and tuple element whose code declares a local in a `do` block of its own, so that the `w_`
holds the locals of one value at a time. The size pass needs no such blocks: a type's `r_` holds at
least as many locals as its `s_` with `where` (reading a value takes at least the locals measuring
it does, and `r_` has two parameters), so a type whose `s_` the checks would push past the limit
does not load without them either. With `types` off none of this is generated, and the output is
byte for byte what it was before, but for the `GroupInfo` and `literalKey` fixes above, which apply
either way.
Receiving is untouched: a decoded value always fits its width, and an incoming guard for a branded
number stays `t.number`. A branded buffer (`buffer16`, `buffer32`, strict or implicit) is guarded as
a buffer, `t.typeof("buffer")`, as a branded primitive is guarded as the primitive
(`buildIntersectionGuard`); guarding the brand's object half too rejected every buffer that arrived.

Code packed at a call site is spliced into the caller's function: among the caller's declarations,
and with the caller's own values. The values keep the types they were declared with (`typed`: the
call's arguments, and the copies `bind` makes of them), and TypeScript refuses some casts from those
straight to the loose types the generator writes with (TS2352): a readonly tuple to `unknown[]`, an
object with an index signature to `Map<unknown, unknown>`. `cast` sends such a value through
`unknown` (`origin as unknown as unknown[]`), which leaves nothing in the Luau; what the generator
makes itself is `unknown` already and keeps the single cast. The globals the code names are resolved
where it lands, the call site's scope or, for the hoisted code (`fileLevel`), the module's
(`globalRef`, `globalType`). A `buffer` a caller's local hides (`for (const [player, buffer] of
...)`) is read through a module-level `const buffer_1: typeof buffer = buffer`, and so is a `math`
that a `catch (math)` around a call site hides. roblox-ts refuses a local, a parameter, a function
or an import named after a Luau global it reserves (`error`, `math`, `assert`, `game`, `string`,
`table`, and `type` and `typeof`, which it emits for `typeIs`), but not a `catch` clause's
variable, so a `catch` is the only way to hide those and the module-level alias always reaches the
global. A hidden `error` is not aliased but raised as `assert(false, message)` (`raiseWith`): Luau's
`assert` puts the same position in front of the message as `error` does, and it costs the file no
local, where an alias would take one from the main chunk of a file that loaded before the hole checks
put `error` into its sends (the `assert` macro moves a message with a value in it into a
temporary, inside the branch that raises). Only where a `catch (assert)` hides that too does `error`
go through an alias. A global type a declaration hides (`type Map<K, V> = globalThis.Map<K, V>`, a
function's own `interface Map`) is spelled `globalThis.Map<...>`, which a type position reaches
whatever is declared around it (a hidden `globalThis` itself is a build error) and which leaves
nothing in the Luau; before, a hidden type was refused,
although a project's own alias of the global compiled before that. Anything else hidden (`typeIs`,
`Array`, `Map`, `Set`, `Enum`, `Promise`, the datatypes' constructors), a `buffer` the module
itself declares, and a module-level `warn` that the check helper calls under `mode: "warn"`, is a
build error that names the declaration: a macro or constructor roblox-ts knows by name cannot go
through an alias, and the helpers at the top of the file share the module's scope. `$range` and
`$tuple` are looked up too, but nothing can hide them: they are no Luau identifiers, so roblox-ts
refuses such a local and stops on such a `catch` variable. Guards and literals built elsewhere are
walked for the same names, and a hidden global type in them is rewritten the same way
(`checkGlobalsIn`). The guards `createServer` and `createClient` build for incoming arguments are
not: a module that declares its own, different `Map` next to such a call can still fail to build
there (TS2315), as it could before. What roblox-ts emits by itself is out of reach: inside `catch (table)` or
`catch (type)`, its own `table.insert` and `type(...)` read the caught value, packed or not.
Arrays, records and the `codec` table are typed structurally (`unknown[]`, `{ [key: string]:
unknown }`), so a project's own `Record` or `Callback` is never in the way. A local named after a
field or a type goes through `localName` (`util/functions/identifierName.ts`): a reserved word,
`arguments` or `eval`, a Luau keyword, a global roblox-ts reserves, a leading digit, an empty name
or a global gets a `v_` prefix. The printer renames a unique name only against the identifiers of the
file it lands in, so a field declared in another file (a library's action with an `arguments`
tuple) came out as `const arguments = ...`. A guard's deduplicated local, a macro's hoisted metadata
and a plugin's hoisted value are named the same way.

An array is written by index up to its length (`for i = 1, #array`), as it is counted, and so is a
tuple's rest element. Before, the writes skipped a nil (`for _, item in array`) while the count said
`#array`, so the reader got the list shifted, or ran out of bytes. An element type that takes nil
(`allowsNil`: an optional, `undefined`, `unknown`) writes a hole as a nil. One that does not
refuses it in the pass that reaches the elements first (`elementAt`): the size pass when it walks
them (a variable-size element, where measuring a nil would raise first), otherwise the writes
(`holeInWrite`), with the path a width check would give (`Place`, which `emitSize` carries too)
and the index joined in when it raises. A hoisted `s_` takes no `where` unless type checks are on, so a hole its size pass
finds starts from the type's name even where the type's `w_` checks start from the caller's `where`. Nothing in `serialization.checks` changes that: a hole has
nothing to be written as. `listOf` makes an array type, which is what `Parameters<F>` is for an
array rest parameter, a list of nothing but its rest, as the tuple guards already did
(`[[], guard]`); before, the array was one element, and a call with any other number of arguments
could not be packed.

### Remote ids

The generated metadata carries `incomingIds` and `outgoingIds` per realm, so each side knows what it
receives and what it sends. `createRemoteInstance` finds or creates a folder per global name under
ReplicatedStorage and a remote per id inside it, matching on an `id` attribute rather than the name
-- names are for debugging and may be obfuscated or duplicated.

The global name is a `Modding.Caller.Uuid`: a uuid v5 of `package:file@declaration+offset`, so it
is the same in every file of one build and, without obfuscation, across builds. Under obfuscation
its namespace is the build seed `flamework.build` carries instead of a constant, and since a plain
build recreates that file, every build names its remotes afresh while a watcher, which reuses the
file, keeps them for its lifetime.

An **event** uses one remote for both directions, so its id is the bare event name. A **function**
needs two channels, because a request and its response travel over the same remote in opposite
directions, so ids are prefixed: the server receives on `$name` and sends on `@name`, and the client
is the mirror image. Nested namespaces prefix the path (`stats/report`), and unreliable events get
their own `unreliable:` channel on an `UnreliableRemoteEvent`.

The server creates the tree; the client waits for it to replicate, matching by attribute.

### The receive pipeline

What runs between a remote delivering a message and the handler is plain Luau,
`middleware/processor.luau` and `util/signal.luau` (each with a `.d.ts`), so that an argument list
travels as varargs and keeps its count: roblox-ts builds a table from every `...args` and spreads it
with `unpack`, which stops at `#list`. There is no Promise and no thread of its own in it.

- **Receiving.** `createReceiver` is connected to `OnServerEvent`/`OnClientEvent` directly, so a
  message is processed in the thread the engine runs the handler on, one per message. It decodes the
  payload (under `pcall`; `onMalformed` and a drop on failure) and unpacks the decoded list up to
  its last value (`table.maxn`). `predict` runs the same processor, minus the decoding, on a
  recycled thread (`spawn`), so that a middleware that yields does not hold up the caller.
- **The processor.** `createProcessor` folds the guards, the middleware factories (from the back)
  and a final step into one function. The generated guards run first, ahead of all user middleware,
  so user middleware never observes a payload that failed them; the first failure is reported with
  its 0-based index (`onBadRequest`, a warning with `warnOnInvalidGuards`) and the processor
  returns `rejected`: nothing for an event, which drops it, and `SkipBadRequest` for a function,
  a distinct sentinel that `getProcessResult` maps to a `BadRequest` rejection.
  `Networking.Skip` maps to `Cancelled`. Each factory is handed `processNext`, which calls the next
  link with the list cut after its last value (a middleware that names its parameters hands on a
  list ending in nil) and returns its result, **following a Promise the link returned** in the same
  thread (`awaitStatus`): the value, `cancelled` for a cancelled one (`Networking.Skip` on a
  function), a raise for a rejected one. So a middleware may yield or return a Promise; the thread
  handling the message waits, nothing else does.
- **The signal.** An event's final step fires networking's own signal, which passes its arguments by
  reference (a BindableEvent would copy a decoded `Map<Instance, ...>` into one keyed by strings and
  raise on a `Set<boolean>`). Each handler runs through `spawn`, a recycled thread per handler
  (at most 16 idle threads are kept), so one that yields holds up nothing and one that raises has its
  error printed while the others run; the newest connection runs first, like an engine signal's.
  Connections are copy-on-write, so a fire under way is unaffected by a connect and skips a
  disconnect. `connect` returns this signal's connection, a table with `Connected`, `Disconnect` and
  `Destroy`, not an engine `RBXScriptConnection`; `registerHandler` likewise. Its type,
  `SignalConnection` in `util/signal.d.ts`, is public as `Networking.Connection`.

A message with no user middleware therefore costs the decode and the guard calls, a signal fire, and
one resumption of a parked thread per handler.

### The function protocol

A request is `(requestId, ...args)` on the sender's channel. The receiver runs its processor
(guards, middleware, callback) as plain calls in the thread the channel's signal gives the request,
a Promise the callback or a middleware returned waited for there, then answers
`(requestId, processResult, value)` on the same channel in the opposite direction -- `processResult`
is `true`, or the error to reject with; a raise anywhere, the result's packing included, answers
`false`. The sender makes exactly one Promise per request, the one `invoke` returns: its executor
registers the request in the map of pending ids (per player on the server) and sends it; the
timeout is a `task.delay` that rejects with `Timeout` if the request is still pending, cancelled
with `task.cancel` when the answer arrives, and not made at all for `math.huge`; cancelling the
Promise drops the request and the timer. A send that raises raises to the caller and leaves nothing
pending. Return values are validated on the sender's side, which is what produces `InvalidResult`.

When a player leaves, `Players.PlayerRemoving` cancels every request outstanding for them, and a
request to a player no longer parented to `Players` is rejected at once, whenever its sender was
made. A callback or middleware can return a promise that is then cancelled; the processor reads it as
`Networking.Skip`, and the request is answered `Cancelled`.

## The test harness

The runtime specs run compiled Flamework under [Lune](https://lune-org.github.io/docs), which means
the harness has to be enough of Roblox for the emitted code to run.

**Module loading.** roblox-ts emits `local TS = _G[script]` plus
`TS.import(script, base, ...parts)`, where `base` is an Instance. `harness.luau` models that tree
over the filesystem: every directory and `.luau` file is a node, `TS.import` resolves a node to a
file and loads it with `script` bound in its environment. The tree is built eagerly, because Lune's
`fs` yields and a metamethod cannot. A node answers the few Instance methods path registration calls
-- `IsA`, `GetChildren`, `GetDescendants` (by name), `FindFirstChild`, `WaitForChild`,
`GetFullName` -- and is a `ModuleScript` when it has a file of its own, so a spec can set the path
root to a folder of the specs package and register it by path. Package manifests are read for `main`, and `types` is aliased
onto it -- roblox-ts derives a nested import path from `types` (`lib/t.d.ts` → `lib.t`) while the
module lives at `main` (`lib/ts.lua`).

**Roblox globals.** `roblox.luau` builds one realm's world: services, `Enum`, `task`, an Instance
emulation with attributes, ancestry and signals, CollectionService, RemoteEvents, Players. `typeof`
is shadowed, because `t.instanceIsA` gates on `typeof(value) == "Instance"` and the harness's
instances are tables. Enum items are tables as well, and answer as the engine's do: `typeof` names
them `EnumItem` (an enum `Enum`), `EnumType` is their enum, `tostring` gives
`Enum.Material.Plastic`, and `Value` is the engine's number, from Lune's enum database, which also
lists an enum's items for `GetEnumItems`: the serializer writes an item as its `Value` and reads a
whole Roblox enum back through that list. A Heartbeat pump drives `Promise.delay`, which every
request timeout is built on; Promise.lua is loaded with a `game` of its own
(`context.setPromiseGlobal`) so that the pump does not touch the graph's `RunService.Heartbeat`,
which carries `onTick` and only fires from `__harness.step(delta)`.

**Two graphs.** `harness.create()` returns an independent module graph and `roblox.create(realm)` an
independent world, which is what lets `replication.luau` hold a real server and a real client in one
process. `bridge.luau` mirrors the server's ReplicatedStorage into the client graph and routes
remote traffic between them, deferred like Roblox, with the ability to drop an unreliable message.
The filesystem tree stays shared, so both graphs load byte-identical output and therefore have to
agree on generated remote ids -- identical remote trees on both sides is the assertion that
replication works.

`main.luau` runs the single-realm suites once per realm in separate processes, because a graph
caches realm-dependent decisions at require time. A spec module that fails to load ends the run at
once, with its error; the Heartbeat pump used to keep the process alive until the runner's timeout.

**Golden layouts.** The `golden layouts` suite (`specs/goldenLayouts.ts`) pins what the serializer
writes. Its fixture, `src/golden/layouts.ts`, holds a wide set of types, each with sample values:
every width, check and brand, strings, buffers, objects, collections and tuples (index signatures,
holes, and counts that take two bytes of varint among them), unions written out and not, literal
unions under every ordering rule, TypeScript and Roblox enums, mapped types, the datatypes (NaN,
the infinities and -0 inside the float ones) and the blobs; and a few packed networking members,
with what their events, requests and results send. The suite writes every sample and compares
each buffer, as hex with its blob list's shape, with `packages/specs/golden/serializer.txt` and
`networking.txt`, listing every line that differs with both hex strings; then it reads each golden
back with this build's decoders and wants the sample again, bit for bit, which is what a buffer a
game stored with an earlier build needs: numbers, and the float datatypes component by component,
are compared by their bits, since Luau's `==` takes -0 for 0 (a decoder that lost the sign would
pass) and never takes NaN as itself. A normal run never writes them.
`bun run test:runtime --update-golden` hands its runs `UPDATE_GOLDEN=1`, which makes the Server run
rewrite them (`__harness.golden`) and the Client run check what it wrote, for a deliberate layout
change, named in the CHANGELOG's upgrade notes. A build with `networking.serialization` off refuses
before writing either file. The update is a flag of the runner rather than the variable itself
because a flag reads the same on every shell, and the runner clears the variable when the flag is
not given: one left set in a PowerShell session would otherwise rewrite the goldens on every later
run, and every such run would pass. Maps and sets in the fixture hold one entry at most, since a
table's iteration order is the runtime's, not the layout's, and a NaN sample has fixed bits.
Every case has a versioned twin next to it, the same type argument with `{ version: 1 }`: the suite
wants it to write the header and then the case's own bytes for every sample, one hash per type, and
to read them back, and pins each type's hash in `packages/specs/golden/hashes.txt`, so a refactor
of `layoutText` that moves a hash fails. A few cases at the end are versioned themselves, which pins
a header's bytes in full. Before `--update-golden` rewrites `serializer.txt` and `hashes.txt`, it
refuses a type whose bytes would change under the same hash (`guardHashes`): a buffer stored by a
versioned serializer would pass its header check and be read wrong.

**`@rbxts/signal` is deferred in the engine, and on request here.** The library wraps a
BindableEvent, so every dispatch through it -- `onComponentAdded`, `onComponentRemoved`,
`onAttributeChanged` -- arrives at the end of the resumption in a real place, and inline in this
harness. Anything a handler reads about the state that fired it may therefore have moved on by the
time the engine delivers it: a link telling its own component's removal from a subclass's has to
identify the component by its class rather than by looking it up, because the lookup only still finds
it here, and a removal can arrive about a component the instance has already replaced.

`__harness.deferSignals(callback)` switches to the engine's behaviour for the duration of the
callback: every BindableEvent fire inside it is queued, and delivered afterwards in order, with fires
made by the queued handlers themselves joining the back of the batch rather than nesting. That last
part is the whole point -- it is what lets a spec show a ring of links removing and rebuilding itself
one round per delivery. It covers `@rbxts/signal` and the harness's own BindableEvents; the tag and
tree signals join the same batch through controls of their own, below.

**One batch, three controls.** The engine has a single deferred queue, and so does the harness: tree
signals, tag signals and BindableEvent dispatch all join it in the order they are raised, and the
batch is delivered once the outermost control returns. Nesting the three is how a spec opens a
resumption's worth of a place -- and the interleaving across categories is the point, because a tag
announcement and the child signal for the same move reach their handlers one after the other, in the
order a place raises them. Draining a queue per category at a scope exit cannot show that at all,
and it is what a place's own sequences are made of: `getComponent` builds a component out of a tree
that then moves, and the tag that starts Flamework watching it is delivered after both. Everything
the batch deferred stays deferred while it is delivered. A batch that will not settle is a place that
never settles, which in Roblox is a frozen server rather than an error, so delivery gives up after
200 dispatches and raises; a spec asserts that its block does *not* raise.

**Tree signals are deferred in the engine, and on request here.** ChildAdded, ChildRemoved and the
descendant pair fire inline in this harness, so a spec's own moves arrive one at a time, in the
order it made them -- which hides every case where a handler runs against a tree that has already
finished moving. `__harness.deferTree(callback)` switches to the engine's behaviour for the duration
of the callback: every tree signal fired inside it joins the batch. It is the counterpart of
`__harness.deferTags`, and it is what lets a spec put a link's rebuild in front of the signal that
would have unmet a different link. An error raised by a queued handler does not stop the rest, and
the first one is re-raised once they have all run, so a spec can assert on what would be a red error
in the output rather than only on the state left behind. It covers the tree signals and nothing else;
`__harness.deferTags` and `__harness.deferSignals` cover the other two categories of the same batch.

**Ancestry announces tags.** CollectionService announces a tag when the instance carrying it enters
the DataModel and again when it leaves, which is a second way for a component to come and go, and one
the harness had no answer for at all: a tagged instance parented out stayed attached here and lost
its component in a real place, so two link specs asserted the opposite of what a place would show.
`instance.luau` now tells each realm's CollectionService which instances crossed the boundary -- the
whole subtree, not only the instance that moved -- and `collection.luau` fires the added or removed
signal for every tag they carry. The order is the engine's: the tag is announced as gone before the
old parent's `ChildRemoved` and as arriving before the new parent's `ChildAdded`, with the move
already applied, so every handler reads the tree as it now stands. A service is the root that marks
the DataModel, which is what tells "parented into Workspace" apart from "parented into a folder
nothing holds"; moving within the DataModel announces nothing, and neither does tagging something
that is not in it. The tag itself never moves -- an instance keeps it through all of this -- so
parenting it back in builds the component again.

**Tags belong to the DataModel, not to the runtime's filters.** `AddTag` and `RemoveTag` announce
nothing for an instance the DataModel does not hold, and `GetTagged` does not list one, which is what
a place does. The harness used to announce them regardless, and only the parentless case was masked,
by a `Parent` check in the runtime -- so a tag applied to a *descendant* of a detached tree built a
component here that a place would not have built, and the specs that looked like they were testing
the rule were testing that filter instead. `Instance:Clone` carries the source's tags across for the
same reason: a tagged template cloned into Workspace is how most tagged instances come to exist, and
dropping the tags made that case untestable. `Instance:Destroy` follows the engine's order too,
probed in a real server on 2026-09-11: `Destroying`, then the parent is nilled (announcing the
subtree's tags as gone), then the children come apart with the instance's own connections still
live -- its `DescendantRemoving` and `ChildRemoved` fire for each child against a tree that has
already left the DataModel -- and only then is every connection dropped. An earlier version of the
harness disconnected before the children moved, on the belief that the engine did; it does not,
and the registry has to cope with a component's tree handlers running mid-destroy, which the
`components` suite now asserts. `InstanceHandle.new(nil):Wait(timeout)` answers at once rather
than after the timeout, as the engine's does.

**Clean up a tag that can never qualify.** Specs leave their instances in the world on purpose, which
is harmless for anything that qualifies. An instance tagged for a component it can never satisfy is
not: every later spec builds a module that rediscovers it, arms a warning timer for it and cancels
that timer on `extinguish`. Lune holds a cancelled `task.delay` until its deadline, and enough of
them stall the process long after the last spec has passed -- the suite prints its summary and then
hangs, with no failure to point at. A spec that tags something which never qualifies should destroy
it before it ends.

## Rough edges

- roblox-ts 3.0.0 bundles TypeScript 5.5.3 while the transformer is authored and typed against 5.9.3,
  so every build prints a version warning and runs on 5.5.3. Harmless -- every internal the
  transformer uses exists in both -- but the transformer is not exercised against the compiler it
  targets until roblox-ts releases its 5.9.3 build; see [compiler internals](#compiler-internals).
- There is no v1 → v2 migration codemod; see [migrating from v1](../guide/10-migrating-from-v1.md).
- `scripts/copy-readme.mjs` copies the root README into every package at publish time, and the root
  README now documents the monorepo's development workflow rather than the framework.
  `scripts/copy-docs.mjs` (`bun run prepare:docs`, part of `prepare:publish`, and core's own
  `prepack`, which `npm pack`/`bun pm pack` and the publishes run) copies `docs/README.md` and
  `docs/guide` into `packages/core/docs`. Both scripts point every link to a file the package does
  not ship at GitHub, and leave code fences and code spans alone (`scripts/links.mjs`). core ships
  no Rojo project file, so a place maps its whole folder: the docs arrive as two empty Folders, and a
  nested `node_modules` (npm and bun nest core's `@rbxts/t` there when the game's own is older than
  3.1.0) reaches the place, where the guards the transformer routes through `core/out/prelude` find
  core's own `t`.
- The plugin host loads plugins with `require` at transform time. A plugin that throws takes the
  build with it, which is intended, but there is no isolation if one misbehaves.
- **The harness announces a tag's removal after the instance has left, where the engine announces
  it during the change.** `instance.luau`'s `Destroy` clears the parent and then reports the tags
  gone, so a handler reading `IsDescendantOf(game)` sees the tree it will be rather than the tree it
  was. A real place is the other way round, which hid a components bug from every Lune spec until
  the in-place suite found it (see [testing in the place](../guide/12-testing.md)). Treat anything
  that reads instance state from inside a CollectionService handler as untested here.
- `resolveRbxPath` waits for each child without a limit, so a registered path naming a folder that
  does not exist stalls ignition instead of raising. The build warns where such a path is written,
  and after five seconds the wait warns, naming the registration, but it keeps waiting: a client may
  still be receiving the folder, and a registration that failed there would leave the client dead.
- **Lune 0.10.5 does not reliably let go of a `task.wait` cancelled while it slept**, and holds a
  cancelled `task.delay` until its deadline. A thread parked in `task.wait` and then
  `task.cancel`led can leave the scheduler waiting forever, so the suite prints its summary and the
  process never exits; it depends on timing (a `print` beside it made it go away) and did not
  reproduce outside the harness. The registry's link-attribute poll no longer cancels its sleeping
  thread for that reason: it sets a flag and lets the thread wake and see it. The runner
  (`tests/runtime/main.luau`) defends against both: every case runs under a timeout
  (`FLAMEWORK_SPEC_TIMEOUT`, 30s) and is reported as `HANG` by name when it is up, and the process
  exits explicitly after the summary rather than waiting for the scheduler to drain.
  `scripts/test-runtime.mjs` kills a run that still does not finish (`FLAMEWORK_RUNTIME_TIMEOUT_MS`,
  10 minutes) and prints the last case it reported.
