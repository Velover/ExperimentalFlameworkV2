import { Flamework, Provider } from "@flamework/core";
import { expectEqual, expectThrows, expectTrue, suite } from "../testkit";

@Provider()
class SharedState {
	public instances = 0;

	constructor() {
		SharedState.constructed += 1;
		this.instances = SharedState.constructed;
	}

	public static constructed = 0;
}

@Provider()
class Exported {
	public tag = "exported";
}

@Provider()
class Private {
	public tag = "private";
}

export = suite("modules", [
	[
		// Regression: setupIncludedModules cached the new instantiation under the *parent's* state
		// instead of the included module's, so the cache never hit and every includer built its own
		// copy -- contradicting "included modules are shared across all modules under the root".
		"shares an included module between two includers",
		() => {
			SharedState.constructed = 0;

			const shared = Flamework.createModule()
				.registerClassProvider(SharedState)
				.exportProviders<SharedState>()
				.build();

			const left = Flamework.createModule().includeModule(shared).exportProviders<SharedState>().build();
			const right = Flamework.createModule().includeModule(shared).exportProviders<SharedState>().build();

			const root = Flamework.createModule().includeModule(left).includeModule(right).ignite();

			expectEqual(SharedState.constructed, 1, "number of SharedState instances");

			const fromLeft = root.resolveDependency<SharedState>();
			expectEqual(fromLeft.instances, 1, "instance index");

			root.extinguish();
		},
	],
	[
		"exposes exported providers to the including module",
		() => {
			const inner = Flamework.createModule().registerClassProvider(Exported).exportProviders<Exported>().build();
			const outer = Flamework.createModule().includeModule(inner).ignite();

			expectEqual(outer.resolveDependency<Exported>().tag, "exported", "exported provider");

			outer.extinguish();
		},
	],
	[
		"keeps unexported providers private to their module",
		() => {
			const inner = Flamework.createModule().registerClassProvider(Private).build();
			const outer = Flamework.createModule().includeModule(inner).ignite();

			expectThrows(() => outer.resolveDependency<Private>(), "resolving an unexported provider");

			outer.extinguish();
		},
	],
	[
		// A definition is a blueprint: each ignition builds an isolated container, which is what
		// makes a module testable in the first place.
		"igniting a definition twice yields independent containers",
		() => {
			const definition = Flamework.createModule().registerClassProvider(Exported).build();

			const first = definition.ignite();
			const second = definition.ignite();

			expectTrue(
				first.resolveDependency<Exported>() !== second.resolveDependency<Exported>(),
				"each ignition builds its own providers",
			);

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"refuses to extinguish twice",
		() => {
			const module = Flamework.createModule().registerClassProvider(Exported).ignite();
			module.extinguish();

			expectThrows(() => module.extinguish(), "extinguishing an extinguished module");
		},
	],
]);
