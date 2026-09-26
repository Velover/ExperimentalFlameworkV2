import { Provider } from "@flamework-experimental/core";

/** Only constructed when something resolves it (the v2 replacement for `@Optional`). */
@Provider({ lazy: true })
export class FwTestClientLazyProvider {
	public static constructed = 0;

	constructor() {
		FwTestClientLazyProvider.constructed++;
	}
}
