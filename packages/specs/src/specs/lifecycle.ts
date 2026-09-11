import {
	Flamework,
	HookPriority,
	Injectable,
	LifecyclePlugin,
	LifecycleProvider,
	OnExtinguished,
	OnPhysics,
	OnRender,
	OnStart,
	OnTick,
	Provider,
	createLifecyclePlugin,
} from "@flamework-experimental/core";
import { RunService } from "@rbxts/services";
import { expectArrayEqual, expectEqual, expectThrows, expectTrue, suite } from "../testkit";

declare const __harness: {
	/** Fires the RunService signals the per-frame lifecycle events hang off. */
	step: (delta: number) => void;
};

const started = new Array<string>();
const frames = new Array<string>();
const extinguished = new Array<string>();

@Provider()
class Starter implements OnStart {
	public onStart() {
		started.push("Starter");
	}
}

@Provider()
class Plain {}

/** Subscribes to every per-frame event so one frame covers all three signals. */
@Provider()
class Ticker implements OnTick, OnPhysics, OnRender {
	public onTick(dt: number) {
		frames.push(`tick:${dt}`);
	}

	public onPhysics(dt: number) {
		frames.push(`physics:${dt}`);
	}

	public onRender(dt: number) {
		frames.push(`render:${dt}`);
	}
}

@Provider()
class Closer implements OnExtinguished {
	public onExtinguished() {
		extinguished.push("Closer");
	}
}

export = suite("lifecycle", [
	[
		"invokes onStart for providers implementing it",
		() => {
			started.clear();

			const module = Flamework.createModule().registerClassProvider(Starter).ignite();

			// onStart is spawned on its own thread, so it has already run by the time ignite returns.
			expectEqual(started.size(), 1, "number of started providers");
			expectEqual(started[0], "Starter", "started provider");

			module.extinguish();
		},
	],
	[
		"listen registers an ad-hoc lifecycle listener",
		() => {
			started.clear();

			const module = Flamework.createModule().ignite();

			const disconnect = module.listen<OnStart>({
				onStart() {
					started.push("listener");
				},
			});

			// `listen` attaches after ignite, so onStart does not fire retroactively.
			expectEqual(started.size(), 0, "listeners started");

			disconnect();
			module.extinguish();
		},
	],
	[
		// Regression: extinguish() only unregistered temporary instances, never the providers it had
		// instantiated, so plugins such as the lifecycle plugin kept holding (and ticking) providers
		// belonging to a dead module.
		"unregisters provider interfaces on extinguish",
		() => {
			const added = new Array<string>();
			const removed = new Array<string>();

			const trackingPlugin = Flamework.createPlugin("Tracking", (target) => {
				target.observe<OnStart>({
					onAdded: () => added.push("start"),
					onRemoved: () => removed.push("start"),
				});
			});

			const module = Flamework.createModule()
				.includePlugin(trackingPlugin)
				.registerClassProvider(Starter)
				.ignite();

			expectEqual(added.size(), 1, "onAdded invocations");
			expectEqual(removed.size(), 0, "onRemoved invocations before extinguish");

			module.extinguish();

			expectEqual(removed.size(), 1, "onRemoved invocations after extinguish");
		},
	],
	[
		// Regression: HookConfig.priority was a TODO'd enum that nothing read, so hook ordering was
		// whatever order plugins happened to be registered in.
		"runs hooks in priority order",
		() => {
			const order = new Array<string>();

			function hookPlugin(name: string, priority?: number) {
				return Flamework.createPlugin(name, (target) => {
					target.onPostIgnite(() => order.push(name), { priority });
				});
			}

			const module = Flamework.createModule()
				.includePlugin(hookPlugin("last", HookPriority.Last))
				.includePlugin(hookPlugin("normal"))
				.includePlugin(hookPlugin("first", HookPriority.First))
				.ignite();

			expectEqual(order.size(), 3, "hooks fired");
			expectEqual(order[0], "first", "first hook");
			expectEqual(order[1], "normal", "second hook");
			expectEqual(order[2], "last", "third hook");

			module.extinguish();
		},
	],
	[
		"PreIgnite runs before this module's providers are constructed",
		() => {
			const order = new Array<string>();

			@Provider()
			class Tracked {
				constructor() {
					order.push("provider");
				}
			}

			const plugin = Flamework.createPlugin("Order", (target) => {
				target.onPreIgnite(() => order.push("preIgnite"));
				target.onPostIgnite(() => order.push("postIgnite"));
			});

			const module = Flamework.createModule().includePlugin(plugin).registerClassProvider(Tracked).ignite();

			expectEqual(order[0], "preIgnite", "first event");
			expectEqual(order[1], "provider", "second event");
			expectEqual(order[2], "postIgnite", "third event");

			module.extinguish();
		},
	],
	[
		"createClassInstance injects dependencies without registering a provider",
		() => {
			const module = Flamework.createModule().registerClassProvider(Plain).ignite();

			@Injectable()
			class Consumer {
				constructor(public plain: Plain) {}
			}

			const instance = module.createClassInstance(Consumer);
			expectTrue(instance.plain === module.resolveDependency<Plain>(), "injected dependency");

			// It is not a provider, so it cannot be resolved by id.
			expectTrue(module.createClassInstance(Consumer) !== instance, "each call builds a new instance");

			module.extinguish();
		},
	],
	[
		"createClassInstance attaches lifecycle events and removeClassInstance detaches them",
		() => {
			const added = new Array<string>();
			const removed = new Array<string>();

			const trackingPlugin = Flamework.createPlugin("Tracking", (target) => {
				target.observe<OnStart>({
					onAdded: () => added.push("start"),
					onRemoved: () => removed.push("start"),
				});
			});

			const module = Flamework.createModule().includePlugin(trackingPlugin).ignite();

			@Injectable()
			class Listener implements OnStart {
				public onStart() {}
			}

			const instance = module.createClassInstance(Listener);
			expectEqual(added.size(), 1, "onAdded invocations");

			module.removeClassInstance(instance);
			expectEqual(removed.size(), 1, "onRemoved invocations");

			// Removing twice must not fire onRemoved again.
			module.removeClassInstance(instance);
			expectEqual(removed.size(), 1, "onRemoved invocations after a repeated removal");

			module.extinguish();
		},
	],
	[
		"keeps registration order for equal priorities",
		() => {
			const order = new Array<string>();

			function hookPlugin(name: string) {
				return Flamework.createPlugin(name, (target) => {
					target.onPostIgnite(() => order.push(name));
				});
			}

			const module = Flamework.createModule()
				.includePlugin(hookPlugin("a"))
				.includePlugin(hookPlugin("b"))
				.includePlugin(hookPlugin("c"))
				.ignite();

			expectTrue(order[0] === "a" && order[1] === "b" && order[2] === "c", "registration order preserved");

			module.extinguish();
		},
	],
	[
		"delivers the per-frame lifecycle events with their delta",
		() => {
			frames.clear();

			const module = Flamework.createModule().registerClassProvider(Ticker).ignite();

			__harness.step(0.25);

			// PreRender never fires on the server, so the plugin only connects it on the client.
			const expected = RunService.IsClient()
				? ["physics:0.25", "tick:0.25", "render:0.25"]
				: ["physics:0.25", "tick:0.25"];
			expectArrayEqual(frames, expected, "lifecycle events for one frame");

			module.extinguish();
		},
	],
	[
		"stops delivering per-frame events once the module is extinguished",
		() => {
			frames.clear();

			const module = Flamework.createModule().registerClassProvider(Ticker).ignite();

			module.extinguish();
			__harness.step(0.5);

			expectEqual(frames.size(), 0, "lifecycle events after extinguish");
		},
	],
	[
		"runs onExtinguished when the module is extinguished",
		() => {
			extinguished.clear();

			const module = Flamework.createModule().registerClassProvider(Closer).ignite();

			expectEqual(extinguished.size(), 0, "onExtinguished before extinguish");

			module.extinguish();

			expectArrayEqual(extinguished, ["Closer"], "onExtinguished after extinguish");
		},
	],
	[
		"starts every module with the lifecycle plugin",
		() => {
			started.clear();

			const module = Flamework.createModule().registerClassProvider(Starter).ignite();

			expectEqual(started.size(), 1, "onStart calls without including LifecyclePlugin by hand");
			expectTrue(module.resolveDependency<LifecycleProvider>() !== undefined, "the provider is there to ask");

			module.extinguish();
		},
	],
	[
		"disableDefaultLifecycle() leaves lifecycle events out",
		() => {
			started.clear();
			frames.clear();

			const module = Flamework.createModule()
				.disableDefaultLifecycle()
				.registerClassProvider(Starter)
				.registerClassProvider(Ticker)
				.ignite();

			__harness.step(0.25);

			expectEqual(started.size(), 0, "onStart calls");
			expectEqual(frames.size(), 0, "per-frame events");
			expectThrows(() => module.resolveDependency<LifecycleProvider>(), "resolving the lifecycle provider");

			module.extinguish();
		},
	],
	[
		// Two lifecycle plugins would tick everything twice; a configured one takes the default's place.
		"replaces the default with a configured lifecycle plugin rather than adding one",
		() => {
			frames.clear();

			const module = Flamework.createModule()
				.includePlugin(createLifecyclePlugin({ profiling: false }))
				.registerClassProvider(Ticker)
				.ignite();

			__harness.step(0.25);

			expectEqual(frames.filter((v) => v === "tick:0.25").size(), 1, "ticks in one frame");

			module.extinguish();
		},
	],
	[
		"including LifecyclePlugin by hand changes nothing",
		() => {
			frames.clear();

			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.registerClassProvider(Ticker)
				.ignite();

			__harness.step(0.25);

			expectEqual(frames.filter((v) => v === "tick:0.25").size(), 1, "ticks in one frame");

			module.extinguish();
		},
	],
	[
		"refuses a second lifecycle plugin brought in by a plugin",
		() => {
			const sneaky = Flamework.createPlugin("Sneaky", (target) => {
				target.includePlugin(createLifecyclePlugin({}));
			});

			const message = expectThrows(
				() => Flamework.createModule().includePlugin(sneaky).ignite(),
				"a plugin including a second lifecycle plugin",
			);

			expectTrue(message.find("slot")[0] !== undefined, "error names the slot");
		},
	],
]);
