# Changelog

Notable changes to the `@flamework-experimental` packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Upgrade notes

- **A union with `number` has a new tag for whole numbers.** In such a union, a value from 0 to
  2^35 - 1 is written as a varint under a tag after the members. Both realms are built together, so
  remotes need nothing. A buffer that `Flamework.createSerializer` writes in this release raises
  "malformed payload" when an older build reads it. Buffers written by earlier releases still read.

### core

#### Added

- `requireModules("src/server/commands")`, a built-in macro for v1's `Flamework.addPaths` on a folder
  of modules that do their work as they load, such as commands that register themselves with a
  library. It requires every ModuleScript at and under the folder, in tree order, and returns what
  they export, leaving out the ones that export nothing; each module runs once, however often it is
  required. It takes the same source paths as `registerProviders` and works in any module of a game.
  A folder inside a registered folder needs no call: registration already requires every
  ModuleScript under it. A folder missing from the place raises
  `requireModules("..."): the folder is not in the place`, naming the part of the path that is
  missing, after waiting five seconds once the place has loaded; a folder of the other realm (a
  server folder on a client, a client folder on the server) raises at once and says which realm to
  call it from.
- The guide ships in the package, for the installed version: `docs/README.md` (the index) and
  `docs/guide/*.md`. Links between the pages stay relative; links to the rest of the repository
  (reference, testing docs, changelog, packages) point at GitHub. core's `prepack` makes the copy,
  so every `npm pack`, `bun pm pack` and publish carries the docs as they are. Rojo skips the
  Markdown, and a place gets two empty Folders for it, `core.docs` and `core.docs.guide`.

### transformer, transformer-plugin

#### Added

- Each package ships a `default.project.json` that maps it to an empty Folder, so a game can map the
  whole `node_modules/@flamework-experimental` folder in one line
  (`"@flamework-experimental": { "$path": "node_modules/@flamework-experimental" }`): the
  transformer's three JSON schemas no longer arrive in the place as ModuleScripts. With an older
  transformer, keep mapping the runtime packages by name.

### transformer

#### Added

- A build warning when a union has members a value cannot tell apart: two members that could each
  take part of the other's values, such as two patches whose fields are all optional. It is given
  once per union type and file, where the union is first written, in the empty-glob warning's form,
  and names the union and the members. A union spelled through another alias or a generic is warned
  again. A value that fits both may be written as the first of them in the warning's order, without
  the parts only the others declare.

#### Changed

- Serialization: which union member a value is written as no longer depends on the written order
  alone. The members are tried in this order:
  - Members with a test of their own go first, in written order: a type, a literal, a discriminant,
    a key only they have.
  - The members checked by a guard follow. A member whose guard would take another member's value
    and write it without part of it (a key it does not declare, at any depth) goes after that member.
    Where two would each do that to the other, the written order stands, with objects whose fields
    are all optional last, and the build warns.
  - A blob that takes anything goes last.

  The tag is still the member's written position. When the last member tried is an object or a
  collection without a test of its own, it is only checked to be a table. So a charm-sync patch no
  longer walks its guard: a small patch serializes in about 5.5 µs instead of 10.
- Serialization: a branded number member of a union (`Serialization.u16` and the other widths, and
  `varint`) only takes a number that fits its width: in range and whole for an integer width, in
  range for `f32`. Any other number goes to the next member.
- Serialization: in a union with `number`, a whole number from 0 to 2^35 - 1 is a varint under a tag
  of its own, after the members. So 3 in `string | number` takes 2 bytes instead of 9, and so do
  array indices sent as map keys. Other numbers, and a `number` outside a union, stay f64.
- Serialization: a type with no name of its own that a file's values reach more than once now gets
  size, write and read functions, as a named type does, instead of being written out at every place.
  This covers objects, unions, tuples, arrays, sets and maps: a mapped or conditional type's instance,
  an object literal type, `string[]`, `Map<string, number>`. The bytes sent are the same. A
  charm-sync payload modelled on Dive In's went from 5,277 lines (166 KB) to 3,367 lines (108 KB).
- Serialization: the size, write and read functions of every hoisted type in a file are fields of one
  table, `codec`, instead of three locals each.
- `Could not find Rojo data for '...'` adds what the path compiles to and that no `$path` in the Rojo
  project covers it, or that no Rojo project file was found.

#### Fixed

- Serialization: `Partial<Crate> | None` wrote every removal as an empty patch, so the receiver kept
  what was removed. The patch, whose fields are all optional, was written ahead of charm-sync's
  removal marker. A union member written ahead of another whose values its guard accepts lost data
  the same way:
  - a list or a map taken by a patch;
  - a map's value taken by an object;
  - `{ pos: { x, y, z } }` taken by `{ pos: { x, y } }` or by a map of `{ x }`;
  - `{ a, b }` taken by `{ a }`.
- Serialization: `u16 | number` wrote 70000 as a u16, which arrived as 4464.
- Serialization: a file with more than about 66 hoisted types compiled but did not load, because it
  went past Luau's limit of 200 locals.
- Serialization: a recursive type with no name of its own, such as a conditional patch type over a
  recursive interface, overflowed the stack at build time.

### core, components, networking, transformer, transformer-plugin

#### Changed

- The README each package ships points its links to files the package does not ship at GitHub, so
  they work from `node_modules` and on npm; core's link to its own `docs/README.md` stays relative.

### core, components, networking, testing, transformer, transformer-plugin

#### Changed

- Each package.json links this repository, with the package's folder, plus its homepage and issues, so
  npm shows them on the package page. core and transformer pointed at the original v1 repositories.

### Docs

- Guide 06:
  - how the union member a value is sent as is chosen, and when the build warns;
  - branded number members;
  - whole numbers in a union with `number`;
  - which wrong values raise at the sender and which do not: numeric strings, booleans, undeclared
    keys, a table sent as a union's last member, an array with holes, and NaN in a guarded number
    field;
  - in place of "Remote wiring is deferred by one frame", what a late listener misses:
    - a reliable event only past the engine's queue limit;
    - an unreliable one sent before the first `connect`;
    - under `Immediate` signals, one arriving right behind the event whose handler makes that first
      `connect`.

### Tests

- The Studio place pins what a late listener misses, in both directions and under every project:
  reliable events wait for the first connection, unreliable ones are dropped, and one more is missed
  because Flamework starts listening a moment late under `Immediate` signals.

## 2026-09-27: core, components, networking and testing 2.0.0-alpha.3; transformer 2.0.0-alpha.4; transformer-plugin 2.0.0-alpha.2

### Upgrade notes

- **Path registration takes every class a module defines, exported or not, as v1 did.** A `@Provider()`
  or `@Component()` class declared at the top level of a module under a registered folder is now
  registered even if the module does not export it. Move a decorated class that must stay out of the
  module to a folder no module registers, or into the function that uses it. `core` and `transformer`
  have to come from this release together: with an older one of either, only exported classes are found.
- **`Dependency<T>()`, `module.resolveDependency<T>()` and a provider's constructor refuse a component
  at compile time.** v1 built any decorated class on demand; v2 resolves registered providers only.
  Make such a class a `@Provider()` (`{ lazy: true }` keeps v1's "built when first asked for"), or get
  the component from `Components`.
- **A path or glob registration whose own scope condition does not hold no longer loads its
  folder.** `registerProviders(path, { activeIn })`, the glob forms, a plugin target's forms and
  `ComponentPlugin.fromPath`/`fromGlob`/`registerComponents*` return before looking the folder up,
  so the top-level code of the ModuleScripts under it no longer runs in a build where the condition
  fails. A condition on the class or the module still lets the folder load, and so does one on
  `includePlugin` around `ComponentPlugin.fromPath`/`fromGlob`/`registerComponents*`: put it on the
  registration itself.
- **Transformer options go in `flamework.config.json` only.** The tsconfig entry takes `transform`
  and `configFile`, plus the plugin loader's own keys such as `import`; any other key fails the
  build, naming the key and saying to move it to the file or to remove it. Before, an option on the
  entry won over the file, so a game with `obfuscation: true` in the file and `false` on the entry
  (as a v1 entry often had) built unobfuscated. Move every transformer option on the entry
  (`obfuscation`, `hashPrefix`, `idGenerationMode`, `salt`, `noSemanticDiagnostics`,
  `optimizations`, `plugins`) to the `transformer` section, and remove v1's `preloadIds`.
- **A game's build writes to its `flamework.config.json` once.** It adds a `$schema` line when the
  file has none, and creates the file with only that line when `tsconfig.json` is at the package
  root and there is no file. Commit the change; after that the build leaves the file alone.

### core

#### Added

- `@Provider({ loadOrder })`, v1's ordering of `onInit` and `onStart` within one ignition: lower first,
  default 1, registration order among equals. A provider's dependencies are still constructed and
  initialised before it, whatever their `loadOrder`; `onStart` follows `loadOrder` alone, each on its
  own thread up to its first yield before the next. Lazy providers ignore it, per-frame events stay
  unordered, and an imported module still ignites first. A value that is not a finite number raises
  when the class's module loads.
- Path registration (`registerProviders`, `registerProvidersGlob`, the plugin target's forms,
  `getClassesInPath`, `getClassesInGlob`) finds the classes a module defines at its top level whether
  or not it exports them, each once. Classes are tied to the ModuleScript that defines them, so this
  holds in every `idGenerationMode` and with obfuscation on. A class declared inside a function is
  found only through its module's exports.
- A failed resolution of a class that has loaded says what the class is, where it is defined and what
  to do: a component (get it from `Components`, or make it a `@Provider()`), a `@Provider()` that
  nothing in the module registers or provides, or a class that is not a provider.
- `explainLeftOut`, `leftOutRegistration` and the `LeftOutRegistration` type, beside the other
  path-registration utilities: what a plugin that registers folders under a scope condition uses to
  say why a class under a left-out folder cannot be found.

#### Changed

- `getClassesInPath` also returns the classes a module does not export: each module's classes in
  definition order, then what it exports. `requireModulesInPath` is unchanged.
- Eager providers are constructed in ascending `loadOrder`; with none set, the order is unchanged.
- A path or glob registration whose own scope condition does not hold no longer touches its folder.
  `registerProviders`, `registerProvidersGlob` and a plugin target's forms of both return before
  looking the folder up (no `WaitForChild`) or requiring anything under it. The active scopes are the
  compiled `scopes.active`, so this leaves out exactly what ignition would have left out. A build can
  now drop such a folder from the place: a release build without its `Tests` folders, registered
  under `activeIn: ["testing"]` as the testing guide sets them up, no longer waits for them forever.
  The registration is recorded, and a lookup that misses a class under it names it:
  `'X' (...) is under registerProviders("..."), which is left out by its scope (...)`. When the class
  has not loaded, the message lists the module's left-out registrations.
- `getGlobPaths`'s error names its real causes: the include folder not in the Rojo project, a glob
  used inside a package, a string that did not come from a glob macro, or `globs.json` from another
  build. A glob that matched no files never raised it; it resolves to no paths.

#### Fixed

- `getClassesInPath` over a package folder returned a class twice when the package also re-exported
  it (`Components` from the components package).
- `out/index.d.ts` re-exported the stripped `@internal` hooks `__setActiveScopes` and
  `__setPathRoot`, so a plain `tsc` without `skipLibCheck` failed inside the package (TS2724). The
  re-exports are stripped as well; the Luau still exports them.

### transformer

#### Added

- Records each class with a Flamework identifier that is declared at the top level of its file, or of
  a namespace in it, against its module (`flamework:module`), for path registration.
- A compile error for `Dependency<T>()`, `module.resolveDependency<T>()` and a `@Provider()`
  constructor parameter whose type is a `@Component()` class that is not a provider.
- A build warning at every use of a glob that matches no files (`registerProvidersGlob`,
  `ComponentPlugin.fromGlob`, `registerComponentsGlob`, a plugin target's glob form, or a
  `Modding.Intrinsic<"pathglob">` macro), naming the glob and its file, line and column. The build
  still passes and the glob still resolves to no paths. A watcher checks again on every rebuild.
- A game's build gives its `flamework.config.json` a `$schema` line when it has none, so an editor
  lists every option with its description and default. The path is relative to the file and goes
  through the project's `node_modules/@flamework-experimental/transformer`. The line is added as the
  first key and every other byte is kept (indentation, line endings, comments). A game without the
  file gets one holding just the line, but only when its tsconfig is at the package root: below it, a
  created file would hide a shared one added there later. It happens when `rbxtsc` starts, not on a
  watcher's rebuilds; it never replaces an existing `$schema` and never runs for a package. A file
  that cannot be written gets a warning.
- Every option in `flamework.config.schema.json` states its default, and fixed defaults carry
  `default` (`plugins` and `optimizations` gained one).

#### Changed

- The tsconfig entry is checked, and the options come from `flamework.config.json` alone (no longer
  merged). Besides `configFile`, only the plugin loader's keys are allowed: roblox-ts's `transform`,
  `import`, `type`, `after`, `afterDeclarations`, and ts-patch's `name`, `transformProgram`,
  `isEsm`, `tsConfig`, `resolvePathAliases`. A transformer option on the entry fails with
  `Move '<key>' to the "transformer" section of <file>`; any other key with
  `Remove '<key>': not a transformer option`; a `configFile` that is not a string fails too.

#### Fixed

- `flamework.config.json` rejected `components.watchRenames`, which guide 09 documents and the
  components package reads; the schema now accepts a boolean.
- A macro call written directly as an argument of another macro call (for example
  `Dependency<T>(undefined, Flamework.id<T>())`) was emitted untransformed, as a call to a function
  that does not exist at runtime ("attempt to call a nil value"). Macro arguments are now transformed
  like any call's, at any depth.
- The schema's and `TransformerConfig`'s `idGenerationMode` default said `"full"`, which is wrong with
  obfuscation on (`"obfuscated"`); `components.attributeWarningTimeout`'s said 5, where it follows
  `warningTimeout`; `hashPrefix` said it defaults to the package name, where a game gets no prefix
  (it also says now that a prefix cannot start with `$`).

### components

#### Fixed

- Several `ComponentPlugin`s in one module -- a `fromPath` per folder as guide 09 shows, a `fromGlob`, a
  built one, in any mix -- raised `provider ID was registered more than once: $c:components@Components`
  at ignition. They now share one `Components` per module: every registration ends up in it, a
  component can link to one registered by another plugin, and `Dependency<Components>()` and
  constructor injection get that one. A module that imports another keeps its own `Components` when it
  includes a component plugin, and resolves the import's when it does not.
- `ancestorBlacklist`'s doc comment named two default services. The default is ServerStorage,
  ReplicatedStorage, StarterPack, StarterGui and StarterPlayer.

#### Changed

- `fromPath`, `fromGlob`, `registerComponents` and `registerComponentsGlob` register components their
  modules do not export (see core).
- A link to an unregistered component now raises `… not registered in any ComponentPlugin of this module`.
- `ComponentPlugin.fromPath`, `fromGlob`, `registerComponents` and `registerComponentsGlob` whose own
  scope condition does not hold no longer look their folder up, as in core. `getComponent` on a component
  under such a folder says `component '...' could not be found: ... is under
  ComponentPlugin.fromPath("..."), which is left out by its scope (...)`. A condition given to
  `includePlugin` does not stop `fromPath` from looking its folder up, because `fromPath` looks it
  up when it is called; put the condition on `fromPath` itself.

### testing

#### Fixed

- `out/index.d.ts` re-exported the stripped `@internal` hooks `__resetTests` and `__isAttached`, so a
  plain `tsc` without `skipLibCheck` failed inside the package (TS2305). The re-exports are stripped
  as well; the Luau still exports them.

### core, components, networking, testing

#### Changed

- Built with their id prefixes (`$`, `$c`, `$n`, `$T`) in a `flamework.config.json` instead of on the
  tsconfig entry, which also drops the dead v1 key `$rbxpackmode$`. The published `out` and
  `flamework.build` are byte-identical, ids included.

### components, networking, testing

#### Fixed

- The peer dependency on `@flamework-experimental/core` (and testing's on
  `@flamework-experimental/transformer`) was `*`, which matches no prerelease, so every install of an
  alpha warned about an incorrect peer dependency. It is `^2.0.0-alpha.0` now.

### Docs

- Getting started: the Rojo section maps each runtime package under `@flamework-experimental` by
  name and says why not the whole folder -- the transformer is installed there too, and its folders
  and three JSON schemas would be copied into ReplicatedStorage -- with the `globIgnorePaths` line
  that leaves it out instead; the components, networking and testing pages point to it from their
  install steps.
- Migrating from v1: a first step for the packages, `tsconfig.json`, `flamework.json` →
  `flamework.config.json`, the Rojo mapping and clearing v1's `out/`; `Flamework.resolveDependency(id)`'s
  replacement, and rows for the other v1 `Modding` functions (`createDependency`,
  `createDeferredDependency`, `resolveSingleton`, `addListener`); that components now attach after
  every provider's `onStart` and that an attribute its guard rejects removes the component;
  subscribing to implementers after ignition (a plugin for providers, `Components` for components);
  the macro type renames (`Generic` → `Target.*`, `Many` → `Emit`, `Caller<M>` → `Caller.*`, ...)
  and what else changed with them (the `path` intrinsic's value, `Caller.Uuid`), which the guide had
  listed as unchanged; and the networking changes (`processNext`, `Networking.Connection`, handlers
  no longer tied to the connecting script), which it had called unchanged. Step 12 no longer names
  `Flamework.registerExternalClass` and `Flamework.createDependency`, which v1 1.3.2 does not have.
- Macros: writing a path or glob macro of your own with `Modding.Intrinsic<"path">` /
  `Modding.Intrinsic<"pathglob">`; `Caller.Uuid` changes with every clean build under obfuscation.
- Every guide page, the README and the testing package's README are reworded in plainer language:
  shorter sentences, terms defined where they first appear, steps and rules as lists. Code examples
  are unchanged. Facts corrected along the way: interfaces match through a class's `implements`
  clause (a parent's only if it is decorated too), not by shape; remote folder names and
  `Caller.Uuid` change with every plain build under obfuscation, not with a watcher's rebuild or an
  incremental build; only the runtime sections of `flamework.config.json` reach the place (`cloud`
  never does); `Flamework.env` reads the environment when `rbxtsc` starts; a child's `Name` is
  followed only with `watchRenames`; migrating step 6 no longer suggests an optional child typed as a
  component, which the transformer rejects; `build()` and `ignite()` do not return the builder; a
  table in the components guide that rendered in two pieces is whole.
- Testing: the shipping advice is reversed. A `Tests` folder is registered by its own path with the
  scope condition on the registration, which a release build without the folder now skips (see core).
- Project structure: the tsconfig entry takes only `transform` and `configFile`; the `$schema` line
  and when the build adds or creates it; the `hashPrefix` and `idGenerationMode` defaults; the example
  config's `"hashPrefix": "$g"`, which failed a game build, is now `"g"`; under obfuscation, ids
  declared in a package (`OnStart`, `OnInit`, `Components`, ...) keep their names, and why that only
  reveals which Flamework events and package types a class uses. Getting started, Migrating from v1,
  Transformer plugins and Internals follow.

### Tests

- The Studio test place lives in the repository (`tests/place`), linked to the packages' own builds:
  `bun run test:place` builds the packages and runs its suite in Studio under the default,
  immediate, deferred and streaming projects.
- The Lune harness's module tree answers `IsA`, `GetChildren`, `GetDescendants`, `FindFirstChild`,
  `WaitForChild` and `GetFullName`, so specs can register a folder by path.
- The place's providers that cases register in modules of their own moved out of the registered
  `Tests` folders into `src/server/Fixtures`.
- `tests/packaging/typings.test.ts` type-checks every published declaration file without
  `skipLibCheck` and checks that none exports a `__` name. New scope specs and place cases cover
  left-out folder registrations, and new transformer tests cover the empty-glob warning and nested
  macro calls.
- Transformer tests for the tsconfig entry check (each option, unknown keys, loader keys,
  `configFile`, a real rbxtsc build) and for the `$schema` line (layouts, CRLF, BOM, comments,
  creation at the package root and none below it, packages, watcher rebuilds, unwritable files), a
  test that every schema option states a default, and packaging tests that pin each package's id
  prefix and the ids games compare against. The fixture's probe files are removed before a run.

## 2026-09-26: core, components, networking and testing 2.0.0-alpha.2; transformer 2.0.0-alpha.3

### Upgrade notes

- **Release `core`, `components` and `testing` together.** `core` now starts providers from a new
  `onIgnited` plugin hook, and `components` and `testing` rely on it. A new `core` with an older
  `components` or `testing` (or the reverse) misbehaves.
- **Rebuild networking code with the matching transformer.** The transformer emits a new
  `_setCallback(callback, pack)` shape for receiving functions.
- **Deploy server and client from the same build.** Function remote ids changed for one-way
  functions (see networking below).
- **Networking middleware: `processNext` returns the next link's result, not a Promise.** A
  middleware that only returns `processNext(...)`, or `await`s it, needs no change. One that chains
  on it, `processNext(...).andThen(f)` (or `.then(f)`), becomes `f(processNext(...))`. An error
  further down is raised through `processNext` rather than rejecting a Promise, so a `.catch` or
  `.finally` becomes a `try`/`catch` or `try`/`finally` around the call. For an event `processNext`
  returns nothing; for a function it returns the value or `Networking.Skip`.
- **Networking handlers are no longer tied to the script that connected them.** `connect` and
  `registerHandler` no longer go through a BindableEvent, so the engine does not disconnect a handler
  along with the script that connected it. A roblox-ts project does not destroy its scripts, so
  nothing changes for a normal project. (Corrected after release: this note first said a destroyed
  script's handlers pile up.)
- **Networking connections have their own type, `Networking.Connection`.** Code that stores what
  `connect` or `registerHandler` returns as `RBXScriptConnection` still compiles, because the shape
  matches, but it should name `Networking.Connection`, which also offers `Destroy()`. A runtime check
  such as `typeIs(connection, "RBXScriptConnection")` is false for these connections; `typeOf` gives
  `"table"`.

### core

#### Added

- `PluginTarget.onIgnited(callback, options?)`: runs once the module is fully ignited, after every
  `onPostIgnite` hook and after its imports know about it. Providers' `onStart` now runs here.
- A warning when a provider has waited 5 seconds for an `onInit` that may be waiting on that very
  ignition (an `onInit` that, after it has yielded, ignites a module taking what it initialises),
  naming both providers.

#### Changed

- `onStart` runs only once the module is ignited. Inside it `isIgnited()` is true, `extinguish()`
  works, and modules that import this one can be ignited.
- Providers stop getting `onTick`/`onPhysics`/`onRender` from the moment `extinguish()` is called.
- `extinguish()` on an import waits for an importer that is still extinguishing on another thread,
  so importers finish before the import is released. A wait that would close a cycle, or wait on a
  thread that was cancelled, returns at once instead of deadlocking.
- Lazy providers resolved after ignition get `onInit` and `onStart` only once the module is ignited
  and never after extinguish has begun. Several resolved together (one, and the lazy providers its
  constructor takes) run `onInit` in dependency order, and one resolved from inside one of their
  `onInit`s, sync or `async`, joins them. One resolved anywhere else meanwhile gets its own turn:
  its `onInit` waits only for the pending `onInit`s of the providers its constructor takes, and for
  nothing else. A lazy provider whose `onInit` raises never ticks or starts.
- An import that is extinguished while an importer is still igniting now fails that importer's
  ignition (`imported module '…' was extinguished while this module was igniting`).
- Per-frame events (`onTick`/`onPhysics`/`onRender`) walk their listener sets in place and call each
  listener without creating a closure. At 1,000 listeners a frame takes about 30% less time in Studio
  (about 780 → 530 µs, profiling off) and allocates nothing (about 80 KB per frame before, about
  140 KB with profiling on). Delivery rules are unchanged: a listener attached during a frame starts
  on the next, and one detached before its turn is not called.
- What a class implements is computed once per class and cached; this is used on every attach and
  detach and by `Flamework.implements`. Attaching an object no longer records an undo list. Attach
  plus detach allocates about 60% less, and `Flamework.implements` on an instance allocates nothing.

#### Fixed

- A listener attached during a frame made other listeners tick twice or not at all.
- A lazy provider ticked before its `onInit` had finished.
- With profiling on, a provider's memory category leaked onto the thread that called `ignite()`.
- A lazy provider refused by an observer stayed cached and was handed out with no lifecycle events.
- An importer stayed ignited forever when its import was extinguished during its ignition.
- An import was released while an importer's yielding `onExtinguished` was still using it.
- Deadlocks between concurrent extinguishes along an import chain, with a cancelled extinguish
  thread, and when an `onInit` (sync or `async`) extinguished an import during an ignition started
  from `onExtinguished`.
- A lazy provider first resolved during extinguish was released without `onExtinguished`, and could
  get `onInit`/`onStart` after it; an object refused during extinguish was told `onExtinguished`.
- `release` skipped or doubled providers resolved while it ran.
- An object provided under two ids got every event twice.
- A failed ignition sent `onRemoved` for provided instances that never joined.
- Cancelled threads left entries behind in the module-level wait map.
- An eager provider whose constructor takes an import's lazy provider that is not initialised yet
  (resolved for the first time by that constructor, or still loading) ran `onInit` and `onStart`
  before that provider's `onInit` had finished, including when its module was ignited from Promise
  work (an `andThen` callback or an `async` function). Its `onInit` now waits for it, and ignition
  waits with it; if the import begins to extinguish meanwhile, the ignition fails without running
  that `onInit` (`'…' takes a provider of a module that was extinguished while this module was
  igniting`).
- A provider without an `onInit` (eager or lazy) got `onStart` and per-frame events before the
  pending `onInit` of a provider its constructor takes had finished; they now wait for it, as an
  `onInit` does.
- A per-frame callback that kept its thread (`coroutine.running()`) and cancelled it after returning
  broke `onTick`/`onPhysics`/`onRender` for every module for good (`cannot spawn non-suspended
  coroutine with arguments`). The recycled thread is now reused only while it is parked.

### components

#### Changed

- `onComponentRemoved` runs before `destroy` under Immediate signal behaviour and after it under
  Deferred. The docs said "before" in both; the behaviour is unchanged.
- Removing a dependency by hand, tagged or not, takes its dependents down until the next one is
  built.
- When Flamework removes a component on its own (tree, link, attribute or dependency lost) and its
  `destroy` raises, the error is a warning (`[Flamework] Failed to remove '…' from …`). A hand
  `removeComponent` still raises.
- `getComponent` builds nothing and returns `undefined` once the module has begun to extinguish.
- Under Immediate, `getComponent` for a component still being constructed (e.g. from a handler
  fired by its default-attribute write) returns `undefined`.
- With `watchRenames` on, children ahead of a resolved required child are followed too (one `Name`
  connection each), because a rename there changes which child the name resolves to.
- `getComponents` no longer keeps a lookup per instance: it reads the instance's own components
  against each class's ids, worked out once at registration. Results are the same, in no particular
  order, as before.
- Adding a component allocates and keeps less: attribute guards, the instance check, inherited
  config and whether a class implements `OnInit`/`OnStart` are read once per class; tracker entries
  make their sets on first use; a class with no links of a kind shares one frozen empty
  `childComponents`/`attributeComponents`; `onStart` runs on a recycled thread and its failure
  message is only built on a raise; constructor dependencies resolve through one shared resolver;
  attributes keep no per-component copy of old values. For an instance with two components:
  6.4 → 4.0 KB kept, 14.6 → 8.1 KB allocated per add, adds about 25–35% faster.

#### Fixed

- A subclass that re-declares its parent's interface was announced twice to `onComponentAdded` /
  `onComponentRemoved`.
- A component that removed itself in `onStart` leaked its maid, was announced as added after its
  removal and was handed to waiters already destroyed; a later waiter could get a component an
  earlier waiter had removed.
- Child links: a child renamed and then removed was missed; with `watchRenames` on, a sibling
  renamed into a taken name was never heard; a replaced child never rebuilt its owner under the
  server's default mode or `Disabled`; a long chain taken down under Deferred left its tail attached.
- Optional attribute links with an Instance default reported themselves met and then raised in
  construction, and their watcher went stale when the owner was taken down.
- Dependencies Flamework will never build (predicate, no tag) counted as met and made construction
  raise; a dependency removed by hand left its dependent holding it; a dependency whose setup raised
  was never released; a dependent's raising `destroy` kept its dependency attached; re-adding a
  component from `onComponentRemoved` left its dependents down.
- A handler fired by a default-attribute write could build a second copy of the component.
- Removing a component's tag during its `onInit` left it attached for good.
- Hand-written `t` instance guards were re-checked only in one direction; their queued poll could
  run after extinguish and raise.
- `getComponent` raised after the module had extinguished.
- Under Immediate, re-adding a tag from `onComponentRemoved` during that tag's own removal left the
  instance tagged with no component; dependents now see a dependency as missing while its removal
  runs, and are rebuilt around the new one when it ends.
- A hand `removeComponent` of a dependency whose own `destroy` raises left its dependent holding it.
- Removing components was quadratic in the number attached (each removal counted every id's global
  set): at 5,000 instances a removal cost about 300 µs, now about 10–20 µs.
- Under Immediate signal behaviour, an `onAttributeChanged` handler that wrote the same attribute
  was told a stale old value for that change and the next.

### networking

#### Changed

- Every function remote id carries its direction prefix (`$` / `@`), one-way functions included.
- `Cancelled` also answers a request whose callback or middleware promise was cancelled.
- Invoking a player who has left rejects with `Cancelled` at once, with any timeout.
- A timeout of `math.huge` never fires.
- **Breaking:** middleware `processNext` returns the next link's result instead of a Promise (see
  the upgrade notes). A middleware may still yield or return a Promise; it is waited for in the
  thread handling the message. For a function, a cancelled one reads as `Networking.Skip`.
- Receiving no longer uses Promises: decoding, guards, middleware and the handler or callback run as
  plain calls in the thread that received the message. An event with no middleware costs about 3 µs
  and 80 bytes instead of about 20 µs and 18 KB; a function request costs the server about 6 µs and
  0.4 KB instead of about 50 µs and 46 KB.
- A function call makes a single Promise, the one `invoke`/`invokeWithTimeout` returns. Its timeout
  is a `task.delay`, cancelled when the answer arrives.
- Event handlers run on networking's own signal instead of `@rbxts/signal`:
  - each handler runs at once on a thread of its own, newest connection first, rather than through
    a BindableEvent (which the engine defers under `SignalBehavior.Deferred`);
  - an event's `predict` has called its handlers by the time it returns, unless a middleware yields;
  - `@rbxts/signal` is no longer a dependency of `networking`.
- `connect` and `registerHandler` return `Networking.Connection` (`Connected`, `Disconnect()`,
  `Destroy()`), networking's own connection, not an engine `RBXScriptConnection`.

#### Fixed

- Event arguments are delivered by reference, so decoded Maps and Sets with non-string keys (players,
  numbers, Vector3s, enums, booleans) reach `connect` intact.
- Argument lists with `undefined` gaps and a trailing `undefined` lost values after the gap, including
  through middleware that names its parameters.
- Under serialization, middleware that returned a plain value broke the call.
- Functions declared to return `Promise<T>` always failed their result guard.
- `predict` before any `connect` threw.
- Invoking a player who had already left kept that Player in memory for good.
- Two concurrent `createClient` calls built two handlers on the same remotes; a cancelled
  `createClient` blocked every later one.
- A one-way function named `$name` shared a remote with a two-way `name`, so both callbacks ran and
  callers got each other's answers.
- A predicted function whose callback Promise was cancelled never settled.

### testing

#### Fixed

- `flamework-test` no longer reports a Studio window closed while it is still open, or closes a
  window it did not open. `test` closes the window it opened by the process it started, not by a
  title suffix, which could also match another directory's same-named file and end that window
  instead. It checks the process is gone after the polite and the forced close, and fails with the
  window's PID and title when it is not. It drives only the window it launched: a same-named window
  already listed by the MCP proxy is ignored, and runs of same-named files take turns to open
  theirs. A run that cannot tell its window from another of the same name that is still opening
  refuses and closes its own. A window the run gave up on (e.g. one that never connected) is closed
  unless `--keep`. The earlier-build close only matches a window whose title shows that very file,
  compared ordinally ignoring case, so "Straße" is not "Strasse". Paths and titles reach PowerShell
  as data, so any character in them, including ‘ ’, is taken literally. `studio close` closes
  nothing when several windows share the title.

### transformer

#### Changed

- Receiving networking functions compile to `_setCallback(callback, pack)`; the result is packed after
  the middleware chain. `incomingResults` is gone from the generated metadata.
- The result guard of a function returning `Promise<T>` checks `T`.

### Tests

- The Lune runtime harness now behaves as Roblox Studio does for everything the specs rely on,
  measured in Studio under Immediate and Deferred: signal and tag order, handler errors (printed and
  collected through `__harness.errors()` / `clearErrors()`, and a case fails on an uncleared one),
  deferral and re-entrancy limits, frame order, Bindable argument copying, attribute validation and
  `task` timing.

### Known issues

- core: dependency waiting is not transitive. A provider waits for the pending `onInit` of the
  providers its constructor takes directly; a provider in between with no pending `onInit` of its
  own (e.g. a lazy service without `onInit` that takes a lazy store still loading) is not followed.
  Give that service an `onInit` (an empty one is enough) or take the store directly.
- core: an `onInit` that, after it has yielded, ignites a module taking the provider it initialises
  makes that ignition wait for itself until the import is extinguished (the warning above names
  it). Ignite such modules from `onStart` or a `PlayerAdded` handler.
- core: the `async` `onInit` deadlock fix lets an unrelated thread's `extinguish()` of an import skip
  waiting for an importer that is waiting on a pending `onInit` Promise.
- core: while a lazy provider's `onInit` Promise is pending, a lazy provider resolved on any thread
  running Promise work joins its batch, an unrelated Promise's too; one resolved by a thread the
  `onInit`'s executor spawned, after that thread yielded, gets its own turn.
- core, components, networking: per-frame callbacks, component `onStart`s and networking handlers
  run on recycled threads. Code that keeps the thread it ran on (`coroutine.running()`) and cancels
  or resumes it later can cut short or wake another callback that is reusing that thread.
- networking: a sender created inside the leaving player's own `PlayerRemoving` handler never settles
  an infinite-timeout invoke of that player under Default or Immediate signal behaviour.
- docs: the harness sections of `docs/reference/internals.md` still describe the old harness.
