import { RunService } from "@rbxts/services";
import { getRuntimeConfig } from "../utility/runtimeConfig";
import type { Module } from "../module/module";
import { Provider } from "../provider";
import type { OnExtinguished, OnInit, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycleInterfaces";
import { recycleThread } from "../utility/recycleThread";
import { threadWaits } from "../utility/threadWaits";
import { Reflect } from "../reflect";
import {
	LIFECYCLE_SLOT,
	PluginDefinition,
	type InterfaceConfiguration,
	type InterfaceContext,
	type PluginTarget,
} from "../plugin/pluginDefinition";

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

	/** The providers `postIgnite` starts, in attachment order; `onStart` is every member. */
	private startOrder = new Array<OnStart>();
	public onStart = new Set<OnStart>();
	public onTick = new Set<OnTick>();
	public onPhysics = new Set<OnPhysics>();
	public onRender = new Set<OnRender>();
	public onExtinguished = new Set<OnExtinguished>();

	private identifiers = new Map<object, string>();
	private moduleConnections = new Map<Module, RBXScriptConnection[]>();
	private lateProviders = new Set<object>();
	/** Late providers waiting for their turn, in the order they were resolved. */
	private lateQueue = new Array<object>();
	/** Whether a turn is deferred, or running, that takes whatever joins `lateQueue`. */
	private hasLateTurn = false;
	/** Late providers whose turn came while the module was still igniting, for `start` to schedule again. */
	private heldLateProviders = new Array<object>();

	/**
	 * What joined `onExtinguished` once `extinguished` had begun -- a lazy provider resolved for the
	 * first time by a handler, or by an extinguished hook after this one -- and has not been told
	 * yet. Nothing else can join then: `listen` and `createClassInstance` refuse a module that is
	 * extinguishing.
	 */
	private untold = new Set<OnExtinguished>();
	/** Set as `extinguished` begins its walk, for `untold`; not whether the module has begun to extinguish. */
	private isExtinguishing = false;
	private hasStarted = false;
	private module?: Module;
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
		const result = this.callInit(object, id);
		if (Promise.is(result)) {
			// Recorded as a wait on the Promise, as `callInit` records one on its thread: an `async`
			// `onInit` runs its body on a thread of its own, so one that extinguished an import of a
			// module this thread was extinguishing waited for this thread, which waited here for its
			// Promise, for good. Removed as the Promise settles, since a cancelled caller never resumes.
			if (result.getStatus() === Promise.Status.Started) {
				const caller = coroutine.running();
				threadWaits.set(caller, result);
				result
					.finally(() => {
						threadWaits.delete(caller);
					})
					.catch(() => {});
			}

			const [status, value] = result.awaitStatus();
			if (status === Promise.Status.Rejected) {
				error(`onInit failed for '${id}': ${tostring(value)}`, 0);
			}
		}
	}

	/**
	 * Calls `onInit` on a thread of its own, waiting for it if it yields, and hands back what it
	 * returned or raises what it raised.
	 *
	 * Its own so that the memory category profiling files it under stays on it: a category belongs
	 * to the thread it is set on and cannot be read back to be restored, so one set on the caller's
	 * -- the thread that called `ignite()` -- outlived the call. An `onInit` that raised left the
	 * provider's category there, and one that returned reset the caller's own to the default. The
	 * same thread whether profiling or not, so that Studio and a live server run `onInit` alike.
	 */
	private callInit(object: OnInit, id: string) {
		const caller = coroutine.running();
		let outcome = undefined as [boolean, unknown] | undefined;
		let waiting = false;

		const initThread = coroutine.create(() => {
			if (this.isProfiling) {
				debug.setmemorycategory(id);
			}

			const [success, value] = pcall(() => object.onInit());
			outcome = [success, value];

			// Removed here rather than by the caller once it resumes: a caller cancelled meanwhile --
			// the testing runner cancels a body that overran -- never does, and left its entry behind.
			threadWaits.delete(caller);
			if (waiting) {
				task.spawn(caller);
			}
		});

		// Recorded as a wait, from before it starts, so that an extinguish can tell the caller waits
		// on it: an `onInit` that extinguished an import of a module the caller was extinguishing --
		// an ignition started from that module's `onExtinguished` -- waited for the caller, which
		// waited here, for good. On the caller's own thread, it would have gone straight through.
		threadWaits.set(caller, initThread);
		task.spawn(initThread);

		if (outcome === undefined) {
			waiting = true;
			coroutine.yield();
		}

		const [success, value] = outcome!;
		if (!success) {
			error(value, 0);
		}

		return value;
	}

	/**
	 * Whether the module has begun to extinguish: from the first line of `extinguish()`. Not from
	 * this plugin's `extinguished` hook, which runs after the importers have gone down and the hooks
	 * ahead of it have run -- any of which may yield, and let a late provider start, the providers
	 * start or the frame loops tick against a module that is on its way out.
	 */
	private hasBegunExtinguishing() {
		return this.isExtinguishing || this.module?.isExtinguished() === true;
	}

	private runStart(object: OnStart) {
		task.spawn(() => object.onStart());
	}

	/**
	 * A provider constructed after ignition (a lazy one) still gets `onInit` and `onStart`, in that
	 * order, once every one of its interfaces has been attached. Instances attached late through
	 * `listen` or `createClassInstance` do not; they are owned by whoever created them.
	 *
	 * Until its `onInit` has finished it stays in `lateProviders`, which keeps it out of the
	 * per-frame events, as an eager provider is kept out of them until every `onInit` has run: it
	 * is attached to them at once, and used to tick before it was initialised.
	 */
	private scheduleLateProvider(object: object) {
		if (this.lateProviders.has(object)) {
			return;
		}

		this.lateProviders.add(object);
		this.deferLateProvider(object);
	}

	/**
	 * Queues a late provider for the next turn, which one deferred thread takes for everything queued
	 * by then, the way `postIgnite` and `start` take the eager providers: every `onInit` in the order
	 * the providers were resolved -- a dependency, constructed as a constructor parameter, before
	 * what needs it -- each finished before the next begins, then every `onStart`. A thread per
	 * provider ran the next one's `onInit` as soon as the one before yielded, and started it before
	 * its dependency had finished initialising.
	 */
	private deferLateProvider(object: object) {
		this.lateQueue.push(object);
		if (this.hasLateTurn) {
			return;
		}

		this.hasLateTurn = true;
		task.defer(() => this.runLateProviders());
	}

	private runLateProviders() {
		const initialised = new Array<object>();

		// Walked live, as `postIgnite` walks: an `onInit` may resolve another lazy provider, which
		// joins the end of the queue and is initialised in its turn.
		while (!this.lateQueue.isEmpty()) {
			// Nothing once the module has begun to extinguish: by then it may have been told
			// `onExtinguished` -- one an `onExtinguished` handler resolved for the first time is --
			// and a later step that yields let this run after it, and before `release` detached it.
			// Nor once an `onInit` that yielded saw it begin.
			if (this.hasBegunExtinguishing()) {
				this.lateQueue.clear();
				break;
			}

			// Nor while the module is still igniting -- one a postIgnite hook after this plugin's
			// resolved, whose turn came when a hook yielded: it was started before the module was
			// ignited, even by an ignition that then failed. `start` gives them their turn again.
			if (this.module?.isIgnited() !== true) {
				for (const object of this.lateQueue) {
					this.heldLateProviders.push(object);
				}

				this.lateQueue.clear();
				break;
			}

			const object = this.lateQueue.shift()!;
			if (!this.lateProviders.has(object)) {
				continue;
			}

			if (this.initMembers.has(object as OnInit)) {
				// One that raises is reported and left out -- never ticking, never started, as on a
				// thread of its own -- and does not hold back the ones after it.
				const [success, err] = pcall(() => this.runInit(object as OnInit));
				if (!success) {
					task.spawn(error, err, 0);
					continue;
				}
			}

			this.lateProviders.delete(object);
			initialised.push(object);
		}

		// Over from here: one an `onStart` resolves gets a turn of its own.
		this.hasLateTurn = false;

		for (const object of initialised) {
			if (this.hasBegunExtinguishing()) {
				return;
			}

			if (this.onStart.has(object as OnStart)) {
				this.runStart(object as OnStart);
			}
		}
	}

	public addInit(object: OnInit, context: InterfaceContext) {
		this.initMembers.add(object);

		// Only a provider is initialised by the plugin. An instance attached through `listen` or
		// `createClassInstance` is owned by whoever created it -- `Components` runs a component's
		// `onInit` itself, before the component can be seen -- so one built during ignition must not
		// be initialised a second time here.
		if (context.kind !== "provider") return;

		if (!this.hasStarted) {
			this.onInit.push(object);
		} else {
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

		// Only a provider is started by the plugin, as with `onInit`: an instance attached through
		// `listen` or `createClassInstance` is owned by whoever created it. `Components` starts a
		// component itself, once the component is attached and ignition has finished.
		if (context.kind !== "provider") return;

		if (!this.hasStarted) {
			this.startOrder.push(object);
		} else {
			this.scheduleLateProvider(object);
		}
	}

	public removeStart(object: OnStart) {
		this.onStart.delete(object);
		this.lateProviders.delete(object);

		const index = this.startOrder.indexOf(object);
		if (index !== -1) {
			this.startOrder.remove(index);
		}

		this.forget(object);
	}

	public postIgnite(module: Module) {
		this.module = module;

		// Walked live rather than over a copy: an `onInit` may resolve a lazy provider, which joins
		// the end of the list while we iterate and is initialised in its turn -- over a copy it was
		// skipped, and then started with the rest, never initialised. Nothing leaves the list
		// during ignition, so the index stays true. A `while`, since a `for` compiles to a numeric
		// loop that reads the length once.
		let index = 0;
		while (index < this.onInit.size()) {
			this.runInit(this.onInit[index]);
			index += 1;
		}

		this.hasStarted = true;
	}

	/**
	 * Starts the providers, then connects the per-frame events, once ignition has completed.
	 *
	 * Not at `postIgnite`, where `onStart` ran while the module was still igniting: `isIgnited()`
	 * answered false, `extinguish()` raised, a module importing this one could not ignite, the
	 * hooks of plugins after this one had not run, and ignition could still fail -- an import
	 * extinguished while an `onInit` yielded had the providers started against it first.
	 */
	public start(module: Module) {
		// An `onStart` may extinguish the module; nothing starts or ticks after that.
		for (const object of [...this.startOrder]) {
			if (this.hasBegunExtinguishing()) {
				return;
			}

			this.runStart(object);
		}

		if (this.hasBegunExtinguishing()) {
			return;
		}

		for (const object of this.heldLateProviders) {
			this.deferLateProvider(object);
		}

		this.heldLateProviders.clear();

		const onTick = this.onTick;
		const onPhysics = this.onPhysics;
		const onRender = this.onRender;
		const lateProviders = this.lateProviders;
		const connections = new Array<RBXScriptConnection>();

		// Each frame walks a copy of its set: a callback runs synchronously and may attach an object
		// -- `createClassInstance`, `listen`, a lazy provider resolved -- and a key added to a table
		// while it is walked can make the walk visit others twice or not at all once the table
		// grows. One attached during the frame gets its first call on the next; one detached before
		// its turn, or a late provider still waiting on its `onInit`, is passed over.
		//
		// And the walk stops once the module has begun to extinguish: a callback that extinguishes
		// it returns here as soon as a later step of the extinguish yields, and by then everything
		// has been told `onExtinguished` while still in the sets, which only `release` empties.

		// Heartbeat rather than PostSimulation: the same point of the frame in a running game, but
		// Heartbeat also fires where no simulation runs (an edit-mode plugin, an Open Cloud Luau
		// task), so onTick works there too. PreSimulation has no such alias; onPhysics stays silent.
		connections.push(
			RunService.Heartbeat.Connect((dt) => {
				for (const provider of [...onTick]) {
					if (this.hasBegunExtinguishing()) break;
					if (onTick.has(provider) && !lateProviders.has(provider)) {
						this.profile(() => provider.onTick(dt), provider);
					}
				}
			}),
		);

		connections.push(
			RunService.PreSimulation.Connect((dt) => {
				const now = time();
				for (const provider of [...onPhysics]) {
					if (this.hasBegunExtinguishing()) break;
					if (onPhysics.has(provider) && !lateProviders.has(provider)) {
						this.profile(() => provider.onPhysics(dt, now), provider);
					}
				}
			}),
		);

		// PreRender never fires on the server, so there is nothing to connect there.
		if (RunService.IsClient()) {
			connections.push(
				RunService.PreRender.Connect((dt) => {
					for (const provider of [...onRender]) {
						if (this.hasBegunExtinguishing()) break;
						if (onRender.has(provider) && !lateProviders.has(provider)) {
							this.profile(() => provider.onRender(dt), provider);
						}
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

		// Over a copy, since a handler may detach objects; one detached by a handler before it --
		// `removeClassInstance` from an `onExtinguished` -- has left the event, so it is not told.
		// One failing handler must not leave the module stuck half-extinguished.
		this.isExtinguishing = true;
		for (const provider of [...this.onExtinguished]) {
			if (!this.onExtinguished.has(provider)) {
				continue;
			}

			this.tellExtinguished(provider);
		}

		// What the handlers attached is not in the copy: a lazy provider they resolved for the first
		// time. It is told in its turn, as it would have been released without it.
		while (!this.untold.isEmpty()) {
			const [provider] = [...this.untold];
			this.untold.delete(provider);
			this.tellExtinguished(provider);
		}
	}

	private tellExtinguished(provider: OnExtinguished) {
		const [success, err] = pcall(() => provider.onExtinguished());
		if (!success) {
			warn(`[Flamework] onExtinguished failed for '${this.getIdentifier(provider)}': ${tostring(err)}`);
		}
	}

	/** @internal */
	public addExtinguished(object: OnExtinguished) {
		this.onExtinguished.add(object);

		if (this.isExtinguishing) {
			this.untold.add(object);
		}
	}

	/**
	 * One attached after the walk in `extinguished` finished -- by an extinguished hook that runs
	 * after this plugin's -- is told when the module releases it, which is the last it hears.
	 *
	 * One an observer refused is not: the module undoing its attachment is not releasing it, since
	 * it never joined, and a refused object hears nothing.
	 *
	 * @internal
	 */
	public removeExtinguished(object: OnExtinguished, refused = false) {
		if (this.untold.has(object)) {
			this.untold.delete(object);
			if (!refused) {
				this.tellExtinguished(object);
			}
		}

		this.removeFrom(this.onExtinguished, object);
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
	const setup = (target: PluginTarget) => {
		// One per ignition: the setup runs for every module that includes the plugin, and again for
		// every ignition of a definition, so nothing here is shared between modules.
		const lifecycle = new LifecycleProvider(options);
		target.provideInstance(lifecycle);

		target.onPostIgnite((module) => lifecycle.postIgnite(module));
		target.onIgnited((module) => lifecycle.start(module));
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
		target.observe<OnExtinguished>({
			onAdded: (value) => lifecycle.addExtinguished(value),
			onRemoved: (value, context) => lifecycle.removeExtinguished(value, context.refused === true),
		});
	};

	return new PluginDefinition("Lifecycle", setup, LIFECYCLE_SLOT);
}

/**
 * The lifecycle plugin with default options. Every module made with `Flamework.createModule()`
 * starts with it; `disableDefaultLifecycle()` on the builder leaves it out, and including one built
 * with {@link createLifecyclePlugin} takes its place.
 */
export const LifecyclePlugin = createLifecyclePlugin();
