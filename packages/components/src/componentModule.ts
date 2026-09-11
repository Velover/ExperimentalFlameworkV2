import {
	Flamework,
	Reflect,
	Modding,
	describeConditions,
	getClassesInGlob,
	getClassesInPath,
	type ScopeCondition,
} from "@flamework-experimental/core";
import type { Constructor } from "./utility";
import { Components } from "./components";
import { BaseComponent } from "./baseComponent";
import type { ComponentConfig } from "./decorator";

export interface ComponentModuleConfig {
	components: Constructor[];

	/**
	 * The components left out of this module by their scope conditions, by identifier, each with
	 * a description of why, for the error a lookup of one gets.
	 */
	skipped?: Map<string, string>;
}

/** No condition: what a component or a registration that was not given one contributes to a list. */
const NO_CONDITION: ScopeCondition = {};

/** The scope condition a component's own decorator set, or none. Own metadata: a subclass does not inherit it. */
function getComponentScope(component: Constructor): ScopeCondition {
	const config = Reflect.getOwnMetadata<ComponentConfig>(component, "flamework:componentConfig");
	if (config === undefined || (config.activeIn === undefined && config.inactiveIn === undefined)) {
		return NO_CONDITION;
	}

	return { activeIn: config.activeIn, inactiveIn: config.inactiveIn };
}

export class ComponentPlugin {
	public static createPlugin() {
		return new ComponentPlugin();
	}

	/**
	 * This is a shorthand for creating a default components plugin.
	 *
	 * @metadata macro
	 */
	public static fromPath<T extends string>(
		_stringPath: T,
		options?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		return this.createPlugin().registerComponents(_stringPath, options, path).build();
	}

	/**
	 * This is a shorthand for creating a default components plugin from a compile-time glob.
	 *
	 * @metadata macro
	 */
	public static fromGlob<T extends string>(
		_glob: T,
		options?: ScopeCondition,
		glob?: Modding.Intrinsic<"pathglob", [T], string>,
	) {
		return this.createPlugin().registerComponentsGlob(_glob, options, glob).build();
	}

	private components = new Array<Constructor>();

	/** The condition each registration was given, for the classes that were given one. */
	private registrationScopes = new Map<Constructor, ScopeCondition>();

	private constructor() {}

	/**
	 * Registers a single component class.
	 *
	 * The class must carry the `@Component()` decorator itself; an undecorated subclass of a
	 * component inherits its parent's identifier and would otherwise be registered as the parent.
	 *
	 * With a scope condition, the component is registered only in a build where it holds, on top of
	 * the module's condition and the class's own.
	 */
	public registerComponent(component: Constructor<BaseComponent>, options?: ScopeCondition) {
		if (!Reflect.hasOwnMetadata(component, "flamework:component")) {
			error(
				Reflect.hasMetadata(component, "flamework:component")
					? `class '${component}' is missing the @Component() decorator: it inherits one from a parent class, but every component must be decorated itself`
					: `class '${component}' is missing the @Component() decorator`,
			);
		}

		if (!this.components.includes(component)) {
			this.components.push(component);
		}

		if (options !== undefined) {
			this.registrationScopes.set(component, options);
		}

		return this;
	}

	/**
	 * Registers every exported `@Component()` class under the specified path and its descendants.
	 * The options apply to every class found.
	 *
	 * @metadata macro
	 */
	public registerComponents<T extends string>(
		_stringPath: T,
		options?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		assert(path !== undefined);

		return this.registerComponentClasses(getClassesInPath(path), options);
	}

	/**
	 * Registers every exported `@Component()` class under every path matched by the specified glob,
	 * which is resolved at compile time.
	 *
	 * @metadata macro
	 */
	public registerComponentsGlob<T extends string>(
		_glob: T,
		options?: ScopeCondition,
		glob?: Modding.Intrinsic<"pathglob", [T], string>,
	) {
		assert(glob !== undefined);

		return this.registerComponentClasses(getClassesInGlob(glob), options);
	}

	private registerComponentClasses(classes: object[], options?: ScopeCondition) {
		for (const component of classes) {
			// Own metadata only, so an undecorated subclass of a component is skipped rather than
			// registered under its parent's identifier.
			if (Reflect.hasOwnMetadata(component, "flamework:component")) {
				this.registerComponent(component as Constructor<BaseComponent>, options);
			}
		}

		return this;
	}

	public build() {
		const registered = this.components;
		const registrationScopes = this.registrationScopes;

		// Components are constructed through the module this plugin is included in (see
		// `Components.module`), so they take their lifecycle events from that module's plugins.
		return Flamework.createPlugin("Components", (target) => {
			// Judged per ignition, against the module's condition as well as each class's own, so
			// that a component is scoped the way a provider is.
			const active = new Array<Constructor>();
			const skipped = new Map<string, string>();
			for (const component of registered) {
				const conditions = [registrationScopes.get(component) ?? NO_CONDITION, getComponentScope(component)];
				if (target.isActive(...conditions)) {
					active.push(component);
				} else {
					const identifier = Reflect.getOwnMetadata<string>(component, "identifier");
					assert(identifier !== undefined, `class '${component}' has no identifier`);
					skipped.set(identifier, describeConditions([target.scope ?? NO_CONDITION, ...conditions]));
				}
			}

			const components = new Components(target.module, { components: active, skipped });
			target.provideInstance(components);

			// Tags are only watched once the module has ignited, so that every provider a component
			// might inject exists by the time one is constructed.
			target.onPostIgnite(() => components.startCollectionService());
			target.onExtinguished(() => components.stopCollectionService());
		});
	}
}
