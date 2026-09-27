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
	/** Yields once, letting deferred work run. */
	flush: () => void;
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

/** Counts its per-frame calls; `Walker.onCall` runs inside each, for the specs that change the sets mid-walk. */
@Injectable()
class Walker implements OnTick, OnPhysics, OnRender {
	public static onCall?: (walker: Walker, event: "tick" | "physics" | "render") => void;

	public ticks = 0;
	public physics = 0;
	public renders = 0;

	public onTick() {
		this.ticks += 1;
		Walker.onCall?.(this, "tick");
	}

	public onPhysics() {
		this.physics += 1;
		Walker.onCall?.(this, "physics");
	}

	public onRender() {
		this.renders += 1;
		Walker.onCall?.(this, "render");
	}
}

function totalTicks(walkers: Array<Walker>) {
	return walkers.reduce((total, walker) => total + walker.ticks, 0);
}

/** Holds up the extinguish it hears of, on the thread running it, until a spec resumes `held`. */
@Provider()
class HoldingCloser implements OnExtinguished {
	public static held?: thread;

	public onExtinguished() {
		HoldingCloser.held = coroutine.running();
		coroutine.yield();
	}
}

const storeLog = new Array<string>();

/** A lazy provider whose `onInit` holds until a spec resumes `held`: a store still loading. */
@Provider({ lazy: true })
class HeldStore implements OnInit, OnStart {
	public static held?: thread;
	public initialised = false;

	public onInit() {
		HeldStore.held = coroutine.running();
		coroutine.yield();
		this.initialised = true;
		storeLog.push("store:init ends");
	}

	public onStart() {
		storeLog.push("store:start");
	}
}

/** An eager provider taking `HeldStore`, for a module that imports the one registering it. */
@Provider()
class StoreUser implements OnInit, OnStart {
	constructor(private readonly store: HeldStore) {}

	public onInit() {
		storeLog.push(`user:init store=${this.store.initialised}`);
	}

	public onStart() {
		storeLog.push(`user:start store=${this.store.initialised}`);
	}
}

/** A lazy provider whose `onInit` returns a Promise that a spec settles with `release`: a store loading. */
@Provider({ lazy: true })
class PromisedStore implements OnInit {
	public static release?: () => void;
	public initialised = false;

	public onInit() {
		return new Promise<void>((resolve) => {
			PromisedStore.release = () => {
				this.initialised = true;
				storeLog.push("store:init ends");
				resolve();
			};
		});
	}
}

/** An eager provider taking `PromisedStore`, for a module that imports the one registering it. */
@Provider()
class PromisedStoreUser implements OnInit, OnStart {
	constructor(private readonly store: PromisedStore) {}

	public onInit() {
		storeLog.push(`user:init store=${this.store.initialised}`);
	}

	public onStart() {
		storeLog.push(`user:start store=${this.store.initialised}`);
	}
}

/** A lazy provider nothing has resolved, with a sync `onInit`. */
@Provider({ lazy: true })
class QuietStore implements OnInit {
	public initialised = false;

	public onInit() {
		this.initialised = true;
		storeLog.push("quiet:init");
	}
}

/** An eager provider taking `QuietStore`, for a module that imports the one registering it. */
@Provider()
class QuietStoreUser implements OnInit, OnStart {
	constructor(private readonly store: QuietStore) {}

	public onInit() {
		storeLog.push(`user:init quiet=${this.store.initialised}`);
	}

	public onStart() {
		storeLog.push(`user:start quiet=${this.store.initialised}`);
	}
}

/** An eager provider taking `HeldStore` with an `onStart` and an `onTick`, and no `onInit`. */
@Provider()
class StartOnlyStoreUser implements OnStart, OnTick {
	private ticked = false;

	constructor(private readonly store: HeldStore) {}

	public onStart() {
		storeLog.push(`user:start store=${this.store.initialised}`);
	}

	public onTick() {
		if (this.ticked) return;
		this.ticked = true;
		storeLog.push(`user:tick store=${this.store.initialised}`);
	}
}

/** A lazy provider taking `HeldStore` with an `onStart` and no `onInit`, in the same module. */
@Provider({ lazy: true })
class LazyStartOnlyStoreUser implements OnStart {
	constructor(private readonly store: HeldStore) {}

	public onStart() {
		storeLog.push(`lazy:start store=${this.store.initialised}`);
	}
}

/** Yields until `done` answers true, a few rounds at most; answers whether it did. */
function flushUntil(done: () => boolean) {
	for (let round = 0; round < 20 && !done(); round++) {
		__harness.flush();
	}

	return done();
}

/** A lazy provider that ticks, whose `onInit` holds until a spec resumes `held`. */
@Provider({ lazy: true })
class HeldLazyTicker implements OnInit, OnTick {
	public static held?: thread;
	public static ticks = 0;

	public onInit() {
		HeldLazyTicker.held = coroutine.running();
		coroutine.yield();
	}

	public onTick() {
		HeldLazyTicker.ticks += 1;
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

			// One engine frame fires PreRender, then PreSimulation, then Heartbeat. PreRender never
			// fires on the server, so the plugin only connects it on the client.
			const expected = RunService.IsClient()
				? ["render:0.25", "physics:0.25", "tick:0.25"]
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
	[
		// The per-frame sets are walked in place, and a key added to a table while it is walked can
		// make the walk visit others twice, or not at all, once the table grows.
		"a per-frame listener attached during a frame is first called on the next, and each once a frame",
		() => {
			const module = Flamework.createModule().ignite();
			const walkers = new Array<Walker>();
			const attached = new Array<Walker>();
			for (let i = 0; i < 8; i++) {
				walkers.push(module.createClassInstance(Walker));
			}

			// Enough of them to grow the set several times over.
			Walker.onCall = (_, event) => {
				if (event !== "tick" || !attached.isEmpty()) return;
				for (let i = 0; i < 40; i++) {
					attached.push(module.createClassInstance(Walker));
				}
			};

			try {
				__harness.step(0.25);
				Walker.onCall = undefined;
				expectEqual(walkers.filter((w) => w.ticks !== 1).size(), 0, "listeners not ticked exactly once");
				expectEqual(totalTicks(attached), 0, "ticks of the listeners attached during the frame");

				__harness.step(0.25);
				expectEqual(walkers.filter((w) => w.ticks !== 2).size(), 0, "listeners not ticked once more");
				expectEqual(
					attached.filter((w) => w.ticks !== 1 || w.physics !== 1).size(),
					0,
					"listeners attached during the last frame not called exactly once in this one",
				);
			} finally {
				Walker.onCall = undefined;
				module.extinguish();
			}
		},
	],
	[
		"a per-frame listener detached during a frame before its turn is not called, nor one attached and detached in it",
		() => {
			const module = Flamework.createModule().ignite();
			const walkers = new Array<Walker>();
			for (let i = 0; i < 10; i++) {
				walkers.push(module.createClassInstance(Walker));
			}

			// The first one called detaches every other one, whichever it is: those whose turn has yet
			// to come must not be called.
			let passing: Walker | undefined;
			Walker.onCall = (walker, event) => {
				if (event !== "tick") return;
				Walker.onCall = undefined;
				for (const other of walkers) {
					if (other !== walker) module.removeClassInstance(other);
				}

				passing = module.createClassInstance(Walker);
				module.removeClassInstance(passing);
			};

			try {
				__harness.step(0.25);
				expectEqual(totalTicks(walkers), 1, "ticks in the frame the others were detached in");

				__harness.step(0.25);
				expectEqual(totalTicks(walkers), 2, "ticks after the next frame");
				expectTrue(passing !== undefined, "the listener was attached");
				expectEqual(passing!.ticks + passing!.physics + passing!.renders, 0, "calls to it");
			} finally {
				Walker.onCall = undefined;
				module.extinguish();
			}
		},
	],
	[
		"a per-frame callback that extinguishes its module ends the frame's walk",
		() => {
			const module = Flamework.createModule().ignite();
			const walkers = new Array<Walker>();
			for (let i = 0; i < 10; i++) {
				walkers.push(module.createClassInstance(Walker));
			}

			Walker.onCall = (_, event) => {
				if (event !== "tick") return;
				Walker.onCall = undefined;
				module.extinguish();
			};

			try {
				__harness.step(0.25);
				expectTrue(module.isExtinguished(), "the module extinguished");
				expectEqual(totalTicks(walkers), 1, "ticks in the frame the module extinguished in");
			} finally {
				Walker.onCall = undefined;
				if (!module.isExtinguished()) module.extinguish();
			}
		},
	],
	[
		// The extinguish begins on a thread the callback starts and yields -- in an importer's
		// `onExtinguished` -- before the module's lifecycle plugin hears of it: the callback has
		// returned by then, so the walk has to notice by itself.
		"a per-frame callback that starts an extinguish which yields ends the frame's walk",
		() => {
			HoldingCloser.held = undefined;

			const module = Flamework.createModule().ignite();
			const importer = Flamework.createModule()
				.registerClassProvider(HoldingCloser)
				.ignite({ imports: [module] });

			const walkers = new Array<Walker>();
			for (let i = 0; i < 10; i++) {
				walkers.push(module.createClassInstance(Walker));
			}

			Walker.onCall = (_, event) => {
				if (event !== "tick") return;
				Walker.onCall = undefined;
				task.spawn(() => module.extinguish());
			};

			try {
				__harness.step(0.25);
				expectTrue(HoldingCloser.held !== undefined, "the importer's onExtinguished holds the extinguish");
				expectEqual(totalTicks(walkers), 1, "ticks in the frame the extinguish began in");
			} finally {
				Walker.onCall = undefined;
				const held = HoldingCloser.held;
				HoldingCloser.held = undefined;
				if (held !== undefined) task.spawn(held);
			}

			expectTrue(module.isExtinguished() && importer.isExtinguished(), "both modules extinguished");
			__harness.step(0.25);
			expectEqual(totalTicks(walkers), 1, "ticks after the extinguish");
		},
	],
	[
		"a lazy provider resolved during a frame does not tick before its onInit has finished",
		() => {
			HeldLazyTicker.held = undefined;
			HeldLazyTicker.ticks = 0;

			const module = Flamework.createModule().registerClassProvider(HeldLazyTicker).ignite();
			const walker = module.createClassInstance(Walker);

			// Resolved inside a tick, so that it joins the event while the walk runs.
			Walker.onCall = (_, event) => {
				if (event !== "tick") return;
				Walker.onCall = undefined;
				module.resolveDependency<HeldLazyTicker>();
			};

			try {
				__harness.step(0.25);
				__harness.flush();
				expectTrue(HeldLazyTicker.held !== undefined, "its onInit is running");

				__harness.step(0.25);
				__harness.step(0.25);
				expectEqual(HeldLazyTicker.ticks, 0, "ticks before its onInit finished");
				expectEqual(walker.ticks, 3, "ticks of the other listener meanwhile");

				const held = HeldLazyTicker.held!;
				HeldLazyTicker.held = undefined;
				task.spawn(held);

				__harness.step(0.25);
				expectEqual(HeldLazyTicker.ticks, 1, "ticks once its onInit finished");
			} finally {
				Walker.onCall = undefined;
				const held = HeldLazyTicker.held;
				HeldLazyTicker.held = undefined;
				if (held !== undefined) task.spawn(held);
				module.extinguish();
			}
		},
	],
	[
		// The store is constructed for the user's constructor, in a module whose plugin has started,
		// so its `onInit` gets a turn of that module's own -- which came after the user's `onInit`
		// and `onStart` both, as the user was on the importing module's ignition list.
		"an eager provider's onInit waits for the pending onInit of an import's lazy provider it takes",
		() => {
			storeLog.clear();
			HeldStore.held = undefined;

			const gameModule = Flamework.createModule().registerClassProvider(HeldStore).ignite();
			let player: Module | undefined;
			task.spawn(() => {
				player = Flamework.createModule().registerClassProvider(StoreUser).ignite({ imports: [gameModule] });
				storeLog.push("ignited");
			});

			try {
				expectTrue(
					flushUntil(() => HeldStore.held !== undefined),
					"the store's onInit is running",
				);
				flushUntil(() => false);
				expectArrayEqual(storeLog, [], "events while the store's onInit runs");

				const held = HeldStore.held!;
				HeldStore.held = undefined;
				task.spawn(held);

				expectTrue(
					flushUntil(() => player !== undefined),
					"the importing module ignited",
				);
				expectArrayEqual(
					storeLog,
					["store:init ends", "store:start", "user:init store=true", "user:start store=true", "ignited"],
					"events",
				);
			} finally {
				const held = HeldStore.held;
				HeldStore.held = undefined;
				if (held !== undefined) task.spawn(held);
				flushUntil(() => player !== undefined);
				if (player !== undefined && !player.isExtinguished()) player.extinguish();
				if (!gameModule.isExtinguished()) gameModule.extinguish();
			}
		},
	],
	[
		// The import releases the store unfinished: the user's `onInit` would run against it, and
		// the module ignite onto an import gone, so the ignition fails instead, as it does when an
		// import extinguishes while an `onInit` yields.
		"an eager provider waiting on an import's lazy onInit fails the ignition when the import extinguishes",
		() => {
			storeLog.clear();
			HeldStore.held = undefined;

			const gameModule = Flamework.createModule().registerClassProvider(HeldStore).ignite();
			let outcome: string | undefined;
			task.spawn(() => {
				const [ignited, err] = pcall(() =>
					Flamework.createModule().registerClassProvider(StoreUser).ignite({ imports: [gameModule] }),
				);
				outcome = ignited ? "ignited" : tostring(err);
			});

			try {
				expectTrue(
					flushUntil(() => HeldStore.held !== undefined),
					"the store's onInit is running",
				);

				gameModule.extinguish();
				expectTrue(
					flushUntil(() => outcome !== undefined),
					"the ignition ended",
				);
				expectTrue(
					outcome!.find("extinguished while this module was igniting", 1, true)[0] !== undefined,
					`the ignition failed: ${outcome}`,
				);
				expectArrayEqual(storeLog, [], "the user's events");
			} finally {
				const held = HeldStore.held;
				HeldStore.held = undefined;
				if (held !== undefined) task.spawn(held);
				if (!gameModule.isExtinguished()) gameModule.extinguish();
			}
		},
	],
	[
		// Promise work -- a profile load's `andThen`, an `async` handler -- is a thread the store's
		// turn, waiting on the Promise its `onInit` returned, could have been running: taking it for
		// that turn's own work had the user skip the wait, and initialise and start against a store
		// still loading.
		"an eager provider ignited from Promise work waits for an import's lazy onInit that returned a Promise",
		() => {
			for (const how of ["andThen", "async"]) {
				storeLog.clear();
				PromisedStore.release = undefined;

				const gameModule = Flamework.createModule().registerClassProvider(PromisedStore).ignite();
				let player: Module | undefined;
				const ignitePlayer = () => {
					player = Flamework.createModule()
						.registerClassProvider(PromisedStoreUser)
						.ignite({ imports: [gameModule] });
					storeLog.push("ignited");
				};

				if (how === "andThen") {
					Promise.resolve().andThen(ignitePlayer);
				} else {
					(async () => {
						await Promise.resolve();
						ignitePlayer();
					})();
				}

				try {
					expectTrue(
						flushUntil(() => PromisedStore.release !== undefined),
						`${how}: the store's onInit is running`,
					);
					flushUntil(() => false);
					expectArrayEqual(storeLog, [], `${how}: events while the store's onInit runs`);

					PromisedStore.release!();
					expectTrue(
						flushUntil(() => player !== undefined),
						`${how}: the importing module ignited`,
					);
					expectArrayEqual(
						storeLog,
						["store:init ends", "user:init store=true", "user:start store=true", "ignited"],
						`${how}: events`,
					);
				} finally {
					// Read through a cast: the flow analysis still takes it for the `undefined` assigned above.
					const release = PromisedStore.release as (() => void) | undefined;
					PromisedStore.release = undefined;
					if (release !== undefined) release();
					flushUntil(() => player !== undefined);
					if (player !== undefined && !player.isExtinguished()) player.extinguish();
					if (!gameModule.isExtinguished()) gameModule.extinguish();
				}
			}
		},
	],
	[
		// Resolved for the first time from Promise work while another lazy provider's Promise was
		// pending, the store joins that provider's turn: it is initialised after that one's `onInit`,
		// and the user waits for it all the same.
		"an eager provider ignited from Promise work waits for a lazy provider that joined another's loading turn",
		() => {
			for (const how of ["andThen", "async"]) {
				storeLog.clear();
				PromisedStore.release = undefined;

				const gameModule = Flamework.createModule()
					.registerClassProvider(PromisedStore)
					.registerClassProvider(QuietStore)
					.ignite();
				gameModule.resolveDependency<PromisedStore>();

				let player: Module | undefined;
				try {
					expectTrue(
						flushUntil(() => PromisedStore.release !== undefined),
						`${how}: the loading store's onInit is running`,
					);

					const ignitePlayer = () => {
						player = Flamework.createModule()
							.registerClassProvider(QuietStoreUser)
							.ignite({ imports: [gameModule] });
						storeLog.push("ignited");
					};

					if (how === "andThen") {
						Promise.resolve().andThen(ignitePlayer);
					} else {
						(async () => {
							await Promise.resolve();
							ignitePlayer();
						})();
					}

					flushUntil(() => false);
					expectArrayEqual(storeLog, [], `${how}: events while the other store loads`);

					PromisedStore.release!();
					expectTrue(
						flushUntil(() => player !== undefined),
						`${how}: the importing module ignited`,
					);
					expectArrayEqual(
						storeLog,
						["store:init ends", "quiet:init", "user:init quiet=true", "user:start quiet=true", "ignited"],
						`${how}: events`,
					);
				} finally {
					// Read through a cast: the flow analysis still takes it for the `undefined` assigned above.
					const release = PromisedStore.release as (() => void) | undefined;
					PromisedStore.release = undefined;
					if (release !== undefined) release();
					flushUntil(() => player !== undefined);
					if (player !== undefined && !player.isExtinguished()) player.extinguish();
					if (!gameModule.isExtinguished()) gameModule.extinguish();
				}
			}
		},
	],
	[
		// Its `onStart` and per-frame events are what would see the store half-initialised.
		"an eager provider without an onInit starts and ticks after the pending onInit of an import's lazy provider it takes",
		() => {
			storeLog.clear();
			HeldStore.held = undefined;

			const gameModule = Flamework.createModule().registerClassProvider(HeldStore).ignite();
			let player: Module | undefined;
			task.spawn(() => {
				player = Flamework.createModule().registerClassProvider(StartOnlyStoreUser).ignite({ imports: [gameModule] });
				storeLog.push("ignited");
			});

			try {
				expectTrue(
					flushUntil(() => HeldStore.held !== undefined),
					"the store's onInit is running",
				);
				flushUntil(() => false);
				__harness.step(0.25);
				expectArrayEqual(storeLog, [], "events while the store's onInit runs");

				const held = HeldStore.held!;
				HeldStore.held = undefined;
				task.spawn(held);

				expectTrue(
					flushUntil(() => player !== undefined),
					"the importing module ignited",
				);
				__harness.step(0.25);
				expectArrayEqual(
					storeLog,
					["store:init ends", "store:start", "user:start store=true", "ignited", "user:tick store=true"],
					"events",
				);
			} finally {
				const held = HeldStore.held;
				HeldStore.held = undefined;
				if (held !== undefined) task.spawn(held);
				flushUntil(() => player !== undefined);
				if (player !== undefined && !player.isExtinguished()) player.extinguish();
				if (!gameModule.isExtinguished()) gameModule.extinguish();
			}
		},
	],
	[
		"a lazy provider without an onInit starts after the pending onInit of a provider it takes",
		() => {
			storeLog.clear();
			HeldStore.held = undefined;

			const module = Flamework.createModule()
				.registerClassProvider(HeldStore)
				.registerClassProvider(LazyStartOnlyStoreUser)
				.ignite();
			module.resolveDependency<HeldStore>();

			try {
				expectTrue(
					flushUntil(() => HeldStore.held !== undefined),
					"the store's onInit is running",
				);

				// On a thread of its own, so that it gets a turn of its own.
				task.spawn(() => module.resolveDependency<LazyStartOnlyStoreUser>());
				flushUntil(() => false);
				expectArrayEqual(storeLog, [], "events while the store's onInit runs");

				const held = HeldStore.held!;
				HeldStore.held = undefined;
				task.spawn(held);

				expectTrue(
					flushUntil(() => storeLog.includes("lazy:start store=true")),
					"the lazy provider started",
				);
				expectArrayEqual(storeLog, ["store:init ends", "store:start", "lazy:start store=true"], "events");
			} finally {
				const held = HeldStore.held;
				HeldStore.held = undefined;
				if (held !== undefined) task.spawn(held);
				module.extinguish();
			}
		},
	],
	[
		// The recycled thread a per-frame callback runs on is parked between callbacks: one that
		// kept `coroutine.running()` and cancels it later leaves a dead thread in the pool, which
		// every later callback, of every module, was then handed to.
		"a per-frame callback's thread cancelled while parked does not stop later callbacks",
		() => {
			const module = Flamework.createModule().ignite();
			let kept: thread | undefined;
			let first = 0;
			let second = 0;
			const stopFirst = module.listen<OnTick>(() => {
				first += 1;
				kept ??= coroutine.running();
			});

			try {
				__harness.step(0.25);
				expectTrue(kept !== undefined, "the callback ran");
				expectEqual(coroutine.status(kept!), "suspended", "its thread, parked");
				task.cancel(kept!);

				const stopSecond = module.listen<OnTick>(() => {
					second += 1;
				});
				__harness.step(0.25);
				__harness.step(0.25);
				stopSecond();

				expectEqual(first, 3, "calls to the callback that kept its thread");
				expectEqual(second, 2, "calls to one attached after the cancel");
			} finally {
				stopFirst();
				module.extinguish();
			}
		},
	],
	[
		// v1's `@Service/@Controller({ loadOrder })`: lower first, default 1.
		"runs onInit and onStart in ascending loadOrder, registration order among equals",
		() => {
			const log = new Array<string>();

			@Provider({ loadOrder: 5 })
			class OrderLate implements OnInit, OnStart {
				public onInit() {
					log.push("init:late");
				}
				public onStart() {
					log.push("start:late");
				}
			}

			@Provider()
			class OrderPlain implements OnInit, OnStart {
				public onInit() {
					log.push("init:plain");
				}
				public onStart() {
					log.push("start:plain");
				}
			}

			@Provider({ loadOrder: 0 })
			class OrderEarly implements OnInit, OnStart {
				public onInit() {
					log.push("init:early");
				}
				public onStart() {
					log.push("start:early");
				}
			}

			@Provider({ loadOrder: -1.5 })
			class OrderEarliest implements OnInit, OnStart {
				public onInit() {
					log.push("init:earliest");
				}
				public onStart() {
					log.push("start:earliest");
				}
			}

			/** The default spelled out: it keeps its place after the one registered before it. */
			@Provider({ loadOrder: 1 })
			class OrderPlainToo implements OnInit, OnStart {
				public onInit() {
					log.push("init:plain2");
				}
				public onStart() {
					log.push("start:plain2");
				}
			}

			const module = Flamework.createModule()
				.registerClassProvider(OrderLate)
				.registerClassProvider(OrderPlain)
				.registerClassProvider(OrderEarly)
				.registerClassProvider(OrderEarliest)
				.registerClassProvider(OrderPlainToo)
				.ignite();

			expectArrayEqual(
				log,
				[
					"init:earliest",
					"init:early",
					"init:plain",
					"init:plain2",
					"init:late",
					"start:earliest",
					"start:early",
					"start:plain",
					"start:plain2",
					"start:late",
				],
				"lifecycle order",
			);

			module.extinguish();
		},
	],
	[
		"initialises a provider's dependencies before it whatever their loadOrder, and starts in loadOrder alone",
		() => {
			const log = new Array<string>();

			@Provider({ loadOrder: 10 })
			class Heavy implements OnInit, OnStart {
				public onInit() {
					log.push("init:heavy");
				}
				public onStart() {
					log.push("start:heavy");
				}
			}

			@Provider({ loadOrder: 0 })
			class Needy implements OnInit, OnStart {
				constructor(public readonly heavy: Heavy) {}

				public onInit() {
					log.push("init:needy");
				}
				public onStart() {
					log.push("start:needy");
				}
			}

			@Provider()
			class Bystander implements OnInit, OnStart {
				public onInit() {
					log.push("init:bystander");
				}
				public onStart() {
					log.push("start:bystander");
				}
			}

			const module = Flamework.createModule()
				.registerClassProvider(Bystander)
				.registerClassProvider(Heavy)
				.registerClassProvider(Needy)
				.ignite();

			// `Needy` goes first and pulls `Heavy` forward with it: its onInit sees `Heavy` initialised.
			expectArrayEqual(
				log.filter((entry) => entry.find("init:", 1, true)[0] !== undefined),
				["init:heavy", "init:needy", "init:bystander"],
				"onInit order",
			);
			expectArrayEqual(
				log.filter((entry) => entry.find("start:", 1, true)[0] !== undefined),
				["start:needy", "start:bystander", "start:heavy"],
				"onStart order",
			);

			module.extinguish();
		},
	],
	[
		"keeps dependency order through a provider with no onInit of its own",
		() => {
			const log = new Array<string>();

			@Provider({ loadOrder: 9 })
			class Bedrock implements OnInit {
				public onInit() {
					log.push("bedrock");
				}
			}

			@Provider()
			class Between {
				constructor(public readonly bedrock: Bedrock) {}
			}

			@Provider({ loadOrder: 0 })
			class Summit implements OnInit {
				constructor(public readonly between: Between) {}

				public onInit() {
					log.push("summit");
				}
			}

			@Provider()
			class Aside implements OnInit {
				public onInit() {
					log.push("aside");
				}
			}

			const module = Flamework.createModule()
				.registerClassProvider(Aside)
				.registerClassProvider(Bedrock)
				.registerClassProvider(Between)
				.registerClassProvider(Summit)
				.ignite();

			expectArrayEqual(log, ["bedrock", "summit", "aside"], "onInit order");
			module.extinguish();
		},
	],
	[
		"starts a lower loadOrder's onStart up to its first yield before the next one starts",
		() => {
			const log = new Array<string>();

			@Provider({ loadOrder: 0 })
			class Yielder implements OnStart {
				public onStart() {
					log.push("yielder:begin");
					task.wait();
					log.push("yielder:end");
				}
			}

			@Provider()
			class Follower implements OnStart {
				public onStart() {
					log.push("follower");
				}
			}

			const module = Flamework.createModule()
				.registerClassProvider(Follower)
				.registerClassProvider(Yielder)
				.ignite();

			expectArrayEqual(log, ["yielder:begin", "follower"], "by the end of ignition");

			module.extinguish();
		},
	],
	[
		"ignores the loadOrder of a lazy provider",
		() => {
			const log = new Array<string>();

			@Provider({ lazy: true, loadOrder: -100 })
			class LazyFirst implements OnStart {
				public onStart() {
					log.push("lazy");
				}
			}

			@Provider({ loadOrder: 0.5 })
			class EagerHalf implements OnStart {
				public onStart() {
					log.push("eager");
				}
			}

			/** Resolves the lazy one during ignition, so that it starts with the eager ones. */
			@Provider()
			class LazyPuller implements OnInit {
				constructor(private readonly module: Module) {}

				public onInit() {
					this.module.resolveDependency<LazyFirst>();
				}
			}

			const module = Flamework.createModule()
				.registerClassProvider(LazyFirst)
				.registerClassProvider(EagerHalf)
				.registerClassProvider(LazyPuller)
				.ignite();

			expectArrayEqual(log, ["eager", "lazy"], "onStart order");
			module.extinguish();
		},
	],
	[
		"refuses a loadOrder that is not a finite number",
		() => {
			for (const bad of [math.huge, -math.huge, 0 / 0, "2" as unknown as number]) {
				const message = expectThrows(
					() => {
						@Provider({ loadOrder: bad })
						class BadOrder {}
					},
					`loadOrder ${tostring(bad)}`,
				);

				expectTrue(message.find("loadOrder must be a finite number", 1, true)[0] !== undefined, message);
				expectTrue(message.find("BadOrder", 1, true)[0] !== undefined, `names the class: ${message}`);
			}
		},
	],
]);
