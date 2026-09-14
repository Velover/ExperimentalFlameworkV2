import {
	Dependency,
	Flamework,
	HookPriority,
	OnExtinguished,
	OnStart,
	OnTick,
	Provider,
	type Module,
} from "@flamework-experimental/core";
import { expectArrayEqual, expectEqual, expectFalse, expectNoThrow, expectThrows, expectTrue, suite } from "../testkit";

declare const __harness: {
	/** Runs what was deferred to the next resume point. */
	flush: () => void;
	/** Fires the RunService signals the per-frame lifecycle events hang off. */
	step: (delta: number) => void;
	warnings: () => string[];
	clearWarnings: () => void;
};

@Provider()
class Widget {}

@Provider()
class Consumer {
	constructor(public readonly widget: Widget) {}
}

@Provider({ lazy: true })
class LazyGadget implements OnStart {
	public static starts = 0;

	public onStart() {
		LazyGadget.starts += 1;
	}
}

@Provider()
class Genuine {
	public readonly kind = "genuine";
}

/** Registered under `Genuine`'s id, as a stand-in. */
@Provider()
class Stub {
	public readonly kind = "stub";
}

@Provider()
class Counted {
	public static constructed = 0;

	constructor() {
		Counted.constructed += 1;
	}
}

/** Ticks and counts its extinguish, to show what a module still holds after it went wrong. */
@Provider()
class Ticking implements OnTick, OnExtinguished {
	public static frames = 0;
	public static extinguished = 0;

	public onTick() {
		Ticking.frames += 1;
	}

	public onExtinguished() {
		Ticking.extinguished += 1;
	}
}

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

/** A plugin that logs the module's name when it extinguishes, to record teardown order. */
function tracked(name: string, log: string[]) {
	return Flamework.createPlugin(name, (target) => target.onExtinguished(() => log.push(name)));
}

export = suite("modules", [
	[
		"resolves an import's provider, and injects it into an own provider",
		() => {
			const world = Flamework.createModule().registerClassProvider(Widget).ignite();
			const test = Flamework.createModule()
				.registerClassProvider(Consumer)
				.ignite({ imports: [world] });

			const widget = world.resolveDependency<Widget>();
			expectTrue(test.resolveDependency<Widget>() === widget, "resolved through the import");
			expectTrue(test.resolveDependency<Consumer>().widget === widget, "injected from the import");

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"follows imports transitively, and in order",
		() => {
			const deep = Flamework.createModule().registerClassProvider(Widget).ignite();
			const middle = Flamework.createModule().ignite({ imports: [deep] });
			const top = Flamework.createModule().ignite({ imports: [middle] });
			expectTrue(top.resolveDependency<Widget>() === deep.resolveDependency<Widget>(), "through two imports");

			const genuine = Flamework.createModule().registerClassProvider(Genuine).ignite();
			const stubbed = Flamework.createModule().registerProvider<Genuine>({ type: "class", value: Stub }).ignite();
			const stubFirst = Flamework.createModule().ignite({ imports: [stubbed, genuine] });
			const genuineFirst = Flamework.createModule().ignite({ imports: [genuine, stubbed] });
			expectEqual(stubFirst.resolveDependency<Genuine>().kind, "stub" as never, "the first import answers");
			expectEqual(genuineFirst.resolveDependency<Genuine>().kind, "genuine", "and the other way round");

			genuineFirst.extinguish();
			stubFirst.extinguish();
			stubbed.extinguish();
			genuine.extinguish();
			top.extinguish();
			middle.extinguish();
			deep.extinguish();
		},
	],
	[
		"refuses to ignite with an import that is not ignited",
		() => {
			const gone = Flamework.createModule().ignite();
			gone.extinguish();

			const message = expectThrows(
				() => Flamework.createModule().ignite({ imports: [gone] }),
				"importing an extinguished module",
			);
			expectTrue(contains(message, "is not ignited"), "error says the import is not ignited");
		},
	],
	[
		"an import's lazy provider is constructed by its owner, which starts it once",
		() => {
			LazyGadget.starts = 0;

			const world = Flamework.createModule().registerClassProvider(LazyGadget).ignite();
			const test = Flamework.createModule().ignite({ imports: [world] });

			const gadget = test.resolveDependency<LazyGadget>();
			expectTrue(gadget === world.resolveDependency<LazyGadget>(), "the owner holds it");

			// Both modules run a lifecycle plugin; only the owner's sees the construction.
			__harness.flush();
			expectEqual(LazyGadget.starts, 1, "onStart calls");

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"an own registration of a different class under an import's id wins",
		() => {
			const world = Flamework.createModule().registerClassProvider(Genuine).ignite();
			const test = Flamework.createModule()
				.registerProvider<Genuine>({ type: "class", value: Stub })
				.ignite({ imports: [world] });

			expectEqual(test.resolveDependency<Genuine>().kind, "stub" as never, "own answers first");
			expectEqual(world.resolveDependency<Genuine>().kind, "genuine", "the import keeps its own");

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"an own registration of the class an import holds is shared, not constructed again",
		() => {
			Counted.constructed = 0;

			const world = Flamework.createModule().registerClassProvider(Counted).ignite();
			const test = Flamework.createModule()
				.registerClassProvider(Counted)
				.ignite({ imports: [world] });

			expectEqual(Counted.constructed, 1, "constructions");
			expectTrue(
				test.resolveDependency<Counted>() === world.resolveDependency<Counted>(),
				"the import's answers",
			);

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"isolated keeps an own instance of a class an import holds",
		() => {
			Counted.constructed = 0;

			const world = Flamework.createModule().registerClassProvider(Counted).ignite();
			const test = Flamework.createModule()
				.registerClassProvider(Counted, { isolated: true })
				.ignite({ imports: [world] });

			expectEqual(Counted.constructed, 2, "constructions");
			expectTrue(test.resolveDependency<Counted>() !== world.resolveDependency<Counted>(), "two instances");

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"extinguishing a module extinguishes its importers first, deepest first",
		() => {
			const log = new Array<string>();
			const deep = Flamework.createModule().includePlugin(tracked("deep", log)).ignite();
			const middle = Flamework.createModule()
				.includePlugin(tracked("middle", log))
				.ignite({ imports: [deep] });
			const top = Flamework.createModule()
				.includePlugin(tracked("top", log))
				.ignite({ imports: [middle] });

			deep.extinguish();

			expectArrayEqual(log, ["top", "middle", "deep"], "teardown order");
			expectTrue(top.isExtinguished() && middle.isExtinguished(), "importers are down");
		},
	],
	[
		"an importer extinguished on its own detaches, so the import goes down alone",
		() => {
			const log = new Array<string>();
			const world = Flamework.createModule().includePlugin(tracked("world", log)).ignite();
			const test = Flamework.createModule()
				.includePlugin(tracked("test", log))
				.ignite({ imports: [world] });

			test.extinguish();
			world.extinguish();

			expectArrayEqual(log, ["test", "world"], "teardown order");
		},
	],
	[
		"a miss names the imports that were searched",
		() => {
			const world = Flamework.createModule().ignite();
			const test = Flamework.createModule().ignite({ imports: [world] });

			const message = expectThrows(() => test.resolveDependency<Widget>(), "resolving what nobody has");
			expectTrue(contains(message, "not found in imports"), "error says the imports were searched");

			test.extinguish();
			world.extinguish();
		},
	],
	[
		"isIgnited holds between ignition and extinguish",
		() => {
			const module = Flamework.createModule().ignite();
			expectTrue(module.isIgnited(), "after ignite");

			module.extinguish();
			expectFalse(module.isIgnited(), "after extinguish");
		},
	],
	[
		// A definition is a blueprint: each ignition builds an isolated container, which is what
		// makes a module testable in the first place.
		"igniting a definition twice yields independent containers",
		() => {
			const definition = Flamework.createModule().registerClassProvider(Widget).build();

			const first = definition.ignite();
			const second = definition.ignite();

			expectTrue(
				first.resolveDependency<Widget>() !== second.resolveDependency<Widget>(),
				"each ignition builds its own providers",
			);

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"refuses to extinguish twice",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite();
			module.extinguish();

			expectThrows(() => module.extinguish(), "extinguishing an extinguished module");
		},
	],
	[
		// Igniting a module twice used to return quietly, the one transition the state machine let
		// slide; it was there for a shared submodule ignited by each includer, which no longer exists.
		"refuses to ignite a module twice",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite();

			// `ignite` on a module is internal -- a definition is what gets ignited -- so it is
			// reached through a cast here, to pin the transition down rather than the API.
			const internal = module as unknown as { ignite: (this: void) => unknown };
			expectThrows(() => internal.ignite(), "igniting an ignited module");

			module.extinguish();
		},
	],
	[
		"Dependency resolves against the first root ignited",
		() => {
			// Claim the default explicitly and release it, so that the case does not depend on what
			// ran before it: the next plain ignite is the first root again.
			Flamework.createModule().ignite({ default: true }).extinguish();

			const first = Flamework.createModule().registerClassProvider(Widget).ignite();
			const second = Flamework.createModule().registerClassProvider(Widget).ignite();

			expectTrue(Dependency<Widget>() === first.resolveDependency<Widget>(), "the first root is the default");
			expectTrue(Dependency<Widget>() !== second.resolveDependency<Widget>(), "a later root is not");

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"ignite({ default: true }) makes a later root the default",
		() => {
			const first = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			const second = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });

			expectTrue(Dependency<Widget>() === second.resolveDependency<Widget>(), "the explicit default wins");

			second.extinguish();
			first.extinguish();
		},
	],
	[
		"extinguishing the default releases it",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			module.extinguish();

			const message = expectThrows(() => Dependency<Widget>(), "Dependency with no default module");
			expectTrue(message.find("before any module was ignited")[0] !== undefined, "error names the cause");
		},
	],
	[
		"Dependency resolves against a given module instead of the default",
		() => {
			const first = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			const second = Flamework.createModule().registerClassProvider(Widget).ignite();

			expectTrue(Dependency<Widget>(second) === second.resolveDependency<Widget>(), "the given module answers");
			expectTrue(Dependency<Widget>(second) !== Dependency<Widget>(), "and not the default");

			second.extinguish();
			first.extinguish();
		},
	],
	[
		"Dependency against an extinguished module raises for that module",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			module.extinguish();

			const message = expectThrows(() => Dependency<Widget>(module), "Dependency on an extinguished module");
			expectTrue(message.find("has been extinguished")[0] !== undefined, "error names the module's state");
		},
	],
	[
		// v1 let a constructor reach for a dependency through the global; the default is claimed
		// before ignition so that this still works, and the resolution constructs what is missing.
		"Dependency answers inside a provider constructor during ignition",
		() => {
			@Provider()
			class Reader {
				public seen = Dependency<Widget>();
			}

			// `Reader` first, so that `Widget` does not exist yet when the constructor asks for it.
			const module = Flamework.createModule()
				.registerClassProvider(Reader)
				.registerClassProvider(Widget)
				.ignite({ default: true });

			expectTrue(
				module.resolveDependency<Reader>().seen === module.resolveDependency<Widget>(),
				"resolved through the default while igniting",
			);

			module.extinguish();
		},
	],
	[
		// Regression: `ignite` ran the hooks bare, so a postIgnite hook that raised after the
		// lifecycle plugin's left its RunService connections live, ticking the failed module's
		// providers on every frame, and left the module in `Igniting`, where `extinguish` refused
		// it. Nothing could take it down.
		"a module whose ignition raises is extinguished, and holds nothing",
		() => {
			Ticking.frames = 0;
			Ticking.extinguished = 0;

			const log = new Array<string>();
			let seen: Module | undefined;

			const failing = Flamework.createPlugin("FailingPostIgnite", (target) => {
				seen = target.module;
				target.onExtinguished(() => log.push("extinguished"));
				target.onPostIgnite(() => error("post-ignite failed"));
			});

			const message = expectThrows(
				() =>
					Flamework.createModule()
						.includePlugin(failing)
						.registerClassProvider(Ticking)
						.ignite({ default: true }),
				"igniting past a hook that raises",
			);
			expectTrue(contains(message, "post-ignite failed"), `the hook's error comes out: ${message}`);

			__harness.step(0.25);
			expectEqual(Ticking.frames, 0, "frames delivered to the failed module's provider");
			expectArrayEqual(log, ["extinguished"], "the extinguished hooks ran");
			expectEqual(Ticking.extinguished, 1, "the provider's onExtinguished ran");
			expectTrue(seen!.isExtinguished(), "the module reports itself extinguished");
			expectThrows(() => seen!.resolveDependency<Ticking>(), "resolving from the failed module");
			expectThrows(() => Dependency<Ticking>(), "Dependency, with the failed module let go of as default");
		},
	],
	[
		// Regression: the extinguished hooks ran bare too, so one that raised left the hooks after it
		// unrun and the providers attached to their lifecycle events, with the state stuck in
		// `Extinguishing`, where a second `extinguish` was refused, and the module held as the
		// default for good.
		"extinguishes past a hook that raises, and reports it",
		() => {
			__harness.clearWarnings();
			Ticking.frames = 0;
			Ticking.extinguished = 0;

			const log = new Array<string>();
			const failing = Flamework.createPlugin("FailingExtinguished", (target) => {
				// First, so that the lifecycle plugin's own hook is among those after the raise.
				target.onExtinguished(() => error("extinguished hook failed"), { priority: HookPriority.First });
			});

			const module = Flamework.createModule()
				.includePlugin(failing)
				.includePlugin(tracked("after", log))
				.registerClassProvider(Ticking)
				.ignite({ default: true });

			expectNoThrow(() => module.extinguish(), "extinguishing past a hook that raises");
			expectTrue(
				__harness.warnings().some((line) => contains(line, "extinguished hook failed")),
				`the failure is reported: ${__harness.warnings().join(" | ")}`,
			);
			expectArrayEqual(log, ["after"], "the hooks after the raise ran");
			expectEqual(Ticking.extinguished, 1, "the provider's onExtinguished ran");

			__harness.step(0.25);
			expectEqual(Ticking.frames, 0, "frames delivered after extinguish");
			expectThrows(() => module.resolveDependency<Ticking>(), "resolving from the extinguished module");
			expectThrows(() => Dependency<Ticking>(), "Dependency, with the module let go of as default");
		},
	],
	[
		// Regression: the default is claimed before ignition, and a failed ignition only let go of
		// the claim, so `ignite({ default: true })` raising left no default at all: the root that had
		// been the default, still ignited, no longer answered `Dependency<T>()`.
		"a failed ignition with default: true leaves the previous default as it was",
		() => {
			const anchor = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });

			try {
				const failing = Flamework.createPlugin("FailingPostIgnite", (target) => {
					target.onPostIgnite(() => error("post-ignite failed"));
				});
				expectThrows(
					() => Flamework.createModule().includePlugin(failing).ignite({ default: true }),
					"igniting past a hook that raises",
				);

				expectTrue(
					Dependency<Widget>() === anchor.resolveDependency<Widget>(),
					"the previous default still answers",
				);
			} finally {
				anchor.extinguish();
			}
		},
	],
]);
