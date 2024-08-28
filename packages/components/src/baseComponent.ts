import Signal from "@rbxts/signal";
import { Component } from "./decorator";

/**
 * @hidden @internal
 */
export const SYMBOL_ATTRIBUTE_HANDLERS: unique symbol = {} as never;

/**
 * @hidden @deprecated
 */
export const SYMBOL_ATTRIBUTE_SETTER: unique symbol = {} as never;

/**
 * This is the initial metadata for the components.
 */
export interface ComponentMetadata {
	attributes: unknown;
	instance: Instance;
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
	 * @metadata intrinsic-component-attributes
	 */
	public attributes: Readonly<A>;

	/**
	 * The instance this component is attached to.
	 * This should only be called in a component lifecycle event.
	 *
	 * @metadata intrinsic-component-instance
	 */
	public instance: I;

	constructor(metadata: ComponentMetadata) {
		this.attributes = metadata.attributes as A;
		this.instance = metadata.instance as I;
	}

	/** @hidden @deprecated */
	public [SYMBOL_ATTRIBUTE_SETTER]<T extends keyof A>(key: T, value: A[T], postfix?: boolean) {
		const previousValue = this.attributes[key];
		(this.attributes as A)[key] = value;
		this.instance.SetAttribute(key as string, value as never);
		return postfix ? previousValue : value;
	}

	/** @hidden @internal */
	public [SYMBOL_ATTRIBUTE_HANDLERS] = new Map<string, Signal<(newValue: unknown, oldValue: unknown) => void>>();

	/**
	 * Connect a callback to the change of a specific attribute.
	 * @param name The name of the attribute
	 * @param cb The callback
	 */
	onAttributeChanged<K extends keyof A>(name: K, cb: (newValue: A[K], oldValue: A[K]) => void) {
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
