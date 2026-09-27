import type { ScopeCondition } from "./module/scopes";
import { Reflect } from "./reflect";

export interface ProviderDecoratorConfig extends ScopeCondition {
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

	/**
	 * Orders this provider's `onInit` and `onStart` against the other providers the same ignition
	 * constructs, as v1's `loadOrder` did: lower goes first. Defaults to `1`; any finite number,
	 * negative and fractional ones included. Providers with the same `loadOrder` keep the order
	 * they would have without one.
	 *
	 * Dependency order still wins. The module constructs its providers in ascending `loadOrder`,
	 * each after what its constructor takes, so a provider's dependencies are constructed and
	 * initialised before it even when theirs is higher: a low `loadOrder` pulls what the provider
	 * needs forward with it. `onInit` runs in that construction order. `onStart` runs in ascending
	 * `loadOrder` alone, each on its own thread as always, so a lower one runs up to its first yield
	 * before the next is started.
	 *
	 * Only within one module's ignition: imported modules ignite, and start, before it. Per-frame
	 * events (`onTick`, `onPhysics`, `onRender`) stay unordered. A lazy provider is not part of
	 * the order: it is initialised and started when it is first resolved, and its `loadOrder` is
	 * ignored.
	 */
	loadOrder?: number;
}

/**
 * Register a class as a provider.
 *
 * Unlike Flamework v1's `@Service` and `@Controller`, a provider is not bound to a realm. Which
 * providers exist on which realm is decided by the module that registers them, so this metadata
 * must be defined on both the client and the server.
 *
 * `activeIn` and `inactiveIn` scope the class: it is registered only when they hold against the
 * build's active scopes, on top of whatever condition the module and the registration set.
 *
 * @metadata reflect identifier flamework:dependencies flamework:implements flamework:parameters injectable
 */
export function Provider(config?: ProviderDecoratorConfig) {
	return (constructor: object) => {
		const loadOrder = config?.loadOrder;
		if (
			loadOrder !== undefined &&
			// NaN compares false with everything, so this refuses it along with both infinities.
			(!typeIs(loadOrder, "number") || !(math.abs(loadOrder) < math.huge))
		) {
			error(
				`@Provider() on '${constructor}': loadOrder must be a finite number, got ${tostring(loadOrder)} (${typeOf(loadOrder)})`,
			);
		}

		Reflect.defineMetadata(constructor, "flamework:provider", true);
		Reflect.defineMetadata(constructor, "flamework:providerConfig", config ?? {});
	};
}
