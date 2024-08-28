import { RunService } from "@rbxts/services";
import { ModuleBuilder } from "../module/moduleBuilder";
import type { Module } from "../module/module";
import { HookType } from "../module/moduleHooks";
import { Provider } from "../provider";
import type { OnExtinguished, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycleInterfaces";
import type { Modding } from "../modding";
import { recycleThread } from "../utility/recycleThread";
import { Reflect } from "../reflect";

@Provider()
class LifecycleProvider {
	private moduleConnections = new Map<Module, RBXScriptConnection[]>();
	private isProfiling = RunService.IsStudio();

	private profile(callback: () => void, object: object) {
		if (this.isProfiling) {
			const id = Reflect.getMetadata<string>(object, "identifier") ?? "[flamework provider]";

			return recycleThread(() => {
				debug.profilebegin(id);
				debug.setmemorycategory(id);
				callback();
				debug.resetmemorycategory();
			});
		}

		return recycleThread(callback);
	}

	/** @metadata macro */
	private getLifecycleSet<T>(module: Module, id?: Modding.Generic<T, "id">) {
		const set = new Set<T>();

		for (const item of module.getInterfaces(id)) {
			set.add(item);
		}

		module.getInterfaceAdded((item) => set.add(item), id);
		module.getInterfaceRemoved((item) => set.delete(item), id);

		return set;
	}

	public postIgnite(module: Module) {
		// TODO: this needs to support adding/removing instances
		const onStart = module.getInterfaces<OnStart>();
		const onTick = this.getLifecycleSet<OnTick>(module);
		const onPhysics = this.getLifecycleSet<OnPhysics>(module);
		const onRender = this.getLifecycleSet<OnRender>(module);

		for (const provider of onStart) {
			task.spawn(() => provider.onStart());
		}

		const connections = new Array<RBXScriptConnection>();

		connections.push(
			RunService.PostSimulation.Connect((dt) => {
				for (const provider of onTick) {
					this.profile(() => provider.onTick(dt), provider);
				}
			}),
		);

		connections.push(
			RunService.PreSimulation.Connect((dt) => {
				for (const provider of onPhysics) {
					this.profile(() => provider.onPhysics(dt), provider);
				}
			}),
		);

		connections.push(
			RunService.PreRender.Connect((dt) => {
				for (const provider of onRender) {
					this.profile(() => provider.onRender(dt), provider);
				}
			}),
		);

		this.moduleConnections.set(module, connections);
	}

	public extinguished(module: Module) {
		const connections = this.moduleConnections.get(module);
		if (connections) {
			for (const connection of connections) {
				connection.Disconnect();
			}
		}

		for (const provider of module.getInterfaces<OnExtinguished>()) {
			provider.onExtinguished();
		}
	}
}

export const LifecycleModule = new ModuleBuilder()
	// Hooks
	.registerHook({
		type: HookType.PostIgnite,
		callback: (context) => {
			const lifecycleProvider = context.sourceModule.resolveDependency<LifecycleProvider>();
			lifecycleProvider.postIgnite(context.targetModule);
		},
	})
	.registerHook({
		type: HookType.Extinguished,
		callback: (context) => {
			const lifecycleProvider = context.sourceModule.resolveDependency<LifecycleProvider>();
			lifecycleProvider.extinguished(context.targetModule);
		},
	})
	.exportHooks()

	// Providers
	.registerClassProvider(LifecycleProvider)

	// Lifecycle events
	.registerInterfaces<OnStart | OnTick | OnPhysics | OnRender | OnExtinguished>()
	.exportInterfaces<OnStart | OnTick | OnPhysics | OnRender | OnExtinguished>()
	.build();
