import { Players, RunService, StarterPlayer } from "@rbxts/services";
import { tsImport } from "./tsImport";
import { Reflect } from "../reflect";

/**
 * Requires every ModuleScript at and under the specified Rojo path and returns every exported value
 * that carries its own Flamework identifier.
 *
 * A module that fails to load raises, as it did in v1: a class that silently fails to register would
 * otherwise only show up later as an unresolvable dependency, far from the cause.
 */
export function getClassesInPath(rbxPath: readonly string[]): Array<object> {
	assert(rbxPath);

	// Copied so that the generated path literal is not consumed by this call.
	const path = [...rbxPath];

	/** @hidden */
	let preloadPath: Instance = game.GetService(path.shift() as keyof Services);
	if (preloadPath === StarterPlayer) {
		assert(path.shift() === "StarterPlayerScripts", "StarterPlayer only supports StarterPlayerScripts");
		assert(RunService.IsClient(), "The server cannot load StarterPlayer content");

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
			error(`${moduleScript.GetFullName()} failed to load (${endTime}ms): ${value}`, 0);
		}

		if (typeIs(value, "table")) {
			// This is an `export =` on a Flamework class.
			if (Reflect.hasOwnMetadata(value, "identifier")) {
				return foundClasses.push(value);
			}

			for (const [, member] of pairs(value)) {
				// This is an `export` on a Flamework class.
				//
				// Own metadata only: an undecorated subclass inherits its parent's identifier, and
				// must not be mistaken for a registered class of its own.
				if (typeIs(member, "table") && Reflect.hasOwnMetadata(member, "identifier")) {
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
