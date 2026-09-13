import { CollectionService } from "@rbxts/services";
import { deferOnce } from "./instanceTree";

const ATOMIC_MODES = new Set<Enum.ModelStreamingMode>([
	Enum.ModelStreamingMode.Atomic,
	Enum.ModelStreamingMode.Persistent,
	Enum.ModelStreamingMode.PersistentPerPlayer,
]);

/** Whether the instance is a model that streams in whole, whose tree contextual streaming reads once rather than follows. */
export function isAtomicModel(instance: Instance) {
	return instance.IsA("Model") && ATOMIC_MODES.has(instance.ModelStreamingMode);
}

type Listener = (isQualified: boolean, instance: Instance) => void;

/** How far a warning follows links and dependencies for their reasons before it stops naming them. */
const MAX_REASON_DEPTH = 2;

interface InstanceTracker {
	isQualified: boolean;
	unmetCriteria: Set<unknown>;
	listeners: Set<Listener>;

	/**
	 * The subset of `listeners` that is waiting rather than merely watching, which is what the
	 * warning is about: it is armed while this is non-empty and cancelled once it empties, however
	 * many observers are left holding the entry open.
	 */
	waiting: Set<Listener>;

	/**
	 * The subset of `waiting` this entry is read for: the tag path's listener, which builds the
	 * component out of the answer. Its arrival is what reads the criteria for keeps -- once, for a
	 * component that reads its tree once, and from then on through the entry's own deferred tasks
	 * -- so until it is here the entry answers the way no entry at all would, read afresh each
	 * time it is asked. A dependent's listener waits here too, for the warning's sake, but like a
	 * link's it reads nothing and keeps nothing current: the entry is held open, not owned.
	 */
	owners: Set<Listener>;

	/**
	 * The listener this entry registered on each of its component's dependencies, so that a wait
	 * starting or ending here can reach the same subscriptions down the chain.
	 */
	dependencyListeners: Map<ComponentTracker, Listener>;

	cleanup: Set<Callback>;
	timeoutWarningThread?: thread;

	/**
	 * Re-points the instance guard's poll at the change that could overturn the guard's current
	 * answer. Present only while that poll is running, which is not every component and not every
	 * streaming mode.
	 */
	syncTypeGuardPoll?: (isMet: boolean) => void;

	/**
	 * The watcher following the instance guard's tree, present only while the guard is polled
	 * through a shape. `testInstance` re-reads the guard through it rather than running it whole,
	 * so that what the watcher holds stays in step with the answer it gave.
	 */
	typeGuardWatcher?: TypeGuardWatcher;

	/**
	 * The watcher following the component's links, present while the entry has any. `refreshInstance`
	 * re-reads the links through it rather than beside it, so that what it watches -- the linked
	 * component's own entry, its announcements -- is re-pointed along with the answer it gave.
	 */
	linkWatcher?: LinkWatcher;

	/** The attribute criteria currently unmet, `invalid attribute '<name>'` each, so a re-read can clear the stale ones. */
	invalidAttributes?: Set<string>;

	/**
	 * Whether this entry is still being set up, and its answer therefore provisional.
	 *
	 * An entry starts out qualified and is corrected as each criterion subscribes, so a question
	 * that arrives before that has finished is a question the setup asked itself: a link naming the
	 * very component this entry is for, on the very instance it is for. Answering it with a verdict
	 * that has not been reached yet is what reports such a link met and then raises out of the
	 * construction it asked for, so it is answered `false` until the entry can speak for itself.
	 */
	isProvisional?: boolean;

	/**
	 * Whether a criterion was lost with no owner registered to act on it.
	 *
	 * An entry is set up before its first listener is added, and the component it is for can
	 * already be there: the eager path builds one the moment somebody asks for it, a resumption
	 * before the tag that creates this entry is announced. A criterion that goes unmet and met
	 * again in between describes a component that has to be built afresh, and the current answer
	 * on its own says none of that -- it is "qualified", and the stale component is handed back.
	 *
	 * Cleared by a build (`noteBuilt`): a component built after the loss is that fresh one.
	 */
	unheardLoss?: boolean;
}

/** A watched instance guard: the tree's answer as it was last resolved, re-read on demand. */
export interface TypeGuardWatcher {
	isMet: () => boolean;
	refresh: () => boolean;
	release: () => void;
}

/**
 * The watched links of one entry. `refresh` resolves every link again, re-pointing what each
 * watches at the target it has now and reporting each as it stands, the way the watcher reports a
 * change it was told about.
 */
export interface LinkWatcher {
	refresh: () => void;
	release: () => void;
}

export interface Criteria {
	tag?: string;
	typeGuard?: (instance: Instance) => boolean;

	/**
	 * Explains one unmet criterion on an instance, for the warning: which child the instance guard
	 * is missing when it was written as a shape, or what a link's target is still short of. `depth`
	 * is how far the explanation has already followed links and dependencies, so that a ring of
	 * them ends.
	 */
	describeCriterion?: (instance: Instance, criterion: string, depth: number) => string | undefined;

	/**
	 * The links that are not met on an instance right now, by the name each is recorded under. For
	 * an instance that has no entry to read them from.
	 */
	unmetLinks?: (instance: Instance) => string[];

	/**
	 * Watches the instance for the guard one required child at a time, calling `changed` whenever
	 * one was resolved again. Without it, a polled guard is re-run whole on every descendant change.
	 */
	watchTypeGuard?: (instance: Instance, changed: () => void) => TypeGuardWatcher;

	/**
	 * The plain attributes whose guards fail on the instance, with nothing to stand in for them: one
	 * criterion each, so a component comes down when an attribute goes bad and up again when it is
	 * valid, and the warning can name it.
	 */
	checkAttributes?: (instance: Instance) => string[];

	/** Watches those attributes, calling `changed` whenever one of them was written. Returns the cleanup. */
	watchAttributes?: (instance: Instance, changed: () => void) => () => void;
	typeGuardPoll?: boolean;
	typeGuardPollAtomic?: boolean;
	dependencies?: ComponentTracker[];
	warningTimeout?: number;

	/**
	 * Whether the component this tracker is for holds an invalid place on the instance: it was
	 * built there and its `onInit` raised. Such a component is not a criterion of its own entry --
	 * the tag path that built it is what takes it down, for a reason of its own -- but it is one
	 * for whoever asks the entry for the component, a dependent above all, which cannot be built
	 * on top of it.
	 */
	isInvalid?: (instance: Instance) => boolean;

	/**
	 * Whether the component's links are all met on this instance, right now. Used for instances
	 * that are not tracked, where there is nothing watching and nothing to wait on.
	 *
	 * The same question `linksMet` asks of a tracked instance, so that whether something happens to
	 * be watching an instance does not change the answer given for it.
	 */
	checkLinks?: (instance: Instance) => boolean;

	/**
	 * Watches the component's links on this instance, reporting each one as it is met or lost, and
	 * returns the watcher, which releases those subscriptions and re-reads the links on demand.
	 *
	 * Links live outside the instance -- another instance's component, or one an attribute points
	 * at -- so unlike the other criteria they cannot be recomputed from the instance alone. For an
	 * entry whose links are read once -- a child link under a streaming mode that does not follow
	 * the tree -- the watcher's `refresh` is the only thing that ever reads them again.
	 */
	watchLinks?: (instance: Instance, update: (criterion: string, isMet: boolean) => void) => LinkWatcher;

	/**
	 * Whether every link is met on this instance right now, read from the instance rather than from
	 * what the watched links last reported.
	 */
	linksMet?: (instance: Instance) => boolean;
}

export class ComponentTracker {
	private instances = new Map<Instance, InstanceTracker>();

	constructor(
		private identifier: string,
		private criteria: Criteria,
	) {}

	private getInstanceTracker(instance: Instance, create?: true): InstanceTracker;
	private getInstanceTracker(instance: Instance, create: false): InstanceTracker | undefined;
	private getInstanceTracker(instance: Instance, create = true) {
		let tracker = this.instances.get(instance);
		if (!tracker && create) {
			tracker = {
				unmetCriteria: new Set(),
				listeners: new Set(),
				waiting: new Set(),
				owners: new Set(),
				dependencyListeners: new Map(),
				cleanup: new Set(),
				isQualified: true,
			};
			this.instances.set(instance, tracker);
		}
		return tracker;
	}

	/**
	 * Whether the instance passes every criterion that is read from it, read now rather than from the
	 * entry: the instance guard, the attributes and the links.
	 *
	 * Every criterion is a cache of something read elsewhere, and each of these can go stale with
	 * nothing on the way to correct it in time. The engine defers the child signals, so a link is
	 * asked to rebuild while the signal that would have unmet another one is still queued behind it,
	 * and a child renamed rather than moved fires no signal at all; the guard and the attributes are
	 * read on deferred tasks of their own, a resumption after the tree or the attribute moved, and
	 * the link's signal that asks for the rebuild lands in between. So the flip to qualified -- the
	 * moment a component is built out of these caches, from an instance it then reads for itself --
	 * is gated on reading them again. Without it a link reports itself met and construction raises
	 * out of whatever handler happened to ask, or builds on a tree that is short of a child.
	 *
	 * A gate rather than a criterion of its own: the reading is worth nothing if it can only happen
	 * while the set is already empty, and the answer stops mattering the moment the component exists.
	 * A component whose tree is read once keeps the child it was built with, however that tree moves
	 * afterwards; what the deferred tasks find is recorded by them, a resumption later.
	 *
	 * A dependency is among them. It is read from its own entry rather than from the instance, but
	 * that entry is a cache of the same kind: it answers for a component that was removed by hand
	 * and cannot be built again, because the tree its guard read once has since moved, or for one
	 * that was built and is invalid -- and construction raises on either, asking for a dependency
	 * it cannot resolve.
	 */
	private readsQualified(instance: Instance) {
		const { typeGuard, checkAttributes, dependencies, linksMet } = this.criteria;

		if (typeGuard !== undefined && !typeGuard(instance)) return false;
		if (checkAttributes !== undefined && !checkAttributes(instance).isEmpty()) return false;

		if (dependencies !== undefined && dependencies.some((dependency) => !dependency.checkInstance(instance))) {
			return false;
		}

		return linksMet === undefined || linksMet(instance);
	}

	private updateListeners(instance: Instance, tracker: InstanceTracker) {
		const isQualified = tracker.unmetCriteria.isEmpty() && (tracker.isQualified || this.readsQualified(instance));

		if (isQualified !== tracker.isQualified) {
			tracker.isQualified = isQualified;

			// A criterion lost with nothing registered to act on it is kept for the listener that
			// arrives next, because the component this entry is for may already exist and would
			// otherwise simply be handed back. Only the tag path's listener acts on it: a link
			// hearing the loss re-checks its own criterion, and a dependent takes its own component
			// down -- neither can take this one down, however much the dependent is waiting. A gain
			// nobody heard needs nothing: the answer a listener is given as it registers already
			// says it.
			if (tracker.owners.isEmpty()) {
				if (!isQualified) tracker.unheardLoss = true;
			} else {
				tracker.unheardLoss = undefined;
			}

			for (const listener of tracker.listeners) {
				listener(isQualified, instance);
			}

			const warningThread = tracker.timeoutWarningThread;
			if (isQualified && warningThread) {
				tracker.timeoutWarningThread = undefined;
				task.cancel(warningThread);
			}

			// Said again after every loss while something waits: a component that goes down -- its
			// tree broke, a link was lost, an attribute went bad -- and stays down is as stuck as one
			// that never came up, and says why the same way.
			if (!isQualified && !tracker.waiting.isEmpty()) {
				this.armWarning(instance, tracker);
			}
		}
	}

	/**
	 * Records which plain attributes fail their guards, one criterion each, clearing the ones that
	 * have since been put right.
	 */
	private setInvalidAttributes(tracker: InstanceTracker, invalid: string[]) {
		const criteria = new Set<string>();
		for (const name of invalid) {
			criteria.add(`invalid attribute '${name}'`);
		}

		if (tracker.invalidAttributes !== undefined) {
			for (const previous of tracker.invalidAttributes) {
				if (!criteria.has(previous)) tracker.unmetCriteria.delete(previous);
			}
		}

		for (const criterion of criteria) {
			tracker.unmetCriteria.add(criterion);
		}

		tracker.invalidAttributes = criteria;
	}

	private setupTracker(instance: Instance, tracker: InstanceTracker, observeOnly = false) {
		const { typeGuard, typeGuardPoll, typeGuardPollAtomic, watchTypeGuard, dependencies } = this.criteria;

		const pollsTree =
			typeGuard !== undefined && typeGuardPoll === true && (typeGuardPollAtomic || !isAtomicModel(instance));

		if (pollsTree && watchTypeGuard !== undefined) {
			// A shape is followed one required child at a time: the watcher keeps the slot that
			// moved current, and the poll only reads the answer. Nothing is re-pointed here, because
			// the watcher listens for a child arriving and leaving alike.
			const deferred = deferOnce(() => {
				// The entry's own watcher, set below before anything can schedule this and cleared
				// as the poll is released.
				const watcher = tracker.typeGuardWatcher;
				if (watcher === undefined) return;

				// Reported even when it is what the entry already records. A flip the gate in
				// `updateListeners` refused records nothing, and this poll is what runs after the
				// tree moved again: a tree that broke and was repaired before it ran reads as the
				// record says, and the entry would otherwise stay down with nothing left to lift it.
				this.setTypeGuardMet(tracker, watcher.isMet());
				this.updateListeners(instance, tracker);
			});

			const watcher = watchTypeGuard(instance, deferred.schedule);
			tracker.typeGuardWatcher = watcher;

			tracker.cleanup.add(() => {
				tracker.typeGuardWatcher = undefined;
				deferred.release();
				watcher.release();
			});
		} else if (pollsTree) {
			// A guard written by hand can only be run whole, so the tree is watched whole: every
			// descendant change re-runs it.
			let addedConnection: RBXScriptConnection | undefined;
			let removingConnection: RBXScriptConnection | undefined;
			let isScheduled = false;

			// Re-reads the guard against the tree as it now stands, whichever signal reported that
			// it moved. Both connections run the same body because the poll is not told what
			// changed: it is here to report the tree it finds when it runs, and a poll that was
			// re-pointed while this was already queued still has to. As above, a reading that
			// matches the record is reported too: the gate can have refused a flip on a tree that
			// is whole again by now, and the record says nothing of it.
			const poll = () => {
				this.setTypeGuardMet(tracker, typeGuard(instance));
				this.updateListeners(instance, tracker);
			};

			const schedule = () => {
				if (isScheduled) return;
				isScheduled = true;

				task.defer(() => {
					isScheduled = false;
					poll();
				});
			};

			const connectAdded = () => {
				if (addedConnection) return;

				removingConnection?.Disconnect();
				removingConnection = undefined;
				addedConnection = instance.DescendantAdded.Connect(schedule);
			};
			const connectRemoving = () => {
				if (removingConnection) return;

				addedConnection?.Disconnect();
				addedConnection = undefined;
				removingConnection = instance.DescendantRemoving.Connect(schedule);
			};

			// Only ever one of the two: a guard that fails can only be met by the tree gaining
			// something, and one that passes can only be broken by it losing something. Which of
			// them is live is derived from the criterion rather than remembered beside it, so that
			// every path writing the criterion re-points the poll with it and the two -- one fact
			// in two places -- cannot come to disagree.
			tracker.syncTypeGuardPoll = (isMet) => {
				if (isMet) {
					connectRemoving();
				} else {
					connectAdded();
				}
			};

			tracker.cleanup.add(() => {
				tracker.syncTypeGuardPoll = undefined;
				addedConnection?.Disconnect();
				removingConnection?.Disconnect();
			});

			tracker.syncTypeGuardPoll(!tracker.unmetCriteria.has("type guard"));
		}

		const { checkAttributes, watchAttributes } = this.criteria;
		if (checkAttributes !== undefined && watchAttributes !== undefined) {
			// A burst of attribute writes is read once, after the engine has delivered them all.
			const deferred = deferOnce(() => {
				this.setInvalidAttributes(tracker, checkAttributes(instance));
				this.updateListeners(instance, tracker);
			});

			const release = watchAttributes(instance, deferred.schedule);
			tracker.cleanup.add(() => {
				deferred.release();
				release();
			});
		}

		if (dependencies) {
			for (const dependency of dependencies) {
				const listener = (isQualified: boolean) => {
					if (isQualified) {
						tracker.unmetCriteria.delete(dependency);
					} else {
						tracker.unmetCriteria.add(dependency);
					}

					this.updateListeners(instance, tracker);
				};

				// Observing, the way a link does: this entry is not the dependency's tag path, and
				// registering as if it were is what would freeze the dependency's entry on whatever
				// this reading found -- a guard read before the tree was finished, a tag criterion
				// only the announcement writes -- and answer the dependency's own tag from it.
				// The wait is passed on below, through the chain, when this entry itself waits: a
				// tracker that is only observing is not waiting for its dependencies either, and
				// a dependency's warning would be the same "wrong way round" report `observeOnly`
				// exists to suppress -- said about a component nobody has asked for on an
				// instance nothing is tagged with.
				dependency.trackInstance(instance, listener, true);
				tracker.dependencyListeners.set(dependency, listener);

				tracker.cleanup.add(() => {
					tracker.dependencyListeners.delete(dependency);
					dependency.untrackInstance(instance, listener);
				});
			}
		}

		const { watchLinks } = this.criteria;
		if (watchLinks) {
			const watcher = watchLinks(instance, (criterion, isMet) => {
				if (isMet) {
					tracker.unmetCriteria.delete(criterion);
				} else {
					tracker.unmetCriteria.add(criterion);
				}

				this.updateListeners(instance, tracker);
			});
			tracker.linkWatcher = watcher;

			tracker.cleanup.add(() => {
				tracker.linkWatcher = undefined;
				watcher.release();
			});
		}

		// The whole chain, because the dependencies above were subscribed as observers: the wait
		// reaches each of them from here, as it does for a listener arriving at an entry later.
		if (!observeOnly) {
			this.armWarningChain(instance, tracker);
		}
	}

	/**
	 * The criteria an instance is short of: read off its entry when it has one, and from the
	 * instance otherwise -- the tag, the instance guard, each dependency and each link, as
	 * `testInstance` would find them.
	 *
	 * An entry whose every recorded criterion is met and that is still not qualified is held down
	 * by the reading `readsQualified` gates the flip on, which records nothing: what it read is
	 * read again here, so the warning can name it the way it names a criterion a poll recorded.
	 */
	public unmetCriteriaOf(instance: Instance): defined[] {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker !== undefined) {
			const recorded = [...tracker.unmetCriteria] as defined[];
			return recorded.isEmpty() && !tracker.isQualified ? this.readUnmet(instance, false) : recorded;
		}

		return this.readUnmet(instance, true);
	}

	/**
	 * The criteria read from the instance itself, now. `whole` adds the tag, which an entry records
	 * for itself; without it, only what `readsQualified` reads.
	 */
	private readUnmet(instance: Instance, whole: boolean): defined[] {
		const unmet = new Array<defined>();
		const { tag, typeGuard, checkAttributes, dependencies, unmetLinks } = this.criteria;

		if (whole && tag !== undefined && !CollectionService.HasTag(instance, tag)) unmet.push("CollectionService tag");
		if (typeGuard !== undefined && !typeGuard(instance)) unmet.push("type guard");

		if (checkAttributes !== undefined) {
			for (const name of checkAttributes(instance)) unmet.push(`invalid attribute '${name}'`);
		}

		if (dependencies !== undefined) {
			for (const dependency of dependencies) {
				if (!dependency.checkInstance(instance)) unmet.push(dependency);
			}
		}

		if (unmetLinks !== undefined) {
			for (const link of unmetLinks(instance)) unmet.push(link);
		}

		return unmet;
	}

	/**
	 * One criterion as the warning says it: the instance guard with the child that is wrong, a link
	 * with what its target is short of, a dependency with what it is waiting for in turn.
	 */
	public describe(instance: Instance, criterion: defined, depth = 0): string {
		if (typeIs(criterion, "string")) {
			return this.criteria.describeCriterion?.(instance, criterion, depth) ?? criterion;
		}

		if (criterion instanceof ComponentTracker) {
			const reasons = depth < MAX_REASON_DEPTH ? criterion.describeUnmet(instance, depth + 1) : [];

			return reasons.isEmpty()
				? `dependency '${criterion.identifier}'`
				: `dependency '${criterion.identifier}' (waiting for: ${reasons.join(", ")})`;
		}

		return tostring(criterion);
	}

	/** Everything an instance is still waiting for, as the warning lists it. */
	public describeUnmet(instance: Instance, depth = 0): string[] {
		return this.unmetCriteriaOf(instance).map((criterion) => this.describe(instance, criterion, depth));
	}

	/**
	 * Starts the warning that reports what a component is still waiting for, unless it is already
	 * running or there is nothing left to wait for.
	 *
	 * A tracker outlives the listener that created it, and one created by a link watches without
	 * waiting, so this is also what arms the warning for the first listener that does wait.
	 */
	private armWarning(instance: Instance, tracker: InstanceTracker) {
		if (tracker.isQualified || tracker.timeoutWarningThread !== undefined) return;
		if (this.criteria.warningTimeout === 0) return;

		tracker.timeoutWarningThread = task.delay(this.criteria.warningTimeout ?? 5, () => {
			// Released as the warning is said rather than left behind: the thread is what says a
			// warning is pending, and a spent one would refuse every later wait on this instance.
			tracker.timeoutWarningThread = undefined;

			// Each criterion with its reason: the child the instance guard is missing, what a link's
			// target is short of in the linked component's own words, what a dependency waits for.
			const reasons = this.describeUnmet(instance);

			warn(`[Flamework] Infinite yield possible on instance '${instance.GetFullName()}'`);
			warn(`Waiting for component '${this.identifier}'`);
			warn(`Waiting for the following criteria: ${reasons.join(", ")}`);
		});
	}

	/**
	 * Arms the warning for an instance being tracked, and for everything this component depends
	 * on, because a listener that waits has arrived -- with the entry, or after it was created.
	 *
	 * The dependencies are part of it because their entries were created alongside this one, and
	 * every entry observes its dependencies: nothing down the chain is armed until somebody
	 * actually waits at the top of it. The subscription this entry holds on each of them starts
	 * waiting along with it, which is what makes the wait end down there as well.
	 */
	private armWarningChain(instance: Instance, tracker: InstanceTracker) {
		this.armWarning(instance, tracker);

		for (const [dependency, listener] of tracker.dependencyListeners) {
			const dependencyTracker = dependency.getInstanceTracker(instance, false);
			if (dependencyTracker === undefined) continue;

			dependencyTracker.waiting.add(listener);
			dependency.armWarningChain(instance, dependencyTracker);
		}
	}

	/**
	 * Cancels the warning for an entry nothing waits for any more, and for everything below it in
	 * the dependency chain.
	 *
	 * The mirror of `armWarningChain`: a wait that ends has to reach as far down as the wait that
	 * started it did. Without it, an entry a link holds open would keep announcing what the tag that
	 * has since gone was waiting for -- a component nobody is asking for any more, one instance
	 * further down than the tag that was removed.
	 */
	private disarmWarningChain(instance: Instance, tracker: InstanceTracker) {
		if (tracker.timeoutWarningThread !== undefined) {
			task.cancel(tracker.timeoutWarningThread);
			tracker.timeoutWarningThread = undefined;
		}

		for (const [dependency, listener] of tracker.dependencyListeners) {
			const dependencyTracker = dependency.getInstanceTracker(instance, false);
			if (dependencyTracker === undefined) continue;

			dependencyTracker.waiting.delete(listener);

			if (dependencyTracker.waiting.isEmpty()) {
				dependency.disarmWarningChain(instance, dependencyTracker);
			}
		}
	}

	/**
	 * Records what the instance guard says, moving its poll along with it.
	 *
	 * The criterion and the connection the poll holds are one fact kept in two places -- the
	 * guard's answer, and the change that could overturn it -- so they are written together and
	 * every path that learns the answer comes through here. Writing the criterion alone is what
	 * would leave the poll listening for the change that has already happened: a guard recorded as
	 * failing while the poll still waits for the tree to break can only ever be told that it broke
	 * again, which it never does, and the component would never be built or never be dropped.
	 */
	private setTypeGuardMet(tracker: InstanceTracker, isMet: boolean) {
		if (isMet) {
			tracker.unmetCriteria.delete("type guard");
		} else {
			tracker.unmetCriteria.add("type guard");
		}

		const syncPoll = tracker.syncTypeGuardPoll;
		if (syncPoll !== undefined) {
			syncPoll(isMet);
		}
	}

	/**
	 * Re-reads every criterion an instance can be judged by on its own, updating the entry's
	 * unmet set in both directions and notifying the listeners once, at the end.
	 *
	 * `checkLinks` is left out for an instance that has an entry, because a link is not something
	 * the instance can be read for: it is watched, and reported through `watchLinks` -- or read
	 * again by `refreshInstance`, ahead of this, for an entry nothing waits on.
	 */
	private testInstance(instance: Instance, tracker?: InstanceTracker) {
		let result = true;

		if (!tracker && this.criteria.checkLinks && !this.criteria.checkLinks(instance)) {
			return false;
		}

		if (this.criteria.dependencies) {
			for (const dependency of this.criteria.dependencies) {
				if (dependency.checkInstance(instance)) {
					tracker?.unmetCriteria.delete(dependency);
				} else {
					result = false;
					if (!tracker) return result;

					tracker.unmetCriteria.add(dependency);
				}
			}
		}

		if (this.criteria.typeGuard) {
			// Through the watcher where there is one: it resolves every slot again, which also
			// catches what no signal reported, and what it holds stays in step with the answer.
			const watcher = tracker?.typeGuardWatcher;
			const isMet = watcher !== undefined ? watcher.refresh() : this.criteria.typeGuard(instance);

			if (isMet) {
				if (tracker) {
					this.setTypeGuardMet(tracker, true);
				}
			} else {
				result = false;
				if (!tracker) return result;

				this.setTypeGuardMet(tracker, false);
			}
		}

		if (this.criteria.checkAttributes) {
			const invalid = this.criteria.checkAttributes(instance);
			if (tracker) {
				this.setInvalidAttributes(tracker, invalid);
			}

			if (!invalid.isEmpty()) {
				result = false;
				if (!tracker) return result;
			}
		}

		if (this.criteria.tag !== undefined) {
			if (CollectionService.HasTag(instance, this.criteria.tag)) {
				tracker?.unmetCriteria.delete("CollectionService tag");
			} else {
				result = false;
				if (!tracker) return result;

				tracker.unmetCriteria.add("CollectionService tag");
			}
		}

		if (tracker) {
			this.updateListeners(instance, tracker);
		}

		return result;
	}

	/**
	 * Sets whether this instance has the required tag.
	 * This is called by Components for efficiency.
	 */
	public setHasTag(instance: Instance, hasTag: boolean) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker) {
			if (hasTag) {
				tracker.unmetCriteria.delete("CollectionService tag");
			} else {
				tracker.unmetCriteria.add("CollectionService tag");
			}

			this.updateListeners(instance, tracker);

			// The tag going is a loss the tag path reports here itself, having already let its
			// listener go, and it takes the component down along with it: there is nothing left
			// for the listener that arrives with the tag coming back to replay.
			if (!hasTag) tracker.unheardLoss = undefined;
		}
	}

	/**
	 * Re-reads the criteria of an entry the tag path has not registered on, which is an entry only
	 * a link or a dependent is holding open.
	 *
	 * Neither is allowed to change the answer this tracker gives, so an entry one of them created
	 * has to answer the way no entry at all would: every criterion read now rather than frozen at
	 * whatever it was when the link or the dependent first looked. A dependent's listener waits
	 * here, but it keeps nothing current, and the component it belongs to may not poll the tree at
	 * all. Called from every path that learns something new about an instance but has no listener
	 * to register -- one the predicate or the ancestor lists filtered out, where nothing else will
	 * ever read the tree again.
	 *
	 * The links are among those criteria. A child link is part of the tree, and read once under a
	 * streaming mode that does not follow it -- as it was when the link looked, before the child
	 * was there -- so it is re-read here with the instance guard, through the watcher rather than
	 * beside it: a link met by this reading is watched from here on, on the target it resolved to,
	 * so that the linked component going is heard whatever the streaming mode.
	 */
	public refreshInstance(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker === undefined || !tracker.owners.isEmpty()) return;

		tracker.linkWatcher?.refresh();
		this.testInstance(instance, tracker);
	}

	/**
	 * Whether the instance can have this component right now: it qualifies, and no invalid one --
	 * built, its `onInit` raised -- holds the place. An invalid component is the tag path's to take
	 * down, and its entry goes on qualifying; what is asked here is asked by a dependent, or by the
	 * eager path, and neither can be handed a component that is not there.
	 */
	public checkInstance(instance: Instance) {
		if (this.criteria.isInvalid?.(instance) === true) return false;

		const tracker = this.getInstanceTracker(instance, false);

		if (tracker) {
			if (tracker.isProvisional === true) return false;

			// An entry the tag path has not registered on is one a link or a dependent holds open,
			// and it answers the way no entry would: read now rather than frozen. Its tag
			// criterion in particular is only ever written by the announcement, which arrives a
			// resumption after the tag itself -- the very window the eager path builds in.
			if (tracker.owners.isEmpty()) {
				this.refreshInstance(instance);

				return tracker.isQualified;
			}

			// An entry the tag path registered on was read at its arrival, and is read by its own
			// deferred tasks from then on; its answer is what the listener acts on, a resumption
			// after the change, and the question here is asked now, ahead of that, by a path that
			// builds on the answer. So a "yes" is confirmed by the reading the flip to qualified
			// is gated on, rather than trusted: an attribute that went bad this resumption is one
			// construction would raise on.
			return tracker.isQualified && this.readsQualified(instance);
		}

		return this.testInstance(instance, tracker);
	}

	/**
	 * Notes that a component was built on this instance from the criteria as they stand now.
	 *
	 * A loss nothing heard is kept for the listener that arrives next, to take down a component
	 * built before it. A component built after it -- the eager path, in the window between an entry
	 * a link created and the tag's announcement -- was built out of everything that loss described,
	 * and replaying it would destroy and rebuild that component for nothing.
	 */
	public noteBuilt(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker !== undefined) {
			tracker.unheardLoss = undefined;
		}
	}

	/**
	 * Notes that the component built on this instance turned out invalid: its `onInit` raised.
	 *
	 * A loss for the observers and not for the entry, which goes on qualifying: a dependent was
	 * counting on a component Flamework would build here, and now waits, saying so; a link re-reads
	 * its own criterion. The tag path is not told, because it is what built the component and what
	 * takes it down, for a reason of its own -- told the entry no longer qualifies, it would take
	 * the invalid component down and build it again at once, and again.
	 */
	public noteInvalidated(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker === undefined) return;

		for (const listener of tracker.listeners) {
			if (!tracker.owners.has(listener)) listener(false, instance);
		}
	}

	/**
	 * Notes that the invalid component on this instance was taken down: the place is free again.
	 *
	 * The counterpart of `noteInvalidated`, for the same observers, which are answered from the
	 * entry again -- it went on qualifying throughout, and nothing else ever tells them so: the
	 * removal of an invalid component is announced to nobody, and the entry never flips. A
	 * dependent that was waiting on nothing but the invalid component qualifies on this, and its
	 * own tag path builds it, asking for the dependency on the way: being taken down is what lets
	 * the next construction here try again, and that construction is the next one.
	 */
	public noteCleared(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker === undefined) return;

		for (const listener of tracker.listeners) {
			if (!tracker.owners.has(listener)) listener(tracker.isQualified, instance);
		}
	}

	public isTracked(instance: Instance) {
		return this.instances.has(instance);
	}

	/**
	 * Starts tracking an instance, calling `listener` whenever it starts or stops qualifying.
	 *
	 * `observeOnly` is for a listener that is watching rather than waiting -- a link, whose own
	 * component already reports the wait, or a dependent, whose wait reaches this entry through
	 * `armWarningChain` instead. Without it the instance would be reported as one this component
	 * is being kept from, which is the wrong way round and says it twice; and the entry would be
	 * read as if for the tag path, and frozen on that reading before the tag has arrived.
	 */
	public trackInstance(instance: Instance, listener: Listener, observeOnly = false) {
		const isNewInstance = !this.instances.has(instance);
		const tracker = this.getInstanceTracker(instance);
		if (isNewInstance) {
			this.testInstance(instance, tracker);

			// The first reading is where the entry starts from, not a loss: the answer it gives the
			// listener below says everything it found. What is kept is a loss after that -- one the
			// subscriptions below notice as they are set up, or that only a link hears later.
			tracker.unheardLoss = undefined;

			// The criteria this entry is judged by are subscribed below, and a link is one of them:
			// until they have all reported, the entry has no answer of its own to give back to one
			// of them.
			tracker.isProvisional = true;
			try {
				this.setupTracker(instance, tracker, observeOnly);
			} finally {
				tracker.isProvisional = undefined;
			}
		} else if (!observeOnly) {
			// The tag path was not here yet, so the entry is only here because a link or a
			// dependent is watching it: an instance guard that failed before the tree was finished
			// is asked again rather than left frozen by whoever happened to look first.
			this.refreshInstance(instance);

			// The tracker is already here because a link is watching this instance, which arms no
			// warning of its own: the wait only starts once somebody is actually waiting.
			this.armWarningChain(instance, tracker);
		}

		tracker.listeners.add(listener);
		if (!observeOnly) {
			tracker.waiting.add(listener);
			tracker.owners.add(listener);
		}

		// The entry was set up before this listener existed, so a criterion lost and met again
		// while that happened is news it has not been given. Handing it the current answer alone is
		// what leaves a component built from a tree that has since moved exactly where it was: the
		// answer is "qualified", and the listener has nothing to do about a component it already
		// has. The loss is replayed first, in the order it happened -- to a listener that waits,
		// which is the one that can act on it; an observer arriving would only use it up.
		if (!observeOnly && tracker.unheardLoss === true && tracker.isQualified) {
			tracker.unheardLoss = undefined;

			listener(false, instance);
		}

		// An observer is answered the way `checkInstance` answers, since that is what it asks: a
		// component that is invalid here is not one a dependent can be handed. The tag path is
		// answered whether the entry qualifies, which is its question.
		const isInvalid = observeOnly && this.criteria.isInvalid?.(instance) === true;
		listener(tracker.isQualified && !isInvalid, instance);
	}

	/**
	 * Releases every tracked instance: connections, dependency subscriptions and pending warnings.
	 */
	public dispose() {
		for (const [, tracker] of this.instances) {
			for (const cleanup of tracker.cleanup) {
				cleanup();
			}

			if (tracker.timeoutWarningThread) {
				task.cancel(tracker.timeoutWarningThread);
				tracker.timeoutWarningThread = undefined;
			}
		}

		this.instances.clear();
	}

	public untrackInstance(instance: Instance, listener: Listener) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker) {
			tracker.listeners.delete(listener);
			tracker.waiting.delete(listener);
			tracker.owners.delete(listener);

			// The warning outlives the listener that armed it otherwise. A link can create a
			// tracker that the tag path later arms, so an observer left holding the entry open is
			// not a reason to keep waiting: nobody is, and the instance is usually no longer even
			// tagged by the time this runs. It reaches as far down the dependency chain as arming
			// it did, because that is how far the wait itself reached.
			if (tracker.waiting.isEmpty()) {
				this.disarmWarningChain(instance, tracker);
			}

			if (tracker.listeners.isEmpty()) {
				for (const cleanup of tracker.cleanup) {
					cleanup();
				}

				this.instances.delete(instance);
			}
		}
	}
}
