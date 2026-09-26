import { BaseComponent, Component, ComponentMetadata } from "@flamework-experimental/components";
import { Module, OnStart, OnTick } from "@flamework-experimental/core";
import { t } from "@rbxts/t";
import { FW_TEST_TAG } from "shared/Features/Testing/FwTestConfig";

interface Attributes {
	Speed: number;
}

@Component({
	tag: FW_TEST_TAG,
	attributes: { Speed: t.number },
	defaults: { Speed: 1 },
	instanceGuard: t.instanceIsA("BasePart"),
})
export class FwTestPartComponent extends BaseComponent<Attributes, BasePart> implements OnStart, OnTick {
	public static created = 0;
	public static destroyed = 0;
	/** One entry per construction (+Name) and destruction (-Name), to diagnose duplicate components. */
	public static log = new Array<string>();

	public started = false;
	public ticks = 0;
	/** `[newValue, oldValue]` pairs seen by onAttributeChanged. */
	public changes = new Array<[number, number]>();

	// ComponentMetadata has to come first; anything after it is injected by the module.
	constructor(
		metadata: ComponentMetadata,
		public readonly module: Module,
	) {
		super(metadata);
		FwTestPartComponent.created++;
		FwTestPartComponent.log.push(`+${this.instance.Name}`);
	}

	/** The write a cast let through, which the attribute's own guard has to refuse. */
	public misassign(value: string) {
		this.attributes.Speed = value as unknown as number;
	}

	public setSpeed(speed: number) {
		this.attributes.Speed = speed;
	}

	onStart() {
		this.started = true;
		this.onAttributeChanged("Speed", (newValue, oldValue) => this.changes.push([newValue, oldValue]));
	}

	onTick() {
		this.ticks++;
	}

	override destroy() {
		super.destroy();
		FwTestPartComponent.destroyed++;
		FwTestPartComponent.log.push(`-${this.instance.Name}`);
	}
}
