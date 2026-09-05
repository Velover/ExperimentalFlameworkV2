import { Flamework, Reflect, Modding, getClassesInGlob, getClassesInPath, HookType } from "@flamework/core";
import type { Constructor } from "./utility";
import { Components } from "./components";
import { BaseComponent } from "./baseComponent";

export interface ComponentModuleConfig {
	components: Constructor[];
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
	public static fromPath<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[]>) {
		return this.createPlugin().registerComponents(_stringPath, path).build();
	}

	/**
	 * This is a shorthand for creating a default components plugin from a compile-time glob.
	 *
	 * @metadata macro
	 */
	public static fromGlob<T extends string>(_glob: T, glob?: Modding.Intrinsic<"pathglob", [T], string>) {
		return this.createPlugin().registerComponentsGlob(_glob, glob).build();
	}

	private config: ComponentModuleConfig = {
		components: [],
	};

	private constructor() {}

	/**
	 * Registers a single component class.
	 *
	 * The class must carry the `@Component()` decorator itself; an undecorated subclass of a
	 * component inherits its parent's identifier and would otherwise be registered as the parent.
	 */
	public registerComponent(component: Constructor<BaseComponent>) {
		if (!Reflect.hasOwnMetadata(component, "flamework:component")) {
			error(
				Reflect.hasMetadata(component, "flamework:component")
					? `class '${component}' is missing the @Component() decorator: it inherits one from a parent class, but every component must be decorated itself`
					: `class '${component}' is missing the @Component() decorator`,
			);
		}

		if (!this.config.components.includes(component)) {
			this.config.components.push(component);
		}

		return this;
	}

	/**
	 * Registers every exported `@Component()` class under the specified path and its descendants.
	 *
	 * @metadata macro
	 */
	public registerComponents<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[]>) {
		assert(path !== undefined);

		return this.registerComponentClasses(getClassesInPath(path));
	}

	/**
	 * Registers every exported `@Component()` class under every path matched by the specified glob,
	 * which is resolved at compile time.
	 *
	 * @metadata macro
	 */
	public registerComponentsGlob<T extends string>(_glob: T, glob?: Modding.Intrinsic<"pathglob", [T], string>) {
		assert(glob !== undefined);

		return this.registerComponentClasses(getClassesInGlob(glob));
	}

	private registerComponentClasses(classes: object[]) {
		for (const component of classes) {
			// Own metadata only, so an undecorated subclass of a component is skipped rather than
			// registered under its parent's identifier.
			if (Reflect.hasOwnMetadata(component, "flamework:component")) {
				this.registerComponent(component as Constructor<BaseComponent>);
			}
		}

		return this;
	}

	public build() {
		// Components are constructed through the module this plugin is included in (see
		// `Components.module`), so they take their lifecycle events from that module's plugins.
		// Including the lifecycle plugin here would only tick an empty set.
		const pluginModule = Flamework.createModule()
			.setDebugName("ComponentPlugin")
			.registerProvider<ComponentModuleConfig>({ type: "function", callback: () => this.config })
			.registerClassProvider(Components)
			.exportProviders<Components>()
			.build();

		return Flamework.createPlugin(pluginModule)
			.registerHook({
				type: HookType.PostIgnite,
				callback: (context) => {
					// Wait until the parent module has ignited.
					context.sourceModule.resolveDependency<Components>().startCollectionService();
				},
			})
			.registerHook({
				type: HookType.Extinguished,
				callback: (context) => {
					context.sourceModule.resolveDependency<Components>().stopCollectionService();
				},
			})
			.build();
	}
}
