import { Dependency, Flamework, Provider } from "@flamework/core";
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
	[
		"Dependency resolves against the first root ignited",
		() => {
			// Claim the default explicitly and release it, so that the case does not depend on what
			// ran before it: the next plain ignite is the first root again.
			Flamework.createModule().ignite({ default: true }).extinguish();

			const first = Flamework.createModule().registerClassProvider(Exported).ignite();
			const second = Flamework.createModule().registerClassProvider(Exported).ignite();

			expectTrue(Dependency<Exported>() === first.resolveDependency<Exported>(), "the first root is the default");
			expectTrue(Dependency<Exported>() !== second.resolveDependency<Exported>(), "a later root is not");

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"ignite({ default: true }) makes a later root the default",
		() => {
			const first = Flamework.createModule().registerClassProvider(Exported).ignite({ default: true });
			const second = Flamework.createModule().registerClassProvider(Exported).ignite({ default: true });

			expectTrue(Dependency<Exported>() === second.resolveDependency<Exported>(), "the explicit default wins");

			second.extinguish();
			first.extinguish();
		},
	],
	[
		"extinguishing the default releases it",
		() => {
			const module = Flamework.createModule().registerClassProvider(Exported).ignite({ default: true });
			module.extinguish();

			const message = expectThrows(() => Dependency<Exported>(), "Dependency with no default module");
			expectTrue(message.find("before any module was ignited")[0] !== undefined, "error names the cause");
		},
	],
	[
		// v1 let a constructor reach for a dependency through the global; the default is claimed
		// before ignition so that this still works, and the resolution constructs what is missing.
		"Dependency answers inside a provider constructor during ignition",
		() => {
			@Provider()
			class Reader {
				public seen = Dependency<Exported>();
			}

			// `Reader` first, so that `Exported` does not exist yet when the constructor asks for it.
			const module = Flamework.createModule()
				.registerClassProvider(Reader)
				.registerClassProvider(Exported)
				.ignite({ default: true });

			expectTrue(
				module.resolveDependency<Reader>().seen === module.resolveDependency<Exported>(),
				"resolved through the default while igniting",
			);

			module.extinguish();
		},
	],
]);
