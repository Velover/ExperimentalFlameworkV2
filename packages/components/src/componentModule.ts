import {
	Flamework,
	HookPriority,
	Reflect,
	Modding,
	describeConditions,
	getClassesInGlob,
	getClassesInPath,
	holdsCondition,
	leftOutRegistration,
	type LeftOutRegistration,
	type Module,
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

	/**
	 * The path and glob registrations left out by their own condition, whose folders were never
	 * looked up: what a lookup of a component under one of them names.
	 */
	leftOut?: ReadonlyArray<LeftOutRegistration>;
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

/**
 * What every component plugin set up in one ignition of a module registers into: the components
 * kept, in the order the plugins were set up and each registered them, and the ones left out by
 * scope. They share one `Components`, which the first plugin set up builds from this once every
 * plugin has registered.
 */
interface SharedRegistration {
	active: Array<Constructor>;
	skipped: Map<string, string>;
	leftOut: Array<LeftOutRegistration>;
}

/** By the module being ignited: set up by the first component plugin, gone with the module. */
const sharedRegistrations = new WeakMap<Module, SharedRegistration>();

export class ComponentPlugin {
	public static createPlugin() {
		return new ComponentPlugin();
	}

	/**
	 * This is a shorthand for creating a default components plugin.
	 *
	 * A module may include any number of component plugins; they share the module's one `Components`.
	 * With a scope condition that does not hold, the folder is not touched (see `registerComponents`).
	 *
	 * @metadata macro
	 */
	public static fromPath<T extends string>(
		_stringPath: T,
		options?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		return this.createPlugin().registerFolder(`ComponentPlugin.fromPath("${_stringPath}")`, options, path).build();
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
		return this.createPlugin().registerGlob(`ComponentPlugin.fromGlob("${_glob}")`, options, glob).build();
	}

	private components = new Array<Constructor>();

	/** The condition each registration was given, for the classes that were given one. */
	private registrationScopes = new Map<Constructor, ScopeCondition>();

	/** The path and glob registrations whose own condition did not hold: their folders were never looked up. */
	private leftOut = new Array<LeftOutRegistration>();

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
	 * Registers every `@Component()` class the modules under the specified path and its descendants
	 * define, exported or not. The options apply to every class found.
	 *
	 * When their scope condition does not hold, the folder is not touched at all -- not looked up,
	 * nothing under it required -- so a build can leave it out of the place. The condition is this
	 * registration's own: one given to `includePlugin` is judged later, at ignition, after the folder
	 * has been required.
	 *
	 * @metadata macro
	 */
	public registerComponents<T extends string>(
		_stringPath: T,
		options?: ScopeCondition,
		path?: Modding.Intrinsic<"path", [T], string[]>,
	) {
		return this.registerFolder(`registerComponents("${_stringPath}")`, options, path);
	}

	/**
	 * Registers every `@Component()` class the modules under every path matched by the specified
	 * glob define, exported or not. The glob is resolved at compile time. As with
	 * `registerComponents`, a scope condition that does not hold leaves every matched folder untouched.
	 *
	 * @metadata macro
	 */
	public registerComponentsGlob<T extends string>(
		_glob: T,
		options?: ScopeCondition,
		glob?: Modding.Intrinsic<"pathglob", [T], string>,
	) {
		return this.registerGlob(`registerComponentsGlob("${_glob}")`, options, glob);
	}

	/** `registerComponents`, named in messages as `call`. */
	private registerFolder(call: string, options: ScopeCondition | undefined, path: string[] | undefined) {
		assert(path !== undefined);

		// Recorded, so that a lookup of a component under the folder can say why it is missing.
		if (!holdsCondition(options)) {
			this.leftOut.push(leftOutRegistration(call, options!, { path }));
			return this;
		}

		return this.registerComponentClasses(getClassesInPath(path, call), options);
	}

	/** `registerComponentsGlob`, named in messages as `call`. */
	private registerGlob(call: string, options: ScopeCondition | undefined, glob: string | undefined) {
		assert(glob !== undefined);

		if (!holdsCondition(options)) {
			this.leftOut.push(leftOutRegistration(call, options!, { glob }));
			return this;
		}

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
		const leftOut = this.leftOut;

		// Components are constructed through the module this plugin is included in (see
		// `Components.module`), so they take their lifecycle events from that module's plugins.
		//
		// Every component plugin a module includes -- several `fromPath`s, a `fromGlob` beside a
		// built one -- registers into the one `Components` of that module: two would each provide
		// `Components` under the same id, a component could link only to those of its own plugin,
		// and `Dependency<Components>()` could answer for one of them at most.
		return Flamework.createPlugin("Components", (target) => {
			let shared = sharedRegistrations.get(target.module);
			const isFirst = shared === undefined;
			if (shared === undefined) {
				shared = { active: [], skipped: new Map(), leftOut: [] };
				sharedRegistrations.set(target.module, shared);
			}

			for (const registration of leftOut) {
				if (!shared.leftOut.includes(registration)) {
					shared.leftOut.push(registration);
				}
			}

			// Judged per ignition, against the module's condition as well as each class's own, so
			// that a component is scoped the way a provider is. A class that several plugins register
			// is kept once, when any registration of it holds.
			const { active, skipped, leftOut: sharedLeftOut } = shared;
			for (const component of registered) {
				const conditions = [registrationScopes.get(component) ?? NO_CONDITION, getComponentScope(component)];
				const identifier = Reflect.getOwnMetadata<string>(component, "identifier");
				assert(identifier !== undefined, `class '${component}' has no identifier`);

				if (target.isActive(...conditions)) {
					if (!active.includes(component)) {
						active.push(component);
					}

					skipped.delete(identifier);
				} else if (!active.includes(component) && !skipped.has(identifier)) {
					skipped.set(identifier, describeConditions([target.scope ?? NO_CONDITION, ...conditions]));
				}
			}

			if (!isFirst) {
				return;
			}

			// Built once every plugin has been set up, so that it holds what all of them registered,
			// and before any provider is constructed, which is when one can first be injected with it.
			let components: Components | undefined;
			target.onPreIgnite(
				(module) => {
					sharedRegistrations.delete(module);
					components = new Components(module, { components: active, skipped, leftOut: sharedLeftOut });
					target.provideInstance(components);
				},
				{ priority: HookPriority.First },
			);

			// Tags are only watched once the module has ignited, so that every provider a component
			// might inject exists by the time one is constructed. At `onIgnited`, after the lifecycle
			// plugin has started the providers there, so that the components built during ignition
			// still start after every provider has.
			target.onIgnited(() => components?.startCollectionService());

			// Nothing to stop when the ignition failed before it was built.
			target.onExtinguished(() => components?.stopCollectionService());
		});
	}
}
