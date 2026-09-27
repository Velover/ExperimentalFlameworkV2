import { RunService } from "@rbxts/services";
import { getRuntimeConfig } from "../utility/runtimeConfig";
import type { Module } from "../module/module";
import { Provider } from "../provider";
import type { OnExtinguished, OnInit, OnPhysics, OnRender, OnStart, OnTick } from "./lifecycleInterfaces";
import { recycleThread } from "../utility/recycleThread";
import { extinguishesBegun, runsPromiseWork, threadWaits } from "../utility/threadWaits";
import { Reflect } from "../reflect";
import { DEFAULT_LOAD_ORDER } from "../module/providerRegistration";
import {
	LIFECYCLE_SLOT,
	PluginDefinition,
	type InterfaceConfiguration,
	type InterfaceContext,
	type PluginTarget,
} from "../plugin/pluginDefinition";

/**
 * Late providers whose `onInit` has yet to finish, or to raise, to the plugin that runs it: what a
 * dependent's waits for. Shared by every module's plugin, since a provider's constructor may take a
 * lazy provider of an import, which the import's plugin initialises.
 */
const pendingInits = new Map<object, LifecycleProvider>();

/**
 * How many seconds a dependency wait that may be on itself (see `mayWaitForRunningThread`) lasts
 * before it is warned about.
 */
const SELF_WAIT_WARNING = 5;

/**
 * A per-frame method read off its object as a plain function, and called with the object as `self`:
 * roblox-ts refuses a reference to a method that does not call it, and calling it through the object
 * took a closure per listener per frame to hand to the thread that runs it.
 */
type FrameCallback = (object: unknown, dt: number, now?: number) => void;

/** The per-frame methods, by name, as `FrameCallback`s. */
type FrameMethods = Record<"onTick" | "onPhysics" | "onRender", FrameCallback | undefined>;

/**
 * Runs a per-frame callback under the MicroProfiler label and the memory category of its object's
 * identifier. A function of its own, handed its arguments, rather than a closure per call.
 */
function runProfiled(id: string, callback: FrameCallback, object: unknown, dt: number, now?: number) {
	// `profilebegin` ends when the thread yields or dies.
	debug.profilebegin(id);
	debug.setmemorycategory(id);
	callback(object, dt, now);
	debug.resetmemorycategory();
}

/**
 * The listeners of one per-frame event, walked in place every frame rather than over a copy.
 *
 * Luau lets a walk clear keys of the table it walks, ones it has yet to reach included -- which it
 * then passes over -- but not add them: a key added while a table is walked can make the walk visit
 * others twice, or not at all, once the table grows. So what is detached leaves `members` at once,
 * and is not called if its turn this frame has yet to come, while what is attached during the
 * event's walk -- by a callback: `createClassInstance`, `listen`, a lazy provider resolved -- waits
 * in `added` and joins once the walk is over, for its first call on the next frame.
 */
class FrameListeners<T extends object> {
	/** Whether the event's walk is running. */
	public walking = false;

	/** What was attached while the walk ran, for `members` once it is over. */
	private added = new Set<T>();

	constructor(public readonly members: Set<T>) {}

	public has(value: T) {
		return this.members.has(value) || this.added.has(value);
	}

	public add(value: T) {
		if (this.walking) {
			this.added.add(value);
		} else {
			this.members.add(value);
		}
	}

	public delete(value: T) {
		this.members.delete(value);
		this.added.delete(value);
	}

	/** Ends a walk: what was attached meanwhile joins. */
	public endWalk() {
		this.walking = false;
		if (this.added.isEmpty()) return;

		for (const value of this.added) {
			this.members.add(value);
		}

		this.added.clear();
	}
}

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

	/** The providers `start` starts, in attachment order; `onStart` is every member. */
	private startOrder = new Array<OnStart>();
	/**
	 * The `loadOrder` of each provider in `startOrder` that has one other than the default, which
	 * `start` orders them by. Empty unless a provider sets one, and emptied once they have started.
	 */
	private startLoadOrders = new Map<OnStart, number>();
	public onStart = new Set<OnStart>();
	public onTick = new Set<OnTick>();
	public onPhysics = new Set<OnPhysics>();
	public onRender = new Set<OnRender>();
	public onExtinguished = new Set<OnExtinguished>();

	private tickListeners = new FrameListeners(this.onTick);
	private physicsListeners = new FrameListeners(this.onPhysics);
	private renderListeners = new FrameListeners(this.onRender);

	private identifiers = new Map<object, string>();
	private moduleConnections = new Map<Module, RBXScriptConnection[]>();
	private lateProviders = new Set<object>();
	/** Late providers resolved since the last turn began, in the order they were resolved: the next turn's. */
	private lateQueue = new Array<object>();
	/** Whether a turn is deferred that takes whatever joins `lateQueue`. */
	private hasLateTurn = false;
	/** The turns still running `onInit`, by their thread, to the providers each walks. */
	private lateTurns = new Map<thread, Array<object>>();
	/** The provider whose `onInit` each turn is running, by the turn's thread. */
	private lateTurnInits = new Map<thread, object>();
	/** Late providers whose turn came while the module was still igniting, for `start` to schedule again. */
	private heldLateProviders = new Array<object>();
	/** What each provider's constructor was given, until its `onInit` has waited for theirs. */
	private initDependencies = new Map<object, ReadonlyArray<defined>>();

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
			this.tickListeners.has(object as OnTick) ||
			this.physicsListeners.has(object as OnPhysics) ||
			this.renderListeners.has(object as OnRender) ||
			this.onExtinguished.has(object as OnExtinguished);

		if (!attached) {
			this.identifiers.delete(object);
			this.lateProviders.delete(object);
			this.initDependencies.delete(object);
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

	/**
	 * Attaches the observers that keep the per-frame events in step with the module.
	 *
	 * @internal
	 */
	public observeFrameEvents(target: PluginTarget) {
		target.observe<OnTick>(this.observeFrameEvent(this.tickListeners));
		target.observe<OnRender>(this.observeFrameEvent(this.renderListeners));
		target.observe<OnPhysics>(this.observeFrameEvent(this.physicsListeners));
	}

	private observeFrameEvent<T extends object>(listeners: FrameListeners<T>): InterfaceConfiguration<T> {
		return {
			onAdded: (value, context) => {
				listeners.add(value);
				if (context.kind === "provider") this.addFrameProvider(value, context);
			},
			onRemoved: (value) => {
				listeners.delete(value);
				this.forget(value);
			},
		};
	}

	/**
	 * A provider on a per-frame event does not tick before the pending `onInit`s of what its
	 * constructor took have finished, as its `onStart` does not start before them: during ignition
	 * the ignition waits for them (see `postIgnite`), and afterwards one without an `onInit` or
	 * `onStart` of its own gets a turn for it, which keeps it out of the per-frame events until then.
	 */
	private addFrameProvider(object: object, context: InterfaceContext) {
		if (this.recordDependencies(object, context) && this.hasStarted) {
			this.scheduleLateProvider(object);
		}
	}

	/**
	 * Calls a per-frame event's method on every listener attached to it, each on a recycled thread.
	 *
	 * Walked in place (see `FrameListeners`): one attached during the walk gets its first call on the
	 * next frame, and one detached before its turn is passed over. A late provider still waiting on
	 * its `onInit` is passed over too, as an eager provider does not tick before every `onInit` has
	 * run; with none, nothing is looked up.
	 *
	 * Nothing once the module has begun to extinguish, and the walk stops when a callback begins it:
	 * that callback returns here as soon as a later step of the extinguish yields, and by then
	 * everything may have been told `onExtinguished` while still in the sets, which only `release`
	 * empties. Checked once before the walk, and then only when an extinguish has begun somewhere
	 * since (`extinguishesBegun`), so that a frame costs no call per listener.
	 *
	 * The callback is read off the listener and called with it as `self`, and its arguments are
	 * handed to the thread rather than closed over, so that a frame creates nothing per listener.
	 */
	private walkFrame<T extends object>(
		listeners: FrameListeners<T>,
		method: keyof FrameMethods,
		dt: number,
		now?: number,
	) {
		if (this.hasBegunExtinguishing()) return;

		const late = this.lateProviders.isEmpty() ? undefined : this.lateProviders;
		const profiling = this.isProfiling;
		let extinguishes = extinguishesBegun.count;

		listeners.walking = true;
		for (const listener of listeners.members) {
			if (late !== undefined && late.has(listener)) continue;

			const callback = (listener as unknown as FrameMethods)[method]!;
			if (profiling) {
				recycleThread(runProfiled, this.getIdentifier(listener), callback, listener, dt, now);
			} else {
				recycleThread(callback, listener, dt, now);
			}

			if (extinguishesBegun.count !== extinguishes) {
				extinguishes = extinguishesBegun.count;
				if (this.hasBegunExtinguishing()) break;
			}
		}

		listeners.endWalk();
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
	 *
	 * One that an `onInit` of a running turn resolves joins that turn, as one an eager `onInit`
	 * resolves joins ignition's. One resolved anywhere else once a turn has begun gets the next turn
	 * and does not wait for that one's `onInit`s: a single turn for everything held it back behind
	 * an `onInit` it had nothing to do with that yielded -- for good, when that `onInit` waited for it.
	 * It waits only for the `onInit`s of what its constructor took, when those are still running in
	 * a turn of their own (see `awaitDependencies`).
	 */
	private deferLateProvider(object: object) {
		const turn = this.findRunningTurn();
		if (turn !== undefined) {
			this.lateTurns.get(turn)!.push(object);
			return;
		}

		this.lateQueue.push(object);
		if (this.hasLateTurn) {
			return;
		}

		this.hasLateTurn = true;
		task.defer(() => this.runLateProviders());
	}

	/**
	 * The thread of the turn whose `onInit` the running thread is part of, if any: the `onInit`'s
	 * own thread, which `callInit` records the turn waiting on; one it resumed and has not got back
	 * from -- a thread it spawned, an `async` body before its first yield, a Promise's executor --
	 * which leaves the turn's thread `normal`; or, while the turn waits on the Promise an `onInit`
	 * returned, a thread doing Promise work (see `runsPromiseWork`): the `async` body once it has
	 * yielded, a deferred executor, an `andThen` callback, whose threads nothing records.
	 */
	private findRunningTurn() {
		const running = coroutine.running();
		let waitingOnPromise: thread | undefined;
		for (const [turn] of this.lateTurns) {
			const waitedOn = threadWaits.get(turn);
			if (waitedOn === running || coroutine.status(turn) === "normal") {
				return turn;
			}

			if (waitedOn !== undefined && !typeIs(waitedOn, "thread")) {
				waitingOnPromise ??= turn;
			}
		}

		if (waitingOnPromise !== undefined && runsPromiseWork(running)) {
			return waitingOnPromise;
		}

		return undefined;
	}

	/**
	 * Whether a late provider's `onInit` can only run once the running thread is done with the turn
	 * it is part of: the turn that initialises the provider is that turn, and is running the provider's
	 * own `onInit` or one ahead of it. An `onInit` of that turn that ignites a module importing this
	 * one, whose eager provider takes the provider -- resolving it for the first time there, which
	 * has it join the turn -- holds up the very `onInit` the eager one would wait for.
	 *
	 * Only where the running thread is known to be part of the turn: the `onInit`'s own thread, or
	 * one it resumed and has not got back from. Not merely because the turn waits on a Promise and
	 * the running thread does Promise work, the guess `findRunningTurn` makes to join a turn: any
	 * Promise's thread passes it, and an ignition started from an unrelated Promise's work -- a
	 * profile load's `andThen`, an `async` handler -- then went ahead of the very `onInit` it takes.
	 * Nor for what that guess joined to the turn from the running thread: a lazy provider the
	 * ignition resolved for the first time while another's `async` `onInit` was loading joined that
	 * turn, and its dependent went ahead of its `onInit`. Where the guess is all there is, the wait
	 * goes on, and warns if it lasts (see `mayWaitForRunningThread`).
	 */
	private initWaitsForRunningThread(object: object) {
		const running = coroutine.running();
		for (const [turn, providers] of this.lateTurns) {
			if (threadWaits.get(turn) === running || coroutine.status(turn) === "normal") {
				return this.lateTurnInits.get(turn) === object || providers.includes(object);
			}
		}

		return false;
	}

	/**
	 * Whether a late provider's `onInit` may be waiting for the running thread after all, where
	 * `initWaitsForRunningThread` cannot tell: the turn that initialises it waits on the Promise an
	 * `onInit` returned, and the running thread does Promise work, which may be that Promise's -- an
	 * `async` `onInit` that ignites, after an `await`, a module taking what its turn initialises.
	 */
	private mayWaitForRunningThread(object: object) {
		for (const [turn, providers] of this.lateTurns) {
			if (this.lateTurnInits.get(turn) !== object && !providers.includes(object)) continue;

			const waitedOn = threadWaits.get(turn);
			return waitedOn !== undefined && !typeIs(waitedOn, "thread") && runsPromiseWork(coroutine.running());
		}

		return false;
	}

	/**
	 * Waits until no provider a provider's constructor took has an `onInit` still to finish, as an
	 * eager provider's `onInit` comes after the eager providers' it takes. Run before the `onInit` of
	 * a late provider in its turn, and of an eager one during ignition -- or, for one without an
	 * `onInit`, before its `onStart` and per-frame events, which saw the same. A late provider resolved in a
	 * turn of its own, or a lazy provider of an import that an eager provider's constructor resolved
	 * for the first time -- which the import's plugin initialises on a turn of its own -- had the
	 * provider taking it initialised, and started, against a dependency not yet initialised.
	 * Resolved together, a dependency comes first in the same turn, so this finds nothing to wait for.
	 *
	 * Polled, since a dependency's `onInit` ends in several ways -- it finishes, it raises, its turn
	 * drops it as the module extinguishes -- and a wait nothing ended would hold this turn, or the
	 * ignition, for good. Does not wait for one whose `onInit` waits for the running thread (see
	 * `initWaitsForRunningThread`), which would never end; one that may, as far as can be told, is
	 * waited for, and warned about once the wait has lasted `SELF_WAIT_WARNING` seconds.
	 *
	 * Answers whether the provider's `onInit` may run: not once its own module has begun to
	 * extinguish, nor once the module of a dependency it waited for has, which dropped that
	 * dependency uninitialised or is releasing it. A late provider's module goes down then too, as
	 * an importer of that module; an igniting module is no importer yet, so its ignition fails.
	 */
	private awaitDependencies(object: object) {
		const dependencies = this.initDependencies.get(object);
		if (dependencies === undefined) return !this.hasBegunExtinguishing();
		this.initDependencies.delete(object);

		let waitedFor: Array<LifecycleProvider> | undefined;
		let since: number | undefined;
		let warned = false;
		while (!this.hasBegunExtinguishing()) {
			let pending = false;
			for (const dependency of dependencies) {
				const owner = pendingInits.get(dependency as object);
				if (owner === undefined || owner.initWaitsForRunningThread(dependency as object)) continue;

				pending = true;
				waitedFor ??= [];
				if (!waitedFor.includes(owner)) {
					waitedFor.push(owner);
				}

				// Once, and only for a wait that has lasted and may be on itself.
				if (
					!warned &&
					since !== undefined &&
					os.clock() - since >= SELF_WAIT_WARNING &&
					owner.mayWaitForRunningThread(dependency as object)
				) {
					warned = true;
					warn(
						`[Flamework] '${this.getIdentifier(object)}' has waited ${SELF_WAIT_WARNING}s for the onInit of '${owner.getIdentifier(dependency as object)}', which waits on Promise work that may be this very ignition: an onInit that ignites a module taking it after it has yielded waits for itself. Ignite such a module from onStart or a PlayerAdded handler instead.`,
					);
				}
			}

			if (!pending) break;
			since ??= os.clock();
			task.wait();
		}

		if (this.hasBegunExtinguishing()) return false;
		return waitedFor === undefined || !waitedFor.some((owner) => owner.hasBegunExtinguishing());
	}

	private runLateProviders() {
		// This turn takes what was resolved before it began; anything resolved from here on, but by
		// its own `onInit`s, is the next one's.
		const providers = this.lateQueue;
		this.lateQueue = new Array<object>();
		this.hasLateTurn = false;

		const turn = coroutine.running();
		this.lateTurns.set(turn, providers);
		const initialised = new Array<object>();

		// Walked live, as `postIgnite` walks: an `onInit` may resolve another lazy provider, which
		// joins the end of this turn and is initialised after the ones before it.
		while (!providers.isEmpty()) {
			// Nothing once the module has begun to extinguish: by then it may have been told
			// `onExtinguished` -- one an `onExtinguished` handler resolved for the first time is --
			// and a later step that yields let this run after it, and before `release` detached it.
			// Nor once an `onInit` that yielded saw it begin.
			if (this.hasBegunExtinguishing()) {
				providers.clear();
				break;
			}

			// Nor while the module is still igniting -- one a postIgnite hook after this plugin's
			// resolved, whose turn came when a hook yielded: it was started before the module was
			// ignited, even by an ignition that then failed. `start` gives them their turn again.
			if (this.module?.isIgnited() !== true) {
				for (const object of providers) {
					this.heldLateProviders.push(object);
				}

				providers.clear();
				break;
			}

			const object = providers.shift()!;
			if (!this.lateProviders.has(object)) {
				continue;
			}

			// In front of its `onInit`, or of its `onStart` and per-frame events when it has none.
			if (!this.awaitDependencies(object)) {
				providers.clear();
				break;
			}

			if (this.initMembers.has(object as OnInit)) {
				// One that raises is reported and left out -- never ticking, never started, as on a
				// thread of its own -- and does not hold back the ones after it.
				this.lateTurnInits.set(turn, object);
				const [success, err] = pcall(() => this.runInit(object as OnInit));
				this.lateTurnInits.delete(turn);
				pendingInits.delete(object);
				if (!success) {
					task.spawn(error, err, 0);
					continue;
				}
			}

			this.lateProviders.delete(object);
			initialised.push(object);
		}

		// Over from here: one an `onStart` resolves gets a turn of its own.
		this.lateTurns.delete(turn);

		for (const object of initialised) {
			if (this.hasBegunExtinguishing()) {
				return;
			}

			if (this.onStart.has(object as OnStart)) {
				this.runStart(object as OnStart);
			}
		}
	}

	/**
	 * Records what a provider's constructor took, whose pending `onInit`s its own `onInit` waits
	 * for -- or its `onStart` and per-frame events, when it has no `onInit` -- in its turn, or
	 * during ignition (see `awaitDependencies`). Answers whether it took anything.
	 */
	private recordDependencies(object: object, context: InterfaceContext) {
		if (context.dependencies === undefined || context.dependencies.isEmpty()) return false;

		this.initDependencies.set(object, context.dependencies);
		return true;
	}

	public addInit(object: OnInit, context: InterfaceContext) {
		this.initMembers.add(object);

		// Only a provider is initialised by the plugin. An instance attached through `listen` or
		// `createClassInstance` is owned by whoever created it -- `Components` runs a component's
		// `onInit` itself, before the component can be seen -- so one built during ignition must not
		// be initialised a second time here.
		if (context.kind !== "provider") return;

		this.recordDependencies(object, context);

		if (!this.hasStarted) {
			this.onInit.push(object);
		} else {
			pendingInits.set(object, this);
			this.scheduleLateProvider(object);
		}
	}

	public removeInit(object: OnInit) {
		this.initMembers.delete(object);
		this.lateProviders.delete(object);
		pendingInits.delete(object);
		this.initDependencies.delete(object);

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

		this.recordDependencies(object, context);

		if (!this.hasStarted) {
			this.startOrder.push(object);
			if (context.loadOrder !== undefined && context.loadOrder !== DEFAULT_LOAD_ORDER) {
				this.startLoadOrders.set(object, context.loadOrder);
			}
		} else {
			this.scheduleLateProvider(object);
		}
	}

	public removeStart(object: OnStart) {
		this.onStart.delete(object);
		this.lateProviders.delete(object);
		this.startLoadOrders.delete(object);

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
		//
		// Then the providers without an `onInit` whose `onStart` or per-frame events wait for what
		// their constructor took: what is left in `initDependencies` once every `onInit` has waited.
		let index = 0;
		while (true) {
			let object: object | undefined;
			const initialises = index < this.onInit.size();
			if (initialises) {
				object = this.onInit[index];
			} else {
				for (const [waiting] of this.initDependencies) {
					object = waiting;
					break;
				}

				if (object === undefined) break;
			}

			// After the `onInit`s still pending of what its constructor took, as in a late turn: a
			// lazy provider of an import that nothing had resolved yet is constructed for it here and
			// initialised by the import's plugin, on a turn of its own, which came after this one's
			// `onInit` and `onStart` both. The ignition waits, as for an `onInit` that yields, and
			// fails if that module extinguishes meanwhile, as it does when an import extinguishes
			// while an `onInit` yields -- here before this `onInit` runs against what it released.
			if (!this.awaitDependencies(object)) {
				error(
					`module '${module.debugName}': '${this.getIdentifier(object)}' takes a provider of a module that was extinguished while this module was igniting`,
					0,
				);
			}

			if (initialises) {
				this.runInit(object as OnInit);
				index += 1;
			}
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
		for (const object of this.inLoadOrder(this.startOrder)) {
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

		const tickListeners = this.tickListeners;
		const physicsListeners = this.physicsListeners;
		const renderListeners = this.renderListeners;
		const connections = new Array<RBXScriptConnection>();

		// Heartbeat rather than PostSimulation: the same point of the frame in a running game, but
		// Heartbeat also fires where no simulation runs (an edit-mode plugin, an Open Cloud Luau
		// task), so onTick works there too. PreSimulation has no such alias; onPhysics stays silent.
		connections.push(RunService.Heartbeat.Connect((dt) => this.walkFrame(tickListeners, "onTick", dt)));

		connections.push(
			RunService.PreSimulation.Connect((dt) => this.walkFrame(physicsListeners, "onPhysics", dt, time())),
		);

		// PreRender never fires on the server, so there is nothing to connect there.
		if (RunService.IsClient()) {
			connections.push(RunService.PreRender.Connect((dt) => this.walkFrame(renderListeners, "onRender", dt)));
		}

		this.moduleConnections.set(module, connections);
	}

	/**
	 * A copy of the providers to start, in ascending `loadOrder`: each on its own thread, so a lower
	 * one runs up to its first yield before the next is started. Attachment order -- dependency order
	 * -- among equals, and unchanged when no provider sets one. Sorted once, at ignition: nothing per
	 * frame is ordered.
	 */
	private inLoadOrder(objects: ReadonlyArray<OnStart>) {
		const orders = this.startLoadOrders;
		if (orders.isEmpty()) {
			return [...objects];
		}

		this.startLoadOrders = new Map();

		// `table.sort` is not stable, so equals are ordered by their position.
		const position = new Map<OnStart, number>();
		objects.forEach((object, index) => position.set(object, index));

		const sorted = [...objects];
		sorted.sort((a, b) => {
			const orderA = orders.get(a) ?? DEFAULT_LOAD_ORDER;
			const orderB = orders.get(b) ?? DEFAULT_LOAD_ORDER;
			return orderA !== orderB ? orderA < orderB : position.get(a)! < position.get(b)!;
		});

		return sorted;
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
		lifecycle.observeFrameEvents(target);
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
