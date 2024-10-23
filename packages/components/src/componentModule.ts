import { Flamework, Reflect, Modding, LifecyclePlugin } from "@flamework/core";
import { getClassesInPath } from "@flamework/core/out/utility/getClassesInPath";
import type { Constructor } from "./utility";
import { Components } from "./components";
import { BaseComponent } from "./baseComponent";
import { HookType } from "@flamework/core/out/module/moduleHooks";

export interface ComponentModuleConfig {
	components: Constructor[];
}

export class ComponentPlugin {
	public static createPlugin() {
		return new ComponentPlugin();
	}

	private config: ComponentModuleConfig = {
		components: [],
	};

	private constructor() {}

	public registerComponent(component: Constructor<BaseComponent>) {
		this.config.components.push(component);

		return this;
	}

	/** @metadata macro */
	public registerComponents<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[][]>) {
		assert(path !== undefined);

		const components = getClassesInPath(path[0]).filter((v) => Reflect.hasMetadata(v, "flamework:component"));
		for (const component of components) {
			this.config.components.push(component as Constructor<BaseComponent>);
		}

		return this;
	}

	public build() {
		const pluginModule = Flamework.createModule()
			.includePlugin(LifecyclePlugin)
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
			.build();
	}
}
