import { Flamework } from "../flamework";
import { Modding } from "../modding";
import { ProviderDecoratorConfig } from "../provider";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import { getClassImplements } from "../utility/getClassImplements";
import type { ModuleState } from "./moduleDefinition";
import { HookType, type HookConfig, type HookContext } from "./moduleHooks";

export interface Module {
	/**
	 * Try to resolve this dependency.
	 *
	 * @internal
	 */
	tryResolveDependency: (
		info: Modding.DependencyInfo,
		requestingModule?: Module,
		requestingOrigin?: object,
	) => unknown;

	/**
	 * Initializes all providers, nested modules and invokes the hooks.
	 *
	 * @internal
	 */
	ignite: () => Module;

	/**
	 * Returns all registered or imported interfaces from this module.
	 *
	 * @internal
	 */
	resolveImportedInterfaces: () => Set<string>;

	/**
	 * Returns all registered or imported hooks from this module.
	 *
	 * @internal
	 */
	resolveImportedHooks: (targetModule: Module) => Array<ImportedHooks>;

	/** @internal */
	getModuleState: () => ModuleState;

	/** @metadata macro */
	resolveDependency: <T = unknown>(info?: string | Modding.Generic<T, "dependencyConcise">) => T;

	/**
	 * Returns all providers that implement the specified interface.
	 *
	 * @metadata macro
	 */
	getInterfaces: <T>(id?: string | Modding.Generic<T, "id">) => T[];

	getInterfaceAdded: <T>(callback: (value: T) => void, id?: string | Modding.Generic<T, "id">) => () => void;
	getInterfaceRemoved: <T>(callback: (value: T) => void, id?: string | Modding.Generic<T, "id">) => () => void;

	/**
	 * Terminates this module.
	 *
	 * This will trigger the `HookType.Terminated` hook.
	 */
	extinguish: () => void;

	// WIP APIs for creating dependency injected classes and registering them to lifecycle events
	createClassInstance: <T extends object>(constructor: Constructor<T>, config?: InstanceCreationConfig) => T;
	removeClassInstance: (instance: object) => void;
}

interface ModuleContext {
	modules: Map<ModuleState, Module>;
	transient?: boolean;
}

interface InstanceCreationConfig {
	/**
	 * When specified, this allows you to override dependency resolution.
	 *
	 * If this function returns `undefined`, then dependency resolution will fallback to the module's resolution.
	 */
	overrideDependency?: (info: Modding.DependencyInfo) => unknown;
}

interface ImportedHooks extends HookContext {
	hook: HookConfig;
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

export function createModuleInstantiation(state: ModuleState, context: ModuleContext): Module {
	const instantiatedProviders = new Map<string, defined>();
	const importedInterfaces = table.clone(state.interfaces);
	const interfaces = new Map<string, defined[]>();
	const interfaceAddedConnections = new Map<string, Set<(value: never) => void>>();
	const interfaceRemovedConnections = new Map<string, Set<(value: never) => void>>();

	const temporaryInstances = new Set<object>();
	const importedHookTypesCached = new Map<HookType, ImportedHooks[]>();
	const cachedDependencyInfo = new Map<string, Modding.DependencyInfo>();

	const submodules = state.include.map((state) => {
		const existingModule = context.modules.get(state);
		if (existingModule) {
			return existingModule;
		}

		// Modules will register themselves into the context.
		return createModuleInstantiation(state, {
			modules: context.modules,
			transient: state.transient,
		});
	});

	let importedHooksCached: ImportedHooks[] | undefined;
	let moduleInitState = ModuleInitState.Created;

	for (const module of submodules) {
		const state = module.getModuleState();
		for (const moduleInterface of module.resolveImportedInterfaces()) {
			if (state.exportedInterfaces.has(moduleInterface)) {
				importedInterfaces.add(moduleInterface);
			}
		}
	}

	const switchInitState = (from: ModuleInitState, to: ModuleInitState) => {
		if (moduleInitState !== from) {
			error(
				`module is in invalid state when transitiong to '${ModuleInitState[to]}', got '${ModuleInitState[moduleInitState]}' when '${ModuleInitState[from]}' was expected.`,
			);
		}

		moduleInitState = to;
	};

	const getDependencyInfoFromConcise = (dependency?: string | Modding.DependencyInfo) => {
		assert(dependency !== undefined);

		if (typeIs(dependency, "string")) {
			let metadata = cachedDependencyInfo.get(dependency);
			if (!metadata) {
				cachedDependencyInfo.set(dependency, (metadata = { id: dependency }));
			}

			return metadata;
		}

		return dependency;
	};

	const getHookType = (hookType: HookType) => {
		const importedHooks = (importedHooksCached ??= resolveImportedHooks(module));

		let cachedHooks = importedHookTypesCached.get(hookType);
		if (!cachedHooks) {
			importedHookTypesCached.set(
				hookType,
				(cachedHooks = importedHooks.filter((v) => v.hook.type === hookType)),
			);
		}

		return cachedHooks;
	};

	const registerClassInterfaces = (instance: object) => {
		// This caches the provider based on its implemented interfaces.
		// This makes querying interfaces much cheaper.
		for (const id of getClassImplements(instance)) {
			let providerInterface = interfaces.get(id);
			if (!providerInterface) {
				interfaces.set(id, (providerInterface = []));
			}

			if (!providerInterface.includes(instance)) {
				providerInterface.push(instance);
			}

			const addedCallbacks = interfaceAddedConnections.get(id);
			if (addedCallbacks) {
				for (const callback of addedCallbacks) {
					task.spawn(callback, instance as never);
				}
			}
		}
	};

	const unregisterClassInterfaces = (instance: object) => {
		// This caches the provider based on its implemented interfaces.
		// This makes querying interfaces much cheaper.
		for (const id of getClassImplements(instance)) {
			let providerInterface = interfaces.get(id);
			if (!providerInterface) {
				interfaces.set(id, (providerInterface = []));
			}

			const index = providerInterface.indexOf(instance);
			if (index !== -1) {
				providerInterface.unorderedRemove(index);
			}

			if (providerInterface.size() === 0) {
				interfaces.delete(id);
			}

			const removedCallbacks = interfaceRemovedConnections.get(id);
			if (removedCallbacks) {
				for (const callback of removedCallbacks) {
					task.spawn(callback, instance as never);
				}
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

	const getModuleState: Module["getModuleState"] = () => state;

	const tryResolveDependency: Module["tryResolveDependency"] = (info, requestingModule, requestingOrigin) => {
		if (moduleInitState <= ModuleInitState.PreIgniting) {
			error(`module is in pre-ignite phase, dependency cannot be resolved: ${info.id}`);
		}

		const instantiatedProvider = instantiatedProviders.get(info.id);
		if (instantiatedProvider !== undefined) {
			return instantiatedProvider;
		}

		// The ModuleInstantiation type always refers to the current module instantiation.
		if (info.id === MODULE_ID) {
			return module;
		}

		const moduleProvider = state.providers.find((v) => v.injectionId === info.id);
		if (moduleProvider) {
			const config = moduleProvider.config;
			if (config.type === "class") {
				const instantiatedProvider = instantiateClassWithDependencies(config.value as Constructor);
				instantiatedProviders.set(info.id, instantiatedProvider);
				registerClassInterfaces(instantiatedProvider);

				return instantiatedProvider;
			} else if (config.type === "function") {
				// Function providers are not cached.
				// It is up to the provider to decide whether to cache dependency resolution, based on the injection context.
				return config.callback({
					injectionId: info.id,
					dependencyInfo: info,
					sourceModule: module,
					targetModule: requestingModule ?? module,
					origin: requestingOrigin,
				});
			} else if (config.type === "alias") {
				return tryResolveDependency(
					getDependencyInfoFromConcise(config.injectionId),
					requestingModule,
					requestingOrigin,
				);
			}
		}

		for (const submodule of submodules) {
			// We only want to resolve module IDs if they are explicitly exported.
			if (submodule.getModuleState().exportedProviders.has(info.id)) {
				const moduleProvider = submodule.tryResolveDependency(info, module, requestingOrigin);
				if (moduleProvider !== undefined) {
					return moduleProvider;
				}
			}
		}
	};

	const resolveDependencyWithOrigin = <T>(info: Modding.DependencyInfo, requestingOrigin?: object): T => {
		const dependency = tryResolveDependency(info, undefined, requestingOrigin);
		if (dependency === undefined) {
			error(`module could not resolve dependency '${info.id}'`);
		}

		return dependency as T;
	};

	const resolveDependency: Module["resolveDependency"] = (info) => {
		assert(info !== undefined);

		return resolveDependencyWithOrigin(getDependencyInfoFromConcise(info));
	};

	const getInterfaces: Module["getInterfaces"] = (id) => {
		assert(id !== undefined);
		assert(importedInterfaces.has(id), "the specified interface is not imported in this module");

		return (interfaces.get(id) as never[]) ?? [];
	};

	const getInterfaceAdded: Module["getInterfaceAdded"] = (callback, id) => {
		assert(id !== undefined);

		let connections = interfaceAddedConnections.get(id);
		if (!connections) interfaceAddedConnections.set(id, (connections = new Set()));

		connections.add(callback);

		return () => connections!.delete(callback);
	};

	const getInterfaceRemoved: Module["getInterfaceRemoved"] = (callback, id) => {
		assert(id !== undefined);

		let connections = interfaceRemovedConnections.get(id);
		if (!connections) interfaceRemovedConnections.set(id, (connections = new Set()));

		connections.add(callback);

		return () => connections!.delete(callback);
	};

	const resolveImportedInterfaces: Module["resolveImportedInterfaces"] = () => {
		return importedInterfaces;
	};

	const resolveImportedHooks: Module["resolveImportedHooks"] = (targetModule: Module) => {
		const importedHooks = new Array<ImportedHooks>();

		// Including a module also implicitly includes its registered hooks and lifecycle events.
		for (const submodule of submodules) {
			// Modules don't currently support selective hook exports.
			// Alternatively, we could have `exportHook(HookConfig)` for export-only hooks
			if (submodule.getModuleState().exportedHooks) {
				for (const hook of submodule.resolveImportedHooks(targetModule)) {
					importedHooks.push({
						hook: hook.hook,
						sourceModule: hook.sourceModule,
						targetModule,
					});
				}
			}
		}

		for (const hook of state.hooks) {
			importedHooks.push({
				hook,
				sourceModule: module,
				targetModule,
			});
		}

		return importedHooks;
	};

	const createClassInstance: Module["createClassInstance"] = (constructor, config) => {
		const instance = instantiateClassWithDependencies(constructor, config?.overrideDependency);
		temporaryInstances.add(instance);
		registerClassInterfaces(instance);
		return instance as never;
	};

	const removeClassInstance: Module["removeClassInstance"] = (instance) => {
		unregisterClassInterfaces(instance);
		temporaryInstances.delete(instance);
		return instance as never;
	};

	const ignite: Module["ignite"] = () => {
		// We're already ignited, so we can ignore repeated calls.
		if (moduleInitState === ModuleInitState.Ignited) {
			return module;
		}

		switchInitState(ModuleInitState.Created, ModuleInitState.PreIgniting);

		assert(!state.transient || context.transient, "transient modules cannot be ignited");

		// We initialize any nested modules first.
		// They are isolated and so we don't have to worry about side effects besides exports.
		for (const submodule of submodules) {
			submodule.ignite();
		}

		for (const context of getHookType(HookType.PreIgnite)) {
			context.hook.callback(context);
		}

		switchInitState(ModuleInitState.PreIgniting, ModuleInitState.Igniting);

		for (const provider of state.providers) {
			if (provider.config.type === "class") {
				resolveDependency(provider.injectionId);
			}
		}

		for (const context of getHookType(HookType.PostIgnite)) {
			context.hook.callback(context);
		}

		switchInitState(ModuleInitState.Igniting, ModuleInitState.Ignited);

		return module;
	};

	const extinguish: Module["extinguish"] = () => {
		switchInitState(ModuleInitState.Ignited, ModuleInitState.Extinguishing);

		for (const context of getHookType(HookType.Extinguished)) {
			context.hook.callback(context);
		}

		for (const temporaryInstance of temporaryInstances) {
			removeClassInstance(temporaryInstance);
		}

		instantiatedProviders.clear();

		assert(temporaryInstances.size() === 0);
		switchInitState(ModuleInitState.Extinguishing, ModuleInitState.Extinguished);
	};

	const module: Module = {
		getModuleState,
		tryResolveDependency,
		resolveDependency,
		getInterfaces,
		getInterfaceAdded,
		getInterfaceRemoved,
		createClassInstance,
		removeClassInstance,
		ignite,
		extinguish,
		resolveImportedInterfaces,
		resolveImportedHooks,
	};

	if (!state.transient) {
		context.modules.set(state, module);
	}

	return module;
}
