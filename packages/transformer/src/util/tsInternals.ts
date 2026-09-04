import ts from "typescript";

/**
 * TypeScript does not export these `TypeFlags` members, and enum declaration merging would require
 * hardcoding their numeric values -- which are computed from other flags and drift between
 * releases. Reading them off the real enum keeps them correct for whatever TypeScript the project
 * happens to be compiling with.
 */
const internalTypeFlags = ts.TypeFlags as typeof ts.TypeFlags & {
	Intrinsic: number;
	DisjointDomains: number;
};

export const TYPE_FLAG_INTRINSIC = internalTypeFlags.Intrinsic;
export const TYPE_FLAG_DISJOINT_DOMAINS = internalTypeFlags.DisjointDomains;
