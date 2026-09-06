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
	expectFalse,
	expectNoThrow,
	expectResolves,
	expectThrows,
	expectTrue,
	suite,
} from "../testkit";

const events = new Array<string>();

declare const __harness: {
	/** Component streaming reacts to descendant changes on a deferred task. */
	flush: () => void;

	/**
	 * Runs the callback with the tree signals deferred, delivering them in order afterwards, the
	 * way the engine does at the end of a resumption. A handler therefore runs against a tree that
	 * has finished moving, with the signals for the rest of the move still queued behind it.
	 */
	deferTree: (callback: () => void) => void;

	/**
	 * Runs the callback with the CollectionService signals deferred, delivering them in order
	 * afterwards, which is when a place announces a tag.
	 */
	deferTags: (callback: () => void) => void;

	/**
	 * Runs the callback with BindableEvent dispatch deferred -- which is what `@rbxts/signal`, and
	 * with it every component added/removed announcement, fires through. The queue is drained until
	 * it empties, so a place that would never settle raises here instead of running forever.
	 */
	deferSignals: (callback: () => void) => void;

	/** Everything `warn` has been called with since the last `clearWarnings`. */
	warnings: () => string[];
	clearWarnings: () => void;

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

	public setSpeed(speed: number) {
		this.attributes.speed = speed;
	}

	public accelerate() {
		this.attributes.speed += 1;
	}

	/** The write a cast let through: the value is not the type the attribute is declared as. */
	public misassign(value: string) {
		this.attributes.speed = value as unknown as number;
	}

	/** The same mistake in its other shape: a required attribute written away entirely. */
	public clearSpeed() {
		this.attributes.speed = undefined as unknown as number;
	}

	public rename(label?: string) {
		this.attributes.label = label;
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

/** Declares a tree of its own, so the structure it needs is part of the guard on every link to it. */
@Component({ tag: "Rig", warningTimeout: 0 })
class Rig extends BaseComponent<{}, Folder & { Root: Folder }> {}

/** The same tree, watched, so the guard on a link to it passes once the tree has filled in. */
@Component({ tag: "LateRig", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class LateRig extends BaseComponent<{}, Folder & { Root: Folder }> {}

/** Points at a `LateRig` through an attribute, so the link's guard fails until that tree arrives. */
@Component({
	tag: "LateRigOwner",
	warningTimeout: 0,
	attributeWarningTimeout: 0,
	streamingMode: ComponentStreamingMode.Watching,
})
class LateRigOwner extends BaseComponent<{ Rigged: LateRig }, Folder> {}

/**
 * Declares a plain `Folder` but demands a `Root` child through a guard of its own, so a link to it
 * carries none of that structure: the link's guard is the declared `Folder` and nothing more.
 */
@Component({
	tag: "Strict",
	warningTimeout: 0,
	streamingMode: ComponentStreamingMode.Disabled,
	instanceGuard: (value): value is Folder => typeIs(value, "Instance") && value.FindFirstChild("Root") !== undefined,
})
class Strict extends BaseComponent<{}, Folder> {}

/** Links to `Strict`, which is how that component's tracker gets an entry before its tag arrives. */
@Component({ tag: "StrictOwner", warningTimeout: 0, attributeWarningTimeout: 0 })
class StrictOwner extends BaseComponent<{ Linked: Strict }, Folder> {}

/** A plain instance link whose guard asks for a tree, with no component to report it filling in. */
@Component({ tag: "Rooted", warningTimeout: 0, attributeWarningTimeout: 0 })
class Rooted extends BaseComponent<{ Target: Folder & { Root: Folder } }, Folder> {}

/** A link attribute on a component that tracks no attributes at all. */
@Component({ tag: "FrozenPointer", warningTimeout: 0, attributeWarningTimeout: 0, refreshAttributes: false })
class FrozenPointer extends BaseComponent<{ Target: Folder }, Folder> {}

/** Links to another component of its own kind, so two of them can be pointed at each other. */
@Component({ tag: "Twin", warningTimeout: 0, attributeWarningTimeout: 0 })
class Twin extends BaseComponent<{ Partner?: Twin }, Folder> {
	public destroyCount = 0;

	public destroy() {
		this.destroyCount += 1;
		super.destroy();
	}
}

/** A second component for the same instances, to show a link picks the one it names. */
@Component({ tag: "Extra" })
class Extra extends BaseComponent<{}, Folder> {}

/** A component hierarchy, to show which of the two a link to the parent accepts. */
@Component({ tag: "BaseHandler" })
class BaseHandler extends BaseComponent<{}, Folder> {}

@Component({ tag: "DerivedHandler" })
class DerivedHandler extends BaseHandler {}

/** Links to the parent class of a hierarchy. */
@Component({ tag: "BaseOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class BaseOwner extends BaseComponent<{}, Folder & { Core: BaseHandler }> {}

/** Links through a tree it never re-checks, so the two kinds of change can be told apart. */
@Component({ tag: "FrozenOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Disabled })
class FrozenOwner extends BaseComponent<{}, Folder & { Core: Handler }> {}

/** Only ever built under an instance named `Chosen`, which a link has to weigh as well. */
@Component({ tag: "Choosy", predicate: (instance) => instance.Parent?.Name === "Chosen" })
class Choosy extends BaseComponent<{}, Folder> {}

/** Links to a component a predicate can refuse, which no amount of tagging then satisfies. */
@Component({ tag: "ChoosyOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class ChoosyOwner extends BaseComponent<{}, Folder & { Core: Choosy }> {}

/** An optional child link, so the component is built with or without the child it names. */
@Component({ tag: "LooseOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class LooseOwner extends BaseComponent<{}, Folder & { Core?: Handler }> {}

/** A required child link alongside an optional one, which is what churns the tree the most. */
@Component({ tag: "PairOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class PairOwner extends BaseComponent<{}, Folder & { Core: Handler; Aux?: Handler }> {}

/**
 * A child link that is read once beside an attribute link that is followed forever.
 *
 * The attribute can take the component down and ask for it back long after the tree stopped
 * holding the child, which is the rebuild the frozen child link has no signal to correct.
 */
@Component({
	tag: "FrozenPair",
	warningTimeout: 0,
	attributeWarningTimeout: 0,
	streamingMode: ComponentStreamingMode.Disabled,
})
class FrozenPair extends BaseComponent<{ Target: Folder & { Root: Folder } }, Folder & { Core: Handler }> {}

/** Warns almost at once, so a spec can wait for the warning rather than the default five seconds. */
@Component({ tag: "Impatient", warningTimeout: 0.1 })
class Impatient extends BaseComponent<{}, Part> {}

/** Links to `Impatient`, so that tracker exists before anything is waiting on it. */
@Component({ tag: "ImpatientOwner", warningTimeout: 0 })
class ImpatientOwner extends BaseComponent<{}, Folder & { Core: Impatient }> {}

/** Warns almost at once, and is reached as a dependency rather than through a link. */
@Component({ tag: "Ignition", warningTimeout: 0.1 })
class Ignition extends BaseComponent<{}, Folder> {}

/** Depends on `Ignition`, so its tracker subscribes to Ignition's on the same instance. */
@Component({ tag: "Starter", warningTimeout: 0 })
class Starter extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly ignition: Ignition,
	) {
		super(metadata);
	}
}

/** Links to `Starter`, which is how a dependency is reached by a listener that only watches. */
@Component({ tag: "StarterOwner", warningTimeout: 0 })
class StarterOwner extends BaseComponent<{}, Folder & { Core: Starter }> {}

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

/**
 * The same, optional. An optional attribute's guard accepts a missing one, so this is the case
 * where nothing else would ever write the default to the instance.
 */
@Component({ tag: "SpareDefault", warningTimeout: 0, defaults: { Spare: DEFAULT_LINK_TARGET } })
class SpareDefault extends BaseComponent<{ Spare?: Folder }, Folder> {
	public clearSpare() {
		this.attributes.Spare = undefined;
	}
}

interface PointerAttributes {
	/** An instance-valued attribute, which is stored as an `InstanceHandle`. */
	Target: Folder;

	/** Optional, so the attribute is allowed to be missing entirely. */
	Spare?: Folder;

	/** A component-valued attribute: the instance it names has to carry that component. */
	Linked: Handler;

	/** Optional, and the component it names needs a tree of its own. */
	Rigged?: Rig;
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

	/**
	 * The resolved attribute type already demands the tree, so the cast is what a mistake looks
	 * like here -- and what leaves the runtime guard as the only thing checking.
	 */
	public setRigged(rigged: Folder) {
		this.attributes.Rigged = rigged as Folder & { Root: Folder };
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
		.registerComponent(SpareDefault)
		.registerComponent(Rig)
		.registerComponent(LateRig)
		.registerComponent(LateRigOwner)
		.registerComponent(Strict)
		.registerComponent(StrictOwner)
		.registerComponent(Rooted)
		.registerComponent(FrozenPointer)
		.registerComponent(Twin)
		.registerComponent(Extra)
		.registerComponent(BaseHandler)
		.registerComponent(DerivedHandler)
		.registerComponent(BaseOwner)
		.registerComponent(FrozenOwner)
		.registerComponent(Choosy)
		.registerComponent(ChoosyOwner)
		.registerComponent(LooseOwner)
		.registerComponent(PairOwner)
		.registerComponent(FrozenPair)
		.registerComponent(Impatient)
		.registerComponent(ImpatientOwner)
		.registerComponent(Ignition)
		.registerComponent(Starter)
		.registerComponent(StarterOwner)
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
		"leaves a component down when a rebuild is asked for by the first of two queued child signals",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("QueuedPair");
			const core = addCore(instance);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "PairOwner");
			expectDefined(components.getComponent<PairOwner>(instance), "component");

			const aux = new Instance("Folder");
			aux.Name = "Aux";
			collectionService().AddTag(aux, "Handler");

			const elsewhere = folder("QueuedPairElsewhere");

			// Both moves happen in one resumption, so the optional child arriving is delivered
			// before the required one leaving. The optional link takes the component down and asks
			// for it straight back, while the required link's criterion still says a `Core` is
			// there and the tree no longer holds one: the rebuild must not trust it and raise out
			// of a handler that is only there because something else moved.
			expectNoThrow(() => {
				__harness.deferTree(() => {
					aux.Parent = instance;
					core.Parent = elsewhere;
				});
			}, "delivering the queued child signals");
			__harness.flush();

			expectEqual(
				components.getComponent<PairOwner>(instance),
				undefined,
				"component after the required child left",
			);

			// And it comes back once the tree really does hold a `Core` again.
			core.Parent = instance;
			__harness.flush();

			const rebuilt = expectDefined(
				components.getComponent<PairOwner>(instance),
				"component once the required child returned",
			);
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(core), "the required link");
			expectEqual(rebuilt.childComponents.Aux, components.getComponent<Handler>(aux), "the optional link");

			instance.Destroy();
			core.Destroy();
			aux.Destroy();
			elsewhere.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a component down when a link attribute rebuilds it after its frozen tree broke",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const good = folder("FrozenPairTarget");
			folderIn(good, "Root");

			const instance = folder("FrozenPairOwner");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Handler");
			instance.SetAttribute("Target", new InstanceHandle(good));
			collectionService().AddTag(instance, "FrozenPair");
			expectDefined(components.getComponent<FrozenPair>(instance), "component");

			// Streaming is disabled, so the child link is read once: the component is kept. The child
			// moves rather than leaving the DataModel, which would announce its tag as gone and take
			// the component the link names -- and with it this component -- whatever the mode.
			core.Parent = folder("FrozenPairElsewhere");
			__harness.flush();
			expectDefined(components.getComponent<FrozenPair>(instance), "component after the frozen tree broke");

			// The attribute is followed whatever the streaming mode, so re-pointing it at something
			// its guard refuses takes the component down.
			const bare = folder("FrozenPairBare");
			instance.SetAttribute("Target", new InstanceHandle(bare));
			expectEqual(components.getComponent<FrozenPair>(instance), undefined, "component after a bad re-point");

			// Pointing it back asks for the component again, and a fresh build reads the tree as it
			// is now: there is no `Core` left, so it stays down rather than raising out of the
			// write that asked for it.
			expectNoThrow(() => {
				instance.SetAttribute("Target", new InstanceHandle(good));
			}, "pointing the attribute back at a target its guard accepts");

			expectEqual(
				components.getComponent<FrozenPair>(instance),
				undefined,
				"component the tree can no longer support",
			);

			// The criterion is read rather than latched, so the component builds again once the
			// tree does hold a `Core` and something asks for it.
			core.Parent = instance;
			instance.SetAttribute("Target", new InstanceHandle(bare));
			instance.SetAttribute("Target", new InstanceHandle(good));

			expectDefined(components.getComponent<FrozenPair>(instance), "component once the tree was whole again");

			instance.Destroy();
			core.Destroy();
			good.Destroy();
			bare.Destroy();
			module.extinguish();
		},
	],
	[
		"keeps a required link watching after an optional one has come and gone",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("ProbeSeq");
			const core = addCore(instance);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "PairOwner");
			expectDefined(components.getComponent<PairOwner>(instance), "component");

			// The optional child arrives, then leaves, each rebuilding the component.
			const aux = new Instance("Folder");
			aux.Name = "Aux";
			collectionService().AddTag(aux, "Handler");
			aux.Parent = instance;
			__harness.flush();
			expectDefined(components.getComponent<PairOwner>(instance), "component with the optional child");

			aux.Parent = folder("ProbeSeqElsewhere");
			__harness.flush();
			expectDefined(components.getComponent<PairOwner>(instance), "component after the optional child left");

			// Now the required link's component goes: this has to take the owner down.
			collectionService().RemoveTag(core, "Handler");
			__harness.flush();

			expectEqual(
				components.getComponent<PairOwner>(instance),
				undefined,
				"component after the required link's component went",
			);

			module.extinguish();
		},
	],
	[
		"keeps a component when a plain attribute is changed to a value its guard rejects",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BadExternal", { speed: 3 });
			collectionService().AddTag(instance, "Tagged");
			const component = expectDefined(components.getComponent<Tagged>(instance), "component");

			// A plain attribute guard is a construction check, not a criterion: a bad change is
			// filtered out so a handler never sees it, and the component carries on.
			instance.SetAttribute("speed", "nope");

			expectDefined(components.getComponent<Tagged>(instance), "component after a bad attribute change");
			expectEqual(component.attributes.speed, 3, "attribute after a bad change");

			module.extinguish();
		},
	],
	[
		"keeps a component whose tree breaks when streaming is disabled",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("FrozenTree");
			const core = addCore(instance);
			collectionService().AddTag(instance, "Frozen");
			expectDefined(components.getComponent<Frozen>(instance), "component while the tree holds");

			core.Parent = undefined;
			__harness.flush();

			expectEqual(
				components.getComponent<Frozen>(instance) !== undefined,
				true,
				"component after the tree broke with streaming disabled",
			);

			module.extinguish();
		},
	],
	[
		"removes a component when the component a link names goes, whatever the streaming mode",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("FrozenLink");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "FrozenOwner");
			expectDefined(components.getComponent<FrozenOwner>(instance), "component while the link holds");

			// The tree is never re-checked under `Disabled`, but a linked component being destroyed
			// is a lifecycle event rather than the tree filling in, so it is always noticed.
			collectionService().RemoveTag(core, "Handler");

			expectEqual(components.getComponent<FrozenOwner>(instance), undefined, "component after the link broke");

			module.extinguish();
		},
	],
	[
		"keeps a linked child that moves away when streaming is disabled, and loses one that is unparented",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("FrozenChild");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "FrozenOwner");

			const owner = expectDefined(components.getComponent<FrozenOwner>(instance), "component");

			// A child link is part of the instance tree, so `Disabled` reads it once and keeps the
			// answer, exactly as it does for the instance guard. A child moved elsewhere in the
			// DataModel keeps its tag, and with it the component the link is holding.
			core.Parent = folder("FrozenChildElsewhere");
			__harness.flush();

			expectDefined(components.getComponent<FrozenOwner>(instance), "component after the child moved away");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "the child it resolved to");

			// Leaving the DataModel is not the tree moving: CollectionService announces the tag as
			// gone, so `Handler` is removed, and a link losing the component it names takes its own
			// component down whatever the streaming mode.
			core.Parent = undefined;
			__harness.flush();

			expectEqual(
				components.getComponent<FrozenOwner>(instance),
				undefined,
				"component after the child left the DataModel",
			);

			instance.Destroy();
			core.Destroy();
			module.extinguish();
		},
	],
	[
		"builds a component when a tagged instance enters the DataModel, and drops it when it leaves",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = new Instance("Folder");
			instance.Name = "LateParented";
			collectionService().AddTag(instance, "Handler");

			// Tagging something the DataModel does not hold announces nothing at all.
			expectEqual(components.getComponents<Handler>(instance).size(), 0, "components while unparented");

			// Parenting it in is the announcement, so the component is built without anyone asking:
			// `getComponents` reads what is attached rather than constructing one.
			instance.Parent = game.Workspace;
			expectDefined(components.getComponents<Handler>(instance)[0], "component once it entered the DataModel");

			// Leaving announces it as gone again, with the tag still in place: it is the
			// announcement ancestry drives, not the tag itself.
			instance.Parent = undefined;
			expectEqual(components.getComponents<Handler>(instance).size(), 0, "components after it left again");
			expectTrue(collectionService().HasTag(instance, "Handler"), "the tag the instance kept");

			// And parenting it back in builds one again, because the tag never went anywhere.
			instance.Parent = game.Workspace;
			expectDefined(components.getComponents<Handler>(instance)[0], "component once it was parented back in");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"removes a component from a descendant when the tree around it leaves the DataModel",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const removed = new Array<string>();
			components.onComponentRemoved<Handler>((_component, instance) => removed.push(instance.Name));

			const pooled = folder("PooledTree");
			const core = folderIn(pooled, "PooledCore");
			collectionService().AddTag(core, "Handler");

			expectDefined(components.getComponent<Handler>(core), "component while the tree is in the DataModel");

			// Pooling by unparenting rather than destroying. The descendant left the DataModel with
			// its ancestor, so its tag is announced as gone exactly as the ancestor's own is: what
			// takes a component down is leaving the DataModel, not losing a parent.
			pooled.Parent = undefined;

			expectEqual(components.getComponents<Handler>(core).size(), 0, "components after the unparenting");
			expectArrayEqual(removed, ["PooledCore"], "removal notifications");

			// And nothing builds one out there either: a descendant of a pooled tree still has a
			// parent, which is why asking it by hand used to construct one that nothing would ever
			// take away again.
			expectEqual(components.getComponent<Handler>(core), undefined, "getComponent on the pooled descendant");
			expectEqual(components.getComponents<Handler>(core).size(), 0, "components getComponent left behind");

			// Parented back in, the tag is announced again and the component comes back with it.
			pooled.Parent = game.Workspace;
			expectDefined(components.getComponent<Handler>(core), "component once the tree was parented back in");

			pooled.Destroy();
			module.extinguish();
		},
	],
	[
		"announces nothing for a tag applied inside a tree the DataModel does not hold",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// A template being assembled before it is dropped in. The tag lands on a descendant of a
			// tree nothing holds, which announces nothing at all -- not only the parentless instance
			// itself.
			const template = new Instance("Folder");
			template.Name = "DetachedTemplate";

			const core = folderIn(template, "DetachedCore");
			collectionService().AddTag(core, "Handler");

			expectEqual(components.getComponents<Handler>(core).size(), 0, "components while the tree is detached");
			expectEqual(components.getComponent<Handler>(core), undefined, "getComponent on the detached descendant");

			// A module igniting now reads the tagged instances out of the DataModel, and this tree
			// is not in it.
			const late = createComponentModule();
			const lateComponents = late.resolveDependency<Components>();
			expectEqual(lateComponents.getComponents<Handler>(core).size(), 0, "components a later module built");
			late.extinguish();

			// Dropping the tree in is the announcement.
			template.Parent = game.Workspace;
			expectDefined(components.getComponent<Handler>(core), "component once the tree entered the DataModel");

			template.Destroy();
			module.extinguish();
		},
	],
	[
		"tears a destroyed instance down in the order a place does",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const owner = folder("DestroyOrder");
			const core = folderIn(owner, "Core");
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(owner, "Owner");

			expectDefined(components.getComponent<Owner>(owner), "component");

			const fired = new Array<string>();
			const destroying = owner.Destroying.Connect(() => fired.push(`destroying:${owner.GetChildren().size()}`));
			const childRemoved = owner.ChildRemoved.Connect(() => fired.push("childRemoved"));
			const descendantRemoving = owner.DescendantRemoving.Connect(() => fired.push("descendantRemoving"));

			const removed = new Array<string>();
			components.onComponentRemoved<Owner>((_component, instance) => removed.push(`Owner:${instance.Name}`));
			components.onComponentRemoved<Handler>((_component, instance) => removed.push(`Handler:${instance.Name}`));

			owner.Destroy();

			destroying.Disconnect();
			childRemoved.Disconnect();
			descendantRemoving.Disconnect();

			// `Destroying` runs while the tree still stands, and every connection on the instance is
			// dropped before its children come apart -- so a component's own `ChildRemoved` handler
			// never runs against a half-dismantled tree, which is a state no place ever shows it.
			expectArrayEqual(fired, ["destroying:1"], "signals the destroyed instance fired");

			// Both components still go, because it is leaving the DataModel that announces their
			// tags as gone: the owner's on the way out, and the child's with it.
			expectArrayEqual(removed, ["Owner:DestroyOrder", "Handler:Core"], "removal notifications");
			expectEqual(components.getComponents<Handler>(core).size(), 0, "components left on the child");
			expectEqual(components.getComponents<Owner>(owner).size(), 0, "components left on the owner");

			module.extinguish();
		},
	],
	[
		"builds a component whose link names a component the same resumption would build",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("EagerLinkOwner");
			const core = folderIn(instance, "Core");

			// Tags are announced at the end of the resumption, so this is the tree as a spawner
			// leaves it: both instances tagged, neither component built yet. `getComponent` builds
			// what the tag is about to build, links included -- the link names a component this very
			// call constructs, which is what the tracked path and `resolveLinks` already answer.
			let built: Owner | undefined;

			__harness.deferTags(() => {
				collectionService().AddTag(core, "Handler");
				collectionService().AddTag(instance, "Owner");

				built = expectDefined(components.getComponent<Owner>(instance), "component inside the resumption");

				const handler = expectDefined(components.getComponent<Handler>(core), "the linked component it built");
				expectEqual(built.childComponents.Core, handler, "the link it resolved");
			});

			// The announcements arrive afterwards and find the components already there, rather
			// than building a second pair on top of them.
			expectEqual(components.getComponent<Owner>(instance), built, "component once the tags were announced");

			// The same thing in the shape it usually arrives in: a tagged template cloned in and
			// asked for its component before the announcements land.
			const template = new Instance("Folder");
			template.Name = "SpawnTemplate";
			collectionService().AddTag(folderIn(template, "Core"), "Handler");
			collectionService().AddTag(template, "Owner");

			expectEqual(components.getComponents<Owner>(template).size(), 0, "components for the template itself");

			const spawned = template.Clone();
			spawned.Name = "Spawned";

			__harness.deferTags(() => {
				spawned.Parent = game.Workspace;
				expectDefined(components.getComponent<Owner>(spawned), "component for the clone");
			});

			instance.Destroy();
			spawned.Destroy();
			template.Destroy();
			module.extinguish();
		},
	],
	[
		"writes an optional link attribute's default to the instance, and clears it back to nothing",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("DefaultedSpare");
			collectionService().AddTag(instance, "SpareDefault");

			const component = expectDefined(components.getComponent<SpareDefault>(instance), "component");
			expectEqual(component.attributes.Spare, DEFAULT_LINK_TARGET, "attribute holds the default instance");

			// The default is written to the instance as well, exactly as a required link's is. An
			// optional guard accepts a missing attribute, which is not a reason to leave the
			// instance out of step with the component reading it.
			const written = instance.GetAttribute("Spare");
			expectTrue(typeIs(written, "InstanceHandle"), "the default was written as a handle");
			expectEqual((written as InstanceHandle).Get(), DEFAULT_LINK_TARGET, "the handle names the default");

			// And clearing an optional link clears it: a default stands in for an attribute the
			// component was built without, not for one it has just written away.
			component.clearSpare();

			expectEqual(component.attributes.Spare, undefined, "attribute after it was cleared");
			expectEqual(instance.GetAttribute("Spare"), undefined, "the attribute on the instance after the clear");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"settles a link cycle whose removal is announced after the component was rebuilt",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const first = folder("DeferredTwinA");
			const second = folder("DeferredTwinB");
			collectionService().AddTag(first, "Twin");
			collectionService().AddTag(second, "Twin");

			expectDefined(components.getComponent<Twin>(first), "first component");
			expectDefined(components.getComponent<Twin>(second), "second component");

			first.SetAttribute("Partner", new InstanceHandle(second));
			second.SetAttribute("Partner", new InstanceHandle(first));
			__harness.flush();

			// A component's removal is announced through a BindableEvent, which the engine defers:
			// the handler runs after everything the resumption went on to do, and by then this
			// instance has been asked for its component again and carries a new one. Taking the
			// other half of the cycle down for a component that has already been replaced is what
			// makes the rebuild that follows take this half down again, without end.
			expectNoThrow(() => {
				__harness.deferSignals(() => {
					components.removeComponent<Twin>(first);
					expectDefined(components.getComponent<Twin>(first), "component rebuilt in the same resumption");
				});
			}, "the deferred announcements");

			const rebuilt = expectDefined(components.getComponent<Twin>(first), "first component after the drain");
			const partner = expectDefined(components.getComponent<Twin>(second), "second component after the drain");
			expectEqual(partner.attributeComponents.Partner, rebuilt, "the link the surviving component holds");
			expectEqual(rebuilt.attributeComponents.Partner, partner, "the link the rebuilt component holds");

			first.Destroy();
			second.Destroy();
			module.extinguish();
		},
	],
	[
		"rebuilds a component when its linked child is swapped without ever going missing",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("SwappedInPlace");
			const first = folderIn(instance, "Core");
			collectionService().AddTag(first, "Handler");
			collectionService().AddTag(instance, "Owner");

			const owner = expectDefined(components.getComponent<Owner>(instance), "component");

			// The replacement is parented before the old child leaves, so the link never sees a
			// moment with no child at all -- which is how a swap looks through deferred signals. The
			// old child moves rather than leaving the DataModel, which would announce its tag as
			// gone and take the component down for a reason that has nothing to do with the tree.
			const second = folderIn(instance, "Core");
			collectionService().AddTag(second, "Handler");
			first.Parent = folder("SwappedInPlaceElsewhere");
			__harness.flush();

			const rebuilt = expectDefined(components.getComponent<Owner>(instance), "component after the swap");
			expectTrue(rebuilt !== owner, "the component was rebuilt rather than left holding the old child");
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(second), "the new child");

			module.extinguish();
		},
	],
	[
		"resolves a link to the component it names, not to whatever else is on the instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Crowded");
			const core = folderIn(instance, "Core");

			// Two components on one child: the link names one of them and gets that one.
			collectionService().AddTag(core, "Extra");
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "Owner");

			const owner = expectDefined(components.getComponent<Owner>(instance), "component");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "the named component");
			expectTrue(components.getComponent<Extra>(core) !== undefined, "the other component is still there");

			// And losing the one it does not name changes nothing.
			collectionService().RemoveTag(core, "Extra");
			expectDefined(components.getComponent<Owner>(instance), "component after the other one went");

			module.extinguish();
		},
	],
	[
		"names a component exactly: a subclass does not stand in for the class a link names",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Subclassed");
			const core = folderIn(instance, "Core");

			// `DerivedHandler` is a `BaseHandler`, but a link resolves the class it names and
			// nothing else, so this is not the component the link is waiting for.
			collectionService().AddTag(core, "DerivedHandler");
			collectionService().AddTag(instance, "BaseOwner");
			expectEqual(components.getComponent<BaseOwner>(instance), undefined, "component with only the subclass");

			collectionService().AddTag(core, "BaseHandler");
			const owner = expectDefined(components.getComponent<BaseOwner>(instance), "component with the class named");
			expectEqual(owner.childComponents.Core, components.getComponent<BaseHandler>(core), "the named component");

			module.extinguish();
		},
	],
	[
		"keeps a component when a subclass of the component its link names is removed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("SubclassRemoved");
			const core = folderIn(instance, "Core");

			// Both are on the child, and a component announces its removal under every id it
			// inherits: the link names `BaseHandler`, which is still attached.
			collectionService().AddTag(core, "BaseHandler");
			collectionService().AddTag(core, "DerivedHandler");
			collectionService().AddTag(instance, "BaseOwner");

			const owner = expectDefined(components.getComponent<BaseOwner>(instance), "component");

			collectionService().RemoveTag(core, "DerivedHandler");

			expectEqual(components.getComponent<DerivedHandler>(core), undefined, "the subclass after its tag went");
			expectEqual(components.getComponent<BaseOwner>(instance), owner, "component after the subclass went");

			module.extinguish();
		},
	],
	[
		"waits for a linked component a predicate refuses instead of building one that throws",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// `Choosy` is only built under an instance named `Chosen`, so tagging the child is not
			// enough here: the link has to weigh everything `getComponent` weighs.
			const refused = folder("Refused");
			const refusedCore = folderIn(refused, "Core");
			collectionService().AddTag(refusedCore, "Choosy");
			collectionService().AddTag(refused, "ChoosyOwner");

			expectEqual(components.getComponent<Choosy>(refusedCore), undefined, "the refused component");
			expectEqual(components.getComponent<ChoosyOwner>(refused), undefined, "component whose link is refused");

			const chosen = folder("Chosen");
			const chosenCore = folderIn(chosen, "Core");
			collectionService().AddTag(chosenCore, "Choosy");
			collectionService().AddTag(chosen, "ChoosyOwner");

			const owner = expectDefined(components.getComponent<ChoosyOwner>(chosen), "component whose link is met");
			expectEqual(
				owner.childComponents.Core,
				components.getComponent<Choosy>(chosenCore),
				"the linked component",
			);

			module.extinguish();
		},
	],
	[
		"rebuilds a component when the child of an optional link arrives",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("OptionalArrives");
			collectionService().AddTag(instance, "LooseOwner");

			const built = expectDefined(components.getComponent<LooseOwner>(instance), "component without the child");
			expectEqual(built.childComponents.Core, undefined, "the link before the child arrived");

			// Tagged before it is parented, the way a template is tagged and then dropped in.
			const core = new Instance("Folder");
			core.Name = "Core";
			collectionService().AddTag(core, "Handler");
			core.Parent = instance;
			__harness.flush();

			const rebuilt = expectDefined(components.getComponent<LooseOwner>(instance), "component after it arrived");
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(core), "the child's component");

			module.extinguish();
		},
	],
	[
		"rebuilds a component when the child of an optional link leaves the tree",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("OptionalLeaves");
			const core = addCore(instance);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(instance, "LooseOwner");

			const built = expectDefined(components.getComponent<LooseOwner>(instance), "component with the child");
			const handler = expectDefined(components.getComponent<Handler>(core), "the child's component");
			expectEqual(built.childComponents.Core, handler, "the link while the child is in the tree");

			// Moved rather than destroyed, so the component on it lives on: a link is about the
			// tree, and this tree no longer holds it.
			core.Parent = folder("Elsewhere");
			__harness.flush();

			expectEqual(components.getComponent<Handler>(core), handler, "the child's component after it moved");

			const rebuilt = expectDefined(components.getComponent<LooseOwner>(instance), "component after it left");
			expectEqual(rebuilt.childComponents.Core, undefined, "the link after the child left the tree");

			module.extinguish();
		},
	],
	[
		"warns for an instance whose tracker a link created before anything waited on it",
		() => {
			const module = createComponentModule();

			const instance = folder("ObservedFirst");
			const core = folderIn(instance, "Core"); // a Folder, so `Impatient` never qualifies

			// The link watches the child without waiting for it, which is what creates the tracker.
			collectionService().AddTag(instance, "ImpatientOwner");

			__harness.clearWarnings();
			collectionService().AddTag(core, "Impatient");
			task.wait(0.3);

			expectTrue(
				__harness.warnings().some((line) => line.find("Impatient")[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			// Every other spec leaves its instances behind, which this one cannot: an instance that
			// can never qualify arms a warning of its own in every module a later spec builds, and
			// enough of those pending timers stall the Lune runner long after the suite is done.
			instance.Destroy();

			module.extinguish();
		},
	],
	[
		"drops the warning again when the tag goes while a link is still watching",
		() => {
			const module = createComponentModule();

			const instance = folder("UntaggedAgain");
			const core = folderIn(instance, "Core"); // a Folder, so `Impatient` never qualifies

			// The link creates the tracker entry, watching rather than waiting.
			collectionService().AddTag(instance, "ImpatientOwner");

			__harness.clearWarnings();
			collectionService().AddTag(core, "Impatient");
			collectionService().RemoveTag(core, "Impatient");
			task.wait(0.3);

			// The tag armed the warning and then took itself away. The link holding the entry open
			// is watching rather than waiting, so there is nobody left for the warning to be about.
			expectFalse(
				__harness.warnings().some((line) => line.find("Impatient")[0] !== undefined),
				`warnings after the tag went: ${__harness.warnings().join(" | ")}`,
			);

			// And the entry has not spent its one warning: tagging it again waits again.
			__harness.clearWarnings();
			collectionService().AddTag(core, "Impatient");
			task.wait(0.3);

			expectTrue(
				__harness.warnings().some((line) => line.find("Impatient")[0] !== undefined),
				`warnings after tagging again: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves the dependencies of a component a link only watches unwarned",
		() => {
			const module = createComponentModule();

			const instance = folder("WatchedDependency");
			folderIn(instance, "Core"); // never tagged with anything

			__harness.clearWarnings();

			// The link watches `Core` for `Starter`, whose own tracker watches it for `Ignition`.
			// Neither is being waited for: nothing on that instance is tagged with either.
			collectionService().AddTag(instance, "StarterOwner");
			task.wait(0.3);

			expectFalse(
				__harness.warnings().some((line) => line.find("Ignition")[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a link unmet when the component it names sits under a blocked ancestor",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// Tagged before the link ever looks at it.
			const early = folderIn(ReplicatedStorage, "BlockedEarly");
			collectionService().AddTag(early, "Handler");
			const earlyOwner = pointer("BlockedOwnerEarly", folder("BlockedTargetEarly"), early);

			expectEqual(
				components.getComponent<Pointer>(earlyOwner),
				undefined,
				"component linked to an instance under a blocked ancestor",
			);

			// And the other way round: the link watches the instance first, the tag arrives after.
			const late = folderIn(ReplicatedStorage, "BlockedLate");
			const lateOwner = pointer("BlockedOwnerLate", folder("BlockedTargetLate"), late);
			collectionService().AddTag(late, "Handler");

			expectEqual(
				components.getComponent<Pointer>(lateOwner),
				undefined,
				"component linked to an instance tagged after the link watched it",
			);

			// Neither order built the linked component, which is what the ancestor lists are for.
			// Counted with `getComponents`, which looks rather than constructs the way `getComponent`
			// would.
			expectEqual(components.getComponents<Handler>(early).size(), 0, "components on the instance tagged first");
			expectEqual(components.getComponents<Handler>(late).size(), 0, "components on the instance tagged later");

			earlyOwner.Destroy();
			lateOwner.Destroy();
			early.Destroy();
			late.Destroy();
			module.extinguish();
		},
	],
	[
		"answers getComponent for a blocked instance the same whether or not a link watches it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const watched = folderIn(ReplicatedStorage, "WatchedBlocked");
			const owner = pointer("WatchedBlockedOwner", folder("WatchedBlockedTarget"), watched);
			collectionService().AddTag(watched, "Handler");

			const control = folderIn(ReplicatedStorage, "UnwatchedBlocked");
			collectionService().AddTag(control, "Handler");

			// `getComponent` builds a component for a tagged instance whatever its ancestry, and a
			// link watching that instance is not allowed to change the answer it gives.
			expectDefined(components.getComponent<Handler>(control), "component for an instance nothing watches");
			const handler = expectDefined(
				components.getComponent<Handler>(watched),
				"component for an instance a link watches",
			);

			// Once it is there, the link is met by it: the ancestor lists gate construction, not
			// what a link accepts from an instance that already carries the component.
			__harness.flush();
			const built = expectDefined(components.getComponent<Pointer>(owner), "component whose link is now met");
			expectEqual(built.attributeComponents.Linked, handler, "the link's component");

			owner.Destroy();
			watched.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"waits for a link attribute whose guard only passes once the target's tree fills in",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The guard on a link to `LateRig` carries that component's tree, so a folder without a
			// `Root` fails it. Nothing about the attribute changes afterwards: the tree does.
			const rig = folder("LateRigTarget");
			const owner = folder("LateRigOwner1");
			owner.SetAttribute("Rigged", new InstanceHandle(rig));
			collectionService().AddTag(owner, "LateRigOwner");

			expectEqual(
				components.getComponent<LateRigOwner>(owner),
				undefined,
				"owner while the target has no tree of its own",
			);

			folderIn(rig, "Root");
			collectionService().AddTag(rig, "LateRig");
			__harness.flush();

			expectDefined(components.getComponent<LateRig>(rig), "the linked component once its tree is complete");

			const built = expectDefined(
				components.getComponent<LateRigOwner>(owner),
				"owner once the link's guard passes",
			);
			expectEqual(built.attributes.Rigged, rig, "the attribute the link resolved to");
			expectEqual(
				built.attributeComponents.Rigged,
				components.getComponent<LateRig>(rig),
				"the component the link resolved to",
			);

			owner.Destroy();
			rig.Destroy();
			module.extinguish();
		},
	],
	[
		"follows a plain link attribute's guard as the instance it names gains and loses its tree",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// Nothing but the guard here: no component names the target, so its tree is the only
			// thing there is to watch.
			const target = folder("RootedTarget");
			const instance = folder("Rooted1");
			instance.SetAttribute("Target", new InstanceHandle(target));
			collectionService().AddTag(instance, "Rooted");

			expectEqual(components.getComponent<Rooted>(instance), undefined, "component while the target is bare");

			const root = folderIn(target, "Root");
			__harness.flush();

			expectDefined(components.getComponent<Rooted>(instance), "component once the target's tree is complete");

			// The guard is a criterion, so it holds in both directions.
			root.Destroy();
			__harness.flush();

			expectEqual(
				components.getComponent<Rooted>(instance),
				undefined,
				"component after the target's tree broke apart",
			);

			instance.Destroy();
			target.Destroy();
			module.extinguish();
		},
	],
	[
		"asks a component's instance guard again when its tag arrives at an entry a link created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// `Strict` declares a plain Folder and demands a `Root` child through a guard of its
			// own, so the link's guard passes at once and the component's does not.
			const target = folder("StrictLinked");
			const owner = folder("StrictOwner1");
			owner.SetAttribute("Linked", new InstanceHandle(target));
			collectionService().AddTag(owner, "StrictOwner");

			expectEqual(components.getComponent<StrictOwner>(owner), undefined, "owner before the target is tagged");

			// The control: the same instance and the same order, with nothing linked to it.
			const control = folder("StrictControl");

			for (const instance of [target, control]) {
				folderIn(instance, "Root");
				collectionService().AddTag(instance, "Strict");
			}

			__harness.flush();

			expectDefined(components.getComponent<Strict>(control), "the component nothing links to");
			expectDefined(components.getComponent<Strict>(target), "the component a link watches");
			expectDefined(components.getComponent<StrictOwner>(owner), "owner once the link is met");

			owner.Destroy();
			target.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"drops a component whose tree breaks after its tag reached an entry a link created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The link creates the entry for `LateRig` while the target's only child is named
			// something else, so the instance guard fails and the tracker is watching the tree for the
			// child that would complete it.
			const rig = folder("DesyncedRig");
			const child = folderIn(rig, "Wrong");
			const owner = folder("DesyncedRigOwner");
			owner.SetAttribute("Rigged", new InstanceHandle(rig));
			collectionService().AddTag(owner, "LateRigOwner");

			expectEqual(
				components.getComponent<LateRig>(rig),
				undefined,
				"the linked component while the target has no tree",
			);

			// A rename fires no descendant signal, so the guard starts passing with nothing announcing
			// it: the tag arriving is what asks again. What it learns has to reach the poll as well,
			// which is now watching for the change that has already happened.
			child.Name = "Root";
			collectionService().AddTag(rig, "LateRig");
			__harness.flush();

			expectDefined(components.getComponent<LateRig>(rig), "the linked component once the tree is complete");
			expectDefined(components.getComponent<LateRigOwner>(owner), "owner once the link is met");

			// `Watching`, so the tree is re-checked in both directions, however the guard came to pass.
			child.Parent = undefined;
			__harness.flush();

			expectEqual(components.getComponent<LateRig>(rig), undefined, "the linked component after its tree broke");
			expectEqual(components.getComponent<LateRigOwner>(owner), undefined, "owner after the link's tree broke");

			owner.Destroy();
			rig.Destroy();
			child.Destroy();
			module.extinguish();
		},
	],
	[
		"builds a component whose tree is repaired after its tag reached an entry a link created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The mirror of the case above: the link creates the entry while the target's tree is
			// complete, so the tracker is watching for the child that would break it.
			const rig = folder("StuckRig");
			const child = folderIn(rig, "Root");
			const owner = folder("StuckRigOwner");
			owner.SetAttribute("Rigged", new InstanceHandle(rig));
			collectionService().AddTag(owner, "LateRigOwner");

			expectEqual(components.getComponent<LateRigOwner>(owner), undefined, "owner before the target is tagged");

			// The tree breaks without a signal announcing it either, so the tag arrives at a guard that
			// has started failing since the link looked.
			child.Name = "Wrong";
			collectionService().AddTag(rig, "LateRig");
			__harness.flush();

			expectEqual(
				components.getComponent<LateRig>(rig),
				undefined,
				"the linked component while its tree is broken",
			);

			// And the repair is an ordinary child arriving, which is the change the poll has to be
			// listening for now that the guard fails.
			const replacement = folderIn(rig, "Root");
			__harness.flush();

			const built = expectDefined(
				components.getComponent<LateRig>(rig),
				"the linked component once its tree was repaired",
			);
			expectEqual(built.instance.Root, replacement, "the child the guard passed on");
			expectDefined(components.getComponent<LateRigOwner>(owner), "owner once the link is met");

			owner.Destroy();
			rig.Destroy();
			child.Destroy();
			module.extinguish();
		},
	],
	[
		"asks a blocked instance's guard again when its tag arrives at an entry a link created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The tag never reaches the tracker's own listener here, because the ancestor lists
			// keep Flamework from constructing under ReplicatedStorage. The entry a link created is
			// still there, and must not be left answering with the guard's verdict from before the
			// tree was finished.
			const target = folderIn(ReplicatedStorage, "BlockedStrict");
			const owner = folder("BlockedStrictOwner");
			owner.SetAttribute("Linked", new InstanceHandle(target));
			collectionService().AddTag(owner, "StrictOwner");

			// The control: the same instance, in the same place, in the same order, with nothing
			// linked to it.
			const control = folderIn(ReplicatedStorage, "BlockedStrictControl");

			for (const instance of [target, control]) {
				folderIn(instance, "Root");
				collectionService().AddTag(instance, "Strict");
			}

			__harness.flush();

			expectDefined(components.getComponent<Strict>(control), "the blocked component nothing links to");
			const linked = expectDefined(
				components.getComponent<Strict>(target),
				"the blocked component a link watches",
			);

			// The escape hatch the ancestor lists leave open: a component that is already attached
			// to a blocked instance satisfies the link, whoever built it.
			__harness.flush();
			const built = expectDefined(components.getComponent<StrictOwner>(owner), "owner once the link is met");
			expectEqual(built.attributeComponents.Linked, linked, "the link's component");

			owner.Destroy();
			target.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a link unmet when it is re-pointed at a component under a blocked ancestor",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("RepointBlockedLinked");
			const instance = pointer("RepointBlocked", folder("RepointBlockedTarget"), linked);
			const component = expectDefined(components.getComponent<Pointer>(instance), "component");

			// Tagged and correctly unbuilt: the ancestor lists refuse to construct one here, and a
			// link is Flamework driving construction just as the tag is.
			const written = folderIn(ReplicatedStorage, "RepointBlockedWritten");
			const external = folderIn(ReplicatedStorage, "RepointBlockedExternal");
			collectionService().AddTag(written, "Handler");
			collectionService().AddTag(external, "Handler");

			__harness.clearWarnings();
			component.relink(written);

			expectEqual(components.getComponents<Handler>(written).size(), 0, "components after the refused write");
			expectEqual(component.attributes.Linked, linked, "attribute after the refused write");
			expectTrue(
				__harness.warnings().some((line) => line.find("has no component")[0] !== undefined),
				`warnings after the refused write: ${__harness.warnings().join(" | ")}`,
			);

			// The same re-point from outside: the link goes unmet rather than building a component
			// where neither a tag nor a link is allowed to.
			instance.SetAttribute("Linked", new InstanceHandle(external));
			__harness.flush();

			expectEqual(components.getComponents<Handler>(external).size(), 0, "components after the re-point");
			expectEqual(components.getComponent<Pointer>(instance), undefined, "owner after the re-point");

			instance.Destroy();
			written.Destroy();
			external.Destroy();
			module.extinguish();
		},
	],
	[
		"cancels a dependency's warning when the tag goes while a link is still watching",
		() => {
			const module = createComponentModule();

			// The link creates both entries -- `Starter` on the child, and `Ignition` under it --
			// before anything waits for either of them.
			const instance = folder("ChainUntagged");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(instance, "StarterOwner");

			__harness.clearWarnings();
			collectionService().AddTag(core, "Starter");
			collectionService().RemoveTag(core, "Starter");
			task.wait(0.3);

			expectFalse(
				__harness.warnings().some((line) => line.find("Ignition")[0] !== undefined),
				`warnings after the tag went: ${__harness.warnings().join(" | ")}`,
			);

			// And the other order, where the dependency's entry was waiting before the link ever
			// watched the component that depends on it.
			const mirror = folder("ChainUntaggedMirror");
			const mirrorCore = folderIn(mirror, "Core");

			__harness.clearWarnings();
			collectionService().AddTag(mirrorCore, "Starter");
			collectionService().AddTag(mirror, "StarterOwner");
			collectionService().RemoveTag(mirrorCore, "Starter");
			task.wait(0.3);

			expectFalse(
				__harness.warnings().some((line) => line.find("Ignition")[0] !== undefined),
				`warnings after the tag went in the other order: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			mirror.Destroy();
			module.extinguish();
		},
	],
	[
		"freezes a link attribute when refreshAttributes is off",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const first = folder("FrozenPointerFirst");
			const instance = folder("FrozenPointer1");
			instance.SetAttribute("Target", new InstanceHandle(first));
			collectionService().AddTag(instance, "FrozenPointer");

			const component = expectDefined(components.getComponent<FrozenPointer>(instance), "component");
			expectEqual(component.attributes.Target, first, "attribute as the link resolved it");

			const changes = new Array<string>();
			component.onAttributeChanged("Target", (newValue) => changes.push(tostring(newValue)));

			instance.SetAttribute("Target", new InstanceHandle(folder("FrozenPointerSecond")));
			__harness.flush();

			expectEqual(component.attributes.Target, first, "attribute after an external re-point");
			expectEqual(changes.size(), 0, "onAttributeChanged calls");

			// The component's own write still lands, as a plain attribute's does with tracking off,
			// and -- exactly as a plain one -- it announces nothing.
			const second = folder("FrozenPointerOwn");
			component.attributes.Target = second;

			const written = instance.GetAttribute("Target");
			expectEqual(component.attributes.Target, second, "attribute after the component wrote it");
			expectTrue(
				typeIs(written, "InstanceHandle") && written.Get() === second,
				"the handle the component's own write left on the instance",
			);
			expectEqual(changes.size(), 0, "onAttributeChanged calls with refreshAttributes off");

			// It is the component's view of the attribute that is frozen, not the criterion behind
			// it: a re-point the guard refuses still takes the component down.
			const part = new Instance("Part");
			part.Name = "FrozenPointerPart";
			part.Parent = game.Workspace;
			instance.SetAttribute("Target", new InstanceHandle(part));

			expectEqual(
				components.getComponent<FrozenPointer>(instance),
				undefined,
				"component after a re-point its guard refuses",
			);

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"removes both components of a link cycle exactly once",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const first = folder("TwinA");
			const second = folder("TwinB");
			collectionService().AddTag(first, "Twin");
			collectionService().AddTag(second, "Twin");

			const componentA = expectDefined(components.getComponent<Twin>(first), "first component");
			const componentB = expectDefined(components.getComponent<Twin>(second), "second component");

			// The link is optional, so both are built before either points anywhere; pointing them
			// at each other is what closes the cycle.
			first.SetAttribute("Partner", new InstanceHandle(second));
			second.SetAttribute("Partner", new InstanceHandle(first));
			__harness.flush();

			expectEqual(componentA.attributeComponents.Partner, componentB, "the first link");
			expectEqual(componentB.attributeComponents.Partner, componentA, "the second link");

			const removed = new Array<string>();
			components.onComponentRemoved<Twin>((_component, instance) => removed.push(instance.Name));

			// Each component's removal takes the other's link with it, and the announcement must
			// not find its way back into the removal it came from.
			components.removeComponent<Twin>(first);

			expectEqual(components.getComponent<Twin>(first), undefined, "first component after the removal");
			expectEqual(components.getComponent<Twin>(second), undefined, "second component after the removal");
			expectEqual(removed.size(), 2, `removal notifications: ${removed.join(", ")}`);
			expectTrue(removed.includes("TwinA"), "the first component announced its removal");
			expectTrue(removed.includes("TwinB"), "the second component announced its removal");
			expectEqual(componentA.destroyCount, 1, "times the first component was destroyed");
			expectEqual(componentB.destroyCount, 1, "times the second component was destroyed");

			first.Destroy();
			second.Destroy();
			module.extinguish();
		},
	],
	[
		"builds nothing for a component a removal handler asks for while it is being removed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RemovalReentry");
			collectionService().AddTag(instance, "Handler");
			expectDefined(components.getComponent<Handler>(instance), "component");

			// A hand removal touches neither the tag nor the tracker, so the instance still
			// qualifies while its component is being taken apart: `getComponent` has to answer for
			// a component that has left rather than build the replacement nobody was told about.
			let seen: Handler | undefined;
			const connection = components.onComponentRemoved<Handler>((_component, target) => {
				seen = components.getComponent<Handler>(target);
			});

			components.removeComponent<Handler>(instance);
			connection.Disconnect();

			expectEqual(seen, undefined, "getComponent inside the removal handler");
			expectEqual(
				components.getComponents<Handler>(instance).size(),
				0,
				"components still attached after removeComponent returned",
			);

			// Still tagged, so asking for it afterwards builds one, the way it always has.
			expectDefined(components.getComponent<Handler>(instance), "component asked for after the removal");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a component unbuilt while a link attribute names its own instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("SelfLink");
			instance.SetAttribute("Partner", new InstanceHandle(instance));

			// The link names the very component the tag is about to build, so it cannot be met on
			// the way in: it has to report itself unmet rather than report itself met and raise out
			// of the construction it asked for.
			expectNoThrow(() => {
				collectionService().AddTag(instance, "Twin");
			}, "tagging an instance whose link names itself");

			expectEqual(components.getComponent<Twin>(instance), undefined, "component while the link names itself");

			// The link is optional, so clearing it builds the component...
			instance.SetAttribute("Partner", undefined);
			const component = expectDefined(components.getComponent<Twin>(instance), "component once the link cleared");

			// ...and pointing it back at its own instance resolves to the component now attached.
			instance.SetAttribute("Partner", new InstanceHandle(instance));
			expectEqual(component.attributeComponents.Partner, component, "the link it resolved to");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"re-resolves a child link when the child is replaced by another instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Replaced");
			const first = folderIn(instance, "Core");
			collectionService().AddTag(first, "Handler");
			collectionService().AddTag(instance, "Owner");

			const owner = expectDefined(components.getComponent<Owner>(instance), "component");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(first), "the first child");

			// Swapped for another instance of the same name: the link follows the child, not the
			// component it happened to resolve to first.
			first.Parent = undefined;
			const second = folderIn(instance, "Core");
			collectionService().AddTag(second, "Handler");
			__harness.flush();

			const replaced = expectDefined(components.getComponent<Owner>(instance), "component after the swap");
			expectEqual(replaced.childComponents.Core, components.getComponent<Handler>(second), "the second child");

			module.extinguish();
		},
	],
	[
		"writes an attribute through to the instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Written", { speed: 3 });
			collectionService().AddTag(instance, "Tagged");

			const component = expectDefined(components.getComponent<Tagged>(instance), "component");

			component.setSpeed(9);
			expectEqual(component.attributes.speed, 9, "attribute after the write");
			expectEqual(instance.GetAttribute("speed"), 9, "instance attribute after the write");

			component.accelerate();
			expectEqual(instance.GetAttribute("speed"), 10, "instance attribute after a compound write");

			// An optional attribute can be written away, which is what clears it on the instance.
			component.rename("named");
			expectEqual(instance.GetAttribute("label"), "named", "optional attribute after the write");
			component.rename(undefined);
			expectEqual(instance.GetAttribute("label"), undefined, "optional attribute after being cleared");

			module.extinguish();
		},
	],
	[
		"refuses a write whose value does not match the attribute it is written to",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BadWrite", { speed: 3 });
			collectionService().AddTag(instance, "Tagged");

			const component = expectDefined(components.getComponent<Tagged>(instance), "component");

			// The cast is the point: nothing in the type system stops this, so the guard has to.
			const message = expectThrows(() => component.misassign("fast"), "writing a string to a number");
			expectTrue(message.find("not a valid value")[0] !== undefined, "message names the attribute");

			// Neither the component nor the instance is left holding the bad value.
			expectEqual(component.attributes.speed, 3, "attribute after the refused write");
			expectEqual(instance.GetAttribute("speed"), 3, "instance attribute after the refused write");

			expectThrows(() => component.clearSpeed(), "clearing a required attribute");
			expectEqual(component.attributes.speed, 3, "attribute after the refused clear");
			expectEqual(instance.GetAttribute("speed"), 3, "instance attribute after the refused clear");

			module.extinguish();
		},
	],
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
		"refuses a link write whose instance is the wrong shape",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("ShapeLinked");
			const instance = pointer("ShapeWrite", folder("ShapeTarget"), linked);
			const component = expectDefined(components.getComponent<Pointer>(instance), "component");

			// `Rig` needs a `Root` child, and the guard on a link carries that structure, not just
			// the class. A folder without one can never be right, so this raises.
			const message = expectThrows(() => component.setRigged(folder("NoRoot")), "writing a rootless folder");
			expectTrue(message.find("did not pass the guard")[0] !== undefined, "message names the guard");
			expectEqual(instance.GetAttribute("Rigged"), undefined, "attribute after the refused write");

			module.extinguish();
		},
	],
	[
		"warns rather than raising when a link write names an instance without the component",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("AwaitLinked");
			const instance = pointer("AwaitWrite", folder("AwaitTarget"), linked);
			const component = expectDefined(components.getComponent<Pointer>(instance), "component");

			// The right shape, but nothing has given it the component yet. Writing it would unqualify
			// the component doing the writing, so the write is refused and said out loud instead.
			const rigged = folder("RiggedLater");
			folderIn(rigged, "Root");

			__harness.clearWarnings();
			component.setRigged(rigged);

			expectEqual(instance.GetAttribute("Rigged"), undefined, "attribute after the refused write");
			expectDefined(components.getComponent<Pointer>(instance), "the writing component is still alive");
			expectTrue(
				__harness.warnings().some((line) => line.find("has no component")[0] !== undefined),
				"a warning said the component was missing",
			);
			expectTrue(
				__harness.warnings().some((line) => line.find("waitForComponent")[0] !== undefined),
				"a warning said what to do about it",
			);

			// Waiting for the component first is what makes the write land.
			collectionService().AddTag(rigged, "Rig");
			expectResolves(components.waitForComponent<Rig>(rigged), "the component being waited for");

			component.setRigged(rigged);
			expectEqual(component.attributes.Rigged, rigged, "attribute once the component was there");
			expectEqual(
				component.attributeComponents.Rigged,
				components.getComponent<Rig>(rigged),
				"linked component after the write",
			);

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
