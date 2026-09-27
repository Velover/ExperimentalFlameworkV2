import { BaseComponent, Component } from "@flamework-experimental/components";
import { Flamework, Injectable, Provider } from "@flamework-experimental/core";

// Nothing below is exported but the ids and the factory: path registration finds the classes a
// module defines as it loads, as v1 registered every decorated class it required.

@Provider()
class HiddenProvider {}

@Component({ tag: "HiddenComponent" })
class HiddenComponent extends BaseComponent<{}, Folder> {}

@Injectable()
class HiddenInjectable {}

/** A class declared in a function is created by every call, and is never recorded against the module. */
export function makeLocalProvider() {
	@Provider()
	class LocalProvider {}

	return LocalProvider;
}

/** One made as the module loads, and not exported: still not found. */
const madeAtLoad = makeLocalProvider();

export const hiddenIds = {
	provider: Flamework.id<HiddenProvider>(),
	component: Flamework.id<HiddenComponent>(),
	injectable: Flamework.id<HiddenInjectable>(),
	madeAtLoad: tostring(madeAtLoad),
};
