import { BaseComponent, Component } from "@flamework-experimental/components";
import { Flamework, Provider } from "@flamework-experimental/core";

/** Below a folder of the path: path registration requires every module under it. */
@Provider()
class DiscoveryDeep {}

@Component({ tag: "DiscoveryDeep" })
class DiscoveryDeepComponent extends BaseComponent<{}, Folder> {}

export const deepIds = {
	provider: Flamework.id<DiscoveryDeep>(),
	component: Flamework.id<DiscoveryDeepComponent>(),
};
