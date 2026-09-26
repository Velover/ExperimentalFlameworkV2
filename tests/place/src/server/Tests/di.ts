import { Components } from "@flamework-experimental/components";
import { Dependency, OnStart, Provider } from "@flamework-experimental/core";
import { defineTests, expectDefined, expectEqual, expectTrue, test } from "@flamework-experimental/testing";
import { FwTestDependency } from "server/Features/Testing/Services/FwTestDependency";
import { FwTestService } from "server/Features/Testing/Services/FwTestService";

/**
 * Dependency injection against the real server module: these run through
 * `workspace.FlameworkTests:Invoke("di")` in Studio, or `flamework-test test place.rbxl --sections di`.
 * A test provider gets what it exercises injected; `Dependency<T>()` is checked against that.
 */
@Provider({ activeIn: ["testing"] })
export class DiTests implements OnStart {
	constructor(
		private readonly service: FwTestService,
		private readonly dependency: FwTestDependency,
		private readonly components: Components,
	) {}

	onStart() {
		defineTests("di", ({ module }) => {
			test("the section knows the module that ignited it", () => {
				expectDefined(module, "module");
			});

			test("Dependency<T>() answers from the ignited module", () => {
				expectEqual(Dependency<FwTestService>(), this.service, "the injected instance");
				expectEqual(
					module?.resolveDependency<FwTestService>(),
					this.service,
					"the same instance through the module",
				);
			});

			test("a provider's onInit ran before anything injected it", () => {
				expectTrue(this.dependency.initialized, "FwTestDependency.initialized");
			});

			test("the components plugin provided its registry", () => {
				expectDefined(this.components, "Components");
			});
		});
	}
}
