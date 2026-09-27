import { BaseComponent, Component } from "@flamework-experimental/components";
import { Flamework, Injectable, Provider } from "@flamework-experimental/core";

// Nothing below is exported but the ids and the factory: path registration finds the classes a
// module defines as it loads, as v1 registered every decorated class it required.

@Provider()
class DiscoveryHidden {}

@Component({ tag: "DiscoveryHidden" })
class DiscoveryHiddenComponent extends BaseComponent<{}, Folder> {}

@Injectable()
class DiscoveryInjectable {}

/** A class declared in a function is created by every call, and is never recorded against the module. */
export function makeDiscoveryLocal() {
	@Provider()
	class DiscoveryLocal {}

	return DiscoveryLocal;
}

/** One made as the module loads, and not exported: still not found. */
const madeAtLoad = makeDiscoveryLocal();

export const discoveryIds = {
	provider: Flamework.id<DiscoveryHidden>(),
	component: Flamework.id<DiscoveryHiddenComponent>(),
	injectable: Flamework.id<DiscoveryInjectable>(),
	madeAtLoad: tostring(madeAtLoad),
};
