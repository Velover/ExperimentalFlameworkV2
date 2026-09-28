import { OnStart, Provider, requireModules } from "@flamework-experimental/core";

// core's built-in macro, called as a game calls it: at a module's top level and from a provider.
export const requiredAtLoad = requireModules("src/glob");

@Provider()
export class RequiresOnStart implements OnStart {
	onStart() {
		requireModules("src/glob/target");
	}
}
