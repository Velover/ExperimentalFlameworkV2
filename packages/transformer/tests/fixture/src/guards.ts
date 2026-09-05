import { Flamework } from "@flamework/core";

export const stringGuard = Flamework.createGuard<string>();
export const objectGuard = Flamework.createGuard<{ a: number; b?: string }>();
export const unionGuard = Flamework.createGuard<string | number>();
export const arrayGuard = Flamework.createGuard<string[]>();
export const cframeGuard = Flamework.createGuard<CFrame>();

// More than two members: `t` has a hard argument limit, so these must use the `*List` variants.
export const literalListGuard = Flamework.createGuard<"a" | "b" | "c" | "d" | "e">();
export const unionListGuard = Flamework.createGuard<string | number | Vector3>();
