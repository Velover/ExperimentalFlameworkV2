import { BaseComponent, Component, ComponentStreamingMode } from "@flamework-experimental/components";
import { t } from "@rbxts/t";
import { FW_TEST_STREAM_TAG } from "shared/Features/Testing/FwTestConfig";

/**
 * Attached to parts the server spawns near and far from the spawn point. With StreamingEnabled the
 * far ones never arrive, so the number of these components tells whether streaming is on.
 */
@Component({
	tag: FW_TEST_STREAM_TAG,
	instanceGuard: t.instanceIsA("BasePart"),
	streamingMode: ComponentStreamingMode.Watching,
})
export class FwTestStreamPartClientComponent extends BaseComponent<{}, BasePart> {}
