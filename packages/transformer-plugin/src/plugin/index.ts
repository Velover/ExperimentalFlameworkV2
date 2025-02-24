/**
 * This module runs inside of the Flamework transformer VM and is responsible for bridging between Flamework and the sandbox.
 *
 * It exposes the public API of this module.
 *
 * The other files in this directory also run inside of the VM.
 */

import { type Node, type PluginApi, type Type } from "../types";
import { createNodeFactory } from "./nodes";
import { instantiateType } from "./types";

const HANDLERS = new Array<(value: Type) => Node>();
const factory = createNodeFactory();

declare function $registerMacroType(id: string, handler: number): void;

/** @internal */
export function $invokePlugin(handler: number, type: number) {
	return HANDLERS[handler](instantiateType(type)).id;
}

export function registerPlugin(plugin: (api: PluginApi) => void) {
	const api: PluginApi = {
		factory,

		registerMacroType(id, handler) {
			$registerMacroType(id, HANDLERS.push(handler) - 1);
		},
	};

	plugin(api);
}
