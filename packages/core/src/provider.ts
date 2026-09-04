import { Reflect } from "./reflect";

export interface ProviderDecoratorConfig {}

/**
 * Register a class as a provider.
 *
 * Unlike Flamework v1's `@Service` and `@Controller`, a provider is not bound to a realm. Which
 * providers exist on which realm is decided by the module that registers them, so this metadata
 * must be defined on both the client and the server.
 *
 * @metadata reflect identifier flamework:dependencies flamework:implements flamework:parameters injectable
 */
export function Provider(config?: ProviderDecoratorConfig) {
	return (constructor: object) => {
		Reflect.defineMetadata(constructor, "flamework:provider", true);
		Reflect.defineMetadata(constructor, "flamework:providerConfig", config);
	};
}
