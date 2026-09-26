import { ComponentPlugin } from "@flamework-experimental/components";
import { Flamework, LifecyclePlugin, type Module } from "@flamework-experimental/core";
import { TestingPlugin } from "@flamework-experimental/testing";
import { FwTestConfig } from "shared/Features/Testing/FwTestConfig";

let module: Module | undefined;

/**
 * Builds and ignites the server module. `runtime.server.ts` calls this when the place runs; an
 * Open Cloud task, where no Script runs, requires this module through `testing.entry` and calls
 * it itself. Either way the module ignites once.
 */
export function ignite(): Module {
	if (module !== undefined) {
		return module;
	}

	// One module per realm. Providers are discovered by folder; `LifecyclePlugin` supplies
	// onInit/onStart/onTick/onPhysics, which are no longer built in, and components come from
	// `ComponentPlugin`, which ticks through the same LifecyclePlugin.
	module = Flamework.createModule()
		.includePlugin(LifecyclePlugin)
		.includePlugin(ComponentPlugin.fromPath("src/server/Features/Testing/Components"))
		.registerProviders("src/server/Core")
		.registerProviders("src/server/Features")
		.registerProviders("src/shared/Core")
		.registerProviders("src/shared/Features")
		// The test providers, and the host that runs them: both only in a build where the `testing`
		// scope is active (FLAMEWORK_SCOPES in .env), which is the one switch for tests.
		.registerProviders("src/server/Tests", { activeIn: ["testing"] })
		.registerProviders("src/shared/Tests", { activeIn: ["testing"] })
		.includePlugin(TestingPlugin)
		// A function provider runs on every resolution, so each injection receives its own object.
		.registerProvider<FwTestConfig>({ type: "function", callback: () => ({ realm: "server", stamp: os.clock() }) })
		.ignite();

	return module;
}
