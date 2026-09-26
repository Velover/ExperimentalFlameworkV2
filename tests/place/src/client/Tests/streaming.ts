import { Components } from "@flamework-experimental/components";
import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectDefined,
	expectEqual,
	expectTrue,
	getProject,
	test,
} from "@flamework-experimental/testing";
import { Players, Workspace } from "@rbxts/services";
import { FwTestStreamModelClientComponent } from "client/Features/Testing/Components/FwTestStreamModelClientComponent";
import {
	FW_TEST_FOLDER,
	FW_TEST_STREAM_MODEL,
	FW_TEST_STREAM_MODEL_POSITION,
} from "shared/Features/Testing/FwTestConfig";

/** Waits for a lookup to answer, and returns what it answered. */
function untilFound<T>(lookup: () => T | undefined, what: string, timeout?: number): T {
	let found: T | undefined;
	eventually(
		() => {
			found = lookup();
			return found !== undefined;
		},
		what,
		timeout,
	);

	return found!;
}

/** The local character's root, which is where the client's streaming area is centred. */
function characterRoot() {
	const player = Players.LocalPlayer;
	const character = player.Character ?? player.CharacterAdded.Wait()[0];
	return character.WaitForChild("HumanoidRootPart", 10) as BasePart;
}

/**
 * What only a streaming place can show: the server parks a tagged Model far outside the radius
 * (`FwTestService.spawnStreamModel`), and under the `streaming` project the client has neither the
 * model nor its component until the character goes there. The radii are set by the project file
 * and cannot be read back, so the case reads them off what arrives. Under the other projects
 * streaming is off and the same model replicated with everything else, which the case checks too.
 */
@Provider({ activeIn: ["testing"] })
export class StreamingTests implements OnStart {
	constructor(private readonly components: Components) {}

	onStart() {
		defineTests("streaming", () => {
			test("a far model and its contextual component arrive when the character goes near, and go when it leaves", () => {
				const folder = expectDefined(Workspace.WaitForChild(FW_TEST_FOLDER, 10), "the server's test folder");
				const findModel = () => folder.FindFirstChild(FW_TEST_STREAM_MODEL) as Model | undefined;
				const componentOf = (model: Model) =>
					this.components.getComponent<FwTestStreamModelClientComponent>(model);
				const created = FwTestStreamModelClientComponent.created;
				const destroyed = FwTestStreamModelClientComponent.destroyed;
				print(
					`[streaming] ${getProject() ?? "no project"}: StreamingEnabled=${Workspace.StreamingEnabled} model present=${findModel() !== undefined}`,
				);

				if (!Workspace.StreamingEnabled) {
					// Everything replicates: the model came with the rest, and its component is up.
					const model = untilFound(findModel, "the far model, replicated with streaming off");
					untilFound(() => componentOf(model), "its component, built where nothing streams");
					return;
				}

				// With streaming on, a model 8000 studs out is nowhere on the client, and neither is
				// a component for it: `Improved` model streaming sends not even the empty container.
				expectEqual(findModel(), undefined, "the far model while the character is at the spawn");
				expectEqual(
					FwTestStreamModelClientComponent.created - created,
					0,
					"components built before it streamed in",
				);

				// The character is what the client streams around. Anchored while it is away, so it
				// stands in the air instead of falling off the map before the floor arrives.
				const root = characterRoot();
				const home = root.CFrame;
				root.Anchored = true;
				defer(() => {
					root.CFrame = home;
					root.Anchored = false;
				});
				root.CFrame = new CFrame(FW_TEST_STREAM_MODEL_POSITION.add(new Vector3(8, 3, 0)));

				const model = untilFound(findModel, "the far model once the character is near it", 20);
				const built = untilFound(() => componentOf(model), "its component once the model streamed in", 10);
				expectTrue(built.instance.Core.IsA("BasePart"), "the Core the component was built with");
				expectEqual(FwTestStreamModelClientComponent.created - created, 1, "components built by the arrival");

				// Back at the spawn the model is outside the radius again. `StreamOutBehavior` is
				// `Opportunistic` under the project, so the engine takes it back rather than keeping
				// it until memory runs short, and the component goes with the instance.
				root.CFrame = home;
				eventually(() => findModel() === undefined, "the model to stream out once the character has left", 30);
				eventually(() => componentOf(model) === undefined, "its component to go with it", 5);
				expectEqual(FwTestStreamModelClientComponent.destroyed - destroyed, 1, "takedowns by the departure");
			});
		});
	}
}
