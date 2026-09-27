import { Dependency, Flamework, Modding, Provider } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

// A macro call written directly as an argument of another macro call. Each of these used to reach
// the output untransformed: the outer macro visited its argument's children, never the argument.

@Provider()
export class Economy {}

/** @metadata macro */
export function idOf<T>(id?: Modding.Target.Id<T>): string {
	return id!;
}

/** @metadata macro */
export function tagged<T>(value: string, id?: Modding.Target.Id<T>): string {
	return `${value}/${id!}`;
}

/** @metadata macro */
export function typedId<T>(id?: Modding.Target.Id<T>): Modding.Target.Id<T> {
	return id!;
}

/** @metadata macro */
export function eventName(name?: Modding.Caller.Uuid): Modding.Caller.Uuid {
	return name!;
}

// The reported case: a core macro in a core macro.
export function resolveEconomy() {
	return Dependency<Economy>(undefined, Flamework.id<Economy>());
}

// A user macro in a core macro that is rewritten to its runtime implementation.
export function implementsEconomy(value: unknown) {
	return Flamework.implements<Economy>(value, typedId<Economy>());
}

// A user macro in a core macro.
export function resolveThroughUserMacro() {
	return Dependency<Economy>(undefined, idOf<Economy>());
}

// A core macro in a user macro.
export const coreInUser = tagged<Economy>(Flamework.id<Economy>());

// A user macro in a networking macro.
export const namedEvents = Networking.createEvent<{ ping(): void }, {}>(eventName());

// Two levels: a core macro in a user macro in a core macro.
export function twoLevels() {
	return Dependency<Economy>(undefined, tagged<Economy>(Flamework.id<Economy>()));
}

// Three levels, user macros all the way down.
export const threeLevels = tagged<Economy>(tagged<Economy>(tagged<Economy>(idOf<Economy>())));
