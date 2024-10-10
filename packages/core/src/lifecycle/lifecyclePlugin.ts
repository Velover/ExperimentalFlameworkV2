import { RunService } from "@rbxts/services";
import { ModuleBuilder } from "../module/moduleBuilder";
import type { Module } from "../module/module";
import { HookType } from "../module/moduleHooks";
import { Provider } from "../provider";
import type { OnExtinguished, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycleInterfaces";
import { recycleThread } from "../utility/recycleThread";
import { Reflect } from "../reflect";
import { PluginBuilder } from "../plugin/pluginBuilder";
import type { InterfaceConfiguration } from "../plugin/pluginDefinition";

@Provider()
class LifecycleProvider {
	public onStart = new Set<OnStart>();
	public onTick = new Set<OnTick>();
	public onPhysics = new Set<OnPhysics>();
	public onRender = new Set<OnRender>();
	public onExtinguished = new Set<OnExtinguished>();

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

	public postIgnite(module: Module) {
		const onStart = this.onStart;
		const onTick = this.onTick;
		const onPhysics = this.onPhysics;
		const onRender = this.onRender;

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

		for (const provider of this.onExtinguished) {
			provider.onExtinguished();
		}
	}
}

function createLifecycleSet<T>(get: (provider: LifecycleProvider) => Set<T>): InterfaceConfiguration<T> {
	return {
		onAdded: (ctx, value) => get(ctx.sourceModule.resolveDependency<LifecycleProvider>()).add(value),
		onRemoved: (ctx, value) => get(ctx.sourceModule.resolveDependency<LifecycleProvider>()).delete(value),
	};
}

const lifecycleModule = new ModuleBuilder().setDebugName(1).registerClassProvider(LifecycleProvider).build();

export const LifecyclePlugin = new PluginBuilder(lifecycleModule)
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

	// Lifecycle events
	.registerInterface(createLifecycleSet((p) => p.onStart))
	.registerInterface(createLifecycleSet((p) => p.onTick))
	.registerInterface(createLifecycleSet((p) => p.onRender))
	.registerInterface(createLifecycleSet((p) => p.onPhysics))
	.registerInterface(createLifecycleSet((p) => p.onExtinguished))
	.build();
