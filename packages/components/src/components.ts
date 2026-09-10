import { Flamework, OnStart, Provider, Reflect, type Modding, getRuntimeConfig } from "@flamework/core";
import {
	CollectionService,
	ReplicatedStorage,
	RunService,
	ServerStorage,
	StarterGui,
	StarterPack,
	StarterPlayer,
} from "@rbxts/services";
import { t } from "@rbxts/t";
import { BaseComponent, ComponentMetadata, SYMBOL_ATTRIBUTE_HANDLERS } from "./baseComponent";
import { ComponentTracker } from "./componentTracker";
import {
	AbstractConstructor,
	AbstractConstructorRef,
	Constructor,
	ConstructorRef,
	getIdFromSpecifier,
	getParentConstructor,
	safeCall,
} from "./utility";
import Maid from "@rbxts/maid";
import Signal from "@rbxts/signal";
import type { ComponentModuleConfig } from "./componentModule";
import { ComponentStreamingMode, type ComponentConfig, type ComponentLink } from "./decorator";
import type { Module } from "@flamework/core";

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	componentDependencies: Constructor[];
	identifier: string;
	config: ComponentConfig;
	polymorphicIds: string[];
	links: ComponentLink[];
	attributeLinks: Map<string, ComponentLink>;
}

/**
 * A link attribute whose instance has not streamed in yet, and the thread parked in
 * `InstanceHandle:Wait` until it does.
 */
interface PendingLink {
	thread?: thread;
	cancelled: boolean;
}

/** How long an unresolved attribute is waited on at a time when its warning is disabled. */
const LINK_POLL_INTERVAL = 5;

/** How a link reads in the warning that lists what a component is still waiting for. */
function describeLink(link: ComponentLink) {
	const target = link.kind === "attribute" ? `attribute '${link.name}'` : `child '${link.name}'`;
	return link.component !== undefined ? `${target} with component '${link.component}'` : target;
}

function cancelPendingLink(pending: PendingLink) {
	pending.cancelled = true;

	const thread = pending.thread;
	const current = coroutine.running();

	// The wait resumes into `resolve`, which releases the link it came from: cancelling there would
	// be cancelling the thread this is running on.
	if (thread !== undefined && thread !== current && coroutine.status(thread) === "suspended") {
		task.cancel(thread);
	}
}

const DEFAULT_ANCESTOR_BLACKLIST = [ServerStorage, ReplicatedStorage, StarterPack, StarterGui, StarterPlayer];

/** The project-wide default from flamework.config.json, falling back to Flamework's own. */
function defaultStreamingMode(): ComponentStreamingMode {
	switch (getRuntimeConfig().components?.streamingMode) {
		case "Disabled":
			return ComponentStreamingMode.Disabled;
		case "Watching":
			return ComponentStreamingMode.Watching;
		case "Contextual":
			return ComponentStreamingMode.Contextual;
		default:
			return ComponentStreamingMode.Default;
	}
}

/**
 * This class is responsible for loading and managing
 * all components in the game.
 */
@Provider()
export class Components {
	private components = new Map<Constructor, ComponentInfo>();
	private classParentCache = new Map<AbstractConstructor, readonly AbstractConstructor[]>();

	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();
	private activeInheritedComponents = new Map<Instance, Map<string, Set<BaseComponent>>>();
	private reverseComponentsMapping = new Map<string, Set<BaseComponent>>();

	/** Components whose constructor is currently running, per instance, to detect cycles. */
	private constructing = new Map<Instance, Set<Constructor>>();

	/**
	 * Components whose removal is running, per instance, so that nothing Flamework builds on its
	 * own can take the place of one that is being taken apart.
	 */
	private removing = new Map<Instance, Set<Constructor>>();

	/**
	 * Components whose links are being read for an instance nobody is tracking, so that a ring of
	 * links -- one naming its own component on its own instance included -- is answered rather than
	 * followed round forever.
	 */
	private checkingLinks = new Map<Instance, Set<Constructor>>();

	private trackers = new Map<Constructor, ComponentTracker>();
	private componentWaiters = new Map<Instance, Map<Constructor, Set<(value: unknown) => void>>>();
	private componentCleanup = new Map<BaseComponent, Maid>();

	private componentAddedListeners = new Map<string, Signal<(value: never, instance: Instance) => void>>();
	private componentRemovedListeners = new Map<string, Signal<(value: never, instance: Instance) => void>>();

	private connections = new Array<RBXScriptConnection>();
	private isStopped = false;

	private componentsIdMapping: Map<string, Constructor>;

	private getComponentsIdMapping() {
		const mapping = new Map<string, Constructor>();
		for (const component of this.config.components) {
			mapping.set(Reflect.getMetadata(component, "identifier")!, component);
		}
		return mapping;
	}

	constructor(
		private module: Module,
		private config: ComponentModuleConfig,
	) {
		const components = new Map<Constructor, ComponentInfo>();

		this.componentsIdMapping = this.getComponentsIdMapping();
		this.components = components;

		for (const ctor of config.components) {
			if (ctor === undefined) {
				continue;
			}

			const identifier = Reflect.getMetadata<string>(ctor, "identifier")!;
			const componentDependencies = new Array<Constructor>();
			const parameters = Reflect.getMetadata<string[]>(ctor, "flamework:parameters");
			if (parameters) {
				for (const dependency of parameters) {
					const object = this.componentsIdMapping.get(dependency);
					if (object !== undefined) {
						componentDependencies.push(object);
					}
				}
			}

			const componentConfig = Reflect.getMetadata<ComponentConfig>(ctor, "flamework:componentConfig");
			const links = componentConfig?.links ?? [];
			const attributeLinks = new Map<string, ComponentLink>();
			for (const link of links) {
				if (link.kind === "attribute") {
					attributeLinks.set(link.name, link);
				}
			}

			components.set(ctor, {
				ctor: ctor as Constructor<BaseComponent>,
				config: componentConfig || {},
				polymorphicIds: this.getPolymorphicIds(ctor),
				componentDependencies,
				attributeLinks,
				identifier,
				links,
			});
		}

		// A link names a component by id, so the component it names has to be registered here too.
		// Unlike a constructor dependency, which is skipped when it is not a component at all,
		// there is nothing else a link could mean.
		for (const [, info] of components) {
			for (const link of info.links) {
				if (link.component === undefined) continue;
				if (this.componentsIdMapping.has(link.component)) continue;

				error(
					`component '${info.identifier}' links to '${link.component}' through ${describeLink(link)}, ` +
						`but that component is not registered in this plugin`,
				);
			}
		}
	}

	/**
	 * Whether the ancestor lists let Flamework construct this component on this instance.
	 *
	 * A whitelist takes priority over the blocklist: with one configured, being inside it is the
	 * whole question and the blocklist is not consulted.
	 */
	private passesAncestorLists(componentInfo: ComponentInfo, instance: Instance) {
		const { config } = componentInfo;

		const isWhitelisted = config.ancestorWhitelist?.some((ancestor) => instance.IsDescendantOf(ancestor));
		if (isWhitelisted !== undefined) return isWhitelisted;

		const ancestorBlacklist = config.ancestorBlacklist ?? DEFAULT_ANCESTOR_BLACKLIST;
		return !ancestorBlacklist.some((ancestor) => instance.IsDescendantOf(ancestor));
	}

	/** @internal */
	public startCollectionService() {
		for (const [, componentInfo] of this.components) {
			const { config, ctor } = componentInfo;

			if (config.tag !== undefined) {
				const tag = config.tag;
				const tracker = this.getComponentTracker(ctor);
				const predicate = this.getConfigValue(ctor, "predicate");

				const listener = (isQualified: boolean, instance: Instance) => {
					if (isQualified) {
						this.addComponent(instance, ctor, true);
					} else {
						this.removeComponent(instance, ctor);
					}
				};

				const instanceAdded = (instance: Instance) => {
					// CollectionService signals are deferred in most places, so by the time this runs the tag
					// can already be gone again (or the instance destroyed). Trusting the event here would
					// re-qualify the instance and construct a component for an untagged instance.
					//
					// The DataModel is what a tag is announced by, so it is what is asked about here:
					// an instance can have a parent and still be nowhere the tag was announced from --
					// a descendant of a tree that has been pooled by unparenting it, or a template
					// being assembled before it is dropped in.
					if (!instance.IsDescendantOf(game) || !CollectionService.HasTag(instance, tag)) {
						return;
					}

					// Recorded before the filters rather than after them: the criterion is a cache of
					// `HasTag`, and every entry this tracker holds is answered from it -- including
					// one a link created for an instance this component may never be constructed on.
					// Leaving it behind is what makes such an entry stale, and a stale entry is then
					// what `getComponent` is answered with.
					tracker.setHasTag(instance, true);

					// A filtered instance never reaches `trackInstance`, so nothing else here brings
					// an entry a link created up to date -- and on a realm that does not poll the
					// tree, nothing ever will. Leaving it is what freezes an instance guard that
					// failed while the tree was still filling in, and `getComponent` is then
					// answered from it: a link watching an instance would change the answer.
					if (predicate !== undefined && !predicate(instance)) {
						tracker.refreshInstance(instance);
						return;
					}

					if (!this.passesAncestorLists(componentInfo, instance)) {
						tracker.refreshInstance(instance);
						return;
					}

					tracker.trackInstance(instance, listener);
				};

				this.connections.push(CollectionService.GetInstanceAddedSignal(tag).Connect(instanceAdded));
				this.connections.push(
					CollectionService.GetInstanceRemovedSignal(tag).Connect((instance) => {
						// The same deferral can deliver a removal for a tag that has since been added back;
						// that instance keeps its component. Being back in the DataModel is half of that:
						// a removal announced because the instance left it stands, however tagged the
						// instance still is, and whether it lost its own parent or an ancestor's.
						if (instance.IsDescendantOf(game) && CollectionService.HasTag(instance, tag)) {
							return;
						}

						tracker.untrackInstance(instance, listener);
						tracker.setHasTag(instance, false);
						this.removeComponent(instance, ctor);
					}),
				);

				for (const instance of CollectionService.GetTagged(tag)) {
					safeCall(
						[`[Flamework] Failed to instantiate '${ctor}' for`, instance, `[${instance.GetFullName()}]`],
						() => instanceAdded(instance),
						false,
					);
				}
			}
		}
	}

	/**
	 * Stops watching CollectionService, destroys every active component and releases the trackers.
	 *
	 * Called by the component plugin when the owning module extinguishes, so that a dead module
	 * neither keeps its components alive nor constructs new ones.
	 *
	 * @internal
	 */
	public stopCollectionService() {
		this.isStopped = true;

		for (const connection of this.connections) {
			connection.Disconnect();
		}
		this.connections.clear();

		// One component's teardown must not leave the rest of the module standing. A `destroy` that
		// raises is reported and the next component comes down anyway, so the trackers below are
		// released either way -- otherwise the raise left every tracker's tree connections and
		// warning timers attached to a module that says it is gone.
		for (const [instance, active] of [...this.activeComponents]) {
			for (const [ctor] of [...active]) {
				const [success, err] = pcall(() => this.removeComponent(instance, ctor as Constructor<BaseComponent>));

				if (!success) {
					warn(`[Flamework] Failed to remove '${ctor}' from ${instance.GetFullName()}: ${tostring(err)}`);
				}
			}
		}

		for (const [, tracker] of this.trackers) {
			tracker.dispose();
		}
		this.trackers.clear();
		this.componentWaiters.clear();
	}

	private getComponentTracker(component: Constructor) {
		const existingTracker = this.trackers.get(component);
		if (existingTracker) return existingTracker;

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided component does not exist");

		const instanceGuard = this.getConfigValue(component, "instanceGuard");
		const dependencies = new Array<ComponentTracker>();

		for (const dependency of componentInfo.componentDependencies) {
			dependencies.push(this.getComponentTracker(dependency));
		}

		const hasLinks = componentInfo.links.size() !== 0;
		const streamingMode = componentInfo.config.streamingMode ?? defaultStreamingMode();

		// Whether this component re-reads its instance tree at all. A child link is part of that
		// tree, so it follows the same rule the instance guard does: under `Disabled` the tree is
		// read once and the answer kept, however the children move afterwards.
		const pollsTree =
			(streamingMode === ComponentStreamingMode.Contextual && RunService.IsClient()) ||
			streamingMode === ComponentStreamingMode.Watching;

		const tracker = new ComponentTracker(componentInfo.identifier, {
			checkLinks: hasLinks ? (instance) => this.areLinksMet(componentInfo, instance) : undefined,
			watchLinks: hasLinks
				? (instance, update) => this.watchLinks(componentInfo, instance, update, pollsTree)
				: undefined,
			linksMet: hasLinks ? (instance) => this.areLinksMet(componentInfo, instance) : undefined,
			tag: componentInfo.config.tag,
			typeGuard: instanceGuard,
			typeGuardPoll: pollsTree,
			typeGuardPollAtomic: streamingMode !== ComponentStreamingMode.Contextual,
			warningTimeout: componentInfo.config.warningTimeout ?? getRuntimeConfig().components?.warningTimeout,
			dependencies,
		});

		this.trackers.set(component, tracker);
		return tracker;
	}

	/**
	 * The instance a link points at, or nothing when it has not resolved yet. An instance-valued
	 * attribute holds an `InstanceHandle`, which stays empty until the instance it names has
	 * streamed in at least once.
	 */
	private resolveLinkTarget(instance: Instance, componentInfo: ComponentInfo, link: ComponentLink) {
		if (link.kind === "child") {
			return instance.FindFirstChild(link.name);
		}

		const handle = instance.GetAttribute(link.name);
		if (typeIs(handle, "InstanceHandle")) {
			return handle.Get();
		}

		// A default stands in for an attribute that was never written, as it does for a plain one.
		// It has to be read here rather than left to `getAttributes`, which only runs once the
		// component is being built -- and a required link would hold that up forever.
		//
		// An optional one holds nothing up, so it needs no standing in: `getAttributes` writes its
		// default to the instance like any other, and after that the attribute is the whole story.
		// Answering with the default here as well is what would make clearing such an attribute
		// impossible -- cleared and never written are the same nothing on an instance, so the
		// default would simply be read back.
		if (link.optional) return undefined;

		const fallback = this.getConfigValue(componentInfo.ctor, "defaults")?.[link.name];
		return typeIs(fallback, "Instance") ? fallback : undefined;
	}

	/** Whether a component is attached to an instance, without constructing one. */
	private hasComponent(instance: Instance, component: Constructor) {
		return this.activeComponents.get(instance)?.get(component) !== undefined;
	}

	private passesLinkGuard(link: ComponentLink, target: Instance) {
		return link.guard === undefined || link.guard(target);
	}

	private getLinkedComponent(link: ComponentLink) {
		const component = this.componentsIdMapping.get(link.component!);
		assert(component, `Component '${link.component}' is linked but not registered`);

		return component;
	}

	/**
	 * The component a link names on an instance, constructing one only where a link is allowed to.
	 *
	 * `getComponent` ignores the ancestor lists on purpose -- asking by hand is how you get past
	 * them -- while a link is Flamework driving construction and goes through them, exactly as the
	 * criterion that decided the link was met did. Going straight to `getComponent` here is what
	 * would build a component under a blocked ancestor for a link that is not even met.
	 */
	private resolveLinkedComponent(target: Instance, component: Constructor) {
		const existing = this.activeComponents.get(target)?.get(component);
		if (existing !== undefined) return existing;

		if (this.canCreateComponentEager(target, component, true) !== true) return undefined;

		return this.getComponent(target, component);
	}

	/**
	 * Watches an instance's tree, calling `changed` on a deferred task so that a burst of changes
	 * costs one call.
	 *
	 * This is the shape the tracker's own instance-guard poll has, for the same reason: a structural
	 * guard is answered by children that may not have arrived yet. Returns the cleanup.
	 */
	private watchInstanceTree(instance: Instance, changed: () => void) {
		let isScheduled = false;
		let isReleased = false;

		const schedule = () => {
			if (isScheduled || isReleased) return;
			isScheduled = true;

			task.defer(() => {
				isScheduled = false;
				if (!isReleased) changed();
			});
		};

		const added = instance.DescendantAdded.Connect(schedule);
		const removing = instance.DescendantRemoving.Connect(schedule);

		return () => {
			isReleased = true;
			added.Disconnect();
			removing.Disconnect();
		};
	}

	private getAttributeWarningTimeout(componentInfo: ComponentInfo) {
		const config = getRuntimeConfig().components;

		return (
			this.getConfigValue(componentInfo.ctor, "attributeWarningTimeout") ??
			this.getConfigValue(componentInfo.ctor, "warningTimeout") ??
			config?.attributeWarningTimeout ??
			config?.warningTimeout ??
			5
		);
	}

	/**
	 * Whether one link is met on this instance right now, read from the instance rather than from
	 * whatever the link last reported.
	 *
	 * This is the question `watchLink`'s `refresh` answers, and the one `resolveLinks` has to agree
	 * with: an instance that is there, passes the guard, and either already carries the component
	 * the link names or is somewhere Flamework would build one.
	 */
	private isLinkMet(componentInfo: ComponentInfo, instance: Instance, link: ComponentLink) {
		const target = this.resolveLinkTarget(instance, componentInfo, link);
		if (target === undefined) return link.optional;

		if (!this.passesLinkGuard(link, target)) return false;
		if (link.component === undefined) return true;

		const linkedComponent = this.getLinkedComponent(link);
		return (
			this.hasComponent(target, linkedComponent) ||
			this.canCreateComponentEager(target, linkedComponent, true) === true
		);
	}

	/**
	 * Whether every link of a component is met on this instance right now.
	 *
	 * A watched link is a subscription, and a subscription only answers for the changes it is told
	 * about: the engine defers the child signals, so one link is asked to rebuild the component
	 * while the signal that would have unmet another is still queued behind it, and a child renamed
	 * rather than moved fires nothing at all. The tracker reads this at the moment it would
	 * qualify, which is the moment the difference between what the links reported and what the tree
	 * holds stops being harmless: `resolveLinks` reads that tree next.
	 *
	 * It is also the answer for an instance nobody is tracking, where there is nothing watching and
	 * nothing to wait on. The two used to differ -- an untracked instance's links had to name a
	 * component that already existed, rather than one Flamework would build -- and that is what made
	 * `getComponent` refuse a freshly tagged tree whose links `resolveLinks` would have built a
	 * moment later, in the same resumption, for the very same instance.
	 *
	 * A link may reach for a component whose own links are still being decided, so this can come
	 * back round to the question it started from: a ring of links, of which one naming its own
	 * component on its own instance is the shortest. Nothing in such a ring exists yet, so none of
	 * it can be built out of nothing, and the second arrival is answered `false` rather than
	 * recursing -- which is the same answer the tracker's provisional entry gives for the tracked
	 * side of it.
	 */
	private areLinksMet(componentInfo: ComponentInfo, instance: Instance) {
		let checking = this.checkingLinks.get(instance);
		if (checking?.has(componentInfo.ctor)) return false;

		if (!checking) this.checkingLinks.set(instance, (checking = new Set()));
		checking.add(componentInfo.ctor);

		try {
			for (const link of componentInfo.links) {
				if (!this.isLinkMet(componentInfo, instance, link)) return false;
			}
		} finally {
			checking.delete(componentInfo.ctor);

			if (checking.isEmpty()) {
				this.checkingLinks.delete(instance);
			}
		}

		return true;
	}

	/**
	 * Watches every link of a component on one instance, so that the component exists only while
	 * the instances and components it names do.
	 */
	private watchLinks(
		componentInfo: ComponentInfo,
		instance: Instance,
		update: (criterion: string, isMet: boolean) => void,
		pollsTree: boolean,
	) {
		const maid = new Maid();

		for (const link of componentInfo.links) {
			this.watchLink(componentInfo, instance, link, update, maid, pollsTree);
		}

		return () => maid.Destroy();
	}

	private watchLink(
		componentInfo: ComponentInfo,
		instance: Instance,
		link: ComponentLink,
		update: (criterion: string, isMet: boolean) => void,
		maid: Maid,
		pollsTree: boolean,
	) {
		const criterion = describeLink(link);

		// `refreshAttributes: false` freezes a link attribute the way it freezes a plain one: the
		// criterion behind the link is still watched -- re-pointing one at something its guard
		// refuses still takes the component down -- it is the component's view that stops moving.
		const tracksAttributes = this.getConfigValue(componentInfo.ctor, "refreshAttributes") !== false;

		let targetMaid: Maid | undefined;
		let pending: PendingLink | undefined;
		let lastTarget: Instance | undefined;
		let hasResolved = false;

		// A component outlives the watcher that follows its tree. The eager path builds one the
		// moment somebody asks for it, while the tag that creates this entry -- and with it these
		// watchers -- is announced a resumption later, and the tree can have moved in between: the
		// place that swapped the child did so before anything was watching for it.
		//
		// So the child a link starts from is the one the live component actually holds, read from
		// the component rather than from the instance. Starting from the tree instead is what
		// records the swap as the state the component was built from, leaving it running against a
		// tree it was never built out of and never rebuilding it. A link that does not follow the
		// tree keeps the child it was built with whatever happens, so there is nothing to notice.
		if (link.kind === "child" && pollsTree) {
			const built = this.activeComponents.get(instance)?.get(componentInfo.ctor);
			if (built !== undefined) {
				const linked = (built.childComponents as unknown as Map<string, BaseComponent>).get(link.name);

				hasResolved = true;
				lastTarget = linked?.instance;
			}
		}

		const release = () => {
			targetMaid?.Destroy();
			targetMaid = undefined;

			if (pending !== undefined) {
				cancelPendingLink(pending);
				pending = undefined;
			}
		};

		/**
		 * Records what the link resolved to, taking the component down first when that changed.
		 *
		 * A child is part of the instance tree, so a different child is a different tree and the
		 * component is rebuilt around it. That includes the child of an optional link arriving or
		 * leaving, which never holds construction up and would otherwise leave `childComponents`
		 * naming an instance the tree no longer holds. Signals are deferred, so a child swapped out
		 * and back within one resumption arrives as a single change with a new instance on the end
		 * of it. An attribute is a pointer with an event of its own, so re-pointing one updates in
		 * place instead of rebuilding.
		 */
		const noteTarget = (target: Instance | undefined) => {
			if (link.kind === "child" && hasResolved && lastTarget !== target) {
				update(criterion, false);
			}

			hasResolved = true;
			lastTarget = target;
		};

		const resolve = () => {
			release();

			const target = this.resolveLinkTarget(instance, componentInfo, link);
			if (target === undefined) {
				noteTarget(undefined);
				update(criterion, link.optional);

				// The attribute names an instance that has never streamed in, which is what
				// `InstanceHandle:Wait` is for; it resumes once it has, however long that takes.
				if (link.kind === "attribute") {
					pending = this.waitForLinkAttribute(componentInfo, instance, link, resolve);
				}

				return;
			}

			noteTarget(target);

			const linkedComponent = link.component !== undefined ? this.getLinkedComponent(link) : undefined;

			// Whether the target is everything the link asks of it right now: the shape its guard
			// describes, and the component it names being there or being one Flamework would build
			// there. Asking the tracker alone would leave out the predicate and the ancestry weighed
			// here as well, and report a link met that then throws out of the very construction it
			// asked for. A component with no tag only exists once somebody adds it, which is what
			// `hasComponent` is for -- and it is also what lets a component already attached under a
			// blocked ancestor satisfy a link the ancestor lists would not build.
			const refresh = () => {
				if (!this.passesLinkGuard(link, target)) {
					return update(criterion, false);
				}

				// A handle that fills in after the component was built changes nothing on the
				// instance, so no attribute signal reports it; this is the only place that notices.
				// It matters for an optional link, which does not hold construction up in the first
				// place.
				if (link.kind === "attribute" && tracksAttributes) {
					this.refreshLinkAttribute(instance, componentInfo, link);
				}

				// The target may not have moved while the component on it was replaced, which is
				// what a removal and the rebuild behind it look like once they are delivered. Every
				// other path here is keyed on the target instance changing, so this is what keeps
				// the owner from holding on to the component that left. `refreshAttributes: false`
				// freezes an attribute link's view of it, as it freezes the rest.
				if (link.kind !== "attribute" || tracksAttributes) {
					this.refreshLinkedComponent(instance, componentInfo, link, target);
				}

				update(
					criterion,
					linkedComponent === undefined ||
						this.hasComponent(target, linkedComponent) ||
						this.canCreateComponentEager(target, linkedComponent, true) === true,
				);
			};

			targetMaid = new Maid();

			// The guard is a criterion rather than an answer given once. It carries the whole shape
			// the target has to have, and that shape can arrive -- or break -- long after the
			// attribute naming the instance was written, which is what a link to a component whose
			// own tree fills in late looks like. Only an attribute link carries a guard; a child's
			// shape is already part of its owner's instance guard.
			if (link.guard !== undefined) {
				targetMaid.GiveTask(this.watchInstanceTree(target, refresh));
			}

			if (linkedComponent === undefined) {
				refresh();
				return;
			}

			const tracker = this.getComponentTracker(linkedComponent);

			// Observing, not waiting: this component's own tracker is the one that reports the link
			// as a criterion it is still missing.
			const listener = () => refresh();
			tracker.trackInstance(target, listener, true);
			targetMaid.GiveTask(() => tracker.untrackInstance(target, listener));

			let addedSignal = this.componentAddedListeners.get(link.component!);
			if (!addedSignal) this.componentAddedListeners.set(link.component!, (addedSignal = new Signal()));

			let removedSignal = this.componentRemovedListeners.get(link.component!);
			if (!removedSignal) this.componentRemovedListeners.set(link.component!, (removedSignal = new Signal()));

			targetMaid.GiveTask(
				addedSignal.Connect((_, changed) => {
					if (changed === target) refresh();
				}),
			);

			// A component announces its removal under every id it inherits, so a subclass leaving
			// reaches the signal its parent class is named by; the class of the component that
			// actually left is what tells the two apart. It has to come from the value itself,
			// because these signals are BindableEvents: the engine defers them, so by the time this
			// arrives the component is already out of the active map and cannot be looked up. That
			// deferral is also why this cannot go back through `refresh`, which would say the link
			// is still met whenever the tag that would rebuild it is still there.
			targetMaid.GiveTask(
				removedSignal.Connect((removed: object, changed) => {
					if (changed !== target) return;
					if (getmetatable(removed) !== linkedComponent) return;

					// The same deferral is why the announcement has to be weighed against the
					// target as it stands now. A hand removal leaves the tag and every criterion
					// alone, so the same resumption can ask for the component again and get a new
					// one; the removal then arrives about a component that has already been
					// replaced. Acting on it is what turns a ring of links into a rebuild without
					// end -- each side's stale removal takes the other down, and the rebuild that
					// follows queues the next one -- while the link it is reporting lost is, on the
					// instance itself, still met.
					if (this.hasComponent(target, linkedComponent)) return;

					update(criterion, false);
				}),
			);

			refresh();
		};

		maid.GiveTask(release);

		if (link.kind === "attribute") {
			// An attribute is not part of the tree, so it is followed whatever the streaming mode.
			maid.GiveTask(instance.GetAttributeChangedSignal(link.name).Connect(resolve));
		} else if (pollsTree) {
			const childChanged = (child: Instance) => {
				if (child.Name === link.name) resolve();
			};

			maid.GiveTask(instance.ChildAdded.Connect(childChanged));
			maid.GiveTask(instance.ChildRemoved.Connect(childChanged));
		}

		resolve();
	}

	/**
	 * Waits for the instance an attribute names to stream in, warning once the wait has gone on
	 * too long -- which is usually an attribute pointing at something that will never arrive.
	 */
	private waitForLinkAttribute(
		componentInfo: ComponentInfo,
		instance: Instance,
		link: ComponentLink,
		resolved: () => void,
	): PendingLink | undefined {
		const handle = instance.GetAttribute(link.name);
		if (!typeIs(handle, "InstanceHandle")) return undefined;

		const timeout = this.getAttributeWarningTimeout(componentInfo);
		const pending: PendingLink = { cancelled: false };

		pending.thread = task.spawn(() => {
			let warned = false;

			while (!pending.cancelled) {
				if (handle.Wait(timeout > 0 ? timeout : LINK_POLL_INTERVAL) !== undefined) {
					pending.thread = undefined;
					if (!pending.cancelled) resolved();

					return;
				}

				if (timeout > 0 && !warned) {
					warned = true;

					warn(`[Flamework] Infinite yield possible on attribute '${link.name}' of instance`);
					warn(`'${instance.GetFullName()}', which component '${componentInfo.identifier}' links to`);
					warn(`The instance it names has not streamed in`);
				}
			}
		});

		return pending;
	}

	/**
	 * Resolves every link for a component that is about to be constructed, filling in the instances
	 * its attributes name and the components it is linked to.
	 */
	private resolveLinks(instance: Instance, componentInfo: ComponentInfo, attributes: Map<string, unknown>) {
		const childComponents = new Map<string, unknown>();
		const attributeComponents = new Map<string, unknown>();

		for (const link of componentInfo.links) {
			const target = this.resolveLinkTarget(instance, componentInfo, link);
			if (target === undefined) {
				if (link.optional) {
					if (link.kind === "attribute") attributes.delete(link.name);
					continue;
				}

				throw `${instance.GetFullName()} has no instance for ${describeLink(link)} of '${componentInfo.identifier}'`;
			}

			if (!this.passesLinkGuard(link, target)) {
				throw `${target.GetFullName()} did not pass the guard for ${describeLink(link)} of '${componentInfo.identifier}'`;
			}

			// The attribute is stored as a handle; the component sees the instance it resolves to.
			if (link.kind === "attribute") attributes.set(link.name, target);

			if (link.component !== undefined) {
				const linked = this.resolveLinkedComponent(target, this.getLinkedComponent(link));
				if (linked === undefined) {
					throw `${target.GetFullName()} has no component for ${describeLink(link)} of '${componentInfo.identifier}'`;
				}

				const holder = link.kind === "attribute" ? attributeComponents : childComponents;
				holder.set(link.name, linked);
			}
		}

		return { childComponents, attributeComponents };
	}

	/**
	 * Brings a component's view of one link attribute back in line with the instance, firing
	 * `onAttributeChanged` with the instances rather than the handles.
	 *
	 * A target that no longer qualifies is left alone: the tracker sees the same change and removes
	 * the component, rather than leaving it running against a half-updated link.
	 *
	 * `notify` is what `refreshAttributes: false` switches off. The component's view still moves
	 * for a write it made itself -- a plain attribute's own write lands the same way -- but a
	 * component that tracks no attributes announces none either.
	 */
	private refreshLinkAttribute(instance: Instance, componentInfo: ComponentInfo, link: ComponentLink, notify = true) {
		const component = this.activeComponents.get(instance)?.get(componentInfo.ctor);
		if (component === undefined) return;

		const attributes = component.attributes as unknown as Map<string, unknown>;
		const previous = attributes.get(link.name);
		const target = this.resolveLinkTarget(instance, componentInfo, link);
		if (previous === target) return;

		if (target !== undefined) {
			if (!this.passesLinkGuard(link, target)) return;

			if (link.component !== undefined) {
				const linked = this.resolveLinkedComponent(target, this.getLinkedComponent(link));
				if (linked === undefined) return;

				(component.attributeComponents as unknown as Map<string, unknown>).set(link.name, linked);
			}
		} else {
			if (!link.optional) return;

			(component.attributeComponents as unknown as Map<string, unknown>).delete(link.name);
		}

		attributes.set(link.name, target);

		if (notify) {
			component[SYMBOL_ATTRIBUTE_HANDLERS].get(link.name)?.Fire(target, previous);
		}
	}

	/**
	 * Puts a built component's view of the component one of its links names back in step, for a
	 * target instance that has not moved.
	 *
	 * A removal and the rebuild that follows it are announced separately and delivered a resumption
	 * late, so the link itself is never lost -- the target carries a component of the class it names
	 * both before and after -- while the component the owner holds is the one that left.
	 */
	private refreshLinkedComponent(
		instance: Instance,
		componentInfo: ComponentInfo,
		link: ComponentLink,
		target: Instance,
	) {
		if (link.component === undefined) return;

		const component = this.activeComponents.get(instance)?.get(componentInfo.ctor);
		if (component === undefined) return;

		const linked = this.activeComponents.get(target)?.get(this.getLinkedComponent(link));
		if (linked === undefined) return;

		const holder = (link.kind === "attribute"
			? component.attributeComponents
			: component.childComponents) as unknown as Map<string, unknown>;

		if (holder.get(link.name) !== linked) {
			holder.set(link.name, linked);
		}
	}

	/**
	 * The write path behind `this.attributes.speed = 32`.
	 *
	 * Every write is checked against the guard the attribute was accepted with, so a value that only
	 * typechecked because of a cast raises where it was written instead of quietly leaving the
	 * component holding something its own declared type says is impossible -- and leaving that value
	 * on the instance, where it would reject the component the next time one is built.
	 *
	 * An instance-valued attribute is stored as a handle, which is a write this does itself; the
	 * return value says whether the key was handled here, so a plain one falls through to the
	 * component's own write.
	 */
	private createAttributeWriter(
		componentInfo: ComponentInfo,
		instance: Instance,
		guards: Map<string, t.check<unknown>>,
	) {
		if (guards.isEmpty() && componentInfo.attributeLinks.size() === 0) return undefined;

		// A link key is written here rather than by the component, so this is the only path that
		// could still announce one with tracking off: the external re-point is already silent in
		// `refresh`, and the instance's own attribute signal is not even connected.
		const tracksAttributes = this.getConfigValue(componentInfo.ctor, "refreshAttributes") !== false;

		return (key: string, value: unknown) => {
			const link = componentInfo.attributeLinks.get(key);
			if (link === undefined) {
				const guard = guards.get(key);
				if (guard !== undefined && !guard(value)) {
					error(
						`'${tostring(value)}' is not a valid value for attribute '${key}' of '${componentInfo.identifier}'`,
					);
				}

				return false;
			}

			if (value === undefined) {
				if (!link.optional) {
					error(`attribute '${key}' of '${componentInfo.identifier}' is required and cannot be cleared`);
				}

				instance.SetAttribute(key, undefined);
			} else {
				if (!typeIs(value, "Instance") || !this.passesLinkGuard(link, value)) {
					error(
						`'${tostring(value)}' did not pass the guard for attribute '${key}' of '${componentInfo.identifier}'`,
					);
				}

				// The instance is the right shape but has no component on it yet, which is a matter
				// of timing rather than a mistake in the value. Writing it anyway would unqualify
				// this component and destroy it mid-write, so the write is refused and said out
				// loud instead -- wait for the component first, then assign.
				if (
					link.component !== undefined &&
					this.resolveLinkedComponent(value, this.getLinkedComponent(link)) === undefined
				) {
					warn(
						`[Flamework] ${value.GetFullName()} has no component '${link.component}', which attribute`,
						`'${key}' of '${componentInfo.identifier}' links to; the attribute was left alone`,
					);
					warn(`Wait for the component with Components.waitForComponent before writing the attribute`);

					return true;
				}

				instance.SetAttribute(key, new InstanceHandle(value));
			}

			// Attribute signals are deferred, so the component would otherwise not see its own
			// write until the next resumption. With tracking off the write still lands -- as a
			// plain attribute's own write does -- and, like a plain one, it announces nothing.
			this.refreshLinkAttribute(instance, componentInfo, link, tracksAttributes);

			return true;
		};
	}

	private getOrderedParents(ctor: AbstractConstructor, omitBaseComponent = true) {
		const cache = this.classParentCache.get(ctor);
		if (cache) return cache;

		const classes = [ctor];
		let nextParent: AbstractConstructor | undefined = ctor;
		while ((nextParent = getParentConstructor(nextParent)) !== undefined) {
			if (!omitBaseComponent || nextParent !== BaseComponent) {
				classes.push(nextParent);
			}
		}

		this.classParentCache.set(ctor, classes);
		return classes;
	}

	private getAttributeGuards(ctor: AbstractConstructor) {
		const attributes = new Map<string, t.check<unknown>>();
		const metadata = this.components.get(ctor as Constructor);
		if (metadata) {
			if (metadata.config.attributes !== undefined) {
				for (const [attribute, guard] of pairs(metadata.config.attributes)) {
					attributes.set(attribute as string, guard);
				}
			}
			const parentCtor = getmetatable(ctor) as { __index?: AbstractConstructor };
			if (parentCtor.__index !== undefined) {
				for (const [attribute, guard] of this.getAttributeGuards(parentCtor.__index)) {
					if (!attributes.has(attribute)) {
						attributes.set(attribute, guard);
					}
				}
			}
		}
		return attributes;
	}

	private getAttributes(instance: Instance, componentInfo: ComponentInfo, guards: Map<string, t.check<unknown>>) {
		const attributes = instance.GetAttributes() as Map<string, unknown>;
		const newAttributes = new Map<string, unknown>();
		const defaults = this.getConfigValue(componentInfo.ctor, "defaults");

		for (const [key, guard] of pairs(guards)) {
			const attribute = attributes.get(key);
			const isLink = componentInfo.attributeLinks.has(key);

			// A link attribute that was never written takes its default even though its guard is
			// happy without it, which an optional link's is. The default is meant to be written to
			// the instance as a handle, exactly as a required link's is: filling the component's
			// view alone would leave the two disagreeing about what the link names.
			const isMissingLink = isLink && attribute === undefined;

			if (guard(attribute) && !(isMissingLink && defaults?.[key] !== undefined)) {
				newAttributes.set(key, attribute);
				continue;
			}

			if (defaults?.[key] !== undefined) {
				// A link's default is written as the instance it names, but stored the way
				// every other instance-valued attribute is.
				const value = defaults[key];

				newAttributes.set(key, value);
				instance.SetAttribute(
					key,
					(isLink && typeIs(value, "Instance") ? new InstanceHandle(value) : value) as never,
				);
			} else {
				throw `${instance.GetFullName()} has invalid attribute '${key}' for '${componentInfo.identifier}'`;
			}
		}

		return newAttributes;
	}

	private getConfigValue<T extends keyof ComponentConfig>(ctor: AbstractConstructor, key: T): ComponentConfig[T] {
		const metadata = this.components.get(ctor as Constructor);
		if (metadata) {
			if (metadata.config[key] !== undefined) {
				return metadata.config[key];
			}
			const parentCtor = getmetatable(ctor) as { __index?: AbstractConstructor };
			if (parentCtor.__index !== undefined) {
				return this.getConfigValue(parentCtor.__index, key);
			}
		}
	}

	private setupComponent(
		instance: Instance,
		attributes: Map<string, unknown>,
		component: BaseComponent,
		componentInfo: ComponentInfo,
	) {
		const { ctor } = componentInfo;

		if (Flamework.implements<OnStart>(component)) {
			safeCall(
				[`[Flamework] Component '${ctor}' failed to start for`, instance, `[${instance.GetFullName()}]`],
				() => component.onStart(),
			);
		}

		const maid = new Maid();
		this.componentCleanup.set(component, maid);

		const refreshAttributes = this.getConfigValue(ctor, "refreshAttributes");
		if (refreshAttributes === undefined || refreshAttributes) {
			const attributeCache = table.clone(attributes);
			const attributeGuards = this.getAttributeGuards(ctor);
			for (const [attribute, guard] of pairs(attributeGuards)) {
				if (typeIs(attribute, "string")) {
					const link = componentInfo.attributeLinks.get(attribute);

					maid.GiveTask(
						instance.GetAttributeChangedSignal(attribute).Connect(() => {
							// A link is stored as a handle and read as the instance it resolves to,
							// which is a different update from a plain attribute's.
							if (link !== undefined) {
								return this.refreshLinkAttribute(instance, componentInfo, link);
							}

							const signal = component[SYMBOL_ATTRIBUTE_HANDLERS].get(attribute);
							const value = instance.GetAttribute(attribute);
							const attributes = component.attributes as Map<string, unknown>;
							if (guard(value)) {
								attributes.set(attribute, value);
								signal?.Fire(value, attributeCache.get(attribute));
								attributeCache.set(attribute, value);
							}
						}),
					);
				}
			}
		}

		const instanceWaiters = this.componentWaiters.get(instance);
		const componentWaiters = instanceWaiters?.get(ctor);
		if (componentWaiters) {
			instanceWaiters!.delete(ctor);

			if (instanceWaiters!.size() === 0) {
				this.componentWaiters.delete(instance);
			}

			for (const waiter of componentWaiters) {
				waiter(component);
			}
		}
	}

	private addIdMapping(value: BaseComponent, id: string, inheritedComponents: Map<string, Set<BaseComponent>>) {
		let instances = inheritedComponents.get(id);
		if (!instances) inheritedComponents.set(id, (instances = new Set()));

		let inheritedLookup = this.reverseComponentsMapping.get(id);
		if (!inheritedLookup) this.reverseComponentsMapping.set(id, (inheritedLookup = new Set()));

		instances.add(value);
		inheritedLookup.add(value);
	}

	private removeIdMapping(instance: Instance, value: BaseComponent, id: string) {
		const inheritedComponents = this.activeInheritedComponents.get(instance);
		if (!inheritedComponents) return;

		const instances = inheritedComponents.get(id);
		if (!instances) return;

		const inheritedLookup = this.reverseComponentsMapping.get(id);
		if (!inheritedLookup) return;

		instances.delete(value);
		inheritedLookup.delete(value);

		if (inheritedLookup.size() === 0) {
			this.reverseComponentsMapping.delete(id);
		}

		if (instances.size() === 0) {
			inheritedComponents.delete(id);
		}

		if (inheritedComponents.size() === 0) {
			this.activeInheritedComponents.delete(instance);
		}
	}

	/**
	 * Whether `getComponent` would construct this component here: the instance is in the DataModel,
	 * tagged, past the predicate and qualified.
	 *
	 * `checkAncestors` adds the ancestor lists on top. They gate construction Flamework drives, so
	 * a link goes through them the way the tag that would build the component does, while
	 * `getComponent` does not -- asking by hand is how you get past them.
	 */
	private canCreateComponentEager(instance: Instance, component: Constructor, checkAncestors = false) {
		const componentInfo = this.components.get(component);
		if (!componentInfo) return false;

		// A component that is being removed is not one that can be built here, however qualified
		// the instance still is: a hand removal leaves the tag and the tracker alone, so every
		// criterion still says yes while the component it would build is the one being destroyed.
		if (this.isRemoving(instance, component)) {
			return false;
		}

		// The predicate gates eager construction too, as it did in v1; otherwise `getComponent`
		// would construct a component for an instance the predicate rejected.
		const predicate = this.getConfigValue(component, "predicate");
		if (predicate !== undefined && !predicate(instance)) {
			return false;
		}

		if (checkAncestors && !this.passesAncestorLists(componentInfo, instance)) {
			return false;
		}

		const tag = componentInfo.config.tag;
		if (tag !== undefined && instance.IsDescendantOf(game) && CollectionService.HasTag(instance, tag)) {
			const tracker = this.getComponentTracker(component);
			return tracker.checkInstance(instance);
		}
	}

	private isConstructing(instance: Instance, component: Constructor) {
		return this.constructing.get(instance)?.has(component) === true;
	}

	private isRemoving(instance: Instance, component: Constructor) {
		return this.removing.get(instance)?.has(component) === true;
	}

	private getDependencyResolutionOptions(
		componentInfo: ComponentInfo,
		instance: Instance,
		metadata: ComponentMetadata,
	) {
		return {
			overrideDependency: (info: Modding.DependencyInfo) => {
				if (info.id === Flamework.id<ComponentMetadata>()) {
					return metadata;
				}

				const dependency = this.componentsIdMapping.get(info.id);
				if (dependency !== undefined) {
					const component = this.getComponent(instance, dependency);
					if (component === undefined) {
						const name = instance.GetFullName();
						throw `Could not resolve component '${info.id}' while constructing '${componentInfo.identifier}' (${name})`;
					}

					return component;
				}
			},
		};
	}

	private getPolymorphicIds(component: AbstractConstructor) {
		const ids = new Array<string>();

		for (const parentClass of this.getOrderedParents(component)) {
			const parentId = Reflect.getOwnMetadata<string>(parentClass, "identifier");
			if (parentId === undefined) continue;

			ids.push(parentId);
		}

		const implementedList = Reflect.getMetadatas<string[]>(component, "flamework:implements");
		for (const implemented of implementedList) {
			for (const id of implemented) {
				ids.push(id);
			}
		}

		return ids;
	}

	private getComponentFromSpecifier<T extends AbstractConstructorRef<unknown>>(componentSpecifier?: T) {
		return typeIs(componentSpecifier, "string")
			? (this.componentsIdMapping.get(componentSpecifier) as object as Extract<T, AbstractConstructor>)
			: (componentSpecifier as Extract<T, AbstractConstructor>);
	}

	/**
	 * This returns the specified component associated with the instance.
	 *
	 * The specified type must be exact and not a lifecycle event or superclass. If you want to
	 * query for lifecycle events or superclasses, you should use the `getComponents` method.
	 *
	 * Returns `undefined` while the component is still being constructed, so that a constructor
	 * asking for its own component sees nothing rather than recursing.
	 *
	 * @metadata macro
	 */
	getComponent<T extends object>(instance: Instance, componentSpecifier?: ConstructorRef<T>): T | undefined {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		if (this.isConstructing(instance, component)) {
			return undefined;
		}

		// The removal is announced with the component already out of every lookup, and this is what
		// makes that true for the eager path as well: a handler that reaches for the component it
		// was just told about is told it has gone, rather than handed a second one built on top of
		// the removal that is still running.
		if (this.isRemoving(instance, component)) {
			return undefined;
		}

		const activeComponents = this.activeComponents.get(instance);
		if (activeComponents) {
			const activeComponent = activeComponents.get(component);
			if (activeComponent) {
				return activeComponent as T;
			}
		}

		if (this.canCreateComponentEager(instance, component)) {
			return this.addComponent(instance, component, true);
		}
	}

	/**
	 * This returns all components associated with the instance that extend or implement the specified type.
	 *
	 * For example, `getComponents<OnTick>` will retrieve all components that subscribe to the OnTick lifecycle event.
	 *
	 * @metadata macro
	 */
	getComponents<T extends object>(instance: Instance, componentSpecifier?: AbstractConstructorRef<T>): T[] {
		const componentIdentifier = getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const activeComponents = this.activeInheritedComponents.get(instance);
		if (!activeComponents) return [];

		const componentsSet = activeComponents.get(componentIdentifier);
		if (!componentsSet) return [];

		return [...componentsSet] as never;
	}

	/** @internal */
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>, skipInstanceCheck: true): T;

	/**
	 * Adds the specified component to the instance.
	 * The specified class must be exact and cannot be a lifecycle event or superclass.
	 *
	 * @metadata macro
	 */
	addComponent<T>(instance: Instance, componentSpecifier?: ConstructorRef<T>): T;
	addComponent<T extends BaseComponent>(
		instance: Instance,
		componentSpecifier?: Constructor<T> | string,
		skipInstanceCheck?: boolean,
	) {
		if (this.isStopped) {
			error("Components has been extinguished along with its module and can no longer create components");
		}

		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided componentSpecifier does not exist");

		const attributeGuards = this.getAttributeGuards(component);
		const attributes = this.getAttributes(instance, componentInfo, attributeGuards);

		if (skipInstanceCheck !== true) {
			const instanceGuard = this.getConfigValue(component, "instanceGuard");
			if (instanceGuard !== undefined) {
				assert(
					instanceGuard(instance),
					`${instance.GetFullName()} did not pass instance guard check for '${componentInfo.identifier}'`,
				);
			}
		}

		const existingComponent = this.activeComponents.get(instance)?.get(component);
		if (existingComponent !== undefined) return existingComponent;

		let constructingSet = this.constructing.get(instance);
		if (constructingSet?.has(component)) {
			error(
				`component '${componentInfo.identifier}' is cyclic: it was requested for ${instance.GetFullName()} while it was already being constructed`,
			);
		}

		if (!constructingSet) this.constructing.set(instance, (constructingSet = new Set()));

		// Marked as constructing before the links resolve, so that a component linked back to this
		// one fails to resolve rather than recursing through `getComponent`.
		constructingSet.add(component);

		let componentInstance: BaseComponent;
		try {
			const { childComponents, attributeComponents } = this.resolveLinks(instance, componentInfo, attributes);
			const metadata = identity<ComponentMetadata>({
				instance,
				attributes,
				childComponents,
				attributeComponents,
				writeAttribute: this.createAttributeWriter(componentInfo, instance, attributeGuards),
			});

			componentInstance = this.module.createClassInstance(
				component,
				this.getDependencyResolutionOptions(componentInfo, instance, metadata),
			);
		} finally {
			constructingSet.delete(component);
			if (constructingSet.isEmpty()) {
				this.constructing.delete(instance);
			}
		}

		// The per-instance lookups are created here rather than before the construction: nothing
		// takes an empty one away again -- `removeComponent` leaves before it looks at the map, and
		// `stopCollectionService` only walks what is in it -- so a construction that raises, from a
		// constructor or a link or the cyclic check, would leave one keyed by the instance for as
		// long as the module lives, holding the instance past its own `Destroy`. A nested
		// construction may have made them in the meantime, so they are looked up again here.
		let activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) this.activeComponents.set(instance, (activeComponents = new Map()));

		let inheritedComponents = this.activeInheritedComponents.get(instance);
		if (!inheritedComponents) this.activeInheritedComponents.set(instance, (inheritedComponents = new Map()));

		activeComponents.set(component, componentInstance);

		for (const id of componentInfo.polymorphicIds) {
			this.addIdMapping(componentInstance, id, inheritedComponents);
		}

		this.setupComponent(instance, attributes, componentInstance, componentInfo);

		for (const id of componentInfo.polymorphicIds) {
			const signal = this.componentAddedListeners.get(id);
			if (signal) {
				signal.Fire(componentInstance as never, instance);
			}
		}

		return componentInstance;
	}

	/**
	 * Removes the specified component from this instance.
	 * The specified class must be exact and cannot be a lifecycle event or superclass.
	 *
	 * @metadata macro
	 */
	removeComponent<T extends object>(instance: Instance, componentSpecifier?: ConstructorRef<T>) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided componentSpecifier does not exist");

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		const existingComponent = activeComponents.get(component);
		if (!existingComponent) return;

		// Out of every lookup before the removal is announced, which mirrors a component being
		// announced only once it is in them. A link that names this component reacts to that
		// announcement by taking its own component down, and a cycle of links would otherwise come
		// back round and remove this one a second time -- or without end. The engine defers these
		// signals, so the maps are already clear by the time a handler runs there; this is that
		// ordering, said out loud.
		activeComponents.delete(component);

		if (activeComponents.size() === 0) {
			this.activeComponents.delete(instance);
		}

		for (const id of componentInfo.polymorphicIds) {
			this.removeIdMapping(instance, existingComponent, id);
		}

		// Marked as removing for as long as the removal runs. Leaving every lookup is only half of
		// "the component has gone": the other half is that nothing builds it back, and the eager
		// path would, because a hand removal never touched the tag or the tracker and every
		// criterion still qualifies. Without this a handler asking for the component it was just
		// told about gets a second, freshly constructed one -- announced to nobody, held by no
		// earlier caller -- and `removeComponent` returns with a component still attached.
		let removingSet = this.removing.get(instance);
		if (!removingSet) this.removing.set(instance, (removingSet = new Set()));

		removingSet.add(component);

		try {
			for (const id of componentInfo.polymorphicIds) {
				const signal = this.componentRemovedListeners.get(id);
				if (signal) {
					signal.Fire(existingComponent as never, instance);
				}
			}

			this.module.removeClassInstance(existingComponent);

			existingComponent.destroy();
		} finally {
			removingSet.delete(component);

			if (removingSet.isEmpty()) {
				this.removing.delete(instance);
			}

			// The maid goes whatever the teardown above did, since it holds what Flamework attached
			// rather than what the component did: an attribute-changed connection per tracked
			// attribute, on an instance that may well outlive the component. A `destroy` overridden
			// for a component's own cleanup -- the usual reason to override it -- that raises used
			// to leave those connections live, still firing into a component nothing else holds,
			// and the entry here holding the component for as long as the module lived.
			const maid = this.componentCleanup.get(existingComponent);
			this.componentCleanup.delete(existingComponent);

			if (maid !== undefined) {
				maid.Destroy();
			}
		}
	}

	/**
	 * This returns all components, across all instances, which extend or implement the specified type.
	 *
	 * For example, `getAllComponents<OnTick>` will retrieve all components that subscribe to the OnTick lifecycle event.
	 *
	 * @metadata macro
	 */
	getAllComponents<T extends object>(componentSpecifier?: AbstractConstructorRef<T>): T[] {
		const componentIdentifier = getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const reverseMapping = this.reverseComponentsMapping.get(componentIdentifier);
		if (!reverseMapping) return [];

		return [...reverseMapping] as never;
	}

	/**
	 * This returns a promise which will fire when the specified component is added.
	 * This will first call `getComponent` which means it can resolve instantly and will also
	 * have the eager loading capabilities of `getComponent`.
	 *
	 * This only fires once and should be cancelled to avoid memory leaks if the Promise is discarded prior to being invoked.
	 *
	 * @metadata macro
	 */
	waitForComponent<T extends object>(instance: Instance, componentSpecifier?: ConstructorRef<T>): Promise<T> {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		return new Promise((resolve, _, onCancel) => {
			const existingComponent = this.getComponent(instance, componentSpecifier);
			if (existingComponent !== undefined) return resolve(existingComponent);

			let instanceWaiters = this.componentWaiters.get(instance);
			if (!instanceWaiters) this.componentWaiters.set(instance, (instanceWaiters = new Map()));

			let componentWaiters = instanceWaiters.get(component);
			if (!componentWaiters) instanceWaiters.set(component, (componentWaiters = new Set()));

			onCancel(() => {
				componentWaiters!.delete(resolve as never);

				if (componentWaiters!.size() === 0) {
					instanceWaiters!.delete(component);
				}

				if (instanceWaiters!.size() === 0) {
					this.componentWaiters.delete(instance);
				}
			});

			componentWaiters.add(resolve as never);
		});
	}

	/**
	 * This function listens for the specified component type to be added to any instance.
	 *
	 * This function also supports polymorphism, which means you can listen for specific interfaces or superclasses.
	 *
	 * @metadata macro
	 */
	onComponentAdded<T extends object>(
		callback: (value: T, instance: Instance) => void,
		componentSpecifier?: AbstractConstructorRef<T>,
	) {
		const componentId = getIdFromSpecifier(componentSpecifier);
		assert(componentId !== undefined);

		let signal = this.componentAddedListeners.get(componentId);
		if (!signal) this.componentAddedListeners.set(componentId, (signal = new Signal()));

		return signal.Connect(callback);
	}

	/**
	 * This function listens for the specified component type to be removed from any instance.
	 * The callback is invoked before the component's `destroy` method is called.
	 *
	 * This function also supports polymorphism, which means you can listen for specific interfaces or superclasses.
	 *
	 * @metadata macro
	 */
	onComponentRemoved<T extends object>(
		callback: (value: T, instance: Instance) => void,
		componentSpecifier?: AbstractConstructorRef<T>,
	) {
		const componentId = getIdFromSpecifier(componentSpecifier);
		assert(componentId !== undefined);

		let signal = this.componentRemovedListeners.get(componentId);
		if (!signal) this.componentRemovedListeners.set(componentId, (signal = new Signal()));

		return signal.Connect(callback);
	}
}
