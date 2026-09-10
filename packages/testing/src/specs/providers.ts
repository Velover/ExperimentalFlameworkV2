import { Flamework, Provider, type Module } from "@flamework/core";
import { expectEqual, expectNoThrow, expectThrows, expectTrue, suite } from "../testkit";

@Provider()
class Counter {
	public value = 0;
}

@Provider()
class Incrementer {
	constructor(private counter: Counter) {}

	public bump() {
		this.counter.value += 1;
		return this.counter.value;
	}
}

@Provider()
class Standalone {}

class NotAProvider {}

export = suite("providers", [
	[
		// Regression: `@Provider()` used to only define its metadata when RunService.IsServer(),
		// a leftover from v1's `@Service`. That made every module fail to build on the client.
		"registers on both the client and the server",
		() => {
			expectNoThrow(() => {
				Flamework.createModule().registerClassProvider(Standalone).build();
			}, "registering a provider");
		},
	],
	[
		"injects constructor dependencies",
		() => {
			const module = Flamework.createModule()
				.registerClassProvider(Counter)
				.registerClassProvider(Incrementer)
				.ignite();

			expectEqual(module.resolveDependency<Incrementer>().bump(), 1, "first bump");
			expectEqual(module.resolveDependency<Incrementer>().bump(), 2, "second bump");
			expectEqual(module.resolveDependency<Counter>().value, 2, "shared counter");

			module.extinguish();
		},
	],
	[
		"resolves a provider to the same instance",
		() => {
			const module = Flamework.createModule().registerClassProvider(Counter).ignite();

			expectTrue(
				module.resolveDependency<Counter>() === module.resolveDependency<Counter>(),
				"repeated resolution returns the same instance",
			);

			module.extinguish();
		},
	],
	[
		"rejects a class without the decorator",
		() => {
			expectThrows(() => {
				Flamework.createModule().registerProvider<NotAProvider>({
					type: "class",
					value: NotAProvider,
				});
			}, "registering an undecorated class");
		},
	],
	[
		// Judged at ignition rather than at registration: two registrations may share an id when
		// their scope conditions keep at most one of them, so the builder cannot know yet.
		"rejects a duplicate provider id at ignition",
		() => {
			const definition = Flamework.createModule().registerClassProvider(Counter).registerClassProvider(Counter);
			expectThrows(() => definition.ignite(), "igniting with the same provider twice");
		},
	],
	[
		"supports function providers with an injection context",
		() => {
			let resolvedFrom: Module | undefined;

			const module = Flamework.createModule()
				.registerProvider<string>(
					{
						type: "function",
						callback: (ctx) => {
							resolvedFrom = ctx.module;
							return `made:${ctx.injectionId}`;
						},
					},
					"greeting",
				)
				.ignite();

			expectEqual(module.resolveDependency<string>("greeting"), "made:greeting", "function provider result");
			expectTrue(resolvedFrom === module, "the context names the resolving module");

			module.extinguish();
		},
	],
	[
		"supports alias providers",
		() => {
			const module = Flamework.createModule()
				.registerClassProvider(Counter)
				.registerProvider<string>({ type: "alias", injectionId: Flamework.id<Counter>() }, "alias")
				.ignite();

			expectTrue(
				(module.resolveDependency("alias") as Counter) === module.resolveDependency<Counter>(),
				"alias resolves to the aliased provider",
			);

			module.extinguish();
		},
	],
	[
		"fails to resolve an unregistered dependency",
		() => {
			const module = Flamework.createModule().ignite();
			expectThrows(() => module.resolveDependency<Counter>(), "resolving an unregistered provider");
			module.extinguish();
		},
	],
]);
