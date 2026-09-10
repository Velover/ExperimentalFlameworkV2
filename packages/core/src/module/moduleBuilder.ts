import { Modding } from "../modding";
import { ModuleDefinition, ModuleState, ProviderConfig, type IgniteOptions } from "./moduleDefinition";
import { getClassesInPath } from "../utility/getClassesInPath";
import { getClassesInGlob } from "../utility/globs";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import type { WritableState } from "../utility/writable";
import { LIFECYCLE_SLOT, type PluginDefinition } from "../plugin/pluginDefinition";
import { getProviderClassId, normalizeProviderConfig } from "./providerRegistration";

type GenericId<T> = string | Modding.Target.Id<T>;

export class ModuleBuilder {
	/** A global count of the number of module builders. Used to disambiguate identical module debug names. */
	private static moduleCount = 0;

	private moduleIndex = ModuleBuilder.moduleCount++;
	private module: WritableState<ModuleState>;

	constructor() {
		this.module = {
			debugName: "Anonymous",
			providers: [],
			plugins: [],
		};
	}

	/**
	 * Includes a plugin in this module: its setup runs against every ignition of the module, before
	 * any provider is constructed.
	 *
	 * A plugin is set up once per ignition however many times it is included, so including one
	 * twice is not an error; it is simply not recorded twice.
	 */
	public includePlugin(plugin: PluginDefinition) {
		const plugins = this.module.plugins;
		if (plugins.includes(plugin)) {
			return this;
		}

		// A slotted plugin takes the place of whatever holds its slot -- the default lifecycle
		// plugin, usually -- rather than joining it, and keeps that position so hook order is stable.
		const occupant = plugin.slot !== undefined ? plugins.findIndex((v) => v.slot === plugin.slot) : -1;
		if (occupant !== -1) {
			plugins[occupant] = plugin;
		} else {
			plugins.push(plugin);
		}

		return this;
	}

	/**
	 * Leaves out the `LifecyclePlugin` every module otherwise starts with, so that nothing in this
	 * module receives `onInit`, `onStart` or the per-frame events. Silent by design: a module that
	 * wants no lifecycle has nothing to be told.
	 */
	public disableDefaultLifecycle() {
		const plugins = this.module.plugins;
		for (let i = plugins.size() - 1; i >= 0; i--) {
			if (plugins[i].slot === LIFECYCLE_SLOT) {
				plugins.remove(i);
			}
		}

		return this;
	}

	/**
	 * Sets the debug name for this module.
	 *
	 * if a number is provided, a debug name will be generated using the debug info at the level (relative to the caller.)
	 */
	public setDebugName(debugNameOrLevel: string | number) {
		if (typeIs(debugNameOrLevel, "string")) {
			this.module.debugName = debugNameOrLevel;
		} else {
			const [source, line] = debug.info(debugNameOrLevel + 1, "sl");
			this.module.debugName = `${this.moduleIndex}+${source.match("(%w+)$")[0] ?? source}:${line}`;
		}

		return this;
	}

	/**
	 * Register all providers under the specified path and its descendants.
	 *
	 * The providers must be exported, and must carry the `@Provider()` decorator themselves: an
	 * undecorated subclass of a provider is not registered.
	 *
	 * @metadata macro
	 */
	public registerProviders<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[]>) {
		assert(path);

		return this.registerProviderClasses(getClassesInPath(path));
	}

	/**
	 * Register all providers under every path matched by the specified glob, which is resolved at
	 * compile time.
	 *
	 * This is the v2 equivalent of v1's `Flamework.addPathsGlob`. Globs can match a large number of
	 * paths, so keep them as specific as possible.
	 *
	 * @metadata macro
	 */
	public registerProvidersGlob<T extends string>(_glob: T, glob?: Modding.Intrinsic<"pathglob", [T], string>) {
		assert(glob !== undefined);

		return this.registerProviderClasses(getClassesInGlob(glob));
	}

	private registerProviderClasses(classes: object[]) {
		for (const provider of classes) {
			if (Reflect.hasOwnMetadata(provider, "flamework:provider")) {
				this.registerClassProvider(provider as Constructor);
			}
		}

		return this;
	}

	/**
	 * Register a new provider.
	 *
	 * @metadata macro
	 */
	public registerProvider<T>(providerConfig: ProviderConfig, injectionId?: GenericId<T>) {
		assert(injectionId !== undefined);

		providerConfig = normalizeProviderConfig(providerConfig);

		for (const provider of this.module.providers) {
			if (provider.injectionId === injectionId) {
				error(`provider ID was registered more than once: ${injectionId}`);
			}
		}

		this.module.providers.push({ config: providerConfig, injectionId });

		return this;
	}

	/**
	 * Register a new class provider.
	 *
	 * This is just a shorthand for `registerProvider` which uses the generated `identifier` from the class.
	 */
	public registerClassProvider(provider: Constructor) {
		return this.registerProvider({ type: "class", value: provider }, getProviderClassId(provider));
	}

	/**
	 * An easy way to apply a function to the builder without breaking chaining.
	 */
	public apply(callback: (builder: ModuleBuilder) => ModuleBuilder) {
		return callback(this);
	}

	/**
	 * Finalizes this module.
	 */
	public build() {
		return new ModuleDefinition(this.module);
	}

	/**
	 * Ignites this module.
	 *
	 * This is shorthand for `.build().ignite(options)`
	 */
	public ignite(options?: IgniteOptions) {
		return this.build().ignite(options);
	}
}
