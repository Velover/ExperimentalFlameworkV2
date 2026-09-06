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

	/** An `InstanceHandle` for an instance that has not streamed in, so `Get` is empty. */
	pendingHandle: (instance: Instance) => InstanceHandle;

	/** Streams in the instance a pending handle names, resuming whatever was waiting on it. */
	streamIn: (handle: InstanceHandle) => void;
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

/** Attached to the instances the linking components below name. */
@Component({ tag: "Handler" })
class Handler extends BaseComponent<{}, Folder> {}

/**
 * Names a component on a child of its own instance tree.
 *
 * Watching, so the child arriving late re-runs the instance guard on both realms: contextual
 * streaming does not watch on a server, and the tree filling in is the case being tested.
 */
@Component({ tag: "Owner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class Owner extends BaseComponent<{}, Folder & { Core: Handler }> {}

/** The instance a missing link attribute falls back to. */
const DEFAULT_LINK_TARGET = new Instance("Folder");
DEFAULT_LINK_TARGET.Name = "DefaultLinkTarget";

/** A link attribute with a default, which stands in when the attribute was never written. */
@Component({ tag: "PointerDefault", warningTimeout: 0, defaults: { Target: DEFAULT_LINK_TARGET } })
class PointerDefault extends BaseComponent<{ Target: Folder }, Folder> {}

interface PointerAttributes {
	/** An instance-valued attribute, which is stored as an `InstanceHandle`. */
	Target: Folder;

	/** Optional, so the attribute is allowed to be missing entirely. */
	Spare?: Folder;

	/** A component-valued attribute: the instance it names has to carry that component. */
	Linked: Handler;
}

/** Names instances through its attributes rather than through its tree. */
@Component({ tag: "Pointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class Pointer extends BaseComponent<PointerAttributes, Folder> {
	public retarget(target: Folder) {
		this.attributes.Target = target;
	}

	public relink(linked: Folder) {
		this.attributes.Linked = linked;
	}

	public setSpare(spare: Folder) {
		this.attributes.Spare = spare;
	}

	public clearTarget() {
		this.attributes.Target = undefined!;
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
		.registerComponent(Handler)
		.registerComponent(Owner)
		.registerComponent(Pointer)
		.registerComponent(PointerDefault)
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

/**
 * A folder tagged `Pointer` with both required links satisfied, which most of the link cases start
 * from before breaking one of them.
 */
function pointer(name: string, target: Instance, linked: Instance) {
	const instance = folder(name);
	instance.SetAttribute("Target", new InstanceHandle(target));
	instance.SetAttribute("Linked", new InstanceHandle(linked));
	collectionService().AddTag(instance, "Pointer");

	return instance;
}

/** A folder carrying `Handler`, which is what the component links point at. */
function handlerFolder(name: string) {
	const instance = folder(name);
	collectionService().AddTag(instance, "Handler");

	return instance;
}

function collectionService() {
	return game.GetService("CollectionService");
}

export = suite("components", [
	[
		"leaves a component uncreated while a required link attribute is missing",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("MissingLinked");

			// No `Target` at all: the attribute guard has nothing to check and the link nothing to
			// resolve, so neither the tag nor `addComponent` can produce a component.
			const instance = folder("MissingAttribute");
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			expectEqual(components.getComponent<Pointer>(instance), undefined, "component with the attribute missing");
			expectThrows(() => components.addComponent<Pointer>(instance), "addComponent with the attribute missing");

			module.extinguish();
		},
	],
	[
		"rejects a link attribute that is not a handle",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("BadTypeLinked");

			const instance = folder("BadAttributeType");
			instance.SetAttribute("Target", "not a handle");
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			expectEqual(components.getComponent<Pointer>(instance), undefined, "component with a bad attribute type");

			const message = expectThrows(() => components.addComponent<Pointer>(instance), "addComponent");
			expectTrue(message.find("invalid attribute")[0] !== undefined, "message names the attribute");

			module.extinguish();
		},
	],
	[
		"rejects a handle that names an instance of the wrong class",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("WrongClassLinked");

			// `Target` is declared as a Folder, so a Part does not pass the link's guard even though
			// the attribute itself is a perfectly good handle.
			const part = new Instance("Part");
			part.Name = "NotAFolder";
			part.Parent = game.Workspace;

			const instance = folder("WrongClass");
			instance.SetAttribute("Target", new InstanceHandle(part));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			expectEqual(components.getComponent<Pointer>(instance), undefined, "component with a bad target class");
			expectThrows(() => components.addComponent<Pointer>(instance), "addComponent with a bad target class");

			module.extinguish();
		},
	],
	[
		"removes a component when a link attribute is re-pointed at the wrong class",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("RepointBadLinked");
			const instance = pointer("RepointBad", folder("RepointBadTarget"), linked);
			expectDefined(components.getComponent<Pointer>(instance), "component while the link is valid");

			const part = new Instance("Part");
			part.Name = "RepointBadPart";
			part.Parent = game.Workspace;
			instance.SetAttribute("Target", new InstanceHandle(part));

			expectEqual(components.getComponent<Pointer>(instance), undefined, "component after a bad re-point");

			// Pointed back at something valid, it comes back, the way a tag or a tree does.
			instance.SetAttribute("Target", new InstanceHandle(folder("RepointGoodTarget")));
			expectDefined(components.getComponent<Pointer>(instance), "component after pointing back at a folder");

			module.extinguish();
		},
	],
	[
		"removes a component when a required link attribute is cleared",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("ClearedLinked");
			const instance = pointer("Cleared", folder("ClearedTarget"), linked);
			expectDefined(components.getComponent<Pointer>(instance), "component while the attribute is set");

			instance.SetAttribute("Target", undefined);

			expectEqual(
				components.getComponent<Pointer>(instance),
				undefined,
				"component after the attribute was cleared",
			);

			module.extinguish();
		},
	],
	[
		"refuses to clear a required link attribute through the component",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("ClearWriteLinked");
			const target = folder("ClearWriteTarget");
			const instance = pointer("ClearWrite", target, linked);

			const component = expectDefined(components.getComponent<Pointer>(instance), "component");
			expectThrows(() => component.clearTarget(), "clearing a required link");
			expectEqual(component.attributes.Target, target, "attribute after the refused write");

			module.extinguish();
		},
	],
	[
		"fills a missing link attribute from its default and writes it back as a handle",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("DefaultedLink");
			collectionService().AddTag(instance, "PointerDefault");

			const component = expectDefined(components.getComponent<PointerDefault>(instance), "component");
			expectEqual(component.attributes.Target, DEFAULT_LINK_TARGET, "attribute holds the default instance");

			const written = instance.GetAttribute("Target");
			expectTrue(typeIs(written, "InstanceHandle"), "the default was written as a handle");
			expectEqual((written as InstanceHandle).Get(), DEFAULT_LINK_TARGET, "the handle names the default");

			module.extinguish();
		},
	],
	[
		"builds a component whose optional link has a handle that has not resolved",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("OptionalPendingLinked");
			const spare = folder("OptionalPendingSpare");

			const instance = folder("OptionalPending");
			instance.SetAttribute("Target", new InstanceHandle(folder("OptionalPendingTarget")));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			instance.SetAttribute("Spare", __harness.pendingHandle(spare));
			collectionService().AddTag(instance, "Pointer");

			// Optional, so an empty handle is not something to wait for.
			const component = expectDefined(components.getComponent<Pointer>(instance), "component");
			expectEqual(component.attributes.Spare, undefined, "optional attribute while its handle is empty");

			__harness.streamIn(instance.GetAttribute("Spare") as InstanceHandle);
			__harness.flush();

			expectEqual(component.attributes.Spare, spare, "optional attribute once its handle resolved");

			module.extinguish();
		},
	],
	[
		"adds a linked component by hand once its links resolve",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("ManualOkLinked");
			const target = folder("ManualOkTarget");

			// No tag: this component only ever exists because it was added.
			const instance = folder("ManualOk");
			instance.SetAttribute("Target", new InstanceHandle(target));
			instance.SetAttribute("Linked", new InstanceHandle(linked));

			const component = components.addComponent<Pointer>(instance);
			expectEqual(component.attributes.Target, target, "attribute resolved by hand");
			expectEqual(
				component.attributeComponents.Linked,
				components.getComponent<Handler>(linked),
				"linked component resolved by hand",
			);

			module.extinguish();
		},
	],
	[
		"waits for a child that is parented in later, then for its component",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// Neither the child nor its component exists yet: the instance guard fails first, and
			// the link only becomes the outstanding criterion once the child is there.
			const instance = folder("LateChild");
			collectionService().AddTag(instance, "Owner");
			expectEqual(components.getComponent<Owner>(instance), undefined, "owner with no child at all");

			const core = folderIn(instance, "Core");
			__harness.flush();
			expectEqual(
				components.getComponent<Owner>(instance),
				undefined,
				"owner with a child that has no component",
			);

			collectionService().AddTag(core, "Handler");
			const owner = expectDefined(components.getComponent<Owner>(instance), "owner once the child has one");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "linked child component");

			// And the child leaving takes it away again.
			core.Parent = undefined;
			__harness.flush();
			expectEqual(components.getComponent<Owner>(instance), undefined, "owner after the child was removed");

			module.extinguish();
		},
	],
	[
		"waits for the component a child of the instance tree names",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Owned");
			const core = folderIn(instance, "Core");

			collectionService().AddTag(instance, "Owner");
			expectEqual(components.getComponent<Owner>(instance), undefined, "owner before the child has a component");

			collectionService().AddTag(core, "Handler");

			const owner = expectDefined(components.getComponent<Owner>(instance), "owner once the child has one");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "linked child component");
			expectEqual(owner.instance.Core, core, "the tree still holds the instance itself");

			module.extinguish();
		},
	],
	[
		"removes a component when the component its link names goes away",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Orphaned");
			const core = folderIn(instance, "Core");

			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "Owner");
			expectDefined(components.getComponent<Owner>(instance), "owner while the link holds");

			collectionService().RemoveTag(core, "Handler");

			expectEqual(components.getComponent<Owner>(instance), undefined, "owner after the link broke");

			module.extinguish();
		},
	],
	[
		"resolves an instance-valued attribute through its handle",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const target = folder("PointerTarget");
			const linked = folder("PointerLinked");
			collectionService().AddTag(linked, "Handler");

			const instance = folder("Pointer1");
			instance.SetAttribute("Target", new InstanceHandle(target));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			const pointer = expectDefined(components.getComponent<Pointer>(instance), "component");

			// The attribute is written as a handle and read as the instance it resolves to.
			expectEqual(pointer.attributes.Target, target, "attribute holds the instance");
			expectEqual(pointer.attributes.Spare, undefined, "optional attribute with no handle");
			expectEqual(
				pointer.attributeComponents.Linked,
				components.getComponent<Handler>(linked),
				"linked component",
			);

			module.extinguish();
		},
	],
	[
		"waits for the instance an attribute names to stream in",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = folder("StreamedLinked");
			collectionService().AddTag(linked, "Handler");

			const target = folder("StreamedTarget");
			const handle = __harness.pendingHandle(target);

			const instance = folder("Pointer2");
			instance.SetAttribute("Target", handle);
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			expectEqual(components.getComponent<Pointer>(instance), undefined, "component while the handle is empty");

			__harness.streamIn(handle);
			__harness.flush();

			const pointer = expectDefined(components.getComponent<Pointer>(instance), "component once it streamed in");
			expectEqual(pointer.attributes.Target, target, "attribute holds the instance");

			module.extinguish();
		},
	],
	[
		"reports the instance to onAttributeChanged when a link is re-pointed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const target = folder("FirstTarget");
			const linked = folder("RepointLinked");
			collectionService().AddTag(linked, "Handler");

			const instance = folder("Pointer3");
			instance.SetAttribute("Target", new InstanceHandle(target));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			const pointer = expectDefined(components.getComponent<Pointer>(instance), "component");

			const changes = new Array<[Folder | undefined, Folder | undefined]>();
			pointer.onAttributeChanged("Target", (newValue, oldValue) => changes.push([newValue, oldValue]));

			const other = folder("SecondTarget");
			instance.SetAttribute("Target", new InstanceHandle(other));
			__harness.flush();

			expectEqual(pointer.attributes.Target, other, "attribute after the write");
			expectEqual(changes.size(), 1, "change count");
			expectEqual(changes[0][0], other, "new value is the instance");
			expectEqual(changes[0][1], target, "old value is the instance");

			module.extinguish();
		},
	],
	[
		"writes an instance-valued attribute back to the instance as a handle",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = folder("WriteLinked");
			collectionService().AddTag(linked, "Handler");

			const instance = folder("Pointer4");
			instance.SetAttribute("Target", new InstanceHandle(folder("WriteTarget")));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			const pointer = expectDefined(components.getComponent<Pointer>(instance), "component");

			const other = folder("WriteOther");
			pointer.retarget(other);

			// The write lands on the instance and on the component at once, rather than waiting for
			// the deferred attribute signal.
			expectEqual(pointer.attributes.Target, other, "component sees its own write");

			const written = instance.GetAttribute("Target");
			expectTrue(typeIs(written, "InstanceHandle"), "attribute is stored as a handle");
			expectEqual((written as InstanceHandle).Get(), other, "the handle names the instance");

			pointer.setSpare(other);
			expectEqual(pointer.attributes.Spare, other, "optional link after a write");

			module.extinguish();
		},
	],
	[
		"refuses a write that names an instance without the linked component",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = folder("GuardLinked");
			collectionService().AddTag(linked, "Handler");

			const instance = folder("Pointer5");
			instance.SetAttribute("Target", new InstanceHandle(folder("GuardTarget")));
			instance.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(instance, "Pointer");

			const pointer = expectDefined(components.getComponent<Pointer>(instance), "component");

			const message = expectThrows(() => pointer.relink(folder("Untagged")), "write to a component link");
			expectTrue(message.find("has no component")[0] !== undefined, "message names the missing component");
			expectEqual(pointer.attributes.Linked, linked, "attribute after the rejected write");

			module.extinguish();
		},
	],
	[
		"raises when a component is added by hand before its links resolve",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = folder("ManualLinked");
			collectionService().AddTag(linked, "Handler");

			const instance = folder("ManualPointer");
			instance.SetAttribute("Target", __harness.pendingHandle(folder("ManualTarget")));
			instance.SetAttribute("Linked", new InstanceHandle(linked));

			expectThrows(() => components.addComponent<Pointer>(instance), "addComponent with an empty handle");

			module.extinguish();
		},
	],
	[
		"refuses a link to a component the plugin does not register",
		() => {
			const plugin = ComponentPlugin.createPlugin().registerComponent(Owner).build();

			const message = expectThrows(
				() => Flamework.createModule().includePlugin(plugin).ignite(),
				"ignition with an unregistered link",
			);

			expectTrue(message.find("not registered in this plugin")[0] !== undefined, "message explains the link");
		},
	],
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
