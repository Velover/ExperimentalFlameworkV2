# Flamework v2: plugins, and packages other games install

For anything not covered here, read
`node_modules/@flamework-experimental/core/docs/guide/08-plugins.md`, and
`09-project-structure.md` and `07-macros.md` ("Paths") next to it for what differs in a package.

## Shape

```ts
import { Flamework, HookPriority, PluginDefinition } from "@flamework-experimental/core";

export interface ScoreOptions {
	startingScore?: number;
}

export function createScorePlugin(options: ScoreOptions = {}): PluginDefinition {
	return Flamework.createPlugin("Score", (target) => {
		const board = new ScoreBoard(options.startingScore ?? 0);
		const connections = new Array<RBXScriptConnection>();

		target.provideInstance(board);
		target.observe<OnScoreChanged>({
			onAdded: (listener) => board.listen(listener),
			onRemoved: (listener) => board.unlisten(listener),
		});
		target.onIgnited(() => connections.push(board.start()), { priority: HookPriority.Last });
		target.onExtinguished(() => {
			for (const connection of connections) connection.Disconnect();
		});
	});
}

export const ScorePlugin = createScorePlugin();
```

- A plugin is a factory that takes options, plus the plugin with the defaults. A game includes it
  in each realm's module: `.includePlugin(ScorePlugin)`.
- The setup function runs once per ignition of every module that includes the plugin. Keep its
  state inside it: state at the top of the file is shared by every module.
- What `target` offers:
  - `provideInstance(value)`: hands the module an object that providers inject by its type;
  - `registerClassProvider(Class)`: registers a provider, as the module builder would;
  - `observe<T>({ onAdded, onRemoved })`: every object that implements `T` as the module creates
    it, providers and `createClassInstance` alike. Only a class with a Flamework decorator that
    names `T` in its `implements` clause is matched;
  - `onPreIgnite`, `onPostIgnite`, `onIgnited` and `onExtinguished`, ordered within a phase by
    `{ priority }` (`HookPriority.First`, `Normal`, `Last`). The lifecycle plugin calls `onStart`
    in `onIgnited`; `Last` runs after it.
  - `includePlugin(other)`: a plugin it depends on, set up first and only once per ignition.
- Nothing can be resolved during setup or `onPreIgnite`. Keep `target.module` for later hooks.
- Disconnect everything the plugin connected in `onExtinguished`. Nothing does it for you.
- Call listeners with `task.spawn`, over a copy of the set, so that one that yields or errors holds
  up no other, and one that creates an observed object does not change the set being walked.

## A plugin published as a package

- **A scoped name** (`@scope/name`): roblox-ts and Flamework treat only a scoped name as a package.
  Its ids start with that name, and a game's build reads them from the package's
  `flamework.build`, so the package publishes it: `"files": ["out", "flamework.build"]`.
- **No path macros.** `registerProviders("src/...")`, `requireModules` and the glob macros resolve
  in the project that compiles them, so in a game they point at nothing. Register the package's own
  providers with `target.registerClassProvider(SomeClass)`.
- **No `idGenerationMode` or `obfuscation`** in the package's `flamework.config.json`: its ids must
  be the same in every game.
- **Core as a peer dependency,** pinned to the release the package is built against, and as a dev
  dependency at the same version. The same for any other Flamework package it uses.
- `"declaration": true` in its tsconfig, and `"stripInternal": true` keeps members marked
  `@internal` out of the published typings.
- A game that installs it adds `node_modules/@scope` to `typeRoots` and maps it in its Rojo project
  next to `@flamework-experimental`.

## Developing one in a bun workspace

A package beside a game that installs it, as the Flamework plugin template has it:

- Keep bun's default linker (isolated). `linker = "hoisted"` breaks roblox-ts, which refuses an
  import from outside the project's own `node_modules`
  (`You cannot use modules directly under node_modules`).
- Keep the transformer and roblox-ts out of the package's `package.json`: the root has them, and the
  package's tsconfig finds them there. roblox-ts walks the package's
  `node_modules/@flamework-experimental` through its symlinks, and a transformer linked there makes
  `rbxtsc` hang for minutes.
- Pin the imports that two projects share with tsconfig `paths`: in the package, each import it
  shares with its dependencies, through its own `node_modules`; in the game, each import the
  package's typings make, through the game's. roblox-ts writes an import through the first link to
  a package that TypeScript met, which could otherwise be another project's.
- Build the package (`rbxtsc -p package`) before the game, which compiles against its typings and
  reads its ids from its `flamework.build`.
