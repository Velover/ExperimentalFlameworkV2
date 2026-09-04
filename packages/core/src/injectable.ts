import { Reflect } from "./reflect";

export interface InjectableDecoratorConfig {}

/**
 * Marks a class as constructible through a module's dependency injection, without registering it as
 * a provider.
 *
 * Use this for classes created with `Module.createClassInstance`: they get constructor injection
 * and lifecycle events like a provider, but are not registered by `registerProviders` and cannot be
 * resolved by id.
 *
 * @metadata reflect identifier flamework:dependencies flamework:implements flamework:parameters injectable
 */
export function Injectable(config?: InjectableDecoratorConfig) {
	return (constructor: object) => {
		Reflect.defineMetadata(constructor, "flamework:injectableConfig", config);
	};
}
