import { Reflect } from "../reflect";
import type { ProviderDecoratorConfig } from "../provider";
import type { Constructor } from "../utility/constructors";
import type { ProviderConfig } from "./moduleDefinition";
import { NO_CONDITION, type ScopeCondition } from "./scopes";

/**
 * Metadata is inherited through the class hierarchy, so this deliberately checks the class's own
 * metadata: an undecorated subclass of a provider carries the parent's identifier, and registering
 * it would register it under the parent's id.
 */
export function assertIsProviderClass(value: object) {
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

/** The generated identifier a provider class is registered under. */
export function getProviderClassId(provider: Constructor) {
	assertIsProviderClass(provider);

	const providerId = Reflect.getOwnMetadata<string>(provider, "identifier");
	assert(
		providerId !== undefined,
		`class '${provider}' has no identifier, was it compiled with the Flamework transformer?`,
	);

	return providerId;
}

/**
 * Checks that a class provider carries `@Provider()`, and fills in `lazy` from the decorator when
 * the registration did not say. Other kinds of provider are returned as they are.
 */
export function normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
	if (config.type !== "class") {
		return config;
	}

	assertIsProviderClass(config.value);

	if (config.lazy !== undefined) {
		return config;
	}

	const decoratorConfig = Reflect.getOwnMetadata<ProviderDecoratorConfig>(config.value, "flamework:providerConfig");
	return { ...config, lazy: decoratorConfig?.lazy === true };
}

/**
 * The scope condition a provider's own decorator set, when it is a class provider with one, and
 * no condition otherwise. Own metadata, as everywhere else: a subclass does not inherit its
 * parent's scope.
 */
export function getProviderClassScope(config: ProviderConfig): ScopeCondition {
	if (config.type !== "class") {
		return NO_CONDITION;
	}

	const decoratorConfig = Reflect.getOwnMetadata<ProviderDecoratorConfig>(config.value, "flamework:providerConfig");
	if (decoratorConfig === undefined) {
		return NO_CONDITION;
	}

	return { activeIn: decoratorConfig.activeIn, inactiveIn: decoratorConfig.inactiveIn };
}
