export type ToWritable<T> =
	T extends ReadonlySet<infer V> ? Set<V> : T extends ReadonlyMap<infer K, infer V> ? Map<K, V> : Writable<T>;

export type WritableState<T> = Writable<{ [k in keyof T]: ToWritable<T[k]> }>;
