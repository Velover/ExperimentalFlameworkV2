/**
 * What a Flamework listener returns: `Connected`, and `Disconnect()` to stop listening. Typed by its
 * shape, so that the object behind it may change without breaking code that holds one. An engine
 * `RBXScriptConnection` and networking's `Networking.Connection` both satisfy it.
 */
export interface Connection {
	readonly Connected: boolean;
	Disconnect(): void;
}

/**
 * Alias for destructors, which is just a callback.
 */
export type Destructor = () => void;

/**
 * Checks whether `T` is a union.
 */
export type IsUnion<T, U = T> = T extends T ? (U extends T ? false : true) : never;

/**
 * Checks whether this interface contains a single field, which is also a Callback.
 */
export type HasSingleCallback<T> = [IsUnion<keyof T>, T[keyof T]] extends [false, Callback] ? true : false;

/**
 * If this interface contains a single callback, extract its type.
 */
export type ExtractSingleCallback<T> = HasSingleCallback<T> extends true ? T[keyof T] : never;
