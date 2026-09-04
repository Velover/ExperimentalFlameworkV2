import { Flamework } from "@flamework/core";

export const stringGuard = Flamework.createGuard<string>();
export const objectGuard = Flamework.createGuard<{ a: number; b?: string }>();
export const unionGuard = Flamework.createGuard<string | number>();
export const arrayGuard = Flamework.createGuard<string[]>();
export const cframeGuard = Flamework.createGuard<CFrame>();
