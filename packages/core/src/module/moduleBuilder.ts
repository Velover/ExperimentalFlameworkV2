import { Modding } from "../modding";
import { ModuleDefinition, ModuleState, ProviderConfig, type IgniteOptions } from "./moduleDefinition";
import { getClassesInPath } from "../utility/getClassesInPath";
import { getClassesInGlob } from "../utility/globs";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import type { WritableState } from "../utility/writable";
import type { PluginDefinition } from "../plugin/pluginDefinition";
import type { ProviderDecoratorConfig } from "../provider";

type GenericId<T> = string | Modding.Target.Id<T>;
type MultipleIDs<T> = string[] | Modding.Emit<(T extends T ? Modding.Target.Id<T> : never)[]>;

export class ModuleBuilder {
	/** A global count of the number of module builders. Used to disambiguate identical module debug names. */
	private static moduleCount = 0;

	private moduleIndex = ModuleBuilder.moduleCount++;
	private module: WritableState<ModuleState>;

	constructor() {
		this.module = {
			debugName: "Anonymous",
			providers: [],
			include: [],
			plugins: [],
			exportedProviders: new Set(),
		};
	}

	/**
	 * Includes a plugin into this module.
	 *
	 * A plugin is a normal module except it can modify modules it is included on.
	 */
	public includePlugin(plugin: PluginDefinition) {
		this.module.plugins.push(plugin.getPluginState());

		return this;
	}

	/**
	 * Includes a module into this module.
	 *
	 * This will allow you to access this module's exports.
	 * Included modules are shared across all modules under the root module.
	 */
	public includeModule(module: ModuleDefinition) {
		this.module.include.push(module.getModuleState());

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

		if (providerConfig.type === "class") {
			assertIsProviderClass(providerConfig.value);

			if (providerConfig.lazy === undefined) {
				const decoratorConfig = Reflect.getOwnMetadata<ProviderDecoratorConfig>(
					providerConfig.value,
					"flamework:providerConfig",
				);

				providerConfig = { ...providerConfig, lazy: decoratorConfig?.lazy === true };
			}
		}

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
		assertIsProviderClass(provider);

		const providerId = Reflect.getOwnMetadata<string>(provider, "identifier");
		assert(
			providerId !== undefined,
			`class '${provider}' has no identifier, was it compiled with the Flamework transformer?`,
		);

		return this.registerProvider({ type: "class", value: provider }, providerId);
	}

	/**
	 * Export the specified providers from this module.
	 * You can specify multiple providers at one time using union syntax.
	 *
	 * Exporting providers allows them to be accessed when this module is included in another module.
	 *
	 * @metadata macro
	 */
	public exportProviders<T>(injectionIds?: MultipleIDs<T>) {
		assert(injectionIds !== undefined);

		for (const injectionId of injectionIds) {
			if (this.module.exportedProviders.has(injectionId)) {
				warn(`module already exports the provider '${injectionId}'`);
			}

			this.module.exportedProviders.add(injectionId);
		}

		return this;
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

/**
 * Metadata is inherited through the class hierarchy, so this deliberately checks the class's own
 * metadata: an undecorated subclass of a provider carries the parent's identifier, and registering
 * it would register it under the parent's id.
 */
function assertIsProviderClass(value: object) {
	if (Reflect.hasOwnMetadata(value, "flamework:provider")) {
		return;
	}

	if (Reflect.hasMetadata(value, "flamework:provider")) {
		error(
			`class '${value}' is missing the @Provider() decorator: it inherits one from a parent class, but every provider must be decorated itself`,
		);
	}

	error(`class '${value}' is missing the @Provider() decorator`);
}
