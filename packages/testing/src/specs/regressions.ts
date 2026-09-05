import { BaseComponent, Component, ComponentMetadata, ComponentPlugin, Components } from "@flamework/components";
import {
	Flamework,
	LifecyclePlugin,
	OnInit,
	OnPhysics,
	OnStart,
	OnTick,
	Provider,
	createLifecyclePlugin,
} from "@flamework/core";
import { expectDefined, expectEqual, expectThrows, expectTrue, suite } from "../testkit";

/**
 * Regressions found in the v1-to-v2 review. Each case names the behaviour it pins down; the
 * comment above it says what used to go wrong.
 */

declare const __harness: {
	step: (delta: number) => void;
	flush: () => void;
	/** Runs the callback with CollectionService signals deferred, then delivers them in order. */
	deferTags: (callback: () => void) => void;
};

const log = new Array<string>();

function folder(name: string) {
	const instance = new Instance("Folder");
	instance.Name = name;
	instance.Parent = game.Workspace;
	return instance;
}

function collectionService() {
	return game.GetService("CollectionService");
}

// -- lifecycle ------------------------------------------------------------------------------------

@Provider()
class InitFirst implements OnInit, OnStart {
	public onInit() {
		log.push("init:first");
	}

	public onStart() {
		log.push("start:first");
	}
}

@Provider()
class InitSecond implements OnInit {
	constructor(_first: InitFirst) {}

	/** Returns a Promise, which ignition has to wait on before initialising the next provider. */
	public onInit() {
		return new Promise<void>((resolve) => {
			task.defer(() => {
				log.push("init:second");
				resolve();
			});
		});
	}
}

@Provider()
class InitThird implements OnInit, OnStart {
	constructor(_second: InitSecond) {}

	public onInit() {
		log.push("init:third");
	}

	public onStart() {
		log.push("start:third");
	}
}

@Provider()
class PhysicsTimer implements OnPhysics {
	public onPhysics(dt: number, time: number) {
		log.push(`physics:${dt}:${typeIs(time, "number")}`);
	}
}

@Provider({ lazy: true })
class LazyThing implements OnStart {
	public static constructed = 0;

	constructor() {
		LazyThing.constructed += 1;
	}

	public onStart() {
		log.push("start:lazy");
	}
}

@Provider()
class Ticker implements OnTick {
	public onTick(dt: number) {
		log.push(`tick:${dt}`);
	}
}

@Provider()
class BaseProvider {}

class UndecoratedChild extends BaseProvider {}

// -- components -----------------------------------------------------------------------------------

@Component({ tag: "RgTicker" })
class RgTicker extends BaseComponent<{}, Folder> implements OnTick {
	public onTick(dt: number) {
		log.push(`ctick:${dt}`);
	}
}

/** Asks for its own component while it is being constructed, which must yield nothing, not recurse. */
@Component({ tag: "RgSelfish" })
class RgSelfish extends BaseComponent<{}, Folder> {
	public sawSelf: boolean;

	constructor(metadata: ComponentMetadata, components: Components) {
		super(metadata);
		this.sawSelf = components.getComponent<RgSelfish>(metadata.instance) !== undefined;
	}
}

/** Forces its own construction from inside its constructor, which is a genuine cycle. */
@Component({ tag: "RgCyclic" })
class RgCyclic extends BaseComponent<{}, Folder> {
	constructor(metadata: ComponentMetadata, components: Components) {
		super(metadata);
		components.addComponent<RgCyclic>(metadata.instance);
	}
}

@Component({ tag: "RgPicky", predicate: (instance) => instance.Name === "Chosen" })
class RgPicky extends BaseComponent<{}, Folder> {}

@Component({ tag: "RgPlain" })
class RgPlain extends BaseComponent<{}, Folder> {}

class RgUndecorated extends RgPlain {}

/** Counts constructions and destructions, to catch a component being rebuilt behind our back. */
@Component({ tag: "RgStale" })
class RgStale extends BaseComponent<{}, Folder> {
	public static created = 0;
	public static destroyed = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		RgStale.created++;
	}

	override destroy() {
		super.destroy();
		RgStale.destroyed++;
	}
}

function componentPlugin() {
	return ComponentPlugin.createPlugin()
		.registerComponent(RgTicker)
		.registerComponent(RgSelfish)
		.registerComponent(RgCyclic)
		.registerComponent(RgPicky)
		.registerComponent(RgPlain)
		.registerComponent(RgStale)
		.build();
}

export = suite("regressions", [
	[
		// v1 had `OnInit`; v2 dropped it, leaving no ordered, awaitable initialisation step.
		"runs onInit in dependency order, awaiting promises, before any onStart",
		() => {
			log.clear();

			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.registerClassProvider(InitThird)
				.registerClassProvider(InitFirst)
				.registerClassProvider(InitSecond)
				.ignite();

			expectEqual(log[0], "init:first", "first init");
			expectEqual(log[1], "init:second", "second init, after its promise settled");
			expectEqual(log[2], "init:third", "third init");

			for (let i = 3; i < log.size(); i++) {
				expectTrue(log[i].sub(1, 6) === "start:", `entry ${i} is a start`);
			}

			expectTrue(log.includes("start:first") && log.includes("start:third"), "starts ran after inits");

			module.extinguish();
		},
	],
	[
		// v1 passed the elapsed time to onPhysics; v2 silently dropped the argument.
		"passes the elapsed time to onPhysics",
		() => {
			log.clear();

			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.registerClassProvider(PhysicsTimer)
				.ignite();

			__harness.step(0.5);
			expectTrue(log.includes("physics:0.5:true"), "onPhysics received a numeric time");

			module.extinguish();
		},
	],
	[
		// v1's `@Optional()` let a singleton exist only when depended on; v2 constructed everything.
		"constructs a lazy provider only when it is first resolved, and still starts it",
		() => {
			log.clear();
			LazyThing.constructed = 0;

			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.registerClassProvider(LazyThing)
				.ignite();
			expectEqual(LazyThing.constructed, 0, "constructions during ignite");

			const lazy = module.resolveDependency<LazyThing>();
			expectEqual(LazyThing.constructed, 1, "constructions after resolving");
			expectTrue(lazy === module.resolveDependency<LazyThing>(), "lazy provider is still a singleton");

			// A provider constructed after ignition is started on the next resume point.
			__harness.flush();
			expectTrue(log.includes("start:lazy"), "onStart ran for the lazy provider");

			module.extinguish();
		},
	],
	[
		// v2 let an extinguished module hand out providers and construct new instances.
		"refuses to resolve, create or listen once extinguished",
		() => {
			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.registerClassProvider(InitFirst)
				.ignite();
			module.extinguish();

			expectTrue(module.isExtinguished(), "isExtinguished");
			expectThrows(() => module.resolveDependency<InitFirst>(), "resolving from a dead module");
			expectThrows(() => module.createClassInstance(InitFirst), "creating an instance on a dead module");
			expectThrows(() => module.listen<OnStart>({ onStart() {} }), "listening on a dead module");
		},
	],
	[
		// Metadata is inherited, so an undecorated subclass used to register under its parent's id.
		"rejects an undecorated subclass of a provider",
		() => {
			const message = expectThrows(
				() => Flamework.createModule().registerClassProvider(UndecoratedChild),
				"registering an undecorated subclass",
			);

			expectTrue(message.find("inherits")[0] !== undefined, "error explains the inheritance");
		},
	],
	[
		"rejects an undecorated subclass of a component",
		() => {
			const message = expectThrows(
				() => ComponentPlugin.createPlugin().registerComponent(RgUndecorated),
				"registering an undecorated component subclass",
			);

			expectTrue(message.find("inherits")[0] !== undefined, "error explains the inheritance");
		},
	],
	[
		// Documented wrongly as "called once": function providers run on every resolution.
		"runs a function provider on every resolution",
		() => {
			let calls = 0;
			const module = Flamework.createModule()
				.registerProvider<string>(
					{
						type: "function",
						callback: () => {
							calls += 1;
							return "value";
						},
					},
					"counted",
				)
				.ignite();

			module.resolveDependency<string>("counted");
			module.resolveDependency<string>("counted");
			expectEqual(calls, 2, "function provider invocations");

			module.extinguish();
		},
	],
	[
		"accepts lifecycle plugin options",
		() => {
			log.clear();

			const module = Flamework.createModule()
				.includePlugin(createLifecyclePlugin({ profiling: true }))
				.registerClassProvider(Ticker)
				.ignite();

			__harness.step(0.1);
			expectTrue(log.includes("tick:0.1"), "tick delivered with profiling on");

			module.extinguish();
		},
	],
	[
		// The docs claimed the component plugin brought its own lifecycle plugin; components take
		// their events from the module that includes the component plugin.
		"delivers per-frame events to components through the parent module's lifecycle plugin",
		() => {
			log.clear();

			const module = Flamework.createModule()
				.includePlugin(LifecyclePlugin)
				.includePlugin(componentPlugin())
				.ignite();

			collectionService().AddTag(folder("RgTickerTarget"), "RgTicker");
			__harness.step(0.25);

			expectEqual(log.filter((v) => v === "ctick:0.25").size(), 1, "component ticks in one frame");

			module.extinguish();
			log.clear();

			__harness.step(0.25);
			expectEqual(log.size(), 0, "component ticks after extinguish");
		},
	],
	[
		// A constructor asking for its own component used to recurse until the stack overflowed.
		"returns nothing from getComponent while that component is constructing",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();
			const components = module.resolveDependency<Components>();

			const instance = folder("RgSelfishTarget");
			collectionService().AddTag(instance, "RgSelfish");

			const component = components.getComponent<RgSelfish>(instance);
			expectTrue(component !== undefined, "component constructed");
			expectEqual(component!.sawSelf, false, "getComponent inside the constructor");

			module.extinguish();
		},
	],
	[
		"raises a clear error on a cyclic component construction",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();

			const message = expectThrows(
				() => collectionService().AddTag(folder("RgCyclicTarget"), "RgCyclic"),
				"constructing a cyclic component",
			);

			expectTrue(message.find("cyclic")[0] !== undefined, "error names the cycle");

			module.extinguish();
		},
	],
	[
		// v1 checked the predicate on the eager path too; v2 only checked it for CollectionService.
		"honours the predicate when getComponent constructs eagerly",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();
			const components = module.resolveDependency<Components>();

			const rejected = folder("NotChosen");
			collectionService().AddTag(rejected, "RgPicky");
			expectEqual(components.getComponent<RgPicky>(rejected), undefined, "component for a rejected instance");

			const accepted = folder("Chosen");
			collectionService().AddTag(accepted, "RgPicky");
			expectTrue(components.getComponent<RgPicky>(accepted) !== undefined, "component for an accepted instance");

			module.extinguish();
		},
	],
	[
		// The component plugin had no Extinguished hook, so a dead module kept its components and
		// kept constructing new ones.
		"destroys components and stops watching tags when the module extinguishes",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();
			const components = module.resolveDependency<Components>();

			const instance = folder("RgPlainTarget");
			collectionService().AddTag(instance, "RgPlain");
			expectEqual(components.getAllComponents<RgPlain>().size(), 1, "components before extinguish");

			module.extinguish();
			expectEqual(components.getAllComponents<RgPlain>().size(), 0, "components after extinguish");

			collectionService().AddTag(folder("RgPlainLate"), "RgPlain");
			expectEqual(components.getAllComponents<RgPlain>().size(), 0, "components created on a dead module");

			expectThrows(() => components.addComponent<RgPlain>(folder("RgPlainManual")), "adding to a dead module");
		},
	],
	[
		// CollectionService signals are deferred in most places. A component built eagerly (through
		// getComponent or waitForComponent) whose tag was removed inside the same deferral window
		// used to be destroyed by the late InstanceAdded event, rebuilt by it, and destroyed again by
		// InstanceRemoved: three constructions for one part. Found by the Studio battletest.
		"ignores a stale tag-added event for an instance that has lost its tag",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();
			const components = module.resolveDependency<Components>();
			RgStale.created = 0;
			RgStale.destroyed = 0;

			const instance = folder("RgStaleTarget");
			__harness.deferTags(() => {
				collectionService().AddTag(instance, "RgStale");
				expectTrue(components.getComponent<RgStale>(instance) !== undefined, "eager component");
				collectionService().RemoveTag(instance, "RgStale");
			});

			expectEqual(components.getComponent<RgStale>(instance), undefined, "component once the tag is gone");
			expectEqual(RgStale.created, 1, "constructions");
			expectEqual(RgStale.destroyed, 1, "destructions");

			module.extinguish();
		},
	],
	[
		// The mirror image: a removal delivered after the tag has been put back must not tear down
		// a component whose instance is tagged again.
		"keeps a component whose tag was removed and re-added within one deferral",
		() => {
			const module = Flamework.createModule().includePlugin(componentPlugin()).ignite();
			const components = module.resolveDependency<Components>();
			RgStale.created = 0;
			RgStale.destroyed = 0;

			const instance = folder("RgStaleKept");
			collectionService().AddTag(instance, "RgStale");
			const component = expectDefined(components.getComponent<RgStale>(instance), "component");

			__harness.deferTags(() => {
				collectionService().RemoveTag(instance, "RgStale");
				collectionService().AddTag(instance, "RgStale");
			});

			expectEqual(components.getComponent<RgStale>(instance), component, "the same component survives");
			expectEqual(RgStale.created, 1, "constructions");
			expectEqual(RgStale.destroyed, 0, "destructions");

			module.extinguish();
		},
	],
]);
