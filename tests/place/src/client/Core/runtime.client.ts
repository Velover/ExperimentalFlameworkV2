import { ComponentPlugin } from "@flamework-experimental/components";
import { Flamework, LifecyclePlugin } from "@flamework-experimental/core";
import { TestingPlugin } from "@flamework-experimental/testing";
import { FwTestConfig } from "shared/Features/Testing/FwTestConfig";

// One module per realm. Providers are discovered by folder; `LifecyclePlugin` supplies
// onInit/onStart/onTick/onPhysics/onRender, which are no longer built in, and components come from
// `ComponentPlugin`, which ticks through the same LifecyclePlugin.
Flamework.createModule()
	.includePlugin(LifecyclePlugin)
	.includePlugin(ComponentPlugin.fromPath("src/client/Features/Testing/Components"))
	.registerProviders("src/client/Core")
	.registerProviders("src/client/Features")
	.registerProviders("src/shared/Core")
	.registerProviders("src/shared/Features")
	// The client's test providers and its own host, both only in a build where the `testing` scope
	// is active. The client answers its own Workspace.FlameworkTests; the server's sections are
	// reached from here through Testing.runOnServer.
	.registerProviders("src/client/Tests", { activeIn: ["testing"] })
	.registerProviders("src/shared/Tests", { activeIn: ["testing"] })
	.includePlugin(TestingPlugin)
	// A function provider runs on every resolution, so each injection receives its own object.
	.registerProvider<FwTestConfig>({ type: "function", callback: () => ({ realm: "client", stamp: os.clock() }) })
	.ignite();
