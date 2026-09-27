import { Provider } from "@flamework-experimental/core";

// A namespace's body runs once, as the module loads, so a class declared in it is recorded too.
namespace Inner {
	@Provider()
	export class DiscoveryNamespaced {}
}

export const namespacedName = tostring(Inner.DiscoveryNamespaced);
