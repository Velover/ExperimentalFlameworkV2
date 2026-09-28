import { Components } from "@flamework-experimental/components";
import {
	Flamework,
	Module,
	OnInit,
	OnRender,
	OnStart,
	OnTick,
	Provider,
	requireModules,
} from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Events, Functions } from "client/Core/network";

/**
 * The half of the suite that needs a client: a real round trip over real remotes, and `onRender`,
 * which only ever fires on a client with a viewport. An Open Cloud task has no client, so these run
 * in Studio -- `Testing.runOnServer` reaches the server's sections from here, and the client's own
 * `Workspace.FlameworkTests` runs these.
 */
@Provider({ activeIn: ["testing"] })
export class ClientTests implements OnStart, OnRender, OnTick {
	private renders = 0;
	private ticks = 0;

	constructor(
		private readonly module: Module,
		private readonly components: Components,
	) {}

	onRender() {
		this.renders++;
	}

	onTick() {
		this.ticks++;
	}

	onStart() {
		defineTests("client", ({ module }) => {
			test("the client module ignited and is the one this section belongs to", () => {
				expectEqual(module, this.module, "the igniting module");
				expectTrue(RunService.IsClient(), "running on the client");
				expectDefined(Players.LocalPlayer, "a local player exists");
			});

			// The server's folders never replicate: the client is told so at once, not after a wait
			// for a child that cannot arrive.
			test("requireModules on a server folder says it is the server's, at once", () => {
				const started = os.clock();
				const message = expectThrows(() => requireModules("src/server/Required"), "a server folder");
				expectTrue(
					message.find(
						`requireModules("src/server/Required"): the folder is in ServerScriptService, which does not replicate to clients`,
						1,
						true,
					)[0] !== undefined,
					message,
				);
				expectTrue(os.clock() - started < 1, "without waiting for the folder");
			});

			test("onRender fires on the client, where the server sees nothing", () => {
				const before = this.renders;
				eventually(() => this.renders > before, "onRender to fire");
			});

			test("onTick fires on the client too", () => {
				const before = this.ticks;
				eventually(() => this.ticks > before, "onTick to fire");
			});

			test("a function request crosses to the server and comes back", () => {
				// The server answers `${value}!`, so the reply proves both directions ran.
				expectEqual(Functions.FwTest.Echo("hello").expect(), "hello!", "the echoed value");
				expectEqual(Functions.FwTest.RawEcho("plain").expect(), "plain?", "a raw function");
			});

			test("a rich payload survives the generated guards and serialization both ways", () => {
				// A replicated instance, not one this client just made: a client-side Instance has
				// no counterpart on the server, so it arrives as nothing and fails the guard there.
				const part = Workspace;

				const back = Functions.FwTest.RichEcho({
					position: new Vector3(1, 2, 3),
					look: new CFrame(),
					tint: Color3.fromRGB(1, 2, 3),
					tags: ["client"],
					scores: new Map([["alice", 1]]),
					nested: { depth: 1, label: "deep" },
					mode: "walk",
					part,
				}).expect();

				expectTrue(
					back.position === new Vector3(2, 3, 4),
					`the server added one to each axis, got ${tostring(back.position)}`,
				);
				expectEqual(back.nested.depth, 2, "a nested number");
				expectEqual(back.nested.label, "deep!", "a nested string");
				expectArrayEqual(back.tags, ["client", "server"], "the tag list the server appended to");
				expectEqual(back.scores.get("alice"), 1, "a map entry");
				expectEqual(back.mode, "walk", "a union member");
				expectEqual(back.part, part, "the Instance came back as itself");
			});

			test("an event round trip reaches the server and the reply reaches back", () => {
				const nonce = math.random(1, 1_000_000);
				let got: number | undefined;
				const connection = Events.FwTest.Pong.connect((value) => (got = value));
				defer(() => connection.Disconnect());

				Events.FwTest.Ping.fire(nonce);
				eventually(() => got === nonce, "the server's Pong with our nonce");
			});

			test("a raw event travels as a plain value and still passes its guard", () => {
				const nonce = math.random(1, 1_000_000);
				let got: number | undefined;
				const connection = Events.FwTest.RawPong.connect((value) => (got = value));
				defer(() => connection.Disconnect());

				Events.FwTest.RawPing.fire(nonce);
				eventually(() => got === nonce, "the raw reply");
			});

			test("the remote tree replicated to the client", () => {
				let count = 0;
				for (const descendant of ReplicatedStorage.GetDescendants()) {
					if (descendant.IsA("RemoteEvent") || descendant.IsA("RemoteFunction")) {
						count++;
					}
				}
				expectTrue(count > 0, `remotes replicated, found ${count}`);
			});

			test("orders onInit and onStart by loadOrder on the client too", () => {
				const log = new Array<string>();

				@Provider({ loadOrder: 5 })
				class ClientLate implements OnInit, OnStart {
					public onInit() {
						log.push("init:late");
					}
					public onStart() {
						log.push("start:late");
					}
				}

				@Provider({ loadOrder: 0 })
				class ClientEarly implements OnInit, OnStart {
					public onInit() {
						log.push("init:early");
					}
					public onStart() {
						log.push("start:early");
					}
				}

				const orderModule = Flamework.createModule()
					.registerClassProvider(ClientLate)
					.registerClassProvider(ClientEarly)
					.ignite();
				defer(() => orderModule.extinguish());

				expectArrayEqual(log, ["init:early", "init:late", "start:early", "start:late"], "lifecycle order");
			});

			test("the client's own registry is separate from the server's", () => {
				expectDefined(this.components, "the client's component registry");
				expectTrue(
					Flamework.isScopeActive("testing"),
					"the client was built with the same scope as the server",
				);
			});
		});
	}
}
