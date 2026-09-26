import { Serialization } from "@flamework-experimental/core";
import { t } from "@rbxts/t";
import { NetworkInfo } from "../types";
import { MiddlewareFactory } from "./types";
import { Signal } from "../util/signal";

/** One step of the receive pipeline: `(player, ...args) -> result`. The player is `undefined` on a client. */
export type Processor = (player: Player | undefined, ...args: unknown[]) => unknown;

/** The generated argument checks, run ahead of all user middleware. */
export interface Guards {
	/** `fixed[i]` checks argument `i`. */
	fixed: ReadonlyArray<t.check<unknown>>;

	/** Checks every argument past the fixed ones, for a rest parameter. */
	rest: t.check<unknown> | undefined;

	/** Called with the first argument that failed, by its 0-based index. */
	reject: (player: Player | undefined, index: number, value: unknown) => void;
}

/**
 * Folds the guards and the middleware into one processor that runs them as plain calls in the
 * calling thread and returns what the last link did, a Promise already followed (see `processor.luau`).
 * @param rejected What the processor returns when a guard fails.
 * @param cancelled What a Promise that was cancelled reads as.
 */
export function createProcessor(
	middleware: ReadonlyArray<MiddlewareFactory<any, any>> | undefined,
	networkInfo: NetworkInfo,
	final: Processor,
	guards: Guards | undefined,
	rejected: unknown,
	cancelled: unknown,
): Processor;

/**
 * The handler for a remote's `OnServerEvent` (`withPlayer`) or `OnClientEvent`: decodes the payload
 * when there is a decoder, reporting and dropping one it cannot read, and runs `process`.
 */
export function createReceiver(
	decoder: Serialization.Decoder | undefined,
	onMalformed: ((player: Player | undefined, message: string) => void) | undefined,
	process: Processor,
	withPlayer: boolean,
): (...args: unknown[]) => void;

/**
 * Unpacks a serialized argument list, `(payload, blobs?)` as the remote carried it, under `pcall`:
 * `true` and the list, or `false` and why it could not be read.
 */
export function decode(
	decoder: Serialization.Decoder,
	payload: unknown,
	blobs: unknown,
): LuaTuple<[ok: true, list: unknown[]] | [ok: false, message: string]>;

/** The last step of an event's chain: fires `signal`, with the sender first when `withPlayer`. */
export function deliverTo(signal: Signal, withPlayer: boolean): Processor;

/** `callback` called without the player in front, which is how a client's callback is written. */
export function withoutPlayer(callback: (...args: never[]) => unknown): Processor;
