import {
	BaseComponent,
	Component,
	ComponentMetadata,
	ComponentPlugin,
	ComponentStreamingMode,
	Components,
} from "@flamework-experimental/components";
import { Flamework, OnInit, OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectFalse,
	expectNoThrow,
	expectResolves,
	expectThrows,
	expectTrue,
	scratch,
	test,
} from "@flamework-experimental/testing";
import { CollectionService, LogService, ReplicatedStorage, RunService } from "@rbxts/services";
import { signalsAreDeferred } from "./signalBehavior";

/**
 * The Lune `components` suite, run against the engine. Same components, same cases, same order;
 * what the Lune harness faked is replaced by what a place has: the deferred task the registry
 * reacts to tree changes on is waited out with `settle`, warnings are read off `LogService`, and
 * a handle that has not resolved is an empty `InstanceHandle`.
 *
 * The cases the harness deferred signals for depend on `Workspace.SignalBehavior`, which the suite
 * runs under both settings of (`bun run test`, one Rojo project per setting; see `tests/`). Where
 * the place defers its signals (`signalsAreDeferred`, measured, since the property is not
 * scriptable) they run in the Lune order: a tag is announced a resumption after `AddTag`, so a
 * component can be asked for, built through a link or waited for by a dependent before its own
 * announcement lands, and `queued` puts a step between two announcements the way the harness did.
 * Where the place delivers every signal inside the write (`Immediate`, and `Default` as measured
 * 2026-09-13) those orderings cannot arise: the tag path builds first, and the writes are ordered
 * so that the one the registry hears comes last. Both branches assert the same outcome, and each
 * asserts, through `announcements`, that the ordering it ran was the one it meant to.
 *
 * Every case builds a module of its own from the plugin below and extinguishes it afterwards, so
 * nothing here depends on the game's component plugin or leaks into the next case.
 */

const events = new Array<string>();

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

/** A tree two levels deep, watched, so a change under `Root` is a change to this component's tree. */
@Component({ tag: "Deep", streamingMode: ComponentStreamingMode.Watching, warningTimeout: 0 })
class Deep extends BaseComponent<{}, Folder & { Root: Folder & { Texture: Folder } }> {}

/** The same tree, warning almost at once, so a test can read what the warning names. */
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

/** Warns almost at once, so a test can read what it says about a bad attribute. */
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

	public override destroy() {
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

/** Warns almost at once, so a case can wait for the warning rather than the configured seconds. */
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

	public override destroy() {
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

	public override destroy() {
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

/** Two plain required children, so one can take the other's name and be followed by both slots. */
@Component({ tag: "LeakPair", warningTimeout: 0, streamingMode: ComponentStreamingMode.Watching, watchRenames: true })
class LeakPair extends BaseComponent<{}, Folder & { Core: Folder; Extra: Folder }> {}

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

/** The plugin every case's module is built from: just these components, no path discovery. */
const SPEC_PLUGIN = ComponentPlugin.createPlugin()
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
	.registerComponent(LeakPair)
	.registerComponent(Throwy)
	.registerComponent(ThrowyPointer)
	.registerComponent(Fussy)
	.registerComponent(FussyPointer)
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
	.build();

/** A module of the spec's components, ignited now and left to the case to extinguish. */
function buildModule() {
	return Flamework.createModule().includePlugin(SPEC_PLUGIN).ignite();
}

/** The module a case works against, extinguished when the case is over, whatever happened in it. */
function createComponentModule() {
	const module = buildModule();
	defer(() => module.extinguish());

	return module.resolveDependency<Components>();
}

/**
 * Lets the engine deliver what a change queued: the registry reacts to a tree change on a deferred
 * task, and a place may defer its signals as well. Two frames cover both, which is what the Lune
 * harness's `flush` stood for.
 */
function settle() {
	task.wait();
	task.wait();
}

/**
 * Lets a tag's announcement land before the case goes on. The Lune harness announced a tag inside
 * `AddTag`, so a case whose premise is a component the tag path has built -- whose tree or links
 * it then breaks, expecting the streaming mode to decide what happens -- has that premise at once
 * there. Where the place defers its signals the announcement is still queued after `AddTag` and
 * after the eager build an `expectDefined(getComponent)` made, and a write made before it lands is
 * one the announcement replays against the component: the tree it reads is the broken one. So the
 * case waits here, and the announcement finds nothing changed and keeps the component.
 */
function announced() {
	settle();
}

/** Waits for a lookup to answer, and returns what it answered. */
function untilFound<T>(lookup: () => T | undefined, what: string): T {
	let found: T | undefined;
	eventually(() => {
		found = lookup();
		return found !== undefined;
	}, what);

	return found!;
}

/** Waits for a lookup to stop answering. */
function untilGone(lookup: () => unknown, what: string) {
	eventually(() => lookup() === undefined, what);
}

/**
 * Everything `warn` says while the case runs, off `LogService`; a case reads it after giving a
 * warning's timer the time it asked for.
 */
function recordWarnings() {
	return recordMessages(Enum.MessageType.MessageWarning);
}

/**
 * Everything raised on a signal's thread while the case runs, off `LogService`: what a tag's
 * handler raises never comes out of `AddTag` in the engine, it is printed as an error instead.
 */
function recordErrors() {
	return recordMessages(Enum.MessageType.MessageError);
}

function recordMessages(kind: Enum.MessageType) {
	const lines = new Array<string>();
	const connection = LogService.MessageOut.Connect((message, messageKind) => {
		if (messageKind === kind) {
			lines.push(message);
		}
	});
	defer(() => connection.Disconnect());

	return {
		lines,
		clear: () => lines.clear(),
		mentions: (needle: string) => lines.some((line) => line.find(needle, 1, true)[0] !== undefined),
		describe: () => lines.join(" | "),
	};
}

/**
 * How many instances a component's tracker holds an entry for, which is what a leaked entry shows
 * up in. The map is private to the registry; a roblox-ts private field is a plain table field.
 */
function trackedCount(components: Components, component: object) {
	const trackers = (components as unknown as { trackers: Map<object, { instances: Map<Instance, unknown> }> })
		.trackers;

	return trackers.get(component)?.instances.size() ?? 0;
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

/** A folder in the case's scratch space, which goes with everything in it when the case ends. */
function folder(name: string, attributes?: { [key: string]: unknown }) {
	return folderIn(scratch(), name, attributes);
}

/** A folder under ReplicatedStorage, which the default ancestor lists keep components out of. */
function storageFolder(name: string) {
	const instance = folderIn(ReplicatedStorage, name);
	defer(() => instance.Destroy());

	return instance;
}

/** A part-shaped child, for the link trees a place builds out of models and parts. */
function partIn(parent: Instance, name: string) {
	const instance = new Instance("Part");
	instance.Name = name;
	instance.Anchored = true;
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
	CollectionService.AddTag(instance, "Pointer");

	return instance;
}

/** A folder carrying `Handler`, which is what the component links point at. */
function handlerFolder(name: string) {
	const instance = folder(name);
	CollectionService.AddTag(instance, "Handler");

	return instance;
}

/** A handle that names nothing, which is what an instance that has not streamed in looks like. */
function emptyHandle() {
	return new InstanceHandle(undefined);
}

/**
 * Counts a tag's announcements for one instance from here on, as the registry hears them. Where
 * signals are immediate `AddTag` returns with one counted; where they are deferred the count stays
 * at zero until the thread yields, and that is the window a Lune case asks for the component in.
 */
function announcements(tag: string, instance: Instance) {
	const counter = { count: 0 };
	const connection = CollectionService.GetInstanceAddedSignal(tag).Connect((tagged) => {
		if (tagged === instance) counter.count++;
	});
	defer(() => connection.Disconnect());

	return counter;
}

/**
 * Runs `callback` from the engine's signal queue. Where signals are deferred a BindableEvent's
 * fire is queued behind everything raised before it and ahead of everything raised after, so the
 * callback runs between two announcements, which the Lune harness did by hand; where they are
 * immediate it runs at once, as any call would. The callback runs on the signal's own thread, so
 * what it raises is kept and re-raised by `rethrow`, for after the thread has yielded.
 */
function queued(callback: () => void) {
	const event = new Instance("BindableEvent");
	const state = { ran: false, failure: undefined as unknown };
	const connection = event.Event.Connect(() => {
		state.ran = true;
		const [ok, err] = pcall(callback);
		if (!ok) state.failure = err;
	});
	defer(() => {
		connection.Disconnect();
		event.Destroy();
	});
	event.Fire();

	return {
		rethrow: () => {
			expectTrue(state.ran, "the queued step ran");
			if (state.failure !== undefined) throw state.failure;
		},
	};
}

@Provider({ activeIn: ["testing"] })
export class ComponentSpecs implements OnStart {
	onStart() {
		defineTests("components", () => {
			test("leaves a component down when a rebuild is asked for by a queued child signal after a later one broke the tree", () => {
				const components = createComponentModule();

				const instance = folder("QueuedPair");
				const core = addCore(instance);
				CollectionService.AddTag(core, "Handler");
				const aux = folderIn(instance, "Aux");
				CollectionService.AddTag(aux, "Handler");
				CollectionService.AddTag(instance, "PairOwner");
				untilFound(() => components.getComponent<PairOwner>(instance), "component");

				const elsewhere = folder("QueuedPairElsewhere");

				// Three moves in one resumption: `Aux` out, back in, and `Core` out. Its return is
				// delivered before `Core` leaving, so the `Aux` link takes the component down and
				// asks for it straight back while the `Core` link's criterion still says a `Core` is
				// there and the tree no longer holds one: the rebuild must not trust it and raise out
				// of a handler that is only there because something else moved.
				expectNoThrow(() => {
					aux.Parent = elsewhere;
					aux.Parent = instance;
					core.Parent = elsewhere;
				}, "delivering the queued child signals");
				settle();

				expectEqual(
					components.getComponent<PairOwner>(instance),
					undefined,
					"component after the required child left",
				);

				// And it comes back once the tree really does hold a `Core` again.
				core.Parent = instance;
				settle();

				const rebuilt = expectDefined(
					components.getComponent<PairOwner>(instance),
					"component once the required child returned",
				);
				expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(core), "the Core link");
				expectEqual(rebuilt.childComponents.Aux, components.getComponent<Handler>(aux), "the Aux link");
			});

			test("leaves a component down when a linked child is swapped in the resumption an attribute went bad", () => {
				const components = createComponentModule();

				const instance = folder("SpeedOwner1", { speed: 1 });
				const oldCore = addCore(instance);
				CollectionService.AddTag(oldCore, "Handler");
				CollectionService.AddTag(instance, "SpeedOwner");
				expectDefined(components.getComponent<SpeedOwner>(instance), "component");

				const newCore = new Instance("Folder");
				newCore.Name = "Core";
				CollectionService.AddTag(newCore, "Handler");
				const elsewhere = folder("SpeedOwnerElsewhere");

				// The attribute criterion is read on a deferred task, so the swap's child signals arrive
				// first: the link takes the component down and asks for it straight back, against an
				// attribute the guard refuses. The rebuild reads it rather than raising out of the
				// handler, and nothing is built until the attribute is valid again.
				expectNoThrow(() => {
					instance.SetAttribute("speed", "bad");
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
				}, "delivering the queued child signals");
				untilGone(() => components.getComponents<SpeedOwner>(instance)[0], "the component after the swap");
				settle();

				expectEqual(
					components.getComponent<SpeedOwner>(instance),
					undefined,
					"component while the attribute is bad",
				);

				instance.SetAttribute("speed", 2);
				const rebuilt = untilFound(
					() => components.getComponent<SpeedOwner>(instance),
					"the component once the attribute is valid again",
				);
				expectEqual(rebuilt.attributes.speed, 2, "the attribute the rebuilt component read");
				expectEqual(
					rebuilt.childComponents.Core,
					components.getComponent<Handler>(newCore),
					"the swapped child",
				);
			});

			test("leaves a component down when a linked child is swapped in the resumption another child left", () => {
				events.clear();
				TwoChildOwner.created = 0;
				const components = createComponentModule();

				const instance = folder("TwoChildOwner1");
				const extra = folderIn(instance, "Extra");
				const oldCore = addCore(instance);
				CollectionService.AddTag(oldCore, "Handler");
				CollectionService.AddTag(instance, "TwoChildOwner");
				expectDefined(components.getComponent<TwoChildOwner>(instance), "component");
				expectEqual(TwoChildOwner.created, 1, "constructions");

				const newCore = new Instance("Folder");
				newCore.Name = "Core";
				CollectionService.AddTag(newCore, "Handler");
				const elsewhere = folder("TwoChildOwnerElsewhere");

				// The instance guard is read on a deferred task as well, so the link's rebuild arrives
				// while the guard still says the tree is whole: the rebuild reads the tree for itself,
				// rather than constructing a component on one that is missing a required child.
				extra.Parent = elsewhere;
				oldCore.Parent = elsewhere;
				newCore.Parent = instance;
				untilGone(() => components.getComponents<TwoChildOwner>(instance)[0], "the component after the swap");
				settle();

				expectEqual(TwoChildOwner.created, 1, "constructions after the guard was read");
				expectEqual(components.getComponents<TwoChildOwner>(instance).size(), 0, "components after the swap");
				expectFalse(events.includes("twostart:false"), "a component started on a tree missing its child");

				// Whole again, the tree is read by the guard's own poll: nothing here asks for it.
				extra.Parent = instance;
				untilFound(
					() => components.getComponents<TwoChildOwner>(instance)[0],
					"the component once the tree is whole again",
				);
				expectEqual(TwoChildOwner.created, 2, "constructions once the tree is whole again");
			});

			test("builds a component whose tree was repaired between a refused rebuild and the guard's poll", () => {
				const components = createComponentModule();

				const instance = folder("RepairedOwner");
				const oldCore = addCore(instance);
				CollectionService.AddTag(oldCore, "Handler");
				const extra = folderIn(instance, "Extra");
				CollectionService.AddTag(instance, "TwoChildOwner");
				expectDefined(components.getComponent<TwoChildOwner>(instance), "component");
				announced();

				const newCore = new Instance("Folder");
				newCore.Name = "Core";
				CollectionService.AddTag(newCore, "Handler");
				const elsewhere = folder("RepairedOwnerElsewhere");
				const other = folder("RepairedOwnerOther");
				Repairer.repair = () => {
					extra.Parent = instance;
				};
				defer(() => {
					Repairer.repair = undefined;
				});

				if (signalsAreDeferred()) {
					// The Lune raise order, which the harness deferred the tree and the tags for: the
					// linked child's swap, then a tag whose component's constructor puts `Extra` back,
					// then `Extra` leaving. The swap asks for a rebuild while `Extra` is gone, which
					// the reading at the flip refuses without recording anything; the constructor
					// puts it back; and the guard's own signal for `Extra` then finds the slot filled
					// again, so its poll reads the tree exactly as the entry already records it. The
					// poll still has to say so, or nothing ever lifts the refusal.
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
					CollectionService.AddTag(other, "Repairer");
					extra.Parent = elsewhere;
					settle();
					settle();
					expectEqual(extra.Parent, instance, "Extra is back");
				} else {
					// Signals are immediate and the guard is read on a deferred task, so `Extra`
					// leaves first and the component stands until that read. The linked child's swap
					// then asks for the same refused rebuild while `Extra` is gone; the tag's
					// constructor puts `Extra` back inside the tag's own handler; and the guard's
					// signal for `Extra` finds the slot filled again, as above.
					extra.Parent = elsewhere;
					oldCore.Parent = elsewhere;
					newCore.Parent = instance;
					CollectionService.AddTag(other, "Repairer");
					expectEqual(extra.Parent, instance, "Extra is back");
					settle();
					settle();
				}
				Repairer.repair = undefined;

				expectDefined(components.getComponent<Handler>(newCore), "the linked child's component");
				untilFound(
					() => components.getComponents<TwoChildOwner>(instance)[0],
					"the component once the tree holds again",
				);
			});

			test("leaves a component down when a link attribute rebuilds it after its frozen tree broke", () => {
				const components = createComponentModule();

				const good = folder("FrozenPairTarget");
				folderIn(good, "Root");

				const instance = folder("FrozenPairOwner");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Handler");
				instance.SetAttribute("Target", new InstanceHandle(good));
				CollectionService.AddTag(instance, "FrozenPair");
				expectDefined(components.getComponent<FrozenPair>(instance), "component");
				announced();

				// Streaming is disabled, so the child link is read once: the component is kept. The
				// child moves rather than leaving the DataModel, which would announce its tag as gone
				// and take the component the link names -- and with it this component -- whatever
				// the mode.
				core.Parent = folder("FrozenPairElsewhere");
				settle();
				expectDefined(components.getComponent<FrozenPair>(instance), "component after the frozen tree broke");

				// The attribute is followed whatever the streaming mode, so re-pointing it at
				// something its guard refuses takes the component down.
				const bare = folder("FrozenPairBare");
				instance.SetAttribute("Target", new InstanceHandle(bare));
				untilGone(() => components.getComponent<FrozenPair>(instance), "the component after a bad re-point");

				// Pointing it back asks for the component again, and a fresh build reads the tree as
				// it is now: there is no `Core` left, so it stays down rather than raising out of the
				// write that asked for it.
				expectNoThrow(() => {
					instance.SetAttribute("Target", new InstanceHandle(good));
				}, "pointing the attribute back at a target its guard accepts");
				settle();

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

				untilFound(
					() => components.getComponent<FrozenPair>(instance),
					"the component once the tree was whole again",
				);
			});

			test("removes a component when a plain attribute becomes invalid, and builds it again once it is valid", () => {
				const components = createComponentModule();

				const instance = folder("BadExternal", { speed: 3 });
				CollectionService.AddTag(instance, "Tagged");
				untilFound(() => components.getComponent<Tagged>(instance), "component");

				// An attribute guard is a criterion: a value it rejects takes the component down, and a
				// value it accepts builds it again, reading the attributes afresh.
				instance.SetAttribute("speed", "nope");
				untilGone(() => components.getComponent<Tagged>(instance), "component after a bad attribute change");

				instance.SetAttribute("speed", 4);
				const rebuilt = untilFound(
					() => components.getComponent<Tagged>(instance),
					"component once the attribute is valid again",
				);
				expectEqual(rebuilt.attributes.speed, 4, "the attribute the rebuilt component read");
			});

			test("hands a built component back when its tag is announced again beside an attribute that has just gone bad", () => {
				const components = createComponentModule();

				const instance = folder("RetaggedBad", { speed: 1 });
				CollectionService.AddTag(instance, "Tagged");
				const component = expectDefined(components.getComponent<Tagged>(instance), "component");
				settle();

				// A tag's removal is announced during the change, with the instance still reading as
				// tagged and in the tree, so the removal looks again a resumption later. Parented
				// straight back in, the tag is announced again in the same resumption, and reaches a
				// component that is still attached -- and is handed it, as it would be without the
				// attribute write. The attribute criterion takes it down on its own, a resumption
				// later, as it does without the re-announcement.
				expectNoThrow(() => {
					instance.SetAttribute("speed", "bad");
					instance.Parent = undefined;
					instance.Parent = scratch();
				}, "announcing the tag again");
				expectEqual(components.getComponent<Tagged>(instance), component, "component in the same resumption");

				untilGone(() => components.getComponent<Tagged>(instance), "the component once the attribute was read");
				settle();
				expectEqual(
					components.getComponents<Tagged>(instance).size(),
					0,
					"components once the attribute was read",
				);
			});

			test("answers getComponent with nothing, not a raise, for an attribute that went bad in the same resumption", () => {
				const components = createComponentModule();

				const instance = folder("BadNowTagged", { speed: 1 });
				CollectionService.AddTag(instance, "Tagged");
				expectDefined(components.getComponent<Tagged>(instance), "component");
				settle();

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
			});

			test("treats a link attribute that is not a handle as invalid, and builds the component once it is cleared", () => {
				const components = createComponentModule();

				// An optional link resolves a value that is not a handle to nothing, which holds nothing
				// up, so the guard is what refuses it -- as a criterion, the way a plain attribute's is,
				// rather than raising out of the tag handler on the way into the constructor.
				const instance = folder("BadOptionalLink", { Partner: "nope" });
				expectNoThrow(() => CollectionService.AddTag(instance, "Twin"), "tagging with a bad link attribute");
				settle();
				expectEqual(
					components.getComponents<Twin>(instance).size(),
					0,
					"components the tag built while the attribute is invalid",
				);
				expectEqual(
					components.getComponent<Twin>(instance),
					undefined,
					"component while the attribute is invalid",
				);

				instance.SetAttribute("Partner", undefined);
				untilFound(
					() => components.getComponents<Twin>(instance)[0],
					"the component once the attribute was cleared",
				);
				settle();
				expectEqual(
					components.getComponents<Twin>(instance).size(),
					1,
					"components once the attribute was cleared",
				);
			});

			test("keeps a component whose tree breaks when streaming is disabled", () => {
				const components = createComponentModule();

				const instance = folder("FrozenTree");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Frozen");
				expectDefined(components.getComponent<Frozen>(instance), "component while the tree holds");
				announced();

				core.Parent = undefined;
				defer(() => core.Destroy());
				settle();

				expectDefined(
					components.getComponent<Frozen>(instance),
					"component after the tree broke with streaming disabled",
				);
			});

			test("removes a component when the component a link names goes, whatever the streaming mode", () => {
				const components = createComponentModule();

				const instance = folder("FrozenLink");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(instance, "FrozenOwner");
				expectDefined(components.getComponent<FrozenOwner>(instance), "component while the link holds");

				// The tree is never re-checked under `Disabled`, but a linked component being
				// destroyed is a lifecycle event rather than the tree filling in, so it is always
				// noticed.
				CollectionService.RemoveTag(core, "Handler");
				untilGone(() => components.getComponent<FrozenOwner>(instance), "the component after the link broke");
			});

			test("keeps a linked child that moves away when streaming is disabled, and loses one that is unparented", () => {
				const components = createComponentModule();

				const instance = folder("FrozenChild");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(instance, "FrozenOwner");

				const owner = expectDefined(components.getComponent<FrozenOwner>(instance), "component");
				announced();

				// A child link is part of the instance tree, so `Disabled` reads it once and keeps
				// the answer, exactly as it does for the instance guard. A child moved elsewhere in
				// the DataModel keeps its tag, and with it the component the link is holding.
				core.Parent = folder("FrozenChildElsewhere");
				settle();

				expectDefined(components.getComponent<FrozenOwner>(instance), "component after the child moved away");
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Handler>(core),
					"the child it resolved to",
				);

				// Leaving the DataModel is not the tree moving: CollectionService announces the tag
				// as gone, so `Handler` is removed, and a link losing the component it names takes
				// its own component down whatever the streaming mode.
				core.Parent = undefined;
				defer(() => core.Destroy());

				untilGone(
					() => components.getComponent<FrozenOwner>(instance),
					"the component after the child left the DataModel",
				);
			});

			test("builds a component when a tagged instance enters the DataModel, and drops it when it leaves", () => {
				const components = createComponentModule();

				const instance = new Instance("Folder");
				instance.Name = "LateParented";
				defer(() => instance.Destroy());
				CollectionService.AddTag(instance, "Handler");

				// Tagging something the DataModel does not hold announces nothing at all.
				expectEqual(components.getComponents<Handler>(instance).size(), 0, "components while unparented");

				// Parenting it in is the announcement, so the component is built without anyone
				// asking: `getComponents` reads what is attached rather than constructing one.
				instance.Parent = scratch();
				untilFound(
					() => components.getComponents<Handler>(instance)[0],
					"the component once it entered the DataModel",
				);

				// Leaving announces it as gone again, with the tag still in place: it is the
				// announcement ancestry drives, not the tag itself.
				instance.Parent = undefined;
				eventually(
					() => components.getComponents<Handler>(instance).size() === 0,
					"no components after it left again",
				);
				expectTrue(CollectionService.HasTag(instance, "Handler"), "the tag the instance kept");

				// And parenting it back in builds one again, because the tag never went anywhere.
				instance.Parent = scratch();
				untilFound(
					() => components.getComponents<Handler>(instance)[0],
					"the component once it was parented back in",
				);
			});

			test("removes a component from a descendant when the tree around it leaves the DataModel", () => {
				const components = createComponentModule();

				const removed = new Array<string>();
				components.onComponentRemoved<Handler>((_component, instance) => removed.push(instance.Name));

				const pooled = folder("PooledTree");
				defer(() => pooled.Destroy());
				const core = folderIn(pooled, "PooledCore");
				CollectionService.AddTag(core, "Handler");

				expectDefined(components.getComponent<Handler>(core), "component while the tree is in the DataModel");

				// Pooling by unparenting rather than destroying. The descendant left the DataModel
				// with its ancestor, so its tag is announced as gone exactly as the ancestor's own
				// is: what takes a component down is leaving the DataModel, not losing a parent.
				pooled.Parent = undefined;
				eventually(
					() => components.getComponents<Handler>(core).size() === 0,
					"no components after the unparenting",
				);
				expectArrayEqual(removed, ["PooledCore"], "removal notifications");

				// And nothing builds one out there either: a descendant of a pooled tree still has a
				// parent, which is why asking it by hand used to construct one that nothing would
				// ever take away again.
				expectEqual(components.getComponent<Handler>(core), undefined, "getComponent on the pooled descendant");
				expectEqual(components.getComponents<Handler>(core).size(), 0, "components getComponent left behind");

				// Parented back in, the tag is announced again and the component comes back with it.
				pooled.Parent = scratch();
				untilFound(
					() => components.getComponent<Handler>(core),
					"the component once the tree was parented back in",
				);
			});

			test("announces nothing for a tag applied inside a tree the DataModel does not hold", () => {
				const components = createComponentModule();

				// A template being assembled before it is dropped in. The tag lands on a descendant
				// of a tree nothing holds, which announces nothing at all -- not only the parentless
				// instance itself.
				const template = new Instance("Folder");
				template.Name = "DetachedTemplate";
				defer(() => template.Destroy());

				const core = folderIn(template, "DetachedCore");
				CollectionService.AddTag(core, "Handler");
				settle();

				expectEqual(components.getComponents<Handler>(core).size(), 0, "components while the tree is detached");
				expectEqual(
					components.getComponent<Handler>(core),
					undefined,
					"getComponent on the detached descendant",
				);

				// A module igniting now reads the tagged instances out of the DataModel, and this
				// tree is not in it.
				const late = buildModule();
				const lateComponents = late.resolveDependency<Components>();
				expectEqual(lateComponents.getComponents<Handler>(core).size(), 0, "components a later module built");
				late.extinguish();

				// Dropping the tree in is the announcement.
				template.Parent = scratch();
				untilFound(
					() => components.getComponent<Handler>(core),
					"the component once the tree entered the DataModel",
				);
			});

			test("tears a destroyed instance down in the order a place does", () => {
				const components = createComponentModule();

				const owner = folder("DestroyOrder");
				const core = folderIn(owner, "Core");
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(owner, "Owner");

				expectDefined(components.getComponent<Owner>(owner), "component");

				const fired = new Array<string>();
				const destroying = owner.Destroying.Connect(() =>
					fired.push(`destroying:${owner.GetChildren().size()}`),
				);
				const childRemoved = owner.ChildRemoved.Connect(() => fired.push("childRemoved"));
				const descendantRemoving = owner.DescendantRemoving.Connect(() => fired.push("descendantRemoving"));

				const removed = new Array<string>();
				components.onComponentRemoved<Owner>((_component, instance) => removed.push(`Owner:${instance.Name}`));
				components.onComponentRemoved<Handler>((_component, instance) =>
					removed.push(`Handler:${instance.Name}`),
				);

				owner.Destroy();

				// Disconnected once whatever the destruction queued has been delivered: where the
				// place defers its signals a handler whose connection is gone by then is dropped.
				settle();
				destroying.Disconnect();
				childRemoved.Disconnect();
				descendantRemoving.Disconnect();

				// `Destroying` runs while the tree still stands; then the instance leaves the DataModel,
				// and its children come apart with its own connections still live, so its tree
				// handlers run for each child against a tree that is already out of the DataModel.
				// A component's own `ChildRemoved` handler does see that, and has to cope. Where the
				// place defers its signals the `Destroying` handler itself runs after the yield, when
				// the children are gone as well (measured 2026-09-13: `destroying:0`), and the rest
				// in the same order.
				const deferred = signalsAreDeferred();
				expectEqual(
					fired.join(", "),
					[deferred ? "destroying:0" : "destroying:1", "descendantRemoving", "childRemoved"].join(", "),
					`signals the destroyed instance fired (${deferred ? "deferred" : "immediate"})`,
				);

				// Both components go, because it is leaving the DataModel that announces their tags
				// as gone: the owner's on the way out, and the child's with it.
				expectArrayEqual(removed, ["Owner:DestroyOrder", "Handler:Core"], "removal notifications");
				expectEqual(components.getComponents<Handler>(core).size(), 0, "components left on the child");
				expectEqual(components.getComponents<Owner>(owner).size(), 0, "components left on the owner");
			});

			test("builds a component whose link names a component the same resumption would build", () => {
				const components = createComponentModule();

				const instance = folder("EagerLinkOwner");
				const core = folderIn(instance, "Core");

				// Both tagged in one resumption, the way a spawner leaves a tree. `getComponent`
				// builds what the tags are about to build, links included -- or finds what they
				// already built, in a place that announces tags at once. Either way, nothing builds
				// a second pair on top.
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(instance, "Owner");

				const built = expectDefined(
					components.getComponent<Owner>(instance),
					"component inside the resumption",
				);
				const handler = expectDefined(components.getComponent<Handler>(core), "the linked component it built");
				expectEqual(built.childComponents.Core, handler, "the link it resolved");
				settle();

				expectEqual(components.getComponent<Owner>(instance), built, "component once the tags were announced");
				expectEqual(components.getComponents<Owner>(instance).size(), 1, "components on the owner");
				expectEqual(components.getComponents<Handler>(core).size(), 1, "components on the child");

				// The same thing in the shape it usually arrives in: a tagged template cloned in and
				// asked for its component before the announcements land.
				const template = new Instance("Folder");
				template.Name = "SpawnTemplate";
				defer(() => template.Destroy());
				CollectionService.AddTag(folderIn(template, "Core"), "Handler");
				CollectionService.AddTag(template, "Owner");

				expectEqual(components.getComponents<Owner>(template).size(), 0, "components for the template itself");

				const spawned = template.Clone();
				spawned.Name = "Spawned";
				spawned.Parent = scratch();

				const clone = expectDefined(components.getComponent<Owner>(spawned), "component for the clone");
				settle();
				expectEqual(components.getComponent<Owner>(spawned), clone, "the clone's component once announced");
				expectEqual(components.getComponents<Owner>(spawned).size(), 1, "components on the clone");
			});

			test("builds a freshly tagged component eagerly when a link already tracks its instance", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				// The pointer's link gives `Handler`'s tracker an entry for the untagged instance, whose
				// tag criterion only the announcement writes. The eager path reads the tag now, as it
				// does with no entry at all. Where signals are deferred the announcement is still
				// queued when the component is asked for, which is the Lune case: the eager path
				// builds, and the announcement then finds what it built. Where they are immediate the
				// announcement has built it before `AddTag` returns, and the eager path finds that.
				const linked = folder("EagerTrackedLinked");
				pointer("EagerTrackedPointer", folder("EagerTrackedTarget"), linked);
				settle();

				const announced = announcements("Handler", linked);
				CollectionService.AddTag(linked, "Handler");
				expectEqual(announced.count, deferred ? 0 : 1, "announcements before the component is asked for");
				const built = expectDefined(
					components.getComponent<Handler>(linked),
					"component inside the resumption",
				);
				settle();

				expectEqual(announced.count, 1, "announcements once the thread yielded");
				expectEqual(components.getComponent<Handler>(linked), built, "component once the tag was announced");
				expectEqual(components.getComponents<Handler>(linked).size(), 1, "components on the instance");
			});

			test("writes an optional link attribute's default to the instance, and clears it back to nothing", () => {
				const components = createComponentModule();

				const instance = folder("DefaultedSpare");
				CollectionService.AddTag(instance, "SpareDefault");

				const component = expectDefined(components.getComponent<SpareDefault>(instance), "component");
				expectEqual(component.attributes.Spare, DEFAULT_LINK_TARGET, "attribute holds the default instance");

				// The default is written to the instance as well, exactly as a required link's is.
				// An optional guard accepts a missing attribute, which is not a reason to leave the
				// instance out of step with the component reading it.
				const written = instance.GetAttribute("Spare");
				expectTrue(typeIs(written, "InstanceHandle"), "the default was written as a handle");
				expectEqual((written as InstanceHandle).Get(), DEFAULT_LINK_TARGET, "the handle names the default");

				// And clearing an optional link clears it: a default stands in for an attribute the
				// component was built without, not for one it has just written away.
				component.clearSpare();

				expectEqual(component.attributes.Spare, undefined, "attribute after it was cleared");
				expectEqual(instance.GetAttribute("Spare"), undefined, "the attribute on the instance after the clear");
			});

			test("settles a link cycle whose removal is announced after the component was rebuilt", () => {
				const components = createComponentModule();

				const first = folder("DeferredTwinA");
				const second = folder("DeferredTwinB");
				CollectionService.AddTag(first, "Twin");
				CollectionService.AddTag(second, "Twin");

				expectDefined(components.getComponent<Twin>(first), "first component");
				expectDefined(components.getComponent<Twin>(second), "second component");

				first.SetAttribute("Partner", new InstanceHandle(second));
				second.SetAttribute("Partner", new InstanceHandle(first));
				settle();

				// A component's removal is announced through a BindableEvent. Where a place defers
				// those, the handler runs after this instance has been asked for its component again
				// and carries a new one, and taking the other half down for a component already
				// replaced would make the rebuild take this half down again, without end. Where
				// signals are immediate, the other half goes at once and each link names a component
				// that is not there, so neither can build. Either way the cycle has to settle, with
				// both halves up and linked to each other or both down: never one holding a link to
				// nothing.
				expectNoThrow(() => {
					components.removeComponent<Twin>(first);
					components.getComponent<Twin>(first);
				}, "the announcements");
				settle();

				const rebuilt = components.getComponent<Twin>(first);
				const partner = components.getComponent<Twin>(second);
				expectEqual(rebuilt === undefined, partner === undefined, "both halves of the cycle up, or both down");
				if (rebuilt !== undefined && partner !== undefined) {
					expectEqual(partner.attributeComponents.Partner, rebuilt, "the link the surviving component holds");
					expectEqual(rebuilt.attributeComponents.Partner, partner, "the link the rebuilt component holds");
				}
			});

			test("rebuilds a component when its linked child is swapped without ever going missing", () => {
				const components = createComponentModule();

				const instance = folder("SwappedInPlace");
				const first = folderIn(instance, "Core");
				CollectionService.AddTag(first, "Handler");
				CollectionService.AddTag(instance, "Owner");

				const owner = expectDefined(components.getComponent<Owner>(instance), "component");

				// The replacement is parented before the old child leaves, so the link never sees a
				// moment with no child at all. The old child is unparented rather than moved, which
				// is what a place does when it pools a part instead of destroying it: its own tag is
				// announced as gone on the way out, and the link still has to weigh the tree rather
				// than that announcement.
				const second = folderIn(instance, "Core");
				CollectionService.AddTag(second, "Handler");
				first.Parent = undefined;
				defer(() => first.Destroy());
				settle();

				const rebuilt = expectDefined(components.getComponent<Owner>(instance), "component after the swap");
				expectEqual(owner.destroyCount, 1, "takedowns of the component that held the old child");
				expectTrue(rebuilt !== owner, "the component was rebuilt rather than left holding the old child");
				expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(second), "the new child");
			});

			test("re-points a child link when the child it holds is renamed away and a sibling takes its name", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				const instance = folder("RenamedLink");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Handler");
				const spare = folderIn(instance, "Spare");
				CollectionService.AddTag(instance, "Owner");

				const owner = expectDefined(components.getComponent<Owner>(instance), "component");

				// A rename fires no child signal, so the link learns of the swap from the children's
				// own names: the child it holds is followed, and while the name resolves to nothing
				// every other child is followed as a candidate. Where signals are deferred both
				// renames are queued and the handler runs against the finished tree, so the Lune
				// order stands: the held child renamed away, then the sibling taking its name. Where
				// they are immediate the held child's rename is heard on its own and resolves to no
				// child at all; here the sibling takes the name first -- behind the child the link
				// holds, which still resolves -- and the held child's rename is what the link hears
				// (the next case takes the other order). Either way `Core` now names a child that
				// carries no `Handler`, and the component built around the old one comes down.
				if (deferred) {
					core.Name = "Old";
					spare.Name = "Core";
				} else {
					spare.Name = "Core";
					core.Name = "Old";
				}
				eventually(() => owner.destroyCount === 1, "the takedown after the swap");
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component while the child named Core has no Handler",
				);

				// The child the name resolves to now is the one the link watches: its component
				// arriving builds the owner around it, and leaving takes the owner down again.
				CollectionService.AddTag(spare, "Handler");
				const rebuilt = untilFound(
					() => components.getComponents<Owner>(instance)[0],
					"the component once the new Core carries Handler",
				);
				expectEqual(
					rebuilt.childComponents.Core,
					components.getComponent<Handler>(spare),
					"the child it holds",
				);

				CollectionService.RemoveTag(spare, "Handler");
				untilGone(
					() => components.getComponent<Owner>(instance),
					"the component after the new Core lost its Handler",
				);
				expectEqual(rebuilt.destroyCount, 1, "takedowns of the rebuilt component");

				// Renamed back the same way -- in the Lune order where signals are deferred, and where
				// they are immediate with the old child taking the name first, behind the one the
				// link holds, and that one renamed away -- the old child is `Core` again, and the link
				// follows it there too.
				if (deferred) {
					spare.Name = "Spare";
					core.Name = "Core";
				} else {
					core.Name = "Core";
					spare.Name = "Spare";
				}
				const restored = untilFound(
					() => components.getComponents<Owner>(instance)[0],
					"the component once the old child is Core again",
				);
				expectEqual(
					restored.childComponents.Core,
					components.getComponent<Handler>(core),
					"the child it holds again",
				);
			});

			test("re-points a child link when the child it holds is renamed away before a sibling takes its name", () => {
				const components = createComponentModule();

				// The Lune order of the case above, under every signal behaviour and asserted as the
				// Lune case asserts it. Where signals are deferred the two renames are one batch and
				// the link resolves against the finished tree. Where they are immediate the held
				// child's rename is heard alone and resolves to no child, which is when every other
				// child is followed as a candidate: the sibling's rename that follows is heard from
				// the sibling, the only thing that announces it.
				const instance = folder("RenamedLinkLuneOrder");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Handler");
				const spare = folderIn(instance, "Spare");
				CollectionService.AddTag(instance, "Owner");

				const owner = expectDefined(components.getComponent<Owner>(instance), "component");

				core.Name = "Old";
				spare.Name = "Core";
				eventually(() => owner.destroyCount === 1, "the takedown after the swap");
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"component while the child named Core has no Handler",
				);

				CollectionService.AddTag(spare, "Handler");
				const rebuilt = untilFound(
					() => components.getComponents<Owner>(instance)[0],
					"the component once the new Core carries Handler (the link heard the sibling take the name)",
				);
				expectEqual(
					rebuilt.childComponents.Core,
					components.getComponent<Handler>(spare),
					"the child it holds",
				);

				CollectionService.RemoveTag(spare, "Handler");
				untilGone(
					() => components.getComponent<Owner>(instance),
					"the component after the new Core lost its Handler",
				);

				spare.Name = "Spare";
				core.Name = "Core";
				const restored = untilFound(
					() => components.getComponents<Owner>(instance)[0],
					"the component once the old child is Core again",
				);
				expectEqual(
					restored.childComponents.Core,
					components.getComponent<Handler>(core),
					"the child it holds again",
				);
			});

			test("rebuilds a component around the child that replaced the one it was built with", () => {
				const components = createComponentModule();

				const root = folder("SwappedUnwatched");
				const model = new Instance("Model");
				model.Name = "SwappedUnwatchedModel";
				model.Parent = root;

				const core = partIn(model, "Core");
				defer(() => core.Destroy());
				const target = partIn(root, "SwappedUnwatchedTarget");
				const linked = partIn(root, "SwappedUnwatchedLinked");

				const created = Chassis.created;
				const destroyed = Chassis.destroyed;

				CollectionService.AddTag(linked, "Bolt");
				model.SetAttribute("Target", new InstanceHandle(target));
				model.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(model, "Chassis");
				CollectionService.AddTag(core, "Bolt");

				const component = expectDefined(components.getComponent<Chassis>(model), "component");
				expectEqual(component.childComponents.Core.instance, core, "the child it was built with");

				// The child leaves the DataModel entirely and one of the same name takes its place,
				// in the same resumption.
				core.Parent = undefined;
				const replacement = partIn(model, "Core");
				CollectionService.AddTag(replacement, "Bolt");
				settle();

				expectEqual(Chassis.created - created, 2, "constructions");
				expectEqual(Chassis.destroyed - destroyed, 1, "takedowns");

				const swapped = expectDefined(components.getComponent<Chassis>(model), "component after the swap");
				expectTrue(swapped !== component, "the component was rebuilt rather than left holding the old child");
				expectEqual(swapped.childComponents.Core, components.getComponent<Bolt>(replacement), "the new child");
				expectEqual(components.getComponent<Bolt>(core), undefined, "the component on the child that left");
			});

			test("rebuilds a component whose linked child was swapped while only a link was watching it", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				const outer = folder("ObservedSwapOuter");
				const inner = folder("ObservedSwapInner");
				const oldCore = folderIn(inner, "Core");
				outer.SetAttribute("Inner", new InstanceHandle(inner));

				let built: Owner | undefined;
				let newCore!: Folder;
				const swap = () => {
					built = expectDefined(components.getComponent<Owner>(inner), "component built through the link");

					newCore = folderIn(inner, "Core");
					CollectionService.AddTag(newCore, "Handler");
					oldCore.Parent = folder("ObservedSwapElsewhere");
				};

				// Where signals are immediate the inner instance's tag is what builds `Owner`, and the
				// pointer -- whose link waited for it -- is announced inside that same write; the swap
				// made from the pointer's added notification reaches an entry the tag path owns.
				if (!deferred) {
					const connection = components.onComponentAdded<OwnerPointer>(() => {
						if (built === undefined) swap();
					});
					defer(() => connection.Disconnect());
				}

				// Where they are deferred the announcements are queued in raise order, and the
				// pointer's builds `Owner` on the inner instance through its link -- the tag is on
				// the instance already -- against a tracker entry the link created, one nothing
				// waits on until the inner instance's own announcement, queued behind it. The swap
				// is queued between the two, so it reaches an entry only a link watches, which
				// cannot take the component down: the Lune case. (The tree signals the swap raises
				// join the queue behind the announcement -- the engine defers those as well, where
				// the Lune harness deferred only the tags -- so the loss itself is heard once the
				// tag path has the entry.)
				const announced = announcements("Owner", inner);
				CollectionService.AddTag(oldCore, "Handler");
				CollectionService.AddTag(outer, "OwnerPointer");
				const swapped = deferred
					? queued(() => {
							expectEqual(
								announced.count,
								0,
								"announcements of the inner instance's tag before the swap",
							);
							swap();
						})
					: undefined;
				CollectionService.AddTag(inner, "Owner");

				if (swapped !== undefined) {
					settle();
					swapped.rethrow();
				}

				const first = untilFound(() => built, "the component built through the link");
				eventually(() => first.destroyCount === 1, "the takedown of the component that held the old child");
				const rebuilt = untilFound(
					() => components.getComponent<Owner>(inner),
					"the component after the announcements",
				);
				expectTrue(rebuilt !== first, "the component was rebuilt rather than left holding the old child");
				expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(newCore), "the new child");
			});

			test("rebuilds a component whose linked child was swapped while only a dependent was waiting at it", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				const instance = folder("DependentSwap");
				const elsewhere = folder("DependentSwapElsewhere");
				const oldCore = addCore(instance);
				const newCore = addCore(elsewhere);
				CollectionService.AddTag(oldCore, "Handler");
				CollectionService.AddTag(newCore, "Handler");

				// The dependent's tag creates `Owner`'s entry on the instance, with the dependent waiting
				// at it and nothing owning it: the tag path has not read it yet.
				CollectionService.AddTag(instance, "OwnerCar");
				settle();
				expectEqual(
					components.getComponent<OwnerCar>(instance),
					undefined,
					"dependent before the owner exists",
				);

				// Where signals are deferred the announcement is still queued when the owner is asked
				// for, so the eager path builds it at the entry the dependent created, the dependent
				// is built on it, and the swap reaches that entry with only the dependent listening:
				// the Lune case, in which the loss is one the announcement still has to replay. (The
				// tree signals are deferred as well, so the loss is heard after the announcement,
				// where the Lune harness delivered it before.) Where they are immediate the owner is
				// built by its own tag at that entry, with the dependent built on it, and the swap
				// reaches an entry the tag path owns. Either way the outcome is the same, and is what
				// is asserted.
				const announced = announcements("Owner", instance);
				CollectionService.AddTag(instance, "Owner");
				expectEqual(announced.count, deferred ? 0 : 1, "announcements before the owner is asked for");
				const first = expectDefined(components.getComponent<Owner>(instance), "component once its tag arrived");
				expectDefined(components.getComponent<OwnerCar>(instance), "dependent once the owner was built");
				oldCore.Parent = elsewhere;
				newCore.Parent = instance;

				eventually(() => first.destroyCount === 1, "the takedown of the component that held the old child");
				expectEqual(announced.count, 1, "announcements once the thread yielded");
				const rebuilt = untilFound(
					() => components.getComponent<Owner>(instance),
					"the component after the announcement",
				);
				expectTrue(rebuilt !== first, "the component was rebuilt rather than left holding the old child");
				expectEqual(rebuilt.childComponents.Core, components.getComponent<Handler>(newCore), "the new child");
			});

			test("keeps a component built before its tag was announced when nothing about it changed", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				const pointer = folder("UnchangedPointer");
				const inner = folder("UnchangedInner");
				const core = addCore(inner);
				CollectionService.AddTag(pointer, "OwnerPointer");
				settle();

				const announced = announcements("Owner", inner);
				let built: Owner | undefined;
				if (deferred) {
					// The Lune order. The attribute change is raised first and the tag's announcement
					// after it, with a step queued between the two: the pointer's link reads the entry
					// it creates with the tag already on the instance and the guard met, and its own
					// child link unmet -- `Core` carries no `Handler` yet -- which is a loss nobody
					// hears. The step then tags the child and asks for the component, which the eager
					// path builds after that loss, from everything it described, with the announcement
					// still queued behind.
					pointer.SetAttribute("Inner", new InstanceHandle(inner));
					const asked = queued(() => {
						expectEqual(announced.count, 0, "announcements before the component is asked for");
						CollectionService.AddTag(core, "Handler");
						built = components.getComponent<Owner>(inner);
					});
					CollectionService.AddTag(inner, "Owner");
					settle();
					asked.rethrow();
				} else {
					// The pointer's link creates `Owner`'s entry on the inner instance before its tag is
					// there, and with its own child link unmet: `Core` carries no `Handler` yet. That
					// first reading is a loss nobody hears, and the entry is read a resumption before
					// the tags land, at once, and the component is asked for.
					pointer.SetAttribute("Inner", new InstanceHandle(inner));
					settle();
					expectEqual(
						components.getComponent<OwnerPointer>(pointer),
						undefined,
						"owner before the target is tagged",
					);

					CollectionService.AddTag(inner, "Owner");
					CollectionService.AddTag(core, "Handler");
					built = components.getComponent<Owner>(inner);
					settle();
				}
				const owner = expectDefined(built, "component asked for before its tag was announced");

				// Nothing has changed since the construction, so the entry keeps the component it
				// built rather than replaying the loss the component was built after.
				expectEqual(announced.count, 1, "announcements once the thread yielded");
				expectEqual(owner.destroyCount, 0, "takedowns by the tag's announcement");
				expectEqual(components.getComponent<Owner>(inner), owner, "the component after the announcement");
				expectEqual(components.getComponents<Owner>(inner).size(), 1, "components on the instance");
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Handler>(core),
					"the linked component it holds",
				);
				expectDefined(components.getComponent<OwnerPointer>(pointer), "owner once the link is met");
			});

			test("resolves a link to the component it names, not to whatever else is on the instance", () => {
				const components = createComponentModule();

				const instance = folder("Crowded");
				const core = folderIn(instance, "Core");

				// Two components on one child: the link names one of them and gets that one.
				CollectionService.AddTag(core, "Extra");
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(instance, "Owner");

				const owner = expectDefined(components.getComponent<Owner>(instance), "component");
				expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "the named component");
				expectTrue(components.getComponent<Extra>(core) !== undefined, "the other component is still there");

				// And losing the one it does not name changes nothing.
				CollectionService.RemoveTag(core, "Extra");
				settle();
				expectEqual(components.getComponent<Owner>(instance), owner, "component after the other one went");
			});

			test("names a component exactly: a subclass does not stand in for the class a link names", () => {
				const components = createComponentModule();

				const instance = folder("Subclassed");
				const core = folderIn(instance, "Core");

				// `DerivedHandler` is a `BaseHandler`, but a link resolves the class it names and
				// nothing else, so this is not the component the link is waiting for.
				CollectionService.AddTag(core, "DerivedHandler");
				CollectionService.AddTag(instance, "BaseOwner");
				expectEqual(
					components.getComponent<BaseOwner>(instance),
					undefined,
					"component with only the subclass",
				);

				CollectionService.AddTag(core, "BaseHandler");
				const owner = untilFound(
					() => components.getComponent<BaseOwner>(instance),
					"the component with the class named",
				);
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<BaseHandler>(core),
					"the named component",
				);
			});

			test("keeps a component when a subclass of the component its link names is removed", () => {
				const components = createComponentModule();

				const instance = folder("SubclassRemoved");
				const core = folderIn(instance, "Core");

				// Both are on the child, and a component announces its removal under every id it
				// inherits: the link names `BaseHandler`, which is still attached.
				CollectionService.AddTag(core, "BaseHandler");
				CollectionService.AddTag(core, "DerivedHandler");
				CollectionService.AddTag(instance, "BaseOwner");

				const owner = expectDefined(components.getComponent<BaseOwner>(instance), "component");

				CollectionService.RemoveTag(core, "DerivedHandler");
				untilGone(() => components.getComponent<DerivedHandler>(core), "the subclass after its tag went");
				settle();

				expectEqual(components.getComponent<BaseOwner>(instance), owner, "component after the subclass went");
			});

			test("waits for a linked component a predicate refuses instead of building one that throws", () => {
				const components = createComponentModule();

				// `Choosy` is only built under an instance named `Chosen`, so tagging the child is
				// not enough here: the link has to weigh everything `getComponent` weighs.
				const refused = folder("Refused");
				const refusedCore = folderIn(refused, "Core");
				CollectionService.AddTag(refusedCore, "Choosy");
				CollectionService.AddTag(refused, "ChoosyOwner");
				settle();

				expectEqual(components.getComponent<Choosy>(refusedCore), undefined, "the refused component");
				expectEqual(
					components.getComponent<ChoosyOwner>(refused),
					undefined,
					"component whose link is refused",
				);

				const chosen = folder("Chosen");
				const chosenCore = folderIn(chosen, "Core");
				CollectionService.AddTag(chosenCore, "Choosy");
				CollectionService.AddTag(chosen, "ChoosyOwner");

				const owner = expectDefined(
					components.getComponent<ChoosyOwner>(chosen),
					"component whose link is met",
				);
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Choosy>(chosenCore),
					"the linked component",
				);
			});

			test("warns for an instance whose tracker a link created before anything waited on it", () => {
				createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("ObservedFirst");
				const core = folderIn(instance, "Core"); // a Folder, so `Impatient` never qualifies

				// The link watches the child without waiting for it, which is what creates the
				// tracker.
				CollectionService.AddTag(instance, "ImpatientOwner");

				warnings.clear();
				CollectionService.AddTag(core, "Impatient");
				task.wait(0.3);

				expectTrue(warnings.mentions("Impatient"), `warnings: ${warnings.describe()}`);
			});

			test("drops the warning again when the tag goes while a link is still watching", () => {
				createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("UntaggedAgain");
				const core = folderIn(instance, "Core"); // a Folder, so `Impatient` never qualifies

				// The link creates the tracker entry, watching rather than waiting.
				CollectionService.AddTag(instance, "ImpatientOwner");

				warnings.clear();
				CollectionService.AddTag(core, "Impatient");
				CollectionService.RemoveTag(core, "Impatient");
				task.wait(0.3);

				// The tag armed the warning and then took itself away. The link holding the entry
				// open is watching rather than waiting, so there is nobody left for the warning to be
				// about.
				expectFalse(warnings.mentions("Impatient"), `warnings after the tag went: ${warnings.describe()}`);

				// And the entry has not spent its one warning: tagging it again waits again.
				warnings.clear();
				CollectionService.AddTag(core, "Impatient");
				task.wait(0.3);

				expectTrue(warnings.mentions("Impatient"), `warnings after tagging again: ${warnings.describe()}`);
			});

			test("leaves the dependencies of a component a link only watches unwarned", () => {
				createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("WatchedDependency");
				folderIn(instance, "Core"); // never tagged with anything

				warnings.clear();

				// The link watches `Core` for `Starter`, whose own tracker watches it for
				// `Ignition`. Neither is being waited for: nothing on that instance is tagged with
				// either.
				CollectionService.AddTag(instance, "StarterOwner");
				task.wait(0.3);

				expectFalse(warnings.mentions("Ignition"), `warnings: ${warnings.describe()}`);
			});

			test("leaves a link unmet when the component it names sits under a blocked ancestor", () => {
				const components = createComponentModule();

				// Tagged before the link ever looks at it.
				const early = storageFolder("BlockedEarly");
				CollectionService.AddTag(early, "Handler");
				const earlyOwner = pointer("BlockedOwnerEarly", folder("BlockedTargetEarly"), early);

				expectEqual(
					components.getComponent<Pointer>(earlyOwner),
					undefined,
					"component linked to an instance under a blocked ancestor",
				);

				// And the other way round: the link watches the instance first, the tag arrives
				// after.
				const late = storageFolder("BlockedLate");
				const lateOwner = pointer("BlockedOwnerLate", folder("BlockedTargetLate"), late);
				CollectionService.AddTag(late, "Handler");
				settle();

				expectEqual(
					components.getComponent<Pointer>(lateOwner),
					undefined,
					"component linked to an instance tagged after the link watched it",
				);

				// Neither order built the linked component, which is what the ancestor lists are
				// for. Counted with `getComponents`, which looks rather than constructs the way
				// `getComponent` would.
				expectEqual(
					components.getComponents<Handler>(early).size(),
					0,
					"components on the instance tagged first",
				);
				expectEqual(
					components.getComponents<Handler>(late).size(),
					0,
					"components on the instance tagged later",
				);
			});

			test("answers getComponent for a blocked instance the same whether or not a link watches it", () => {
				const components = createComponentModule();

				const watched = storageFolder("WatchedBlocked");
				const owner = pointer("WatchedBlockedOwner", folder("WatchedBlockedTarget"), watched);
				CollectionService.AddTag(watched, "Handler");

				const control = storageFolder("UnwatchedBlocked");
				CollectionService.AddTag(control, "Handler");

				// `getComponent` builds a component for a tagged instance whatever its ancestry, and
				// a link watching that instance is not allowed to change the answer it gives.
				expectDefined(components.getComponent<Handler>(control), "component for an instance nothing watches");
				const handler = expectDefined(
					components.getComponent<Handler>(watched),
					"component for an instance a link watches",
				);

				// Once it is there, the link is met by it: the ancestor lists gate construction, not
				// what a link accepts from an instance that already carries the component.
				const built = untilFound(
					() => components.getComponent<Pointer>(owner),
					"the component whose link is now met",
				);
				expectEqual(built.attributeComponents.Linked, handler, "the link's component");
			});

			test("waits for a link attribute whose guard only passes once the target's tree fills in", () => {
				const components = createComponentModule();

				// The guard on a link to `LateRig` carries that component's tree, so a folder
				// without a `Root` fails it. Nothing about the attribute changes afterwards: the tree
				// does.
				const rig = folder("LateRigTarget");
				const owner = folder("LateRigOwner1");
				owner.SetAttribute("Rigged", new InstanceHandle(rig));
				CollectionService.AddTag(owner, "LateRigOwner");

				expectEqual(
					components.getComponent<LateRigOwner>(owner),
					undefined,
					"owner while the target has no tree of its own",
				);

				folderIn(rig, "Root");
				CollectionService.AddTag(rig, "LateRig");
				settle();

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
			});

			test("follows a plain link attribute's guard as the instance it names gains and loses its tree", () => {
				const components = createComponentModule();

				// Nothing but the guard here: no component names the target, so its tree is the
				// only thing there is to watch.
				const target = folder("RootedTarget");
				const instance = folder("Rooted1");
				instance.SetAttribute("Target", new InstanceHandle(target));
				CollectionService.AddTag(instance, "Rooted");

				expectEqual(components.getComponent<Rooted>(instance), undefined, "component while the target is bare");

				const root = folderIn(target, "Root");
				settle();

				expectDefined(
					components.getComponent<Rooted>(instance),
					"component once the target's tree is complete",
				);

				// The guard is a criterion, so it holds in both directions.
				root.Destroy();
				settle();

				expectEqual(
					components.getComponent<Rooted>(instance),
					undefined,
					"component after the target's tree broke apart",
				);
			});

			test("asks a component's instance guard again when its tag arrives at an entry a link created", () => {
				const components = createComponentModule();

				// `Strict` declares a plain Folder and demands a `Root` child through a guard of its
				// own, so the link's guard passes at once and the component's does not.
				const target = folder("StrictLinked");
				const owner = folder("StrictOwner1");
				owner.SetAttribute("Linked", new InstanceHandle(target));
				CollectionService.AddTag(owner, "StrictOwner");

				expectEqual(
					components.getComponent<StrictOwner>(owner),
					undefined,
					"owner before the target is tagged",
				);

				// The control: the same instance and the same order, with nothing linked to it.
				const control = folder("StrictControl");

				for (const instance of [target, control]) {
					folderIn(instance, "Root");
					CollectionService.AddTag(instance, "Strict");
				}
				settle();

				expectDefined(components.getComponent<Strict>(control), "the component nothing links to");
				expectDefined(components.getComponent<Strict>(target), "the component a link watches");
				expectDefined(components.getComponent<StrictOwner>(owner), "owner once the link is met");
			});

			test("asks a component's child link again when its tag arrives at an entry a link created", () => {
				const components = createComponentModule();

				// `FrozenOwner` reads its tree once, and its child link with it. The pointer's link
				// creates the entry while there is no `Core` at all, so the link is read as unmet -- an
				// answer nothing would ever correct if the entry kept it, where an instance nothing
				// links to would be read afresh when its tag arrives.
				const inner = folder("FrozenPointedInner");
				const outer = folder("FrozenPointedOuter");
				outer.SetAttribute("Inner", new InstanceHandle(inner));
				CollectionService.AddTag(outer, "FrozenOwnerPointer");
				settle();
				expectEqual(
					components.getComponent<FrozenOwnerPointer>(outer),
					undefined,
					"owner before the target is tagged",
				);

				// The control: the same instance and the same order, with nothing linked to it.
				const control = folder("FrozenPointedControl");

				for (const instance of [inner, control]) {
					CollectionService.AddTag(addCore(instance), "Handler");
					CollectionService.AddTag(instance, "FrozenOwner");
				}
				settle();

				expectDefined(components.getComponent<FrozenOwner>(control), "the component nothing links to");
				untilFound(() => components.getComponents<FrozenOwner>(inner)[0], "the component a link watches");
				expectDefined(components.getComponent<FrozenOwnerPointer>(outer), "owner once the link is met");

				// The same entry asked for in the resumption the tag arrives in.
				const eagerInner = folder("FrozenPointedEagerInner");
				const eagerOuter = folder("FrozenPointedEagerOuter");
				eagerOuter.SetAttribute("Inner", new InstanceHandle(eagerInner));
				CollectionService.AddTag(eagerOuter, "FrozenOwnerPointer");
				settle();

				CollectionService.AddTag(addCore(eagerInner), "Handler");
				CollectionService.AddTag(eagerInner, "FrozenOwner");
				expectDefined(components.getComponent<FrozenOwner>(eagerInner), "the component asked for eagerly");
				settle();
				expectDefined(
					components.getComponent<FrozenOwnerPointer>(eagerOuter),
					"owner once the eager link is met",
				);
			});

			test("asks a component's instance guard again when its tag arrives at an entry a dependency created", () => {
				const components = createComponentModule();

				// The dependent's tag creates `Strict`'s entry while there is no `Root`, so its guard is
				// read as failing -- and `Strict` reads its tree once. The dependent waits at that
				// entry, which is not the same as the tag path having read it: nothing keeps it
				// current, and the tag arriving has to read the tree the way it would with no entry.
				const instance = folder("StrictDependent");
				CollectionService.AddTag(instance, "StrictCar");
				settle();
				expectEqual(components.getComponent<StrictCar>(instance), undefined, "dependent before Strict exists");

				// The control: the same instance and the same order, with nothing depending on it.
				const control = folder("StrictDependentControl");

				for (const target of [instance, control]) {
					folderIn(target, "Root");
					CollectionService.AddTag(target, "Strict");
				}
				settle();

				expectDefined(components.getComponent<Strict>(control), "the component nothing depends on");
				untilFound(() => components.getComponents<Strict>(instance)[0], "the component a dependent waits for");
				untilFound(
					() => components.getComponents<StrictCar>(instance)[0],
					"the dependent once its dependency is built",
				);
			});

			test("asks a component's child link again when its tag arrives at an entry a dependency created", () => {
				const components = createComponentModule();

				// As above, for a link read once: the dependent's tag creates `FrozenOwner`'s entry
				// while there is no `Core` at all.
				const instance = folder("FrozenDependent");
				CollectionService.AddTag(instance, "FrozenOwnerCar");
				settle();
				expectEqual(
					components.getComponent<FrozenOwnerCar>(instance),
					undefined,
					"dependent before the owner exists",
				);

				const control = folder("FrozenDependentControl");

				for (const target of [instance, control]) {
					CollectionService.AddTag(addCore(target), "Handler");
					CollectionService.AddTag(target, "FrozenOwner");
				}
				settle();

				expectDefined(components.getComponent<FrozenOwner>(control), "the component nothing depends on");
				untilFound(
					() => components.getComponents<FrozenOwner>(instance)[0],
					"the component a dependent waits for",
				);
				untilFound(
					() => components.getComponents<FrozenOwnerCar>(instance)[0],
					"the dependent once its dependency is built",
				);
			});

			test("builds a freshly tagged component eagerly when a dependency already tracks its instance", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				// The control: nothing tracks the instance, so the eager path reads the tag itself.
				const control = folder("EagerEngineControl");
				const controlAnnounced = announcements("Engine", control);
				CollectionService.AddTag(control, "Engine");
				expectEqual(
					controlAnnounced.count,
					deferred ? 0 : 1,
					"announcements of the control's tag before it is asked for",
				);
				expectDefined(components.getComponent<Engine>(control), "engine nothing depends on, asked for eagerly");

				// `Car` depends on `Engine`, so Engine's entry exists before Engine's own tag is
				// announced, with its tag criterion written only by that announcement. The eager path
				// has to read the tag now, as it does with no entry at all. Where signals are deferred
				// it is asked in between, which is the Lune case; where they are immediate it finds
				// what the announcement built at that entry.
				const instance = folder("EagerEngine");
				CollectionService.AddTag(instance, "Car");
				settle();
				expectEqual(components.getComponent<Car>(instance), undefined, "car before its engine");

				const announced = announcements("Engine", instance);
				CollectionService.AddTag(instance, "Engine");
				expectEqual(announced.count, deferred ? 0 : 1, "announcements before the engine is asked for");
				const engine = expectDefined(
					components.getComponent<Engine>(instance),
					"engine a dependent waits for, asked for eagerly",
				);
				const car = untilFound(() => components.getComponent<Car>(instance), "the car once its engine exists");
				expectEqual(car.engine, engine, "the engine the car holds");
				settle();
				expectEqual(announced.count, 1, "announcements once the thread yielded");
				expectEqual(components.getComponents<Engine>(instance).size(), 1, "engines once the tag was announced");
			});

			test("takes a component down when the component a re-read child link names goes, whatever the streaming mode", () => {
				const components = createComponentModule();

				const inner = folder("RereadInner");
				const outer = folder("RereadOuter");

				// The link creates the entry before `Core` exists: the child link is read once as unmet,
				// and only the re-read at the tag's arrival sees the child. What that re-read resolves
				// to is what the link watches from then on.
				outer.SetAttribute("Inner", new InstanceHandle(inner));
				CollectionService.AddTag(outer, "FrozenOwnerPointer");
				settle();

				const core = addCore(inner);
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(inner, "FrozenOwner");
				const owner = untilFound(() => components.getComponents<FrozenOwner>(inner)[0], "owner");
				untilFound(() => components.getComponent<FrozenOwnerPointer>(outer), "pointer");
				expectEqual(owner.childComponents.Core, components.getComponent<Handler>(core), "the linked component");

				// The component the link names goes, which is a lifecycle event rather than the tree
				// moving, and is noticed under a streaming mode that reads the tree once.
				CollectionService.RemoveTag(core, "Handler");
				untilGone(() => components.getComponent<Handler>(core), "the handler after its tag went");
				untilGone(
					() => components.getComponent<FrozenOwner>(inner),
					"the owner after its linked component went",
				);
				untilGone(() => components.getComponent<FrozenOwnerPointer>(outer), "the pointer after the owner went");
			});

			test("re-points a re-read child link at the child the component was built from", () => {
				const components = createComponentModule();

				const inner = folder("RepointedInner");
				const outer = folder("RepointedOuter");
				const elsewhere = folder("RepointedElsewhere");
				const core1 = addCore(inner);
				CollectionService.AddTag(core1, "Handler");

				// The link creates the entry with the first child in place, so the child link watches it.
				outer.SetAttribute("Inner", new InstanceHandle(inner));
				CollectionService.AddTag(outer, "FrozenOwnerPointer");
				settle();

				// The child is swapped while nothing follows the tree, and then the tag arrives: the
				// component is built out of the tree as it is now, and the link is re-pointed at that
				// child rather than left on the one it happened to see first.
				core1.Parent = elsewhere;
				const core2 = addCore(inner);
				CollectionService.AddTag(core2, "Handler");
				settle();
				CollectionService.AddTag(inner, "FrozenOwner");
				const owner = untilFound(() => components.getComponents<FrozenOwner>(inner)[0], "owner");
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Handler>(core2),
					"built from the child the tree holds",
				);

				// The first child loses its component, which the owner was never built from.
				CollectionService.RemoveTag(core1, "Handler");
				untilGone(
					() => components.getComponent<Handler>(core1),
					"the first child's component after its tag went",
				);
				settle();
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
				CollectionService.RemoveTag(core2, "Handler");
				untilGone(
					() => components.getComponent<FrozenOwner>(inner),
					"the owner after its linked component went",
				);
			});

			test("drops a component whose tree breaks after its tag reached an entry a link created", () => {
				const components = createComponentModule();

				// The link creates the entry for `LateRig` while the target's only child is named
				// something else, so the instance guard fails and the tracker is watching the tree
				// for the child that would complete it.
				const rig = folder("DesyncedRig");
				const child = folderIn(rig, "Wrong");
				defer(() => child.Destroy());
				const owner = folder("DesyncedRigOwner");
				owner.SetAttribute("Rigged", new InstanceHandle(rig));
				CollectionService.AddTag(owner, "LateRigOwner");

				expectEqual(
					components.getComponent<LateRig>(rig),
					undefined,
					"the linked component while the target has no tree",
				);

				// A rename fires no descendant signal, so the guard starts passing with nothing
				// announcing it: the tag arriving is what asks again. What it learns has to reach the
				// poll as well, which is now watching for the change that has already happened.
				child.Name = "Root";
				CollectionService.AddTag(rig, "LateRig");
				settle();

				expectDefined(components.getComponent<LateRig>(rig), "the linked component once the tree is complete");
				expectDefined(components.getComponent<LateRigOwner>(owner), "owner once the link is met");

				// `Watching`, so the tree is re-checked in both directions, however the guard came
				// to pass.
				child.Parent = undefined;
				settle();

				expectEqual(
					components.getComponent<LateRig>(rig),
					undefined,
					"the linked component after its tree broke",
				);
				expectEqual(
					components.getComponent<LateRigOwner>(owner),
					undefined,
					"owner after the link's tree broke",
				);
			});

			test("builds a component whose tree is repaired after its tag reached an entry a link created", () => {
				const components = createComponentModule();

				// The mirror of the case above: the link creates the entry while the target's tree
				// is complete, so the tracker is watching for the child that would break it.
				const rig = folder("StuckRig");
				const child = folderIn(rig, "Root");
				const owner = folder("StuckRigOwner");
				owner.SetAttribute("Rigged", new InstanceHandle(rig));
				CollectionService.AddTag(owner, "LateRigOwner");

				expectEqual(
					components.getComponent<LateRigOwner>(owner),
					undefined,
					"owner before the target is tagged",
				);

				// The tree breaks without a signal announcing it either, so the tag arrives at a
				// guard that has started failing since the link looked.
				child.Name = "Wrong";
				CollectionService.AddTag(rig, "LateRig");
				settle();

				expectEqual(
					components.getComponent<LateRig>(rig),
					undefined,
					"the linked component while its tree is broken",
				);

				// And the repair is an ordinary child arriving, which is the change the poll has to
				// be listening for now that the guard fails.
				const replacement = folderIn(rig, "Root");
				settle();

				const built = expectDefined(
					components.getComponent<LateRig>(rig),
					"the linked component once its tree was repaired",
				);
				expectEqual(built.instance.Root, replacement, "the child the guard passed on");
				expectDefined(components.getComponent<LateRigOwner>(owner), "owner once the link is met");
			});

			test("asks a blocked instance's guard again when its tag arrives at an entry a link created", () => {
				const components = createComponentModule();

				// The tag never reaches the tracker's own listener here, because the ancestor lists
				// keep Flamework from constructing under ReplicatedStorage. The entry a link created
				// is still there, and must not be left answering with the guard's verdict from before
				// the tree was finished.
				const target = storageFolder("BlockedStrict");
				const owner = folder("BlockedStrictOwner");
				owner.SetAttribute("Linked", new InstanceHandle(target));
				CollectionService.AddTag(owner, "StrictOwner");

				// The control: the same instance, in the same place, in the same order, with nothing
				// linked to it.
				const control = storageFolder("BlockedStrictControl");

				for (const instance of [target, control]) {
					folderIn(instance, "Root");
					CollectionService.AddTag(instance, "Strict");
				}
				settle();

				expectDefined(components.getComponent<Strict>(control), "the blocked component nothing links to");
				const linked = expectDefined(
					components.getComponent<Strict>(target),
					"the blocked component a link watches",
				);

				// The escape hatch the ancestor lists leave open: a component that is already
				// attached to a blocked instance satisfies the link, whoever built it.
				const built = untilFound(
					() => components.getComponent<StrictOwner>(owner),
					"the owner once the link is met",
				);
				expectEqual(built.attributeComponents.Linked, linked, "the link's component");
			});

			test("leaves a link unmet when it is re-pointed at a component under a blocked ancestor", () => {
				const components = createComponentModule();
				const warnings = recordWarnings();

				const linked = handlerFolder("RepointBlockedLinked");
				const instance = pointer("RepointBlocked", folder("RepointBlockedTarget"), linked);
				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				// Tagged and correctly unbuilt: the ancestor lists refuse to construct one here, and
				// a link is Flamework driving construction just as the tag is.
				const written = storageFolder("RepointBlockedWritten");
				const external = storageFolder("RepointBlockedExternal");
				CollectionService.AddTag(written, "Handler");
				CollectionService.AddTag(external, "Handler");

				warnings.clear();
				component.relink(written);
				settle();

				expectEqual(components.getComponents<Handler>(written).size(), 0, "components after the refused write");
				expectEqual(component.attributes.Linked, linked, "attribute after the refused write");
				expectTrue(
					warnings.mentions("has no component"),
					`warnings after the refused write: ${warnings.describe()}`,
				);

				// The same re-point from outside: the link goes unmet rather than building a
				// component where neither a tag nor a link is allowed to.
				instance.SetAttribute("Linked", new InstanceHandle(external));
				settle();

				expectEqual(components.getComponents<Handler>(external).size(), 0, "components after the re-point");
				expectEqual(components.getComponent<Pointer>(instance), undefined, "owner after the re-point");
			});

			test("cancels a dependency's warning when the tag goes while a link is still watching", () => {
				createComponentModule();
				const warnings = recordWarnings();

				// The link creates both entries -- `Starter` on the child, and `Ignition` under it
				// -- before anything waits for either of them.
				const instance = folder("ChainUntagged");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(instance, "StarterOwner");

				warnings.clear();
				CollectionService.AddTag(core, "Starter");
				CollectionService.RemoveTag(core, "Starter");
				task.wait(0.3);

				expectFalse(warnings.mentions("Ignition"), `warnings after the tag went: ${warnings.describe()}`);

				// And the other order, where the dependency's entry was waiting before the link ever
				// watched the component that depends on it.
				const mirror = folder("ChainUntaggedMirror");
				const mirrorCore = folderIn(mirror, "Core");

				warnings.clear();
				CollectionService.AddTag(mirrorCore, "Starter");
				CollectionService.AddTag(mirror, "StarterOwner");
				CollectionService.RemoveTag(mirrorCore, "Starter");
				task.wait(0.3);

				expectFalse(
					warnings.mentions("Ignition"),
					`warnings after the tag went in the other order: ${warnings.describe()}`,
				);
			});

			test("freezes a link attribute when refreshAttributes is off", () => {
				const components = createComponentModule();

				const first = folder("FrozenPointerFirst");
				const instance = folder("FrozenPointer1");
				instance.SetAttribute("Target", new InstanceHandle(first));
				CollectionService.AddTag(instance, "FrozenPointer");

				const component = expectDefined(components.getComponent<FrozenPointer>(instance), "component");
				expectEqual(component.attributes.Target, first, "attribute as the link resolved it");

				const changes = new Array<string>();
				component.onAttributeChanged("Target", (newValue) => changes.push(tostring(newValue)));

				instance.SetAttribute("Target", new InstanceHandle(folder("FrozenPointerSecond")));
				settle();

				expectEqual(component.attributes.Target, first, "attribute after an external re-point");
				expectEqual(changes.size(), 0, "onAttributeChanged calls");

				// The component's own write still lands, as a plain attribute's does with tracking
				// off, and -- exactly as a plain one -- it announces nothing.
				const second = folder("FrozenPointerOwn");
				component.attributes.Target = second;

				const written = instance.GetAttribute("Target");
				expectEqual(component.attributes.Target, second, "attribute after the component wrote it");
				expectTrue(
					typeIs(written, "InstanceHandle") && written.Get() === second,
					"the handle the component's own write left on the instance",
				);
				expectEqual(changes.size(), 0, "onAttributeChanged calls with refreshAttributes off");

				// It is the component's view of the attribute that is frozen, not the criterion
				// behind it: a re-point the guard refuses still takes the component down.
				const part = partIn(scratch(), "FrozenPointerPart");
				instance.SetAttribute("Target", new InstanceHandle(part));

				untilGone(
					() => components.getComponent<FrozenPointer>(instance),
					"the component after a re-point its guard refuses",
				);
			});

			test("removes both components of a link cycle exactly once", () => {
				const components = createComponentModule();

				const first = folder("TwinA");
				const second = folder("TwinB");
				CollectionService.AddTag(first, "Twin");
				CollectionService.AddTag(second, "Twin");

				const componentA = expectDefined(components.getComponent<Twin>(first), "first component");
				const componentB = expectDefined(components.getComponent<Twin>(second), "second component");

				// The link is optional, so both are built before either points anywhere; pointing
				// them at each other is what closes the cycle.
				first.SetAttribute("Partner", new InstanceHandle(second));
				second.SetAttribute("Partner", new InstanceHandle(first));
				settle();

				expectEqual(componentA.attributeComponents.Partner, componentB, "the first link");
				expectEqual(componentB.attributeComponents.Partner, componentA, "the second link");

				const removed = new Array<string>();
				components.onComponentRemoved<Twin>((_component, instance) => removed.push(instance.Name));

				// Each component's removal takes the other's link with it, and the announcement
				// must not find its way back into the removal it came from.
				components.removeComponent<Twin>(first);
				settle();

				expectEqual(components.getComponent<Twin>(first), undefined, "first component after the removal");
				expectEqual(components.getComponent<Twin>(second), undefined, "second component after the removal");
				expectEqual(removed.size(), 2, `removal notifications: ${removed.join(", ")}`);
				expectTrue(removed.includes("TwinA"), "the first component announced its removal");
				expectTrue(removed.includes("TwinB"), "the second component announced its removal");
				expectEqual(componentA.destroyCount, 1, "times the first component was destroyed");
				expectEqual(componentB.destroyCount, 1, "times the second component was destroyed");
			});

			test("builds nothing for a component a removal handler asks for while it is being removed", () => {
				const components = createComponentModule();

				const instance = folder("RemovalReentry");
				CollectionService.AddTag(instance, "Handler");
				const removed = expectDefined(components.getComponent<Handler>(instance), "component");
				announced();

				// A hand removal touches neither the tag nor the tracker, so the instance still
				// qualifies while its component is being taken apart: `getComponent` has to answer
				// for a component that has left rather than build the replacement nobody was told
				// about.
				let seen: Handler | undefined;
				let asked = false;
				const connection = components.onComponentRemoved<Handler>((_component, target) => {
					asked = true;
					seen = components.getComponent<Handler>(target);
				});

				components.removeComponent<Handler>(instance);
				const attachedAfterRemoval = components.getComponents<Handler>(instance).size();
				eventually(() => asked, "the removal handler to run");
				connection.Disconnect();

				expectEqual(attachedAfterRemoval, 0, "components still attached after removeComponent returned");
				if (signalsAreDeferred()) {
					// The announcement is a BindableEvent, which this place delivers once the thread
					// yields: the handler runs after the removal, not inside it, against an instance
					// still tagged and holding no component, so what it asks for is built for it --
					// a replacement, not the one that left -- and is the component from then on.
					const fresh = expectDefined(seen, "getComponent from the removal handler, run after the removal");
					expectTrue(fresh !== removed, "the handler got a fresh component rather than the one that left");
					expectEqual(
						components.getComponent<Handler>(instance),
						fresh,
						"component asked for after the removal",
					);
				} else {
					expectEqual(seen, undefined, "getComponent inside the removal handler");

					// Still tagged, so asking for it afterwards builds one, the way it always has.
					expectDefined(components.getComponent<Handler>(instance), "component asked for after the removal");
				}
			});

			test("leaves a component unbuilt while a link attribute names its own instance", () => {
				const components = createComponentModule();

				const instance = folder("SelfLink");
				instance.SetAttribute("Partner", new InstanceHandle(instance));

				// The link names the very component the tag is about to build, so it cannot be met
				// on the way in: it has to report itself unmet rather than report itself met and
				// raise out of the construction it asked for.
				expectNoThrow(() => {
					CollectionService.AddTag(instance, "Twin");
				}, "tagging an instance whose link names itself");
				settle();

				expectEqual(
					components.getComponent<Twin>(instance),
					undefined,
					"component while the link names itself",
				);

				// The link is optional, so clearing it builds the component...
				instance.SetAttribute("Partner", undefined);
				const component = untilFound(
					() => components.getComponent<Twin>(instance),
					"the component once the link cleared",
				);

				// ...and pointing it back at its own instance resolves to the component now attached.
				instance.SetAttribute("Partner", new InstanceHandle(instance));
				eventually(() => component.attributeComponents.Partner === component, "the link to resolve to itself");
			});

			test("re-resolves a child link when the child is replaced by another instance", () => {
				const components = createComponentModule();

				const instance = folder("Replaced");
				const first = folderIn(instance, "Core");
				CollectionService.AddTag(first, "Handler");
				CollectionService.AddTag(instance, "Owner");

				const owner = expectDefined(components.getComponent<Owner>(instance), "component");
				expectEqual(owner.childComponents.Core, components.getComponent<Handler>(first), "the first child");

				// Swapped for another instance of the same name: the link follows the child, not
				// the component it happened to resolve to first.
				first.Parent = undefined;
				defer(() => first.Destroy());
				const second = folderIn(instance, "Core");
				CollectionService.AddTag(second, "Handler");
				settle();

				const replaced = expectDefined(components.getComponent<Owner>(instance), "component after the swap");
				expectEqual(
					replaced.childComponents.Core,
					components.getComponent<Handler>(second),
					"the second child",
				);
			});

			test("writes an attribute through to the instance", () => {
				const components = createComponentModule();

				const instance = folder("Written", { speed: 3 });
				CollectionService.AddTag(instance, "Tagged");

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
			});

			test("refuses a write whose value does not match the attribute it is written to", () => {
				const components = createComponentModule();

				const instance = folder("BadWrite", { speed: 3 });
				CollectionService.AddTag(instance, "Tagged");

				const component = expectDefined(components.getComponent<Tagged>(instance), "component");

				// The cast is the point: nothing in the type system stops this, so the guard has to.
				const message = expectThrows(() => component.misassign("fast"), "writing a string to a number");
				expectTrue(message.find("not a valid value", 1, true)[0] !== undefined, "message names the attribute");

				// Neither the component nor the instance is left holding the bad value.
				expectEqual(component.attributes.speed, 3, "attribute after the refused write");
				expectEqual(instance.GetAttribute("speed"), 3, "instance attribute after the refused write");

				expectThrows(() => component.clearSpeed(), "clearing a required attribute");
				expectEqual(component.attributes.speed, 3, "attribute after the refused clear");
				expectEqual(instance.GetAttribute("speed"), 3, "instance attribute after the refused clear");
			});

			test("leaves a component uncreated while a required link attribute is missing", () => {
				const components = createComponentModule();

				const linked = handlerFolder("MissingLinked");

				// No `Target` at all: the attribute guard has nothing to check and the link nothing
				// to resolve, so neither the tag nor `addComponent` can produce a component.
				const instance = folder("MissingAttribute");
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				expectEqual(
					components.getComponent<Pointer>(instance),
					undefined,
					"component with the attribute missing",
				);
				expectThrows(
					() => components.addComponent<Pointer>(instance),
					"addComponent with the attribute missing",
				);
			});

			test("rejects a link attribute that is not a handle", () => {
				const components = createComponentModule();

				const linked = handlerFolder("BadTypeLinked");

				const instance = folder("BadAttributeType");
				instance.SetAttribute("Target", "not a handle");
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				expectEqual(
					components.getComponent<Pointer>(instance),
					undefined,
					"component with a bad attribute type",
				);

				const message = expectThrows(() => components.addComponent<Pointer>(instance), "addComponent");
				expectTrue(message.find("invalid attribute", 1, true)[0] !== undefined, "message names the attribute");
			});

			test("rejects a handle that names an instance of the wrong class", () => {
				const components = createComponentModule();

				const linked = handlerFolder("WrongClassLinked");

				// `Target` is declared as a Folder, so a Part does not pass the link's guard even
				// though the attribute itself is a perfectly good handle.
				const part = partIn(scratch(), "NotAFolder");

				const instance = folder("WrongClass");
				instance.SetAttribute("Target", new InstanceHandle(part));
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				expectEqual(components.getComponent<Pointer>(instance), undefined, "component with a bad target class");
				expectThrows(() => components.addComponent<Pointer>(instance), "addComponent with a bad target class");
			});

			test("removes a component when a link attribute is re-pointed at the wrong class", () => {
				const components = createComponentModule();

				const linked = handlerFolder("RepointBadLinked");
				const instance = pointer("RepointBad", folder("RepointBadTarget"), linked);
				expectDefined(components.getComponent<Pointer>(instance), "component while the link is valid");

				const part = partIn(scratch(), "RepointBadPart");
				instance.SetAttribute("Target", new InstanceHandle(part));
				untilGone(() => components.getComponent<Pointer>(instance), "the component after a bad re-point");

				// Pointed back at something valid, it comes back, the way a tag or a tree does.
				instance.SetAttribute("Target", new InstanceHandle(folder("RepointGoodTarget")));
				untilFound(
					() => components.getComponent<Pointer>(instance),
					"the component after pointing back at a folder",
				);
			});

			test("removes a component when a required link attribute is cleared", () => {
				const components = createComponentModule();

				const linked = handlerFolder("ClearedLinked");
				const instance = pointer("Cleared", folder("ClearedTarget"), linked);
				expectDefined(components.getComponent<Pointer>(instance), "component while the attribute is set");

				instance.SetAttribute("Target", undefined);
				untilGone(
					() => components.getComponent<Pointer>(instance),
					"the component after the attribute was cleared",
				);
			});

			test("refuses to clear a required link attribute through the component", () => {
				const components = createComponentModule();

				const linked = handlerFolder("ClearWriteLinked");
				const target = folder("ClearWriteTarget");
				const instance = pointer("ClearWrite", target, linked);

				const component = expectDefined(components.getComponent<Pointer>(instance), "component");
				expectThrows(() => component.clearTarget(), "clearing a required link");
				expectEqual(component.attributes.Target, target, "attribute after the refused write");
			});

			test("fills a missing link attribute from its default and writes it back as a handle", () => {
				const components = createComponentModule();

				const instance = folder("DefaultedLink");
				CollectionService.AddTag(instance, "PointerDefault");

				const component = expectDefined(components.getComponent<PointerDefault>(instance), "component");
				expectEqual(component.attributes.Target, DEFAULT_LINK_TARGET, "attribute holds the default instance");

				const written = instance.GetAttribute("Target");
				expectTrue(typeIs(written, "InstanceHandle"), "the default was written as a handle");
				expectEqual((written as InstanceHandle).Get(), DEFAULT_LINK_TARGET, "the handle names the default");
			});

			test("builds a component whose optional link has a handle that has not resolved", () => {
				const components = createComponentModule();

				const linked = handlerFolder("OptionalPendingLinked");
				const spare = folder("OptionalPendingSpare");

				const instance = folder("OptionalPending");
				instance.SetAttribute("Target", new InstanceHandle(folder("OptionalPendingTarget")));
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				instance.SetAttribute("Spare", emptyHandle());
				CollectionService.AddTag(instance, "Pointer");

				// Optional, so an empty handle is not something to wait for.
				const component = expectDefined(components.getComponent<Pointer>(instance), "component");
				expectEqual(component.attributes.Spare, undefined, "optional attribute while its handle is empty");

				// A server cannot make a handle fill in the way streaming does on a client, so the
				// attribute is pointed at a handle that has: the link follows it the same way.
				instance.SetAttribute("Spare", new InstanceHandle(spare));
				eventually(
					() => component.attributes.Spare === spare,
					"the optional attribute once its handle names something",
				);
			});

			test("adds a linked component by hand once its links resolve", () => {
				const components = createComponentModule();

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
			});

			test("waits for a child that is parented in later, then for its component", () => {
				const components = createComponentModule();

				// Neither the child nor its component exists yet: the instance guard fails first,
				// and the link only becomes the outstanding criterion once the child is there.
				const instance = folder("LateChild");
				CollectionService.AddTag(instance, "Owner");
				expectEqual(components.getComponent<Owner>(instance), undefined, "owner with no child at all");

				const core = folderIn(instance, "Core");
				defer(() => core.Destroy());
				settle();
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"owner with a child that has no component",
				);

				CollectionService.AddTag(core, "Handler");
				const owner = untilFound(
					() => components.getComponent<Owner>(instance),
					"the owner once the child has one",
				);
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Handler>(core),
					"linked child component",
				);

				// And the child leaving takes it away again.
				core.Parent = undefined;
				untilGone(() => components.getComponent<Owner>(instance), "the owner after the child was removed");
			});

			test("waits for the component a child of the instance tree names", () => {
				const components = createComponentModule();

				const instance = folder("Owned");
				const core = folderIn(instance, "Core");

				CollectionService.AddTag(instance, "Owner");
				expectEqual(
					components.getComponent<Owner>(instance),
					undefined,
					"owner before the child has a component",
				);

				CollectionService.AddTag(core, "Handler");

				const owner = untilFound(
					() => components.getComponent<Owner>(instance),
					"the owner once the child has one",
				);
				expectEqual(
					owner.childComponents.Core,
					components.getComponent<Handler>(core),
					"linked child component",
				);
				expectEqual(owner.instance.Core, core, "the tree still holds the instance itself");
			});

			test("removes a component when the component its link names goes away", () => {
				const components = createComponentModule();

				const instance = folder("Orphaned");
				const core = folderIn(instance, "Core");

				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(instance, "Owner");
				expectDefined(components.getComponent<Owner>(instance), "owner while the link holds");

				CollectionService.RemoveTag(core, "Handler");
				untilGone(() => components.getComponent<Owner>(instance), "the owner after the link broke");
			});

			test("resolves an instance-valued attribute through its handle", () => {
				const components = createComponentModule();

				const target = folder("PointerTarget");
				const linked = folder("PointerLinked");
				CollectionService.AddTag(linked, "Handler");

				const instance = folder("Pointer1");
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				// The attribute is written as a handle and read as the instance it resolves to.
				expectEqual(component.attributes.Target, target, "attribute holds the instance");
				expectEqual(component.attributes.Spare, undefined, "optional attribute with no handle");
				expectEqual(
					component.attributeComponents.Linked,
					components.getComponent<Handler>(linked),
					"linked component",
				);
			});

			test("waits for the instance an attribute names to stream in", () => {
				const components = createComponentModule();

				const linked = folder("StreamedLinked");
				CollectionService.AddTag(linked, "Handler");

				const target = folder("StreamedTarget");

				const instance = folder("Pointer2");
				instance.SetAttribute("Target", emptyHandle());
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				expectEqual(
					components.getComponent<Pointer>(instance),
					undefined,
					"component while the handle is empty",
				);

				// On a server nothing streams in, so the handle is replaced by one that names the
				// instance: the attribute changing is what the link follows either way.
				instance.SetAttribute("Target", new InstanceHandle(target));

				const component = untilFound(
					() => components.getComponent<Pointer>(instance),
					"the component once the handle resolved",
				);
				expectEqual(component.attributes.Target, target, "attribute holds the instance");
			});

			test("reports the instance to onAttributeChanged when a link is re-pointed", () => {
				const components = createComponentModule();

				const target = folder("FirstTarget");
				const linked = folder("RepointLinked");
				CollectionService.AddTag(linked, "Handler");

				const instance = folder("Pointer3");
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				const changes = new Array<[Folder | undefined, Folder | undefined]>();
				component.onAttributeChanged("Target", (newValue, oldValue) => changes.push([newValue, oldValue]));

				const other = folder("SecondTarget");
				instance.SetAttribute("Target", new InstanceHandle(other));
				eventually(() => changes.size() > 0, "the change to arrive");

				expectEqual(component.attributes.Target, other, "attribute after the write");
				expectEqual(changes.size(), 1, "change count");
				expectEqual(changes[0][0], other, "new value is the instance");
				expectEqual(changes[0][1], target, "old value is the instance");
			});

			test("writes an instance-valued attribute back to the instance as a handle", () => {
				const components = createComponentModule();

				const linked = folder("WriteLinked");
				CollectionService.AddTag(linked, "Handler");

				const instance = folder("Pointer4");
				instance.SetAttribute("Target", new InstanceHandle(folder("WriteTarget")));
				instance.SetAttribute("Linked", new InstanceHandle(linked));
				CollectionService.AddTag(instance, "Pointer");

				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				const other = folder("WriteOther");
				component.retarget(other);

				// The write lands on the instance and on the component at once, rather than waiting
				// for the attribute signal.
				expectEqual(component.attributes.Target, other, "component sees its own write");

				const written = instance.GetAttribute("Target");
				expectTrue(typeIs(written, "InstanceHandle"), "attribute is stored as a handle");
				expectEqual((written as InstanceHandle).Get(), other, "the handle names the instance");

				component.setSpare(other);
				expectEqual(component.attributes.Spare, other, "optional link after a write");
			});

			test("refuses a link write whose instance is the wrong shape", () => {
				const components = createComponentModule();

				const linked = handlerFolder("ShapeLinked");
				const instance = pointer("ShapeWrite", folder("ShapeTarget"), linked);
				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				// `Rig` needs a `Root` child, and the guard on a link carries that structure, not
				// just the class. A folder without one can never be right, so this raises.
				const message = expectThrows(() => component.setRigged(folder("NoRoot")), "writing a rootless folder");
				expectTrue(message.find("did not pass the guard", 1, true)[0] !== undefined, "message names the guard");
				expectTrue(
					message.find("child 'Root' is missing (expected Folder)", 1, true)[0] !== undefined,
					"message says what is wrong",
				);
				expectEqual(instance.GetAttribute("Rigged"), undefined, "attribute after the refused write");
			});

			test("warns rather than raising when a link write names an instance without the component", () => {
				const components = createComponentModule();
				const warnings = recordWarnings();

				const linked = handlerFolder("AwaitLinked");
				const instance = pointer("AwaitWrite", folder("AwaitTarget"), linked);
				const component = expectDefined(components.getComponent<Pointer>(instance), "component");

				// The right shape, but nothing has given it the component yet. Writing it would
				// unqualify the component doing the writing, so the write is refused and said out
				// loud instead.
				const rigged = folder("RiggedLater");
				folderIn(rigged, "Root");

				warnings.clear();
				component.setRigged(rigged);
				settle();

				expectEqual(instance.GetAttribute("Rigged"), undefined, "attribute after the refused write");
				expectDefined(components.getComponent<Pointer>(instance), "the writing component is still alive");
				expectTrue(
					warnings.mentions("has no component"),
					`a warning said the component was missing: ${warnings.describe()}`,
				);
				expectTrue(warnings.mentions("waitForComponent"), "a warning said what to do about it");

				// Waiting for the component first is what makes the write land.
				CollectionService.AddTag(rigged, "Rig");
				expectResolves(components.waitForComponent<Rig>(rigged), "the component being waited for");

				component.setRigged(rigged);
				expectEqual(component.attributes.Rigged, rigged, "attribute once the component was there");
				expectEqual(
					component.attributeComponents.Rigged,
					components.getComponent<Rig>(rigged),
					"linked component after the write",
				);
			});

			test("raises when a component is added by hand before its links resolve", () => {
				const components = createComponentModule();

				const linked = folder("ManualLinked");
				CollectionService.AddTag(linked, "Handler");

				const instance = folder("ManualPointer");
				instance.SetAttribute("Target", emptyHandle());
				instance.SetAttribute("Linked", new InstanceHandle(linked));

				expectThrows(() => components.addComponent<Pointer>(instance), "addComponent with an empty handle");
			});

			test("refuses a link to a component the plugin does not register", () => {
				const plugin = ComponentPlugin.createPlugin().registerComponent(Owner).build();

				const message = expectThrows(
					() => Flamework.createModule().includePlugin(plugin).ignite(),
					"ignition with an unregistered link",
				);

				expectTrue(
					message.find("not registered in any ComponentPlugin of this module", 1, true)[0] !== undefined,
					"message explains the link",
				);
			});

			test("constructs a component when its tag is added", () => {
				events.clear();

				const components = createComponentModule();

				const instance = folder("Tagged1", { speed: 10 });
				CollectionService.AddTag(instance, "Tagged");

				const component = expectDefined(components.getComponent<Tagged>(instance), "component");
				expectEqual(component.attributes.speed, 10, "attribute value");
				expectEqual(component.instance, instance, "attached instance");
			});

			test("runs component lifecycle events", () => {
				events.clear();

				createComponentModule();
				const instance = folder("Started", { speed: 1 });
				CollectionService.AddTag(instance, "Tagged");

				eventually(() => events.includes("start:Started"), "onStart to fire for the component");
			});

			test("destroys the component when the tag is removed", () => {
				const components = createComponentModule();

				const instance = folder("Removed", { speed: 3 });
				CollectionService.AddTag(instance, "Tagged");
				expectDefined(components.getComponent<Tagged>(instance), "component before removal");

				CollectionService.RemoveTag(instance, "Tagged");
				untilGone(() => components.getComponent<Tagged>(instance), "the component after removal");
			});

			test("rejects an instance whose attributes fail their generated guard", () => {
				const components = createComponentModule();

				// `speed` is typed as `number`, so a string must not satisfy the generated guard.
				const instance = folder("BadAttributes", { speed: "fast" });

				expectThrows(
					() => components.addComponent<Tagged>(instance),
					"adding a component with an invalid attribute",
				);
			});

			test("substitutes a default instead of rejecting when one is configured", () => {
				const components = createComponentModule();

				const instance = folder("Defaulted1");
				const component = components.addComponent<Defaulted>(instance);

				expectEqual(component.attributes.speed, 7, "defaulted attribute");
				expectEqual(instance.GetAttribute("speed"), 7, "default written back to the instance");
			});

			test("honours optional attributes", () => {
				const components = createComponentModule();

				const instance = folder("NoLabel", { speed: 2 });
				const component = components.addComponent<Tagged>(instance);

				expectEqual(component.attributes.label, undefined, "absent optional attribute");
			});

			test("rejects an instance that fails the generated instance guard", () => {
				const components = createComponentModule();

				// PartOnly is declared as `BaseComponent<{}, Part>`, so a Folder must not satisfy it.
				expectThrows(
					() => components.addComponent<PartOnly>(folder("NotAPart")),
					"adding a Part component to a Folder",
				);
			});

			test("adds and removes components manually", () => {
				const components = createComponentModule();

				const instance = folder("ManualTarget");
				const component = components.addComponent<Manual>(instance);

				expectEqual(components.getComponent<Manual>(instance), component, "component after add");

				components.removeComponent<Manual>(instance);
				expectEqual(components.getComponent<Manual>(instance), undefined, "component after remove");
			});

			test("lists every component of a kind", () => {
				const components = createComponentModule();

				components.addComponent<Manual>(folder("List1"));
				components.addComponent<Manual>(folder("List2"));

				expectEqual(components.getAllComponents<Manual>().size(), 2, "components of this kind");
			});

			test("observes attribute changes", () => {
				const components = createComponentModule();

				const instance = folder("Observed", { speed: 1 });
				const component = components.addComponent<Tagged>(instance);

				instance.SetAttribute("speed", 42);
				eventually(() => component.attributes.speed === 42, "the attribute after an external change");
			});

			test("picks up instances that were already tagged before ignition", () => {
				const instance = folder("PreTagged", { speed: 5 });
				CollectionService.AddTag(instance, "Tagged");

				const components = createComponentModule();

				expectDefined(components.getComponent<Tagged>(instance), "component for a pre-existing tag");
			});

			test("waits for the instance tree when streaming is watched", () => {
				const components = createComponentModule();

				const instance = folder("Streamed");
				CollectionService.AddTag(instance, "Watched");
				expectEqual(components.getComponent<Watched>(instance), undefined, "component before the tree arrives");

				addCore(instance);
				settle();

				expectDefined(components.getComponent<Watched>(instance), "component once the tree is complete");
			});

			test("removes a watched component when its tree breaks apart", () => {
				const components = createComponentModule();

				const instance = folder("Unstreamed");
				CollectionService.AddTag(instance, "Watched");

				const core = addCore(instance);
				defer(() => core.Destroy());
				settle();
				expectDefined(components.getComponent<Watched>(instance), "component once the tree is complete");

				core.Parent = undefined;
				settle();

				expectEqual(components.getComponent<Watched>(instance), undefined, "component after the tree broke");
			});

			test("never re-runs the instance guard when streaming is disabled", () => {
				const components = createComponentModule();

				const instance = folder("NotStreamed");
				CollectionService.AddTag(instance, "Frozen");
				announced();

				addCore(instance);
				settle();

				expectEqual(
					components.getComponent<Frozen>(instance),
					undefined,
					"component once the tree is complete",
				);
			});

			test("watches the instance tree contextually on the client only", () => {
				const components = createComponentModule();

				// Contextual is the default: a server sees the whole tree at once, so only a client
				// has any reason to watch for the rest of it to stream in.
				const instance = folder("Contextual1");
				CollectionService.AddTag(instance, "Contextual");
				announced();

				addCore(instance);
				settle();

				const component = components.getComponent<Contextual>(instance);
				if (RunService.IsClient()) {
					expectDefined(component, "component on the client");
				} else {
					expectEqual(component, undefined, "component on the server");
				}
			});

			test("leaves an atomic model unwatched", () => {
				const components = createComponentModule();

				// An atomic model replicates in one piece, so contextual streaming skips the watch
				// even on a client -- if the guard failed, the tree is not going to fill in later.
				const model = new Instance("Model");
				model.Name = "AtomicModel";
				model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic;
				model.Parent = scratch();

				CollectionService.AddTag(model, "Atomic");
				announced();

				addCore(model);
				settle();

				expectEqual(components.getComponent<Atomic>(model), undefined, "component for an atomic model");
			});

			test("leaves an atomic model's child link unwatched", () => {
				const components = createComponentModule();

				const model = new Instance("Model");
				model.Name = "AtomicLinkModel";
				model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic;
				model.Parent = scratch();

				const core = addCore(model);
				CollectionService.AddTag(core, "Handler");
				CollectionService.AddTag(model, "AtomicOwner");
				const owner = expectDefined(components.getComponent<AtomicOwner>(model), "component");
				announced();

				// A child link is part of the tree, and the tree is read once on both realms: the server
				// never follows it, and on the client an atomic model streams in whole.
				core.Parent = folder("AtomicLinkElsewhere");
				settle();
				expectEqual(components.getComponent<AtomicOwner>(model), owner, "component after the child moved away");
			});

			test("keeps a watched component while a second child of the required name comes and goes", () => {
				const components = createComponentModule();

				const instance = folder("Doubled");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				const component = untilFound(() => components.getComponent<Watched>(instance), "component");

				// A second `Core` is not the one `this.instance.Core` reads, so it is none of the
				// tree's business: not arriving, not being there while something unrelated moves,
				// and not leaving. The `t.children` guard this replaced refused two children of one name.
				const spare = folderIn(instance, "Core");
				settle();
				expectEqual(
					components.getComponent<Watched>(instance),
					component,
					"component after a second Core arrived",
				);

				folderIn(instance, "Extra").Destroy();
				settle();
				expectEqual(
					components.getComponent<Watched>(instance),
					component,
					"component after an unrelated child came and went",
				);

				spare.Destroy();
				settle();
				expectEqual(
					components.getComponent<Watched>(instance),
					component,
					"component after the second Core left",
				);

				// The one it reads leaving is the tree breaking.
				core.Destroy();
				untilGone(() => components.getComponent<Watched>(instance), "component after the Core it read left");
			});

			test("reads the next child of the required name when the one it read leaves", () => {
				const components = createComponentModule();

				const instance = folder("Succession");
				const first = addCore(instance);
				const second = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				const component = untilFound(() => components.getComponent<Watched>(instance), "component");
				expectEqual(instance.FindFirstChild("Core"), first, "the Core the component reads");

				// The name resolves to the second one now, which is the same tree as far as the
				// guard is concerned: a plain child is read through the instance, not held.
				first.Destroy();
				settle();
				expectEqual(
					components.getComponent<Watched>(instance),
					component,
					"component after the first Core left",
				);
				expectEqual(instance.FindFirstChild("Core"), second, "the Core the component reads now");
			});

			test("builds a component when a child two levels down arrives, and drops it when that child leaves", () => {
				const components = createComponentModule();

				const instance = folder("DeepTree");
				const root = folderIn(instance, "Root");
				CollectionService.AddTag(instance, "Deep");
				settle();
				expectEqual(components.getComponent<Deep>(instance), undefined, "component while Root has no Texture");

				const texture = folderIn(root, "Texture");
				const built = untilFound(
					() => components.getComponent<Deep>(instance),
					"component once the Texture arrived",
				);

				// Something else under Root is not part of the tree.
				folderIn(root, "Decal").Destroy();
				settle();
				expectEqual(
					components.getComponent<Deep>(instance),
					built,
					"component after an unrelated grandchild came and went",
				);

				texture.Parent = undefined;
				untilGone(() => components.getComponent<Deep>(instance), "component after the Texture left");

				texture.Parent = root;
				untilFound(() => components.getComponent<Deep>(instance), "component once the Texture returned");
			});

			test("re-resolves a required child when it is renamed away, and when it is renamed back", () => {
				const components = createComponentModule();

				const instance = folder("Renamed");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				untilFound(() => components.getComponent<Watched>(instance), "component");
				announced();

				// Each rename is given the resumption its signal needs before the component is
				// asked for, as the Lune case flushed before asking; what asking in the same
				// resumption does is the next case's question.
				core.Name = "Shell";
				settle();
				untilGone(
					() => components.getComponent<Watched>(instance),
					"component after its Core was renamed away",
				);

				core.Name = "Core";
				settle();
				untilFound(() => components.getComponent<Watched>(instance), "component once the child is Core again");
			});

			test("keeps a watched component whose child is renamed away and back within one resumption", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				// The case above without the yields between: the child is renamed away and back, and
				// the component asked for, before the thread yields -- what a place does when it
				// repairs a tree in the same write that broke it. Where signals are immediate the
				// first rename takes the component down and the second builds it again. Where they
				// are deferred the two signals are delivered to a tree that has finished moving, so
				// nothing was ever unmet when the tracker looked; whatever the eager asks answered
				// in between, one component has to stand once the signals have been delivered.
				const instance = folder("RenamedWithin");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				const built = untilFound(() => components.getComponent<Watched>(instance), "component");
				announced();

				core.Name = "Shell";
				const askedAway = components.getComponent<Watched>(instance);
				const attachedAway = components.getComponents<Watched>(instance).size();
				core.Name = "Core";
				const askedBack = components.getComponent<Watched>(instance);
				const attachedBack = components.getComponents<Watched>(instance).size();
				settle();
				settle();

				const measured = `${deferred ? "deferred" : "immediate"}: asked away=${askedAway !== undefined ? (askedAway === built ? "same" : "other") : "none"} attached=${attachedAway}, asked back=${askedBack !== undefined ? (askedBack === built ? "same" : "other") : "none"} attached=${attachedBack}, settled attached=${components.getComponents<Watched>(instance).size()}`;
				expectEqual(
					components.getComponents<Watched>(instance).size(),
					1,
					`components once the signals were delivered (${measured})`,
				);
				expectDefined(
					components.getComponent<Watched>(instance),
					`component once the signals were delivered (${measured})`,
				);
			});

			test("keeps a watched component whose tree was broken, asked for and repaired before its tag was announced", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				// The previous case with the tag's announcement still queued through all of it: the
				// tag, the eager build, the rename that breaks the tree, an ask, and the rename back,
				// in one resumption. Where signals are immediate the announcement built the component
				// before any of it and the renames take it down and bring it back. Where they are
				// deferred the announcement lands last, on a tree that is whole again, after whatever
				// the ask in between did to the entry. Either way one component has to stand once
				// everything queued has been delivered.
				const instance = folder("RenamedBeforeAnnounced");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				const built = expectDefined(components.getComponent<Watched>(instance), "component asked for at once");

				core.Name = "Shell";
				const askedAway = components.getComponent<Watched>(instance);
				const attachedAway = components.getComponents<Watched>(instance).size();
				core.Name = "Core";
				const askedBack = components.getComponent<Watched>(instance);
				const attachedBack = components.getComponents<Watched>(instance).size();
				settle();
				settle();

				const measured = `${deferred ? "deferred" : "immediate"}: asked away=${askedAway !== undefined ? (askedAway === built ? "same" : "other") : "none"} attached=${attachedAway}, asked back=${askedBack !== undefined ? (askedBack === built ? "same" : "other") : "none"} attached=${attachedBack}, settled attached=${components.getComponents<Watched>(instance).size()}`;
				expectEqual(
					components.getComponents<Watched>(instance).size(),
					1,
					`components once the announcement and the renames were delivered (${measured})`,
				);
				expectDefined(
					components.getComponent<Watched>(instance),
					`component once the announcement and the renames were delivered (${measured})`,
				);
			});

			test("leaves names alone unless asked to, and still follows children arriving and leaving", () => {
				const components = createComponentModule();

				const instance = folder("Unrenamed");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Unrenamed");
				const built = untilFound(() => components.getComponent<Unrenamed>(instance), "component");
				// The eager build above may run ahead of the tag's announcement where signals are
				// deferred; the announcement reads the tree as it lands, so it has to land first.
				settle();

				// A rename is announced by nothing that is listened to, so the component stands on a
				// tree that no longer has a `Core`, until the child it read leaves for real.
				core.Name = "Shell";
				settle();
				expectEqual(
					components.getComponent<Unrenamed>(instance),
					built,
					"component after a rename nothing follows",
				);

				core.Parent = undefined;
				untilGone(() => components.getComponent<Unrenamed>(instance), "component after the child left");

				// A sibling renamed into the name is not heard either; a child of the name arriving is.
				// The sibling lands first: where signals are deferred, one parented and renamed in the
				// same resumption is announced as a child that arrived under the new name.
				const spare = folderIn(instance, "Spare");
				settle();
				spare.Name = "Core";
				settle();
				expectEqual(
					components.getComponent<Unrenamed>(instance),
					undefined,
					"component after a sibling took the name",
				);

				addCore(instance);
				untilFound(() => components.getComponent<Unrenamed>(instance), "component once a Core arrived");
			});

			test("rebuilds a watched component asked for every frame after its child is renamed back", () => {
				const components = createComponentModule();
				const deferred = signalsAreDeferred();

				// The rename-away case as a place polls it: tagged, renamed away, asked for, renamed
				// back and asked for each frame from then on, with no resumption given to any signal
				// first, so the eager path is asked while the announcement and both renames are still
				// queued and again on the frame they are delivered, as the tracker's own deferred
				// read of the tree runs. Where signals are deferred the announcement lands after the
				// rename away, so the watcher is born against a tree already short of `Core` and has
				// never resolved the child it is short of: the rename back can only be heard from
				// that child, as a candidate. However the asks fall, the component has to be there
				// within a few frames.
				const instance = folder("RenamedPolled");
				const core = addCore(instance);
				CollectionService.AddTag(instance, "Watched");
				untilFound(() => components.getComponent<Watched>(instance), "component");

				// Nothing yields between the tag and the renames: where signals are deferred the
				// announcement is still queued through both, and lands on the frame the polling starts.
				const attachedBefore = components.getComponents<Watched>(instance).size();
				core.Name = "Shell";
				untilGone(
					() => components.getComponent<Watched>(instance),
					"component after its Core was renamed away",
				);
				const attachedAway = components.getComponents<Watched>(instance).size();

				core.Name = "Core";
				const frames = new Array<string>();
				for (let frame = 0; frame < 6; frame++) {
					const asked = components.getComponent<Watched>(instance);
					frames.push(
						`${asked !== undefined ? "+" : "-"}${components.getComponents<Watched>(instance).size()}`,
					);
					task.wait();
				}

				const measured = `${deferred ? "deferred" : "immediate"}: attached before ${attachedBefore}, after the rename away and an ask ${attachedAway}, asked/attached per frame from the rename back ${frames.join(" ")}`;
				expectEqual(
					components.getComponents<Watched>(instance).size(),
					1,
					`components once the rename was delivered (${measured})`,
				);
				expectDefined(
					components.getComponent<Watched>(instance),
					`component once the rename was delivered (${measured})`,
				);
			});

			test("names the child a watched component is waiting for", () => {
				const components = createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("Explained");
				folderIn(instance, "Root");
				CollectionService.AddTag(instance, "DeepImpatient");
				task.wait(0.3);

				expectTrue(
					warnings.mentions("instance guard (child 'Root.Texture' is missing (expected Folder))"),
					`warnings: ${warnings.describe()}`,
				);
				expectEqual(components.getComponent<DeepImpatient>(instance), undefined, "component");
			});

			test("names what is wrong with the tree when a component is added by hand", () => {
				const components = createComponentModule();

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
			});

			test("keeps waiting for a child of the right class while one of the wrong class holds the name", () => {
				const components = createComponentModule();

				const instance = folder("WrongThenRight");
				const decoy = folderIn(instance, "Core");
				CollectionService.AddTag(instance, "Parted");
				settle();
				expectEqual(components.getComponent<Parted>(instance), undefined, "component while Core is a Folder");

				// A Part of the same name behind the Folder is not what the name resolves to.
				const part = partIn(instance, "Core");
				settle();
				expectEqual(
					components.getComponent<Parted>(instance),
					undefined,
					"component while the Folder still comes first",
				);

				decoy.Destroy();
				untilFound(
					() => components.getComponent<Parted>(instance),
					"component once the name resolves to the Part",
				);
				expectEqual(instance.FindFirstChild("Core"), part, "the Core it reads");
			});

			test("leaves the tree under a linked child to that child's component", () => {
				const components = createComponentModule();

				// `FrozenRig` reads its tree once. The owner watches its own tree, but the tree under
				// `Core` is not the owner's: what the child's component keeps, the owner keeps.
				const instance = folder("FrozenRigOwner1");
				const core = folderIn(instance, "Core");
				const root = folderIn(core, "Root");
				CollectionService.AddTag(core, "FrozenRig");
				CollectionService.AddTag(instance, "FrozenRigOwner");
				const owner = untilFound(() => components.getComponent<FrozenRigOwner>(instance), "owner");
				announced();

				root.Destroy();
				settle();
				expectDefined(components.getComponent<FrozenRig>(core), "the child's component after its tree broke");
				expectEqual(
					components.getComponent<FrozenRigOwner>(instance),
					owner,
					"the owner after the child's tree broke",
				);

				// The child itself is the owner's tree.
				core.Parent = undefined;
				untilGone(() => components.getComponent<FrozenRigOwner>(instance), "the owner after the child left");
			});

			test("follows the tree under a linked child through that child's component when it watches it", () => {
				const components = createComponentModule();

				const instance = folder("LateRigChildOwner1");
				const core = folderIn(instance, "Core");
				const root = folderIn(core, "Root");
				CollectionService.AddTag(core, "LateRig");
				CollectionService.AddTag(instance, "LateRigChildOwner");
				untilFound(() => components.getComponent<LateRigChildOwner>(instance), "owner");

				root.Parent = undefined;
				untilGone(() => components.getComponent<LateRig>(core), "the child's component after its tree broke");
				untilGone(
					() => components.getComponent<LateRigChildOwner>(instance),
					"the owner after the child's component went",
				);

				root.Parent = core;
				untilFound(() => components.getComponent<LateRig>(core), "the child's component once its tree is back");
				untilFound(
					() => components.getComponent<LateRigChildOwner>(instance),
					"the owner once the child's component is back",
				);
			});

			test("says what a linked component is waiting for, and why a plain link's target is the wrong shape", () => {
				createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("ExplainedOwner1");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(core, "Rig");

				const rooted = folder("RootedImpatient1");
				const target = folder("RootlessTarget");
				rooted.SetAttribute("Target", new InstanceHandle(target));

				CollectionService.AddTag(instance, "ExplainedOwner");
				CollectionService.AddTag(rooted, "RootedImpatient");
				task.wait(0.3);

				expectTrue(
					warnings.mentions(
						`child 'Core' with component '${Flamework.id<Rig>()}' (${core.GetFullName()} is waiting for: instance guard (child 'Root' is missing (expected Folder)))`,
					),
					`warnings: ${warnings.describe()}`,
				);
				expectTrue(
					warnings.mentions(
						`attribute 'Target' (${target.GetFullName()}: child 'Root' is missing (expected Folder))`,
					),
					`warnings: ${warnings.describe()}`,
				);
			});

			test("runs onInit before anything can see the component, and onStart after", () => {
				events.clear();
				const components = createComponentModule();

				const seen = new Array<boolean>();
				components.onComponentAdded<Initialised>((component) => seen.push(component.ready));

				const instance = folder("InitOrder");
				CollectionService.AddTag(instance, "Initialised");

				const component = untilFound(() => components.getComponent<Initialised>(instance), "component");
				expectTrue(component.ready, "the component had run onInit by the time getComponent handed it back");
				eventually(() => events.includes("start:InitOrder"), "onStart to fire");
				expectArrayEqual(
					events.filter((event) => event.find(":InitOrder", 1, true)[0] !== undefined),
					["init:InitOrder", "start:InitOrder"],
					"lifecycle order",
				);
				// The added announcement is a BindableEvent, delivered after the yield where signals
				// are deferred; `onStart` ran on its own thread inside the build, so nothing above
				// necessarily yielded.
				eventually(() => seen.size() > 0, "the added notification");
				expectArrayEqual(seen, [true], "what the added listener saw");
			});

			test("initialises a linked component before the component that links to it is built", () => {
				const components = createComponentModule();

				// The owner is tagged first, so its link is what builds the child's component.
				const instance = folder("InitOwner");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(instance, "InitialisedOwner");
				CollectionService.AddTag(core, "Initialised");

				const owner = untilFound(() => components.getComponent<InitialisedOwner>(instance), "owner");
				expectTrue(owner.sawReady, "the owner's onInit saw an initialised child");
				expectTrue(owner.childComponents.Core.ready, "the child in childComponents");
			});

			test("keeps a component whose onInit raised as invalid until it is removed", () => {
				initAttempts = 0;
				const components = createComponentModule();

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
			});

			test("hides a component whose onInit raised from links, and rebuilds it only when its tag comes back", () => {
				events.clear();
				initAttempts = 0;
				const components = createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("BrokenOwner1");
				const core = folderIn(instance, "Core");
				CollectionService.AddTag(instance, "BrokenOwner");
				CollectionService.AddTag(core, "BrokenInitTagged");
				eventually(() => initAttempts === 1, "the tag to build the component once");
				eventually(() => warnings.mentions("failed to initialise"), "the failure to be warned about");

				// No lifecycle events, no lookups, no link: the owner keeps waiting, and says why.
				settle();
				expectTrue(!events.includes("brokenstart:Core"), "no onStart for the invalid component");
				expectEqual(components.getComponent<BrokenInitTagged>(core), undefined, "the child's component");
				expectEqual(components.getComponent<BrokenOwner>(instance), undefined, "the owner");
				expectEqual(initAttempts, 1, "onInit attempts after asking again");

				// A fresh wait says why it waits: the warning belongs to a wait, and the owner had qualified
				// before the link was lost.
				CollectionService.RemoveTag(instance, "BrokenOwner");
				settle();
				CollectionService.AddTag(instance, "BrokenOwner");
				task.wait(0.3);
				expectTrue(warnings.mentions("carries an invalid"), `warnings: ${warnings.describe()}`);

				// The tag going and coming back is a reason: a fresh component, and a fresh onInit.
				CollectionService.RemoveTag(core, "BrokenInitTagged");
				settle();
				CollectionService.AddTag(core, "BrokenInitTagged");
				eventually(() => initAttempts === 2, "a fresh onInit once the tag came back");
			});

			test("waits out a component whose onInit raised two links away", () => {
				events.clear();
				initAttempts = 0;
				const components = createComponentModule();
				const warnings = recordWarnings();

				const outer = folder("BrokenChainOuter");
				const inner = folder("BrokenChainInner");
				const core = folderIn(inner, "Core");
				outer.SetAttribute("Inner", new InstanceHandle(inner));

				// Tags are announced at once here, so the chain is tagged from the bottom up: every
				// link reads met when the one above it is announced, and the build at the top reaches
				// the invalid component through two links rather than one. The one in between is
				// built quietly for nothing, and the owner above it waits the same way.
				warnings.clear();
				expectNoThrow(() => {
					CollectionService.AddTag(core, "BrokenInitTagged");
					CollectionService.AddTag(inner, "BrokenOwner");
					CollectionService.AddTag(outer, "BrokenOwnerPointer");
				}, "announcing a chain of tags that ends in an invalid component");
				eventually(() => initAttempts === 1, "the chain to build the invalid component once");
				task.wait(0.3);

				expectEqual(initAttempts, 1, "onInit attempts");
				expectFalse(events.includes("brokenstart:Core"), "onStart for the invalid component");
				expectEqual(components.getComponent<BrokenInitTagged>(core), undefined, "the child's component");
				expectEqual(components.getComponent<BrokenOwner>(inner), undefined, "the owner in between");
				expectEqual(components.getComponent<BrokenOwnerPointer>(outer), undefined, "the owner at the top");
				expectFalse(warnings.mentions("has no component"), `warnings: ${warnings.describe()}`);
			});

			test("waits out a component whose onInit raised when it is a constructor dependency", () => {
				initAttempts = 0;
				const components = createComponentModule();

				const instance = folder("BrokenDependent");
				const late = folder("BrokenDependentLate");

				// The dependency is invalid before the dependent's tag arrives: a dependency that
				// cannot be had, which the dependent waits for rather than builds on.
				CollectionService.AddTag(instance, "BrokenInitTagged");
				eventually(() => initAttempts === 1, "the tag to build the invalid component once");
				expectNoThrow(() => CollectionService.AddTag(instance, "BrokenCar"), "announcing the dependent's tag");
				settle();
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
				CollectionService.AddTag(late, "BrokenCar");
				settle();
				expectEqual(
					components.getComponent<BrokenCar>(late),
					undefined,
					"dependent before its dependency exists",
				);
				expectNoThrow(
					() => CollectionService.AddTag(late, "BrokenInitTagged"),
					"announcing the dependency's tag under a waiting dependent",
				);
				eventually(() => initAttempts === 2, "the second instance's onInit attempt");
				settle();
				expectEqual(
					components.getComponent<BrokenCar>(late),
					undefined,
					"the dependent whose dependency turned invalid as it was built",
				);
				expectEqual(initAttempts, 2, "onInit attempts after the second dependent asked");
			});

			test("builds a dependent once the invalid dependency it waits at is taken down by hand", () => {
				initAttempts = 0;
				Flaky.broken = true;
				defer(() => {
					Flaky.broken = false;
				});
				const module = buildModule();
				defer(() => {
					if (!module.isExtinguished()) module.extinguish();
				});
				const components = module.resolveDependency<Components>();

				const instance = folder("FlakyDependent");
				const stuck = folder("FlakyDependentStuck");
				CollectionService.AddTag(instance, "Flaky");
				CollectionService.AddTag(instance, "FlakyCar");
				eventually(() => initAttempts === 1, "the tag to build the invalid component once");
				settle();
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
				const car = untilFound(
					() => components.getComponent<FlakyCar>(instance),
					"the dependent once its dependency is valid",
				);
				expectEqual(car.flaky, flaky, "the dependency the dependent holds");

				// Taken down while whatever made it raise is still there, it is tried again -- that
				// is what being taken down is for -- and the dependent waits on.
				Flaky.broken = true;
				CollectionService.AddTag(stuck, "Flaky");
				CollectionService.AddTag(stuck, "FlakyCar");
				eventually(() => initAttempts === 3, "the second instance's onInit attempt");
				settle();
				components.removeComponent<Flaky>(stuck);
				eventually(() => initAttempts === 4, "the retry after the second was taken down");
				settle();
				expectEqual(
					components.getComponent<FlakyCar>(stuck),
					undefined,
					"the dependent while its dependency raises still",
				);

				// Left as they are when the module goes -- the dependency invalid, the dependent
				// waiting -- the invalid one is taken down like every other, and nothing is built
				// on the way out.
				const warnings = recordWarnings();
				module.extinguish();
				settle();
				expectFalse(warnings.mentions("Failed to remove"), `warnings: ${warnings.describe()}`);
				expectEqual(initAttempts, 4, "onInit attempts after the module went");
			});

			test("answers getComponent with nothing for a dependent whose dependency can no longer be built", () => {
				const components = createComponentModule();

				const instance = folder("StrictDependentGone");
				const elsewhere = folder("StrictDependentGoneElsewhere");
				const root = folderIn(instance, "Root");
				CollectionService.AddTag(instance, "Strict");
				CollectionService.AddTag(instance, "StrictCar");
				expectDefined(components.getComponent<Strict>(instance), "the dependency");
				expectDefined(components.getComponent<StrictCar>(instance), "the dependent");
				settle();

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
			});

			test("keeps a component whose onInit raised from hearing its link attributes change", () => {
				BrokenPointer.seen = 0;
				const components = createComponentModule();

				const first = folder("BrokenPointerFirst");
				const second = folder("BrokenPointerSecond");
				const instance = folder("BrokenPointer1");
				instance.SetAttribute("Target", new InstanceHandle(first));
				CollectionService.AddTag(instance, "BrokenPointer");
				settle();
				expectEqual(components.getComponent<BrokenPointer>(instance), undefined, "the invalid component");

				// A plain attribute reaches an invalid component through nothing, because the
				// subscriptions that would carry it were never set up. A link attribute arrives through
				// the tracker's link instead, and it too stops short of a component that keeps its
				// place and nothing else.
				instance.SetAttribute("Target", new InstanceHandle(second));
				settle();
				expectEqual(BrokenPointer.seen, 0, "attribute changes the invalid component heard");
			});

			test("starts a component built during ignition only once ignition has finished", () => {
				// Declared here rather than at the top of the file: `registerProviders("src/shared/Tests")`
				// takes every provider a module defines, and this one belongs to the case's module.
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

				events.clear();
				earlyInstance = folder("Early");

				const module = Flamework.createModule()
					.includePlugin(SPEC_PLUGIN)
					.registerClassProvider(EarlyAdder)
					.ignite();
				defer(() => module.extinguish());

				// Initialised at once, so the provider's onInit can rely on it; started once every
				// provider has, and once.
				eventually(() => events.includes("start:Early"), "the component to start");
				expectArrayEqual(
					events.filter(
						(event) =>
							event.find("Early", 1, true)[0] !== undefined ||
							event.find("adder:", 1, true)[0] !== undefined,
					),
					["init:Early", "adder:init-done", "adder:start", "start:Early"],
					"lifecycle order across ignition",
				);
			});

			test("keeps a component whose invalid attribute has a default to stand in", () => {
				const components = createComponentModule();

				const instance = folder("DefaultedBad", { speed: 3 });
				CollectionService.AddTag(instance, "Defaulted");
				const component = untilFound(() => components.getComponent<Defaulted>(instance), "component");

				instance.SetAttribute("speed", "nope");
				settle();
				expectEqual(
					components.getComponent<Defaulted>(instance),
					component,
					"component after a bad change with a default",
				);
				expectEqual(component.attributes.speed, 3, "the last good value");
			});

			test("names an invalid attribute in the warning", () => {
				createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("SpeedyBad", { speed: "fast" });
				CollectionService.AddTag(instance, "Speedy");
				task.wait(0.3);

				expectTrue(warnings.mentions(`invalid attribute 'speed' ("fast")`), `warnings: ${warnings.describe()}`);
			});

			test("warns again when a component loses a criterion and stays down", () => {
				const components = createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("LostAgain");
				const root = folderIn(instance, "Root");
				const texture = folderIn(root, "Texture");
				CollectionService.AddTag(instance, "DeepImpatient");
				untilFound(() => components.getComponent<DeepImpatient>(instance), "component");

				warnings.clear();
				texture.Destroy();
				untilGone(() => components.getComponent<DeepImpatient>(instance), "component after its tree broke");

				task.wait(0.3);
				expectTrue(warnings.mentions("child 'Root.Texture' is missing"), `warnings: ${warnings.describe()}`);
			});

			test("skips tagged instances under a blocked ancestor", () => {
				const components = createComponentModule();

				// `getComponent` constructs eagerly and deliberately ignores the ancestor lists,
				// which only gate CollectionService-driven construction, so these count what
				// actually exists instead.
				CollectionService.AddTag(storageFolder("InStorage"), "Blocked");
				settle();
				expectEqual(components.getAllComponents<Blocked>().size(), 0, "components under a blocked ancestor");

				CollectionService.AddTag(folder("InWorkspace"), "Blocked");
				eventually(
					() => components.getAllComponents<Blocked>().size() === 1,
					"one component under an allowed ancestor",
				);
			});

			test("restricts construction to an explicit ancestor allowlist", () => {
				const components = createComponentModule();

				CollectionService.AddTag(folder("OutsideAllowlist"), "Allowed");
				settle();
				expectEqual(components.getAllComponents<Allowed>().size(), 0, "components outside the allowlist");

				CollectionService.AddTag(storageFolder("InsideAllowlist"), "Allowed");
				eventually(
					() => components.getAllComponents<Allowed>().size() === 1,
					"one component inside the allowlist",
				);
			});

			test("resolves a component through an interface it implements", () => {
				const components = createComponentModule();

				const instance = folder("Enemy1");
				CollectionService.AddTag(instance, "Enemy");
				announced();

				const damageables = components.getComponents<Damageable>(instance);
				expectEqual(damageables.size(), 1, "components implementing the interface");
				expectEqual(components.getAllComponents<Damageable>().size(), 1, "components of this interface");

				damageables[0].takeDamage(5);
				expectEqual(expectDefined(components.getComponent<Enemy>(instance)).damage, 5, "damage after the call");
			});

			test("notifies listeners when a component is added and removed", () => {
				const components = createComponentModule();

				const added = new Array<string>();
				const removed = new Array<string>();
				components.onComponentAdded<Enemy>((_component, instance) => added.push(instance.Name));
				components.onComponentRemoved<Enemy>((_component, instance) => removed.push(instance.Name));

				const instance = folder("Observed1");
				CollectionService.AddTag(instance, "Enemy");
				eventually(() => added.size() > 0, "the added notification");
				expectArrayEqual(added, ["Observed1"], "added notifications");

				CollectionService.RemoveTag(instance, "Enemy");
				eventually(() => removed.size() > 0, "the removed notification");
				expectArrayEqual(removed, ["Observed1"], "removed notifications");
			});

			test("resolves waitForComponent once the component appears", () => {
				const components = createComponentModule();

				const instance = folder("Awaited");
				const pending = components.waitForComponent<Enemy>(instance);

				CollectionService.AddTag(instance, "Enemy");

				expectEqual(expectResolves(pending, "waitForComponent").instance, instance, "attached instance");
			});

			test("injects one component into another and waits for it", () => {
				const components = createComponentModule();

				// A component that takes another component as a constructor parameter gets it
				// injected, and its tracker will not qualify the instance until the dependency
				// exists.
				const ready = folder("ReadyCar");
				CollectionService.AddTag(ready, "Engine");
				CollectionService.AddTag(ready, "Car");

				const car = expectDefined(components.getComponent<Car>(ready), "car component");
				expectEqual(car.engine, components.getComponent<Engine>(ready), "injected component");

				// Tagging in the other order proves the tracker waits rather than failing to
				// resolve.
				const waiting = folder("WaitingCar");
				CollectionService.AddTag(waiting, "Car");
				settle();
				expectEqual(components.getAllComponents<Car>().size(), 1, "cars before the dependency exists");

				CollectionService.AddTag(waiting, "Engine");
				eventually(
					() => components.getAllComponents<Car>().size() === 2,
					"two cars once the dependency exists",
				);
			});

			test("lets a predicate reject an instance outright", () => {
				const components = createComponentModule();

				CollectionService.AddTag(folder("Rejected"), "Picky");
				settle();
				expectEqual(components.getAllComponents<Picky>().size(), 0, "components the predicate rejected");

				CollectionService.AddTag(folder("Chosen"), "Picky");
				eventually(
					() => components.getAllComponents<Picky>().size() === 1,
					"one component the predicate accepted",
				);
			});

			test("stops observing attributes when refreshAttributes is off", () => {
				const components = createComponentModule();

				const instance = folder("Unrefreshed", { speed: 1 });
				const component = components.addComponent<Static>(instance);

				instance.SetAttribute("speed", 9);
				settle();
				expectEqual(component.attributes.speed, 1, "attribute after an external change");
			});

			test("reports the previous value to an attribute listener", () => {
				const components = createComponentModule();

				const instance = folder("Listened", { speed: 1 });
				const component = components.addComponent<Tagged>(instance);

				const changes = new Array<string>();
				component.onAttributeChanged("speed", (newValue, oldValue) => changes.push(`${oldValue}->${newValue}`));

				instance.SetAttribute("speed", 4);
				eventually(() => changes.size() > 0, "the change to arrive");
				expectArrayEqual(changes, ["1->4"], "attribute changes");
			});

			test("names the instance guard in the warning when the reading at the flip is what holds a component down", () => {
				// Contextual streaming on a server reads the tree once: the child moving away is not
				// polled, so only the reading the flip to qualified is gated on sees that it is gone.
				if (!RunService.IsServer()) return;

				const components = createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("GatedExplained");
				const elsewhere = folder("GatedElsewhere");
				const core = addCore(instance);
				folderIn(core, "Root");
				CollectionService.AddTag(core, "Rig");
				CollectionService.AddTag(instance, "ExplainedOwner");
				expectDefined(components.getComponent<ExplainedOwner>(instance), "component");
				settle();

				// The removal is announced on a deferred signal, which is when the owner comes down.
				warnings.clear();
				components.removeComponent<Rig>(core);
				untilGone(
					() => components.getComponents<ExplainedOwner>(instance)[0],
					"the component after its linked component was removed",
				);
				expectEqual(
					components.getComponent<ExplainedOwner>(instance),
					undefined,
					"component asked for after its linked component was removed",
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
					warnings.mentions("instance guard (child 'Core' is missing"),
					`warnings: ${warnings.describe()}`,
				);
			});

			// Tracker entries: what a leak shows up in. The Lune suite also counts the connections
			// left on an instance (`__harness.connectionCount`), which the engine cannot show; the
			// entry counts below are the half a place can read.

			test("releases the entry of a component whose link names its own instance once the tag has gone", () => {
				const components = createComponentModule();

				const instance = folder("SelfTwinEntry");
				instance.SetAttribute("Partner", new InstanceHandle(instance));
				CollectionService.AddTag(instance, "Twin");
				announced();
				expectEqual(trackedCount(components, Twin), 1, "entries while tagged");

				// The link observer this entry registered is a listener of the entry itself, so the
				// tag leaving must not leave the entry holding itself open.
				CollectionService.RemoveTag(instance, "Twin");
				settle();
				expectEqual(components.getComponent<Twin>(instance), undefined, "component after the tag went");
				expectEqual(trackedCount(components, Twin), 0, "entries after the tag went");

				instance.Destroy();
				settle();
				expectEqual(trackedCount(components, Twin), 0, "entries after the instance was destroyed");
			});

			test("releases the entries of a link ring once both tags have gone", () => {
				const components = createComponentModule();

				const first = folder("RingTwinA");
				const second = folder("RingTwinB");
				CollectionService.AddTag(first, "Twin");
				CollectionService.AddTag(second, "Twin");
				const firstComponent = expectDefined(components.getComponent<Twin>(first), "first component");
				const secondComponent = expectDefined(components.getComponent<Twin>(second), "second component");

				first.SetAttribute("Partner", new InstanceHandle(second));
				second.SetAttribute("Partner", new InstanceHandle(first));
				settle();
				expectEqual(firstComponent.attributeComponents.Partner, secondComponent, "the link the first holds");
				expectEqual(secondComponent.attributeComponents.Partner, firstComponent, "the link the second holds");
				expectEqual(trackedCount(components, Twin), 2, "entries while tagged");

				// Each entry's link observer is a listener of the other: the tags leaving must not
				// leave the two holding each other open.
				CollectionService.RemoveTag(first, "Twin");
				CollectionService.RemoveTag(second, "Twin");
				settle();
				expectEqual(firstComponent.destroyCount, 1, "first destroyed");
				expectEqual(secondComponent.destroyCount, 1, "second destroyed");
				expectEqual(components.getComponent<Twin>(first), undefined, "first component after the tag went");
				expectEqual(components.getComponent<Twin>(second), undefined, "second component after the tag went");
				expectEqual(trackedCount(components, Twin), 0, "entries after the tags went");

				first.Destroy();
				second.Destroy();
				settle();
				expectEqual(trackedCount(components, Twin), 0, "entries after the instances were destroyed");
			});

			test("drops a child two slots followed once it leaves, and takes the component down with it", () => {
				const components = createComponentModule();

				const instance = folder("LeakPair");
				const elsewhere = folder("LeakPairElsewhere");
				const core = addCore(instance);
				const extra = folderIn(instance, "Extra");
				CollectionService.AddTag(instance, "LeakPair");
				expectDefined(components.getComponent<LeakPair>(instance), "component");
				announced();

				// `core` takes the name `Extra`: slot Core keeps following it for a rename back,
				// and slot Extra resolves to it once the old `Extra` is renamed away. One child,
				// two slots following it.
				core.Name = "Extra";
				settle();
				untilGone(() => components.getComponent<LeakPair>(instance), "the component after Core was renamed");

				extra.Name = "Zed";
				settle();
				expectEqual(components.getComponent<LeakPair>(instance), undefined, "component while Core is missing");

				// A fresh `Core` arrives: slot Core lets go of `core`, which slot Extra still reads.
				addCore(instance);
				settle();
				untilFound(() => components.getComponent<LeakPair>(instance), "the component rebuilt");

				// The child slot Extra reads leaves: the tree is short of `Extra` and the component
				// comes down. Whether anything goes on following the name of the child that left is
				// the Lune case's connection count; here the removal is what shows.
				core.Parent = elsewhere;
				settle();
				expectEqual(instance.FindFirstChild("Extra"), undefined, "the Extra child");
				untilGone(
					() => components.getComponent<LeakPair>(instance),
					"the component after the Extra child left",
				);
			});

			test("releases what a link set up when the linked component's instance guard raises out of the setup", () => {
				const components = createComponentModule();
				const errors = recordErrors();

				const instance = folder("ThrowyPointer");
				const target = folder("ThrowyTarget");
				const linked = folder("ThrowyLinked");
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));

				// `linked` has no `X`, so the linked component raises the moment the second link
				// asks about it -- partway through this entry's setup, with the first link already
				// watching its own target. The Lune harness let the raise out of `AddTag`; the
				// engine runs the tag's handler on its own thread and prints what it raised.
				CollectionService.AddTag(instance, "ThrowyPointer");
				settle();
				expectTrue(
					errors.mentions("attempt to index nil with 'Name'"),
					`the guard raised: ${errors.describe()}`,
				);
				expectEqual(
					components.getComponents<ThrowyPointer>(instance).size(),
					0,
					"components after the setup raised",
				);

				// The tag leaving releases everything the failed setup had registered: the entry
				// the link created on the linked component's tracker, and the subscriptions on
				// the owner that no watcher ever came back to hold.
				CollectionService.RemoveTag(instance, "ThrowyPointer");
				settle();
				expectEqual(trackedCount(components, ThrowyPointer), 0, "owner entries after the tag went");
				expectEqual(trackedCount(components, Throwy), 0, "linked entries after the tag went");

				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				settle();
				expectEqual(trackedCount(components, Throwy), 0, "linked entries after the instances were destroyed");
			});

			test("releases what a link set up when the linked component's predicate raises out of the setup", () => {
				const components = createComponentModule();
				const errors = recordErrors();

				const instance = folder("FussyPointer");
				const target = folder("FussyTarget");
				const linked = folder("FussyLinked");
				instance.SetAttribute("Target", new InstanceHandle(target));
				instance.SetAttribute("Linked", new InstanceHandle(linked));

				// As above, with the predicate raising in place of the guard.
				CollectionService.AddTag(instance, "FussyPointer");
				settle();
				expectTrue(
					errors.mentions("attempt to index nil with 'Name'"),
					`the predicate raised: ${errors.describe()}`,
				);
				expectEqual(
					components.getComponents<FussyPointer>(instance).size(),
					0,
					"components after the setup raised",
				);

				CollectionService.RemoveTag(instance, "FussyPointer");
				settle();
				expectEqual(trackedCount(components, FussyPointer), 0, "owner entries after the tag went");
				expectEqual(trackedCount(components, Fussy), 0, "linked entries after the tag went");

				instance.Destroy();
				target.Destroy();
				linked.Destroy();
				settle();
				expectEqual(trackedCount(components, Fussy), 0, "linked entries after the instances were destroyed");
			});
		});
	}
}
