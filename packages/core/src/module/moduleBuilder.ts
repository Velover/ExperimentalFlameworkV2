import { Modding } from "../modding";
import { ModuleDefinition, ModuleState, ProviderConfig } from "./moduleDefinition";
import { getClassesInPath } from "../utility/getClassesInPath";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import type { WritableState } from "../utility/writable";
import type { PluginDefinition } from "../plugin/pluginDefinition";

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
	 * The providers must be exported.
	 *
	 * @metadata macro
	 */
	public registerProviders<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[]>) {
		assert(path);

		const providers = getClassesInPath(path).filter((v) => Reflect.hasMetadata(v, "flamework:provider"));
		for (const provider of providers) {
			const providerId = Reflect.getMetadata<string>(provider, "identifier");
			this.registerProvider({ type: "class", value: provider }, providerId);
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

		for (const provider of this.module.providers) {
			if (provider.injectionId === injectionId) {
				error(`provider ID was registered more than once: ${injectionId}`);
			}
		}

		this.module.providers.push({ config: providerConfig, injectionId });

		if (providerConfig.type === "class") {
			assert(
				Reflect.hasMetadata(providerConfig.value, "flamework:provider"),
				`class '${providerConfig.value}' is missing the @Provider() decorator`,
			);
		}

		return this;
	}

	/**
	 * Register a new class provider.
	 *
	 * This is just a shorthand for `registerProvider` which uses the generated `identifier` from the class.
	 */
	public registerClassProvider(provider: Constructor) {
		const providerId = Reflect.getMetadata<string>(provider, "identifier");
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
	 * This is shorthand for `.build().ignite()`
	 */
	public ignite() {
		return this.build().ignite();
	}
}
