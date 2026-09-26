import { NetworkInfo } from "../types";
import { Skip } from "./skip";

/**
 * Calls the next link of the chain and returns its result: nothing for an event, the value (or
 * `Networking.Skip`) for a function. A Promise the next link returned has already been waited for,
 * in this thread.
 */
export type MiddlewareProcessor<I extends readonly unknown[], O> = (player?: Player, ...args: I) => O;

/**
 * One link of the chain. It may yield, which holds up only the message it is processing, and it may
 * return a Promise, which is waited for before the link ahead of it continues.
 */
export type Middleware<I extends readonly unknown[] = unknown[], O = void> = (
	player?: Player,
	...args: I
) => O | Promise<O>;

export type MiddlewareFactory<I extends readonly unknown[] = [], O = void> = (
	processNext: MiddlewareProcessor<I, O>,
	event: NetworkInfo,
) => Middleware<I, O>;

export type EventMiddleware<I extends readonly unknown[] = unknown[]> = MiddlewareFactory<I, void>;
export type FunctionMiddleware<I extends readonly unknown[] = unknown[], O = void> = MiddlewareFactory<I, O | Skip>;
