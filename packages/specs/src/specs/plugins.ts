import { Flamework, OnStart, Provider } from "@flamework-experimental/core";
import { expectArrayEqual, expectEqual, expectThrows, expectTrue, suite } from "../testkit";

/** Undecorated on purpose: a plugin provides one, and nothing about that needs metadata. */
class Metrics {
	public started = 0;
}

@Provider()
class Reporter {
	constructor(public metrics: Metrics) {}
}

@Provider()
class Starter implements OnStart {
	public onStart() {}
}

export = suite("plugins", [
	[
		"provides an instance that providers inject and the module resolves",
		() => {
			const plugin = Flamework.createPlugin("Metrics", (target) => {
				const metrics = new Metrics();
				target.provideInstance(metrics);
				target.onPostIgnite(() => (metrics.started += 1));
			});

			const module = Flamework.createModule().includePlugin(plugin).registerClassProvider(Reporter).ignite();

			const metrics = module.resolveDependency<Metrics>();
			expectTrue(module.resolveDependency<Reporter>().metrics === metrics, "the provider injected the instance");
			expectEqual(metrics.started, 1, "the hook saw the same instance");

			module.extinguish();
		},
	],
	[
		"constructs a plugin's class provider with injection",
		() => {
			const plugin = Flamework.createPlugin("Reporting", (target) => {
				target.provideInstance(new Metrics());
				target.registerClassProvider(Reporter);
			});

			const module = Flamework.createModule().includePlugin(plugin).ignite();

			expectTrue(
				module.resolveDependency<Reporter>().metrics === module.resolveDependency<Metrics>(),
				"the plugin's provider was injected from the same module",
			);

			module.extinguish();
		},
	],
	[
		// The setup closes over `metrics`; running it per ignition is what keeps two containers apart.
		"sets a plugin up once per ignition, so two containers share nothing",
		() => {
			let setups = 0;
			const plugin = Flamework.createPlugin("Counting", (target) => {
				setups += 1;
				target.provideInstance(new Metrics());
			});

			const definition = Flamework.createModule().includePlugin(plugin).build();
			const first = definition.ignite();
			const second = definition.ignite();

			expectEqual(setups, 2, "setups for two ignitions");
			expectTrue(
				first.resolveDependency<Metrics>() !== second.resolveDependency<Metrics>(),
				"each ignition got its own instance",
			);

			first.extinguish();
			second.extinguish();
		},
	],
	[
		"sets a plugin reached three ways up once",
		() => {
			let setups = 0;
			const shared = Flamework.createPlugin("Shared", () => {
				setups += 1;
			});
			const left = Flamework.createPlugin("Left", (target) => target.includePlugin(shared));
			const right = Flamework.createPlugin("Right", (target) => target.includePlugin(shared));

			const module = Flamework.createModule()
				.includePlugin(shared)
				.includePlugin(left)
				.includePlugin(right)
				.includePlugin(shared)
				.ignite();

			expectEqual(setups, 1, "setups for a plugin included by the module twice and by two plugins");

			module.extinguish();
		},
	],
	[
		"sets an included plugin up before the plugin that included it continues",
		() => {
			const order = new Array<string>();

			const database = Flamework.createPlugin("Database", (target) => {
				order.push("database");
				target.onPostIgnite(() => order.push("database:ignited"));
			});
			const inventory = Flamework.createPlugin("Inventory", (target) => {
				target.includePlugin(database);
				order.push("inventory");
				target.onPostIgnite(() => order.push("inventory:ignited"));
			});

			const module = Flamework.createModule().includePlugin(inventory).ignite();

			expectArrayEqual(
				order,
				["database", "inventory", "database:ignited", "inventory:ignited"],
				"setup order, then hook order",
			);

			module.extinguish();
		},
	],
	[
		"stops a ring of plugins on the second arrival",
		() => {
			let setups = 0;

			// Each names the other; the closures only run at ignition, once both exist.
			const first = Flamework.createPlugin("First", (target) => {
				setups += 1;
				target.includePlugin(second);
			});
			const second = Flamework.createPlugin("Second", (target) => {
				setups += 1;
				target.includePlugin(first);
			});

			const module = Flamework.createModule().includePlugin(first).ignite();

			expectEqual(setups, 2, "each plugin in the ring was set up once");

			module.extinguish();
		},
	],
	[
		// Two plugins observing one interface used to be a map overwrite: only the last saw anything.
		"tells every plugin observing an interface",
		() => {
			const seen = new Array<string>();
			const a = Flamework.createPlugin("A", (target) =>
				target.observe<OnStart>({ onAdded: () => seen.push("a") }),
			);
			const b = Flamework.createPlugin("B", (target) =>
				target.observe<OnStart>({ onAdded: () => seen.push("b") }),
			);

			const module = Flamework.createModule()
				.includePlugin(a)
				.includePlugin(b)
				.registerClassProvider(Starter)
				.ignite();

			expectArrayEqual(seen, ["a", "b"], "observers, in inclusion order");

			module.extinguish();
		},
	],
	[
		"tells an observer what kind of object it is seeing",
		() => {
			const kinds = new Array<string>();
			const plugin = Flamework.createPlugin("Kinds", (target) =>
				target.observe<OnStart>({ onAdded: (_, context) => kinds.push(context.kind) }),
			);

			const module = Flamework.createModule().includePlugin(plugin).registerClassProvider(Starter).ignite();
			module.listen<OnStart>({ onStart() {} });

			expectArrayEqual(kinds, ["provider", "instance"], "kinds, provider first");

			module.extinguish();
		},
	],
	[
		"refuses a provider a plugin registers under an id the module already has",
		() => {
			const plugin = Flamework.createPlugin("Duplicate", (target) => target.registerClassProvider(Reporter));

			const message = expectThrows(
				() => Flamework.createModule().registerClassProvider(Reporter).includePlugin(plugin).ignite(),
				"a plugin registering an id the module has",
			);

			expectTrue(message.find("registered more than once")[0] !== undefined, "error names the collision");
		},
	],
	[
		"refuses to resolve from the module during setup",
		() => {
			const plugin = Flamework.createPlugin("Eager", (target) => {
				target.module.resolveDependency<Metrics>();
			});

			const message = expectThrows(
				() => Flamework.createModule().includePlugin(plugin).ignite(),
				"resolving during setup",
			);

			expectTrue(message.find("pre%-ignite")[0] !== undefined, "error names the phase");
		},
	],
	[
		"releases a provided instance's interfaces on extinguish",
		() => {
			const removed = new Array<string>();

			@Provider()
			class Provided implements OnStart {
				public onStart() {}
			}

			const plugin = Flamework.createPlugin("Provided", (target) => {
				target.provideInstance(new Provided());
				target.observe<OnStart>({ onRemoved: () => removed.push("start") });
			});

			const module = Flamework.createModule().includePlugin(plugin).ignite();
			expectEqual(removed.size(), 0, "removals before extinguish");

			module.extinguish();
			expectEqual(removed.size(), 1, "removals after extinguish");
		},
	],
]);
