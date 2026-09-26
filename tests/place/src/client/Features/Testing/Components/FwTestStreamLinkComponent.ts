import { BaseComponent, Component } from "@flamework-experimental/components";
import { FW_TEST_STREAM_LINK_TAG } from "shared/Features/Testing/FwTestConfig";

interface Attributes {
	/** Names a part the server keeps outside the streaming radius until the client asks for it. */
	Target: BasePart;
}

/**
 * The client half of the streaming link test. Its attribute names a part that has not replicated
 * yet, so the component cannot be built until that part streams in -- which is the case the Lune
 * suites can only stub.
 */
@Component({ tag: FW_TEST_STREAM_LINK_TAG, warningTimeout: 0, attributeWarningTimeout: 0 })
export class FwTestStreamLinkComponent extends BaseComponent<Attributes, BasePart> {}
