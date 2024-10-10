import { Flamework } from "../flamework";
import { Modding } from "../modding";
import { PluginState, type InterfaceConfiguration, type InterfaceContext } from "../plugin/pluginDefinition";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import { convertConciseDependencyInfo } from "../utility/convertConciseDependencyInfo";
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

	/** @internal */
	getModuleState: () => ModuleState;

	/** @metadata macro */
	resolveDependency: <T = unknown>(info?: string | Modding.Generic<T, "dependencyConcise">) => T;

	/**
	 * Terminates this module.
	 *
	 * This will trigger the `HookType.Extinguished` hook.
	 */
	extinguish: () => void;

	// WIP APIs for creating dependency injected classes and registering them to lifecycle events
	createClassInstance: <T extends object>(constructor: Constructor<T>, config?: InstanceCreationConfig) => T;
	removeClassInstance: (instance: object) => void;
}

interface ModuleContext {
	modules: Map<ModuleState, Module>;
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

interface ImportedInterfaces extends InterfaceContext {
	configuration: InterfaceConfiguration<unknown>;
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
	const importedInterfaces = new Map<string, ImportedInterfaces>();
	const importedHooks = new Array<ImportedHooks>();

	const plugins = new Map<PluginState, Module>();
	const submodules = new Array<Module>();
	const temporaryInstances = new Set<object>();

	let moduleInitState = ModuleInitState.Created;

	const switchInitState = (from: ModuleInitState, to: ModuleInitState) => {
		if (moduleInitState !== from) {
			error(
				`module is in invalid state when transitiong to '${ModuleInitState[to]}', got '${ModuleInitState[moduleInitState]}' when '${ModuleInitState[from]}' was expected.`,
			);
		}

		moduleInitState = to;
	};

	const setupIncludedModules = () => {
		for (const submodule of state.include) {
			const existingModule = context.modules.get(submodule);
			if (existingModule) {
				submodules.push(existingModule);
				continue;
			}

			const module = createModuleInstantiation(submodule, context);
			submodules.push(module);

			context.modules.set(state, module);
		}
	};

	const setupPlugins = () => {
		for (const pluginState of state.plugins) {
			const pluginModule = createModuleInstantiation(pluginState.module, context);

			for (const [interfaceId, configuration] of pluginState.interfaces) {
				importedInterfaces.set(interfaceId, {
					configuration,
					interfaceId,
					sourceModule: pluginModule,
					targetModule: module,
				});
			}

			for (const hook of pluginState.hooks) {
				importedHooks.push({
					hook: hook,
					sourceModule: pluginModule,
					targetModule: module,
				});
			}

			submodules.push(pluginModule);
			plugins.set(pluginState, pluginModule);
		}
	};

	const getHookType = (hookType: HookType) => {
		return importedHooks.filter((v) => v.hook.type === hookType);
	};

	const registerClassInterfaces = (instance: object) => {
		for (const id of getClassImplements(instance)) {
			const importedInterface = importedInterfaces.get(id);
			if (!importedInterface) {
				continue;
			}

			importedInterface.configuration.onAdded?.(importedInterface, instance);
		}
	};

	const unregisterClassInterfaces = (instance: object) => {
		for (const id of getClassImplements(instance)) {
			const importedInterface = importedInterfaces.get(id);
			if (!importedInterface) {
				continue;
			}

			importedInterface.configuration.onRemoved?.(importedInterface, instance);
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
					convertConciseDependencyInfo(config.injectionId),
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

		return resolveDependencyWithOrigin(convertConciseDependencyInfo(info));
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

		setupIncludedModules();
		setupPlugins();

		switchInitState(ModuleInitState.Created, ModuleInitState.PreIgniting);

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
		createClassInstance,
		removeClassInstance,
		ignite,
		extinguish,
	};

	return module;
}
