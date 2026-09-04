import {
	BaseComponent,
	Component,
	ComponentMetadata,
	ComponentPlugin,
	ComponentStreamingMode,
	Components,
} from "@flamework/components";
import { Flamework, OnStart } from "@flamework/core";
import { ReplicatedStorage, RunService } from "@rbxts/services";
import {
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectResolves,
	expectThrows,
	expectTrue,
	suite,
} from "../testkit";

const events = new Array<string>();

declare const __harness: {
	/** Component streaming reacts to descendant changes on a deferred task. */
	flush: () => void;
};

interface TaggedAttributes {
	speed: number;
	label?: string;
}

@Component({ tag: "Tagged" })
class Tagged extends BaseComponent<TaggedAttributes, Folder> implements OnStart {
	public onStart() {
		events.push(`start:${this.instance.Name}`);
	}
}

@Component({ tag: "Defaulted", defaults: { speed: 7 } })
class Defaulted extends BaseComponent<{ speed: number }, Folder> {}

@Component({ tag: "PartOnly" })
class PartOnly extends BaseComponent<{}, Part> {}

@Component()
class Manual extends BaseComponent<{}, Folder> {}

/** Requires a `Core` child, so its instance guard fails until one is parented under it. */
@Component({ tag: "Watched", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0 })
class Watched extends BaseComponent<{}, Folder & { Core: Folder }> {}

@Component({ tag: "Frozen", streamingMode: ComponentStreamingMode.Disabled, warningTimeout: 0 })
class Frozen extends BaseComponent<{}, Folder & { Core: Folder }> {}

/** Uses the default streaming mode, which watches on the client and not on the server. */
@Component({ tag: "Contextual", warningTimeout: 0 })
class Contextual extends BaseComponent<{}, Folder & { Core: Folder }> {}

/** Contextual streaming leaves atomic models alone, because they stream in all at once. */
@Component({ tag: "Atomic", warningTimeout: 0 })
class Atomic extends BaseComponent<{}, Model & { Core: Folder }> {}

@Component({ tag: "Blocked" })
class Blocked extends BaseComponent<{}, Folder> {}

@Component({ tag: "Allowed", ancestorWhitelist: [ReplicatedStorage] })
class Allowed extends BaseComponent<{}, Folder> {}

/** Implemented by a component, so it can be resolved polymorphically. */
interface Damageable {
	takeDamage(amount: number): void;
}

@Component({ tag: "Enemy" })
class Enemy extends BaseComponent<{}, Folder> implements Damageable {
	public damage = 0;

	public takeDamage(amount: number) {
		this.damage += amount;
	}
}

@Component({ tag: "Engine" })
class Engine extends BaseComponent<{}, Folder> {}

/** Depends on another component, which Flamework both injects and waits for. */
@Component({ tag: "Car", warningTimeout: 0 })
class Car extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly engine: Engine,
	) {
		super(metadata);
	}
}

@Component({ tag: "Picky", predicate: (instance) => instance.Name === "Chosen" })
class Picky extends BaseComponent<{}, Folder> {}

@Component({ tag: "Static", refreshAttributes: false })
class Static extends BaseComponent<{ speed: number }, Folder> {}

/**
 * Builds a module with the component plugin and just the components the specs use, so that no spec
 * depends on path-based discovery.
 */
function createComponentModule() {
	const plugin = ComponentPlugin.createPlugin()
		.registerComponent(Tagged)
		.registerComponent(Defaulted)
		.registerComponent(PartOnly)
		.registerComponent(Manual)
		.registerComponent(Watched)
		.registerComponent(Frozen)
		.registerComponent(Contextual)
		.registerComponent(Atomic)
		.registerComponent(Blocked)
		.registerComponent(Allowed)
		.registerComponent(Enemy)
		.registerComponent(Engine)
		.registerComponent(Car)
		.registerComponent(Picky)
		.registerComponent(Static)
		.build();

	return Flamework.createModule().includePlugin(plugin).ignite();
}

function folderIn(parent: Instance, name: string, attributes?: { [key: string]: unknown }) {
	const instance = new Instance("Folder");
	instance.Name = name;
	instance.Parent = parent;

	for (const [key, value] of pairs(attributes ?? {})) {
		instance.SetAttribute(key as string, value as AttributeValue);
	}

	return instance;
}

function folder(name: string, attributes?: { [key: string]: unknown }) {
	return folderIn(game.Workspace, name, attributes);
}

/** Completes an instance tree that a `Core` child is missing from. */
function addCore(parent: Instance) {
	const instance = new Instance("Folder");
	instance.Name = "Core";
	instance.Parent = parent;

	return instance;
}

function collectionService() {
	return game.GetService("CollectionService");
}

export = suite("components", [
	[
		"constructs a component when its tag is added",
		() => {
			events.clear();

			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Tagged1", { speed: 10 });
			collectionService().AddTag(instance, "Tagged");

			const component = expectDefined(components.getComponent<Tagged>(instance), "component");
			expectEqual(component.attributes.speed, 10, "attribute value");
			expectEqual(component.instance, instance, "attached instance");

			module.extinguish();
		},
	],
	[
		"runs component lifecycle events",
		() => {
			events.clear();

			const module = createComponentModule();
			const instance = folder("Started", { speed: 1 });
			collectionService().AddTag(instance, "Tagged");

			expectTrue(events.includes("start:Started"), "onStart fired for the component");

			module.extinguish();
		},
	],
	[
		"destroys the component when the tag is removed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Removed", { speed: 3 });
			collectionService().AddTag(instance, "Tagged");
			expectDefined(components.getComponent<Tagged>(instance), "component before removal");

			collectionService().RemoveTag(instance, "Tagged");
			expectEqual(components.getComponent<Tagged>(instance), undefined, "component after removal");

			module.extinguish();
		},
	],
	[
		"rejects an instance whose attributes fail their generated guard",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// `speed` is typed as `number`, so a string must not satisfy the generated guard.
			const instance = folder("BadAttributes", { speed: "fast" });

			expectThrows(
				() => components.addComponent<Tagged>(instance),
				"adding a component with an invalid attribute",
			);

			module.extinguish();
		},
	],
	[
		"substitutes a default instead of rejecting when one is configured",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Defaulted1");
			const component = components.addComponent<Defaulted>(instance);

			expectEqual(component.attributes.speed, 7, "defaulted attribute");
			expectEqual(instance.GetAttribute("speed"), 7, "default written back to the instance");

			module.extinguish();
		},
	],
	[
		"honours optional attributes",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("NoLabel", { speed: 2 });
			const component = components.addComponent<Tagged>(instance);

			expectEqual(component.attributes.label, undefined, "absent optional attribute");

			module.extinguish();
		},
	],
	[
		"rejects an instance that fails the generated instance guard",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// PartOnly is declared as `BaseComponent<{}, Part>`, so a Folder must not satisfy it.
			expectThrows(
				() => components.addComponent<PartOnly>(folder("NotAPart")),
				"adding a Part component to a Folder",
			);

			module.extinguish();
		},
	],
	[
		"adds and removes components manually",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("ManualTarget");
			const component = components.addComponent<Manual>(instance);

			expectEqual(components.getComponent<Manual>(instance), component, "component after add");

			components.removeComponent<Manual>(instance);
			expectEqual(components.getComponent<Manual>(instance), undefined, "component after remove");

			module.extinguish();
		},
	],
	[
		"lists every component of a kind",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			components.addComponent<Manual>(folder("List1"));
			components.addComponent<Manual>(folder("List2"));

			expectEqual(components.getAllComponents<Manual>().size(), 2, "components of this kind");

			module.extinguish();
		},
	],
	[
		"observes attribute changes",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Observed", { speed: 1 });
			const component = components.addComponent<Tagged>(instance);

			instance.SetAttribute("speed", 42);
			expectEqual(component.attributes.speed, 42, "attribute after external change");

			module.extinguish();
		},
	],
	[
		"picks up instances that were already tagged before ignition",
		() => {
			const instance = folder("PreTagged", { speed: 5 });
			collectionService().AddTag(instance, "Tagged");

			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			expectDefined(components.getComponent<Tagged>(instance), "component for a pre-existing tag");

			module.extinguish();
		},
	],
	[
		"waits for the instance tree when streaming is watched",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Streamed");
			collectionService().AddTag(instance, "Watched");
			expectEqual(components.getComponent<Watched>(instance), undefined, "component before the tree arrives");

			addCore(instance);
			__harness.flush();

			expectDefined(components.getComponent<Watched>(instance), "component once the tree is complete");

			module.extinguish();
		},
	],
	[
		"removes a watched component when its tree breaks apart",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Unstreamed");
			collectionService().AddTag(instance, "Watched");

			const core = addCore(instance);
			__harness.flush();
			expectDefined(components.getComponent<Watched>(instance), "component once the tree is complete");

			core.Parent = undefined;
			__harness.flush();

			expectEqual(components.getComponent<Watched>(instance), undefined, "component after the tree broke");

			module.extinguish();
		},
	],
	[
		"never re-runs the instance guard when streaming is disabled",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("NotStreamed");
			collectionService().AddTag(instance, "Frozen");

			addCore(instance);
			__harness.flush();

			expectEqual(components.getComponent<Frozen>(instance), undefined, "component once the tree is complete");

			module.extinguish();
		},
	],
	[
		// Contextual is the default: a server sees the whole tree at once, so only a client has any
		// reason to watch for the rest of it to stream in.
		"watches the instance tree contextually on the client only",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Contextual1");
			collectionService().AddTag(instance, "Contextual");

			addCore(instance);
			__harness.flush();

			const component = components.getComponent<Contextual>(instance);
			if (RunService.IsClient()) {
				expectDefined(component, "component on the client");
			} else {
				expectEqual(component, undefined, "component on the server");
			}

			module.extinguish();
		},
	],
	[
		// An atomic model replicates in one piece, so contextual streaming skips the watch even on
		// a client -- if the guard failed, the tree is not going to fill in later.
		"leaves an atomic model unwatched",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const model = new Instance("Model");
			model.Name = "AtomicModel";
			model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic;
			model.Parent = game.Workspace;

			collectionService().AddTag(model, "Atomic");

			addCore(model);
			__harness.flush();

			expectEqual(components.getComponent<Atomic>(model), undefined, "component for an atomic model");

			module.extinguish();
		},
	],
	[
		// `getComponent` constructs eagerly and deliberately ignores the ancestor lists, which only
		// gate CollectionService-driven construction, so these count what actually exists instead.
		"skips tagged instances under a blocked ancestor",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			collectionService().AddTag(folderIn(ReplicatedStorage, "InStorage"), "Blocked");
			expectEqual(components.getAllComponents<Blocked>().size(), 0, "components under a blocked ancestor");

			collectionService().AddTag(folder("InWorkspace"), "Blocked");
			expectEqual(components.getAllComponents<Blocked>().size(), 1, "components under an allowed ancestor");

			module.extinguish();
		},
	],
	[
		"restricts construction to an explicit ancestor allowlist",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			collectionService().AddTag(folder("OutsideAllowlist"), "Allowed");
			expectEqual(components.getAllComponents<Allowed>().size(), 0, "components outside the allowlist");

			collectionService().AddTag(folderIn(ReplicatedStorage, "InsideAllowlist"), "Allowed");
			expectEqual(components.getAllComponents<Allowed>().size(), 1, "components inside the allowlist");

			module.extinguish();
		},
	],
	[
		"resolves a component through an interface it implements",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Enemy1");
			collectionService().AddTag(instance, "Enemy");

			const damageables = components.getComponents<Damageable>(instance);
			expectEqual(damageables.size(), 1, "components implementing the interface");
			expectEqual(components.getAllComponents<Damageable>().size(), 1, "components of this interface");

			damageables[0].takeDamage(5);
			expectEqual(expectDefined(components.getComponent<Enemy>(instance)).damage, 5, "damage after the call");

			module.extinguish();
		},
	],
	[
		"notifies listeners when a component is added and removed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const added = new Array<string>();
			const removed = new Array<string>();
			components.onComponentAdded<Enemy>((_component, instance) => added.push(instance.Name));
			components.onComponentRemoved<Enemy>((_component, instance) => removed.push(instance.Name));

			const instance = folder("Observed1");
			collectionService().AddTag(instance, "Enemy");
			expectArrayEqual(added, ["Observed1"], "added notifications");

			collectionService().RemoveTag(instance, "Enemy");
			expectArrayEqual(removed, ["Observed1"], "removed notifications");

			module.extinguish();
		},
	],
	[
		"resolves waitForComponent once the component appears",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Awaited");
			const pending = components.waitForComponent<Enemy>(instance);

			collectionService().AddTag(instance, "Enemy");

			expectEqual(expectResolves(pending, "waitForComponent").instance, instance, "attached instance");

			module.extinguish();
		},
	],
	[
		// A component that takes another component as a constructor parameter gets it injected, and
		// its tracker will not qualify the instance until the dependency exists.
		"injects one component into another and waits for it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const ready = folder("ReadyCar");
			collectionService().AddTag(ready, "Engine");
			collectionService().AddTag(ready, "Car");

			const car = expectDefined(components.getComponent<Car>(ready), "car component");
			expectEqual(car.engine, components.getComponent<Engine>(ready), "injected component");

			// Tagging in the other order proves the tracker waits rather than failing to resolve.
			const waiting = folder("WaitingCar");
			collectionService().AddTag(waiting, "Car");
			expectEqual(components.getAllComponents<Car>().size(), 1, "cars before the dependency exists");

			collectionService().AddTag(waiting, "Engine");
			expectEqual(components.getAllComponents<Car>().size(), 2, "cars after the dependency exists");

			module.extinguish();
		},
	],
	[
		"lets a predicate reject an instance outright",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			collectionService().AddTag(folder("Rejected"), "Picky");
			expectEqual(components.getAllComponents<Picky>().size(), 0, "components the predicate rejected");

			collectionService().AddTag(folder("Chosen"), "Picky");
			expectEqual(components.getAllComponents<Picky>().size(), 1, "components the predicate accepted");

			module.extinguish();
		},
	],
	[
		"stops observing attributes when refreshAttributes is off",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Unrefreshed", { speed: 1 });
			const component = components.addComponent<Static>(instance);

			instance.SetAttribute("speed", 9);
			expectEqual(component.attributes.speed, 1, "attribute after an external change");

			module.extinguish();
		},
	],
	[
		"reports the previous value to an attribute listener",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Listened", { speed: 1 });
			const component = components.addComponent<Tagged>(instance);

			const changes = new Array<string>();
			component.onAttributeChanged("speed", (newValue, oldValue) => changes.push(`${oldValue}->${newValue}`));

			instance.SetAttribute("speed", 4);
			expectArrayEqual(changes, ["1->4"], "attribute changes");

			module.extinguish();
		},
	],
]);
