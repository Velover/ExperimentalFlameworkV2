import { Dependency, Flamework, Provider } from "@flamework/core";
import { expectThrows, expectTrue, suite } from "../testkit";

@Provider()
class Widget {}

export = suite("modules", [
	[
		// A definition is a blueprint: each ignition builds an isolated container, which is what
		// makes a module testable in the first place.
		"igniting a definition twice yields independent containers",
		() => {
			const definition = Flamework.createModule().registerClassProvider(Widget).build();

			const first = definition.ignite();
			const second = definition.ignite();

			expectTrue(
				first.resolveDependency<Widget>() !== second.resolveDependency<Widget>(),
				"each ignition builds its own providers",
			);

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"refuses to extinguish twice",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite();
			module.extinguish();

			expectThrows(() => module.extinguish(), "extinguishing an extinguished module");
		},
	],
	[
		// Igniting a module twice used to return quietly, the one transition the state machine let
		// slide; it was there for a shared submodule ignited by each includer, which no longer exists.
		"refuses to ignite a module twice",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite();

			// `ignite` on a module is internal -- a definition is what gets ignited -- so it is
			// reached through a cast here, to pin the transition down rather than the API.
			const internal = module as unknown as { ignite: (this: void) => unknown };
			expectThrows(() => internal.ignite(), "igniting an ignited module");

			module.extinguish();
		},
	],
	[
		"Dependency resolves against the first root ignited",
		() => {
			// Claim the default explicitly and release it, so that the case does not depend on what
			// ran before it: the next plain ignite is the first root again.
			Flamework.createModule().ignite({ default: true }).extinguish();

			const first = Flamework.createModule().registerClassProvider(Widget).ignite();
			const second = Flamework.createModule().registerClassProvider(Widget).ignite();

			expectTrue(Dependency<Widget>() === first.resolveDependency<Widget>(), "the first root is the default");
			expectTrue(Dependency<Widget>() !== second.resolveDependency<Widget>(), "a later root is not");

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"ignite({ default: true }) makes a later root the default",
		() => {
			const first = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			const second = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });

			expectTrue(Dependency<Widget>() === second.resolveDependency<Widget>(), "the explicit default wins");

			second.extinguish();
			first.extinguish();
		},
	],
	[
		"extinguishing the default releases it",
		() => {
			const module = Flamework.createModule().registerClassProvider(Widget).ignite({ default: true });
			module.extinguish();

			const message = expectThrows(() => Dependency<Widget>(), "Dependency with no default module");
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
				public seen = Dependency<Widget>();
			}

			// `Reader` first, so that `Widget` does not exist yet when the constructor asks for it.
			const module = Flamework.createModule()
				.registerClassProvider(Reader)
				.registerClassProvider(Widget)
				.ignite({ default: true });

			expectTrue(
				module.resolveDependency<Reader>().seen === module.resolveDependency<Widget>(),
				"resolved through the default while igniting",
			);

			module.extinguish();
		},
	],
]);
