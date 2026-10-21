import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { NETWORKING_PACKAGE } from "../packages";
import { getDeclaringPackage } from "./getFlameworkDecorators";

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
 * `member` is the member's declared type (`undefined`, `unknown` or `any` reads as plain), `name`
 * what to call it in the message.
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

/** The markers dropped before beta, each with the marker that replaces it: the same type. */
const REMOVED_MARKERS = new Map([
	["SerializedReliable", "Serialized"],
	["RawReliable", "Raw"],
]);

/**
 * TypeScript's error for `Networking.SerializedReliable` or `Networking.RawReliable`, which were dropped
 * before beta, as one that names the marker replacing it; `undefined` for any other diagnostic.
 * TypeScript's own asks "Did you mean 'SerializedUnreliable'?", which would make the event unreliable.
 * Only TypeScript's "no exported member" errors are looked at, so a build without one pays nothing,
 * and only where the namespace is networking's own: a namespace of the user's that happens to look
 * like it keeps TypeScript's message.
 */
export function explainRemovedNetworkMarker(
	state: TransformState,
	diagnostic: ts.DiagnosticWithLocation,
): ts.DiagnosticWithLocation | undefined {
	// 2694: has no exported member 'X'. 2724: has no exported member named 'X'. Did you mean 'Y'?
	if (diagnostic.code !== 2694 && diagnostic.code !== 2724) return undefined;

	const file = diagnostic.file;
	const name = ts.getTokenAtPosition(file, diagnostic.start);
	if (!ts.isIdentifier(name) || !ts.isQualifiedName(name.parent) || name.parent.right !== name) return undefined;

	const replacement = REMOVED_MARKERS.get(name.text);
	if (replacement === undefined) return undefined;

	// Only networking's namespace, however it was imported or renamed.
	let namespace = state.typeChecker.getSymbolAtLocation(name.parent.left);
	if (namespace && namespace.flags & ts.SymbolFlags.Alias) namespace = state.typeChecker.getAliasedSymbol(namespace);
	const declaredByNetworking = namespace?.declarations?.some(
		(declaration) => getDeclaringPackage(declaration) === NETWORKING_PACKAGE,
	);
	if (!declaredByNetworking) return undefined;

	const written = name.parent.left.getText(file);
	return Diagnostics.createDiagnostic(
		name.parent,
		ts.DiagnosticCategory.Error,
		`'${written}.${name.text}' was removed before beta. It was the same type as '${written}.${replacement}', which replaces it.`,
		`Write '${written}.${replacement}<...>'. '${replacement}Unreliable' would make the event unreliable.`,
	);
}

/** Whether a member in this mode is packed into a buffer, given the project's `networking.serialization`. */
export function isPackedMode(state: TransformState, mode: NetworkMode): boolean {
	if (mode === "raw") return false;
	if (mode === "plain") return state.projectConfig.networking?.serialization === true;
	return true;
}
