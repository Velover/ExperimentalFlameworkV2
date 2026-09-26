import {
	Flamework,
	Injectable,
	LifecycleProvider,
	Module,
	ModuleBuilder,
	OnExtinguished,
	OnInit,
	OnPhysics,
	OnStart,
	OnTick,
	Provider,
} from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectEqual,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { RunService } from "@rbxts/services";
import { FwTestDependency } from "server/Features/Testing/Services/FwTestDependency";

// The providers below are not exported on purpose: `registerProviders("src/server/Tests")` takes
// every exported class with an identifier into the game's module, and these belong to the module a
// case builds, whose ticks and extinguishes the case counts.

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

/**
 * Resolves the lazy provider from its `onInit`, the way a provider setting itself up would. Through
 * the module it was built by: `Dependency<T>()` without one answers from the game's module here.
 */
@Provider()
class LazyResolver implements OnInit {
	constructor(private readonly module: Module) {}

	public onInit() {
		inits.push("resolver:init");
		this.module.resolveDependency<LazyInit>();
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
 * A collection is brought on by allocating, until the probe lets go or the rounds run out, since
 * `collectgarbage("collect")` is not a thing a place can call. Returns what the probe still holds.
 */
function collectUntilReleased(probe: Map<object, true>) {
	for (let round = 0; round < 50 && probe.size() > 0; round++) {
		const junk = new Array<object>();
		for (let i = 0; i < 20000; i++) junk.push({ i });
	}

	return probe.size();
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

/** A bare module of the case's own, extinguished when the case is over unless the case already did. */
function caseModule(build: (builder: ModuleBuilder) => ModuleBuilder) {
	const module = build(Flamework.createModule()).ignite();
	defer(() => {
		if (module.isIgnited()) module.extinguish();
	});

	return module;
}

/**
 * Built through the module without being registered, to exercise createClassInstance in a place.
 * `implements OnTick` is what makes the transformer record the interface, which is how the
 * lifecycle plugin finds it; a class with a matching method but no declaration is never ticked.
 */
@Injectable()
class Scratch implements OnTick {
	public ticks = 0;

	constructor(public readonly dependency: FwTestDependency) {}

	onTick() {
		this.ticks++;
	}
}

/**
 * The per-frame lifecycle against the engine's own signals. `onTick` hangs off `RunService.Heartbeat`
 * rather than `PostSimulation` precisely so that it keeps firing where nothing is simulated: an
 * Open Cloud task runs no physics, and `PostSimulation` never fires there.
 */
@Provider({ activeIn: ["testing"] })
export class LifecycleTests implements OnStart, OnTick, OnPhysics {
	private ticks = 0;
	private physics = 0;
	private lastDelta = 0;

	constructor(private readonly module: Module) {}

	onTick(dt: number) {
		this.ticks++;
		this.lastDelta = dt;
	}

	onPhysics() {
		this.physics++;
	}

	onStart() {
		defineTests("lifecycle", () => {
			test("onTick fires every frame with a positive delta", () => {
				const before = this.ticks;
				eventually(() => this.ticks > before, "onTick to fire");
				expectTrue(this.lastDelta > 0, `the delta is positive, got ${this.lastDelta}`);
			});

			test("onPhysics fires in a running game and is silent where nothing simulates", () => {
				const before = this.physics;
				task.wait(0.2);
				const fired = this.physics > before;

				// PreSimulation is the physics step; a Luau execution task has none, and only
				// Heartbeat runs there. Either answer is correct for the environment it ran in.
				if (RunService.IsRunning()) {
					expectTrue(fired, "onPhysics fires in a running game");
				} else {
					expectEqual(this.physics, before, "no physics step outside a running game");
				}
			});

			test("listen registers an ad-hoc lifecycle listener and its destructor removes it", () => {
				let seen = 0;
				// A method, not an arrow property: roblox-ts refuses an arrow where the interface
				// declares a method, which OnTick does.
				const stop = this.module.listen<OnTick>({
					onTick() {
						seen += 1;
					},
				});

				eventually(() => seen > 0, "the ad-hoc listener to tick");

				// Exactly once: a destructor refuses to run twice, so nothing defers it.
				stop();
				expectThrows(() => stop(), "destructing a listener twice");
				const after = seen;
				task.wait(0.1);
				expectEqual(seen, after, "no ticks after the destructor ran");
			});

			test("createClassInstance injects and attaches lifecycle events, removeClassInstance detaches them", () => {
				const scratch = this.module.createClassInstance(Scratch);
				expectTrue(scratch.dependency.initialized, "its dependency was injected and had run onInit");

				eventually(() => scratch.ticks > 0, "the ad-hoc instance to tick");

				this.module.removeClassInstance(scratch);
				const after = scratch.ticks;
				task.wait(0.1);
				expectEqual(scratch.ticks, after, "no ticks after removal");
			});

			test("a module with the lifecycle plugin disabled delivers no per-frame events", () => {
				const quiet = Flamework.createModule()
					.disableDefaultLifecycle()
					.registerClassProvider(FwTestDependency)
					.ignite();
				defer(() => quiet.extinguish());

				const scratch = quiet.createClassInstance(Scratch);
				task.wait(0.2);
				expectEqual(scratch.ticks, 0, "no ticks without a lifecycle plugin");
			});

			// The Lune `lifecycle` suite's regression cases, against the engine's own frames.

			test("initialises a lazy provider resolved during another provider's onInit before anything starts", () => {
				// Regression: `postIgnite` ran `onInit` over a copy of its list, so a lazy provider
				// resolved from another provider's `onInit` -- attached while the copy was being
				// walked -- was never initialised, yet was started with the rest.
				inits.clear();

				caseModule((builder) => builder.registerClassProvider(LazyInit).registerClassProvider(LazyResolver));

				expectArrayEqual(
					inits,
					["resolver:init", "resolver:resolved", "lazy:init", "lazy:start"],
					"onInit, then onStart, for the lazy provider",
				);
			});

			test("listen attaches the object to the event asked for, and no other", () => {
				// Regression: the full form of `listen` wrapped the object in a proxy whose `__index`
				// was the object, so metadata lookups walked on to the object's class and attached
				// the proxy to every event the class implements, not the one asked for.
				const module = caseModule((builder) => builder);
				const lifecycle = module.resolveDependency<LifecycleProvider>();

				const multi = new Multi();
				const stop = module.listen<OnTick>(multi);

				expectEqual(lifecycle.onTick.size(), 1, "onTick members");
				expectEqual(lifecycle.onPhysics.size(), 0, "onPhysics members");
				expectEqual(lifecycle.onExtinguished.size(), 0, "onExtinguished members");

				eventually(() => multi.ticks > 0, "onTick to reach the object");
				expectEqual(multi.physics, 0, "onPhysics calls while ticking");

				stop();
				module.extinguish();
				expectEqual(multi.extinguishes, 0, "onExtinguished calls on extinguish");
			});

			test("listen runs the object's methods with the object as this", () => {
				// The same proxy was what the event called the method on, so a method writing to
				// `this` wrote to the proxy, and the object never saw it.
				const module = caseModule((builder) => builder);

				const counter = {
					count: 0,
					onTick() {
						this.count += 1;
					},
				};
				const stop = module.listen<OnTick>(counter);

				eventually(() => counter.count >= 3, "ticks counted on the object");
				stop();
			});

			test("lets go of a per-frame listener once it is removed", () => {
				// Regression: the thread `recycleThread` keeps idle held on to the last callback it
				// ran, which closes over the listener, so a detached per-frame listener stayed
				// reachable until some other per-frame callback went through. In a place the game's
				// own providers tick through that thread every frame, so this shows the release
				// rather than the hold; the Lune `lifecycle` spec is where the hold showed.
				const module = caseModule((builder) => builder);
				const probe = weakProbe();

				// In a function of its own, so that no register of this frame still names the instance.
				const attachTickAndRemove = () => {
					const instance = module.createClassInstance(FrameListener);
					probe.set(instance, true);

					task.wait(0.1);
					module.removeClassInstance(instance);
				};

				attachTickAndRemove();

				expectEqual(collectUntilReleased(probe), 0, "listeners still held after removal");
			});

			test("attaches a subclass that re-declares its parent's interfaces once per event", () => {
				// Regression: `getClassImplements` flattened every `flamework:implements` list up the
				// class chain, so a subclass re-declaring an interface its parent implements was
				// added to it twice; the lifecycle's sets absorbed the repeat, its ordered lists ran
				// onInit and onStart twice.
				dupLog.clear();

				caseModule((builder) => builder.registerClassProvider(DupChild));

				eventually(() => dupLog.includes("tick"), "the subclass to tick");
				expectArrayEqual(
					[dupLog[0], dupLog[1], dupLog[2]],
					["init", "start", "tick"],
					"events delivered to the subclass",
				);
				expectEqual(dupLog.filter((entry) => entry === "init").size(), 1, "onInit calls");
				expectEqual(dupLog.filter((entry) => entry === "start").size(), 1, "onStart calls");
			});

			test("an attachment an observer refuses attaches nothing", () => {
				// Regression: an observer's `onAdded` that raised part-way through an attachment left
				// the object attached to the observers before it -- the lifecycle's, ticking it every
				// frame -- and among the module's instances, with nothing handed back to remove it by.
				TickCounter.ticks = 0;

				const refusing = Flamework.createPlugin("Refusing", (target) => {
					target.observe<OnTick>({ onAdded: () => error("observer refused") });
				});

				// After the default lifecycle plugin, so that its observer has added the object by
				// the time this one refuses it.
				const module = caseModule((builder) => builder.includePlugin(refusing));
				const lifecycle = module.resolveDependency<LifecycleProvider>();

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
				task.wait(0.2);
				expectEqual(TickCounter.ticks, 0, "ticks delivered to what was refused");
			});

			test("an instance detached by an earlier onExtinguished does not hear the event", () => {
				// Regression: `extinguished` walked a copy of the `onExtinguished` set without
				// checking that each object was still in it, so one detached by a handler before it
				// -- `removeClassInstance` from an `onExtinguished` -- still heard the event.
				Detaching.calls = 0;
				Detaching.instances.clear();

				const module = caseModule((builder) => builder);
				for (let i = 0; i < 6; i++) {
					Detaching.instances.push(module.createClassInstance(Detaching));
				}

				module.extinguish();
				Detaching.instances.clear();

				expectEqual(Detaching.calls, 1, "onExtinguished calls, with each one detaching the rest");
			});
		});
	}
}
