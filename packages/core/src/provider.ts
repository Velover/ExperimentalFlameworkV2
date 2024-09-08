import { RunService } from "@rbxts/services";
import { Reflect } from "./reflect";

export interface ProviderDecoratorConfig {}

/**
 * Register a class as a provider.
 *
 * @server
 * @metadata reflect identifier flamework:dependencies flamework:implements flamework:parameters injectable
 */
export function Provider(config?: ProviderDecoratorConfig) {
	return (constructor: object) => {
		if (RunService.IsServer()) {
			Reflect.defineMetadata(constructor, "flamework:provider", true);
			Reflect.defineMetadata(constructor, "flamework:providerConfig", config);
		}
	};
}
