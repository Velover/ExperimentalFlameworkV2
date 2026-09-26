import { Components } from "@flamework-experimental/components";
import {
	Injectable,
	Module,
	OnInit,
	OnPhysics,
	OnRender,
	OnStart,
	OnTick,
	Provider,
	Serialization,
} from "@flamework-experimental/core";
import { CollectionService, Workspace } from "@rbxts/services";
import { Events, Functions } from "server/Core/network";
import { FwTest } from "shared/Features/Testing/FwTest";
import {
	FW_TEST_FAR_COUNT,
	FW_TEST_FOLDER,
	FW_TEST_LINK_FAR,
	FW_TEST_LINK_FAR_POSITION,
	FW_TEST_LINK_NEAR_POSITION,
	FW_TEST_LINK_TAG,
	FW_TEST_STREAM_LINK_TAG,
	FW_TEST_STREAM_MODEL,
	FW_TEST_STREAM_MODEL_POSITION,
	FW_TEST_STREAM_MODEL_TAG,
	FW_TEST_STREAM_TAG,
	FW_TEST_TAG,
	FwTestConfig,
} from "shared/Features/Testing/FwTestConfig";
import { FwTestLinkComponent } from "../Components/FwTestLinkComponent";
import { FwTestPartComponent } from "../Components/FwTestPartComponent";
import { FwTestDependency } from "./FwTestDependency";
import { FwTestLazyProvider } from "./FwTestLazyProvider";

/** Built through the module without being registered, to exercise createClassInstance. */
@Injectable()
export class FwTestScratch {
	constructor(public readonly dependency: FwTestDependency) {}
}

/**
 * Server half of the Studio battletest. Runs once on start and prints `[FWTEST] server ...` lines.
 */
@Provider()
export class FwTestService implements OnInit, OnStart, OnTick, OnPhysics, OnRender {
	private initialized = false;
	private dependencyInitializedFirst = false;
	private ticks = 0;
	private physics = 0;
	private renders = 0;

	constructor(
		private readonly dependency: FwTestDependency,
		private readonly module: Module,
		private readonly components: Components,
		private readonly config: FwTestConfig,
	) {}

	onInit() {
		this.initialized = true;
		this.dependencyInitializedFirst = this.dependency.initialized;
	}

	onTick() {
		this.ticks++;
	}

	onPhysics() {
		this.physics++;
	}

	onRender() {
		this.renders++;
	}

	onStart() {
		Events.FwTest.Ping.connect((player, nonce) => Events.FwTest.Pong.fire(player, nonce));
		Functions.FwTest.Echo.setCallback((_player, value) => `${value}!`);
		Functions.FwTest.RichEcho.setCallback((_player, payload) => ({
			...payload,
			position: payload.position.add(new Vector3(1, 1, 1)),
			nested: { depth: payload.nested.depth + 1, label: `${payload.nested.label}!` },
			tags: [...payload.tags, "server"],
		}));
		Functions.FwTest.CrazyEcho.setCallback((_player, payload) => ({
			...payload,
			pairs: [...payload.pairs, [7 as Serialization.varint, "server"]],
			sortOf: typeIs(payload.sortOf, "number") ? payload.sortOf + 1 : `${payload.sortOf}!`,
			wallet:
				"Coins" in payload.wallet
					? { Coins: payload.wallet.Coins + 1 }
					: { Items: [...payload.wallet.Items, "server"] },
		}));
		Events.FwTest.RawPing.connect((player, nonce) => Events.FwTest.RawPong.fire(player, nonce));
		Functions.FwTest.RawEcho.setCallback((_player, value) => `${value}?`);
		Events.FwTest.StreamInLinkTarget.connect((_player, near) => {
			const target = Workspace.FindFirstChild(FW_TEST_FOLDER)?.FindFirstChild(FW_TEST_LINK_FAR);
			if (target !== undefined && target.IsA("BasePart")) {
				target.Position = near ? FW_TEST_LINK_NEAR_POSITION : FW_TEST_LINK_FAR_POSITION;
			}
		});
		Events.FwTest.Bump.connect(() => {
			const near = Workspace.FindFirstChild(FW_TEST_FOLDER)?.FindFirstChild("Near");
			near?.SetAttribute("Speed", (near.GetAttribute("Speed") as number) + 1);
		});
		task.spawn(() => this.run());
	}

	private run() {
		FwTest.check("lifecycle: onInit ran before onStart", this.initialized);
		FwTest.check("lifecycle: dependency onInit ran before dependent onInit", this.dependencyInitializedFirst);
		FwTest.check(
			"di: Module is injectable and resolves providers",
			this.module.resolveDependency<FwTestDependency>() === this.dependency,
		);
		FwTest.check(
			"di: function provider runs per resolution",
			this.config.realm === "server" && this.module.resolveDependency<FwTestConfig>() !== this.config,
		);
		FwTest.check("di: lazy provider is not constructed until resolved", FwTestLazyProvider.constructed === 0);
		const lazy = this.module.resolveDependency<FwTestLazyProvider>();
		FwTest.check(
			"di: lazy provider constructed once and cached",
			FwTestLazyProvider.constructed === 1 && this.module.resolveDependency<FwTestLazyProvider>() === lazy,
		);
		const scratch = this.module.createClassInstance(FwTestScratch);
		FwTest.check("di: createClassInstance injects providers", scratch.dependency === this.dependency);
		this.module.removeClassInstance(scratch);

		let listened = 0;
		const stop = this.module.listen<OnTick>(() => listened++);
		FwTest.check(
			"lifecycle: onTick fires",
			FwTest.eventually(() => this.ticks > 0, 2),
			`ticks=${this.ticks}`,
		);
		FwTest.check(
			"lifecycle: onPhysics fires",
			FwTest.eventually(() => this.physics > 0, 2),
			`physics=${this.physics}`,
		);
		FwTest.check(
			"lifecycle: module.listen receives onTick",
			FwTest.eventually(() => listened > 0, 2),
		);
		stop();
		const afterStop = listened;
		task.wait(0.2);
		FwTest.check("lifecycle: listen destructor disconnects", listened === afterStop);
		FwTest.check("lifecycle: onRender is inert on the server", this.renders === 0, `renders=${this.renders}`);

		this.runComponents();
		this.runLinks();
		this.spawnStreamingParts();
		this.spawnStreamLink();
		FwTest.summary();
	}

	private runComponents() {
		const folder = new Instance("Folder");
		folder.Name = FW_TEST_FOLDER;
		folder.Parent = Workspace;

		const near = new Instance("Part");
		near.Name = "Near";
		near.Anchored = true;
		near.Position = new Vector3(0, 10, -20);
		near.Parent = folder;
		CollectionService.AddTag(near, FW_TEST_TAG);

		const [ok, value] = this.components.waitForComponent(near, FwTestPartComponent).timeout(3).await();
		const component = ok ? (value as FwTestPartComponent) : undefined;
		FwTest.check("components: tagged part gets a component", component !== undefined);
		if (component === undefined) return;

		FwTest.check(
			"components: default attribute applied",
			component.attributes.Speed === 1 && near.GetAttribute("Speed") === 1,
		);
		FwTest.check("components: component receives DI", component.module === this.module);
		FwTest.check(
			"components: onStart ran",
			FwTest.eventually(() => component.started, 2),
		);
		FwTest.check(
			"components: onTick ticks through the parent LifecyclePlugin",
			FwTest.eventually(() => component.ticks > 0, 2),
			`ticks=${component.ticks}`,
		);
		near.SetAttribute("Speed", 5);
		FwTest.check(
			"components: onAttributeChanged fires with new and old value",
			FwTest.eventually(() => component.changes.size() > 0, 2) &&
				component.changes[0][0] === 5 &&
				component.changes[0][1] === 1 &&
				component.attributes.Speed === 5,
		);
		FwTest.check(
			"components: getComponent and getAllComponents see it",
			this.components.getComponent(near, FwTestPartComponent) === component &&
				this.components.getAllComponents<FwTestPartComponent>().size() === 1,
		);

		component.setSpeed(11);
		FwTest.check(
			"components: writing an attribute reaches the instance",
			component.attributes.Speed === 11 && near.GetAttribute("Speed") === 11,
			`attribute=${component.attributes.Speed} instance=${near.GetAttribute("Speed")}`,
		);

		// The guard is the only thing standing between a cast and an attribute holding a value its
		// own type forbids -- on the instance as well as in the component.
		const [succeeded] = pcall(() => component.misassign("fast"));
		FwTest.check(
			"components: a write that fails the attribute guard is refused",
			!succeeded && component.attributes.Speed === 11 && near.GetAttribute("Speed") === 11,
			`refused=${!succeeded} attribute=${component.attributes.Speed} instance=${near.GetAttribute("Speed")}`,
		);
		// Set from outside rather than through the component: an attribute guard is a construction
		// check, so a bad value is filtered out and the component carries on with its last good one.
		near.SetAttribute("Speed", "nope" as never);
		FwTest.check(
			"components: an external attribute change that fails its guard is ignored",
			FwTest.eventually(() => near.GetAttribute("Speed") === "nope", 2) &&
				this.components.getComponent(near, FwTestPartComponent) === component &&
				component.attributes.Speed === 11,
			`instance=${near.GetAttribute("Speed")} attribute=${component.attributes.Speed}`,
		);

		near.SetAttribute("Speed", 5);

		const removable = near.Clone(); // keeps the tag
		removable.Name = "Removable";
		removable.Parent = folder;
		const [ok2] = this.components.waitForComponent(removable, FwTestPartComponent).timeout(3).await();
		FwTest.check("components: cloned tagged part gets its own component", ok2 && FwTestPartComponent.created === 2);
		CollectionService.RemoveTag(removable, FW_TEST_TAG);
		const gone = FwTest.eventually(
			() => this.components.getComponent(removable, FwTestPartComponent) === undefined,
			2,
		);
		FwTest.check(
			"components: removing the tag removes the component",
			gone,
			`hasTag=${CollectionService.HasTag(removable, FW_TEST_TAG)} all=${this.components.getAllComponents<FwTestPartComponent>().size()}`,
		);
		FwTest.check(
			"components: removed component had destroy() called",
			FwTestPartComponent.destroyed === 1,
			`destroyed=${FwTestPartComponent.destroyed} created=${FwTestPartComponent.created} log: ${FwTestPartComponent.log.join(" || ")}`,
		);
		removable.Destroy();
	}

	/**
	 * Links against the real engine. `InstanceHandle` is only stubbed in the Lune suites, so this is
	 * where its actual behaviour -- what `typeof` reports, an empty handle, a `Wait` that times out --
	 * is confirmed.
	 */
	private runLinks() {
		const folder = Workspace.WaitForChild(FW_TEST_FOLDER);

		const model = new Instance("Model");
		model.Name = "LinkModel";
		model.Parent = folder;

		const core = new Instance("Part");
		core.Name = "Core";
		core.Anchored = true;
		core.Position = new Vector3(0, 10, -40);
		core.Parent = model;

		const target = new Instance("Part");
		target.Name = "LinkTarget";
		target.Anchored = true;
		target.Position = new Vector3(4, 10, -40);
		target.Parent = folder;

		const linked = new Instance("Part");
		linked.Name = "LinkComponentTarget";
		linked.Anchored = true;
		linked.Position = new Vector3(8, 10, -40);
		linked.Parent = folder;
		CollectionService.AddTag(linked, FW_TEST_TAG);

		const handle = new InstanceHandle(target);
		FwTest.check("links: an instance attribute is an InstanceHandle", typeIs(handle, "InstanceHandle"));
		FwTest.check("links: a handle for a live instance resolves at once", handle.Get() === target);
		FwTest.check(
			"links: Wait returns nothing when it times out",
			new InstanceHandle(undefined).Wait(0.5) === undefined,
		);

		model.SetAttribute("Target", handle);
		model.SetAttribute("Linked", new InstanceHandle(linked));
		CollectionService.AddTag(model, FW_TEST_LINK_TAG);

		// Nothing is linked yet: `Core` carries no component, so neither link is met.
		FwTest.check(
			"links: the component waits for the component its links name",
			this.components.getComponent(model, FwTestLinkComponent) === undefined,
			`created=${FwTestLinkComponent.created}`,
		);

		CollectionService.AddTag(core, FW_TEST_TAG);

		const [ok, value] = this.components.waitForComponent(model, FwTestLinkComponent).timeout(3).await();
		const component = ok ? (value as FwTestLinkComponent) : undefined;
		FwTest.check("links: the component is built once its links resolve", component !== undefined);
		if (component === undefined) return;

		FwTest.check(
			"links: a child names the component attached to it",
			component.childComponents.Core === this.components.getComponent(core, FwTestPartComponent),
		);
		FwTest.check("links: the instance tree still holds the instance", component.instance.Core === core);
		FwTest.check(
			"links: an attribute resolves to the instance its handle names",
			component.attributes.Target === target,
		);
		FwTest.check(
			"links: an attribute names the component attached to it",
			component.attributeComponents.Linked === this.components.getComponent(linked, FwTestPartComponent),
		);
		FwTest.check("links: an absent optional link is left empty", component.attributes.Spare === undefined);

		const other = new Instance("Part");
		other.Name = "LinkTargetTwo";
		other.Anchored = true;
		other.Position = new Vector3(8, 10, -40);
		other.Parent = folder;

		component.retarget(other);
		const written = model.GetAttribute("Target");
		FwTest.check(
			"links: writing an attribute stores a handle for the new instance",
			typeIs(written, "InstanceHandle") && written.Get() === other && component.attributes.Target === other,
			`written=${typeOf(written)}`,
		);

		// Swapping the linked child out for another instance of the same name: the tree changed, so
		// the component goes with it and is built again around whatever took its place.
		core.Parent = undefined;

		const replacement = new Instance("Part");
		replacement.Name = "Core";
		replacement.Anchored = true;
		replacement.Position = new Vector3(0, 10, -40);
		replacement.Parent = model;
		CollectionService.AddTag(replacement, FW_TEST_TAG);

		// The old component is still there until the deferred signals run, so waiting on
		// `waitForComponent` would hand it straight back; the rebuild is what to wait for.
		const rebuilt = FwTest.eventually(() => FwTestLinkComponent.created === 2, 5);
		const swapped = this.components.getComponent(model, FwTestLinkComponent);
		FwTest.check(
			"links: replacing the linked child rebuilds the component around the new one",
			rebuilt &&
				swapped !== undefined &&
				swapped.childComponents.Core === this.components.getComponent(replacement, FwTestPartComponent),
			`created=${FwTestLinkComponent.created} destroyed=${FwTestLinkComponent.destroyed}`,
		);

		CollectionService.RemoveTag(replacement, FW_TEST_TAG);
		FwTest.check(
			"links: losing a linked component removes the component that names it",
			FwTest.eventually(() => this.components.getComponent(model, FwTestLinkComponent) === undefined, 2),
			`destroyed=${FwTestLinkComponent.destroyed}`,
		);
	}

	/**
	 * The pair the client's streaming link test needs: a part parked outside the streaming radius,
	 * and one inside it whose attribute names it.
	 */
	private spawnStreamLink() {
		const folder = Workspace.WaitForChild(FW_TEST_FOLDER);

		const target = new Instance("Part");
		target.Name = FW_TEST_LINK_FAR;
		target.Anchored = true;
		target.Position = FW_TEST_LINK_FAR_POSITION;
		target.Parent = folder;

		const owner = new Instance("Part");
		owner.Name = "StreamLinkOwner";
		owner.Anchored = true;
		owner.Position = FW_TEST_LINK_NEAR_POSITION;
		// Set before the tag, so the attribute is already there when the client sees the instance.
		owner.SetAttribute("Target", new InstanceHandle(target));
		owner.Parent = folder;
		CollectionService.AddTag(owner, FW_TEST_STREAM_LINK_TAG);

		FwTest.info(
			"links: streamed link pair spawned",
			`target=${FW_TEST_LINK_FAR_POSITION} owner=${FW_TEST_LINK_NEAR_POSITION}`,
		);
	}

	private spawnStreamingParts() {
		const folder = Workspace.WaitForChild(FW_TEST_FOLDER);
		const make = (name: string, position: Vector3) => {
			const part = new Instance("Part");
			part.Name = name;
			part.Anchored = true;
			part.Position = position;
			part.Parent = folder;
			CollectionService.AddTag(part, FW_TEST_STREAM_TAG);
		};
		make("StreamNear", new Vector3(10, 10, -20));
		for (let i = 0; i < FW_TEST_FAR_COUNT; i++) {
			make(`StreamFar${i}`, new Vector3(6000 + i * 10, 10, 6000));
		}
		this.spawnStreamModel(folder);
		FwTest.info(
			"streaming: parts spawned",
			`near=1 far=${FW_TEST_FAR_COUNT} model=${FW_TEST_STREAM_MODEL} StreamingEnabled=${Workspace.StreamingEnabled}`,
		);
	}

	/**
	 * The far model the client's `streaming` section goes to: a `Core` part, which the client
	 * component's tree asks for, and a floor under it so a character sent there has something to
	 * stand on once the model has streamed in. Tagged before it is parented, the way a place's own
	 * models arrive, so the tag is on it the moment a client sees it.
	 */
	private spawnStreamModel(folder: Instance) {
		const model = new Instance("Model");
		model.Name = FW_TEST_STREAM_MODEL;

		const floor = new Instance("Part");
		floor.Name = "Floor";
		floor.Anchored = true;
		floor.Size = new Vector3(64, 1, 64);
		floor.Position = FW_TEST_STREAM_MODEL_POSITION.sub(new Vector3(0, 10, 0));
		floor.Parent = model;

		const core = new Instance("Part");
		core.Name = "Core";
		core.Anchored = true;
		core.Size = new Vector3(4, 4, 4);
		core.Position = FW_TEST_STREAM_MODEL_POSITION;
		core.Parent = model;

		model.PrimaryPart = core;
		CollectionService.AddTag(model, FW_TEST_STREAM_MODEL_TAG);
		model.Parent = folder;
	}
}
