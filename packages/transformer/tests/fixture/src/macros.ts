import { Modding } from "@flamework-experimental/core";

export interface FieldInfo {
	name: string;
	kind: string;
	optional: boolean;
	readonly: boolean;
}

/** @metadata macro */
export function fieldInfo<T>(meta?: Modding.Intrinsic<"plugin", ["fieldInfo", T], FieldInfo[]>): FieldInfo[] {
	return meta!;
}

/** @metadata macro */
export function describe<T>(meta?: Modding.Intrinsic<"plugin", ["describe", T], string>): string {
	return meta!;
}

/** @metadata macro */
export function counter<T>(
	meta?: Modding.Intrinsic<"plugin", ["counter", T], (increment: number) => number>,
): (increment: number) => number {
	return meta!;
}

/** @metadata macro */
export function callsiteId(id?: Modding.Caller.Uuid): string {
	return id!;
}
