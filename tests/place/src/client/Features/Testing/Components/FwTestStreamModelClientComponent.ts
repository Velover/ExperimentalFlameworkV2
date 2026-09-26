import { BaseComponent, Component, ComponentMetadata } from "@flamework-experimental/components";
import { FW_TEST_STREAM_MODEL_TAG } from "shared/Features/Testing/FwTestConfig";

/**
 * The client half of the far model the server parks outside the streaming radius. The default
 * streaming mode, which watches the tree on the client: the model can arrive a part at a time, and
 * the component is built once `Core` is there. Under the `streaming` project none of it is on the
 * client until the character goes near, which is what the client's `streaming` section proves.
 */
@Component({ tag: FW_TEST_STREAM_MODEL_TAG, warningTimeout: 0 })
export class FwTestStreamModelClientComponent extends BaseComponent<{}, Model & { Core: BasePart }> {
	public static created = 0;
	public static destroyed = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		FwTestStreamModelClientComponent.created++;
	}

	override destroy() {
		super.destroy();
		FwTestStreamModelClientComponent.destroyed++;
	}
}
