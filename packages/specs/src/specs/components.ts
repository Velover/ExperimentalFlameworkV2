import {
	BaseComponent,
	Component,
	ComponentMetadata,
	ComponentPlugin,
	ComponentStreamingMode,
	Components,
} from "@flamework-experimental/components";
import { Flamework, OnInit, OnStart, OnTick, Provider } from "@flamework-experimental/core";
import { ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
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

	/**
	 * Every error a signal handler raised since the last `clearErrors`. The engine runs each
	 * handler on a thread of its own and prints what it raises, so an `AddTag` whose handler
	 * raises returns normally: this is where the raise shows.
	 */
	errors: () => string[];
	clearErrors: () => void;

	/** An `InstanceHandle` for an instance that has not streamed in, so `Get` is empty. */
	pendingHandle: (instance: Instance) => InstanceHandle;

	/** Streams in the instance a pending handle names, resuming whatever was waiting on it. */
	streamIn: (handle: InstanceHandle) => void;

	/** Every handler connected to an instance, across its own signals and the per-attribute ones. */
	connectionCount: (instance: Instance) => number;
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
@Component({ tag: "Watched", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0, watchRenames: true })
class Watched extends BaseComponent<{}, Folder & { Core: Folder }> {}

/** `Watched` with names left alone, which is the default: a rename is heard by nothing. */
@Component({ tag: "Unrenamed", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0 })
class Unrenamed extends BaseComponent<{}, Folder & { Core: Folder }> {}

@Component({ tag: "Frozen", streamingMode: ComponentStreamingMode.Disabled, warningTimeout: 0 })
class Frozen extends BaseComponent<{}, Folder & { Core: Folder }> {}

/** Uses the default streaming mode, which watches on the client and not on the server. */
@Component({ tag: "Contextual", warningTimeout: 0 })
class Contextual extends BaseComponent<{}, Folder & { Core: Folder }> {}

/** Contextual streaming leaves atomic models alone, because they stream in all at once. */
@Component({ tag: "Atomic", warningTimeout: 0 })
class Atomic extends BaseComponent<{}, Model & { Core: Folder }> {}

/** A tree two levels deep, watched, so a change under `Root` is a change to this component's tree. */
@Component({ tag: "Deep", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0 })
class Deep extends BaseComponent<{}, Folder & { Root: Folder & { Texture: Folder } }> {}

/** The same tree, warning almost at once, so a spec can read what the warning names. */
@Component({ tag: "DeepImpatient", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0.1 })
class DeepImpatient extends BaseComponent<{}, Folder & { Root: Folder & { Texture: Folder } }> {}

/** Requires a Part child, so a Folder of the right name is the wrong class. */
@Component({ tag: "Parted", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0 })
class Parted extends BaseComponent<{}, Folder & { Core: Part }> {}

/** Reads its tree once, so the owner below learns that a linked child's tree is that child's business. */
@Component({ tag: "FrozenRig", warningTimeout: 0, streamingMode: ComponentStreamingMode.Disabled })
class FrozenRig extends BaseComponent<{}, Folder & { Root: Folder }> {}

/** Watches its own tree; the tree under `Core` belongs to `FrozenRig`. */
@Component({ tag: "FrozenRigOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class FrozenRigOwner extends BaseComponent<{}, Folder & { Core: FrozenRig }> {}

/** The same owner over a child whose component does watch its tree. */
@Component({ tag: "LateRigChildOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class LateRigChildOwner extends BaseComponent<{}, Folder & { Core: LateRig }> {}

/** Warns almost at once about a child whose component is missing, in that component's words. */
@Component({ tag: "ExplainedOwner", warningTimeout: 0.1 })
class ExplainedOwner extends BaseComponent<{}, Folder & { Core: Rig }> {}

/** Warns almost at once about a plain link whose target is the wrong shape. */
@Component({ tag: "RootedImpatient", warningTimeout: 0.1, attributeWarningTimeout: 0 })
class RootedImpatient extends BaseComponent<{ Target: Folder & { Root: Folder } }, Folder> {}

/** Warns almost at once, so a spec can read what it says about a bad attribute. */
@Component({ tag: "Speedy", warningTimeout: 0.1 })
class Speedy extends BaseComponent<{ speed: number }, Folder> {}

/** Records `onInit` and `onStart`, and marks itself ready in `onInit`, which anything that sees it can check. */
@Component({ tag: "Initialised", warningTimeout: 0 })
class Initialised extends BaseComponent<{}, Folder> implements OnInit, OnStart {
	public ready = false;

	public onInit() {
		this.ready = true;
		events.push(`init:${this.instance.Name}`);
	}

	public onStart() {
		events.push(`start:${this.instance.Name}`);
	}
}

/** Links to `Initialised` and records, as it is initialised, whether the linked component already was. */
@Component({ tag: "InitialisedOwner", warningTimeout: 0 })
class InitialisedOwner extends BaseComponent<{}, Folder & { Core: Initialised }> implements OnInit {
	public sawReady = false;

	public onInit() {
		this.sawReady = this.childComponents.Core.ready;
	}
}

/** How many times a broken `onInit` has run: once per construction, never for a lookup. */
let initAttempts = 0;

/** Raises out of `onInit`, so it is never valid. */
@Component({ warningTimeout: 0 })
class BrokenInit extends BaseComponent<{}, Folder> implements OnInit {
	public onInit() {
		initAttempts += 1;
		throw "not today";
	}
}

/** The same, tagged, with an `onStart` that must never run. */
@Component({ tag: "BrokenInitTagged", warningTimeout: 0 })
class BrokenInitTagged extends BaseComponent<{}, Folder> implements OnInit, OnStart {
	public onInit() {
		initAttempts += 1;
		throw "not today";
	}

	public onStart() {
		events.push(`brokenstart:${this.instance.Name}`);
	}
}

/** Links to `BrokenInitTagged`, and warns almost at once about what it is waiting for. */
@Component({ tag: "BrokenOwner", warningTimeout: 0.1 })
class BrokenOwner extends BaseComponent<{}, Folder & { Core: BrokenInitTagged }> {}

/** Depends on `BrokenInitTagged` instead, so the component that is never valid is reached through the constructor rather than a link. */
@Component({ tag: "BrokenCar", warningTimeout: 0 })
class BrokenCar extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly broken: BrokenInitTagged,
	) {
		super(metadata);
	}
}

/** Raises out of `onInit` while `broken`, so one build can be invalid and the next valid. */
@Component({ tag: "Flaky", warningTimeout: 0 })
class Flaky extends BaseComponent<{}, Folder> implements OnInit {
	public static broken = false;

	public onInit() {
		initAttempts += 1;
		if (Flaky.broken) throw "not today";
	}
}

/** Depends on `Flaky`, so an invalid dependency taken down by hand is what it waits through. */
@Component({ tag: "FlakyCar", warningTimeout: 0 })
class FlakyCar extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly flaky: Flaky,
	) {
		super(metadata);
	}
}

/** A link attribute beside an `onInit` that raises, listened for from the constructor, which does run. */
@Component({ tag: "BrokenPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class BrokenPointer extends BaseComponent<{ Target: Folder }, Folder> implements OnInit {
	public static seen = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		this.onAttributeChanged("Target", () => {
			BrokenPointer.seen += 1;
		});
	}

	public onInit() {
		throw "not today";
	}
}

/** The instance `EarlyAdder` gives a component to during ignition. */
let earlyInstance: Instance | undefined;

/** A provider that builds a component from its `onInit`, before ignition has finished. */
@Provider()
class EarlyAdder implements OnInit, OnStart {
	constructor(private readonly components: Components) {}

	public onInit() {
		this.components.addComponent<Initialised>(earlyInstance!);
		events.push("adder:init-done");
	}

	public onStart() {
		events.push("adder:start");
	}
}

@Component({ tag: "Blocked" })
class Blocked extends BaseComponent<{}, Folder> {}

@Component({ tag: "Allowed", ancestorAllowList: [ReplicatedStorage] })
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

/** Depends on `Strict`, which is the other way that entry arrives before the tag -- with something waiting at it. */
@Component({ tag: "StrictCar", warningTimeout: 0 })
class StrictCar extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly strict: Strict,
	) {
		super(metadata);
	}
}

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

/** A child link on a model, under the default streaming mode, so an atomic model is read once on the client too. */
@Component({ tag: "AtomicOwner", warningTimeout: 0 })
class AtomicOwner extends BaseComponent<{}, Model & { Core: Handler }> {}

/** Only ever built under an instance named `Chosen`, which a link has to weigh as well. */
@Component({ tag: "Choosy", predicate: (instance) => instance.Parent?.Name === "Chosen" })
class Choosy extends BaseComponent<{}, Folder> {}

/** Links to a component a predicate can refuse, which no amount of tagging then satisfies. */
@Component({ tag: "ChoosyOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class ChoosyOwner extends BaseComponent<{}, Folder & { Core: Choosy }> {}

/** A required child link alongside an optional one, which is what churns the tree the most. */
@Component({ tag: "PairOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class PairOwner extends BaseComponent<{}, Folder & { Core: Handler; Aux: Handler }> {}

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
@Component({ tag: "Owner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching, watchRenames: true })
class Owner extends BaseComponent<{}, Folder & { Core: Handler }> {
	/** Counts the takedowns, so a rebuild can be told from a component that was never replaced. */
	public destroyCount = 0;

	public destroy() {
		this.destroyCount += 1;
		super.destroy();
	}
}

/** Points at an `Owner` through an attribute, which gives that component's tracker an entry before its tag is announced. */
@Component({ tag: "OwnerPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class OwnerPointer extends BaseComponent<{ Inner: Owner }, Folder> {}

/** Depends on an `Owner` instead, so the entry that exists before the tag is one a dependent waits at rather than one a link watches. */
@Component({ tag: "OwnerCar", warningTimeout: 0 })
class OwnerCar extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly owner: Owner,
	) {
		super(metadata);
	}
}

/** Points at a `FrozenOwner`, whose child link is read once: the entry the link creates reads it before the tree is there. */
@Component({ tag: "FrozenOwnerPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class FrozenOwnerPointer extends BaseComponent<{ Inner: FrozenOwner }, Folder> {}

/** Depends on a `FrozenOwner` instead, so the entry that reads the link too early is one a dependent waits at. */
@Component({ tag: "FrozenOwnerCar", warningTimeout: 0 })
class FrozenOwnerCar extends BaseComponent<{}, Folder> {
	constructor(
		metadata: ComponentMetadata,
		public readonly owner: FrozenOwner,
	) {
		super(metadata);
	}
}

/** Points at a `BrokenOwner`, whose own link names a component that is never valid: a chain two links long. */
@Component({ tag: "BrokenOwnerPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class BrokenOwnerPointer extends BaseComponent<{ Inner: BrokenOwner }, Folder> {}

/** A plain attribute beside a linked child, so a link can ask for a rebuild while the attribute has just gone bad. */
@Component({ tag: "SpeedOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class SpeedOwner extends BaseComponent<{ speed: number }, Folder & { Core: Handler }> {}

/** A plain required child beside a linked one, so a link can ask for a rebuild while the tree has just lost the other. */
@Component({ tag: "TwoChildOwner", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching })
class TwoChildOwner extends BaseComponent<{}, Folder & { Core: Handler; Extra: Folder }> implements OnStart {
	public static created = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		TwoChildOwner.created += 1;
	}

	public onStart() {
		events.push(`twostart:${this.instance.FindFirstChild("Extra") !== undefined}`);
	}
}

/** Two plain required children, so one can take the other's name and be followed by both slots. */
@Component({ tag: "LeakPair", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching, watchRenames: true })
class LeakPair extends BaseComponent<{}, Folder & { Core: Folder; Extra: Folder }> {}

/** Runs a callback from its constructor, which is synchronous inside the tag's handler on every engine: a tree it moves moves mid-batch. */
@Component({ tag: "Repairer" })
class Repairer extends BaseComponent<{}, Folder> {
	public static repair?: () => void;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		Repairer.repair?.();
	}
}

/** A part-shaped component, so a link tree can be built out of the classes a place uses. */
@Component({ tag: "Bolt" })
class Bolt extends BaseComponent<{}, Part> {}

interface ChassisAttributes {
	Target: Part;
	Linked: Bolt;
	Spare?: Part;
}

/** A model with a required and an optional linked child, alongside two link attributes. */
@Component({
	tag: "Chassis",
	warningTimeout: 0,
	attributeWarningTimeout: 0,
	streamingMode: ComponentStreamingMode.Watching,
})
class Chassis extends BaseComponent<ChassisAttributes, Model & { Core: Bolt }> {
	public static created = 0;
	public static destroyed = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		Chassis.created += 1;
	}

	public retarget(target: Part) {
		this.attributes.Target = target;
	}

	public destroy() {
		Chassis.destroyed += 1;
		super.destroy();
	}
}

/**
 * What the hiding cases record, in order: each build of `HideableItem` -- constructed, started,
 * destroyed, announced as added and as removed -- and each container's `onStart`.
 */
const hidingLog = new Array<string>();

/**
 * A model that a container shows and hides, tagged on its own. It requires a `Mesh` under the
 * default streaming mode, so its own tree is followed on a client and read once on a server. Each
 * build is numbered, so the log says which one started and which one went, and counts the frames
 * it was ticked, so one that went can be seen to have left the module's lifecycle too.
 */
@Component({ tag: "HideableItem", warningTimeout: 0 })
class HideableItem extends BaseComponent<{}, Folder & { Mesh: Folder }> implements OnStart, OnTick {
	public static builds = 0;
	public readonly build: number;
	public ticks = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		HideableItem.builds += 1;
		this.build = HideableItem.builds;
		hidingLog.push(`item:new:${this.build}`);
	}

	public onStart() {
		hidingLog.push(`item:start:${this.build}`);
	}

	public onTick() {
		this.ticks += 1;
	}

	public destroy() {
		hidingLog.push(`item:destroy:${this.build}`);
		super.destroy();
	}
}

/**
 * In charge of whether its `Item` shows, the way a visibility component is: it hides the item from
 * its own `onStart` by unparenting it, and `show` and `hide` move it back in and out again.
 */
@Component({ tag: "UnparentingContainer", warningTimeout: 0 })
class UnparentingContainer extends BaseComponent<{}, Folder> implements OnStart {
	public item?: Instance;

	public onStart() {
		hidingLog.push("container:start");
		this.item = this.instance.FindFirstChild("Item");
		this.hide();
		hidingLog.push("container:hid");
	}

	public hide() {
		this.item!.Parent = undefined;
	}

	public show() {
		this.item!.Parent = this.instance;
	}
}

/** The same, hiding its `Item` in `storage`, a folder that stays in the DataModel, rather than unparenting it. */
@Component({ tag: "StoringContainer", warningTimeout: 0 })
class StoringContainer extends BaseComponent<{}, Folder> implements OnStart {
	public static storage?: Instance;
	public item?: Instance;

	public onStart() {
		hidingLog.push("container:start");
		this.item = this.instance.FindFirstChild("Item");
		this.hide();
		hidingLog.push("container:hid");
	}

	public hide() {
		this.item!.Parent = StoringContainer.storage;
	}

	public show() {
		this.item!.Parent = this.instance;
	}
}

/** Names its `Item`'s component through a child link, and hides the item when asked: unparented, or moved into `into`. */
@Component({ tag: "LinkedContainer", warningTimeout: 0 })
class LinkedContainer extends BaseComponent<{}, Folder & { Item: HideableItem }> {
	public readonly item: Instance = this.instance.Item;

	public hide(into?: Instance) {
		this.item.Parent = into;
	}

	public show() {
		this.item.Parent = this.instance;
	}
}

/** Names its `Item`'s component through a link attribute instead. */
@Component({ tag: "PointingContainer", warningTimeout: 0, attributeWarningTimeout: 0 })
class PointingContainer extends BaseComponent<{ Item: HideableItem }, Folder> {
	public readonly item: Instance = this.attributes.Item;

	public hide(into?: Instance) {
		this.item.Parent = into;
	}

	public show() {
		this.item.Parent = this.instance;
	}
}

/** Requires its `Item` as a plain child of its instance tree, under the default streaming mode. */
@Component({ tag: "ShapedContainer", warningTimeout: 0 })
class ShapedContainer extends BaseComponent<{}, Folder & { Item: Folder }> {
	public readonly item: Instance = this.instance.Item;

	public hide(into?: Instance) {
		this.item.Parent = into;
	}

	public show() {
		this.item.Parent = this.instance;
	}
}

/**
 * Tagged on its own inside a `HideableItem`: a tagged descendant that goes wherever the item is
 * hidden.
 */
@Component({ tag: "HideableGem", warningTimeout: 0 })
class HideableGem extends BaseComponent<{}, Folder> {}

/**
 * Stores its `Item` in `storage` from its constructor and then raises, so it is never built: a
 * construction that fails after it has hidden the child.
 */
@Component({ tag: "StashingRaiser", warningTimeout: 0 })
class StashingRaiser extends BaseComponent<{}, Folder> {
	public static storage?: Instance;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		this.instance.FindFirstChild("Item")!.Parent = StashingRaiser.storage;
		throw "StashingRaiser raised after storing its item";
	}
}

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

/** An instance guard written by hand that raises, rather than answers, on an instance short of `X`. */
@Component({
	tag: "Throwy",
	warningTimeout: 0,
	instanceGuard: (value): value is Folder => typeIs(value, "Instance") && value.FindFirstChild("X")!.Name !== "",
})
class Throwy extends BaseComponent<{}, Folder> {}

/** Links to `Throwy` after a plain link, so a link set up ahead of the one that raises has subscriptions of its own. */
@Component({ tag: "ThrowyPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class ThrowyPointer extends BaseComponent<{ Target: Folder; Linked: Throwy }, Folder> {}

/** A predicate that raises, rather than answers, on an instance short of `X`. */
@Component({ tag: "Fussy", warningTimeout: 0, predicate: (instance) => instance.FindFirstChild("X")!.Name !== "" })
class Fussy extends BaseComponent<{}, Folder> {}

/** Links to `Fussy` after a plain link. */
@Component({ tag: "FussyPointer", warningTimeout: 0, attributeWarningTimeout: 0 })
class FussyPointer extends BaseComponent<{ Target: Folder; Linked: Fussy }, Folder> {}

@Component({ tag: "Static", refreshAttributes: false })
class Static extends BaseComponent<{ speed: number }, Folder> {}

/** Takes the module's `Components`, for the specs that ask which one a provider is given. */
@Provider()
class ComponentsTaker {
	constructor(public readonly components: Components) {}
}

/**
 * Builds a module with the component plugin and just the components the specs use, so that no spec
 * depends on path-based discovery.
 */
function createComponentPlugin() {
	return ComponentPlugin.builder()
		.registerComponent(Tagged)
		.registerComponent(Defaulted)
		.registerComponent(PartOnly)
		.registerComponent(Manual)
		.registerComponent(Watched)
		.registerComponent(Frozen)
		.registerComponent(Contextual)
		.registerComponent(Atomic)
		.registerComponent(Deep)
		.registerComponent(DeepImpatient)
		.registerComponent(Parted)
		.registerComponent(FrozenRig)
		.registerComponent(FrozenRigOwner)
		.registerComponent(LateRigChildOwner)
		.registerComponent(ExplainedOwner)
		.registerComponent(RootedImpatient)
		.registerComponent(Speedy)
		.registerComponent(Initialised)
		.registerComponent(InitialisedOwner)
		.registerComponent(BrokenInit)
		.registerComponent(BrokenInitTagged)
		.registerComponent(BrokenOwner)
		.registerComponent(BrokenCar)
		.registerComponent(BrokenPointer)
		.registerComponent(Flaky)
		.registerComponent(FlakyCar)
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
		.registerComponent(StrictCar)
		.registerComponent(Rooted)
		.registerComponent(FrozenPointer)
		.registerComponent(Twin)
		.registerComponent(Extra)
		.registerComponent(BaseHandler)
		.registerComponent(DerivedHandler)
		.registerComponent(BaseOwner)
		.registerComponent(FrozenOwner)
		.registerComponent(AtomicOwner)
		.registerComponent(OwnerPointer)
		.registerComponent(OwnerCar)
		.registerComponent(FrozenOwnerPointer)
		.registerComponent(FrozenOwnerCar)
		.registerComponent(BrokenOwnerPointer)
		.registerComponent(SpeedOwner)
		.registerComponent(TwoChildOwner)
		.registerComponent(LeakPair)
		.registerComponent(Throwy)
		.registerComponent(ThrowyPointer)
		.registerComponent(Fussy)
		.registerComponent(FussyPointer)
		.registerComponent(Repairer)
		.registerComponent(Choosy)
		.registerComponent(ChoosyOwner)
		.registerComponent(PairOwner)
		.registerComponent(Unrenamed)
		.registerComponent(FrozenPair)
		.registerComponent(Impatient)
		.registerComponent(ImpatientOwner)
		.registerComponent(Ignition)
		.registerComponent(Starter)
		.registerComponent(StarterOwner)
		.registerComponent(Bolt)
		.registerComponent(Chassis)
		.registerComponent(HideableItem)
		.registerComponent(UnparentingContainer)
		.registerComponent(StoringContainer)
		.registerComponent(LinkedContainer)
		.registerComponent(PointingContainer)
		.registerComponent(ShapedContainer)
		.registerComponent(HideableGem)
		.registerComponent(StashingRaiser)
		.build();
}

/** A module with the spec plugin, which every spec works against. */
function createComponentModule() {
	return Flamework.createModule().includePlugin(createComponentPlugin()).ignite();
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

/** A part-shaped child, for the link trees a place builds out of models and parts. */
function partIn(parent: Instance, name: string) {
	const instance = new Instance("Part");
	instance.Name = name;
	instance.Parent = parent;

	return instance;
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

/** How many instances a component's tracker holds an entry for, which is what a leaked entry shows up in. */
function trackedCount(components: Components, component: object) {
	const trackers = (components as unknown as { trackers: Map<object, { instances: Map<Instance, unknown> }> })
		.trackers;

	return trackers.get(component)?.instances.size() ?? 0;
}

/**
 * How many tagged instances the ancestor lists kept a component off and wait to be weighed again
 * once they move, which is what a leaked refusal shows up in.
 */
function refusedCount(components: Components, component: object) {
	return (components as unknown as Registry).refusals.get(component)?.instances.size() ?? 0;
}

/**
 * An item on its own, the way a template is kept: a folder with the `Mesh` `HideableItem` requires,
 * untagged.
 */
function itemIn(parent: Instance | undefined, name: string) {
	const item = new Instance("Folder");
	item.Name = name;

	const mesh = new Instance("Folder");
	mesh.Name = "Mesh";
	mesh.Parent = item;

	item.Parent = parent;

	return item;
}

/**
 * Runs `callback` as one resumption of a place and lets what it left queued run. Under immediate
 * signal behaviour (`deferred` false), which the harness runs by default, every handler runs
 * inside the write that raised it; under deferred behaviour every signal and `task.defer` raised in
 * the callback is delivered once it returns. Either way the removal the tag path weighs again a
 * resumption after the announcement has run by the time this returns.
 *
 * A module ignites outside it, where the harness delivers signals immediately, so Flamework's watch
 * on what leaves an instance while its announcement is acted on (`announceWatching`) is on in the
 * deferred variants too: they show the watch does no harm where signals are deferred, not how
 * Flamework behaves without it. The place's deferred project covers that.
 */
function resumption(deferred: boolean, callback: () => void) {
	if (deferred) {
		__harness.deferTags(callback);
	} else {
		callback();
	}

	__harness.flush();
	__harness.flush();
}

/** A container holding an `Item` with the `Mesh` the item requires, untagged, in `parent` or detached. */
function hidingTree(name: string, parent: Instance | undefined) {
	const container = new Instance("Folder");
	container.Name = name;

	const item = new Instance("Folder");
	item.Name = "Item";
	item.Parent = container;

	const mesh = new Instance("Folder");
	mesh.Name = "Mesh";
	mesh.Parent = item;

	container.Parent = parent;

	return [container, item] as const;
}

/**
 * A detached container tagged `StoringContainer` with no item of its own, whose tag is announced as
 * it enters the DataModel: whatever is parented into it before that is the `Item` it hides.
 */
function enteringContainer(name: string) {
	const container = new Instance("Folder");
	container.Name = name;
	collectionService().AddTag(container, "StoringContainer");

	return container;
}

/** Tags the item and its container in one go, the item first or the container first. */
function tagHidingTree(container: Instance, item: Instance, containerTag: string, itemFirst: boolean) {
	if (itemFirst) collectionService().AddTag(item, "HideableItem");
	collectionService().AddTag(container, containerTag);
	if (!itemFirst) collectionService().AddTag(item, "HideableItem");
}

/**
 * Every `HideableItem` announced as removed, by build, held weakly: whatever else still holds one is
 * what keeps it here.
 */
const removedItems = setmetatable(new Map<number, HideableItem>(), { __mode: "v" });

/**
 * The tags of the hiding cases: the item's, then each container's, then the item's tagged
 * descendant's.
 */
const HIDING_TAGS = [
	"HideableItem",
	"UnparentingContainer",
	"StoringContainer",
	"LinkedContainer",
	"PointingContainer",
	"ShapedContainer",
	"StashingRaiser",
	"HideableGem",
];

/**
 * Starts `hidingLog` and `removedItems` afresh, and records in them every `HideableItem` announced as
 * added and as removed.
 */
function recordHiding(components: Components) {
	hidingLog.clear();
	removedItems.clear();
	HideableItem.builds = 0;
	__harness.clearWarnings();

	components.onComponentAdded<HideableItem>((component) => hidingLog.push(`item:added:${component.build}`));
	components.onComponentRemoved<HideableItem>((component) => {
		hidingLog.push(`item:removed:${component.build}`);
		removedItems.set(component.build, component);
	});
}

/**
 * One resumption of a stress loop, with no more waiting than it takes: under deferred behaviour the
 * batch is delivered as the callback returns, and under immediate behaviour one frame lets the
 * removal the tag path weighs a resumption late run.
 */
function step(deferred: boolean, callback: () => void) {
	if (deferred) {
		__harness.deferTags(callback);
	} else {
		callback();
		__harness.flush();
	}
}

/**
 * Checks what `hidingLog` says about every build of `HideableItem` so far: each was constructed,
 * started and announced as added once; each that went was destroyed and announced as removed once,
 * after it started and never started again; and `standing` of them are still attached.
 */
function checkItemBuilds(what: string, standing: number) {
	const log = hidingLog.join(", ");
	const count = (line: string) => hidingLog.filter((entry) => entry === line).size();

	let gone = 0;
	for (let build = 1; build <= HideableItem.builds; build++) {
		expectEqual(count(`item:new:${build}`), 1, `${what}: build ${build} constructed (${log})`);
		expectEqual(count(`item:start:${build}`), 1, `${what}: build ${build} started (${log})`);
		expectEqual(count(`item:added:${build}`), 1, `${what}: build ${build} announced as added (${log})`);

		const destroyed = count(`item:destroy:${build}`);
		expectTrue(destroyed <= 1, `${what}: build ${build} destroyed at most once (${log})`);
		expectEqual(count(`item:removed:${build}`), destroyed, `${what}: build ${build} announced as removed (${log})`);

		if (destroyed === 1) {
			gone += 1;
			expectTrue(
				hidingLog.indexOf(`item:start:${build}`) < hidingLog.indexOf(`item:destroy:${build}`),
				`${what}: build ${build} started before it was destroyed (${log})`,
			);
		}
	}

	expectEqual(HideableItem.builds - gone, standing, `${what}: builds still attached (${log})`);
	expectEqual(__harness.warnings().size(), 0, `${what}: warnings: ${__harness.warnings().join(" | ")}`);
}

/** One tracker entry, as far as a leak shows in it: what it holds and what it keeps running. */
interface TrackerEntry {
	listeners: Set<unknown>;
	owners?: Set<unknown>;
	waiting?: Set<unknown>;
	holders?: Map<unknown, { instance: Instance }>;
	dependencyListeners?: Map<unknown, unknown>;
	unmetCriteria?: Set<unknown>;
	invalidAttributes?: Set<unknown>;
	cleanup?: Set<unknown>;
	timeoutWarningThread?: thread;
	typeGuardWatcher?: object;
	linkWatcher?: object;
}

/**
 * What `Components` keeps per instance and per component, which is where a leak would grow: its
 * lookups, the construction and removal windows, the waiters, the maids holding each component's
 * attribute connections, every tracker's entries, which own the tree watchers, the link watchers,
 * the attribute watch and the warning thread of an instance, and the signals its announcements go
 * through, which a link connects to; and the instances the ancestor lists refused, each waiting to
 * be weighed again once it moves, with what hears it move: a connection of its own, or its count on
 * the blocked ancestor it sits under, whose one connection every refusal there shares; and, under
 * immediate signal behaviour, the instances whose announcement is being acted on, each watched for
 * a descendant leaving it, and the instances whose announcement the engine skipped, each watched
 * for leaving the DataModel. The fields are private; a roblox-ts private field is a plain table
 * field.
 */
interface Registry {
	activeComponents: Map<Instance, Map<unknown, BaseComponent>>;
	reverseComponentsMapping: Map<string, Set<BaseComponent>>;
	constructing: Map<Instance, Set<unknown>>;
	cancelled: Map<Instance, Set<unknown>>;
	unannounced: Set<BaseComponent>;
	removing: Map<Instance, Set<unknown>>;
	checkingLinks: Map<Instance, Set<unknown>>;
	invalid: Map<Instance, Map<unknown, string>>;
	pendingStarts?: Array<[BaseComponent, unknown, Instance]>;
	trackers: Map<object, { instances: Map<Instance, TrackerEntry> }>;
	componentWaiters: Map<Instance, Map<unknown, Set<unknown>>>;
	componentCleanup: Map<BaseComponent, { _tasks: Map<unknown, unknown> }>;
	componentAddedListeners: Map<string, { Bindable: Instance }>;
	componentRemovedListeners: Map<string, { Bindable: Instance }>;
	componentInvalidatedListeners: Map<string, { Bindable: Instance }>;
	connections: RBXScriptConnection[];
	refusals: Map<object, { instances: Map<Instance, Instance | RBXScriptConnection> }>;
	leavingWatches: Map<Instance, { counts: Map<unknown, number> }>;
	announcing: Map<Instance, { depth: number }>;
	skippedInstances: Map<Instance, { removals: unknown[] }>;
}

/**
 * Everything `Components` keeps, counted by kind, with the connections on its announcement signals.
 * A count that is higher after a stretch of hiding and showing than before it, with the same
 * instances standing, is a leak.
 */
function registryCounts(components: Components) {
	const registry = components as unknown as Registry;
	const counts = new Map<string, number>();
	const add = (key: string, amount: number) => counts.set(key, (counts.get(key) ?? 0) + amount);
	const sizeOf = (collection?: object) => {
		let size = 0;
		if (collection !== undefined) {
			for (const [_] of pairs(collection as Map<unknown, unknown>)) size += 1;
		}

		return size;
	};

	add("instances with components", registry.activeComponents.size());
	for (const [, active] of registry.activeComponents) add("components", active.size());
	for (const [, set] of registry.reverseComponentsMapping) add("components by id", set.size());
	add("constructing", registry.constructing.size());
	add("cancelled", registry.cancelled.size());
	add("unannounced", registry.unannounced.size());
	add("removing", registry.removing.size());
	add("checking links", registry.checkingLinks.size());
	add("invalid", registry.invalid.size());
	add("pending starts", sizeOf(registry.pendingStarts));
	add("waiters", registry.componentWaiters.size());
	add("maids", registry.componentCleanup.size());
	for (const [, maid] of registry.componentCleanup) add("maid tasks", maid._tasks.size());
	add("tag connections", registry.connections.size());

	for (const [, signal] of registry.componentAddedListeners) {
		add("added signal connections", __harness.connectionCount(signal.Bindable));
	}
	for (const [, signal] of registry.componentRemovedListeners) {
		add("removed signal connections", __harness.connectionCount(signal.Bindable));
	}
	for (const [, signal] of registry.componentInvalidatedListeners) {
		add("invalidated signal connections", __harness.connectionCount(signal.Bindable));
	}

	add("leaving watches", registry.leavingWatches.size());
	add("announcement watches", sizeOf(registry.announcing));
	add("skipped watches", sizeOf(registry.skippedInstances));
	for (const [, watch] of registry.leavingWatches) {
		for (const [, count] of watch.counts) add("refusals counted on leaving watches", count);
	}
	for (const [ctor, refusals] of registry.refusals) {
		const name = tostring(ctor);
		add(`${name}: refused`, refusals.instances.size());
		for (const [, watched] of refusals.instances) {
			if (!typeIs(watched, "Instance")) add(`${name}: refusal connections`, 1);
		}
	}

	for (const [ctor, tracker] of registry.trackers) {
		const name = tostring(ctor);
		add(`${name}: entries`, tracker.instances.size());

		for (const [, entry] of tracker.instances) {
			add(`${name}: listeners`, entry.listeners.size());
			add(`${name}: owners`, sizeOf(entry.owners));
			add(`${name}: waiting`, sizeOf(entry.waiting));
			add(`${name}: holders`, sizeOf(entry.holders));
			add(`${name}: dependency listeners`, sizeOf(entry.dependencyListeners));
			add(`${name}: unmet criteria`, sizeOf(entry.unmetCriteria));
			add(`${name}: cleanups`, sizeOf(entry.cleanup));
			add(`${name}: warning threads`, entry.timeoutWarningThread !== undefined ? 1 : 0);
			add(`${name}: tree watchers`, entry.typeGuardWatcher !== undefined ? 1 : 0);
			add(`${name}: link watchers`, entry.linkWatcher !== undefined ? 1 : 0);
		}
	}

	return counts;
}

/** Every handler connected to each of `instances`, by name: a watcher left behind shows up here. */
function connectionsOn(instances: Instance[]) {
	const counts = new Map<string, number>();
	for (const instance of instances) counts.set(instance.Name, __harness.connectionCount(instance));

	return counts;
}

/** Checks two readings of counts agree, naming every count that moved. */
function expectSameCounts(before: Map<string, number>, after: Map<string, number>, what: string) {
	const moved = new Array<string>();
	for (const [key, value] of after) {
		if ((before.get(key) ?? 0) !== value) moved.push(`${key}: ${before.get(key) ?? 0} -> ${value}`);
	}
	for (const [key, value] of before) {
		if (!after.has(key) && value !== 0) moved.push(`${key}: ${value} -> 0`);
	}

	expectEqual(moved.join(", "), "", `${what}: counts that moved`);
}

/**
 * Where `Components` still holds one of `instances`, or a component attached to one of them: a key
 * of any of its per-instance lookups or tracker entries, an entry held open from one of them, or a
 * component in its lookups, maids and windows.
 */
function registryHolds(components: Components, instances: Instance[]) {
	const registry = components as unknown as Registry;
	const watched = new Set(instances);
	const found = new Array<string>();
	const keyed = (what: string, map: Map<Instance, unknown>) => {
		for (const [instance] of map) {
			if (watched.has(instance)) found.push(`${what}[${instance.Name}]`);
		}
	};
	const attached = (what: string, component: BaseComponent) => {
		if (watched.has(component.instance)) found.push(`${what}: a component of ${component.instance.Name}`);
	};

	keyed("activeComponents", registry.activeComponents);
	keyed("constructing", registry.constructing);
	keyed("cancelled", registry.cancelled);
	keyed("removing", registry.removing);
	keyed("checkingLinks", registry.checkingLinks);
	keyed("invalid", registry.invalid);
	keyed("componentWaiters", registry.componentWaiters);

	for (const [, set] of registry.reverseComponentsMapping) {
		for (const component of set) attached("reverseComponentsMapping", component);
	}
	for (const [component] of registry.componentCleanup) attached("componentCleanup", component);
	for (const component of registry.unannounced) attached("unannounced", component);
	for (const [component] of registry.pendingStarts ?? []) attached("pendingStarts", component);

	for (const [ctor, tracker] of registry.trackers) {
		keyed(`${ctor} entries`, tracker.instances);

		for (const [instance, entry] of tracker.instances) {
			for (const [, holder] of entry.holders ?? new Map<unknown, { instance: Instance }>()) {
				if (watched.has(holder.instance)) {
					found.push(`${ctor} entry of ${instance.Name}, held by ${holder.instance.Name}`);
				}
			}
		}
	}

	for (const [ctor, refusals] of registry.refusals) keyed(`${ctor} refusals`, refusals.instances);
	keyed("leavingWatches", registry.leavingWatches);
	keyed("announcing", registry.announcing);
	keyed("skippedInstances", registry.skippedInstances);

	return found;
}

/**
 * Ends a hiding case: destroys `instances` (the container, the item and the storage), lets every
 * removal land, and checks that the registry holds nothing of them and is back to `baseline`, the
 * counts taken before the case made anything. The harness's CollectionService keeps a destroyed
 * instance's tags, as the engine keeps them on the instance; they are taken off afterwards, so that
 * nothing but Flamework could still hold the instance for `collectUntilReleased`.
 */
function expectReleased(components: Components, baseline: Map<string, number>, instances: Instance[], what: string) {
	const everything = new Array<Instance>();
	for (const instance of instances) {
		everything.push(instance);
		for (const descendant of instance.GetDescendants()) everything.push(descendant);
	}

	for (const instance of instances) instance.Destroy();
	__harness.flush();
	__harness.flush();

	expectEqual(registryHolds(components, everything).join(", "), "", `${what}: what the registry still holds`);
	expectSameCounts(baseline, registryCounts(components), `${what}: the registry once the case was destroyed`);

	for (const instance of everything) {
		for (const tag of collectionService().GetTags(instance)) collectionService().RemoveTag(instance, tag);
	}
}

/**
 * Lets the collector run until `probe`, a weak-valued table, lets go of everything in it, or the
 * rounds run out, and returns what it still holds. Lune refuses `collectgarbage("collect")`, as
 * Roblox does, so a collection is brought on by allocating, as the lifecycle specs do.
 */
function collectUntilReleased(probe: Map<number, object>) {
	for (let round = 0; round < 50 && !probe.isEmpty(); round++) {
		const junk = new Array<object>();
		for (let i = 0; i < 20000; i++) junk.push({ i });
	}

	const left = new Array<string>();
	for (const [key, value] of probe) left.push(`${key}: ${tostring(value)}`);

	return left;
}

/** A table holding its values weakly: what is in it is held by nothing but whoever else still has it. */
function weakProbe() {
	return setmetatable(new Map<number, object>(), { __mode: "v" });
}

export = suite("components", [
	[
		"leaves a component down when a rebuild is asked for by a queued child signal after a later one broke the tree",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("QueuedPair");
			const core = addCore(instance);
			collectionService().AddTag(core, "Handler");
			const aux = folderIn(instance, "Aux");
			collectionService().AddTag(aux, "Handler");
			collectionService().AddTag(instance, "PairOwner");
			expectDefined(components.getComponent<PairOwner>(instance), "component");

			const elsewhere = folder("QueuedPairElsewhere");

			// Three moves in one resumption: `Aux` out, back in, and `Core` out. Its return is
			// delivered before `Core` leaving, so the `Aux` link takes the component down and asks
			// for it straight back while the `Core` link's criterion still says a `Core` is there
			// and the tree no longer holds one: the rebuild must not trust it and raise out of a
			// handler that is only there because something else moved.
			expectNoThrow(() => {
				__harness.deferTree(() => {
					aux.Parent = elsewhere;
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
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(core), "the Core link");
			expectEqual(rebuilt.childComponents.Aux, components.getComponent<Handler>(aux), "the Aux link");

			instance.Destroy();
			core.Destroy();
			aux.Destroy();
			elsewhere.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a component down when a linked child is swapped in the resumption an attribute went bad",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("SpeedOwner1", { speed: 1 });
			const oldCore = addCore(instance);
			collectionService().AddTag(oldCore, "Handler");
			collectionService().AddTag(instance, "SpeedOwner");
			expectDefined(components.getComponent<SpeedOwner>(instance), "component");

			const newCore = new Instance("Folder");
			newCore.Name = "Core";
			collectionService().AddTag(newCore, "Handler");
			const elsewhere = folder("SpeedOwnerElsewhere");

			// The attribute criterion is read on a deferred task, so the swap's child signals arrive
			// first: the link takes the component down and asks for it straight back, against an
			// attribute the guard refuses. The rebuild reads it rather than raising out of the
			// handler, and nothing is built until the attribute is valid again.
			expectNoThrow(() => {
				__harness.deferTree(() => {
					instance.SetAttribute("speed", "bad");
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
				});
			}, "delivering the queued child signals");
			expectEqual(components.getComponent<SpeedOwner>(instance), undefined, "component in the same resumption");
			__harness.flush();
			expectEqual(
				components.getComponent<SpeedOwner>(instance),
				undefined,
				"component while the attribute is bad",
			);

			instance.SetAttribute("speed", 2);
			__harness.flush();
			const rebuilt = expectDefined(
				components.getComponent<SpeedOwner>(instance),
				"component once the attribute is valid again",
			);
			expectEqual(rebuilt.attributes.speed, 2, "the attribute the rebuilt component read");
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(newCore), "the swapped child");

			instance.Destroy();
			oldCore.Destroy();
			elsewhere.Destroy();
			module.extinguish();
		},
	],
	[
		"leaves a component down when a linked child is swapped in the resumption another child left",
		() => {
			events.clear();
			TwoChildOwner.created = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("TwoChildOwner1");
			const extra = folderIn(instance, "Extra");
			const oldCore = addCore(instance);
			collectionService().AddTag(oldCore, "Handler");
			collectionService().AddTag(instance, "TwoChildOwner");
			expectDefined(components.getComponent<TwoChildOwner>(instance), "component");
			expectEqual(TwoChildOwner.created, 1, "constructions");

			const newCore = new Instance("Folder");
			newCore.Name = "Core";
			collectionService().AddTag(newCore, "Handler");
			const elsewhere = folder("TwoChildOwnerElsewhere");

			// The instance guard is read on a deferred task as well, so the link's rebuild arrives
			// while the guard still says the tree is whole: the rebuild reads the tree for itself,
			// rather than constructing a component on one that is missing a required child.
			__harness.deferTree(() => {
				extra.Parent = elsewhere;
				oldCore.Parent = elsewhere;
				newCore.Parent = instance;
			});
			expectEqual(TwoChildOwner.created, 1, "constructions in the same resumption");
			expectEqual(
				components.getComponents<TwoChildOwner>(instance).size(),
				0,
				"components in the same resumption",
			);
			__harness.flush();
			expectEqual(TwoChildOwner.created, 1, "constructions after the guard was read");
			expectFalse(events.includes("twostart:false"), "a component started on a tree missing its child");

			extra.Parent = instance;
			__harness.flush();
			expectDefined(components.getComponent<TwoChildOwner>(instance), "component once the tree is whole again");
			expectEqual(TwoChildOwner.created, 2, "constructions once the tree is whole again");

			instance.Destroy();
			oldCore.Destroy();
			elsewhere.Destroy();
			module.extinguish();
		},
	],
	[
		"builds a component whose tree was repaired between a refused rebuild and the guard's poll",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RepairedOwner");
			const oldCore = addCore(instance);
			collectionService().AddTag(oldCore, "Handler");
			const extra = folderIn(instance, "Extra");
			collectionService().AddTag(instance, "TwoChildOwner");
			expectDefined(components.getComponent<TwoChildOwner>(instance), "component");

			const newCore = new Instance("Folder");
			newCore.Name = "Core";
			collectionService().AddTag(newCore, "Handler");
			const elsewhere = folder("RepairedOwnerElsewhere");
			const other = folder("RepairedOwnerOther");
			Repairer.repair = () => {
				extra.Parent = instance;
			};

			// In raise order: the linked child's swap, then a tag whose component's constructor
			// puts `Extra` back, then `Extra` leaving. The swap asks for a rebuild while `Extra` is
			// gone, which the reading at the flip refuses without recording anything; the
			// constructor puts it back; and the guard's own signal for `Extra` then finds the slot
			// filled again, so its poll reads the tree exactly as the entry already records it.
			// The poll still has to say so, or nothing ever lifts the refusal.
			__harness.deferTree(() => {
				__harness.deferTags(() => {
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
					collectionService().AddTag(other, "Repairer");
					extra.Parent = elsewhere;
				});
			});
			Repairer.repair = undefined;
			__harness.flush();
			__harness.flush();

			expectEqual(extra.Parent, instance, "Extra is back");
			expectDefined(components.getComponent<Handler>(newCore), "the linked child's component");
			expectDefined(components.getComponent<TwoChildOwner>(instance), "component once the tree holds again");

			instance.Destroy();
			oldCore.Destroy();
			elsewhere.Destroy();
			other.Destroy();
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
		"removes a component when a plain attribute becomes invalid, and builds it again once it is valid",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BadExternal", { speed: 3 });
			collectionService().AddTag(instance, "Tagged");
			expectDefined(components.getComponent<Tagged>(instance), "component");

			// An attribute guard is a criterion: a value it rejects takes the component down, and a
			// value it accepts builds it again, reading the attributes afresh.
			instance.SetAttribute("speed", "nope");
			__harness.flush();
			expectEqual(components.getComponent<Tagged>(instance), undefined, "component after a bad attribute change");

			instance.SetAttribute("speed", 4);
			__harness.flush();
			const rebuilt = expectDefined(
				components.getComponent<Tagged>(instance),
				"component once the attribute is valid again",
			);
			expectEqual(rebuilt.attributes.speed, 4, "the attribute the rebuilt component read");

			// Destroyed rather than left behind: every later module would otherwise wait on it.
			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"hands a built component back when its tag is announced again beside an attribute that has just gone bad",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RetaggedBad", { speed: 1 });
			collectionService().AddTag(instance, "Tagged");
			const component = expectDefined(components.getComponent<Tagged>(instance), "component");

			const added = new Array<Tagged>();
			const removed = new Array<Tagged>();
			const addedConnection = components.onComponentAdded<Tagged>((value, owner) => {
				if (owner === instance) added.push(value);
			});
			const removedConnection = components.onComponentRemoved<Tagged>((value, owner) => {
				if (owner === instance) removed.push(value);
			});

			// The removal reads the tag as still there and looks again a resumption later, so the
			// added announcement reaches a component that is still attached -- and is handed it, as
			// it would be without the attribute write, rather than raising out of the handler. The
			// attribute criterion takes it down on its own, on the deferred read the attribute's
			// change scheduled: a place runs that thread in the same queue as the announcements,
			// after them, so the component is gone by the time the resumption's signals are all in.
			__harness.clearErrors();
			__harness.deferTags(() => {
				instance.SetAttribute("speed", "bad");
				collectionService().RemoveTag(instance, "Tagged");
				collectionService().AddTag(instance, "Tagged");
			});
			expectEqual(__harness.errors().size(), 0, `errors announcing the tag again: ${__harness.errors().join(" | ")}`);
			expectEqual(components.getComponent<Tagged>(instance), undefined, "component once the attribute was read");

			__harness.flush();
			expectEqual(components.getComponent<Tagged>(instance), undefined, "component a resumption later");
			expectEqual(removed.size(), 1, "removals");
			expectEqual(removed[0], component, "the component taken down");
			expectEqual(added.size(), 0, "components built again");
			addedConnection.Disconnect();
			removedConnection.Disconnect();

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"answers getComponent with nothing, not a raise, for an attribute that went bad in the same resumption",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BadNowTagged", { speed: 1 });
			collectionService().AddTag(instance, "Tagged");
			expectDefined(components.getComponent<Tagged>(instance), "component");

			// A hand removal leaves the tag and the tracker alone, and the attribute criterion is
			// read on a deferred task: for the rest of this resumption the entry still says the
			// instance qualifies. The eager path reads the attribute for itself rather than
			// building on that answer and raising out of `getComponent`.
			components.removeComponent<Tagged>(instance);
			instance.SetAttribute("speed", "bad");

			let answer: Tagged | undefined;
			expectNoThrow(() => {
				answer = components.getComponent<Tagged>(instance);
			}, "asking beside an attribute that has just gone bad");
			expectEqual(answer, undefined, "component for an instance whose attribute is invalid");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"treats a link attribute that is not a handle as invalid, and builds the component once it is cleared",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// An optional link resolves a value that is not a handle to nothing, which holds nothing
			// up, so the guard is what refuses it -- as a criterion, the way a plain attribute's is,
			// rather than raising out of the tag handler on the way into the constructor.
			const instance = folder("BadOptionalLink", { Partner: "nope" });
			expectNoThrow(() => collectionService().AddTag(instance, "Twin"), "tagging with a bad link attribute");
			expectEqual(components.getComponent<Twin>(instance), undefined, "component while the attribute is invalid");

			instance.SetAttribute("Partner", undefined);
			__harness.flush();
			expectEqual(
				components.getComponents<Twin>(instance).size(),
				1,
				"components once the attribute was cleared",
			);

			instance.Destroy();
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
			// announcement ancestry drives, not the tag itself. The engine announces it before the
			// move, while the instance still reads as parented and tagged, so the component comes
			// down a resumption later, once the removal can be told apart from a stale one.
			instance.Parent = undefined;
			__harness.flush();
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
			// takes a component down is leaving the DataModel, not losing a parent. Announced
			// before the move, as the engine does, it lands a resumption later.
			pooled.Parent = undefined;
			__harness.flush();

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

			// `Destroying` runs while the tree still stands; then the instance leaves the DataModel,
			// and its children come apart with its own connections still live, so its tree handlers
			// run for each child against a tree that is already out of the DataModel. That is the
			// engine's order (probed 2026-09-11), and a component's own `ChildRemoved` handler does
			// see it.
			expectArrayEqual(
				fired,
				["destroying:1", "descendantRemoving", "childRemoved"],
				"signals the destroyed instance fired",
			);

			// Both components still go, because it is leaving the DataModel that announces their
			// tags as gone: the owner's on the way out, and the child's with it. The engine announces
			// both before the owner has left, while each still reads as in the tree and tagged, so
			// they come down a resumption later.
			__harness.flush();
			expectArrayEqual(removed, ["Owner:DestroyOrder", "Handler:Core"], "removal notifications");
			expectEqual(components.getComponents<Handler>(core).size(), 0, "components left on the child");
			expectEqual(components.getComponents<Owner>(owner).size(), 0, "components left on the owner");

			module.extinguish();
		},
	],
	[
		"removes the component of a tagged child its container unparents from onStart when the child is announced first",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				// Both tagged in one resumption, the item first, so its component is built and started
				// before the container's `onStart` unparents it. Leaving the DataModel announces its tag
				// as gone, and the component goes with it -- once, after the container's `onStart` has
				// finished, and without starting again.
				const [container, item] = hidingTree("HideItemFirst", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "UnparentingContainer", true));

				expectEqual(item.Parent, undefined, `${mode}: the hidden item's parent`);
				const hider = expectDefined(
					components.getComponent<UnparentingContainer>(container),
					`${mode}: the container's component`,
				);
				expectEqual(
					components.getComponent<HideableItem>(item),
					undefined,
					`${mode}: the hidden item's component`,
				);
				expectEqual(
					components.getComponents<HideableItem>(item).size(),
					0,
					`${mode}: components on the hidden item`,
				);
				expectEqual(trackedCount(components, HideableItem), 0, `${mode}: entries kept for the hidden item`);
				checkItemBuilds(mode, 0);

				// Immediate behaviour announces the tag as gone inside the container's `onStart`, before
				// the move, and the tag path weighs it a resumption later; deferred behaviour delivers it
				// after the resumption. Either way the removal lands after `onStart` has returned.
				expectArrayEqual(
					hidingLog,
					deferred
						? [
								"item:new:1",
								"item:start:1",
								"container:start",
								"container:hid",
								"item:added:1",
								"item:destroy:1",
								"item:removed:1",
							]
						: [
								"item:new:1",
								"item:start:1",
								"item:added:1",
								"container:start",
								"container:hid",
								"item:removed:1",
								"item:destroy:1",
							],
					`${mode}: what happened, in order`,
				);

				// Shown again, it enters the DataModel again and its tag is announced again: a new
				// component, its state started afresh.
				resumption(deferred, () => hider.show());
				const shown = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the shown item's component`,
				);
				expectEqual(shown.build, 2, `${mode}: the build the shown item has`);
				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item], mode);
				module.extinguish();
			}
		},
	],
	[
		"builds no component for a tagged child its container unparents from onStart when the container is announced first",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				// The container first: its `onStart` unparents the item before the item's tag is
				// announced, or, under immediate behaviour, before it is even tagged. The tag of an
				// instance the DataModel no longer holds builds nothing.
				const [container, item] = hidingTree("HideContainerFirst", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "UnparentingContainer", false));

				expectEqual(item.Parent, undefined, `${mode}: the hidden item's parent`);
				const hider = expectDefined(
					components.getComponent<UnparentingContainer>(container),
					`${mode}: the container's component`,
				);
				expectEqual(
					components.getComponent<HideableItem>(item),
					undefined,
					`${mode}: the hidden item's component`,
				);
				expectEqual(trackedCount(components, HideableItem), 0, `${mode}: entries kept for the hidden item`);
				expectArrayEqual(hidingLog, ["container:start", "container:hid"], `${mode}: what happened, in order`);

				// Shown, its tag is announced for the first time, and it gets its first component.
				resumption(deferred, () => hider.show());
				const shown = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the shown item's component`,
				);
				expectEqual(shown.build, 1, `${mode}: the build the shown item has`);
				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item], mode);
				module.extinguish();
			}
		},
	],
	[
		"builds no component for a tagged child its container unparents from onStart while their tree enters the DataModel",
		() => {
			for (const deferred of [false, true]) {
				for (const itemFirst of [true, false]) {
					const what = `${deferred ? "deferred" : "immediate"}, ${itemFirst ? "item" : "container"} tagged first`;
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);
					const baseline = registryCounts(components);

					// Tagged while detached, the way a template is, then parented in: the tags of the
					// whole tree are announced as it enters, the container's ahead of its descendant's
					// whatever order they were added in. The container's `onStart` unparents the item
					// before the item's announcement is weighed, which finds it out of the DataModel.
					const [container, item] = hidingTree("HideEntering", undefined);
					tagHidingTree(container, item, "UnparentingContainer", itemFirst);
					resumption(deferred, () => (container.Parent = game.Workspace));

					expectEqual(item.Parent, undefined, `${what}: the hidden item's parent`);
					const hider = expectDefined(
						components.getComponent<UnparentingContainer>(container),
						`${what}: the container's component`,
					);
					expectEqual(
						components.getComponent<HideableItem>(item),
						undefined,
						`${what}: the hidden item's component`,
					);
					expectEqual(trackedCount(components, HideableItem), 0, `${what}: entries kept for the hidden item`);
					expectArrayEqual(
						hidingLog,
						["container:start", "container:hid"],
						`${what}: what happened, in order`,
					);

					resumption(deferred, () => hider.show());
					expectDefined(components.getComponent<HideableItem>(item), `${what}: the shown item's component`);
					checkItemBuilds(what, 1);

					expectReleased(components, baseline, [container, item], what);
					module.extinguish();
				}
			}
		},
	],
	[
		"ends with one component for a tagged child its container hides and shows again and again",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const [container, item] = hidingTree("HideToggled", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "UnparentingContainer", true));
				const hider = expectDefined(
					components.getComponent<UnparentingContainer>(container),
					`${mode}: container`,
				);

				// Shown and hidden a resumption apart: a component per showing, each gone with its hiding.
				for (const round of [1, 2, 3]) {
					resumption(deferred, () => hider.show());
					expectDefined(components.getComponent<HideableItem>(item), `${mode}: component, showing ${round}`);

					resumption(deferred, () => hider.hide());
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						0,
						`${mode}: components, hiding ${round}`,
					);
				}
				expectEqual(HideableItem.builds, 4, `${mode}: builds after three rounds`);

				// Hidden and shown again inside one resumption: the removal is weighed against an instance
				// that is back in the DataModel and still tagged, so the component that was there stays.
				resumption(deferred, () => hider.show());
				const before = expectDefined(components.getComponent<HideableItem>(item), `${mode}: component before`);
				resumption(deferred, () => {
					hider.hide();
					hider.show();
				});
				expectEqual(
					components.getComponent<HideableItem>(item),
					before,
					`${mode}: component after hiding and showing at once`,
				);

				// Shown and hidden again inside one resumption: under immediate behaviour the showing
				// builds a component and the hiding takes it away; under deferred behaviour the
				// announcement that it arrived finds it gone and builds nothing.
				resumption(deferred, () => hider.hide());
				const builds = HideableItem.builds;
				resumption(deferred, () => {
					hider.show();
					hider.hide();
				});
				expectEqual(
					components.getComponents<HideableItem>(item).size(),
					0,
					`${mode}: components after showing and hiding at once`,
				);
				expectEqual(
					HideableItem.builds,
					deferred ? builds : builds + 1,
					`${mode}: builds showing and hiding at once made`,
				);

				// And it ends shown, with one component: nothing built twice, nothing left behind.
				resumption(deferred, () => hider.show());
				expectEqual(
					components.getComponents<HideableItem>(item).size(),
					1,
					`${mode}: components on the shown item`,
				);
				expectEqual(components.getAllComponents<HideableItem>().size(), 1, `${mode}: item components anywhere`);
				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item], mode);
				module.extinguish();
			}
		},
	],
	[
		"keeps the component of a tagged child its container hides in storage that stays in the DataModel",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideStorage");
				StoringContainer.storage = storage;

				// The item first, so its component is there before the container's `onStart` moves it
				// into storage. Moving within the DataModel announces nothing, and the ancestor lists only
				// gate construction, so the component stays, under a blocked ancestor, and stays the same
				// one however often it moves.
				const [container, item] = hidingTree("HideStored", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "StoringContainer", true));

				expectEqual(item.Parent, storage, `${mode}: the stored item's parent`);
				const stored = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the stored item's component`,
				);
				const hider = expectDefined(components.getComponent<StoringContainer>(container), `${mode}: container`);

				resumption(deferred, () => hider.show());
				expectEqual(components.getComponent<HideableItem>(item), stored, `${mode}: component once shown`);
				resumption(deferred, () => hider.hide());
				expectEqual(
					components.getComponent<HideableItem>(item),
					stored,
					`${mode}: component once hidden again`,
				);
				resumption(deferred, () => {
					hider.show();
					hider.hide();
					hider.show();
				});
				expectEqual(
					components.getComponent<HideableItem>(item),
					stored,
					`${mode}: component after moving at once`,
				);

				// Its own tree moved with it, so the streaming mode has nothing to react to: its `Mesh` is
				// still there, followed on a client and read once on a server, wherever it is.
				checkItemBuilds(mode, 1);
				expectEqual(HideableItem.builds, 1, `${mode}: builds`);

				expectReleased(components, baseline, [container, item, storage], mode);
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"removes a container whose child link names the child it unparents until the child is back",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const [container, item] = hidingTree("HideLinked", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "LinkedContainer", true));
				const hider = expectDefined(components.getComponent<LinkedContainer>(container), `${mode}: container`);

				// Unparenting the item takes its component away, and the container's link names that
				// component: the container goes too, whatever the streaming mode, and stays down while
				// the item is hidden. Nothing it would have done to show the item again is left to do it.
				resumption(deferred, () => hider.hide());
				expectEqual(
					components.getComponent<HideableItem>(item),
					undefined,
					`${mode}: the hidden item's component`,
				);
				expectEqual(
					components.getComponent<LinkedContainer>(container),
					undefined,
					`${mode}: the container's component`,
				);

				// Put back from outside, the item gets a new component, and the container a new one around it.
				resumption(deferred, () => hider.show());
				const shown = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the item's component`,
				);
				const rebuilt = expectDefined(
					components.getComponent<LinkedContainer>(container),
					`${mode}: the container's component`,
				);
				expectTrue(rebuilt !== hider, `${mode}: the container's component is a new one`);
				expectEqual(rebuilt.childComponents.Item, shown, `${mode}: the component the new container links to`);
				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item], mode);
				module.extinguish();
			}
		},
	],
	[
		"removes a container whose child link names the child it moves into storage only where its tree is followed",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideLinkedStorage");
				const [container, item] = hidingTree("HideLinkedStored", game.Workspace);
				resumption(deferred, () => tagHidingTree(container, item, "LinkedContainer", true));
				const hider = expectDefined(components.getComponent<LinkedContainer>(container), `${mode}: container`);
				const original = expectDefined(components.getComponent<HideableItem>(item), `${mode}: item`);

				// The item keeps its component in storage. The container's link is part of its tree,
				// and the default streaming mode follows that tree on a client, where the child leaving
				// takes the container down, and reads it once on a server, where it keeps the child it
				// was built with.
				resumption(deferred, () => hider.hide(storage));
				expectEqual(
					components.getComponent<HideableItem>(item),
					original,
					`${mode}: the stored item's component`,
				);

				if (RunService.IsClient()) {
					expectEqual(
						components.getComponent<LinkedContainer>(container),
						undefined,
						`${mode}: the container's component`,
					);

					resumption(deferred, () => hider.show());
					const rebuilt = expectDefined(
						components.getComponent<LinkedContainer>(container),
						`${mode}: container once shown`,
					);
					expectTrue(rebuilt !== hider, `${mode}: the container's component is a new one`);
					expectEqual(
						rebuilt.childComponents.Item,
						original,
						`${mode}: the component the new container links to`,
					);
				} else {
					expectEqual(
						components.getComponent<LinkedContainer>(container),
						hider,
						`${mode}: the container's component`,
					);
					expectEqual(hider.childComponents.Item, original, `${mode}: the component it links to`);

					resumption(deferred, () => hider.show());
					expectEqual(
						components.getComponent<LinkedContainer>(container),
						hider,
						`${mode}: container once shown`,
					);
				}

				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item, storage], mode);
				module.extinguish();
			}
		},
	],
	[
		"removes a container whose link attribute names the child it unparents but keeps it when the child moves into storage",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HidePointedStorage");
				const [container, item] = hidingTree("HidePointed", game.Workspace);
				container.SetAttribute("Item", new InstanceHandle(item));
				resumption(deferred, () => tagHidingTree(container, item, "PointingContainer", true));
				const hider = expectDefined(
					components.getComponent<PointingContainer>(container),
					`${mode}: container`,
				);
				const original = expectDefined(components.getComponent<HideableItem>(item), `${mode}: item`);

				// An attribute is not part of the tree: storage is somewhere the item keeps its
				// component, and the link names that component, so the container stays.
				resumption(deferred, () => hider.hide(storage));
				expectEqual(
					components.getComponent<PointingContainer>(container),
					hider,
					`${mode}: container, item stored`,
				);
				resumption(deferred, () => hider.show());
				expectEqual(
					components.getComponent<PointingContainer>(container),
					hider,
					`${mode}: container, item shown`,
				);

				// Unparented, the item loses its component and the container its link.
				resumption(deferred, () => hider.hide());
				expectEqual(
					components.getComponent<PointingContainer>(container),
					undefined,
					`${mode}: container, item unparented`,
				);

				resumption(deferred, () => hider.show());
				const shown = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the item's component`,
				);
				const rebuilt = expectDefined(
					components.getComponent<PointingContainer>(container),
					`${mode}: container, item back`,
				);
				expectTrue(rebuilt !== hider, `${mode}: the container's component is a new one`);
				expectTrue(shown !== original, `${mode}: the item's component is a new one`);
				expectEqual(
					rebuilt.attributeComponents.Item,
					shown,
					`${mode}: the component the new container links to`,
				);
				checkItemBuilds(mode, 1);

				expectReleased(components, baseline, [container, item, storage], mode);
				module.extinguish();
			}
		},
	],
	[
		"removes a container whose tree requires the child it hides only where its tree is followed",
		() => {
			for (const deferred of [false, true]) {
				for (const unparent of [true, false]) {
					const what = `${deferred ? "deferred" : "immediate"}, ${unparent ? "unparented" : "stored"}`;
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);
					const baseline = registryCounts(components);

					const storage = folderIn(ReplicatedStorage, "HideShapedStorage");
					const [container, item] = hidingTree("HideShaped", game.Workspace);
					resumption(deferred, () => tagHidingTree(container, item, "ShapedContainer", true));
					const hider = expectDefined(
						components.getComponent<ShapedContainer>(container),
						`${what}: container`,
					);

					// A plain required child: under the default streaming mode, a client follows the tree
					// and drops the container while the child is away; a server read it once and keeps it.
					resumption(deferred, () => hider.hide(unparent ? undefined : storage));

					if (RunService.IsClient()) {
						expectEqual(
							components.getComponent<ShapedContainer>(container),
							undefined,
							`${what}: container, hidden`,
						);

						resumption(deferred, () => hider.show());
						const rebuilt = expectDefined(
							components.getComponent<ShapedContainer>(container),
							`${what}: shown`,
						);
						expectTrue(rebuilt !== hider, `${what}: the container's component is a new one`);
					} else {
						expectEqual(
							components.getComponent<ShapedContainer>(container),
							hider,
							`${what}: container, hidden`,
						);

						resumption(deferred, () => hider.show());
						expectEqual(
							components.getComponent<ShapedContainer>(container),
							hider,
							`${what}: container, shown`,
						);
					}

					checkItemBuilds(what, 1);
					expectEqual(HideableItem.builds, unparent ? 2 : 1, `${what}: item builds`);

					expectReleased(components, baseline, [container, item, storage], what);
					module.extinguish();
				}
			}
		},
	],
	[
		"keeps the registry level over a hundred hide-and-show cycles of a child its container unparents",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const [container, item] = hidingTree("HideStressUnparented", game.Workspace);
				const mesh = item.FindFirstChild("Mesh")!;
				resumption(deferred, () => tagHidingTree(container, item, "UnparentingContainer", true));
				const hider = expectDefined(
					components.getComponent<UnparentingContainer>(container),
					`${mode}: container`,
				);
				checkItemBuilds(mode, 0);
				const counts = registryCounts(components);
				const connections = connectionsOn([container, item, mesh]);

				for (let cycle = 0; cycle < 100; cycle++) {
					step(deferred, () => hider.show());
					step(deferred, () => hider.hide());
				}
				__harness.flush();

				// Every showing built a component and every hiding took it away, and the registry, the
				// signals and the instances hold exactly what they held before the first: nothing of
				// the hidden item, nothing connected to it, and none of the hundred components it had.
				checkItemBuilds(`${mode}: a hundred cycles`, 0);
				expectEqual(HideableItem.builds, 101, `${mode}: builds`);
				expectEqual(
					registryHolds(components, [item, mesh]).join(", "),
					"",
					`${mode}: what the registry holds of the item`,
				);
				expectSameCounts(counts, registryCounts(components), `${mode}: the registry after a hundred cycles`);
				expectSameCounts(
					connections,
					connectionsOn([container, item, mesh]),
					`${mode}: connections after a hundred cycles`,
				);
				expectEqual(
					__harness.connectionCount(item) + __harness.connectionCount(mesh),
					0,
					`${mode}: connections on the hidden item`,
				);
				expectArrayEqual(collectUntilReleased(removedItems), [], `${mode}: removed components still held`);

				expectReleased(components, baseline, [container, item], `${mode}: destroyed`);
				module.extinguish();
			}
		},
	],
	[
		"keeps the registry level over a hundred hide-and-show cycles of a child its container stores",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideStressStorage");
				StoringContainer.storage = storage;
				const [container, item] = hidingTree("HideStressStored", game.Workspace);
				const mesh = item.FindFirstChild("Mesh")!;
				resumption(deferred, () => tagHidingTree(container, item, "StoringContainer", true));
				const hider = expectDefined(components.getComponent<StoringContainer>(container), `${mode}: container`);
				const stored = expectDefined(
					components.getComponent<HideableItem>(item),
					`${mode}: the stored item's component`,
				);
				const counts = registryCounts(components);
				const connections = connectionsOn([container, item, mesh, storage]);

				for (let cycle = 0; cycle < 100; cycle++) {
					step(deferred, () => hider.show());
					step(deferred, () => hider.hide());
				}
				__harness.flush();

				// One component throughout, and nothing more watching anything than before the first move.
				expectEqual(
					components.getComponent<HideableItem>(item),
					stored,
					`${mode}: the component after a hundred cycles`,
				);
				checkItemBuilds(`${mode}: a hundred cycles`, 1);
				expectSameCounts(counts, registryCounts(components), `${mode}: the registry after a hundred cycles`);
				expectSameCounts(
					connections,
					connectionsOn([container, item, mesh, storage]),
					`${mode}: connections after a hundred cycles`,
				);

				expectReleased(components, baseline, [container, item, storage], `${mode}: destroyed`);
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"keeps the registry level over a hundred hide-and-show cycles of a child its container links to",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const removedContainers = weakProbe();
				let removedCount = 0;
				const removals = components.onComponentRemoved<LinkedContainer>((component) => {
					removedCount += 1;
					removedContainers.set(removedCount, component);
				});

				const storage = folderIn(ReplicatedStorage, "HideStressLinkedStorage");
				const [container, item] = hidingTree("HideStressLinked", game.Workspace);
				const mesh = item.FindFirstChild("Mesh")!;
				resumption(deferred, () => tagHidingTree(container, item, "LinkedContainer", true));
				expectDefined(components.getComponent<LinkedContainer>(container), `${mode}: container`);
				const counts = registryCounts(components);
				const connections = connectionsOn([container, item, mesh, storage]);

				// Unparented on even cycles, stored on odd ones, and put back from outside: the container
				// goes and comes back with the item's component, and on a client with its tree as well.
				for (let cycle = 0; cycle < 100; cycle++) {
					step(deferred, () => {
						item.Parent = cycle % 2 === 0 ? undefined : storage;
					});
					step(deferred, () => {
						item.Parent = container;
					});
				}
				__harness.flush();

				expectDefined(
					components.getComponent<LinkedContainer>(container),
					`${mode}: container after a hundred cycles`,
				);
				checkItemBuilds(`${mode}: a hundred cycles`, 1);
				expectEqual(HideableItem.builds, 51, `${mode}: item builds, one and one per unparenting`);
				expectEqual(removedCount, RunService.IsClient() ? 100 : 50, `${mode}: container removals`);
				expectSameCounts(counts, registryCounts(components), `${mode}: the registry after a hundred cycles`);
				expectSameCounts(
					connections,
					connectionsOn([container, item, mesh, storage]),
					`${mode}: connections after a hundred cycles`,
				);
				expectArrayEqual(collectUntilReleased(removedItems), [], `${mode}: removed item components still held`);
				expectArrayEqual(collectUntilReleased(removedContainers), [], `${mode}: removed containers still held`);

				removals.Disconnect();
				expectReleased(components, baseline, [container, item, storage], `${mode}: destroyed`);
				module.extinguish();
			}
		},
	],
	[
		"releases everything a container and its child held once they are destroyed a hundred times over",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);

				const storage = folderIn(ReplicatedStorage, "HideStressDestroyedStorage");
				StoringContainer.storage = storage;
				const baseline = registryCounts(components);
				const storageConnections = __harness.connectionCount(storage);
				const workspaceConnections = __harness.connectionCount(game.Workspace);

				// Everything each round made, and every component built on it, held weakly from here on.
				const probe = weakProbe();
				let probed = 0;
				const keep = (value: object) => {
					probed += 1;
					probe.set(probed, value);
				};
				const added = [
					components.onComponentAdded<HideableItem>(keep),
					components.onComponentAdded<UnparentingContainer>(keep),
					components.onComponentAdded<StoringContainer>(keep),
					components.onComponentAdded<LinkedContainer>(keep),
					components.onComponentAdded<PointingContainer>(keep),
					components.onComponentAdded<ShapedContainer>(keep),
				];

				// Every kind of container in turn, each built with its item, made to hide it -- from its
				// own `onStart`, or here -- and destroyed with it. Run in a function of its own, so that
				// nothing of the last round is left on this one's stack.
				const rounds = () => {
					for (let round = 0; round < 100; round++) {
						const kind = HIDING_TAGS[1 + (round % 5)];
						const [container, item] = hidingTree(`HideStressDestroyed${round}`, game.Workspace);
						const mesh = item.FindFirstChild("Mesh")!;
						keep(container);
						keep(item);
						keep(mesh);
						if (kind === "PointingContainer") container.SetAttribute("Item", new InstanceHandle(item));

						step(deferred, () => tagHidingTree(container, item, kind, true));
						if (kind === "LinkedContainer" || kind === "PointingContainer" || kind === "ShapedContainer") {
							step(deferred, () => {
								item.Parent = round % 2 === 0 ? undefined : storage;
							});
						}
						step(deferred, () => {
							container.Destroy();
							item.Destroy();
						});

						expectEqual(
							registryHolds(components, [container, item, mesh]).join(", "),
							"",
							`${mode}: what the registry holds of round ${round} (${kind})`,
						);

						for (const instance of [container, item, mesh]) {
							for (const tag of collectionService().GetTags(instance))
								collectionService().RemoveTag(instance, tag);
						}
					}
				};
				rounds();
				__harness.flush();

				expectTrue(HideableItem.builds >= 100, `${mode}: item builds: ${HideableItem.builds}`);
				checkItemBuilds(`${mode}: a hundred rounds`, 0);
				for (const connection of added) connection.Disconnect();
				expectSameCounts(baseline, registryCounts(components), `${mode}: the registry after a hundred rounds`);
				expectEqual(
					__harness.connectionCount(storage),
					storageConnections,
					`${mode}: connections on the storage`,
				);
				expectEqual(
					__harness.connectionCount(game.Workspace),
					workspaceConnections,
					`${mode}: connections on the workspace`,
				);
				expectArrayEqual(collectUntilReleased(probe), [], `${mode}: instances and components still held`);

				storage.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"builds the component of a tagged child its container stored before the child was announced once it is shown",
		() => {
			// Entering, where signals are immediate, the container's `onStart` stores the item before
			// the engine's walk of the entering tree reaches it, and the engine never announces the
			// item's tag (the harness does the same): Flamework weighs the item itself once the walk is
			// over, and refuses it in storage. Everywhere else the item's announcement finds it in
			// storage. Either way it waits there, and is built once shown.
			const missing = new Array<string>();
			for (const deferred of [false, true]) {
				for (const entering of [false, true]) {
					const what = `${deferred ? "deferred" : "immediate"}${entering ? ", entering" : ""}`;
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);

					const storage = folderIn(ReplicatedStorage, "HideStoredFirst");
					StoringContainer.storage = storage;
					const [container, item] = hidingTree(
						"HideStoredBeforeBuilt",
						entering ? undefined : game.Workspace,
					);

					// Cleaned up whatever happens, so that a failure leaves no module or tree behind for
					// the cases after it to trip over; every case below does the same.
					try {
						if (entering) {
							tagHidingTree(container, item, "StoringContainer", false);
							resumption(deferred, () => {
								container.Parent = game.Workspace;
							});
						} else {
							resumption(deferred, () => tagHidingTree(container, item, "StoringContainer", false));
						}

						const hider = expectDefined(
							components.getComponent<StoringContainer>(container),
							`${what}: container`,
						);
						expectEqual(item.Parent, storage, `${what}: the stored item's parent`);
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							0,
							`${what}: components in storage`,
						);
						expectEqual(refusedCount(components, HideableItem), 1, `${what}: refusals in storage`);
						if (entering && !deferred) {
							expectFalse(
								collectionService().GetTagged("HideableItem").includes(item),
								`${what}: the item among the tagged instances, its announcement skipped`,
							);
						}

						resumption(deferred, () => hider.show());
						const shown = components.getComponents<HideableItem>(item).size();
						if (shown !== 1) missing.push(`${what}: ${shown} components`);
					} finally {
						container.Destroy();
						storage.Destroy();
						StoringContainer.storage = undefined;
						module.extinguish();
					}
				}
			}

			expectEqual(
				missing.join(", "),
				"",
				"the variants whose item has no component once it is shown in the workspace",
			);
		},
	],
	[
		"builds the components of a stored child and of its own tagged descendant once it is shown after their tree entered the DataModel",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideGemStorage");
				StoringContainer.storage = storage;
				const [container, item] = hidingTree("HideGemTree", undefined);
				const gem = folderIn(item, "Gem");
				try {
					// The item's own tagged descendant goes into storage with it. Where signals are
					// immediate the engine announces neither, and Flamework weighs both once the walk of
					// the entering tree is over: each refused in storage, each built once shown.
					tagHidingTree(container, item, "StoringContainer", false);
					collectionService().AddTag(gem, "HideableGem");
					resumption(deferred, () => {
						container.Parent = game.Workspace;
					});

					const hider = expectDefined(
						components.getComponents<StoringContainer>(container)[0],
						`${mode}: container`,
					);
					expectEqual(item.Parent, storage, `${mode}: the stored item's parent`);
					if (!deferred) {
						expectFalse(
							collectionService().GetTagged("HideableItem").includes(item),
							`${mode}: the item among the tagged instances, its announcement skipped`,
						);
						expectFalse(
							collectionService().GetTagged("HideableGem").includes(gem),
							`${mode}: the gem among the tagged instances, its announcement skipped`,
						);
					}
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						0,
						`${mode}: item components in storage`,
					);
					expectEqual(
						components.getComponents<HideableGem>(gem).size(),
						0,
						`${mode}: gem components in storage`,
					);
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: items refused in storage`);
					expectEqual(refusedCount(components, HideableGem), 1, `${mode}: gems refused in storage`);
					// Each skipped one is watched for leaving the DataModel, which the engine does not
					// announce for it either.
					expectEqual(
						registryCounts(components).get("skipped watches"),
						deferred ? 0 : 2,
						`${mode}: skipped instances watched`,
					);
					expectEqual(
						registryCounts(components).get("announcement watches"),
						0,
						`${mode}: announcement watches`,
					);

					resumption(deferred, () => hider.show());
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						1,
						`${mode}: item components shown`,
					);
					expectEqual(components.getComponents<HideableGem>(gem).size(), 1, `${mode}: gem components shown`);
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: items refused once shown`);
					expectEqual(refusedCount(components, HideableGem), 0, `${mode}: gems refused once shown`);
					checkItemBuilds(mode, 1);

					expectReleased(components, baseline, [container, item, storage], mode);
				} finally {
					container.Destroy();
					item.Destroy();
					storage.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"builds the component of a tagged child its container moves elsewhere in the workspace as their tree enters the DataModel",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				// Not storage: a folder elsewhere in the workspace, where the lists refuse nothing.
				const elsewhere = folder("HideElsewhere");
				StoringContainer.storage = elsewhere;
				const [container, item] = hidingTree("HideMovedAway", undefined);
				try {
					// Where signals are immediate the engine skips the item's announcement here too, and
					// Flamework builds it where it went, a resumption after the walk, without its being
					// shown.
					tagHidingTree(container, item, "StoringContainer", false);
					resumption(deferred, () => {
						container.Parent = game.Workspace;
					});

					expectEqual(item.Parent, elsewhere, `${mode}: the moved item's parent`);
					if (!deferred) {
						expectFalse(
							collectionService().GetTagged("HideableItem").includes(item),
							`${mode}: the item among the tagged instances, its announcement skipped`,
						);
					}
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						1,
						`${mode}: components where it went`,
					);
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: refusals`);
					expectEqual(
						registryCounts(components).get("announcement watches"),
						0,
						`${mode}: announcement watches`,
					);
					checkItemBuilds(mode, 1);

					// Out of the DataModel its component goes, though the engine announces nothing for a
					// skipped instance; back in, it is announced afresh, and built again.
					resumption(deferred, () => {
						item.Parent = undefined;
					});
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						0,
						`${mode}: components out of the DataModel`,
					);
					expectEqual(
						registryCounts(components).get("skipped watches"),
						0,
						`${mode}: skipped instances watched`,
					);
					resumption(deferred, () => {
						item.Parent = elsewhere;
					});
					expectEqual(components.getComponents<HideableItem>(item).size(), 1, `${mode}: components back in`);
					expectEqual(HideableItem.builds, 2, `${mode}: builds`);
					checkItemBuilds(mode, 1);

					expectReleased(components, baseline, [container, item, elsewhere], mode);
				} finally {
					container.Destroy();
					item.Destroy();
					elsewhere.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"holds nothing of a tagged child its container moves elsewhere as their tree enters the DataModel once its own build destroys it",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);

				const elsewhere = folder("HideSelfDestroyedElsewhere");
				StoringContainer.storage = elsewhere;
				const [container, item] = hidingTree("HideSelfDestroyed", undefined);
				const mesh = item.FindFirstChild("Mesh")!;
				// The item's build destroys it, as an `onStart` that finds it unwanted would.
				const connection = components.onComponentAdded<HideableItem>((component) => {
					if (component.instance === item) item.Destroy();
				});
				const baseline = registryCounts(components);
				try {
					// Where signals are immediate the engine skips the item, and Flamework builds it where
					// it went, a resumption after the walk. That build takes it out of the DataModel before
					// Flamework watches it for leaving, which the engine announces no more than its
					// arrival: its component goes all the same.
					tagHidingTree(container, item, "StoringContainer", false);
					resumption(deferred, () => {
						container.Parent = game.Workspace;
					});

					expectEqual(item.Parent, undefined, `${mode}: the destroyed item's parent`);
					expectEqual(HideableItem.builds, 1, `${mode}: builds`);
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						0,
						`${mode}: components on the destroyed item`,
					);
					expectEqual(
						registryHolds(components, [item, mesh]).join(", "),
						"",
						`${mode}: what the registry holds of the destroyed item`,
					);
					expectEqual(
						registryCounts(components).get("skipped watches"),
						0,
						`${mode}: skipped instances watched`,
					);
					checkItemBuilds(mode, 0);

					expectReleased(components, baseline, [container, item, mesh, elsewhere], mode);
				} finally {
					connection.Disconnect();
					container.Destroy();
					item.Destroy();
					elsewhere.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"builds a tagged child its container moves elsewhere as their tree enters the DataModel afresh once its own build has unparented it and it is back",
		() => {
			for (const deferred of [false, true]) {
				for (const atOnce of [false, true]) {
					const mode = `${deferred ? "deferred" : "immediate"}, back ${atOnce ? "at once" : "later"}`;
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);

					const elsewhere = folder("HideSelfUnparentedElsewhere");
					StoringContainer.storage = elsewhere;
					const [container, item] = hidingTree("HideSelfUnparented", undefined);
					// The item's first build unparents it. Put back at once, it is back before the removal
					// its leaving queued has run.
					const connection = components.onComponentAdded<HideableItem>((component) => {
						if (component.instance !== item || component.build !== 1) return;

						item.Parent = undefined;
						if (atOnce) {
							task.defer(() => {
								item.Parent = elsewhere;
							});
						}
					});
					const baseline = registryCounts(components);
					try {
						tagHidingTree(container, item, "StoringContainer", false);
						resumption(deferred, () => {
							container.Parent = game.Workspace;
						});

						if (!atOnce) {
							// Out of the DataModel the first build goes, though the engine announces nothing
							// for a skipped instance, and nothing is left watching it.
							expectEqual(item.Parent, undefined, `${mode}: the unparented item's parent`);
							expectEqual(
								components.getComponents<HideableItem>(item).size(),
								0,
								`${mode}: components out of the DataModel`,
							);
							expectEqual(
								registryCounts(components).get("skipped watches"),
								0,
								`${mode}: skipped instances watched out of the DataModel`,
							);
							checkItemBuilds(`${mode}: out of the DataModel`, 0);

							resumption(deferred, () => {
								item.Parent = elsewhere;
							});
							expectEqual(HideableItem.builds, 2, `${mode}: builds`);
						}

						// Back in, it is announced as anything entering the DataModel is: built, or still
						// built, and left to the engine's own announcements from then on.
						expectEqual(item.Parent, elsewhere, `${mode}: the item's parent back in`);
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							1,
							`${mode}: components back in`,
						);
						expectEqual(
							registryCounts(components).get("skipped watches"),
							0,
							`${mode}: skipped instances watched back in`,
						);
						checkItemBuilds(`${mode}: back in`, 1);

						resumption(deferred, () => {
							item.Parent = undefined;
						});
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							0,
							`${mode}: components out again`,
						);
						checkItemBuilds(`${mode}: out again`, 0);

						expectReleased(components, baseline, [container, item, elsewhere], mode);
					} finally {
						connection.Disconnect();
						container.Destroy();
						item.Destroy();
						elsewhere.Destroy();
						StoringContainer.storage = undefined;
						module.extinguish();
					}
				}
			}
		},
	],
	[
		"builds nothing for a tagged child refused when its tag was announced once a container announced later moves it out and it would pass",
		() => {
			for (const deferred of [false, true]) {
				for (const refusal of ["predicate", "raise"]) {
					const mode = `${deferred ? "deferred" : "immediate"}, ${refusal}`;
					const tag = refusal === "predicate" ? "Picky" : "Throwy";
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);
					const built = (item: Instance) =>
						refusal === "predicate"
							? components.getComponents<Picky>(item).size()
							: components.getComponents<Throwy>(item).size();

					const elsewhere = folder("RefusedChildElsewhere");
					StoringContainer.storage = elsewhere;
					const container = folder("RefusedChildContainer");
					const item = folderIn(container, "Item");
					// Once the container's component has stored the item, the item comes to pass: named
					// `Chosen`, or given its `X`. Still inside the container's announcement, where signals
					// are immediate.
					const connection = components.onComponentAdded<StoringContainer>((component) => {
						if (component.instance !== container) return;

						if (refusal === "predicate") {
							item.Name = "Chosen";
						} else {
							folderIn(item, "X");
						}
					});
					const baseline = registryCounts(components);
					try {
						// Announced where it is, and refused for good: `Picky` is built only on an instance
						// named `Chosen`, and `Throwy`'s instance guard raises on one with no `X`.
						resumption(deferred, () => collectionService().AddTag(item, tag));
						if (refusal === "raise") {
							expectTrue(__harness.errors().size() > 0, `${mode}: the guard's raise reported`);
							__harness.clearErrors();
						}
						expectEqual(built(item), 0, `${mode}: components once announced`);
						expectTrue(
							collectionService().GetTagged(tag).includes(item),
							`${mode}: the item among the tagged instances, announced`,
						);

						// The container is tagged in the DataModel, so its announcement is its own. Its
						// `onStart` moves the item out while that announcement is acted on, and the item
						// comes to pass before anything weighs it. Its own announcement reached it, and the
						// refusal stands: nothing weighs it again.
						resumption(deferred, () => collectionService().AddTag(container, "StoringContainer"));
						expectEqual(item.Parent, elsewhere, `${mode}: the moved item's parent`);
						expectEqual(built(item), 0, `${mode}: components once it would pass`);
						expectEqual(
							registryCounts(components).get("skipped watches"),
							0,
							`${mode}: skipped instances watched`,
						);

						expectReleased(components, baseline, [container, item, elsewhere], mode);
					} finally {
						connection.Disconnect();
						container.Destroy();
						item.Destroy();
						elsewhere.Destroy();
						StoringContainer.storage = undefined;
						module.extinguish();
					}
				}
			}
		},
	],
	[
		"builds nothing for a tagged child whose instance guard raised when its tag was announced once a link has let go of it and a container announced later moves it out",
		() => {
			for (const parked of [true, false]) {
				const mode = parked ? "parked while linked" : "built through the link, removed by hand";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const elsewhere = folder("RaisedLinkedElsewhere");
				StoringContainer.storage = elsewhere;
				const container = folder("RaisedLinkedContainer");
				const item = folderIn(container, "Item");
				const park = folderIn(ReplicatedStorage, "RaisedLinkedPark");
				const target = folder("RaisedLinkedTarget");
				const pointer = folder("RaisedLinkedPointer");
				const everything = [container, item, elsewhere, park, target, pointer];
				try {
					// Announced where it is: `Throwy`'s instance guard raises on an instance with no `X`,
					// after the tag path made its entry, and the raise stands until the tag is announced
					// again.
					resumption(false, () => collectionService().AddTag(item, "Throwy"));
					expectTrue(__harness.errors().size() > 0, `${mode}: the guard's raise reported`);
					__harness.clearErrors();
					expectEqual(components.getComponents<Throwy>(item).size(), 0, `${mode}: components announced`);
					expectEqual(trackedCount(components, Throwy), 1, `${mode}: entries once announced`);

					// Given its `X` and named by a link, which reads the entry the raise left and lets go
					// of it again, releasing it. Parked in storage meanwhile, nothing is built; otherwise
					// the link builds the component, which is then removed by hand.
					folderIn(item, "X");
					if (parked) item.Parent = park;
					pointer.SetAttribute("Target", new InstanceHandle(target));
					pointer.SetAttribute("Linked", new InstanceHandle(item));
					resumption(false, () => collectionService().AddTag(pointer, "ThrowyPointer"));
					resumption(false, () => collectionService().RemoveTag(pointer, "ThrowyPointer"));
					if (parked) {
						resumption(false, () => {
							item.Parent = container;
						});
					} else {
						expectEqual(components.getComponents<Throwy>(item).size(), 1, `${mode}: built by the link`);
						components.removeComponent<Throwy>(item);
						__harness.flush();
					}
					expectEqual(components.getComponents<Throwy>(item).size(), 0, `${mode}: components let go of`);
					expectEqual(trackedCount(components, Throwy), 0, `${mode}: entries once let go of`);
					expectTrue(
						collectionService().GetTagged("Throwy").includes(item),
						`${mode}: the item among the tagged instances, announced`,
					);

					// A container announced later moves it out while that announcement is acted on. Its
					// own announcement reached it, and the raise stands: nothing weighs it again.
					resumption(false, () => collectionService().AddTag(container, "StoringContainer"));
					expectEqual(item.Parent, elsewhere, `${mode}: the moved item's parent`);
					expectEqual(components.getComponents<Throwy>(item).size(), 0, `${mode}: components moved out`);
					expectEqual(
						registryCounts(components).get("skipped watches"),
						0,
						`${mode}: skipped instances watched`,
					);
					expectEqual(__harness.errors().join(" | "), "", `${mode}: errors`);

					expectReleased(components, baseline, everything, mode);
				} finally {
					for (const instance of everything) instance.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"takes down the component of an announced child that leaves and comes back in one resumption in a tree whose container hides it once it leaves the DataModel",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);
			const baseline = registryCounts(components);

			const elsewhere = folder("HideReturnedElsewhere");
			StoringContainer.storage = elsewhere;
			const item = itemIn(game.Workspace, "Item");
			const mesh = item.FindFirstChild("Mesh")!;
			const container = enteringContainer("HideReturned");
			try {
				resumption(false, () => collectionService().AddTag(item, "HideableItem"));
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components once announced");

				// Out of the DataModel and back in, in one resumption, in a tree whose container hides it
				// as the tree enters. Its leaving is announced while it still reads as in the DataModel,
				// so the removal is weighed a resumption later, by when it is back: it reads as stale.
				// The walk skipped it, though, so the engine announces its next leaving no more than its
				// return. It keeps its component, as a move within the DataModel would, and is watched.
				resumption(false, () => {
					item.Parent = container;
					container.Parent = game.Workspace;
				});
				__harness.flush();
				expectEqual(item.Parent, elsewhere, "the hidden item's parent");
				expectFalse(
					collectionService().GetTagged("HideableItem").includes(item),
					"the item among the tagged instances, its return skipped",
				);
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components once back");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched");
				checkItemBuilds("back", 1);

				resumption(false, () => item.Destroy());
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, item, mesh, elsewhere], "released");
			} finally {
				container.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"takes down the component of a skipped child its own build unparents and puts into a second entering tree that hides it again once it leaves the DataModel",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);

			const elsewhere = folder("HideRehiddenByBuildElsewhere");
			StoringContainer.storage = elsewhere;
			const [container, item] = hidingTree("HideRehiddenByBuild", undefined);
			const mesh = item.FindFirstChild("Mesh")!;
			const second = enteringContainer("HideRehiddenByBuildSecond");
			// The item's first build unparents it and, before the removal its leaving queued has run,
			// puts it into a second container that enters the DataModel and hides it again.
			const connection = components.onComponentAdded<HideableItem>((component) => {
				if (component.instance !== item || component.build !== 1) return;

				item.Parent = undefined;
				task.defer(() => {
					item.Parent = second;
					second.Parent = game.Workspace;
				});
			});
			const baseline = registryCounts(components);
			try {
				tagHidingTree(container, item, "StoringContainer", false);
				resumption(false, () => {
					container.Parent = game.Workspace;
				});
				__harness.flush();

				// Back by the time that removal runs, but skipped again: it keeps its component, and is
				// watched for leaving.
				expectEqual(item.Parent, elsewhere, "the item's parent hidden again");
				expectFalse(
					collectionService().GetTagged("HideableItem").includes(item),
					"the item among the tagged instances, skipped again",
				);
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components hidden again");
				expectEqual(HideableItem.builds, 1, "builds");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched");
				checkItemBuilds("hidden again", 1);

				resumption(false, () => item.Destroy());
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, second, item, mesh, elsewhere], "released");
			} finally {
				connection.Disconnect();
				container.Destroy();
				second.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"takes down the component of a watched skipped child moved in one resumption into a second entering tree that hides it again once it leaves the DataModel",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);
			const baseline = registryCounts(components);

			const elsewhere = folder("HideRehiddenElsewhere");
			StoringContainer.storage = elsewhere;
			const [container, item] = hidingTree("HideRehidden", undefined);
			const mesh = item.FindFirstChild("Mesh")!;
			const second = enteringContainer("HideRehiddenSecond");
			try {
				// Skipped as the tree enters, built where it went, and watched for leaving.
				tagHidingTree(container, item, "StoringContainer", false);
				resumption(false, () => {
					container.Parent = game.Workspace;
				});
				expectEqual(item.Parent, elsewhere, "the item's parent hidden");
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components hidden");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched");

				// Into a second container that enters the DataModel and hides it again, in one
				// resumption: the watch finds it back, and the walk skipped it again. It keeps its
				// component, and is watched again.
				resumption(false, () => {
					item.Parent = second;
					second.Parent = game.Workspace;
				});
				__harness.flush();
				expectEqual(item.Parent, elsewhere, "the item's parent hidden again");
				expectFalse(
					collectionService().GetTagged("HideableItem").includes(item),
					"the item among the tagged instances, skipped again",
				);
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components hidden again");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched again");
				checkItemBuilds("hidden again", 1);

				resumption(false, () => item.Destroy());
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, second, item, mesh, elsewhere], "released");
			} finally {
				container.Destroy();
				second.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"takes down the component of a refused child that leaves and comes back in one resumption in a tree whose container stores it again once it is shown and leaves the DataModel",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);
			const baseline = registryCounts(components);

			const storage = folderIn(ReplicatedStorage, "HideRefusedReturnedStorage");
			StoringContainer.storage = storage;
			const item = itemIn(storage, "Item");
			const mesh = item.FindFirstChild("Mesh")!;
			const container = enteringContainer("HideRefusedReturned");
			try {
				resumption(false, () => collectionService().AddTag(item, "HideableItem"));
				expectEqual(refusedCount(components, HideableItem), 1, "refusals once announced");

				// Out of the DataModel and back in, in one resumption, in a tree whose container stores it
				// again as the tree enters: the removal reads as stale, the walk skipped it, and it is
				// still refused in storage. Watched all the same, for what showing it builds.
				resumption(false, () => {
					item.Parent = container;
					container.Parent = game.Workspace;
				});
				__harness.flush();
				expectEqual(item.Parent, storage, "the stored item's parent");
				expectFalse(
					collectionService().GetTagged("HideableItem").includes(item),
					"the item among the tagged instances, its return skipped",
				);
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components in storage");
				expectEqual(refusedCount(components, HideableItem), 1, "refusals in storage");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched");

				const hider = expectDefined(
					components.getComponents<StoringContainer>(container)[0],
					"the container's component",
				);
				resumption(false, () => hider.show());
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components once shown");
				checkItemBuilds("shown", 1);

				resumption(false, () => item.Destroy());
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, item, mesh, storage], "released");
			} finally {
				container.Destroy();
				item.Destroy();
				storage.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"holds nothing of an announced child that leaves and comes back in one resumption in a tree whose container hides it when a destroy queued in between runs before it is weighed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);
			const baseline = registryCounts(components);

			const elsewhere = folder("HideReturnedDestroyedElsewhere");
			StoringContainer.storage = elsewhere;
			const item = itemIn(game.Workspace, "Item");
			const mesh = item.FindFirstChild("Mesh")!;
			const container = enteringContainer("HideReturnedDestroyed");
			try {
				resumption(false, () => collectionService().AddTag(item, "HideableItem"));
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components once announced");

				// Out of the DataModel and back in, in one resumption, in a tree whose container hides it:
				// the removal its leaving announced reads as stale a resumption later, and the walk
				// skipped it. A destroy queued in between runs after that read and before the item is
				// weighed, which finds it reached, left out of `GetTagged` and out of the DataModel
				// again. The engine announces that leaving no more than its return: its component goes
				// all the same.
				resumption(false, () => {
					item.Parent = container;
					task.defer(() => item.Destroy());
					container.Parent = game.Workspace;
				});
				__harness.flush();
				expectFalse(item.IsDescendantOf(game), "the destroyed item in the DataModel");
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				expectEqual(
					registryHolds(components, [item, mesh]).join(", "),
					"",
					"what the registry holds of the destroyed item",
				);
				expectEqual(registryCounts(components).get("skipped watches"), 0, "skipped instances watched");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, item, mesh, elsewhere], "released");
			} finally {
				container.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"holds nothing of a watched skipped child moved in one resumption into a second entering tree that hides it again when a destroy queued in between runs before it is weighed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);
			const baseline = registryCounts(components);

			const elsewhere = folder("HideRehiddenDestroyedElsewhere");
			StoringContainer.storage = elsewhere;
			const [container, item] = hidingTree("HideRehiddenDestroyed", undefined);
			const mesh = item.FindFirstChild("Mesh")!;
			const second = enteringContainer("HideRehiddenDestroyedSecond");
			try {
				// Skipped as the tree enters, built where it went, and watched for leaving.
				tagHidingTree(container, item, "StoringContainer", false);
				resumption(false, () => {
					container.Parent = game.Workspace;
				});
				expectEqual(item.Parent, elsewhere, "the item's parent hidden");
				expectEqual(components.getComponents<HideableItem>(item).size(), 1, "components hidden");
				expectEqual(registryCounts(components).get("skipped watches"), 1, "skipped instances watched");

				// Into a second container that enters the DataModel and hides it again, in one
				// resumption: the watch finds it back, and the walk skipped it again. A destroy queued in
				// between runs after the watch's read and before the item is weighed, which finds it
				// reached, left out of `GetTagged` and out of the DataModel again: its component goes.
				resumption(false, () => {
					item.Parent = second;
					task.defer(() => item.Destroy());
					second.Parent = game.Workspace;
				});
				__harness.flush();
				expectFalse(item.IsDescendantOf(game), "the destroyed item in the DataModel");
				expectEqual(components.getComponents<HideableItem>(item).size(), 0, "components once destroyed");
				expectEqual(
					registryHolds(components, [item, mesh]).join(", "),
					"",
					"what the registry holds of the destroyed item",
				);
				expectEqual(registryCounts(components).get("skipped watches"), 0, "skipped instances watched");
				checkItemBuilds("destroyed", 0);

				expectReleased(components, baseline, [container, second, item, mesh, elsewhere], "released");
			} finally {
				container.Destroy();
				second.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				module.extinguish();
			}
		},
	],
	[
		"takes down the component a link or a getComponent built on a child its container hides as their tree enters once the child's tree breaks where it is followed",
		() => {
			for (const deferred of [false, true]) {
				for (const builder of ["link", "getComponent"]) {
					const mode = `${deferred ? "deferred" : "immediate"}, ${builder}`;
					const module = createComponentModule();
					const components = module.resolveDependency<Components>();
					recordHiding(components);

					const elsewhere = folder("HideEagerElsewhere");
					StoringContainer.storage = elsewhere;
					const [container, item] = hidingTree("HideEager", undefined);
					const mesh = item.FindFirstChild("Mesh")!;
					// The child's component is built inside the container's announcement, ahead of the
					// child's own: by the container's link attribute naming it, after which a listener
					// hides the child; or by a `getComponent` from a listener, after the container's
					// `onStart` has hidden it.
					let connection: { Disconnect(): void };
					if (builder === "link") {
						container.SetAttribute("Item", new InstanceHandle(item));
						connection = components.onComponentAdded<PointingContainer>((component) => {
							if (component.instance === container) component.hide(elsewhere);
						});
					} else {
						connection = components.onComponentAdded<StoringContainer>((component) => {
							if (component.instance === container) components.getComponent<HideableItem>(item);
						});
					}
					const baseline = registryCounts(components);
					try {
						const containerTag = builder === "link" ? "PointingContainer" : "StoringContainer";
						tagHidingTree(container, item, containerTag, false);
						resumption(deferred, () => {
							container.Parent = game.Workspace;
						});

						// Where signals are immediate the walk skipped the child, which then had a
						// component no announcement built. Weighed where it went, it is tracked as its
						// announcement would have it, as it is where the child is announced there.
						expectEqual(item.Parent, elsewhere, `${mode}: the hidden item's parent`);
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							1,
							`${mode}: components hidden`,
						);
						expectEqual(
							registryCounts(components).get("HideableItem: owners"),
							1,
							`${mode}: the tag path's hold on the item`,
						);
						checkItemBuilds(`${mode}: hidden`, 1);

						// Its tree broken: a client follows the tree, and takes the component down as it
						// would for any tagged instance; a server read the tree once and keeps it.
						resumption(deferred, () => {
							mesh.Parent = undefined;
						});
						const standing = RunService.IsClient() ? 0 : 1;
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							standing,
							`${mode}: components, tree broken`,
						);
						checkItemBuilds(`${mode}: tree broken`, standing);

						expectReleased(components, baseline, [container, item, mesh, elsewhere], mode);
					} finally {
						connection.Disconnect();
						container.Destroy();
						item.Destroy();
						mesh.Destroy();
						elsewhere.Destroy();
						StoringContainer.storage = undefined;
						module.extinguish();
					}
				}
			}
		},
	],
	[
		"holds nothing of a tagged child whose instance guard raised once its container has hidden it as their tree entered and it is destroyed",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const elsewhere = folder("RaisedHiddenElsewhere");
				StoringContainer.storage = elsewhere;
				const container = new Instance("Folder");
				container.Name = "RaisedHidden";
				const item = folderIn(container, "Item");
				try {
					// `Throwy`'s instance guard raises on an instance with no `X`, after the tag path made
					// its entry. Weighed where it went, as its announcement would have weighed it, the
					// raise leaves that entry, which the item's leaving the DataModel takes down.
					collectionService().AddTag(container, "StoringContainer");
					collectionService().AddTag(item, "Throwy");
					resumption(deferred, () => {
						container.Parent = game.Workspace;
					});
					expectTrue(
						__harness.errors().size() + __harness.warnings().size() > 0,
						`${mode}: the guard's raise reported`,
					);
					__harness.clearErrors();
					__harness.clearWarnings();
					expectEqual(item.Parent, elsewhere, `${mode}: the hidden item's parent`);
					expectEqual(components.getComponents<Throwy>(item).size(), 0, `${mode}: components hidden`);
					expectEqual(trackedCount(components, Throwy), 1, `${mode}: entries hidden`);

					resumption(deferred, () => item.Destroy());
					expectEqual(trackedCount(components, Throwy), 0, `${mode}: entries once destroyed`);
					expectEqual(
						registryHolds(components, [item]).join(", "),
						"",
						`${mode}: what the registry holds of the destroyed item`,
					);

					expectReleased(components, baseline, [container, item, elsewhere], mode);
				} finally {
					container.Destroy();
					item.Destroy();
					elsewhere.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"arms nothing for a skipped child once its module is extinguished while the child is weighed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();
			recordHiding(components);

			const elsewhere = folder("HideStoppedElsewhere");
			StoringContainer.storage = elsewhere;
			const [container, item] = hidingTree("HideStopped", undefined);
			const mesh = item.FindFirstChild("Mesh")!;
			// Skipped as the tree enters, the item is weighed for each of its tags: `HideableGem`
			// first, which leaves it something to watch for, then `HideableItem`, whose build the
			// listener here is told of, and extinguishes the module from.
			const connection = components.onComponentAdded<HideableItem>((component) => {
				if (component.instance === item) module.extinguish();
			});
			try {
				collectionService().AddTag(container, "StoringContainer");
				collectionService().AddTag(item, "HideableGem");
				collectionService().AddTag(item, "HideableItem");
				resumption(false, () => {
					container.Parent = game.Workspace;
				});

				// The module let go of everything as it went, and the weighing it went inside of
				// leaves nothing behind: no watch on the item, which nothing would let go of.
				expectTrue(module.isExtinguished(), "the module extinguished");
				expectEqual(item.Parent, elsewhere, "the hidden item's parent");
				expectEqual(
					registryHolds(components, [item, mesh]).join(", "),
					"",
					"what the extinguished module holds of the item",
				);
				expectEqual(registryCounts(components).get("skipped watches"), 0, "skipped instances watched");
				expectEqual(__harness.connectionCount(item), 0, "connections on the item");
				expectEqual(__harness.errors().join(" | "), "", "errors");
			} finally {
				connection.Disconnect();
				container.Destroy();
				item.Destroy();
				elsewhere.Destroy();
				StoringContainer.storage = undefined;
				if (!module.isExtinguished()) module.extinguish();
			}
		},
	],
	[
		"builds the stored child once and holds nothing when its container's construction raises after storing it",
		() => {
			const containerConnections = new Map<string, number>();
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "StashStorage");
				StashingRaiser.storage = storage;
				const [container, item] = hidingTree("StashTree", undefined);
				try {
					// The container's constructor stores the item and raises, out of the announcement:
					// nothing of the container is built, the watch on it is let go of all the same, and
					// the item is weighed, refused in storage.
					collectionService().AddTag(container, "StashingRaiser");
					collectionService().AddTag(item, "HideableItem");
					resumption(deferred, () => {
						container.Parent = game.Workspace;
					});

					const raised = __harness.errors();
					__harness.clearErrors();
					expectTrue(
						raised.some(
							(message) => message.find("raised after storing its item", 1, true)[0] !== undefined,
						),
						`${mode}: the raise reported (${raised.join(" | ")})`,
					);
					expectEqual(item.Parent, storage, `${mode}: the stored item's parent`);
					expectEqual(
						components.getComponents<StashingRaiser>(container).size(),
						0,
						`${mode}: container components`,
					);
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						0,
						`${mode}: item components in storage`,
					);
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals in storage`);
					expectEqual(
						registryCounts(components).get("announcement watches"),
						0,
						`${mode}: announcement watches`,
					);
					containerConnections.set(mode, __harness.connectionCount(container));

					// Shown by hand: built once.
					resumption(deferred, () => {
						item.Parent = container;
					});
					expectEqual(
						components.getComponents<HideableItem>(item).size(),
						1,
						`${mode}: item components shown`,
					);
					checkItemBuilds(mode, 1);
					expectEqual(HideableItem.builds, 1, `${mode}: builds`);

					expectReleased(components, baseline, [container, item, storage], mode);
				} finally {
					container.Destroy();
					item.Destroy();
					storage.Destroy();
					StashingRaiser.storage = undefined;
					module.extinguish();
				}
			}

			// What the container is left holding once its announcement is over is the same whether
			// it was watched or not.
			expectEqual(
				containerConnections.get("immediate"),
				containerConnections.get("deferred"),
				"connections on the container, watched (immediate) and not (deferred)",
			);
		},
	],
	[
		"keeps the registry level over a hundred trees whose container stores the child as they enter the DataModel",
		() => {
			const containerConnections = new Map<string, number[]>();
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideEnterStressStorage");
				StoringContainer.storage = storage;
				const services = connectionsOn([ReplicatedStorage, game.Workspace]);
				const counted = new Array<number>();
				containerConnections.set(mode, counted);
				// The cycle's tree until it is destroyed, so that one a failure leaves in the workspace
				// goes too, rather than being built by every module after this case.
				let standing = new Array<Instance>();
				try {
					// Each cycle: a tree tagged while detached enters the workspace, its container stores
					// the item, which is refused in storage, and is shown, built; then both go.
					for (let cycle = 0; cycle < 100; cycle++) {
						const [container, item] = hidingTree(`HideEnterStress${cycle}`, undefined);
						standing = [container, item];
						tagHidingTree(container, item, "StoringContainer", false);
						step(deferred, () => {
							container.Parent = game.Workspace;
						});
						const hider = expectDefined(
							components.getComponents<StoringContainer>(container)[0],
							`${mode}: container ${cycle}`,
						);
						expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals in storage ${cycle}`);
						step(deferred, () => hider.show());
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							1,
							`${mode}: item components ${cycle}`,
						);
						counted.push(__harness.connectionCount(container));
						step(deferred, () => {
							container.Destroy();
							item.Destroy();
						});
						standing = [];
					}
					__harness.flush();

					checkItemBuilds(`${mode}: a hundred trees`, 0);
					expectEqual(HideableItem.builds, 100, `${mode}: builds`);
					expectSameCounts(
						baseline,
						registryCounts(components),
						`${mode}: the registry after a hundred trees`,
					);
					expectSameCounts(
						services,
						connectionsOn([ReplicatedStorage, game.Workspace]),
						`${mode}: connections on the services after a hundred trees`,
					);
					expectArrayEqual(collectUntilReleased(removedItems), [], `${mode}: removed components still held`);

					expectReleased(components, baseline, [storage], `${mode}: destroyed`);
				} finally {
					for (const instance of standing) instance.Destroy();
					storage.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}

			// Every container held the same once shown, watched or not: no watch outlived its
			// announcement.
			const immediate = containerConnections.get("immediate") ?? [];
			const deferred = containerConnections.get("deferred") ?? [];
			expectEqual(
				new Set([...immediate, ...deferred]).size(),
				1,
				`connections on the containers: ${immediate.join(",")} / ${deferred.join(",")}`,
			);
		},
	],
	[
		"builds nothing under a blocked ancestor for a stored child whose tree is repaired there",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);

				const storage = folderIn(ReplicatedStorage, "HideRepairStorage");
				StoringContainer.storage = storage;
				const [container, item] = hidingTree("HideRepaired", game.Workspace);
				try {
					resumption(deferred, () => tagHidingTree(container, item, "StoringContainer", true));
					const stored = expectDefined(
						components.getComponent<HideableItem>(item),
						`${mode}: the stored item's component`,
					);

					const mesh = item.FindFirstChild("Mesh")!;
					resumption(deferred, () => {
						mesh.Parent = undefined;
					});
					resumption(deferred, () => {
						mesh.Parent = item;
					});

					const now = components.getComponents<HideableItem>(item)[0];
					expectTrue(
						now === undefined || now === stored,
						`${mode}: a component built under ReplicatedStorage`,
					);
				} finally {
					container.Destroy();
					storage.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"builds the component of a stored child whose tree was repaired in storage once it leaves storage",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "HideRepairedOutStorage");
				StoringContainer.storage = storage;
				const [container, item] = hidingTree("HideRepairedOut", game.Workspace);
				try {
					resumption(deferred, () => tagHidingTree(container, item, "StoringContainer", true));
					const hider = expectDefined(
						components.getComponent<StoringContainer>(container),
						`${mode}: container`,
					);

					// Read with `getComponents` throughout, which builds nothing: `getComponent` builds by
					// hand, past the ancestor lists.
					const stored = expectDefined(
						components.getComponents<HideableItem>(item)[0],
						`${mode}: the stored item's component`,
					);

					// Its tree broken and repaired in storage. A client follows the tree: it takes the
					// component down, and the entry qualifying again builds nothing under
					// ReplicatedStorage, where it waits, still tracked. A server read the tree once and
					// keeps the component.
					const mesh = item.FindFirstChild("Mesh")!;
					resumption(deferred, () => {
						mesh.Parent = undefined;
					});
					resumption(deferred, () => {
						mesh.Parent = item;
					});

					if (RunService.IsClient()) {
						expectEqual(
							components.getComponents<HideableItem>(item).size(),
							0,
							`${mode}: components in storage, tree repaired`,
						);
						expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals, tree repaired`);
						expectEqual(trackedCount(components, HideableItem), 1, `${mode}: entries, tree repaired`);
					} else {
						expectEqual(
							components.getComponents<HideableItem>(item)[0],
							stored,
							`${mode}: the stored item's component, tree repaired`,
						);
					}

					// Shown: out of storage, a client builds the entry that qualified all along, once.
					resumption(deferred, () => hider.show());
					const shown = expectDefined(
						components.getComponents<HideableItem>(item)[0],
						`${mode}: the shown item's component`,
					);
					if (RunService.IsClient()) {
						expectEqual(shown.build, 2, `${mode}: the build the shown item has`);
					} else {
						expectEqual(shown, stored, `${mode}: the shown item's component`);
					}
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: refusals once shown`);
					checkItemBuilds(mode, 1);

					expectReleased(components, baseline, [container, item, storage], mode);
				} finally {
					container.Destroy();
					storage.Destroy();
					StoringContainer.storage = undefined;
					module.extinguish();
				}
			}
		},
	],
	[
		"builds a tagged template announced in ReplicatedStorage once it is moved to the workspace and keeps it when it is moved back",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "TemplateStorage");
				const template = itemIn(storage, "Template");
				const place = folder("TemplatePlace");
				try {
					// Tagged where templates are kept: the default blocklist refuses it there, and it waits.
					resumption(deferred, () => collectionService().AddTag(template, "HideableItem"));
					expectEqual(
						components.getComponents<HideableItem>(template).size(),
						0,
						`${mode}: components in storage`,
					);
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals in storage`);

					// Moved within ReplicatedStorage: still refused, and still waiting.
					const shelf = folderIn(storage, "Shelf");
					resumption(deferred, () => {
						template.Parent = shelf;
					});
					expectEqual(
						components.getComponents<HideableItem>(template).size(),
						0,
						`${mode}: components on the shelf`,
					);
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals on the shelf`);

					// Moved to the workspace: built once, as its tag's announcement there would have built
					// it.
					resumption(deferred, () => {
						template.Parent = place;
					});
					const built = expectDefined(
						components.getComponents<HideableItem>(template)[0],
						`${mode}: the component in the workspace`,
					);
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: refusals in the workspace`);

					// Back in storage, and out again: the lists gate construction, not removal, so it keeps
					// the one it has.
					resumption(deferred, () => {
						template.Parent = storage;
					});
					expectEqual(components.getComponents<HideableItem>(template)[0], built, `${mode}: back in storage`);
					resumption(deferred, () => {
						template.Parent = place;
					});
					expectEqual(components.getComponents<HideableItem>(template)[0], built, `${mode}: out again`);
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: refusals at the end`);
					checkItemBuilds(mode, 1);

					expectReleased(components, baseline, [template, storage, place], mode);
				} finally {
					template.Destroy();
					storage.Destroy();
					place.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"builds every tagged part of a model moved out of ServerStorage into the workspace",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				const baseline = registryCounts(components);

				// A map kept in ServerStorage until the round starts, its parts tagged there, some a
				// level down.
				const map = new Instance("Model");
				map.Name = "StoredMap";
				const wing = new Instance("Model");
				wing.Name = "Wing";
				wing.Parent = map;
				const parts = new Array<Instance>();
				for (let index = 0; index < 20; index++)
					parts.push(partIn(index % 2 === 0 ? map : wing, `MapPart${index}`));
				map.Parent = ServerStorage;
				try {
					resumption(deferred, () => {
						for (const part of parts) collectionService().AddTag(part, "PartOnly");
					});
					expectEqual(
						components.getAllComponents<PartOnly>().size(),
						0,
						`${mode}: components in ServerStorage`,
					);
					expectEqual(refusedCount(components, PartOnly), 20, `${mode}: refusals in ServerStorage`);

					// The round starts: every part is built, once.
					resumption(deferred, () => {
						map.Parent = game.Workspace;
					});
					const built = parts.map((part) => components.getComponents<PartOnly>(part)[0]);
					expectEqual(
						built.filter((component) => component !== undefined).size(),
						20,
						`${mode}: parts with a component in the workspace`,
					);
					expectEqual(
						components.getAllComponents<PartOnly>().size(),
						20,
						`${mode}: components in the workspace`,
					);
					expectEqual(refusedCount(components, PartOnly), 0, `${mode}: refusals in the workspace`);

					// The round ends: back into ServerStorage, every part keeps the component it has.
					resumption(deferred, () => {
						map.Parent = ServerStorage;
					});
					expectEqual(
						parts
							.filter((part, index) => components.getComponents<PartOnly>(part)[0] === built[index])
							.size(),
						20,
						`${mode}: parts keeping their component in ServerStorage`,
					);

					expectReleased(components, baseline, [map], mode);
				} finally {
					map.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"builds the component of a tagged instance once it enters an ancestor its allowlist names",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				const baseline = registryCounts(components);

				const outside = folder("AllowlistOutside");
				const instance = folderIn(outside, "AllowlistCandidate");
				const elsewhere = folder("AllowlistElsewhere");
				const inside = folderIn(ReplicatedStorage, "AllowlistInside");
				try {
					// `Allowed` is only built under ReplicatedStorage: tagged in the workspace, it waits,
					// watched on its own.
					resumption(deferred, () => collectionService().AddTag(instance, "Allowed"));
					expectEqual(components.getComponents<Allowed>(instance).size(), 0, `${mode}: components outside`);
					expectEqual(refusedCount(components, Allowed), 1, `${mode}: refusals outside`);
					expectEqual(
						registryCounts(components).get("Allowed: refusal connections"),
						1,
						`${mode}: watches outside`,
					);

					// Moved about outside the allowlist: still refused, and still watched once.
					resumption(deferred, () => {
						instance.Parent = elsewhere;
					});
					expectEqual(components.getComponents<Allowed>(instance).size(), 0, `${mode}: components elsewhere`);
					expectEqual(
						registryCounts(components).get("Allowed: refusal connections"),
						1,
						`${mode}: watches elsewhere`,
					);

					// Into the allowlist: built, and the watch let go of.
					resumption(deferred, () => {
						instance.Parent = inside;
					});
					const built = expectDefined(
						components.getComponents<Allowed>(instance)[0],
						`${mode}: component inside`,
					);
					expectEqual(refusedCount(components, Allowed), 0, `${mode}: refusals inside`);
					expectEqual(
						registryCounts(components).get("Allowed: refusal connections") ?? 0,
						0,
						`${mode}: watches inside`,
					);

					// And out of it again: the lists gate construction, so it keeps the one it has.
					resumption(deferred, () => {
						instance.Parent = outside;
					});
					expectEqual(
						components.getComponents<Allowed>(instance)[0],
						built,
						`${mode}: component outside again`,
					);

					expectReleased(components, baseline, [outside, elsewhere, inside], mode);
				} finally {
					instance.Destroy();
					outside.Destroy();
					elsewhere.Destroy();
					inside.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"builds nothing for a tagged instance its predicate refuses once it leaves storage",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "PickyStorage");
				const unchosen = folderIn(storage, "Unchosen");
				const renamed = folderIn(storage, "Chosen");
				const control = folderIn(storage, "Chosen");
				const place = folder("PickyPlace");
				try {
					// `Picky` is built only on an instance named `Chosen`. The predicate refuses one named
					// otherwise outright, so nothing waits for it to move; the other two pass it and are
					// refused by the lists, so they wait.
					resumption(deferred, () => {
						for (const instance of [unchosen, renamed, control])
							collectionService().AddTag(instance, "Picky");
					});
					expectEqual(components.getAllComponents<Picky>().size(), 0, `${mode}: components in storage`);
					expectEqual(refusedCount(components, Picky), 2, `${mode}: refusals in storage`);

					// One of them stops passing the predicate while it waits, and all three leave
					// storage: the move is weighed the way an announcement would be, the predicate first.
					renamed.Name = "Renamed";
					resumption(deferred, () => {
						for (const instance of [unchosen, renamed, control]) instance.Parent = place;
					});
					expectEqual(
						components.getComponents<Picky>(unchosen).size(),
						0,
						`${mode}: components, never chosen`,
					);
					expectEqual(
						components.getComponents<Picky>(renamed).size(),
						0,
						`${mode}: components, renamed in storage`,
					);
					expectDefined(
						components.getComponents<Picky>(control)[0],
						`${mode}: the component chosen throughout`,
					);
					expectEqual(refusedCount(components, Picky), 0, `${mode}: refusals once out`);

					expectReleased(components, baseline, [storage, place], mode);
				} finally {
					for (const instance of [unchosen, renamed, control]) instance.Destroy();
					storage.Destroy();
					place.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"holds nothing of a refused instance destroyed while it waits",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);
				const connections = connectionsOn([ReplicatedStorage, game.Workspace]);

				// Both kinds of wait: a template under a blocked ancestor, and an instance outside the
				// allowlist. Made in a function of their own, so that nothing on this stack holds them.
				const storage = folderIn(ReplicatedStorage, "DoomedStorage");
				const outside = folder("DoomedOutside");
				try {
					const probe = weakProbe();
					const doomed = new Array<Instance>();
					(() => {
						const template = itemIn(storage, "DoomedTemplate");
						const candidate = folderIn(outside, "DoomedCandidate");
						resumption(deferred, () => {
							collectionService().AddTag(template, "HideableItem");
							collectionService().AddTag(candidate, "Allowed");
						});
						expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refused templates`);
						expectEqual(refusedCount(components, Allowed), 1, `${mode}: refused candidates`);

						doomed.push(template, template.FindFirstChild("Mesh")!, candidate);
						probe.set(1, template);
						probe.set(2, candidate);

						resumption(deferred, () => {
							template.Destroy();
							candidate.Destroy();
						});
					})();

					expectEqual(registryHolds(components, doomed).join(", "), "", `${mode}: what the registry holds`);
					expectSameCounts(baseline, registryCounts(components), `${mode}: the registry`);
					expectSameCounts(
						connections,
						connectionsOn([ReplicatedStorage, game.Workspace]),
						`${mode}: connections`,
					);
					expectEqual(HideableItem.builds, 0, `${mode}: builds`);

					// The harness keeps a destroyed instance's tags, as the engine keeps them on the
					// instance.
					for (const instance of doomed) {
						for (const tag of collectionService().GetTags(instance))
							collectionService().RemoveTag(instance, tag);
					}
					doomed.clear();
					expectArrayEqual(collectUntilReleased(probe), [], `${mode}: instances still held`);
				} finally {
					storage.Destroy();
					outside.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"lets go of a refused instance whose tag is removed while it waits",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				// Both kinds of wait: a template under a blocked ancestor, and an instance outside the
				// allowlist.
				const storage = folderIn(ReplicatedStorage, "UntaggedStorage");
				const outside = folder("UntaggedOutside");
				const place = folder("UntaggedPlace");
				const template = itemIn(storage, "UntaggedTemplate");
				const candidate = folderIn(outside, "UntaggedCandidate");
				const watched = [ReplicatedStorage, game.Workspace, template, candidate];
				const connections = connectionsOn(watched);
				try {
					resumption(deferred, () => {
						collectionService().AddTag(template, "HideableItem");
						collectionService().AddTag(candidate, "Allowed");
					});
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refused templates`);
					expectEqual(refusedCount(components, Allowed), 1, `${mode}: refused candidates`);

					// Their tags removed while they wait: nothing waits for them any more, and what
					// heard them move is let go of, the leaving watch on ReplicatedStorage and the
					// candidate's own.
					resumption(deferred, () => {
						collectionService().RemoveTag(template, "HideableItem");
						collectionService().RemoveTag(candidate, "Allowed");
					});
					const counts = registryCounts(components);
					expectEqual(refusedCount(components, HideableItem), 0, `${mode}: refused templates, untagged`);
					expectEqual(refusedCount(components, Allowed), 0, `${mode}: refused candidates, untagged`);
					expectEqual(counts.get("leaving watches") ?? 0, 0, `${mode}: leaving watches, untagged`);
					expectEqual(
						counts.get("Allowed: refusal connections") ?? 0,
						0,
						`${mode}: refusal connections, untagged`,
					);
					expectSameCounts(baseline, counts, `${mode}: the registry, untagged`);
					expectSameCounts(connections, connectionsOn(watched), `${mode}: connections, untagged`);

					// Moved where the lists would let them through: untagged, neither is built.
					resumption(deferred, () => {
						template.Parent = place;
						candidate.Parent = storage;
					});
					expectEqual(
						components.getComponents<HideableItem>(template).size(),
						0,
						`${mode}: components on the template`,
					);
					expectEqual(
						components.getComponents<Allowed>(candidate).size(),
						0,
						`${mode}: components on the candidate`,
					);
					expectEqual(HideableItem.builds, 0, `${mode}: builds`);

					expectReleased(components, baseline, [storage, outside, place], mode);
				} finally {
					template.Destroy();
					candidate.Destroy();
					storage.Destroy();
					outside.Destroy();
					place.Destroy();
					module.extinguish();
				}
			}
		},
	],
	[
		"keeps the registry level over a hundred moves of a refused instance in and out of storage",
		() => {
			for (const deferred of [false, true]) {
				const mode = deferred ? "deferred" : "immediate";
				const module = createComponentModule();
				const components = module.resolveDependency<Components>();
				recordHiding(components);
				const baseline = registryCounts(components);

				const storage = folderIn(ReplicatedStorage, "RefusedStressStorage");
				const deeper = folderIn(ServerStorage, "RefusedStressDeeper");
				const place = folder("RefusedStressPlace");
				const item = itemIn(storage, "RefusedStressItem");
				const mesh = item.FindFirstChild("Mesh")!;
				try {
					resumption(deferred, () => collectionService().AddTag(item, "HideableItem"));
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals at the start`);

					const counts = registryCounts(components);
					const connections = connectionsOn([item, mesh, storage, deeper, place]);
					const services = connectionsOn([ReplicatedStorage, ServerStorage, game.Workspace]);

					// Each cycle: into ServerStorage, still refused and watched under it instead; out to
					// the workspace, built; out of the DataModel, removed; and back into storage, refused
					// again. A cycle whose move to the workspace builds nothing is named with
					// what it logged (it failed once in a full Lune run, 99 builds, and rarely
					// since).
					const unbuilt = new Array<string>();
					for (let cycle = 0; cycle < 100; cycle++) {
						const logged = hidingLog.size();
						const built = HideableItem.builds;
						step(deferred, () => {
							item.Parent = deeper;
						});
						step(deferred, () => {
							item.Parent = place;
						});
						if (HideableItem.builds !== built + 1) {
							const since = new Array<string>();
							for (let index = logged; index < hidingLog.size(); index++) since.push(hidingLog[index]);
							unbuilt.push(
								`cycle ${cycle}: ${HideableItem.builds - built} builds, ${refusedCount(components, HideableItem)} refused, logged [${since.join(", ")}]`,
							);
						}
						step(deferred, () => {
							item.Parent = undefined;
						});
						step(deferred, () => {
							item.Parent = storage;
						});
					}
					__harness.flush();

					// Every cycle built one component and took it away, and the registry, the signals and
					// the instances hold exactly what they held while the first refusal waited.
					expectEqual(unbuilt.join("; "), "", `${mode}: cycles whose move to the workspace built nothing`);
					checkItemBuilds(`${mode}: a hundred cycles`, 0);
					expectEqual(HideableItem.builds, 100, `${mode}: builds`);
					expectEqual(refusedCount(components, HideableItem), 1, `${mode}: refusals at the end`);
					expectSameCounts(
						counts,
						registryCounts(components),
						`${mode}: the registry after a hundred cycles`,
					);
					expectSameCounts(
						connections,
						connectionsOn([item, mesh, storage, deeper, place]),
						`${mode}: connections after a hundred cycles`,
					);
					expectSameCounts(
						services,
						connectionsOn([ReplicatedStorage, ServerStorage, game.Workspace]),
						`${mode}: connections on the services after a hundred cycles`,
					);
					expectArrayEqual(collectUntilReleased(removedItems), [], `${mode}: removed components still held`);

					expectReleased(components, baseline, [item, storage, deeper, place], `${mode}: destroyed`);
				} finally {
					item.Destroy();
					storage.Destroy();
					deeper.Destroy();
					place.Destroy();
					module.extinguish();
				}
			}
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
		"builds a freshly tagged component eagerly when a link already tracks its instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The pointer's link gives `Handler`'s tracker an entry for the untagged instance, whose
			// tag criterion only the announcement writes. The eager path reads the tag now, as it
			// does with no entry at all.
			const linked = folder("EagerTrackedLinked");
			pointer("EagerTrackedPointer", folder("EagerTrackedTarget"), linked);

			let built: Handler | undefined;
			__harness.deferTags(() => {
				collectionService().AddTag(linked, "Handler");
				built = expectDefined(components.getComponent<Handler>(linked), "component inside the resumption");
			});

			expectEqual(components.getComponent<Handler>(linked), built, "component once the tag was announced");

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
			// old child is unparented rather than moved, which is what a place does when it pools a
			// part instead of destroying it: its own tag is announced as gone on the way out, and
			// the link still has to weigh the tree rather than that announcement.
			let second!: Folder;
			__harness.deferSignals(() => {
				__harness.deferTags(() => {
					__harness.deferTree(() => {
						second = folderIn(instance, "Core");
						collectionService().AddTag(second, "Handler");
						first.Parent = undefined;
					});
				});
			});
			__harness.flush();

			const rebuilt = expectDefined(components.getComponent<Owner>(instance), "component after the swap");
			expectEqual(owner.destroyCount, 1, "takedowns of the component that held the old child");
			expectTrue(rebuilt !== owner, "the component was rebuilt rather than left holding the old child");
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(second), "the new child");

			instance.Destroy();
			first.Destroy();
			module.extinguish();
		},
	],
	[
		"re-points a child link when the child it holds is renamed away and a sibling takes its name",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RenamedLink");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Handler");
			const spare = folderIn(instance, "Spare");
			collectionService().AddTag(instance, "Owner");

			const owner = expectDefined(components.getComponent<Owner>(instance), "component");
			try {
				// A rename fires no child signal, so the link learns of the swap from the child's
				// own name: `Core` now names a child that carries no `Handler`, and the component
				// built around the old one comes down.
				__harness.deferTree(() => {
					core.Name = "Old";
					spare.Name = "Core";
				});
				__harness.flush();
				expectEqual(owner.destroyCount, 1, "takedowns after the swap");
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component while the child named Core has no Handler",
				);

				// The child the name resolves to now is the one the link watches: its component
				// arriving builds the owner around it, and leaving takes the owner down again.
				collectionService().AddTag(spare, "Handler");
				__harness.flush();
				const rebuilt = expectDefined(
					components.getComponent<Owner>(instance),
					"component once the new Core carries Handler",
				);
				expectEqual(
					rebuilt.childComponents.Core,
					components.getComponent<Handler>(spare),
					"the child it holds",
				);

				collectionService().RemoveTag(spare, "Handler");
				__harness.flush();
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component after the new Core lost its Handler",
				);
				expectEqual(rebuilt.destroyCount, 1, "takedowns of the rebuilt component");

				// Renamed back, the old child is `Core` again, and the link follows it there too.
				__harness.deferTree(() => {
					spare.Name = "Spare";
					core.Name = "Core";
				});
				__harness.flush();
				const restored = expectDefined(
					components.getComponent<Owner>(instance),
					"component once the old child is Core again",
				);
				expectEqual(
					restored.childComponents.Core,
					components.getComponent<Handler>(core),
					"the child it holds again",
				);
			} finally {
				instance.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"re-points a child link when the child it holds is renamed away before a sibling takes its name",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RenamedLinkInOrder");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Handler");
			const spare = folderIn(instance, "Spare");
			const bystander = folderIn(instance, "Bystander");
			collectionService().AddTag(instance, "Owner");

			const owner = expectDefined(components.getComponent<Owner>(instance), "component");
			try {
				expectEqual(__harness.connectionCount(bystander), 0, "connections on a bystander while Core resolves");

				// Heard one at a time, as a place that does not defer them delivers them: the held
				// child's rename resolves the name to nothing, and the sibling's rename after it is
				// announced by the sibling alone. So while the name resolves to nothing, every other
				// child is followed for it, and the sibling taking the name is heard from the sibling.
				core.Name = "Old";
				__harness.flush();
				expectEqual(owner.destroyCount, 1, "takedowns after the rename away");
				expectTrue(
					__harness.connectionCount(bystander) > 0,
					"a bystander is followed while Core names nothing",
				);

				spare.Name = "Core";
				__harness.flush();
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component while the child named Core has no Handler",
				);
				expectEqual(
					__harness.connectionCount(bystander),
					0,
					"connections on the bystander once Core resolves again",
				);

				collectionService().AddTag(spare, "Handler");
				__harness.flush();
				const rebuilt = expectDefined(
					components.getComponent<Owner>(instance),
					"component once the new Core carries Handler",
				);
				expectEqual(
					rebuilt.childComponents.Core,
					components.getComponent<Handler>(spare),
					"the child it holds",
				);

				collectionService().RemoveTag(spare, "Handler");
				__harness.flush();
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component after the new Core lost its Handler",
				);

				// Renamed back the same way: the sibling renamed away empties the name, and the old
				// child -- followed once more as a candidate, since it is no longer the one held --
				// taking it back is heard from the old child.
				spare.Name = "Spare";
				core.Name = "Core";
				__harness.flush();
				const restored = expectDefined(
					components.getComponent<Owner>(instance),
					"component once the old child is Core again",
				);
				expectEqual(
					restored.childComponents.Core,
					components.getComponent<Handler>(core),
					"the child it holds again",
				);
				expectEqual(__harness.connectionCount(bystander), 0, "connections on the bystander at the end");
			} finally {
				instance.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"rebuilds a component around the child that replaced the one it was built with",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const root = folder("SwappedUnwatched");
			const model = new Instance("Model");
			model.Name = "SwappedUnwatchedModel";
			model.Parent = root;

			const core = partIn(model, "Core");
			const target = partIn(root, "SwappedUnwatchedTarget");
			const linked = partIn(root, "SwappedUnwatchedLinked");

			const created = Chassis.created;
			const destroyed = Chassis.destroyed;

			let component!: Chassis;
			let replacement!: Part;

			// Everything a place defers, deferred: the tags, the tree, and the BindableEvents a
			// component's own announcements go through. `getComponent` builds the component out of
			// the tree as it stands, while the tag that gives it a tracker entry -- and with it the
			// watchers that follow that tree -- is not announced until this resumption ends. The
			// swap happens in the window between the two, which is a window every place has.
			__harness.deferSignals(() => {
				__harness.deferTags(() => {
					__harness.deferTree(() => {
						collectionService().AddTag(linked, "Bolt");
						model.SetAttribute("Target", new InstanceHandle(target));
						model.SetAttribute("Linked", new InstanceHandle(linked));
						collectionService().AddTag(model, "Chassis");
						collectionService().AddTag(core, "Bolt");

						component = expectDefined(components.getComponent<Chassis>(model), "component");
						expectEqual(component.childComponents.Core.instance, core, "the child it was built with");

						// The child leaves the DataModel entirely and one of the same name takes its
						// place, before a single one of the announcements above has been delivered.
						core.Parent = undefined;
						replacement = partIn(model, "Core");
						collectionService().AddTag(replacement, "Bolt");
					});
				});
			});
			__harness.flush();

			expectEqual(Chassis.created - created, 2, "constructions");
			expectEqual(Chassis.destroyed - destroyed, 1, "takedowns");

			const swapped = expectDefined(components.getComponent<Chassis>(model), "component after the swap");
			expectTrue(swapped !== component, "the component was rebuilt rather than left holding the old child");
			expectEqual(swapped.childComponents.Core, components.getComponent<Bolt>(replacement), "the new child");
			expectEqual(components.getComponent<Bolt>(core), undefined, "the component on the child that left");

			root.Destroy();
			core.Destroy();
			module.extinguish();
		},
	],
	[
		"rebuilds a component whose linked child was swapped while only a link was watching it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const outer = folder("ObservedSwapOuter");
			const inner = folder("ObservedSwapInner");
			const oldCore = folderIn(inner, "Core");
			outer.SetAttribute("Inner", new InstanceHandle(inner));

			// The pointer is announced first, and its link builds `Owner` on the inner instance
			// against a tracker entry the link created -- one nothing waits on until the inner
			// instance's own tag is announced. The swap happens in between, so the only thing that
			// hears the loss is a link, which cannot take the component down.
			let built: Owner | undefined;
			let newCore!: Folder;
			const connection = components.onComponentAdded<OwnerPointer>(() => {
				if (built !== undefined) return;
				built = expectDefined(components.getComponent<Owner>(inner), "component built through the link");

				newCore = folderIn(inner, "Core");
				collectionService().AddTag(newCore, "Handler");
				oldCore.Parent = folder("ObservedSwapElsewhere");
			});

			__harness.deferTags(() => {
				collectionService().AddTag(oldCore, "Handler");
				collectionService().AddTag(outer, "OwnerPointer");
				collectionService().AddTag(inner, "Owner");
			});
			__harness.flush();
			connection.Disconnect();

			const first = expectDefined(built, "component built through the link");
			const rebuilt = expectDefined(components.getComponent<Owner>(inner), "component after the announcements");
			expectEqual(first.destroyCount, 1, "takedowns of the component that held the old child");
			expectTrue(rebuilt !== first, "the component was rebuilt rather than left holding the old child");
			expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(newCore), "the new child");

			outer.Destroy();
			inner.Destroy();
			module.extinguish();
		},
	],
	[
		"rebuilds a component whose linked child was swapped while only a dependent was waiting at it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("DependentSwap");
			const elsewhere = folder("DependentSwapElsewhere");
			const oldCore = addCore(instance);
			const newCore = addCore(elsewhere);
			collectionService().AddTag(oldCore, "Handler");
			collectionService().AddTag(newCore, "Handler");

			// The dependent's tag creates `Owner`'s entry on the instance, with the dependent waiting
			// at it and nothing owning it: the tag path has not read it yet.
			collectionService().AddTag(instance, "OwnerCar");
			expectEqual(components.getComponent<OwnerCar>(instance), undefined, "dependent before the owner exists");

			let built: Owner | undefined;
			try {
				__harness.deferTags(() => {
					collectionService().AddTag(instance, "Owner");
					built = components.getComponent<Owner>(instance);
					expectDefined(components.getComponent<OwnerCar>(instance), "dependent once the owner was built");

					// The swap reaches the entry with only the dependent listening, which takes its
					// own component down and cannot take the owner's: the loss is one the tag's
					// announcement still has to replay, as it does with a link watching instead.
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
				});
				__harness.flush();

				const first = expectDefined(built, "component built before its tag was announced");
				const rebuilt = expectDefined(
					components.getComponent<Owner>(instance),
					"component after the announcement",
				);
				expectEqual(first.destroyCount, 1, "takedowns of the component that held the old child");
				expectTrue(rebuilt !== first, "the component was rebuilt rather than left holding the old child");
				expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(newCore), "the new child");
			} finally {
				instance.Destroy();
				elsewhere.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"keeps a component built before its tag was announced when nothing about it changed",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const pointer = folder("UnchangedPointer");
			const inner = folder("UnchangedInner");
			const core = addCore(inner);
			collectionService().AddTag(pointer, "OwnerPointer");
			__harness.flush();

			let built: Owner | undefined;
			__harness.deferTags(() => {
				collectionService().AddTag(inner, "Owner");

				// The pointer's link creates `Owner`'s entry on the inner instance with the tag
				// present and the guard met, and its own child link unmet: `Core` carries no
				// `Handler` yet. That first reading is a loss nobody hears, and the component is
				// built after it, from everything the loss described.
				pointer.SetAttribute("Inner", new InstanceHandle(inner));

				collectionService().AddTag(core, "Handler");
				built = components.getComponent<Owner>(inner);
			});

			// The announcement finds nothing changed since the construction, so it hands the same
			// component back rather than replaying the loss the component was built after.
			const owner = expectDefined(built, "component asked for before its tag was announced");
			expectEqual(owner.destroyCount, 0, "takedowns by the tag's announcement");
			expectEqual(components.getComponent<Owner>(inner), owner, "the component after the announcement");
			expectEqual(
				owner.childComponents.Core,
				components.getComponent<Handler>(core),
				"the linked component it holds",
			);

			pointer.Destroy();
			inner.Destroy();
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
		"asks a component's child link again when its tag arrives at an entry a link created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// `FrozenOwner` reads its tree once, and its child link with it. The pointer's link
			// creates the entry while there is no `Core` at all, so the link is read as unmet -- an
			// answer nothing would ever correct if the entry kept it, where an instance nothing
			// links to would be read afresh when its tag arrives.
			const inner = folder("FrozenPointedInner");
			const outer = folder("FrozenPointedOuter");
			outer.SetAttribute("Inner", new InstanceHandle(inner));
			collectionService().AddTag(outer, "FrozenOwnerPointer");
			__harness.flush();
			expectEqual(
				components.getComponent<FrozenOwnerPointer>(outer),
				undefined,
				"owner before the target is tagged",
			);

			// The control: the same instance and the same order, with nothing linked to it.
			const control = folder("FrozenPointedControl");

			for (const instance of [inner, control]) {
				collectionService().AddTag(addCore(instance), "Handler");
				collectionService().AddTag(instance, "FrozenOwner");
			}

			__harness.flush();

			expectDefined(components.getComponent<FrozenOwner>(control), "the component nothing links to");
			expectDefined(components.getComponent<FrozenOwner>(inner), "the component a link watches");
			expectDefined(components.getComponent<FrozenOwnerPointer>(outer), "owner once the link is met");

			// The eager path asks the same entry a resumption earlier, before the tag is announced.
			const eagerInner = folder("FrozenPointedEagerInner");
			const eagerOuter = folder("FrozenPointedEagerOuter");
			eagerOuter.SetAttribute("Inner", new InstanceHandle(eagerInner));
			collectionService().AddTag(eagerOuter, "FrozenOwnerPointer");
			__harness.flush();

			collectionService().AddTag(addCore(eagerInner), "Handler");
			__harness.deferTags(() => {
				collectionService().AddTag(eagerInner, "FrozenOwner");
				expectDefined(components.getComponent<FrozenOwner>(eagerInner), "the component asked for eagerly");
			});
			expectDefined(components.getComponent<FrozenOwnerPointer>(eagerOuter), "owner once the eager link is met");

			outer.Destroy();
			inner.Destroy();
			control.Destroy();
			eagerOuter.Destroy();
			eagerInner.Destroy();
			module.extinguish();
		},
	],
	[
		"asks a component's instance guard again when its tag arrives at an entry a dependency created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The dependent's tag creates `Strict`'s entry while there is no `Root`, so its guard is
			// read as failing -- and `Strict` reads its tree once. The dependent waits at that
			// entry, which is not the same as the tag path having read it: nothing keeps it
			// current, and the tag arriving has to read the tree the way it would with no entry.
			const instance = folder("StrictDependent");
			collectionService().AddTag(instance, "StrictCar");
			expectEqual(components.getComponent<StrictCar>(instance), undefined, "dependent before Strict exists");

			// The control: the same instance and the same order, with nothing depending on it.
			const control = folder("StrictDependentControl");

			for (const target of [instance, control]) {
				folderIn(target, "Root");
				collectionService().AddTag(target, "Strict");
			}

			__harness.flush();

			expectDefined(components.getComponent<Strict>(control), "the component nothing depends on");
			expectDefined(components.getComponent<Strict>(instance), "the component a dependent waits for");
			expectDefined(components.getComponent<StrictCar>(instance), "the dependent once its dependency is built");

			instance.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"asks a component's child link again when its tag arrives at an entry a dependency created",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// As above, for a link read once: the dependent's tag creates `FrozenOwner`'s entry
			// while there is no `Core` at all.
			const instance = folder("FrozenDependent");
			collectionService().AddTag(instance, "FrozenOwnerCar");
			expectEqual(
				components.getComponent<FrozenOwnerCar>(instance),
				undefined,
				"dependent before the owner exists",
			);

			const control = folder("FrozenDependentControl");

			for (const target of [instance, control]) {
				collectionService().AddTag(addCore(target), "Handler");
				collectionService().AddTag(target, "FrozenOwner");
			}

			__harness.flush();

			expectDefined(components.getComponent<FrozenOwner>(control), "the component nothing depends on");
			expectDefined(components.getComponent<FrozenOwner>(instance), "the component a dependent waits for");
			expectDefined(
				components.getComponent<FrozenOwnerCar>(instance),
				"the dependent once its dependency is built",
			);

			instance.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"builds a freshly tagged component eagerly when a dependency already tracks its instance",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The control: nothing tracks the instance, so the eager path reads the tag itself.
			const control = folder("EagerEngineControl");
			__harness.deferTags(() => {
				collectionService().AddTag(control, "Engine");
				expectDefined(components.getComponent<Engine>(control), "engine nothing depends on, asked for eagerly");
			});

			// `Car` depends on `Engine`, so Engine's entry exists before Engine's own tag is
			// announced, with its tag criterion written only by that announcement. The eager path
			// asks in between, and has to read the tag now, as it does with no entry at all.
			const instance = folder("EagerEngine");
			collectionService().AddTag(instance, "Car");
			expectEqual(components.getComponent<Car>(instance), undefined, "car before its engine");

			__harness.deferTags(() => {
				collectionService().AddTag(instance, "Engine");
				expectDefined(
					components.getComponent<Engine>(instance),
					"engine a dependent waits for, asked for eagerly",
				);
			});
			expectDefined(components.getComponent<Car>(instance), "car once its engine exists");

			instance.Destroy();
			control.Destroy();
			module.extinguish();
		},
	],
	[
		"takes a component down when the component a re-read child link names goes, whatever the streaming mode",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const inner = folder("RereadInner");
			const outer = folder("RereadOuter");

			// The link creates the entry before `Core` exists: the child link is read once as unmet,
			// and only the re-read at the tag's arrival sees the child. What that re-read resolves
			// to is what the link watches from then on.
			outer.SetAttribute("Inner", new InstanceHandle(inner));
			collectionService().AddTag(outer, "FrozenOwnerPointer");
			__harness.flush();

			const core = addCore(inner);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(inner, "FrozenOwner");
			__harness.flush();
			const owner = expectDefined(components.getComponent<FrozenOwner>(inner), "owner");
			expectDefined(components.getComponent<FrozenOwnerPointer>(outer), "pointer");
			expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "the linked component");

			// The component the link names goes, which is a lifecycle event rather than the tree
			// moving, and is noticed under a streaming mode that reads the tree once.
			collectionService().RemoveTag(core, "Handler");
			__harness.flush();
			expectEqual(components.getComponent<Handler>(core), undefined, "handler after its tag went");
			expectEqual(
				components.getComponent<FrozenOwner>(inner),
				undefined,
				"owner after its linked component went",
			);
			expectEqual(components.getComponent<FrozenOwnerPointer>(outer), undefined, "pointer after the owner went");

			inner.Destroy();
			outer.Destroy();
			module.extinguish();
		},
	],
	[
		"re-points a re-read child link at the child the component was built from",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const inner = folder("RepointedInner");
			const outer = folder("RepointedOuter");
			const elsewhere = folder("RepointedElsewhere");
			const core1 = addCore(inner);
			collectionService().AddTag(core1, "Handler");

			// The link creates the entry with the first child in place, so the child link watches it.
			outer.SetAttribute("Inner", new InstanceHandle(inner));
			collectionService().AddTag(outer, "FrozenOwnerPointer");
			__harness.flush();

			// The child is swapped while nothing follows the tree, and then the tag arrives: the
			// component is built out of the tree as it is now, and the link is re-pointed at that
			// child rather than left on the one it happened to see first.
			core1.Parent = elsewhere;
			const core2 = addCore(inner);
			collectionService().AddTag(core2, "Handler");
			__harness.flush();
			collectionService().AddTag(inner, "FrozenOwner");
			__harness.flush();

			const owner = expectDefined(components.getComponent<FrozenOwner>(inner), "owner");
			expectEqual(
				owner.childComponents.Core,
				components.getComponent<Handler>(core2),
				"built from the child the tree holds",
			);

			// The first child loses its component, which the owner was never built from.
			collectionService().RemoveTag(core1, "Handler");
			__harness.flush();
			expectEqual(
				components.getComponent<FrozenOwner>(inner),
				owner,
				"owner after a component it does not hold went",
			);
			expectEqual(
				owner.childComponents.Core,
				components.getComponent<Handler>(core2),
				"the linked component it holds",
			);

			// The child it was built from loses its component: now the owner goes.
			collectionService().RemoveTag(core2, "Handler");
			__harness.flush();
			expectEqual(
				components.getComponent<FrozenOwner>(inner),
				undefined,
				"owner after its linked component went",
			);

			inner.Destroy();
			outer.Destroy();
			elsewhere.Destroy();
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
		"paces its wait for a link attribute whose handle names nothing",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const linked = handlerFolder("NothingLinked");
			const instance = folder("NothingPointer");
			instance.SetAttribute("Target", new InstanceHandle(undefined));
			instance.SetAttribute("Linked", new InstanceHandle(linked));

			// A handle made from nothing has nothing to wait for, and the engine's `Wait` answers at
			// once rather than after its timeout: the wait for it has to pace itself, or it asks
			// again in the same breath until the engine kills the thread.
			collectionService().AddTag(instance, "Pointer");
			task.wait(0.1);

			expectEqual(
				components.getComponent<Pointer>(instance),
				undefined,
				"component while the handle names nothing",
			);

			// Pointed at something, the link follows.
			const target = folder("NothingTarget");
			instance.SetAttribute("Target", new InstanceHandle(target));

			const component = expectDefined(
				components.getComponent<Pointer>(instance),
				"component once the handle names something",
			);
			expectEqual(component.attributes.Target, target, "attribute holds the instance");

			instance.Destroy();
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
			expectTrue(
				message.find("child 'Root' is missing (expected Folder)", 1, true)[0] !== undefined,
				"message says what is wrong",
			);
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
			const plugin = ComponentPlugin.builder().registerComponent(Owner).build();

			const message = expectThrows(
				() => Flamework.createModule().includePlugin(plugin).ignite(),
				"ignition with an unregistered link",
			);

			expectTrue(
				message.find("not registered in any ComponentPlugin of this module")[0] !== undefined,
				"message explains the link",
			);
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
		"leaves an atomic model's child link unwatched",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const model = new Instance("Model");
			model.Name = "AtomicLinkModel";
			model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic;
			model.Parent = game.Workspace;

			const core = addCore(model);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(model, "AtomicOwner");
			const owner = expectDefined(components.getComponent<AtomicOwner>(model), "component");

			// A child link is part of the tree, and the tree is read once on both realms: the server
			// never follows it, and on the client an atomic model streams in whole.
			core.Parent = folder("AtomicLinkElsewhere");
			__harness.flush();
			expectEqual(components.getComponent<AtomicOwner>(model), owner, "component after the child moved away");

			model.Destroy();
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
	[
		"keeps a watched component while a second child of the required name comes and goes",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Doubled");
			const core = addCore(instance);
			collectionService().AddTag(instance, "Watched");
			const component = expectDefined(components.getComponent<Watched>(instance), "component");

			// A second `Core` is not the one `this.instance.Core` reads, so it is none of the
			// tree's business: not arriving, not being there while something unrelated moves, and
			// not leaving.
			const spare = folderIn(instance, "Core");
			__harness.flush();
			expectEqual(components.getComponent<Watched>(instance), component, "component after a second Core arrived");

			folderIn(instance, "Extra").Destroy();
			__harness.flush();
			expectEqual(
				components.getComponent<Watched>(instance),
				component,
				"component after an unrelated child came and went",
			);

			spare.Destroy();
			__harness.flush();
			expectEqual(components.getComponent<Watched>(instance), component, "component after the second Core left");

			// The one it reads leaving is the tree breaking.
			core.Destroy();
			__harness.flush();
			expectEqual(components.getComponent<Watched>(instance), undefined, "component after the Core it read left");

			module.extinguish();
		},
	],
	[
		"reads the next child of the required name when the one it read leaves",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Succession");
			const first = addCore(instance);
			const second = addCore(instance);
			collectionService().AddTag(instance, "Watched");
			const component = expectDefined(components.getComponent<Watched>(instance), "component");
			expectEqual(instance.FindFirstChild("Core"), first, "the Core the component reads");

			// The name resolves to the second one now, which is the same tree as far as the guard
			// is concerned: a plain child is read through the instance, not held.
			first.Destroy();
			__harness.flush();
			expectEqual(components.getComponent<Watched>(instance), component, "component after the first Core left");
			expectEqual(instance.FindFirstChild("Core"), second, "the Core the component reads now");

			module.extinguish();
		},
	],
	[
		"builds a component when a child two levels down arrives, and drops it when that child leaves",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("DeepTree");
			const root = folderIn(instance, "Root");
			collectionService().AddTag(instance, "Deep");
			expectEqual(components.getComponent<Deep>(instance), undefined, "component while Root has no Texture");

			const texture = folderIn(root, "Texture");
			__harness.flush();
			const built = expectDefined(components.getComponent<Deep>(instance), "component once the Texture arrived");

			// Something else under Root is not part of the tree.
			folderIn(root, "Decal").Destroy();
			__harness.flush();
			expectEqual(
				components.getComponent<Deep>(instance),
				built,
				"component after an unrelated grandchild came and went",
			);

			texture.Parent = undefined;
			__harness.flush();
			expectEqual(components.getComponent<Deep>(instance), undefined, "component after the Texture left");

			texture.Parent = root;
			__harness.flush();
			expectDefined(components.getComponent<Deep>(instance), "component once the Texture returned");

			module.extinguish();
		},
	],
	[
		"re-resolves a required child when it is renamed away, and when it is renamed back",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Renamed");
			const core = addCore(instance);
			collectionService().AddTag(instance, "Watched");
			expectDefined(components.getComponent<Watched>(instance), "component");

			core.Name = "Shell";
			__harness.flush();
			expectEqual(
				components.getComponent<Watched>(instance),
				undefined,
				"component after its Core was renamed away",
			);

			core.Name = "Core";
			__harness.flush();
			expectDefined(components.getComponent<Watched>(instance), "component once the child is Core again");

			module.extinguish();
		},
	],
	[
		"leaves names alone unless asked to, and still follows children arriving and leaving",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Unrenamed");
			const core = addCore(instance);
			collectionService().AddTag(instance, "Unrenamed");
			const built = expectDefined(components.getComponent<Unrenamed>(instance), "component");
			expectEqual(__harness.connectionCount(core), 0, "connections on the child with names not followed");

			// A rename is announced by nothing that is listened to, so the component stands on a
			// tree that no longer has a `Core`, until the child it read leaves for real.
			core.Name = "Shell";
			__harness.flush();
			expectEqual(
				components.getComponent<Unrenamed>(instance),
				built,
				"component after a rename nothing follows",
			);

			core.Parent = undefined;
			__harness.flush();
			expectEqual(components.getComponent<Unrenamed>(instance), undefined, "component after the child left");

			// A child of the name arriving is heard; a sibling renamed into it is not.
			const spare = folderIn(instance, "Spare");
			spare.Name = "Core";
			__harness.flush();
			expectEqual(
				components.getComponent<Unrenamed>(instance),
				undefined,
				"component after a sibling took the name",
			);
			expectEqual(__harness.connectionCount(spare), 0, "connections on the sibling with names not followed");

			addCore(instance);
			__harness.flush();
			expectDefined(components.getComponent<Unrenamed>(instance), "component once a Core arrived");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"re-resolves a required child when a sibling is renamed into its name while it is missing",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("RenamedSibling");
			const core = addCore(instance);
			const spare = folderIn(instance, "Spare");
			const bystander = folderIn(instance, "Bystander");
			collectionService().AddTag(instance, "Watched");
			expectDefined(components.getComponent<Watched>(instance), "component");
			expectEqual(__harness.connectionCount(bystander), 0, "connections on a bystander while the tree is whole");

			try {
				// A rename is announced by the renamed child alone, so a sibling taking the name of
				// the child that was renamed away can only be heard from the sibling: while the slot
				// is empty every other child is followed for its name, and no longer once it fills.
				core.Name = "Shell";
				__harness.flush();
				expectEqual(
					components.getComponent<Watched>(instance),
					undefined,
					"component after its Core was renamed away",
				);
				expectTrue(__harness.connectionCount(bystander) > 0, "a bystander is followed while Core is missing");

				spare.Name = "Core";
				__harness.flush();
				expectDefined(components.getComponent<Watched>(instance), "component once the sibling is Core");
				expectEqual(
					__harness.connectionCount(bystander),
					0,
					"connections on the bystander once the tree is whole again",
				);

				// And back: the sibling renamed away empties the slot, and the old child -- no longer
				// the one followed for a rename back -- taking the name is heard from the old child.
				spare.Name = "Spare";
				__harness.flush();
				expectEqual(
					components.getComponent<Watched>(instance),
					undefined,
					"component after the sibling was renamed away",
				);

				core.Name = "Core";
				__harness.flush();
				expectDefined(components.getComponent<Watched>(instance), "component once the old child is Core again");
				expectEqual(__harness.connectionCount(bystander), 0, "connections on the bystander at the end");

				// A child arriving under another name while the slot is empty is a candidate too.
				core.Name = "Shell";
				__harness.flush();
				const late = folderIn(instance, "Late");
				late.Name = "Core";
				__harness.flush();
				expectDefined(components.getComponent<Watched>(instance), "component once a late child is Core");

				late.Name = "Late";
				__harness.flush();
				expectTrue(
					__harness.connectionCount(bystander) > 0,
					"a bystander is followed while Core is missing again",
				);
				instance.Destroy();
				task.wait();
				expectEqual(
					__harness.connectionCount(bystander),
					0,
					"connections on the bystander after the instance went",
				);
			} finally {
				instance.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"names the child a watched component is waiting for",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("Explained");
			folderIn(instance, "Root");

			__harness.clearWarnings();
			collectionService().AddTag(instance, "DeepImpatient");
			task.wait(0.3);

			expectTrue(
				__harness
					.warnings()
					.some(
						(line) =>
							line.find(
								"instance guard (child 'Root.Texture' is missing (expected Folder))",
								1,
								true,
							)[0] !== undefined,
					),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);
			expectEqual(components.getComponent<DeepImpatient>(instance), undefined, "component");

			// Destroyed rather than left behind: an instance that never qualifies arms a warning in
			// every later module.
			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"names what is wrong with the tree when a component is added by hand",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const bare = folder("Bare");
			const missing = expectThrows(
				() => components.addComponent<Deep>(bare),
				"adding a component to an instance without its tree",
			);
			expectTrue(
				missing.find("child 'Root' is missing (expected Folder)", 1, true)[0] !== undefined,
				`message: ${missing}`,
			);

			folderIn(bare, "Root");
			const partly = expectThrows(() => components.addComponent<Deep>(bare), "adding it with half the tree");
			expectTrue(
				partly.find("child 'Root.Texture' is missing (expected Folder)", 1, true)[0] !== undefined,
				`message: ${partly}`,
			);

			const wrongClass = folder("WrongClass");
			folderIn(wrongClass, "Core");
			const mismatch = expectThrows(
				() => components.addComponent<Parted>(wrongClass),
				"adding a component whose child is the wrong class",
			);
			expectTrue(
				mismatch.find("child 'Core' is a Folder, expected Part", 1, true)[0] !== undefined,
				`message: ${mismatch}`,
			);

			const notAPart = expectThrows(
				() => components.addComponent<PartOnly>(folder("NotAPart2")),
				"adding a Part component to a Folder",
			);
			expectTrue(
				notAPart.find("it is a Folder, expected Part", 1, true)[0] !== undefined,
				`message: ${notAPart}`,
			);

			module.extinguish();
		},
	],
	[
		"keeps waiting for a child of the right class while one of the wrong class holds the name",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("WrongThenRight");
			const decoy = folderIn(instance, "Core");
			collectionService().AddTag(instance, "Parted");
			expectEqual(components.getComponent<Parted>(instance), undefined, "component while Core is a Folder");

			// A Part of the same name behind the Folder is not what the name resolves to.
			const part = partIn(instance, "Core");
			__harness.flush();
			expectEqual(
				components.getComponent<Parted>(instance),
				undefined,
				"component while the Folder still comes first",
			);

			decoy.Destroy();
			__harness.flush();
			expectDefined(components.getComponent<Parted>(instance), "component once the name resolves to the Part");
			expectEqual(instance.FindFirstChild("Core"), part, "the Core it reads");

			module.extinguish();
		},
	],
	[
		"leaves the tree under a linked child to that child's component",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// `FrozenRig` reads its tree once. The owner watches its own tree, but the tree under
			// `Core` is not the owner's: what the child's component keeps, the owner keeps.
			const instance = folder("FrozenRigOwner1");
			const core = folderIn(instance, "Core");
			const root = folderIn(core, "Root");
			collectionService().AddTag(core, "FrozenRig");
			collectionService().AddTag(instance, "FrozenRigOwner");
			const owner = expectDefined(components.getComponent<FrozenRigOwner>(instance), "owner");

			root.Destroy();
			__harness.flush();
			expectDefined(components.getComponent<FrozenRig>(core), "the child's component after its tree broke");
			expectEqual(
				components.getComponent<FrozenRigOwner>(instance),
				owner,
				"the owner after the child's tree broke",
			);

			// The child itself is the owner's tree.
			core.Parent = undefined;
			__harness.flush();
			expectEqual(components.getComponent<FrozenRigOwner>(instance), undefined, "the owner after the child left");

			module.extinguish();
		},
	],
	[
		"follows the tree under a linked child through that child's component when it watches it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("LateRigChildOwner1");
			const core = folderIn(instance, "Core");
			const root = folderIn(core, "Root");
			collectionService().AddTag(core, "LateRig");
			collectionService().AddTag(instance, "LateRigChildOwner");
			expectDefined(components.getComponent<LateRigChildOwner>(instance), "owner");

			root.Parent = undefined;
			__harness.flush();
			expectEqual(
				components.getComponent<LateRig>(core),
				undefined,
				"the child's component after its tree broke",
			);
			expectEqual(
				components.getComponent<LateRigChildOwner>(instance),
				undefined,
				"the owner after the child's component went",
			);

			root.Parent = core;
			__harness.flush();
			expectDefined(components.getComponent<LateRig>(core), "the child's component once its tree is back");
			expectDefined(
				components.getComponent<LateRigChildOwner>(instance),
				"the owner once the child's component is back",
			);

			module.extinguish();
		},
	],
	[
		"says what a linked component is waiting for, and why a plain link's target is the wrong shape",
		() => {
			const module = createComponentModule();
			module.resolveDependency<Components>();

			const instance = folder("ExplainedOwner1");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(core, "Rig");

			const rooted = folder("RootedImpatient1");
			const target = folder("RootlessTarget");
			rooted.SetAttribute("Target", new InstanceHandle(target));

			__harness.clearWarnings();
			collectionService().AddTag(instance, "ExplainedOwner");
			collectionService().AddTag(rooted, "RootedImpatient");
			task.wait(0.3);

			const warnings = __harness.warnings();
			const linked = `child 'Core' with component '${Flamework.id<Rig>()}' (${core.GetFullName()} is waiting for: instance guard (child 'Root' is missing (expected Folder)))`;
			expectTrue(
				warnings.some((line) => line.find(linked, 1, true)[0] !== undefined),
				`warnings: ${warnings.join(" | ")}`,
			);

			const plain = `attribute 'Target' (${target.GetFullName()}: child 'Root' is missing (expected Folder))`;
			expectTrue(
				warnings.some((line) => line.find(plain, 1, true)[0] !== undefined),
				`warnings: ${warnings.join(" | ")}`,
			);

			instance.Destroy();
			rooted.Destroy();
			module.extinguish();
		},
	],
	[
		"runs onInit before anything can see the component, and onStart after",
		() => {
			events.clear();
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const seen = new Array<boolean>();
			components.onComponentAdded<Initialised>((component) => seen.push(component.ready));

			const instance = folder("InitOrder");
			collectionService().AddTag(instance, "Initialised");

			const component = expectDefined(components.getComponent<Initialised>(instance), "component");
			expectTrue(component.ready, "the component had run onInit by the time getComponent handed it back");
			expectArrayEqual(
				events.filter((event) => event.find(":InitOrder", 1, true)[0] !== undefined),
				["init:InitOrder", "start:InitOrder"],
				"lifecycle order",
			);
			expectArrayEqual(seen, [true], "what the added listener saw");

			module.extinguish();
		},
	],
	[
		"initialises a linked component before the component that links to it is built",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			// The owner is tagged first, so its link is what builds the child's component.
			const instance = folder("InitOwner");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(instance, "InitialisedOwner");
			collectionService().AddTag(core, "Initialised");

			const owner = expectDefined(components.getComponent<InitialisedOwner>(instance), "owner");
			expectTrue(owner.sawReady, "the owner's onInit saw an initialised child");
			expectTrue(owner.childComponents.Core.ready, "the child in childComponents");

			module.extinguish();
		},
	],
	[
		"keeps a component whose onInit raised as invalid until it is removed",
		() => {
			initAttempts = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BrokenInit1");
			const message = expectThrows(
				() => components.addComponent<BrokenInit>(instance),
				"adding a component whose onInit raises",
			);
			expectTrue(message.find("failed to initialise", 1, true)[0] !== undefined, `message: ${message}`);
			expectTrue(message.find("not today", 1, true)[0] !== undefined, `message: ${message}`);

			// Absent from every lookup, and yet in place: nothing is built on top of it.
			expectEqual(components.getComponent<BrokenInit>(instance), undefined, "component while invalid");
			expectEqual(components.getAllComponents<BrokenInit>().size(), 0, "components of that kind");
			const again = expectThrows(() => components.addComponent<BrokenInit>(instance), "adding it again");
			expectTrue(again.find("waiting to be removed", 1, true)[0] !== undefined, `message: ${again}`);
			expectEqual(initAttempts, 1, "onInit attempts");

			// Removed, it is built from the ground up, onInit and all.
			components.removeComponent<BrokenInit>(instance);
			expectThrows(() => components.addComponent<BrokenInit>(instance), "adding it after the removal");
			expectEqual(initAttempts, 2, "onInit attempts after the rebuild");

			module.extinguish();
		},
	],
	[
		"hides a component whose onInit raised from links, and rebuilds it only when its tag comes back",
		() => {
			events.clear();
			initAttempts = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BrokenOwner1");
			const core = folderIn(instance, "Core");
			collectionService().AddTag(instance, "BrokenOwner");

			__harness.clearWarnings();
			collectionService().AddTag(core, "BrokenInitTagged");
			expectEqual(initAttempts, 1, "onInit attempts");
			expectTrue(
				__harness.warnings().some((line) => line.find("failed to initialise", 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			// No lifecycle events, no lookups, no link: the owner keeps waiting, and says why.
			expectFalse(events.includes("brokenstart:Core"), "onStart for the invalid component");
			expectEqual(components.getComponent<BrokenInitTagged>(core), undefined, "the child's component");
			expectEqual(components.getComponent<BrokenOwner>(instance), undefined, "the owner");
			expectEqual(initAttempts, 1, "onInit attempts after asking again");

			// A fresh wait says why it waits: the warning belongs to a wait, and the owner had qualified
			// before the link was lost.
			collectionService().RemoveTag(instance, "BrokenOwner");
			collectionService().AddTag(instance, "BrokenOwner");
			task.wait(0.3);
			expectTrue(
				__harness.warnings().some((line) => line.find("carries an invalid", 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			// The tag going and coming back is a reason: a fresh component, and a fresh onInit.
			collectionService().RemoveTag(core, "BrokenInitTagged");
			collectionService().AddTag(core, "BrokenInitTagged");
			expectEqual(initAttempts, 2, "onInit attempts after the tag came back");

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"waits out a component whose onInit raised two links away",
		() => {
			events.clear();
			initAttempts = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const outer = folder("BrokenChainOuter");
			const inner = folder("BrokenChainInner");
			const core = folderIn(inner, "Core");
			outer.SetAttribute("Inner", new InstanceHandle(inner));

			// Every tag is there when the first is announced, so every link reads met, and the
			// build reaches the invalid component through two links rather than one. The one in
			// between is built quietly for nothing, and the owner above it waits the same way.
			__harness.clearWarnings();
			expectNoThrow(() => {
				__harness.deferTags(() => {
					collectionService().AddTag(outer, "BrokenOwnerPointer");
					collectionService().AddTag(inner, "BrokenOwner");
					collectionService().AddTag(core, "BrokenInitTagged");
				});
			}, "announcing a chain of tags that ends in an invalid component");

			expectEqual(initAttempts, 1, "onInit attempts");
			expectFalse(events.includes("brokenstart:Core"), "onStart for the invalid component");
			expectEqual(components.getComponent<BrokenInitTagged>(core), undefined, "the child's component");
			expectEqual(components.getComponent<BrokenOwner>(inner), undefined, "the owner in between");
			expectEqual(components.getComponent<BrokenOwnerPointer>(outer), undefined, "the owner at the top");
			expectFalse(
				__harness.warnings().some((line) => line.find("has no component", 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			outer.Destroy();
			inner.Destroy();
			module.extinguish();
		},
	],
	[
		"waits out a component whose onInit raised when it is a constructor dependency",
		() => {
			initAttempts = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("BrokenDependent");
			const late = folder("BrokenDependentLate");
			try {
				// The dependency is invalid before the dependent's tag arrives: a dependency that
				// cannot be had, which the dependent waits for rather than builds on.
				collectionService().AddTag(instance, "BrokenInitTagged");
				expectEqual(initAttempts, 1, "onInit attempts");
				expectNoThrow(
					() => collectionService().AddTag(instance, "BrokenCar"),
					"announcing the dependent's tag",
				);
				expectEqual(
					components.getComponent<BrokenCar>(instance),
					undefined,
					"the dependent while its dependency is invalid",
				);
				expectEqual(components.getComponent<BrokenInitTagged>(instance), undefined, "the invalid dependency");
				expectEqual(initAttempts, 1, "onInit attempts after the dependent asked");

				// The other order: the dependency turns invalid inside the dependent's own build,
				// which comes to nothing quietly, the way a build that reaches an invalid component
				// through a link does.
				collectionService().AddTag(late, "BrokenCar");
				expectEqual(
					components.getComponent<BrokenCar>(late),
					undefined,
					"dependent before its dependency exists",
				);
				expectNoThrow(
					() => collectionService().AddTag(late, "BrokenInitTagged"),
					"announcing the dependency's tag under a waiting dependent",
				);
				expectEqual(initAttempts, 2, "onInit attempts for the second instance");
				expectEqual(
					components.getComponent<BrokenCar>(late),
					undefined,
					"the dependent whose dependency turned invalid as it was built",
				);
				expectEqual(initAttempts, 2, "onInit attempts after the second dependent asked");
			} finally {
				instance.Destroy();
				late.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"builds a dependent once the invalid dependency it waits at is taken down by hand",
		() => {
			initAttempts = 0;
			Flaky.broken = true;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("FlakyDependent");
			const stuck = folder("FlakyDependentStuck");
			try {
				collectionService().AddTag(instance, "Flaky");
				collectionService().AddTag(instance, "FlakyCar");
				expectEqual(initAttempts, 1, "onInit attempts");
				expectEqual(
					components.getComponent<FlakyCar>(instance),
					undefined,
					"the dependent while its dependency is invalid",
				);

				// The invalid component is taken down by hand, with what made it raise put right:
				// nothing is left in the dependent's way, so it is built -- and, asked for, a valid
				// dependency with it.
				Flaky.broken = false;
				components.removeComponent<Flaky>(instance);
				const flaky = expectDefined(components.getComponent<Flaky>(instance), "the dependency built again");
				expectEqual(initAttempts, 2, "onInit attempts after the rebuild");
				__harness.flush();
				const car = expectDefined(
					components.getComponent<FlakyCar>(instance),
					"the dependent once its dependency is valid",
				);
				expectEqual(car.flaky, flaky, "the dependency the dependent holds");

				// Taken down while whatever made it raise is still there, it is tried again -- that
				// is what being taken down is for -- and the dependent waits on.
				Flaky.broken = true;
				collectionService().AddTag(stuck, "Flaky");
				collectionService().AddTag(stuck, "FlakyCar");
				expectEqual(initAttempts, 3, "onInit attempts for the second instance");
				components.removeComponent<Flaky>(stuck);
				expectEqual(initAttempts, 4, "onInit attempts after the second was taken down");
				expectEqual(
					components.getComponent<FlakyCar>(stuck),
					undefined,
					"the dependent while its dependency raises still",
				);

				// Left as they are when the module goes -- the dependency invalid, the dependent
				// waiting -- the invalid one is taken down like every other, and nothing is built
				// on the way out.
				__harness.clearWarnings();
				module.extinguish();
				expectFalse(
					__harness.warnings().some((line) => line.find("Failed to remove", 1, true)[0] !== undefined),
					`warnings: ${__harness.warnings().join(" | ")}`,
				);
				expectEqual(initAttempts, 4, "onInit attempts after the module went");
			} finally {
				Flaky.broken = false;
				instance.Destroy();
				stuck.Destroy();
				if (!module.isExtinguished()) module.extinguish();
			}
		},
	],
	[
		"answers getComponent with nothing for a dependent whose dependency can no longer be built",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("StrictDependentGone");
			const elsewhere = folder("StrictDependentGoneElsewhere");
			const root = folderIn(instance, "Root");
			try {
				collectionService().AddTag(instance, "Strict");
				collectionService().AddTag(instance, "StrictCar");
				expectDefined(components.getComponent<Strict>(instance), "the dependency");
				expectDefined(components.getComponent<StrictCar>(instance), "the dependent");

				// Both removed by hand, which leaves every criterion as it was; then the tree the
				// dependency's guard asks for goes, which its entry -- read once -- never hears.
				// The dependency answers nothing for it, and so must the dependent, rather than
				// raising out of a construction its dependency cannot be resolved for.
				components.removeComponent<StrictCar>(instance);
				components.removeComponent<Strict>(instance);
				root.Parent = elsewhere;
				expectEqual(components.getComponent<Strict>(instance), undefined, "the dependency once its tree went");
				expectEqual(
					components.getComponent<StrictCar>(instance),
					undefined,
					"the dependent once its dependency's tree went",
				);
			} finally {
				instance.Destroy();
				elsewhere.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"keeps a component whose onInit raised from hearing its link attributes change",
		() => {
			BrokenPointer.seen = 0;
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const first = folder("BrokenPointerFirst");
			const second = folder("BrokenPointerSecond");
			const instance = folder("BrokenPointer1");
			instance.SetAttribute("Target", new InstanceHandle(first));
			__harness.clearWarnings();
			collectionService().AddTag(instance, "BrokenPointer");
			expectEqual(components.getComponent<BrokenPointer>(instance), undefined, "the invalid component");

			// A plain attribute reaches an invalid component through nothing, because the
			// subscriptions that would carry it were never set up. A link attribute arrives through
			// the tracker's link instead, and it too stops short of a component that keeps its
			// place and nothing else.
			instance.SetAttribute("Target", new InstanceHandle(second));
			__harness.flush();
			expectEqual(BrokenPointer.seen, 0, "attribute changes the invalid component heard");

			instance.Destroy();
			first.Destroy();
			second.Destroy();
			module.extinguish();
		},
	],
	[
		"starts a component built during ignition only once ignition has finished",
		() => {
			events.clear();
			earlyInstance = folder("Early");

			const module = Flamework.createModule()
				.includePlugin(createComponentPlugin())
				.registerClassProvider(EarlyAdder)
				.ignite();

			// Initialised at once, so the provider's onInit can rely on it; started once every
			// provider has, and once.
			expectArrayEqual(
				events.filter(
					(event) =>
						event.find("Early", 1, true)[0] !== undefined || event.find("adder:", 1, true)[0] !== undefined,
				),
				["init:Early", "adder:init-done", "adder:start", "start:Early"],
				"lifecycle order across ignition",
			);

			module.extinguish();
		},
	],
	[
		"keeps a component whose invalid attribute has a default to stand in",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("DefaultedBad", { speed: 3 });
			collectionService().AddTag(instance, "Defaulted");
			const component = expectDefined(components.getComponent<Defaulted>(instance), "component");

			instance.SetAttribute("speed", "nope");
			__harness.flush();
			expectEqual(
				components.getComponent<Defaulted>(instance),
				component,
				"component after a bad change with a default",
			);
			expectEqual(component.attributes.speed, 3, "the last good value");

			module.extinguish();
		},
	],
	[
		"names an invalid attribute in the warning",
		() => {
			const module = createComponentModule();
			module.resolveDependency<Components>();

			const instance = folder("SpeedyBad", { speed: "fast" });
			__harness.clearWarnings();
			collectionService().AddTag(instance, "Speedy");
			task.wait(0.3);

			expectTrue(
				__harness
					.warnings()
					.some((line) => line.find(`invalid attribute 'speed' ("fast")`, 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"warns again when a component loses a criterion and stays down",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("LostAgain");
			const root = folderIn(instance, "Root");
			const texture = folderIn(root, "Texture");
			collectionService().AddTag(instance, "DeepImpatient");
			expectDefined(components.getComponent<DeepImpatient>(instance), "component");

			__harness.clearWarnings();
			texture.Destroy();
			__harness.flush();
			expectEqual(components.getComponent<DeepImpatient>(instance), undefined, "component after its tree broke");

			task.wait(0.3);
			expectTrue(
				__harness
					.warnings()
					.some((line) => line.find("child 'Root.Texture' is missing", 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			module.extinguish();
		},
	],
	[
		"names the instance guard in the warning when the reading at the flip is what holds a component down",
		() => {
			// Contextual streaming on a server reads the tree once: the child moving away is not
			// polled, so only the reading the flip to qualified is gated on sees that it is gone.
			if (!RunService.IsServer()) return;

			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("GatedExplained");
			const elsewhere = folder("GatedElsewhere");
			const core = addCore(instance);
			folderIn(core, "Root");
			collectionService().AddTag(core, "Rig");
			collectionService().AddTag(instance, "ExplainedOwner");
			expectDefined(components.getComponent<ExplainedOwner>(instance), "component");

			__harness.clearWarnings();
			components.removeComponent<Rig>(core);
			expectEqual(
				components.getComponent<ExplainedOwner>(instance),
				undefined,
				"component after its linked component was removed",
			);

			core.Parent = elsewhere;
			expectDefined(components.getComponent<Rig>(core), "the linked component rebuilt elsewhere");
			expectEqual(
				components.getComponent<ExplainedOwner>(instance),
				undefined,
				"component while its tree is short of Core",
			);

			// Nothing recorded the guard failing, so the warning reads it the way the gate did.
			task.wait(0.3);
			expectTrue(
				__harness
					.warnings()
					.some((line) => line.find("instance guard (child 'Core' is missing", 1, true)[0] !== undefined),
				`warnings: ${__harness.warnings().join(" | ")}`,
			);

			instance.Destroy();
			elsewhere.Destroy();
			module.extinguish();
		},
	],
	[
		"releases the entry of a component whose link names its own instance once the tag has gone",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("SelfTwin");
			try {
				instance.SetAttribute("Partner", new InstanceHandle(instance));
				collectionService().AddTag(instance, "Twin");
				expectEqual(trackedCount(components, Twin), 1, "entries while tagged");

				// The link observer this entry registered is a listener of the entry itself, so the
				// tag leaving must not leave the entry holding itself open.
				collectionService().RemoveTag(instance, "Twin");
				task.wait();
				expectEqual(components.getComponent<Twin>(instance), undefined, "component after the tag went");
				expectEqual(trackedCount(components, Twin), 0, "entries after the tag went");

				instance.Parent = undefined;
				instance.Destroy();
				task.wait();
				expectEqual(trackedCount(components, Twin), 0, "entries after the instance was destroyed");
				expectEqual(__harness.connectionCount(instance), 0, "connections on the destroyed instance");
			} finally {
				instance.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"releases the entries of a link ring once both tags have gone",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const first = folder("RingTwinA");
			const second = folder("RingTwinB");
			try {
				collectionService().AddTag(first, "Twin");
				collectionService().AddTag(second, "Twin");
				const firstComponent = expectDefined(components.getComponent<Twin>(first), "first component");
				const secondComponent = expectDefined(components.getComponent<Twin>(second), "second component");

				first.SetAttribute("Partner", new InstanceHandle(second));
				second.SetAttribute("Partner", new InstanceHandle(first));
				__harness.flush();
				expectEqual(firstComponent.attributeComponents.Partner, secondComponent, "the link the first holds");
				expectEqual(secondComponent.attributeComponents.Partner, firstComponent, "the link the second holds");
				expectEqual(trackedCount(components, Twin), 2, "entries while tagged");

				// Each entry's link observer is a listener of the other: the tags leaving must not
				// leave the two holding each other open.
				collectionService().RemoveTag(first, "Twin");
				collectionService().RemoveTag(second, "Twin");
				task.wait();
				expectEqual(firstComponent.destroyCount, 1, "first destroyed");
				expectEqual(secondComponent.destroyCount, 1, "second destroyed");
				expectEqual(components.getComponent<Twin>(first), undefined, "first component after the tag went");
				expectEqual(components.getComponent<Twin>(second), undefined, "second component after the tag went");
				expectEqual(trackedCount(components, Twin), 0, "entries after the tags went");

				first.Destroy();
				second.Destroy();
				task.wait();
				expectEqual(trackedCount(components, Twin), 0, "entries after the instances were destroyed");
				expectEqual(__harness.connectionCount(first), 0, "connections on the first instance");
				expectEqual(__harness.connectionCount(second), 0, "connections on the second instance");
			} finally {
				first.Destroy();
				second.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"drops a child two slots followed once it leaves, and takes the component down with it",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("LeakPair");
			const elsewhere = folder("LeakPairElsewhere");
			try {
				const core = addCore(instance);
				const extra = folderIn(instance, "Extra");
				collectionService().AddTag(instance, "LeakPair");
				expectDefined(components.getComponent<LeakPair>(instance), "component");

				// `core` takes the name `Extra`: slot Core keeps following it for a rename back,
				// and slot Extra resolves to it once the old `Extra` is renamed away. One child,
				// two slots following it.
				core.Name = "Extra";
				__harness.flush();
				expectEqual(components.getComponent<LeakPair>(instance), undefined, "component after Core was renamed");

				extra.Name = "Zed";
				__harness.flush();
				expectEqual(components.getComponent<LeakPair>(instance), undefined, "component while Core is missing");

				// A fresh `Core` arrives: slot Core lets go of `core`, which slot Extra still reads.
				addCore(instance);
				__harness.flush();
				expectDefined(components.getComponent<LeakPair>(instance), "component rebuilt");

				// The child slot Extra reads leaves: the tree is short of `Extra` and the component
				// comes down, and nothing goes on following the name of a child that is gone.
				core.Parent = elsewhere;
				__harness.flush();
				expectEqual(instance.FindFirstChild("Extra"), undefined, "the Extra child");
				expectEqual(
					components.getComponent<LeakPair>(instance),
					undefined,
					"component after the Extra child left",
				);
				expectEqual(__harness.connectionCount(core), 0, "connections on the child that left");
			} finally {
				instance.Destroy();
				elsewhere.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"releases what a link set up when the linked component's instance guard raises out of the setup",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("ThrowyPointer");
			const target = folder("ThrowyTarget");
			const linked = folder("ThrowyLinked");
			try {
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));

				// `linked` has no `X`, so the linked component raises the moment the second link
				// asks about it -- partway through this entry's setup, with the first link already
				// watching its own target -- and the tag's handler raises with it. The engine reports
				// a handler's error rather than raising it out of `AddTag`.
				__harness.clearErrors();
				collectionService().AddTag(instance, "ThrowyPointer");
				expectEqual(__harness.errors().size(), 1, "errors the tag's handler raised");
				__harness.clearErrors();

				// The tag leaving releases everything the failed setup had registered: the entry
				// the link created on the linked component's tracker, and the subscriptions on
				// the owner that no watcher ever came back to hold.
				collectionService().RemoveTag(instance, "ThrowyPointer");
				task.wait();
				expectEqual(trackedCount(components, ThrowyPointer), 0, "owner entries after the tag went");
				expectEqual(trackedCount(components, Throwy), 0, "linked entries after the tag went");
				expectEqual(__harness.connectionCount(instance), 0, "connections on the owner after the tag went");

				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				task.wait();
				expectEqual(trackedCount(components, Throwy), 0, "linked entries after the instances were destroyed");
			} finally {
				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				module.extinguish();
			}
		},
	],
	[
		"releases what a link set up when the linked component's predicate raises out of the setup",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const instance = folder("FussyPointer");
			const target = folder("FussyTarget");
			const linked = folder("FussyLinked");
			try {
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));

				// `linked` has no `X`, so the linked component raises the moment the second link
				// asks about it -- partway through this entry's setup, with the first link already
				// watching its own target -- and the tag's handler raises with it. The engine reports
				// a handler's error rather than raising it out of `AddTag`.
				__harness.clearErrors();
				collectionService().AddTag(instance, "FussyPointer");
				expectEqual(__harness.errors().size(), 1, "errors the tag's handler raised");
				__harness.clearErrors();

				// The tag leaving releases everything the failed setup had registered: the entry
				// the link created on the linked component's tracker, and the subscriptions on
				// the owner that no watcher ever came back to hold.
				collectionService().RemoveTag(instance, "FussyPointer");
				task.wait();
				expectEqual(trackedCount(components, FussyPointer), 0, "owner entries after the tag went");
				expectEqual(trackedCount(components, Fussy), 0, "linked entries after the tag went");
				expectEqual(__harness.connectionCount(instance), 0, "connections on the owner after the tag went");

				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				task.wait();
				expectEqual(trackedCount(components, Fussy), 0, "linked entries after the instances were destroyed");
			} finally {
				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				module.extinguish();
			}
		},
	],
	[
		// Guide 09 includes a `ComponentPlugin.fromPath` per folder in one module. Each plugin used to
		// build and provide a `Components` of its own under the one id, which raised
		// `provider ID was registered more than once` at ignition.
		"several component plugins in one module share one Components",
		() => {
			const first = ComponentPlugin.builder().registerComponent(Engine).registerComponent(Handler).build();
			const second = ComponentPlugin.builder().registerComponent(Car).registerComponent(Owner).build();

			const definition = Flamework.createModule()
				.includePlugin(first)
				.includePlugin(second)
				.registerClassProvider(ComponentsTaker)
				.build();

			let module = undefined as unknown as ReturnType<typeof definition.ignite>;
			expectNoThrow(() => {
				module = definition.ignite();
			}, "igniting a module with two component plugins");

			const components = module.resolveDependency<Components>();
			expectEqual(
				module.resolveDependency<ComponentsTaker>().components,
				components,
				"the Components a provider is injected with",
			);

			// A registration from each plugin, and a constructor dependency across them.
			const car = folder("SharedPluginsCar");
			collectionService().AddTag(car, "Engine");
			collectionService().AddTag(car, "Car");
			const built = expectDefined(components.getComponent<Car>(car), "the second plugin's component");
			expectEqual(built.engine, components.getComponent<Engine>(car), "its dependency from the first plugin");

			// A link across them: `Owner` (second) names a `Handler` (first) child.
			const owner = folder("SharedPluginsOwner");
			const core = addCore(owner);
			collectionService().AddTag(core, "Handler");
			collectionService().AddTag(owner, "Owner");
			__harness.flush();
			const linked = expectDefined(components.getComponent<Owner>(owner), "the linking component");
			expectEqual(linked.childComponents.Core, components.getComponent<Handler>(core), "the link across plugins");

			// Extinguishing takes every plugin's components down, and the definition ignites again.
			module.extinguish();
			expectEqual(components.getComponent<Car>(car), undefined, "the car once the module was extinguished");
			expectEqual(
				components.getComponent<Handler>(core),
				undefined,
				"the handler once the module was extinguished",
			);

			const again = definition.ignite();
			const rebuilt = again.resolveDependency<Components>();
			expectTrue(rebuilt !== components, "a fresh Components for the second ignition");
			expectDefined(rebuilt.getComponent<Car>(car), "the car again");
			expectDefined(rebuilt.getComponent<Owner>(owner), "the owner again");
			again.extinguish();

			car.Destroy();
			owner.Destroy();
		},
	],
	[
		"keeps a component two plugins register once, and when either registration holds",
		() => {
			const scoped = ComponentPlugin.builder()
				.registerComponent(Engine, { activeIn: ["fix5NeverActive"] })
				.registerComponent(Handler, { activeIn: ["fix5NeverActive"] })
				.build();
			const plain = ComponentPlugin.builder().registerComponent(Engine).build();

			const module = Flamework.createModule().includePlugin(scoped).includePlugin(plain).ignite();
			const components = module.resolveDependency<Components>();

			const instance = folder("SharedPluginsEngine");
			collectionService().AddTag(instance, "Engine");
			expectDefined(components.getComponent<Engine>(instance), "the component the second plugin keeps");
			expectEqual(components.getComponents<Engine>(instance).size(), 1, "Engine components on the instance");

			// Scoped out by the only plugin that registers it: the lookup explains why.
			const handler = folder("SharedPluginsHandler");
			const message = expectThrows(
				() => components.addComponent<Handler>(handler),
				"adding a scoped-out component",
			);
			expectTrue(
				message.find("fix5NeverActive", 1, true)[0] !== undefined,
				`the message names the scope: ${message}`,
			);

			module.extinguish();
			instance.Destroy();
			handler.Destroy();
		},
	],
	[
		"keeps a Components per module across imports",
		() => {
			const imported = Flamework.createModule()
				.includePlugin(ComponentPlugin.builder().registerComponent(Engine).build())
				.ignite();
			const importing = Flamework.createModule()
				.includePlugin(ComponentPlugin.builder().registerComponent(Handler).build())
				.ignite({ imports: [imported] });
			const plain = Flamework.createModule().ignite({ imports: [imported] });

			const importedComponents = imported.resolveDependency<Components>();
			const ownComponents = importing.resolveDependency<Components>();
			expectTrue(
				ownComponents !== importedComponents,
				"a module with a plugin of its own has its own Components",
			);
			expectEqual(
				plain.resolveDependency<Components>(),
				importedComponents,
				"a module with none resolves its import's",
			);

			const instance = folder("ImportedEngine");
			collectionService().AddTag(instance, "Engine");
			collectionService().AddTag(instance, "Handler");
			expectDefined(importedComponents.getComponent<Engine>(instance), "the import's component");
			expectDefined(ownComponents.getComponent<Handler>(instance), "the importer's own component");
			// Each registers its own: the importer's Components does not know the import's classes.
			expectThrows(
				() => ownComponents.getComponent<Engine>(instance),
				"the import's component, asked of the importer's",
			);

			plain.extinguish();
			importing.extinguish();
			imported.extinguish();
			instance.Destroy();
		},
	],
	[
		"explains a component's dependency on a component no plugin of its module registers",
		() => {
			// `Car` takes an `Engine`, which is a component this module does not register at all.
			const module = Flamework.createModule()
				.includePlugin(ComponentPlugin.builder().registerComponent(Car).build())
				.ignite();
			const components = module.resolveDependency<Components>();

			const instance = folder("UnregisteredEngineCar");
			const message = expectThrows(() => components.addComponent<Car>(instance), "building the car");
			expectTrue(
				message.find("no ComponentPlugin of this module registers", 1, true)[0] !== undefined,
				`the message says what is missing: ${message}`,
			);

			instance.Destroy();
			module.extinguish();
		},
	],
]);
