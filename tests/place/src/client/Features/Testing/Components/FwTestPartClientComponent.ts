import { BaseComponent, Component, ComponentMetadata } from "@flamework-experimental/components";
import { Module, OnStart, OnTick } from "@flamework-experimental/core";
import { t } from "@rbxts/t";
import { FW_TEST_TAG } from "shared/Features/Testing/FwTestConfig";

interface Attributes {
	Speed: number;
}

/** Client-side view of the server's tagged part: the same tag, registered by the client module. */
@Component({
	tag: FW_TEST_TAG,
	attributes: { Speed: t.number },
	defaults: { Speed: 1 },
	instanceGuard: t.instanceIsA("BasePart"),
})
export class FwTestPartClientComponent extends BaseComponent<Attributes, BasePart> implements OnStart, OnTick {
	public ticks = 0;
	/** `[newValue, oldValue]` pairs seen by onAttributeChanged. */
	public changes = new Array<[number, number]>();

	constructor(
		metadata: ComponentMetadata,
		public readonly module: Module,
	) {
		super(metadata);
	}

	onStart() {
		this.onAttributeChanged("Speed", (newValue, oldValue) => this.changes.push([newValue, oldValue]));
	}

	onTick() {
		this.ticks++;
	}
}
