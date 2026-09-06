import { BaseComponent, Component } from "@flamework/components";

@Component({ tag: "FixtureHandler" })
export class HandlerComponent extends BaseComponent<{ power: number }, BasePart> {}

/** Declares a tree of its own, so the structure it needs is part of every guard that names it. */
@Component({ tag: "FixtureRig" })
export class RigComponent extends BaseComponent<{}, Model & { Root: BasePart }> {}

interface LinkedAttributes {
	/** An instance-valued attribute, which is stored as an `InstanceHandle`. */
	Target: BasePart;

	/** Optional, so the handle is allowed to be missing. */
	Spare?: Part;

	/** A component-valued attribute: the instance it names has to carry that component. */
	Handler: HandlerComponent;

	/** A component with a tree: the instance it names has to have that tree as well. */
	Rig: RigComponent;

	/** Asking for the handle itself opts out of linking. */
	Raw: InstanceHandle;

	speed: number;
	label?: string;
}

@Component({ tag: "FixtureLinked" })
export class LinkedComponent extends BaseComponent<
	LinkedAttributes,
	Model & { EffectHandler: HandlerComponent; Plain: BasePart }
> {
	public rename() {
		this.attributes.label = "renamed";
	}

	public accelerate() {
		this.attributes.speed += 1;
		this.attributes.speed++;
	}

	public clear() {
		delete this.attributes.label;
	}

	public retarget(part: BasePart) {
		this.attributes.Target = part;
	}

	/** The instance tree holds instances, and the components it names live beside them. */
	public reach() {
		const part: BasePart = this.instance.EffectHandler;
		const handler: HandlerComponent = this.childComponents.EffectHandler;
		const linked: HandlerComponent = this.attributeComponents.Handler;
		const target: BasePart = this.attributes.Target;
		const raw: InstanceHandle = this.attributes.Raw;

		return [part, handler, linked, target, raw];
	}
}
