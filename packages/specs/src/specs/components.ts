import {
	BaseComponent,
	Component,
	ComponentMetadata,
	ComponentPlugin,
	ComponentStreamingMode,
	Components,
} from "@flamework-experimental/components";
import { Flamework, OnInit, OnStart, Provider } from "@flamework-experimental/core";
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
class Chassis extends BaseComponent<ChassisAttributes, Model & { Core: Bolt; Aux?: Bolt }> {
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
function createComponentPlugin() {
	return ComponentPlugin.createPlugin()
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
		.registerComponent(Repairer)
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
		.registerComponent(Bolt)
		.registerComponent(Chassis)
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

			// The removal reads the tag as still there and looks again a resumption later, so the
			// added announcement reaches a component that is still attached -- and is handed it, as
			// it would be without the attribute write. The attribute criterion takes it down on its
			// own, a resumption later, as it does without the re-tag.
			expectNoThrow(() => {
				__harness.deferTags(() => {
					instance.SetAttribute("speed", "bad");
					collectionService().RemoveTag(instance, "Tagged");
					collectionService().AddTag(instance, "Tagged");
				});
			}, "announcing the tag again");
			expectEqual(components.getComponent<Tagged>(instance), component, "component in the same resumption");

			__harness.flush();
			expectEqual(components.getComponent<Tagged>(instance), undefined, "component once the attribute was read");

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
		"rebuilds a component as an optional linked child arrives tagged and then moves away",
		() => {
			const module = createComponentModule();
			const components = module.resolveDependency<Components>();

			const root = folder("OptionalChildRoot");
			const model = new Instance("Model");
			model.Name = "OptionalChildModel";
			model.Parent = root;

			const core = partIn(model, "Core");
			const target = partIn(root, "OptionalChildTarget");
			const linked = partIn(root, "OptionalChildLinked");
			collectionService().AddTag(linked, "Bolt");
			collectionService().AddTag(core, "Bolt");
			model.SetAttribute("Target", new InstanceHandle(target));
			model.SetAttribute("Linked", new InstanceHandle(linked));
			collectionService().AddTag(model, "Chassis");

			const built = expectDefined(components.getComponent<Chassis>(model), "component");
			expectEqual(built.childComponents.Aux, undefined, "the optional child before it arrives");

			const created = Chassis.created;

			// Tagged before it is parented, the way a clone is prepared: nothing is announced while
			// it is outside the DataModel, and the tag lands as it enters, just before ChildAdded.
			const aux = new Instance("Part");
			aux.Name = "Aux";
			collectionService().AddTag(aux, "Bolt");

			__harness.deferSignals(() => {
				__harness.deferTags(() => {
					__harness.deferTree(() => {
						aux.Parent = model;
					});
				});
			});
			__harness.flush();

			expectEqual(Chassis.created - created, 1, "constructions once the optional child arrived");

			const withAux = expectDefined(components.getComponent<Chassis>(model), "component with the child");
			expectTrue(withAux !== built, "the component was rebuilt around the optional child");
			expectEqual(withAux.childComponents.Aux, components.getComponent<Bolt>(aux), "the optional child");

			// Moved rather than destroyed, so the component on it lives on: the tree is what changed.
			__harness.deferSignals(() => {
				__harness.deferTags(() => {
					__harness.deferTree(() => {
						aux.Parent = root;
					});
				});
			});
			__harness.flush();

			expectEqual(Chassis.created - created, 2, "constructions once the optional child left");

			const withoutAux = expectDefined(components.getComponent<Chassis>(model), "component without the child");
			expectEqual(withoutAux.childComponents.Aux, undefined, "the optional child after it moved away");
			expectDefined(components.getComponent<Bolt>(aux), "the component on the child that moved");

			// And the component the required link names going takes the owner down with it.
			collectionService().RemoveTag(core, "Bolt");
			expectEqual(components.getComponent<Chassis>(model), undefined, "component after the linked one went");

			root.Destroy();
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
]);
