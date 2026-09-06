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
	cleanup: Set<Callback>;
	timeoutWarningThread?: thread;
}

export interface Criteria {
	tag?: string;
	typeGuard?: t.check<unknown>;
	typeGuardPoll?: boolean;
	typeGuardPollAtomic?: boolean;
	dependencies?: ComponentTracker[];
	warningTimeout?: number;

	/**
	 * Whether the component's links are all resolved on this instance, right now. Used for
	 * instances that are not tracked, where there is nothing to wait on.
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
				cleanup: new Set(),
				isQualified: true,
			};
			this.instances.set(instance, tracker);
		}
		return tracker;
	}

	private updateListeners(instance: Instance, tracker: InstanceTracker) {
		const isQualified = tracker.unmetCriteria.isEmpty();
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

			const connectAdded = () => {
				if (removingConnection) {
					removingConnection.Disconnect();
					removingConnection = undefined;
				}

				let isScheduled = false;
				addedConnection = instance.DescendantAdded.Connect(() => {
					if (!isScheduled) {
						isScheduled = true;
						task.defer(() => {
							isScheduled = false;

							if (typeGuard(instance)) {
								connectRemoving();
								tracker.unmetCriteria.delete("type guard");
								this.updateListeners(instance, tracker);
							}
						});
					}
				});
			};
			const connectRemoving = () => {
				if (addedConnection) {
					addedConnection.Disconnect();
					addedConnection = undefined;
				}

				let isScheduled = false;
				removingConnection = instance.DescendantRemoving.Connect(() => {
					if (!isScheduled) {
						isScheduled = true;
						task.defer(() => {
							isScheduled = false;

							if (!typeGuard(instance)) {
								connectAdded();
								tracker.unmetCriteria.add("type guard");
								this.updateListeners(instance, tracker);
							}
						});
					}
				});
			};

			tracker.cleanup.add(() => {
				addedConnection?.Disconnect();
				removingConnection?.Disconnect();
			});

			if (tracker.unmetCriteria.has("type guard")) {
				connectAdded();
			} else {
				connectRemoving();
			}
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

				dependency.trackInstance(instance, listener);

				tracker.cleanup.add(() => {
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

	private testInstance(instance: Instance, tracker?: InstanceTracker) {
		let result = true;

		if (!tracker && this.criteria.checkLinks && !this.criteria.checkLinks(instance)) {
			return false;
		}

		if (this.criteria.dependencies) {
			for (const dependency of this.criteria.dependencies) {
				if (!dependency.checkInstance(instance)) {
					result = false;
					if (tracker) {
						tracker.unmetCriteria.add(dependency);
						this.updateListeners(instance, tracker);
					} else {
						return result;
					}
				}
			}
		}

		if (this.criteria.typeGuard) {
			if (!this.criteria.typeGuard(instance)) {
				result = false;
				if (tracker) {
					tracker.unmetCriteria.add("type guard");
					this.updateListeners(instance, tracker);
				} else {
					return result;
				}
			}
		}

		if (this.criteria.tag !== undefined) {
			if (!CollectionService.HasTag(instance, this.criteria.tag)) {
				result = false;
				if (tracker) {
					tracker.unmetCriteria.add("CollectionService tag");
					this.updateListeners(instance, tracker);
				} else {
					return result;
				}
			}
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

	public checkInstance(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);

		if (tracker) {
			return tracker.isQualified;
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
			this.setupTracker(instance, tracker, observeOnly);
		} else if (!observeOnly) {
			// The tracker is already here because a link is watching this instance, which arms no
			// warning of its own: the wait only starts once somebody is actually waiting.
			this.armWarning(instance, tracker);
		}

		tracker.listeners.add(listener);
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

			if (tracker.listeners.isEmpty()) {
				for (const cleanup of tracker.cleanup) {
					cleanup();
				}

				// The warning outlives the tracker it belongs to otherwise, and a link can create a
				// tracker that the tag path later arms, so this is a warning for an instance that
				// nothing is tracking any more.
				if (tracker.timeoutWarningThread) {
					task.cancel(tracker.timeoutWarningThread);
					tracker.timeoutWarningThread = undefined;
				}

				this.instances.delete(instance);
			}
		}
	}
}
