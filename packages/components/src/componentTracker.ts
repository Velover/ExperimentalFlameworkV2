import { CollectionService } from "@rbxts/services";
import { t } from "@rbxts/t";

const ATOMIC_MODES = new Set<Enum.ModelStreamingMode>([
	Enum.ModelStreamingMode.Atomic,
	Enum.ModelStreamingMode.Persistent,
	Enum.ModelStreamingMode.PersistentPerPlayer,
]);

type Listener = (isQualified: boolean, instance: Instance) => void;

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
	 * Whether this entry is still being set up, and its answer therefore provisional.
	 *
	 * An entry starts out qualified and is corrected as each criterion subscribes, so a question
	 * that arrives before that has finished is a question the setup asked itself: a link naming the
	 * very component this entry is for, on the very instance it is for. Answering it with a verdict
	 * that has not been reached yet is what reports such a link met and then raises out of the
	 * construction it asked for, so it is answered `false` until the entry can speak for itself.
	 */
	isProvisional?: boolean;
}

export interface Criteria {
	tag?: string;
	typeGuard?: t.check<unknown>;
	typeGuardPoll?: boolean;
	typeGuardPollAtomic?: boolean;
	dependencies?: ComponentTracker[];
	warningTimeout?: number;

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
	 * returns the cleanup for those subscriptions.
	 *
	 * Links live outside the instance -- another instance's component, or one an attribute points
	 * at -- so unlike the other criteria they cannot be recomputed from the instance alone.
	 */
	watchLinks?: (instance: Instance, update: (criterion: string, isMet: boolean) => void) => () => void;

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
				dependencyListeners: new Map(),
				cleanup: new Set(),
				isQualified: true,
			};
			this.instances.set(instance, tracker);
		}
		return tracker;
	}

	private updateListeners(instance: Instance, tracker: InstanceTracker) {
		// Every criterion is a cache of something read elsewhere, and a link's is the one that can
		// go stale with nothing on the way to correct it: the engine defers the child signals, so a
		// link is asked to rebuild while the signal that would have unmet another one is still
		// queued behind it, and a child renamed rather than moved fires no signal at all. So the
		// flip to qualified -- the moment a component is built out of these caches, from a tree it
		// then reads for itself -- is gated on reading the links again. Without it a link reports
		// itself met and construction raises out of whatever handler happened to ask.
		//
		// A gate rather than a criterion of its own: the reading is worth nothing if it can only
		// happen while the set is already empty, and the answer stops mattering the moment the
		// component exists. A component whose tree is read once keeps the child it was built with,
		// however that tree moves afterwards.
		const isQualified =
			tracker.unmetCriteria.isEmpty() &&
			(tracker.isQualified || this.criteria.linksMet === undefined || this.criteria.linksMet(instance));

		if (isQualified !== tracker.isQualified) {
			tracker.isQualified = isQualified;

			for (const listener of tracker.listeners) {
				listener(isQualified, instance);
			}

			const warningThread = tracker.timeoutWarningThread;
			if (isQualified && warningThread) {
				tracker.timeoutWarningThread = undefined;
				task.cancel(warningThread);
			}
		}
	}

	private setupTracker(instance: Instance, tracker: InstanceTracker, observeOnly = false) {
		const { typeGuard, typeGuardPoll, typeGuardPollAtomic, dependencies } = this.criteria;

		const isAtomicModel = instance.IsA("Model") && ATOMIC_MODES.has(instance.ModelStreamingMode);
		if (typeGuard && typeGuardPoll && (typeGuardPollAtomic || !isAtomicModel)) {
			let addedConnection: RBXScriptConnection | undefined;
			let removingConnection: RBXScriptConnection | undefined;
			let isScheduled = false;

			// Re-reads the guard against the tree as it now stands, whichever signal reported that
			// it moved. Both connections run the same body because the poll is not told what
			// changed: it is here to notice that the answer moved, and a poll that was re-pointed
			// while this was already queued still has to report the tree it finds when it runs.
			const poll = () => {
				const wasMet = !tracker.unmetCriteria.has("type guard");
				const isMet = typeGuard(instance);
				if (isMet === wasMet) return;

				this.setTypeGuardMet(tracker, isMet);
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

				// Passed on rather than dropped: a tracker that is only observing is not waiting for
				// its dependencies either, and a dependency's warning here would be the same "wrong
				// way round" report `observeOnly` exists to suppress -- said about a component
				// nobody has asked for on an instance nothing is tagged with.
				dependency.trackInstance(instance, listener, observeOnly);
				tracker.dependencyListeners.set(dependency, listener);

				tracker.cleanup.add(() => {
					tracker.dependencyListeners.delete(dependency);
					dependency.untrackInstance(instance, listener);
				});
			}
		}

		const { watchLinks } = this.criteria;
		if (watchLinks) {
			tracker.cleanup.add(
				watchLinks(instance, (criterion, isMet) => {
					if (isMet) {
						tracker.unmetCriteria.delete(criterion);
					} else {
						tracker.unmetCriteria.add(criterion);
					}

					this.updateListeners(instance, tracker);
				}),
			);
		}

		if (!observeOnly) {
			this.armWarning(instance, tracker);
		}
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

			const reasons = new Array<string>();

			for (const criteria of tracker.unmetCriteria) {
				if (typeIs(criteria, "string")) {
					reasons.push(criteria);
				}
			}

			const { dependencies } = this.criteria;
			if (dependencies) {
				for (const dependency of dependencies) {
					if (tracker.unmetCriteria.has(dependency)) {
						reasons.push(`dependency '${dependency.identifier}'`);
					}
				}
			}

			warn(`[Flamework] Infinite yield possible on instance '${instance.GetFullName()}'`);
			warn(`Waiting for component '${this.identifier}'`);
			warn(`Waiting for the following criteria: ${reasons.join(", ")}`);
		});
	}

	/**
	 * Arms the warning for an instance already being tracked, and for everything this component
	 * depends on, because a listener that waits has arrived after the entry was created.
	 *
	 * The dependencies are part of it because their entries were created alongside this one: an
	 * entry a link created observes its dependencies too, so nothing down the chain is armed until
	 * somebody actually waits at the top of it. The subscription this entry holds on each of them
	 * starts waiting along with it, which is what makes the wait end down there as well.
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
	 * the instance can be read for: it is watched, and reported through `watchLinks`.
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
			if (this.criteria.typeGuard(instance)) {
				if (tracker) {
					this.setTypeGuardMet(tracker, true);
				}
			} else {
				result = false;
				if (!tracker) return result;

				this.setTypeGuardMet(tracker, false);
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
		}
	}

	/**
	 * Re-reads the criteria of an entry nothing is waiting for, which is an entry only a link is
	 * holding open.
	 *
	 * A link is not allowed to change the answer this tracker gives, so an entry a link created has
	 * to answer the way no entry at all would: every criterion read now rather than frozen at
	 * whatever it was when the link first looked. Called from every path that learns something new
	 * about an instance but has no listener to register -- one the predicate or the ancestor lists
	 * filtered out, where nothing else will ever read the tree again.
	 */
	public refreshInstance(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker === undefined || !tracker.waiting.isEmpty()) return;

		this.testInstance(instance, tracker);
	}

	public checkInstance(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);

		if (tracker) {
			return tracker.isProvisional !== true && tracker.isQualified;
		}

		return this.testInstance(instance, tracker);
	}

	public isTracked(instance: Instance) {
		return this.instances.has(instance);
	}

	/**
	 * Starts tracking an instance, calling `listener` whenever it starts or stops qualifying.
	 *
	 * `observeOnly` is for a listener that is watching rather than waiting -- a link, whose own
	 * component already reports the wait. Without it the instance would be reported as one this
	 * component is being kept from, which is the wrong way round and says it twice.
	 */
	public trackInstance(instance: Instance, listener: Listener, observeOnly = false) {
		const isNewInstance = !this.instances.has(instance);
		const tracker = this.getInstanceTracker(instance);
		if (isNewInstance) {
			this.testInstance(instance, tracker);

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
			// Nobody was waiting for this instance, so the entry is only here because a link is
			// watching it: an instance guard that failed before the tree was finished is asked
			// again rather than left frozen by whoever happened to look first.
			this.refreshInstance(instance);

			// The tracker is already here because a link is watching this instance, which arms no
			// warning of its own: the wait only starts once somebody is actually waiting.
			this.armWarningChain(instance, tracker);
		}

		tracker.listeners.add(listener);
		if (!observeOnly) {
			tracker.waiting.add(listener);
		}

		listener(tracker.isQualified, instance);
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
