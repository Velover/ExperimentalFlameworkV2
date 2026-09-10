import { Flamework } from "../flamework";
import { Modding } from "../modding";
import type {
	InterfaceConfiguration,
	InterfaceTargetKind,
	PluginDefinition,
	PluginTarget,
} from "../plugin/pluginDefinition";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import { convertConciseDependencyInfo } from "../utility/convertConciseDependencyInfo";
import { getClassImplements } from "../utility/getClassImplements";
import { getClassesInPath } from "../utility/getClassesInPath";
import { getClassesInGlob } from "../utility/globs";
import type { Destructor, ExtractSingleCallback } from "../utility/types";
import type {
	IgniteOptions,
	ModuleProvider,
	ModuleState,
	ProviderConfig,
	ProviderRegistrationOptions,
} from "./moduleDefinition";
import { clearDefaultModule } from "./defaultModule";
import { HookPriority, type HookPhase, type RegisteredHook } from "./moduleHooks";
import { getProviderClassId, getProviderClassScope, normalizeProviderConfig } from "./providerRegistration";
import {
	NO_CONDITION,
	describeConditions,
	hasCondition,
	holdsCondition,
	holdsEveryCondition,
	type ScopeCondition,
} from "./scopes";

interface InternalModule {
	/**
	 * Try to resolve this dependency.
	 *
	 * @internal
	 */
	tryResolveDependency: (info: Modding.DependencyInfo, requestingOrigin?: object) => unknown;

	/**
	 * Sets up the plugins, constructs the providers and runs the hooks.
	 *
	 * @internal
	 */
	ignite: () => Module;
}

export interface Module extends InternalModule {
	/**
	 * This function manually fetches a dependency from this module, as opposed to dependency injection.
	 *
	 * @metadata macro
	 */
	resolveDependency: <T = unknown>(info?: string | Modding.Target.DependencyConcise<T>) => T;

	/**
	 * Terminates this module.
	 *
	 * This runs the plugins' `onExtinguished` hooks.
	 */
	extinguish: () => void;

	/**
	 * Registers a listener for the specified lifecycle event.
	 * You can optionally provide a function as a shorthand for lifecycle events with a single method.
	 *
	 * This function returns a destructor that can be used to disconnect the lifecycle event.
	 *
	 * @param value The object that implements the lifecycle event.
	 * @metadata macro
	 */
	listen<T>(this: void, value: T, meta?: Modding.Target.Id<T>): Destructor;

	/**
	 * Registers a listener for the specified lifecycle event, using a shorthand function.
	 * This overload can only be used on lifecycle events that have a single method.
	 *
	 * This function returns a destructor that can be used to disconnect the lifecycle event.
	 *
	 * @param value A shorthand function for the lifecycle event.
	 * @metadata macro
	 */
	listen<T>(
		this: void,
		value: ExtractSingleCallback<T>,
		id?: Modding.Target.Id<T>,
		name?: Modding.Emit<keyof T>,
	): Destructor;

	/**
	 * Constructs a class through this module's dependency injection without registering it as a
	 * provider, and attaches it to any lifecycle events it implements.
	 *
	 * The instance is owned by this module: it is released when {@link extinguish} runs, or earlier
	 * via {@link removeClassInstance}.
	 */
	createClassInstance: <T extends object>(constructor: Constructor<T>, config?: InstanceCreationConfig) => T;

	/**
	 * Detaches an instance created by {@link createClassInstance} from its lifecycle events.
	 */
	removeClassInstance: (instance: object) => void;

	/**
	 * Whether {@link extinguish} has been called on this module.
	 */
	isExtinguished: () => boolean;
}

interface InstanceCreationConfig {
	/**
	 * When specified, this allows you to override dependency resolution.
	 *
	 * If this function returns `undefined`, then dependency resolution will fallback to the module's resolution.
	 */
	overrideDependency?: (info: Modding.DependencyInfo) => unknown;
}

enum ModuleInitState {
	Created,
	PreIgniting,
	Igniting,
	Ignited,
	Extinguishing,
	Extinguished,
}

const MODULE_ID = Flamework.id<Module>();

/** The class-and-path registration forms take their options as a separate argument; here they join the config. */
function withOptions<T extends object>(config: T, options: ProviderRegistrationOptions | undefined): T {
	return options !== undefined ? { ...config, ...options } : config;
}

export function createModuleInstantiation(state: ModuleState, options?: IgniteOptions): Module {
	/** The module's own scope condition, from `ignite`. Applies to everything it registers. */
	const moduleScope: ScopeCondition =
		options !== undefined && (options.activeIn !== undefined || options.inactiveIn !== undefined)
			? { activeIn: options.activeIn, inactiveIn: options.inactiveIn }
			: NO_CONDITION;

	/** Every registration: the definition's providers, followed by whatever the plugins register. */
	const registered = [...state.providers];

	/** The registrations whose conditions hold, decided once every plugin has been set up. */
	let providers = new Array<ModuleProvider>();

	/** The registrations left out, by id, with the conditions that were judged: for the error a miss gets. */
	const skipped = new Map<string, ReadonlyArray<ScopeCondition>>();

	const instantiatedProviders = new Map<string, defined>();

	/** Objects handed over by `provideInstance`, attached to their interfaces once every plugin is set up. */
	const providedInstances = new Array<object>();
	const observers = new Map<string, Array<InterfaceConfiguration<unknown>>>();
	const hooks = new Array<RegisteredHook>();
	const includedPlugins = new Set<PluginDefinition>();
	const filledSlots = new Map<string, PluginDefinition>();
	const temporaryInstances = new Set<object>();

	let moduleInitState = ModuleInitState.Created;

	const switchInitState = (from: ModuleInitState, to: ModuleInitState) => {
		if (moduleInitState !== from) {
			error(
				`module '${state.debugName}' is in invalid state when transitioning to '${ModuleInitState[to]}', got '${ModuleInitState[moduleInitState]}' when '${ModuleInitState[from]}' was expected.`,
			);
		}

		moduleInitState = to;
	};

	const assertAlive = (action: string) => {
		if (moduleInitState >= ModuleInitState.Extinguishing) {
			error(`module '${state.debugName}' has been extinguished, cannot ${action}`);
		}
	};

	const assertNotProvided = (injectionId: string) => {
		if (instantiatedProviders.has(injectionId)) {
			error(`module '${state.debugName}': provider ID was registered more than once: ${injectionId}`);
		}
	};

	const registerClassProvider = (provider: Constructor, registrationOptions?: ProviderRegistrationOptions) => {
		const injectionId = getProviderClassId(provider);
		registered.push({
			config: normalizeProviderConfig(
				withOptions<ProviderConfig>({ type: "class", value: provider }, registrationOptions),
			),
			injectionId,
		});
	};

	/** Own metadata only, as the builder does: an undecorated subclass of a provider is skipped. */
	const registerProviderClasses = (classes: object[], registrationOptions?: ProviderRegistrationOptions) => {
		for (const provider of classes) {
			if (Reflect.hasOwnMetadata(provider, "flamework:provider")) {
				registerClassProvider(provider as Constructor, registrationOptions);
			}
		}
	};

	/**
	 * Sets a plugin up against this module, once. A plugin reached again -- included by the module
	 * and by a plugin, or by two plugins -- is skipped, and so is one that includes itself through
	 * another: it is marked before its setup runs, so the ring stops on the second arrival.
	 *
	 * An inclusion given a scope condition that does not hold is skipped entirely: the setup does
	 * not run, so nothing it would have registered exists. The plugin itself is not marked, since
	 * it is the inclusion that was scoped, not the plugin.
	 */
	const includePlugin = (plugin: PluginDefinition, scope?: ScopeCondition) => {
		if (includedPlugins.has(plugin)) {
			return;
		}

		if (!holdsCondition(scope)) {
			return;
		}

		// The builder swaps a slotted plugin for the one in its slot, so by the time a module
		// ignites the only way to reach a second one is through a plugin. That is refused rather
		// than run: two lifecycle plugins would tick everything twice.
		if (plugin.slot !== undefined) {
			const occupant = filledSlots.get(plugin.slot);
			if (occupant !== undefined) {
				error(
					`module '${state.debugName}': plugin '${plugin.name}' fills the '${plugin.slot}' slot that plugin '${occupant.name}' already fills; include it on the module instead`,
				);
			}

			filledSlots.set(plugin.slot, plugin);
		}

		includedPlugins.add(plugin);
		plugin.setup(pluginTarget);
	};

	/**
	 * Decides which registrations this ignition keeps: those whose conditions -- the module's, the
	 * registration's own, and the class's decorator -- all hold. Two registrations may share an id
	 * as long as at most one of them is kept, which is how a fake takes a real provider's place
	 * under one scope.
	 */
	const activateProviders = () => {
		const active = new Array<ModuleProvider>();
		const seen = new Set<string>();

		for (const entry of registered) {
			const conditions: ScopeCondition[] = [moduleScope, entry.config, getProviderClassScope(entry.config)];
			if (!holdsEveryCondition(conditions)) {
				skipped.set(entry.injectionId, conditions);
				continue;
			}

			assertNotProvided(entry.injectionId);
			if (seen.has(entry.injectionId)) {
				error(`module '${state.debugName}': provider ID was registered more than once: ${entry.injectionId}`);
			}

			seen.add(entry.injectionId);
			active.push(entry);
		}

		providers = active;
	};

	const registerHook = (phase: HookPhase, callback: (module: Module) => void, priority?: number) => {
		hooks.push({ phase, callback, priority: priority ?? HookPriority.Normal });
	};

	const runHooks = (phase: HookPhase) => {
		const matching = hooks.filter((hook) => hook.phase === phase);

		// `table.sort` is not stable, so hooks of equal priority are ordered by the position they
		// were registered at to keep registration order meaningful.
		const order = new Map<RegisteredHook, number>();
		matching.forEach((hook, index) => order.set(hook, index));

		matching.sort((a, b) => {
			if (a.priority !== b.priority) {
				return a.priority < b.priority;
			}

			return order.get(a)! < order.get(b)!;
		});

		for (const hook of matching) {
			hook.callback(module);
		}
	};

	const registerClassInterfaces = (instance: object, kind: InterfaceTargetKind) => {
		for (const interfaceId of getClassImplements(instance)) {
			const interested = observers.get(interfaceId);
			if (!interested) {
				continue;
			}

			for (const observer of interested) {
				observer.onAdded?.(instance, { interfaceId, kind });
			}
		}
	};

	const unregisterClassInterfaces = (instance: object, kind: InterfaceTargetKind) => {
		for (const interfaceId of getClassImplements(instance)) {
			const interested = observers.get(interfaceId);
			if (!interested) {
				continue;
			}

			for (const observer of interested) {
				observer.onRemoved?.(instance, { interfaceId, kind });
			}
		}
	};

	const instantiateClassWithDependencies = (
		constructor: Constructor,
		resolve?: (info: Modding.DependencyInfo) => unknown,
	) => {
		const dependencies = Reflect.getMetadata<Modding.DependencyInfo[]>(constructor, "flamework:dependencies") ?? [];
		const resolvedParameters = new Array<defined>();
		for (const dependency of dependencies) {
			resolvedParameters.push(resolve?.(dependency) ?? resolveDependencyWithOrigin(dependency, constructor));
		}

		return new constructor(...(resolvedParameters as never[]));
	};

	const tryResolveDependency: Module["tryResolveDependency"] = (info, requestingOrigin) => {
		if (moduleInitState <= ModuleInitState.PreIgniting) {
			error(`module '${state.debugName}' is in pre-ignite phase, dependency cannot be resolved: ${info.id}`);
		}

		// Extinguished hooks and removal callbacks may still resolve siblings while extinguishing,
		// so only a fully extinguished module refuses.
		if (moduleInitState === ModuleInitState.Extinguished) {
			error(`module '${state.debugName}' has been extinguished, dependency cannot be resolved: ${info.id}`);
		}

		const instantiatedProvider = instantiatedProviders.get(info.id);
		if (instantiatedProvider !== undefined) {
			return instantiatedProvider;
		}

		// The Module type always refers to the current module instantiation.
		if (info.id === MODULE_ID) {
			return module;
		}

		const moduleProvider = providers.find((v) => v.injectionId === info.id);
		if (moduleProvider) {
			const config = moduleProvider.config;
			if (config.type === "class") {
				const instantiatedProvider = instantiateClassWithDependencies(config.value as Constructor);
				instantiatedProviders.set(info.id, instantiatedProvider);
				registerClassInterfaces(instantiatedProvider, "provider");

				return instantiatedProvider;
			} else if (config.type === "function") {
				// Function providers are not cached.
				// It is up to the provider to decide whether to cache dependency resolution, based on the injection context.
				return config.callback({
					injectionId: info.id,
					dependencyInfo: info,
					module,
					origin: requestingOrigin,
				});
			} else if (config.type === "alias") {
				return tryResolveDependency(convertConciseDependencyInfo(config.injectionId), requestingOrigin);
			}
		}
	};

	const resolveDependencyWithOrigin = <T>(info: Modding.DependencyInfo, requestingOrigin?: object): T => {
		const dependency = tryResolveDependency(info, requestingOrigin);
		if (dependency === undefined) {
			const inactive = skipped.get(info.id);
			if (inactive !== undefined) {
				error(
					`module '${state.debugName}' could not resolve dependency '${info.id}': it is registered but inactive (${describeConditions(inactive)})`,
				);
			}

			error(`module '${state.debugName}' could not resolve dependency '${info.id}'`);
		}

		return dependency as T;
	};

	const resolveDependency: Module["resolveDependency"] = (info) => {
		assert(info !== undefined);

		return resolveDependencyWithOrigin(convertConciseDependencyInfo(info));
	};

	const createClassInstance: Module["createClassInstance"] = (constructor, config) => {
		assertAlive("create class instances");

		const instance = instantiateClassWithDependencies(constructor, config?.overrideDependency);
		temporaryInstances.add(instance);
		registerClassInterfaces(instance, "instance");
		return instance as never;
	};

	const removeClassInstance: Module["removeClassInstance"] = (instance) => {
		if (!temporaryInstances.has(instance)) {
			return;
		}

		unregisterClassInterfaces(instance, "instance");
		temporaryInstances.delete(instance);
	};

	const listen: Module["listen"] = (...[param, metaId, metaKey]) => {
		assert(metaId !== undefined);
		assertAlive("listen for lifecycle events");

		let listener: object;
		if (metaKey === undefined) {
			// Non-shorthand
			// We create a proxy object so that we have a unique reference for this specific listener.
			listener = setmetatable({}, { __index: param as never });
		} else {
			assert(typeIs(param, "function"));

			listener = {
				[metaKey as string](...args: unknown[]) {
					return param(...args);
				},
			};
		}

		// Register the lifecycle event
		Reflect.defineMetadata(listener, "flamework:implements", [metaId]);

		temporaryInstances.add(listener);
		registerClassInterfaces(listener, "instance");

		return () => {
			assert(listener !== undefined, "listeners cannot be destructed more than once");
			removeClassInstance(listener);
			listener = undefined!;
		};
	};

	const ignite: Module["ignite"] = () => {
		// Raises on a module that has ignited already: a definition is what gets ignited twice.
		switchInitState(ModuleInitState.Created, ModuleInitState.PreIgniting);

		// Plugins are set up before any provider exists, so a setup that resolves is refused the
		// same way an `onPreIgnite` hook is.
		for (const inclusion of state.plugins) {
			includePlugin(inclusion.plugin, inclusion.scope);
		}

		runHooks("preIgnite");

		// Every registration is in by now, the plugins' included, so this is where the conditions
		// are judged and the ids checked for collisions among what is kept.
		activateProviders();

		switchInitState(ModuleInitState.PreIgniting, ModuleInitState.Igniting);

		// Provided instances exist already; here they join the interfaces they implement, now that
		// every plugin's observers are in place.
		for (const instance of providedInstances) {
			registerClassInterfaces(instance, "provider");
		}

		for (const provider of providers) {
			// Lazy providers are constructed the first time they are resolved instead.
			if (provider.config.type === "class" && provider.config.lazy !== true) {
				resolveDependency(provider.injectionId);
			}
		}

		runHooks("postIgnite");

		switchInitState(ModuleInitState.Igniting, ModuleInitState.Ignited);

		return module;
	};

	const extinguish: Module["extinguish"] = () => {
		switchInitState(ModuleInitState.Ignited, ModuleInitState.Extinguishing);

		runHooks("extinguished");

		// Copied first: removal callbacks may themselves remove instances.
		for (const temporaryInstance of [...temporaryInstances]) {
			removeClassInstance(temporaryInstance);
		}

		// Providers join their interfaces when they are instantiated, so they have to leave them
		// too. Without this, a plugin such as the lifecycle plugin keeps holding (and ticking)
		// providers that belong to an extinguished module.
		for (const [, provider] of instantiatedProviders) {
			unregisterClassInterfaces(provider, "provider");
		}

		instantiatedProviders.clear();

		assert(temporaryInstances.size() === 0);
		switchInitState(ModuleInitState.Extinguishing, ModuleInitState.Extinguished);

		// Released last, once nothing in here can resolve any more, so that the next root ignited
		// becomes the default rather than `Dependency<T>()` answering from a dead module.
		clearDefaultModule(module);
	};

	const isExtinguished: Module["isExtinguished"] = () => moduleInitState >= ModuleInitState.Extinguishing;

	const module: Module = {
		tryResolveDependency,
		resolveDependency,
		listen,
		createClassInstance,
		removeClassInstance,
		ignite,
		extinguish,
		isExtinguished,
	};

	/** What a plugin's setup is handed. Everything registers into this instantiation. */
	const pluginTarget: PluginTarget = {
		module,
		scope: hasCondition(moduleScope) ? moduleScope : undefined,
		isActive: (...conditions) => holdsEveryCondition([moduleScope, ...conditions]),
		registerClassProvider,
		registerProviders: (_path, registrationOptions, resolved) => {
			assert(resolved !== undefined);
			registerProviderClasses(getClassesInPath(resolved), registrationOptions);
		},
		registerProvidersGlob: (_glob, registrationOptions, resolved) => {
			assert(resolved !== undefined);
			registerProviderClasses(getClassesInGlob(resolved), registrationOptions);
		},
		registerProvider: (config, injectionId) => {
			assert(injectionId !== undefined);
			registered.push({ config: normalizeProviderConfig(config), injectionId });
		},
		provideInstance: (instance, injectionId) => {
			assert(injectionId !== undefined);
			assertNotProvided(injectionId);
			instantiatedProviders.set(injectionId, instance);
			providedInstances.push(instance);
		},
		includePlugin,
		onPreIgnite: (callback, hookOptions) => registerHook("preIgnite", callback, hookOptions?.priority),
		onPostIgnite: (callback, hookOptions) => registerHook("postIgnite", callback, hookOptions?.priority),
		onExtinguished: (callback, hookOptions) => registerHook("extinguished", callback, hookOptions?.priority),
		observe: (config, interfaceId) => {
			assert(interfaceId !== undefined);

			let interested = observers.get(interfaceId);
			if (!interested) {
				observers.set(interfaceId, (interested = []));
			}

			interested.push(config as InterfaceConfiguration<unknown>);
		},
	};

	return module;
}
