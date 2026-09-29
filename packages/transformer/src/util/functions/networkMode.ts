import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";

/**
 * How a networking member's values travel:
 * - `raw`: as they are (`Networking.Raw*`), whatever the project's switch says;
 * - `plain`: packed when `networking.serialization` is on, as they are otherwise;
 * - `serialized`: packed into a buffer either way (`Networking.Serialized*`).
 */
export type NetworkMode = "raw" | "plain" | "serialized";

const MARKERS = {
	raw: "_flamework_raw",
	serialized: "_flamework_serialized",
	unreliable: "_flamework_unreliable",
} as const;

/** Whether the declared member type carries one of networking's markers (`Raw`, `Serialized`, ...). */
export function hasNetworkMarker(member: ts.Type | undefined, marker: keyof typeof MARKERS): boolean {
	return member !== undefined && member.getProperty(MARKERS[marker]) !== undefined;
}

/**
 * The mode a member's markers ask for. A member declared both raw and serialized is refused here,
 * wherever the transformer first meets it: a call site that sends it or registers its callback, or
 * the metadata of a handler of its network.
 *
 * `member` is the member's declared type (`undefined` or `unknown` reads as plain), `name` what to
 * call it in the message.
 */
export function getNetworkMode(member: ts.Type | undefined, node: ts.Node, name?: string): NetworkMode {
	const raw = hasNetworkMarker(member, "raw");
	const serialized = hasNetworkMarker(member, "serialized");

	if (raw && serialized) {
		const subject = name !== undefined ? `The networking member '${name}'` : "This networking member";
		Diagnostics.error(
			node,
			`${subject} is declared both Raw and Serialized. Raw sends its values as they are; Serialized packs them into a buffer.`,
			`Keep one of the two markers.`,
		);
	}

	if (raw) return "raw";
	if (serialized) return "serialized";
	return "plain";
}

/** Whether a member in this mode is packed into a buffer, given the project's `networking.serialization`. */
export function isPackedMode(state: TransformState, mode: NetworkMode): boolean {
	if (mode === "raw") return false;
	if (mode === "plain") return state.projectConfig.networking?.serialization === true;
	return true;
}
