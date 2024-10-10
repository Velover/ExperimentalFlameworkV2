import { t } from "@rbxts/t";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { AbstractConstructor } from "./utility/constructors";
import { ModuleBuilder } from "./module/moduleBuilder";
import { PluginBuilder } from "./plugin/pluginBuilder";
import type { ModuleDefinition } from "./module/moduleDefinition";

export namespace Flamework {
	/**
	 * Creates a new Module which is the core functionality of Flamework.
	 */
	export function createModule() {
		return new ModuleBuilder().setDebugName(2);
	}

	/**
	 * Creates a new Plugin. The passed in ModuleDefiniton will be used for the plugin's environment.
	 *
	 * Plugins are special types of Modules which allow you to add interfaces, hooks, etc to modules.
	 */
	export function createPlugin(module: ModuleDefinition) {
		return new PluginBuilder(module);
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
	export declare function id<T>(id?: Modding.Generic<T, "id">): string;

	/**
	 * Check if the constructor implements the specified interface.
	 *
	 * @metadata macro {@link _implements intrinsic-flamework-rewrite}
	 */
	export declare function implements<T>(object: AbstractConstructor, id?: Modding.Generic<T, "id">): boolean;

	/**
	 * Check if object implements the specified interface.
	 *
	 * @metadata macro {@link _implements intrinsic-flamework-rewrite}
	 */
	export declare function implements<T>(object: unknown, id?: Modding.Generic<T, "id">): object is T;

	/**
	 * Hash a function using the method used internally by Flamework.
	 * If a context is provided, then Flamework will create a new hash
	 * if the specified string does not have one in that context.
	 * @param str The string to hash
	 * @param context A scope for the hash
	 * @metadata macro {@link meta intrinsic-inline}
	 */
	export declare function hash<T extends string, C extends string = never>(meta?: Modding.Hash<T, C>): string;

	/**
	 * Creates a type guard from any arbitrary type.
	 *
	 * @metadata macro
	 */
	export function createGuard<T>(meta?: Modding.Generic<T, "guard">): t.check<T> {
		return meta!;
	}
}
