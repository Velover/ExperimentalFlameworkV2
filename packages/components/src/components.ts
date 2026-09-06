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
import type { PluginModule } from "@flamework/core";

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
		private module: PluginModule,
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

	/** @internal */
	public startCollectionService() {
		for (const [, { config, ctor }] of this.components) {
			const ancestorBlacklist = config.ancestorBlacklist ?? DEFAULT_ANCESTOR_BLACKLIST;
			const ancestorWhitelist = config.ancestorWhitelist;

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
					if (instance.Parent === undefined || !CollectionService.HasTag(instance, tag)) {
						return;
					}

					if (predicate !== undefined && !predicate(instance)) {
						return;
					}

					const isWhitelisted = ancestorWhitelist?.some((ancestor) => instance.IsDescendantOf(ancestor));
					if (isWhitelisted === false) return;

					const isBlacklisted = ancestorBlacklist.some((ancestor) => instance.IsDescendantOf(ancestor));
					if (isBlacklisted && isWhitelisted === undefined) return;

					tracker.trackInstance(instance, listener);
					tracker.setHasTag(instance, true);
				};

				this.connections.push(CollectionService.GetInstanceAddedSignal(tag).Connect(instanceAdded));
				this.connections.push(
					CollectionService.GetInstanceRemovedSignal(tag).Connect((instance) => {
						// The same deferral can deliver a removal for a tag that has since been added back;
						// that instance keeps its component.
						if (instance.Parent !== undefined && CollectionService.HasTag(instance, tag)) {
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

		for (const [instance, active] of [...this.activeComponents]) {
			for (const [ctor] of [...active]) {
				this.removeComponent(instance, ctor as Constructor<BaseComponent>);
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
		const tracker = new ComponentTracker(componentInfo.identifier, {
			checkLinks: hasLinks ? (instance) => this.checkLinks(componentInfo, instance) : undefined,
			watchLinks: hasLinks ? (instance, update) => this.watchLinks(componentInfo, instance, update) : undefined,
			tag: componentInfo.config.tag,
			typeGuard: instanceGuard,
			typeGuardPoll:
				(streamingMode === ComponentStreamingMode.Contextual && RunService.IsClient()) ||
				streamingMode === ComponentStreamingMode.Watching,
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
		// component is being built -- and it never would be, with the link unresolved.
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
	 * Whether every link of a component resolves on this instance right now.
	 *
	 * This is the answer for an instance nobody is tracking, where there is nothing to wait on, so
	 * a linked component has to already exist rather than merely be constructible.
	 */
	private checkLinks(componentInfo: ComponentInfo, instance: Instance) {
		for (const link of componentInfo.links) {
			const target = this.resolveLinkTarget(instance, componentInfo, link);
			if (target === undefined) {
				if (link.optional) continue;

				return false;
			}

			if (!this.passesLinkGuard(link, target)) return false;
			if (link.component !== undefined && !this.hasComponent(target, this.getLinkedComponent(link))) {
				return false;
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
	) {
		const maid = new Maid();

		for (const link of componentInfo.links) {
			this.watchLink(componentInfo, instance, link, update, maid);
		}

		return () => maid.Destroy();
	}

	private watchLink(
		componentInfo: ComponentInfo,
		instance: Instance,
		link: ComponentLink,
		update: (criterion: string, isMet: boolean) => void,
		maid: Maid,
	) {
		const criterion = describeLink(link);

		let targetMaid: Maid | undefined;
		let pending: PendingLink | undefined;

		const release = () => {
			targetMaid?.Destroy();
			targetMaid = undefined;

			if (pending !== undefined) {
				cancelPendingLink(pending);
				pending = undefined;
			}
		};

		const resolve = () => {
			release();

			const target = this.resolveLinkTarget(instance, componentInfo, link);
			if (target === undefined) {
				update(criterion, link.optional);

				// The attribute names an instance that has never streamed in, which is what
				// `InstanceHandle:Wait` is for; it resumes once it has, however long that takes.
				if (link.kind === "attribute") {
					pending = this.waitForLinkAttribute(componentInfo, instance, link, resolve);
				}

				return;
			}

			if (!this.passesLinkGuard(link, target)) {
				update(criterion, false);
				return;
			}

			// A handle that fills in after the component was built changes nothing on the instance,
			// so no attribute signal reports it; this is the only place that notices. It matters for
			// an optional link, which does not hold construction up in the first place.
			if (link.kind === "attribute") {
				this.refreshLinkAttribute(instance, componentInfo, link);
			}

			if (link.component === undefined) {
				update(criterion, true);
				return;
			}

			const linkedComponent = this.getLinkedComponent(link);
			const tracker = this.getComponentTracker(linkedComponent);
			const hasTag = this.getConfigValue(linkedComponent, "tag") !== undefined;

			targetMaid = new Maid();

			// A tagged component that qualifies is close enough, because `getComponent` constructs
			// it on the way in. One without a tag only ever exists because somebody added it.
			const refresh = () =>
				update(
					criterion,
					this.hasComponent(target, linkedComponent) || (hasTag && tracker.checkInstance(target)),
				);

			// Observing, not waiting: this component's own tracker is the one that reports the link
			// as a criterion it is still missing.
			const listener = () => refresh();
			tracker.trackInstance(target, listener, true);
			targetMaid.GiveTask(() => tracker.untrackInstance(target, listener));

			let addedSignal = this.componentAddedListeners.get(link.component);
			if (!addedSignal) this.componentAddedListeners.set(link.component, (addedSignal = new Signal()));

			let removedSignal = this.componentRemovedListeners.get(link.component);
			if (!removedSignal) this.componentRemovedListeners.set(link.component, (removedSignal = new Signal()));

			targetMaid.GiveTask(
				addedSignal.Connect((_, changed) => {
					if (changed === target) refresh();
				}),
			);

			// Removal is announced before the component leaves the active map, so this cannot go
			// back through `refresh`: it would still find the component that is on its way out.
			targetMaid.GiveTask(
				removedSignal.Connect((_, changed) => {
					if (changed === target) update(criterion, false);
				}),
			);

			refresh();
		};

		maid.GiveTask(release);

		if (link.kind === "attribute") {
			maid.GiveTask(instance.GetAttributeChangedSignal(link.name).Connect(resolve));
		} else {
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
				const linked = this.getComponent(target, this.getLinkedComponent(link));
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
	 */
	private refreshLinkAttribute(instance: Instance, componentInfo: ComponentInfo, link: ComponentLink) {
		const component = this.activeComponents.get(instance)?.get(componentInfo.ctor);
		if (component === undefined) return;

		const attributes = component.attributes as unknown as Map<string, unknown>;
		const previous = attributes.get(link.name);
		const target = this.resolveLinkTarget(instance, componentInfo, link);
		if (previous === target) return;

		if (target !== undefined) {
			if (!this.passesLinkGuard(link, target)) return;

			if (link.component !== undefined) {
				const linked = this.getComponent(target, this.getLinkedComponent(link));
				if (linked === undefined) return;

				(component.attributeComponents as unknown as Map<string, unknown>).set(link.name, linked);
			}
		} else {
			if (!link.optional) return;

			(component.attributeComponents as unknown as Map<string, unknown>).delete(link.name);
		}

		attributes.set(link.name, target);
		component[SYMBOL_ATTRIBUTE_HANDLERS].get(link.name)?.Fire(target, previous);
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
	 * return value says which of the two happened.
	 */
	private createAttributeWriter(
		componentInfo: ComponentInfo,
		instance: Instance,
		guards: Map<string, t.check<unknown>>,
	) {
		if (guards.isEmpty() && componentInfo.attributeLinks.size() === 0) return undefined;

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

				if (link.component !== undefined) {
					const linked = this.getComponent(value, this.getLinkedComponent(link));
					if (linked === undefined) {
						error(
							`${value.GetFullName()} has no component '${link.component}', which attribute '${key}' of '${componentInfo.identifier}' links to`,
						);
					}
				}

				instance.SetAttribute(key, new InstanceHandle(value));
			}

			// Attribute signals are deferred, so the component would otherwise not see its own
			// write until the next resumption.
			this.refreshLinkAttribute(instance, componentInfo, link);

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
			if (!guard(attribute)) {
				if (defaults?.[key] !== undefined) {
					// A link's default is written as the instance it names, but stored the way
					// every other instance-valued attribute is.
					const value = defaults[key];
					const isLink = componentInfo.attributeLinks.has(key);

					newAttributes.set(key, value);
					instance.SetAttribute(
						key,
						(isLink && typeIs(value, "Instance") ? new InstanceHandle(value) : value) as never,
					);
				} else {
					throw `${instance.GetFullName()} has invalid attribute '${key}' for '${componentInfo.identifier}'`;
				}
			} else {
				newAttributes.set(key, attribute);
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

	private canCreateComponentEager(instance: Instance, component: Constructor) {
		const componentInfo = this.components.get(component);
		if (!componentInfo) return false;

		// The predicate gates eager construction too, as it did in v1; otherwise `getComponent`
		// would construct a component for an instance the predicate rejected.
		const predicate = this.getConfigValue(component, "predicate");
		if (predicate !== undefined && !predicate(instance)) {
			return false;
		}

		const tag = componentInfo.config.tag;
		if (tag !== undefined && instance.Parent && CollectionService.HasTag(instance, tag)) {
			const tracker = this.getComponentTracker(component);
			return tracker.checkInstance(instance);
		}
	}

	private isConstructing(instance: Instance, component: Constructor) {
		return this.constructing.get(instance)?.has(component) === true;
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

		let activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) this.activeComponents.set(instance, (activeComponents = new Map()));

		let inheritedComponents = this.activeInheritedComponents.get(instance);
		if (!inheritedComponents) this.activeInheritedComponents.set(instance, (inheritedComponents = new Map()));

		const existingComponent = activeComponents.get(component);
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

		for (const id of componentInfo.polymorphicIds) {
			const signal = this.componentRemovedListeners.get(id);
			if (signal) {
				signal.Fire(existingComponent as never, instance);
			}
		}

		this.module.removeClassInstance(existingComponent);

		existingComponent.destroy();
		activeComponents.delete(component);

		for (const id of componentInfo.polymorphicIds) {
			this.removeIdMapping(instance, existingComponent, id);
		}

		if (activeComponents.size() === 0) {
			this.activeComponents.delete(instance);
		}

		const maid = this.componentCleanup.get(existingComponent);
		this.componentCleanup.delete(existingComponent);

		if (maid !== undefined) {
			maid.Destroy();
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
