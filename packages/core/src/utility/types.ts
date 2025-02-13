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
