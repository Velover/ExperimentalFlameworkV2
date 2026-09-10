import { RunService } from "@rbxts/services";
import { getRuntimeConfig } from "../utility/runtimeConfig";
import type { Module } from "../module/module";
import { Provider } from "../provider";
import type { OnExtinguished, OnInit, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycleInterfaces";
import { recycleThread } from "../utility/recycleThread";
import { Reflect } from "../reflect";
import { PluginDefinition, type InterfaceConfiguration, type InterfaceContext } from "../plugin/pluginDefinition";

export interface LifecyclePluginOptions {
	/**
	 * Whether per-frame lifecycle callbacks are wrapped in `debug.profilebegin` and
	 * `debug.setmemorycategory` with the provider's identifier, so that they show up by name in the
	 * MicroProfiler and the memory view.
	 *
	 * Defaults to `RunService.IsStudio()`, which is what v1's `flamework.json` defaulted to as well.
	 */
	profiling?: boolean;
}

/**
 * Tracks the objects attached to each lifecycle event for one module.
 *
 * The plugin builds one per ignition of every module that includes it, so nothing here is shared
 * between modules, and provides it, so `module.resolveDependency<LifecycleProvider>()` answers what
 * is attached to a module's events right now.
 */
@Provider()
export class LifecycleProvider {
	/** In attachment order, which for providers is dependency order. */
	private onInit = new Array<OnInit>();
	private initMembers = new Set<OnInit>();

	public onStart = new Set<OnStart>();
	public onTick = new Set<OnTick>();
	public onPhysics = new Set<OnPhysics>();
	public onRender = new Set<OnRender>();
	public onExtinguished = new Set<OnExtinguished>();

	private identifiers = new Map<object, string>();
	private moduleConnections = new Map<Module, RBXScriptConnection[]>();
	private lateProviders = new Set<object>();
	private hasStarted = false;
	private isProfiling: boolean;

	constructor(options: LifecyclePluginOptions) {
		// Per-module option, then the project's flamework.config.json, then Studio.
		this.isProfiling = options.profiling ?? getRuntimeConfig().core?.profiling ?? RunService.IsStudio();
	}

	private getIdentifier(object: object) {
		let identifier = this.identifiers.get(object);
		if (identifier === undefined) {
			identifier = Reflect.getMetadata<string>(object, "identifier") ?? "[flamework listener]";
			this.identifiers.set(object, identifier);
		}

		return identifier;
	}

	/**
	 * Drops the memoised identifier of an object that has left its last lifecycle event.
	 *
	 * The memo is keyed by the object itself, so an entry left behind is a strong reference to it:
	 * a removed component, and with it its instance, its attributes and everything it links to,
	 * held for as long as the module lives. `profile` fills it in for every object it runs a
	 * per-frame callback for, so the table grew by one for every component that ever ticked
	 * whenever profiling was on -- which it is in Studio by default, and in production for anyone
	 * who sets `core.profiling`.
	 *
	 * The entry stays while any event still holds the object: dropping it there would only make the
	 * next frame look it up again.
	 */
	private forget(object: object) {
		const attached =
			this.initMembers.has(object as OnInit) ||
			this.onStart.has(object as OnStart) ||
			this.onTick.has(object as OnTick) ||
			this.onPhysics.has(object as OnPhysics) ||
			this.onRender.has(object as OnRender) ||
			this.onExtinguished.has(object as OnExtinguished);

		if (!attached) {
			this.identifiers.delete(object);
		}
	}

	/**
	 * Detaches an object from one of the plain event sets, forgetting it once nothing holds it.
	 *
	 * @internal
	 */
	public removeFrom<T>(set: Set<T>, value: T) {
		set.delete(value);
		this.forget(value as object);
	}

	private profile(callback: () => void, object: object) {
		if (this.isProfiling) {
			const id = this.getIdentifier(object);

			return recycleThread(() => {
				// `profilebegin` ends when the thread yields or dies.
				debug.profilebegin(id);
				debug.setmemorycategory(id);
				callback();
				debug.resetmemorycategory();
			});
		}

		return recycleThread(callback);
	}

	/**
	 * Runs `onInit` synchronously, waiting on a returned Promise, so that initialisation happens in
	 * dependency order and is complete before anything starts.
	 */
	private runInit(object: OnInit) {
		const id = this.getIdentifier(object);
		if (this.isProfiling) {
			debug.setmemorycategory(id);
		}

		const result = object.onInit();
		if (Promise.is(result)) {
			const [status, value] = result.awaitStatus();
			if (status === Promise.Status.Rejected) {
				error(`onInit failed for '${id}': ${tostring(value)}`, 0);
			}
		}

		if (this.isProfiling) {
			debug.resetmemorycategory();
		}
	}

	private runStart(object: OnStart) {
		task.spawn(() => object.onStart());
	}

	/**
	 * A provider constructed after ignition (a lazy one) still gets `onInit` and `onStart`, in that
	 * order, once every one of its interfaces has been attached. Instances attached late through
	 * `listen` or `createClassInstance` do not; they are owned by whoever created them.
	 */
	private scheduleLateProvider(object: object) {
		if (this.lateProviders.has(object)) {
			return;
		}

		this.lateProviders.add(object);

		task.defer(() => {
			if (!this.lateProviders.has(object)) {
				return;
			}

			this.lateProviders.delete(object);

			if (this.initMembers.has(object as OnInit)) {
				this.runInit(object as OnInit);
			}

			if (this.onStart.has(object as OnStart)) {
				this.runStart(object as OnStart);
			}
		});
	}

	public addInit(object: OnInit, context: InterfaceContext) {
		this.initMembers.add(object);

		if (!this.hasStarted) {
			this.onInit.push(object);
		} else if (context.kind === "provider") {
			this.scheduleLateProvider(object);
		}
	}

	public removeInit(object: OnInit) {
		this.initMembers.delete(object);
		this.lateProviders.delete(object);

		const index = this.onInit.indexOf(object);
		if (index !== -1) {
			this.onInit.remove(index);
		}

		this.forget(object);
	}

	public addStart(object: OnStart, context: InterfaceContext) {
		this.onStart.add(object);

		if (this.hasStarted && context.kind === "provider") {
			this.scheduleLateProvider(object);
		}
	}

	public removeStart(object: OnStart) {
		this.onStart.delete(object);
		this.lateProviders.delete(object);
		this.forget(object);
	}

	public postIgnite(module: Module) {
		// Copied: an `onInit` may resolve a lazy provider, which attaches while we iterate.
		for (const object of [...this.onInit]) {
			this.runInit(object);
		}

		this.hasStarted = true;

		for (const object of [...this.onStart]) {
			this.runStart(object);
		}

		const onTick = this.onTick;
		const onPhysics = this.onPhysics;
		const onRender = this.onRender;
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
				const now = time();
				for (const provider of onPhysics) {
					this.profile(() => provider.onPhysics(dt, now), provider);
				}
			}),
		);

		// PreRender never fires on the server, so there is nothing to connect there.
		if (RunService.IsClient()) {
			connections.push(
				RunService.PreRender.Connect((dt) => {
					for (const provider of onRender) {
						this.profile(() => provider.onRender(dt), provider);
					}
				}),
			);
		}

		this.moduleConnections.set(module, connections);
	}

	public extinguished(module: Module) {
		const connections = this.moduleConnections.get(module);
		if (connections) {
			this.moduleConnections.delete(module);

			for (const connection of connections) {
				connection.Disconnect();
			}
		}

		// One failing handler must not leave the module stuck half-extinguished.
		for (const provider of [...this.onExtinguished]) {
			const [success, err] = pcall(() => provider.onExtinguished());
			if (!success) {
				warn(`[Flamework] onExtinguished failed for '${this.getIdentifier(provider)}': ${tostring(err)}`);
			}
		}
	}
}

/** An observer that keeps one of the provider's plain event sets in step with the module. */
function observeSet<T>(provider: LifecycleProvider, set: Set<T>): InterfaceConfiguration<T> {
	return {
		onAdded: (value) => set.add(value),
		onRemoved: (value) => provider.removeFrom(set, value),
	};
}

/**
 * Creates a lifecycle plugin with the specified options.
 *
 * `LifecyclePlugin` is `createLifecyclePlugin()` with the defaults; use this when a module needs
 * different ones, such as forcing profiling on or off.
 */
export function createLifecyclePlugin(options: LifecyclePluginOptions = {}): PluginDefinition {
	return new PluginDefinition("Lifecycle", (target) => {
		// One per ignition: the setup runs for every module that includes the plugin, and again for
		// every ignition of a definition, so nothing here is shared between modules.
		const lifecycle = new LifecycleProvider(options);
		target.provideInstance(lifecycle);

		target.onPostIgnite((module) => lifecycle.postIgnite(module));
		target.onExtinguished((module) => lifecycle.extinguished(module));

		target.observe<OnInit>({
			onAdded: (value, context) => lifecycle.addInit(value, context),
			onRemoved: (value) => lifecycle.removeInit(value),
		});
		target.observe<OnStart>({
			onAdded: (value, context) => lifecycle.addStart(value, context),
			onRemoved: (value) => lifecycle.removeStart(value),
		});
		target.observe<OnTick>(observeSet(lifecycle, lifecycle.onTick));
		target.observe<OnRender>(observeSet(lifecycle, lifecycle.onRender));
		target.observe<OnPhysics>(observeSet(lifecycle, lifecycle.onPhysics));
		target.observe<OnExtinguished>(observeSet(lifecycle, lifecycle.onExtinguished));
	});
}

/**
 * The lifecycle plugin with default options. Include it in every module whose providers, class
 * instances or components should receive lifecycle events.
 */
export const LifecyclePlugin = createLifecyclePlugin();
