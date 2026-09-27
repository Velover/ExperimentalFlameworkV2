import { Provider } from "@flamework-experimental/core";

// Which classes the transformer records against the module that defines them (`flamework:module`):
// those the module creates once, as it loads.

@Provider()
class FixtureHiddenProvider {}

@Provider()
export class FixtureExportedProvider {}

namespace FixtureSpace {
	@Provider()
	export class FixtureNamespacedProvider {}
}

/** Created by every call: never recorded. */
export function fixtureFactory() {
	@Provider()
	class FixtureLocalProvider {}

	return FixtureLocalProvider;
}

/** Undecorated: no metadata at all. */
class FixtureUndecorated {}

export const discoveryUse = [FixtureHiddenProvider, FixtureSpace.FixtureNamespacedProvider, FixtureUndecorated];
