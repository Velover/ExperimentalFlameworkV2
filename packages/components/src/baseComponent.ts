import Signal from "@rbxts/signal";
import { Component } from "./decorator";

/**
 * @hidden @internal
 */
export const SYMBOL_ATTRIBUTE_HANDLERS: unique symbol = {} as never;

/**
 * @hidden
 */
export const SYMBOL_ATTRIBUTE_SETTER: unique symbol = {} as never;

/**
 * @hidden @internal
 */
export const SYMBOL_ATTRIBUTE_WRITER: unique symbol = {} as never;

/**
 * The brand every component carries. It is what tells a component type apart from an Instance type
 * inside `BaseComponent`'s type parameters, which is how links are discovered.
 */
export interface ComponentLike<I extends Instance = Instance> {
	readonly _flamework_link_instance: I;
}

/**
 * Resolves a component type to the instance it is attached to. Anything else is left alone, so this
 * is a no-op for the ordinary Instance and value types an attribute or instance tree holds.
 */
export type ComponentInstance<T> = T extends ComponentLike<infer I> ? ResolvedInstance<I> : T;

/**
 * The keys of `T` whose type is a component.
 */
export type ComponentKeys<T> = {
	[K in keyof T]-?: NonNullable<T[K]> extends ComponentLike ? K : never;
}[keyof T];

/**
 * An instance tree with every component replaced by the instance it is attached to, which is what
 * `this.instance` holds: `this.instance.EffectHandler` is the part, not the component.
 */
export type ResolvedInstance<I> = [ComponentKeys<I>] extends [never]
	? I
	: Omit<I, ComponentKeys<I>> & { readonly [K in ComponentKeys<I>]: ComponentInstance<I[K]> };

/**
 * Attributes with every component replaced by the instance it is attached to, which is what
 * `this.attributes` holds.
 */
export type ResolvedAttributes<A> = { [K in keyof A]: ComponentInstance<A[K]> };

/**
 * The components named by `T`, which is what `childComponents` and `attributeComponents` hold. The
 * fields are readonly: a link is owned by Flamework, and reassigning one would only desync it.
 */
export type LinkedComponents<T> = { readonly [K in ComponentKeys<T>]: T[K] };

/**
 * The shape the attribute guards are generated from. An instance-valued attribute is stored on the
 * instance as an `InstanceHandle`, so that is what the guard has to check.
 */
export type AttributeGuards<A> = { [K in keyof A]: AttributeGuardValue<A[K]> };

type AttributeGuardValue<T> = [NonNullable<T>] extends [Instance | ComponentLike]
	? undefined extends T
		? InstanceHandle | undefined
		: InstanceHandle
	: T;

/**
 * This is the initial metadata for the components.
 */
export interface ComponentMetadata {
	attributes: unknown;
	instance: Instance;

	/**
	 * Components linked through the instance tree, keyed by the child that holds them.
	 *
	 * @hidden
	 */
	childComponents?: object;

	/**
	 * Components linked through an instance attribute, keyed by the attribute that points at them.
	 *
	 * @hidden
	 */
	attributeComponents?: object;

	/**
	 * Checks a write against the attribute's guard, and stores an instance-valued one as a handle.
	 * Returns whether it did the storing itself. Provided by `Components`.
	 *
	 * @hidden
	 */
	writeAttribute?: (key: string, value: unknown) => boolean;
}

/**x
 * This is the base component class which handles instance guards, attribute guards and cleanup.
 *
 * You should not construct this class manually, and all components must extend this class.
 */
@Component()
export class BaseComponent<A = {}, I extends Instance = Instance> {
	/**
	 * Attributes attached to this instance.
	 *
	 * Assigning to one writes it back to the instance, and an instance-valued attribute is written
	 * as an `InstanceHandle`.
	 *
	 * @metadata intrinsic-component-attributes
	 */
	public attributes: ResolvedAttributes<A>;

	/**
	 * The instance this component is attached to.
	 * This should only be called in a component lifecycle event.
	 *
	 * @metadata intrinsic-component-instance
	 */
	public instance: ResolvedInstance<I>;

	/**
	 * The components named by this component's instance tree, keyed by the child that holds them.
	 */
	public readonly childComponents: LinkedComponents<I>;

	/**
	 * The components named by this component's attributes, keyed by the attribute pointing at them.
	 */
	public readonly attributeComponents: LinkedComponents<A>;

	/**
	 * The attributes as written, which is what the generated guards check.
	 *
	 * @hidden @metadata intrinsic-component-attribute-guards
	 */
	declare readonly _flamework_attribute_guards: AttributeGuards<A>;

	/**
	 * The attributes as declared, which is what links are discovered from.
	 *
	 * @hidden @metadata intrinsic-component-attribute-links
	 */
	declare readonly _flamework_link_attributes: A;

	/**
	 * The instance tree as declared, which is what links are discovered from. Doubles as the brand
	 * that identifies a component type.
	 *
	 * @hidden @metadata intrinsic-component-instance-links
	 */
	declare readonly _flamework_link_instance: I;

	constructor(metadata: ComponentMetadata) {
		this.attributes = metadata.attributes as ResolvedAttributes<A>;
		this.instance = metadata.instance as ResolvedInstance<I>;
		this.childComponents = (metadata.childComponents ?? {}) as LinkedComponents<I>;
		this.attributeComponents = (metadata.attributeComponents ?? {}) as LinkedComponents<A>;
		this[SYMBOL_ATTRIBUTE_WRITER] = metadata.writeAttribute;
	}

	/** @hidden */
	public [SYMBOL_ATTRIBUTE_SETTER]<T extends keyof A>(
		key: T,
		value: ResolvedAttributes<A>[T],
		postfix?: boolean,
	): ResolvedAttributes<A>[T] {
		const previousValue = this.attributes[key];
		const write = this[SYMBOL_ATTRIBUTE_WRITER];

		// `Components` holds the guards, so it is what checks the value and what stores an
		// instance-valued attribute as a handle. Anything it did not store is a plain write.
		if (write === undefined || !write(key as string, value)) {
			// Through a local, because an assignment written against `this.attributes` is the very
			// thing the transformer rewrites into this method.
			const attributes = this.attributes as ResolvedAttributes<A>;
			attributes[key] = value;

			(this.instance as Instance).SetAttribute(key as string, value as never);
		}

		return postfix ? previousValue : value;
	}

	/** @hidden @internal */
	public [SYMBOL_ATTRIBUTE_WRITER]: ((key: string, value: unknown) => boolean) | undefined;

	/** @hidden @internal */
	public [SYMBOL_ATTRIBUTE_HANDLERS] = new Map<string, Signal<(newValue: unknown, oldValue: unknown) => void>>();

	/**
	 * Connect a callback to the change of a specific attribute.
	 * @param name The name of the attribute
	 * @param cb The callback
	 */
	onAttributeChanged<K extends keyof A>(
		name: K,
		cb: (newValue: ResolvedAttributes<A>[K], oldValue: ResolvedAttributes<A>[K]) => void,
	) {
		let list = this[SYMBOL_ATTRIBUTE_HANDLERS].get(name as string);
		if (!list) this[SYMBOL_ATTRIBUTE_HANDLERS].set(name as string, (list = new Signal()));

		return list.Connect(cb as never);
	}

	/**
	 * Destroys this component instance.
	 */
	destroy() {
		for (const [, changeHandler] of this[SYMBOL_ATTRIBUTE_HANDLERS]) {
			changeHandler.Destroy();
		}
	}
}
