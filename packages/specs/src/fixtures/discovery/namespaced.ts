import { Provider } from "@flamework-experimental/core";

// A namespace's body runs once, as the module loads, so a class declared in it is recorded too.
namespace Inner {
	@Provider()
	export class NamespacedProvider {}
}

export const namespacedName = tostring(Inner.NamespacedProvider);
