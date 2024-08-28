import { Modding } from "../modding";
import { ModuleDefinition, ModuleState, ProviderConfig } from "./moduleDefinition";
import { getClassesInPath } from "../utility/getClassesInPath";
import { Reflect } from "../reflect";
import type { Constructor } from "../utility/constructors";
import type { HookConfig } from "./moduleHooks";

type GenericId<T> = string | Modding.Generic<T, "id">;
type MultipleIDs<T> = string[] | Modding.Many<(T extends T ? Modding.Generic<T, "id"> : never)[]>;

export class ModuleBuilder {
	private module: ModuleState = {
		providers: [],
		include: [],
		hooks: [],
		exportedHooks: false,
		exportedProviders: new Set(),
		exportedInterfaces: new Set(),
		interfaces: new Set(),
		transient: false,
	};

	public includeModule(module: ModuleDefinition) {
		this.module.include.push(module.getModuleState());

		return this;
	}

	/** @metadata macro */
	public registerProviders<T extends string>(_stringPath: T, path?: Modding.Intrinsic<"path", [T], string[][]>) {
		assert(path);

		// TODO: `path` intrinsic should return `string[]` instead of `string[][]`
		const providers = getClassesInPath(path[0]!).filter((v) => Reflect.hasMetadata(v, "flamework:provider"));
		for (const provider of providers) {
			const providerId = Reflect.getMetadata<string>(provider, "identifier");
			this.registerProvider({ type: "class", value: provider }, providerId);
		}

		return this;
	}

	/** @metadata macro */
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

	/** Shorthand for registering class constructors using their generated ID. */
	public registerClassProvider(provider: Constructor) {
		const providerId = Reflect.getMetadata<string>(provider, "identifier");
		return this.registerProvider({ type: "class", value: provider }, providerId);
	}

	/** @metadata macro */
	public registerInterfaces<T>(ids?: MultipleIDs<T>) {
		assert(ids !== undefined);

		for (const id of ids) {
			this.module.interfaces.add(id);
		}

		return this;
	}

	public registerHook(hookConfig: HookConfig) {
		this.module.hooks.push(hookConfig);

		return this;
	}

	/** @metadata macro */
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

	/** @metadata macro */
	public exportInterfaces<T>(injectionIds?: MultipleIDs<T>) {
		assert(injectionIds !== undefined);

		for (const injectionId of injectionIds) {
			if (this.module.exportedInterfaces.has(injectionId)) {
				warn(`module already exports the provider '${injectionId}'`);
			}

			this.module.exportedInterfaces.add(injectionId);
		}

		return this;
	}

	/**
	 * Exports all hooks defined in this module.
	 */
	public exportHooks() {
		this.module.exportedHooks = true;

		return this;
	}

	/**
	 * Converts this into a transient module.
	 */
	public transient() {
		this.module.transient = true;

		return this;
	}

	/**
	 * An easy way to apply a function to the builder without breaking chaining.
	 */
	public apply(callback: (builder: ModuleBuilder) => ModuleBuilder) {
		return callback(this);
	}

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
