/**
 * What each class implements, own and inherited, as `getClassImplements` found it, by the class --
 * and by every class above it, which it walked on the way. Its own module, apart from
 * `getClassImplements`, so that `Reflect`, which that one reads through, can reach it too.
 */
export const implementsCache = {
	byClass: new WeakMap<object, ReadonlyArray<string>>(),
};

/**
 * Forgets every list once an object whose `flamework:implements` metadata one was built from has
 * it changed: the lists of the classes below it were built from it too. The transformer writes a
 * class's metadata as the class is defined, before anything can ask, so this does not happen in a
 * game; it keeps a later change seen as it was before the lists were cached. What `listen` gives
 * its proxies changes nothing here: an object that implements something of its own is not cached.
 */
export function forgetImplements(object: object) {
	if (implementsCache.byClass.has(object)) {
		implementsCache.byClass = new WeakMap();
	}
}
