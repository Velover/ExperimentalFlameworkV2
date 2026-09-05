import { Reflect } from "./reflect";

export interface ProviderDecoratorConfig {
	/**
	 * A lazy provider is not constructed during ignition. It is constructed the first time something
	 * resolves it -- a constructor parameter, `resolveDependency`, or `createClassInstance` -- and is
	 * otherwise never created.
	 *
	 * This is the v2 equivalent of v1's `@Optional()`. A lazy provider first resolved after ignition
	 * still receives `onInit` and `onStart` from the lifecycle plugin, at the moment it is constructed.
	 *
	 * Defaults to `false`.
	 */
	lazy?: boolean;
}

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
		Reflect.defineMetadata(constructor, "flamework:providerConfig", config ?? {});
	};
}
