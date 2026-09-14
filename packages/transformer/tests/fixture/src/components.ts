import { t } from "@rbxts/t";
import { BaseComponent, Component, ComponentMetadata, Components } from "@flamework-experimental/components";

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
	// A child naming a component is a link; `SpareHandler` is one beside a plain child.
	Model & { EffectHandler: HandlerComponent; SpareHandler: HandlerComponent; Plain: BasePart }
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

/** Writes to an attribute through a receiver that is itself a macro call. */
@Component({ tag: "FixtureCounter" })
export class CounterComponent extends BaseComponent<{ count: number }, BasePart> {
	constructor(
		metadata: ComponentMetadata,
		private components: Components,
	) {
		super(metadata);
	}

	public bumpPostfix(other: BasePart) {
		this.components.getComponent<CounterComponent>(other)!.attributes.count++;
	}

	public bumpPrefix(other: BasePart) {
		++this.components.getComponent<CounterComponent>(other)!.attributes.count;
	}

	public bumpCompound(other: BasePart) {
		this.components.getComponent<CounterComponent>(other)!.attributes.count += 1;
	}
}

/** A tree three levels deep, with a child that may be one of two classes. */
@Component({ tag: "FixtureDeep" })
export class DeepComponent extends BaseComponent<{}, Model & { Root: BasePart & { Texture: Texture | Decal } }> {}

/**
 * A union whose members declare children of their own has no shape: which children go with which
 * class is more than a shape says, so the guard is kept for it.
 */
@Component({ tag: "FixtureEither" })
export class EitherComponent extends BaseComponent<{}, (Model & { Root: BasePart }) | (Folder & { Core: Folder })> {}

/** A guard written by hand is kept as it is, with no shape beside it. */
@Component({ tag: "FixtureCustom", instanceGuard: t.instanceIsA("Part") })
export class CustomGuardComponent extends BaseComponent<{}, Part> {}

/**
 * A child naming a component with a tree of its own: the owner's shape stops at the child's class,
 * and that component's tracker answers for the tree below it.
 */
@Component({ tag: "FixtureRigOwner" })
export class RigOwnerComponent extends BaseComponent<{}, Model & { Rig: RigComponent }> {}
