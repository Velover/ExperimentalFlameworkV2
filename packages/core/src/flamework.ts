import { t } from "@rbxts/t";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { AbstractConstructor } from "./utility/constructors";
import { ModuleBuilder } from "./module/moduleBuilder";
import { PluginDefinition, type PluginTarget } from "./plugin/pluginDefinition";
import { LifecyclePlugin } from "./lifecycle/lifecyclePlugin";
import { getActiveScopes, isScopeActive as isScopeActiveInBuild } from "./module/scopes";
import { Serialization } from "./serialization/types";

export namespace Flamework {
	/**
	 * Creates a new Module which is the core functionality of Flamework.
	 *
	 * Every module starts with `LifecyclePlugin` included. `disableDefaultLifecycle()` on the builder
	 * leaves it out, and including one built with `createLifecyclePlugin` takes its place.
	 */
	export function createModule() {
		return new ModuleBuilder().setDebugName(2).includePlugin(LifecyclePlugin);
	}

	/**
	 * Creates a plugin: a setup function, run once per ignition of every module that includes it,
	 * which registers providers, hooks and observers into that module. See {@link PluginTarget} for
	 * what it can do. `name` labels the plugin in error messages.
	 */
	export function createPlugin(name: string, setup: (target: PluginTarget) => void) {
		return new PluginDefinition(name, setup);
	}

	/**
	 * The scopes this build is compiled with: `scopes.active` in `flamework.config.json`, which
	 * usually comes from the environment. `"*"` in the list stands for every scope.
	 */
	export function activeScopes(): readonly string[] {
		return getActiveScopes();
	}

	/**
	 * Whether a scope is active in this build. What an entry point asks before igniting a module
	 * that only exists for that scope.
	 */
	export function isScopeActive(scope: string): boolean {
		return isScopeActiveInBuild(scope);
	}

	/** @hidden */
	export function _implements<T>(object: unknown, id: string): object is T {
		return Reflect.getMetadatas<string[]>(object as object, "flamework:implements").some((impl) =>
			impl.includes(id),
		);
	}

	/**
	 * Retrieve the identifier for the specified type.
	 *
	 * @metadata macro {@link id intrinsic-inline}
	 */
	export declare function id<T>(id?: Modding.Target.Id<T>): string;

	/**
	 * Inlines an environment variable at compile time: the call becomes the variable's value as a
	 * string literal, read from `.env`, `.env.local` and the process environment when the compiler
	 * started. A variable that is not set and has no fallback fails the build at the call site.
	 *
	 * For deployment values -- a place id, a build channel, a version -- and not for secrets: the
	 * value is written into the emitted Luau, where anyone with the place can read it.
	 *
	 * @metadata macro {@link value intrinsic-inline}
	 */
	export declare function env<N extends string, F extends string | undefined = undefined>(
		name: N,
		fallback?: F,
		value?: Modding.Intrinsic<"env", [N, F], string>,
	): string;

	/**
	 * Check if the constructor implements the specified interface.
	 *
	 * @metadata macro {@link _implements intrinsic-flamework-rewrite}
	 */
	export declare function implements<T>(object: AbstractConstructor, id?: Modding.Target.Id<T>): boolean;

	/**
	 * Check if object implements the specified interface.
	 *
	 * @metadata macro {@link _implements intrinsic-flamework-rewrite}
	 */
	export declare function implements<T>(object: unknown, id?: Modding.Target.Id<T>): object is T;

	/**
	 * Creates a type guard from any arbitrary type.
	 *
	 * @metadata macro
	 */
	export function createGuard<T>(meta?: Modding.Target.Guard<T>): t.check<T> {
		return meta!;
	}

	/**
	 * Creates a serializer for `T`. The encode and decode code is generated from the type at compile
	 * time: plain `buffer` reads and writes, at constant offsets wherever the layout is fixed, with
	 * nothing describing the type left in the output. Instances and `unknown` values travel alongside
	 * the buffer as blobs.
	 *
	 * @metadata macro
	 */
	export function createSerializer<T>(
		meta?: Modding.Intrinsic<"serializer", [T], Serialization.Serializer<T>>,
	): Serialization.Serializer<T> {
		return meta!;
	}
}
