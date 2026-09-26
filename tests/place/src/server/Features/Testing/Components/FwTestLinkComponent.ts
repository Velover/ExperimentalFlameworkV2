import {
	BaseComponent,
	Component,
	ComponentMetadata,
	ComponentStreamingMode,
} from "@flamework-experimental/components";
import { FW_TEST_LINK_TAG } from "shared/Features/Testing/FwTestConfig";
import { FwTestPartComponent } from "./FwTestPartComponent";

interface Attributes {
	/** An instance-valued attribute, stored on the model as an `InstanceHandle`. */
	Target: BasePart;

	/** The instance this one names has to carry `FwTestPartComponent`. */
	Linked: FwTestPartComponent;

	/** Optional, so the model is allowed to have no handle at all for it. */
	Spare?: BasePart;
}

/** A child of the model that has to carry a component of its own before this one is built. */
interface LinkTree extends Model {
	Core: FwTestPartComponent;
}

/**
 * Exercises links against the real engine: an `InstanceHandle` attribute, an attribute naming a
 * component, and a child of the instance tree naming one.
 */
// Watching, so the tree is re-read on a server too: swapping the linked child is the case that
// needs it, and contextual streaming leaves a server alone.
@Component({
	tag: FW_TEST_LINK_TAG,
	warningTimeout: 0,
	attributeWarningTimeout: 0,
	streamingMode: ComponentStreamingMode.Watching,
})
export class FwTestLinkComponent extends BaseComponent<Attributes, LinkTree> {
	public static created = 0;
	public static destroyed = 0;

	constructor(metadata: ComponentMetadata) {
		super(metadata);
		FwTestLinkComponent.created++;
	}

	/** Written through the component, so the transformer's rewrite is what stores the handle. */
	public retarget(target: BasePart) {
		this.attributes.Target = target;
	}

	override destroy() {
		super.destroy();
		FwTestLinkComponent.destroyed++;
	}
}
