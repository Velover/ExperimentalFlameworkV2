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
import { CollectionService, RunService, Workspace } from "@rbxts/services";
import { Events, Functions } from "client/Core/network";
import { FwTest } from "shared/Features/Testing/FwTest";
import {
	FW_TEST_FAR_COUNT,
	FW_TEST_FOLDER,
	FW_TEST_LINK_FAR,
	FW_TEST_STREAM_TAG,
	FwCrazyPayload,
	FwRichPayload,
	FwTestConfig,
} from "shared/Features/Testing/FwTestConfig";
import { FwTestPartClientComponent } from "../Components/FwTestPartClientComponent";
import { FwTestStreamLinkComponent } from "../Components/FwTestStreamLinkComponent";
import { FwTestStreamPartClientComponent } from "../Components/FwTestStreamPartClientComponent";
import { FwTestClientDependency } from "./FwTestClientDependency";
import { FwTestClientLazyProvider } from "./FwTestClientLazyProvider";

/** Built through the module without being registered, to exercise createClassInstance. */
@Injectable()
export class FwTestClientScratch {
	constructor(public readonly dependency: FwTestClientDependency) {}
}

/**
 * Client half of the Studio battletest. Runs once on start and prints `[FWTEST] client ...` lines.
 */
@Provider()
export class FwTestController implements OnInit, OnStart, OnTick, OnPhysics, OnRender {
	private initialized = false;
	private dependencyInitializedFirst = false;
	private ticks = 0;
	private physics = 0;
	private renders = 0;

	constructor(
		private readonly dependency: FwTestClientDependency,
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
		task.spawn(() => this.run());
	}

	/** Whether the engine renders frames at all: RenderStepped fires within two seconds. */
	private engineRenders() {
		let frames = 0;
		const connection = RunService.RenderStepped.Connect(() => frames++);
		const fired = FwTest.eventually(() => frames > 0, 2);
		connection.Disconnect();
		return fired;
	}

	private run() {
		FwTest.check("lifecycle: onInit ran before onStart", this.initialized);
		FwTest.check("lifecycle: dependency onInit ran before dependent onInit", this.dependencyInitializedFirst);
		FwTest.check(
			"di: Module is injectable and resolves providers",
			this.module.resolveDependency<FwTestClientDependency>() === this.dependency,
		);
		FwTest.check(
			"di: function provider runs per resolution",
			this.config.realm === "client" && this.module.resolveDependency<FwTestConfig>() !== this.config,
		);
		FwTest.check("di: lazy provider is not constructed until resolved", FwTestClientLazyProvider.constructed === 0);
		const lazy = this.module.resolveDependency<FwTestClientLazyProvider>();
		FwTest.check(
			"di: lazy provider constructed once and cached",
			FwTestClientLazyProvider.constructed === 1 &&
				this.module.resolveDependency<FwTestClientLazyProvider>() === lazy,
		);
		const scratch = this.module.createClassInstance(FwTestClientScratch);
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
		// PreRender only starts once Studio shows the client in the viewport, a few seconds after the
		// LocalScripts begin running, so this needs a longer window than the simulation events. No
		// frame renders at all while the display is off, which a plain RenderStepped connection tells
		// apart from an onRender that does not fire.
		const renderStart = os.clock();
		const rendered = FwTest.eventually(() => this.renders > 0, 15);
		if (!rendered && !this.engineRenders()) {
			FwTest.skip(
				"lifecycle: onRender fires on the client",
				"RenderStepped doesn't fire: the display may be asleep",
			);
		} else {
			FwTest.check(
				"lifecycle: onRender fires on the client",
				rendered,
				`renders=${this.renders} after ${string.format("%.1f", os.clock() - renderStart)}s`,
			);
		}
		FwTest.check(
			"lifecycle: module.listen receives onTick",
			FwTest.eventually(() => listened > 0, 2),
		);
		stop();
		const afterStop = listened;
		task.wait(0.2);
		FwTest.check("lifecycle: listen destructor disconnects", listened === afterStop);

		this.runNetworking();
		this.runComponents();
		this.runStreaming();
		this.runStreamedLink();
		FwTest.summary();
	}

	private runNetworking() {
		const nonce = math.random(1, 1000000);
		let pong: number | undefined;
		const connection = Events.FwTest.Pong.connect((value) => (pong = value));
		Events.FwTest.Ping.fire(nonce);
		FwTest.check(
			"networking: event round-trip with guards",
			FwTest.eventually(() => pong === nonce, 5),
			`pong=${pong}`,
		);
		connection.Disconnect();

		const [ok, result] = Functions.FwTest.Echo.invoke("hi").timeout(5).await();
		FwTest.check("networking: function round-trip", ok && result === "hi!", `result=${tostring(result)}`);

		const part = Workspace.WaitForChild("SpawnLocation", 5) ?? Workspace;
		const payload: FwRichPayload = {
			position: new Vector3(1, 2, 3),
			look: new CFrame(4, 5, 6),
			tint: new Color3(0.25, 0.5, 1),
			tags: ["a", "b"],
			scores: new Map([
				["alpha", 1],
				["beta", 2.5],
			]),
			nested: { depth: 1, label: "x" },
			mode: "walk",
			part,
		};
		const [richOk, richResult] = Functions.FwTest.RichEcho.invoke(payload).timeout(5).await();
		const rich = richOk ? (richResult as FwRichPayload) : undefined;
		FwTest.check(
			"networking: serialized rich payload round-trip",
			rich !== undefined &&
				rich.position === new Vector3(2, 3, 4) &&
				rich.look === payload.look &&
				rich.tint === payload.tint &&
				rich.tags.size() === 3 &&
				rich.tags[2] === "server" &&
				rich.scores.get("beta") === 2.5 &&
				rich.nested.depth === 2 &&
				rich.nested.label === "x!" &&
				rich.mode === "walk" &&
				rich.maybe === undefined &&
				rich.part === part,
			richOk
				? `position=${rich?.position} tags=${rich?.tags.size()} part=${rich?.part}`
				: `error=${tostring(richResult)}`,
		);

		// Raw members travel as plain values; the generated guards still run on arrival.
		let rawPong: number | undefined;
		const rawConnection = Events.FwTest.RawPong.connect((value) => (rawPong = value));
		Events.FwTest.RawPing.fire(nonce + 1);
		FwTest.check(
			"networking: raw event round-trip",
			FwTest.eventually(() => rawPong === nonce + 1, 5),
			`pong=${rawPong}`,
		);
		rawPong = undefined;
		Events.FwTest.RawPing.fire("nope" as never);
		task.wait(1);
		FwTest.check(
			"networking: raw event with a bad argument is dropped by the guard",
			rawPong === undefined,
			`pong=${rawPong}`,
		);
		rawConnection.Disconnect();
		const [rawOk, rawResult] = Functions.FwTest.RawEcho.invoke("hi").timeout(5).await();
		FwTest.check(
			"networking: raw function round-trip",
			rawOk && rawResult === "hi?",
			`result=${tostring(rawResult)}`,
		);

		// Nested collections, Instance keys, tuples, unions and blobs, all through the serializer and the guards.
		const crazy: FwCrazyPayload = {
			byPart: new Map<Instance, Array<Set<string>>>([
				[part, [new Set(["a", "b"]), new Set<string>()]],
				[Workspace, []],
			]),
			pairs: [
				[1 as Serialization.varint, "one"],
				[200 as Serialization.varint, undefined],
			],
			groups: new Set([new Map([["x", [1, 2]]]), new Map<string, number[]>()]),
			wallet: { Items: ["sword"] },
			sortOf: "text",
			tag: "abc-id",
			anything: { nested: true },
			deep: { a: { b: [{ c: new Vector3(7, 8, 9), d: part }, { c: Vector3.zero }] } },
			weird: new Map<Vector3 | Array<{ id: number }>, Set<CFrame | string>>([
				[new Vector3(1, 2, 3), new Set<CFrame | string>([new CFrame(1, 2, 3), "s"])],
				[[{ id: 9 }], new Set<CFrame | string>(["only"])],
			]),
			matrix: [[new Map<Serialization.u8, [Vector3, string]>([[3 as Serialization.u8, [Vector3.one, "x"]]])], []],
			enums: new Map<Enum.Material, Array<Enum.KeyCode | undefined>>([
				[Enum.Material.Plastic, [Enum.KeyCode.A, Enum.KeyCode.B]],
			]),
			variants: [part, new Vector3(1, 1, 1), { kind: "a", v: 1 }, { kind: "b", s: "s" }, [1, 2], "lit", 5],
			unknownInside: [new Map<string, unknown>([["k", { deep: 1 }]])],
			setOfTuples: new Set<[number, string]>([[1, "a"]]),
			bytes: buffer.fromstring("hello"),
			colors: [new Color3(1, 0, 0), new BrickColor(1004)],
			ro: new Map([["r", [new Set([1, 2])]]]),
		};
		const [crazyOk, crazyResult] = Functions.FwTest.CrazyEcho.invoke(crazy).timeout(5).await();
		const back = crazyOk ? (crazyResult as FwCrazyPayload) : undefined;
		const sets = back?.byPart.get(part);
		let filledGroup = false;
		let emptyGroup = false;
		if (back !== undefined) {
			for (const group of back.groups) {
				const x = group.get("x");
				if (group.size() === 0) emptyGroup = true;
				else if (x !== undefined && x.size() === 2 && x[0] === 1 && x[1] === 2) filledGroup = true;
			}
		}
		FwTest.check(
			"networking: nested collections with Instance keys round-trip through serializer and guards",
			back !== undefined &&
				back.byPart.size() === 2 &&
				sets !== undefined &&
				sets.size() === 2 &&
				sets[0].size() === 2 &&
				sets[0].has("a") &&
				sets[0].has("b") &&
				sets[1].size() === 0 &&
				back.byPart.get(Workspace)?.size() === 0 &&
				back.pairs.size() === 3 &&
				back.pairs[1][0] === 200 &&
				back.pairs[1][1] === undefined &&
				back.pairs[2][0] === 7 &&
				back.pairs[2][1] === "server" &&
				back.groups.size() === 2 &&
				filledGroup &&
				emptyGroup &&
				"Items" in back.wallet &&
				back.wallet.Items.size() === 2 &&
				back.wallet.Items[1] === "server" &&
				back.sortOf === "text!" &&
				back.tag === "abc-id" &&
				(back.anything as { nested: boolean }).nested === true &&
				back.deep.a.b.size() === 2 &&
				back.deep.a.b[0].c === new Vector3(7, 8, 9) &&
				back.deep.a.b[0].d === part &&
				back.deep.a.b[1].d === undefined,
			crazyOk
				? `parts=${back?.byPart.size()} pairs=${back?.pairs.size()} groups=${back?.groups.size()} sortOf=${back?.sortOf} deep=${back?.deep.a.b.size()}`
				: `error=${tostring(crazyResult)}`,
		);

		// The stranger shapes: keys that are datatypes or arrays, enums, a seven-way union, buffers.
		let weirdVectorOk = false;
		let weirdArrayKeyOk = false;
		let tupleOk = false;
		if (back !== undefined) {
			for (const [key, set] of back.weird) {
				if (typeIs(key, "Vector3")) {
					let sawFrame = false;
					for (const member of set) {
						if (typeIs(member, "CFrame") && member === new CFrame(1, 2, 3)) sawFrame = true;
					}
					weirdVectorOk = key === new Vector3(1, 2, 3) && set.size() === 2 && sawFrame && set.has("s");
				} else {
					weirdArrayKeyOk = key.size() === 1 && key[0].id === 9 && set.size() === 1 && set.has("only");
				}
			}
			for (const [n, s] of back.setOfTuples) tupleOk = n === 1 && s === "a";
		}
		const cell = back?.matrix[0]?.[0]?.get(3 as Serialization.u8);
		const keys = back?.enums.get(Enum.Material.Plastic);
		const v = back?.variants;
		const brick = back?.colors[1];
		FwTest.check(
			"networking: bizarre keys, enums, a seven-way union, buffers and readonly collections round-trip",
			back !== undefined &&
				back.weird.size() === 2 &&
				weirdVectorOk &&
				weirdArrayKeyOk &&
				back.matrix.size() === 2 &&
				back.matrix[1].size() === 0 &&
				cell !== undefined &&
				cell[0] === Vector3.one &&
				cell[1] === "x" &&
				keys !== undefined &&
				keys.size() === 2 &&
				keys[0] === Enum.KeyCode.A &&
				keys[1] === Enum.KeyCode.B &&
				v !== undefined &&
				v.size() === 7 &&
				v[0] === part &&
				v[1] === new Vector3(1, 1, 1) &&
				(v[2] as { kind: string; v: number }).kind === "a" &&
				(v[2] as { v: number }).v === 1 &&
				(v[3] as { s: string }).s === "s" &&
				(v[4] as number[])[1] === 2 &&
				v[5] === "lit" &&
				v[6] === 5 &&
				(back.unknownInside[0].get("k") as { deep: number }).deep === 1 &&
				tupleOk &&
				buffer.tostring(back.bytes) === "hello" &&
				back.colors[0] === new Color3(1, 0, 0) &&
				brick !== undefined &&
				typeIs(brick, "BrickColor") &&
				brick.Number === 1004 &&
				back.ro.get("r")?.[0].has(2) === true,
			crazyOk
				? `weird=${back?.weird.size()} variants=${v?.size()} bytes=${back !== undefined ? buffer.tostring(back.bytes) : "?"} enums=${keys?.size()}`
				: `error=${tostring(crazyResult)}`,
		);
	}

	private runComponents() {
		const folder = Workspace.WaitForChild(FW_TEST_FOLDER, 10);
		const near = folder?.WaitForChild("Near", 10) as BasePart | undefined;
		FwTest.check("components: server part replicated", near !== undefined);
		if (near === undefined) return;

		const [ok, value] = this.components.waitForComponent(near, FwTestPartClientComponent).timeout(5).await();
		const component = ok ? (value as FwTestPartClientComponent) : undefined;
		FwTest.check("components: replicated tagged part gets a client component", component !== undefined);
		if (component === undefined) return;

		FwTest.check("components: component receives DI", component.module === this.module);
		FwTest.check(
			"components: attribute replicated",
			typeIs(component.attributes.Speed, "number"),
			`Speed=${component.attributes.Speed}`,
		);
		FwTest.check(
			"components: onTick ticks on the client",
			FwTest.eventually(() => component.ticks > 0, 2),
		);
		const before = component.attributes.Speed;
		Events.FwTest.Bump.fire();
		FwTest.check(
			"components: server attribute change observed",
			FwTest.eventually(
				() => component.changes.some(([newValue, oldValue]) => newValue === before + 1 && oldValue === before),
				8,
			),
			`changes=${component.changes.size()} before=${before} now=${component.attributes.Speed}`,
		);
	}

	/**
	 * A link attribute naming an instance that has not replicated yet. Streaming is the only thing
	 * that produces an empty `InstanceHandle`, so this is the one place the waiting is real.
	 */
	private runStreamedLink() {
		const folder = Workspace.WaitForChild(FW_TEST_FOLDER, 10);
		const owner = folder?.WaitForChild("StreamLinkOwner", 10) as BasePart | undefined;
		FwTest.check("links: the part carrying the link replicated", owner !== undefined);
		if (owner === undefined || folder === undefined) return;

		const targetVisible = () => folder.FindFirstChild(FW_TEST_LINK_FAR) !== undefined;
		const handle = owner.GetAttribute("Target");
		FwTest.check("links: the attribute replicated as an InstanceHandle", typeIs(handle, "InstanceHandle"));

		// The streaming radii are not scriptable, so what the place is set to cannot be reported here.
		FwTest.info(
			"links: streaming state",
			`StreamingEnabled=${Workspace.StreamingEnabled} targetVisible=${targetVisible()}`,
		);

		if (Workspace.StreamingEnabled && !targetVisible()) {
			FwTest.check(
				"links: the component waits while the instance its attribute names is not streamed in",
				this.components.getComponent(owner, FwTestStreamLinkComponent) === undefined,
				`handle=${typeIs(handle, "InstanceHandle") ? tostring(handle.Get()) : "?"}`,
			);
		} else {
			FwTest.info("links: the named instance was already replicated", `visible=${targetVisible()}`);
		}

		Events.FwTest.StreamInLinkTarget.fire(true);
		const [ok, value] = this.components.waitForComponent(owner, FwTestStreamLinkComponent).timeout(20).await();
		const component = ok ? (value as FwTestStreamLinkComponent) : undefined;
		FwTest.check(
			"links: the component is built once that instance streams in",
			component !== undefined,
			`visible=${targetVisible()}`,
		);
		if (component === undefined) return;

		FwTest.check(
			"links: the attribute resolves to the instance that streamed in",
			component.attributes.Target.Name === FW_TEST_LINK_FAR,
			`target=${component.attributes.Target.Name}`,
		);

		// A handle that has resolved once stays resolved, so streaming the instance back out does
		// not take the component with it. Waiting for the instance to actually go is what makes this
		// a test of that rather than of how quickly Studio replicates -- and with streaming off
		// there is nothing to wait for, so the case does not arise at all.
		Events.FwTest.StreamInLinkTarget.fire(false);
		if (!Workspace.StreamingEnabled) {
			FwTest.info("links: nothing streams back out with streaming off", `visible=${targetVisible()}`);
			return;
		}

		const streamedOut = FwTest.eventually(() => !targetVisible(), 20);
		FwTest.check(
			"links: the component survives that instance streaming back out",
			streamedOut && this.components.getComponent(owner, FwTestStreamLinkComponent) === component,
			`streamedOut=${streamedOut} visible=${targetVisible()}`,
		);
	}

	private runStreaming() {
		task.wait(3); // give streaming a moment to settle
		const visible = CollectionService.GetTagged(FW_TEST_STREAM_TAG)
			.filter((i) => i.IsDescendantOf(Workspace))
			.size();
		const created = this.components.getAllComponents<FwTestStreamPartClientComponent>().size();
		const streaming = Workspace.StreamingEnabled;
		FwTest.info(
			"streaming: state",
			`StreamingEnabled=${streaming} visibleTagged=${visible} components=${created} total=${FW_TEST_FAR_COUNT + 1}`,
		);
		FwTest.check(
			"streaming: every visible tagged part has a component",
			created === visible,
			`components=${created} visible=${visible}`,
		);
		if (streaming) {
			FwTest.check("streaming(on): far parts have not streamed in", visible === 1, `visible=${visible}`);
		} else {
			FwTest.check(
				"streaming(off): every part replicated",
				visible === FW_TEST_FAR_COUNT + 1,
				`visible=${visible}`,
			);
		}
	}
}
