import { Flamework, Reflect, Modding, LifecycleModule } from "@flamework/core";
import { getClassesInPath } from "@flamework/core/out/utility/getClassesInPath";
import type { Constructor } from "./utility";
import { Components } from "./components";
import { BaseComponent } from "./baseComponent";
import { HookType } from "@flamework/core/out/module/moduleHooks";

export interface ComponentModuleConfig {
	components: Constructor[];
}

export class ComponentModule {
	public static createModule() {
		return new ComponentModule();
	}

	private module = Flamework.createModule();
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
		return this.module
			.transient()
			.includeModule(LifecycleModule)
			.registerProvider<ComponentModuleConfig>({ type: "function", callback: () => this.config })
			.registerClassProvider(Components)
			.registerHook({
				type: HookType.PostIgnite,
				callback: (context) => {
					if (context.sourceModule !== context.targetModule) {
						context.sourceModule.resolveDependency<Components>().parentPostIgnite(context.targetModule);
					}
				},
			})
			.exportHooks()
			.exportProviders<Components>()
			.build();
	}
}
