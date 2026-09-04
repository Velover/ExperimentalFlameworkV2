import { describe, fieldInfo } from "./macros";

interface PlayerSave {
	coins: number;
	readonly userId: number;
	nickname?: string;
	pets: string[];
}

export const saveFields = fieldInfo<PlayerSave>();

// Used twice in this file: the second call must reuse the hoisted constant.
export const saveFieldsAgain = fieldInfo<PlayerSave>();

export const literalKind = describe<"hello">();
export const numberLiteralKind = describe<42>();
export const booleanLiteralKind = describe<true>();
export const unionKind = describe<string | number>();
export const tupleKind = describe<[string, number]>();
export const arrayKind = describe<boolean[]>();
