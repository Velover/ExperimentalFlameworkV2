import { OnInit, Provider } from "@flamework-experimental/core";

/** Injected into FwTestService, so its onInit has to run before the service's. */
@Provider()
export class FwTestDependency implements OnInit {
	public initialized = false;

	onInit() {
		this.initialized = true;
	}
}
