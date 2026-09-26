import { OnInit, Provider } from "@flamework-experimental/core";

/** Injected into FwTestController, so its onInit has to run before the controller's. */
@Provider()
export class FwTestClientDependency implements OnInit {
	public initialized = false;

	onInit() {
		this.initialized = true;
	}
}
