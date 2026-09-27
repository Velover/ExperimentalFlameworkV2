import {
	Dependency,
	Flamework,
	HookPriority,
	Module,
	OnExtinguished,
	OnStart,
	OnTick,
	Provider,
} from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	expectArrayEqual,
	expectEqual,
	expectFalse,
	expectNoThrow,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { LogService } from "@rbxts/services";
import { FwTestLazyProvider } from "server/Features/Testing/Services/FwTestLazyProvider";
import { FwTestService } from "server/Features/Testing/Services/FwTestService";
import { Consumer, Gadget, Ticking, Widget } from "server/Fixtures/moduleProviders";

/** A plugin that records the module it was extinguished with, to watch teardown order. */
function tracked(name: string, log: Array<string>) {
	return Flamework.createPlugin(name, (target) => target.onExtinguished(() => log.push(name)));
}

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

/** Everything `warn` says while the case runs, off `LogService`. */
function recordWarnings() {
	const lines = new Array<string>();
	const connection = LogService.MessageOut.Connect((message, kind) => {
		if (kind === Enum.MessageType.MessageWarning) {
			lines.push(message);
		}
	});
	defer(() => connection.Disconnect());

	return {
		mentions: (needle: string) => lines.some((line) => contains(line, needle)),
		describe: () => lines.join(" | "),
	};
}

/**
 * Modules, imports and teardown in a live place. The same ground the Lune `modules` suite covers,
 * run against the real engine so that a module built at runtime, beside the one the game ignited,
 * is proven to stay independent of it.
 */
@Provider({ activeIn: ["testing"] })
export class ModuleTests implements OnStart {
	onStart() {
		defineTests("modules", () => {
			test("the game's own module is ignited and is what Dependency answers from", () => {
				const module = Dependency<FwTestService>();
				expectTrue(module !== undefined, "the server's provider");
			});

			test("a module built now resolves its own providers without touching the game's", () => {
				const module = Flamework.createModule().registerClassProvider(Widget).ignite();
				defer(() => module.extinguish());

				expectTrue(module.isIgnited(), "isIgnited after ignition");
				expectEqual(module.resolveDependency<Widget>().kind, "widget", "its own provider");
				expectThrows(() => module.resolveDependency<FwTestService>(), "a provider it never registered");
			});

			test("an import's provider is resolvable and injectable, and the import must be ignited first", () => {
				const world = Flamework.createModule().registerClassProvider(Widget).ignite();
				defer(() => world.extinguish());

				const consumer = Flamework.createModule()
					.registerClassProvider(Consumer)
					.ignite({ imports: [world] });
				defer(() => consumer.extinguish());

				expectEqual(
					consumer.resolveDependency<Consumer>().widget,
					world.resolveDependency<Widget>(),
					"the shared instance",
				);

				const definition = Flamework.createModule().registerClassProvider(Consumer);
				const cold = Flamework.createModule().registerClassProvider(Widget);
				expectThrows(
					() => definition.ignite({ imports: [cold as never] }),
					"importing a module that is not ignited",
				);
			});

			test("extinguishing a module takes its importers down first", () => {
				const log = new Array<string>();
				const base = Flamework.createModule().includePlugin(tracked("base", log)).ignite();
				const middle = Flamework.createModule()
					.includePlugin(tracked("middle", log))
					.ignite({ imports: [base] });
				const top = Flamework.createModule()
					.includePlugin(tracked("top", log))
					.ignite({ imports: [middle] });

				expectTrue(top.isIgnited() && middle.isIgnited(), "all three up");
				base.extinguish();

				expectArrayEqual(log, ["top", "middle", "base"], "deepest importer first");
				expectFalse(top.isIgnited(), "the importer went down with it");
			});

			test("a lazy provider is constructed on first resolution and cached after it", () => {
				const before = Gadget.constructed;
				const module = Flamework.createModule().registerClassProvider(Gadget).ignite();
				defer(() => module.extinguish());

				expectEqual(Gadget.constructed, before, "not constructed by ignition");
				const first = module.resolveDependency<Gadget>();
				expectEqual(Gadget.constructed, before + 1, "constructed on first resolve");
				expectEqual(module.resolveDependency<Gadget>(), first, "cached afterwards");
			});

			test("the game's own lazy provider was left alone until something asked for it", () => {
				// FwTestService resolves it during its checks, so by now it exists exactly once.
				expectTrue(
					FwTestLazyProvider.constructed <= 1,
					`constructed at most once, got ${FwTestLazyProvider.constructed}`,
				);
			});

			test("refuses to ignite or extinguish a module twice", () => {
				const module = Flamework.createModule().registerClassProvider(Widget).ignite();
				module.extinguish();
				expectThrows(() => module.extinguish(), "a second extinguish");
				expectFalse(module.isIgnited(), "down for good");
			});

			// The Lune `modules` suite's regression cases. The default module is the game's own
			// here, and `Dependency<T>()` is what the rest of the run answers from, so a case that
			// claims the default has to leave it as it found it: a failed claim does by itself, and
			// no case here extinguishes a module it claimed the default with.

			test("a module whose ignition raises is extinguished, and holds nothing", () => {
				// Regression: `ignite` ran the hooks bare, so a postIgnite hook that raised after
				// the lifecycle plugin's left its RunService connections live, ticking the failed
				// module's providers on every frame, and left the module in `Igniting`, where
				// `extinguish` refused it. Nothing could take it down.
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

				task.wait(0.2);
				expectEqual(Ticking.frames, 0, "frames delivered to the failed module's provider");
				expectArrayEqual(log, ["extinguished"], "the extinguished hooks ran");
				expectEqual(Ticking.extinguished, 1, "the provider's onExtinguished ran");
				expectTrue(seen!.isExtinguished(), "the module reports itself extinguished");
				expectThrows(() => seen!.resolveDependency<Ticking>(), "resolving from the failed module");
				expectThrows(() => Dependency<Ticking>(), "Dependency, with the failed module let go of as default");
				expectTrue(Dependency<FwTestService>() !== undefined, "the game's module answers Dependency again");
			});

			test("extinguishes past a hook that raises, and reports it", () => {
				// Regression: the extinguished hooks ran bare too, so one that raised left the hooks
				// after it unrun and the providers attached to their lifecycle events, with the
				// state stuck in `Extinguishing`, where a second `extinguish` was refused. Without
				// `default: true` here: extinguishing the default leaves the place without one.
				const warnings = recordWarnings();
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
					.ignite();

				expectNoThrow(() => module.extinguish(), "extinguishing past a hook that raises");
				expectArrayEqual(log, ["after"], "the hooks after the raise ran");
				expectEqual(Ticking.extinguished, 1, "the provider's onExtinguished ran");
				expectFalse(module.isIgnited(), "the module is down");
				expectThrows(() => module.extinguish(), "a second extinguish, refused as on any extinguished module");

				// The warning is read off a signal, which a place may deliver once this thread yields.
				task.wait(0.2);
				expectTrue(
					warnings.mentions("extinguished hook failed"),
					`the failure is reported: ${warnings.describe()}`,
				);
				expectEqual(Ticking.frames, 0, "frames delivered after extinguish");
				expectThrows(() => module.resolveDependency<Ticking>(), "resolving from the extinguished module");
			});

			test("a failed ignition with default: true leaves the previous default as it was", () => {
				// Regression: the default is claimed before ignition, and a failed ignition only let
				// go of the claim, so `ignite({ default: true })` raising left no default at all: the
				// root that had been the default, still ignited, no longer answered `Dependency<T>()`.
				// The game's own module is that root here.
				const anchor = Dependency<FwTestService>();

				const failing = Flamework.createPlugin("FailingPostIgnite", (target) => {
					target.onPostIgnite(() => error("post-ignite failed"));
				});
				expectThrows(
					() => Flamework.createModule().includePlugin(failing).ignite({ default: true }),
					"igniting past a hook that raises",
				);

				expectTrue(Dependency<FwTestService>() === anchor, "the previous default still answers");
			});
		});
	}
}
