import {
	Dependency,
	Flamework,
	HookPriority,
	Injectable,
	LifecyclePlugin,
	LifecycleProvider,
	OnExtinguished,
	OnInit,
	OnPhysics,
	OnRender,
	OnStart,
	OnTick,
	Provider,
	createLifecyclePlugin,
	type Module,
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
const inits = new Array<string>();

@Provider({ lazy: true })
class LazyInit implements OnInit, OnStart {
	public onInit() {
		inits.push("lazy:init");
	}

	public onStart() {
		inits.push("lazy:start");
	}
}

/** Resolves the lazy provider from its `onInit`, the way a provider setting itself up would. */
@Provider()
class LazyResolver implements OnInit {
	public onInit() {
		inits.push("resolver:init");
		Dependency<LazyInit>();
		inits.push("resolver:resolved");
	}
}

/** Implements three events, so that listening for one of them shows which ones attach. */
@Provider()
class Multi implements OnTick, OnPhysics, OnExtinguished {
	public ticks = 0;
	public physics = 0;
	public extinguishes = 0;

	public onTick() {
		this.ticks += 1;
	}

	public onPhysics() {
		this.physics += 1;
	}

	public onExtinguished() {
		this.extinguishes += 1;
	}
}

@Injectable()
class FrameListener implements OnTick {
	public onTick() {}
}

/** A weak-keyed table: an object in it is held by nothing but whoever else still has it. */
function weakProbe() {
	return setmetatable(new Map<object, true>(), { __mode: "k" });
}

/**
 * Lune exposes no `collectgarbage("collect")`, so a collection is brought on by allocating instead,
 * until the probe lets go or the rounds run out. Returns what the probe still holds.
 */
function collectUntilReleased(probe: Map<object, true>) {
	for (let round = 0; round < 50 && probe.size() > 0; round++) {
		const junk = new Array<object>();
		for (let i = 0; i < 20000; i++) junk.push({ i });
	}

	return probe.size();
}

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

const dupLog = new Array<string>();

/** Logs its events; the subclass below re-declares every interface it implements. */
@Provider()
class DupBase implements OnInit, OnStart, OnTick {
	public onInit() {
		dupLog.push("init");
	}

	public onStart() {
		dupLog.push("start");
	}

	public onTick() {
		dupLog.push("tick");
	}
}

/** Re-declares its parent's interfaces, so the transformer writes every id on both classes. */
@Provider()
class DupChild extends DupBase implements OnInit, OnStart, OnTick {}

/** Counts its ticks on the class, since a refused attachment hands nothing back to count on. */
@Injectable()
class TickCounter implements OnTick {
	public static ticks = 0;

	public onTick() {
		TickCounter.ticks += 1;
	}
}

/** From its `onExtinguished`, detaches every other one of its kind: only the first to hear the event should. */
@Injectable()
class Detaching implements OnExtinguished {
	public static instances = new Array<Detaching>();
	public static calls = 0;

	constructor(private readonly module: Module) {}

	public onExtinguished() {
		Detaching.calls += 1;
		for (const other of Detaching.instances) {
			if (other !== this) {
				this.module.removeClassInstance(other);
			}
		}
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
	[
		// Regression: `postIgnite` ran `onInit` over a copy of its list, so a lazy provider resolved
		// from another provider's `onInit` -- attached while the copy was being walked -- was never
		// initialised, yet was started with the rest.
		"initialises a lazy provider resolved during another provider's onInit before anything starts",
		() => {
			inits.clear();

			const module = Flamework.createModule()
				.registerClassProvider(LazyInit)
				.registerClassProvider(LazyResolver)
				.ignite({ default: true });

			expectArrayEqual(
				inits,
				["resolver:init", "resolver:resolved", "lazy:init", "lazy:start"],
				"onInit, then onStart, for the lazy provider",
			);

			module.extinguish();
		},
	],
	[
		// Regression: the full form of `listen` wrapped the object in a proxy whose `__index` was the
		// object, so metadata lookups walked on to the object's class and attached the proxy to
		// every event the class implements, not the one asked for.
		"listen attaches the object to the event asked for, and no other",
		() => {
			const module = Flamework.createModule().ignite();
			const lifecycle = module.resolveDependency<LifecycleProvider>();

			const multi = new Multi();
			const stop = module.listen<OnTick>(multi);

			expectEqual(lifecycle.onTick.size(), 1, "onTick members");
			expectEqual(lifecycle.onPhysics.size(), 0, "onPhysics members");
			expectEqual(lifecycle.onExtinguished.size(), 0, "onExtinguished members");

			__harness.step(0.25);
			expectEqual(multi.ticks, 1, "onTick calls in one frame");
			expectEqual(multi.physics, 0, "onPhysics calls in one frame");

			stop();
			module.extinguish();
			expectEqual(multi.extinguishes, 0, "onExtinguished calls on extinguish");
		},
	],
	[
		// The same proxy was what the event called the method on, so a method writing to `this`
		// wrote to the proxy, and the object never saw it.
		"listen runs the object's methods with the object as this",
		() => {
			const module = Flamework.createModule().ignite();

			const counter = {
				count: 0,
				onTick() {
					this.count += 1;
				},
			};
			const stop = module.listen<OnTick>(counter);

			__harness.step(0.25);
			__harness.step(0.25);
			__harness.step(0.25);
			expectEqual(counter.count, 3, "ticks counted on the object");

			stop();
			module.extinguish();
		},
	],
	[
		// Regression: the thread `recycleThread` keeps idle held on to the last callback it ran,
		// which closes over the listener, so a detached per-frame listener stayed reachable until
		// some other per-frame callback went through -- indefinitely, when there was none.
		"lets go of a per-frame listener once it is removed",
		() => {
			const module = Flamework.createModule().ignite();
			const probe = weakProbe();

			// In a function of its own, so that no register of this frame still names the instance.
			const attachTickAndRemove = () => {
				const instance = module.createClassInstance(FrameListener);
				probe.set(instance, true);

				__harness.step(0.25);
				module.removeClassInstance(instance);
			};

			attachTickAndRemove();

			expectEqual(collectUntilReleased(probe), 0, "listeners still held after removal");

			module.extinguish();
		},
	],
	[
		// Regression: `getClassImplements` flattened every `flamework:implements` list up the class
		// chain, so a subclass re-declaring an interface its parent implements was added to it twice;
		// the lifecycle's sets absorbed the repeat, its ordered lists ran onInit and onStart twice.
		"attaches a subclass that re-declares its parent's interfaces once per event",
		() => {
			dupLog.clear();

			const module = Flamework.createModule().registerClassProvider(DupChild).ignite();

			try {
				__harness.step(0.25);
				expectArrayEqual(dupLog, ["init", "start", "tick"], "events delivered to the subclass");
			} finally {
				module.extinguish();
			}
		},
	],
	[
		// Regression: an observer's `onAdded` that raised part-way through an attachment left the
		// object attached to the observers before it -- the lifecycle's, ticking it every frame --
		// and among the module's instances, with nothing handed back to remove it by.
		"an attachment an observer refuses attaches nothing",
		() => {
			TickCounter.ticks = 0;

			const refusing = Flamework.createPlugin("Refusing", (target) => {
				target.observe<OnTick>({ onAdded: () => error("observer refused") });
			});

			// After the default lifecycle plugin, so that its observer has added the object by the
			// time this one refuses it.
			const module = Flamework.createModule().includePlugin(refusing).ignite();
			const lifecycle = module.resolveDependency<LifecycleProvider>();

			try {
				const message = expectThrows(
					() => module.createClassInstance(TickCounter),
					"creating an instance an observer refuses",
				);
				expectTrue(
					message.find("observer refused", 1, true)[0] !== undefined,
					`the error comes out: ${message}`,
				);
				expectThrows(
					() => module.listen<OnTick>(new TickCounter()),
					"listening with an object an observer refuses",
				);

				expectEqual(lifecycle.onTick.size(), 0, "onTick members after the refusals");
				__harness.step(0.25);
				expectEqual(TickCounter.ticks, 0, "ticks delivered to what was refused");
			} finally {
				module.extinguish();
			}
		},
	],
	[
		// Regression: `extinguished` walked a copy of the `onExtinguished` set without checking that
		// each object was still in it, so one detached by a handler before it -- `removeClassInstance`
		// from an `onExtinguished` -- still heard the event.
		"an instance detached by an earlier onExtinguished does not hear the event",
		() => {
			Detaching.calls = 0;
			Detaching.instances.clear();

			const module = Flamework.createModule().ignite();
			for (let i = 0; i < 6; i++) {
				Detaching.instances.push(module.createClassInstance(Detaching));
			}

			module.extinguish();
			Detaching.instances.clear();

			expectEqual(Detaching.calls, 1, "onExtinguished calls, with each one detaching the rest");
		},
	],
]);
