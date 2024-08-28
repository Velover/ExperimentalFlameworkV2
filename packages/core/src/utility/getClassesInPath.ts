import { Players, RunService, StarterPlayer } from "@rbxts/services";
import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";

export function getClassesInPath(path: string[]): Array<object> {
	assert(path);

	/** @hidden */
	let preloadPath: Instance = game.GetService(path.shift() as keyof Services);
	if (preloadPath === StarterPlayer) {
		assert(path.shift() === "StarterPlayerScripts");
		assert(RunService.IsClient());

		preloadPath = Players.LocalPlayer.WaitForChild("PlayerScripts");
	}

	for (let i = 0; i < path.size(); i++) {
		preloadPath = preloadPath.WaitForChild(path[i]);
	}

	const foundClasses = new Array<object>();
	const search = (moduleScript: ModuleScript) => {
		const start = os.clock();
		const [success, value] = pcall(() => tsImport(moduleScript));
		const endTime = math.floor((os.clock() - start) * 1000);
		if (!success) {
			warn(`${moduleScript.GetFullName()} failed to load (${endTime}ms): ${value}`);
		}

		if (typeIs(value, "table")) {
			// This is an `export =` on a Flamework class.
			if (Reflect.hasMetadata(value, "identifier")) {
				return foundClasses.push(value);
			}

			for (const [, member] of pairs(value)) {
				// This is an `export` on a Flamework class.
				if (Reflect.hasMetadata(member, "identifier")) {
					foundClasses.push(member);
				}
			}
		}
	};

	if (preloadPath.IsA("ModuleScript")) {
		search(preloadPath);
	}

	for (const instance of preloadPath.GetDescendants()) {
		if (instance.IsA("ModuleScript")) {
			search(instance);
		}
	}

	return foundClasses;
}
