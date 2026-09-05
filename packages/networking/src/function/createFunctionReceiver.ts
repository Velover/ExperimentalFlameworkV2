import { Serialization } from "@flamework/core";
import { RunService } from "@rbxts/services";
import { createEvent, decodeArguments } from "../event/createEvent";
import { NetworkInfo } from "../types";
import { NetworkingFunctionError } from "./errors";
import { createMiddlewareProcessor } from "../middleware/createMiddlewareProcessor";
import { MiddlewareFactory, MiddlewareProcessor } from "../middleware/types";
import { Skip, SkipBadRequest } from "../middleware/skip";

export interface CreateFunctionReceiverOptions {
	/**
	 * The namespace this event should be created in.
	 */
	namespace: string;

	/**
	 * The name of the remote instance, not necessarily unique and used for debugging purposes.
	 */
	debugName: string;

	/**
	 * The remote's ID which must be unique.
	 */
	id: string;

	/**
	 * Information about the network, which includes some of the above.
	 *
	 * Passed to the middleware.
	 */
	networkInfo: NetworkInfo;

	/**
	 * This function will be called when we receive a response, and can be used to resolve or reject values.
	 */
	incomingMiddleware?: MiddlewareFactory<any[], any>[];

	/**
	 * Unpacks the request's argument list. Absent when the project does not enable serialization.
	 */
	argsCodec?: Serialization.Codec;

	/**
	 * Packs a successful response's value, as a one-element list. Absent when the project does not
	 * enable serialization.
	 */
	resultCodec?: Serialization.Codec;

	/**
	 * Called when a request cannot be decoded; the caller receives `BadRequest`.
	 */
	onMalformed?: (player: Player | undefined, message: string) => void;
}

export interface RequestInfo {
	nextId: number;
	requests: Map<number, (value: unknown, rejection?: NetworkingFunctionError) => void>;
}

export interface FunctionReceiverInterface {
	setServerCallback(callback: (player: Player, ...args: unknown[]) => unknown): void;
	setClientCallback(callback: (...args: unknown[]) => unknown): void;
	invoke(player: Player | undefined, ...args: unknown[]): Promise<unknown>;
}

export function createFunctionReceiver(options: CreateFunctionReceiverOptions): FunctionReceiverInterface {
	const event = createEvent({
		namespace: options.namespace,
		debugName: options.debugName,
		id: options.id,
		networkInfo: options.networkInfo,
	});

	let callback: MiddlewareProcessor<unknown[], unknown>;

	const setCallback = (newCallback: (...args: never[]) => unknown) => {
		callback = createMiddlewareProcessor(options.incomingMiddleware, options.networkInfo, (player, ...args) => {
			if (RunService.IsServer()) {
				return newCallback(player as never, ...(args as never[]));
			} else {
				return newCallback(...(args as never[]));
			}
		});
	};

	/** A successful value goes back packed when there is a codec; errors always go back as they are. */
	const respond = (player: Player | undefined, id: unknown, processResult: unknown, value?: unknown) => {
		const codec = options.resultCodec;
		if (processResult === true && codec) {
			const [payload, blobs] = codec.encode([value]);
			event.fireEither(player, id, processResult, payload, blobs);
		} else {
			event.fireEither(player, id, processResult, value);
		}
	};

	const processRequest = (player: Player | undefined, id: unknown, ...args: unknown[]) => {
		if (!callback) {
			return event.fireEither(player, id, NetworkingFunctionError.Unprocessed);
		}

		const decoded = decodeArguments(options.argsCodec, player, args, options.onMalformed);
		if (!decoded) {
			return event.fireEither(player, id, NetworkingFunctionError.BadRequest);
		}

		callback(player, ...decoded)
			.then((value) => respond(player, id, getProcessResult(value), value))
			.catch((reason) => {
				warn(`Failed to process request to '${options.debugName}'`);
				warn(reason);

				event.fireEither(player, id, false);
			});
	};

	if (RunService.IsServer()) {
		event.connectServer((player, id, ...args) => processRequest(player, id, ...args));
	} else {
		event.connectClient((id, ...args) => processRequest(undefined, id, ...args));
	}

	return {
		setServerCallback(callback) {
			setCallback(callback);
		},

		setClientCallback(callback) {
			setCallback(callback);
		},

		invoke(player, ...args) {
			if (!callback) {
				return Promise.reject(NetworkingFunctionError.Unprocessed);
			}

			return callback(player, ...args).then((value) => {
				const processResult = getProcessResult(value);
				return processResult === true ? value : Promise.reject(processResult);
			});
		},
	};
}

function getProcessResult(value: unknown) {
	return value === Skip
		? NetworkingFunctionError.Cancelled
		: value === SkipBadRequest
			? NetworkingFunctionError.BadRequest
			: true;
}
