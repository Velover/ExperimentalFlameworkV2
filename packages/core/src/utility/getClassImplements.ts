import { Reflect } from "../reflect";
import { implementsCache } from "./implementsCache";

const IMPLEMENTS = "flamework:implements";

const EMPTY: ReadonlyArray<string> = table.freeze([]);

/** Where `Reflect.getMetadatas` goes next from an object: its metatable's `__index`, its class. */
function getParent(object: object) {
	const metatable = getmetatable(object) as { __index?: object } | undefined;
	if (metatable !== undefined && typeIs(metatable, "table")) {
		return rawget(metatable, "__index") as object | undefined;
	}
}

/**
 * The walk as `Reflect.getMetadatas` makes it, for an object whose list is not cached: every
 * `flamework:implements` list from the object up its chain, each id once, first seen first.
 */
function collect(object: object) {
	const classImplements = new Array<string>();
	const seen = new Set<string>();

	for (const implementList of Reflect.getMetadatas<string[]>(object, IMPLEMENTS)) {
		for (const implementId of implementList) {
			if (!seen.has(implementId)) {
				seen.add(implementId);
				classImplements.push(implementId);
			}
		}
	}

	return classImplements;
}

/**
 * A class's list, built once: its own ids, then those of the class above it that it does not
 * re-declare, which is the order and the ids `collect` finds. One that declares nothing of its own
 * shares the list above it.
 */
function getCachedImplements(object: object): ReadonlyArray<string> {
	const cached = implementsCache.byClass.get(object);
	if (cached !== undefined) {
		return cached;
	}

	const parent = getParent(object);
	const inherited = parent !== undefined ? getCachedImplements(parent) : EMPTY;

	let list = inherited;
	const own = Reflect.getOwnMetadata<string[]>(object, IMPLEMENTS);
	if (own !== undefined) {
		const merged = new Array<string>();
		for (const implementId of own) {
			if (!merged.includes(implementId)) {
				merged.push(implementId);
			}
		}

		for (const implementId of inherited) {
			if (!merged.includes(implementId)) {
				merged.push(implementId);
			}
		}

		list = table.freeze(merged);
	}

	implementsCache.byClass.set(object, list);
	return list;
}

/**
 * The interfaces an object implements, own and inherited, each once: the transformer writes every
 * class's own heritage clause, so a subclass that re-declares an interface its parent implements
 * carries the id twice up the chain, and attached to it twice -- the lifecycle's ordered lists ran
 * `onInit` and `onStart` twice for it.
 *
 * Walked once per class and kept: this runs on every attach and detach, and behind
 * `Flamework.implements`. An instance, which implements nothing of its own, answers its class's
 * list; so does a class asked directly. An object that implements something of its own -- a
 * `listen` proxy, a plain object given the metadata -- or whose `__index` is not a table is walked
 * every time, as before, rather than kept per object. The list is shared and frozen: callers must
 * not change it.
 */
export function getClassImplements(object: object): ReadonlyArray<string> {
	if (Reflect.getOwnMetadata(object, IMPLEMENTS) === undefined) {
		const parent = getParent(object);
		if (parent === undefined) return EMPTY;
		if (typeIs(parent, "table")) return getCachedImplements(parent);
	} else if (typeIs(object, "table") && rawget(object, "__index") === object) {
		// A class: a roblox-ts class is its own instances' `__index`.
		return getCachedImplements(object);
	}

	return collect(object);
}
