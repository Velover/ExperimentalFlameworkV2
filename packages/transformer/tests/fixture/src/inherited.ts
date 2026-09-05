import { Injectable, Provider } from "@flamework/core";

@Provider()
export class Dep {}

@Injectable()
export class GenericBase<T> {
	constructor(public value: T) {}
}

// Regression: the inherited constructor was read from the base declaration, so its parameter came
// out as `T` and the transformer crashed instead of resolving it to `Dep` at this class.
@Provider()
export class Derived extends GenericBase<Dep> {}
