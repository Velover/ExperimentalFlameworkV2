import { OnStart, Provider } from "@flamework-experimental/core";
import { defineTests, expectDefined, expectEqual, expectTrue, test } from "@flamework-experimental/testing";
import { ReplicatedStorage, ServerScriptService, SoundService, Workspace } from "@rbxts/services";

/**
 * What only the original place holds. The Rojo project declares none of it: `Assets` and `Sounds`
 * are not in the project file, so a plain build has neither. These pass only when the build was
 * laid over a copy of the original (`flamework-test test place.rbxl --original original.rbxl`, or
 * `ORIGINAL_PLACE` in `.env`), which is the point of that step.
 *
 * The case names still speak of the game template this place was cut from, whose shared modules
 * waited for `Assets` and whose sound system looked those sounds up; the modules are gone, and what
 * the cases check -- that the patch brought the original's content in and replaced its stale code --
 * is unchanged.
 *
 * `scripts/fabricate-original.luau` makes the original this expects; a real game would save its
 * own from Studio.
 */
@Provider({ activeIn: ["testing"] })
export class AssetTests implements OnStart {
	onStart() {
		defineTests("assets", () => {
			test("the assets folder the shared modules wait for came from the original", () => {
				const assets = expectDefined(ReplicatedStorage.FindFirstChild("Assets"), "ReplicatedStorage.Assets");
				const model = expectDefined(assets.FindFirstChild("PreciousModel"), "a model only the original has");
				expectTrue(model.IsA("Model"), "it is a Model");
				expectDefined(model.FindFirstChild("Body"), "with its part inside");
			});

			test("every sound the sound system looks up is there, so it warned about none", () => {
				const sounds = expectDefined(SoundService.FindFirstChild("Sounds"), "SoundService.Sounds");
				for (const name of ["UIHoverOverButton", "UIClickButton", "UIToggleSwitch"]) {
					const sound = expectDefined(sounds.FindFirstChild(name), `the sound ${name}`);
					expectTrue(sound.IsA("Sound"), `${name} is a Sound`);
				}
			});

			test("what the original kept in Workspace survived the patch", () => {
				expectDefined(Workspace.FindFirstChild("OriginalOnlyAssets"), "Workspace.OriginalOnlyAssets");
			});

			test("the original's stale code was replaced by the build", () => {
				const tree = expectDefined(ServerScriptService.FindFirstChild("TS"), "the compiled server tree");
				expectEqual(tree.FindFirstChild("StaleFolderFromOriginal"), undefined, "no stale folder under it");
				expectDefined(tree.FindFirstChild("Tests"), "the build's Tests folder in its place");
			});
		});
	}
}
