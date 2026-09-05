import { Serialization } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { createEvent, decodeArguments } from "../event/createEvent";
import { NetworkInfo } from "../types";
import { NetworkingFunctionError, getFunctionError } from "./errors";
import { t } from "@rbxts/t";

export interface CreateFunctionSenderOptions {
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
	responseMiddleware?: (
		player: Player | undefined,
		value: unknown,
		resolve: (value: unknown) => void,
		reject: (value: unknown) => void,
	) => void;

	/**
	 * Unpacks a successful response's value, carried as a one-element list. Absent when the project
	 * does not enable serialization. Requests reach `invoke*` already packed by the transformer.
	 */
	resultDecoder?: Serialization.Decoder;

	/**
	 * Called when a response cannot be decoded; the request is rejected with `InvalidResult`.
	 */
	onMalformed?: (player: Player | undefined, message: string) => void;
}

export interface RequestInfo {
	nextId: number;
	requests: Map<number, (value: unknown, rejection?: NetworkingFunctionError) => void>;
}

export interface FunctionSenderInterface {
	invokeServer(...args: unknown[]): Promise<unknown>;
	invokeClient(player: Player, ...args: unknown[]): Promise<unknown>;
}

export function createFunctionSender(options: CreateFunctionSenderOptions): FunctionSenderInterface {
	const event = createEvent({
		namespace: options.namespace,
		debugName: options.debugName,
		id: options.id,
		networkInfo: options.networkInfo,
	});

	const processResponse = (
		player: Player | undefined,
		requestInfo: RequestInfo,
		id: unknown,
		processResult: unknown,
		...response: unknown[]
	) => {
		if (!t.number(id)) {
			return;
		}

		const request = requestInfo.requests.get(id);
		requestInfo.requests.delete(id);
		if (!request) {
			return;
		}

		const rejection = getFunctionError(processResult);
		if (rejection !== undefined || !options.resultDecoder) {
			request(response[0], rejection);
			return;
		}

		// A successful response carries the packed value: `(buffer, blobs?)`.
		const decoded = decodeArguments(options.resultDecoder, player, response, options.onMalformed);
		if (!decoded) {
			request(undefined, NetworkingFunctionError.InvalidResult);
			return;
		}

		request(decoded[0], undefined);
	};

	// We don't need to defer here because we only accept responses to our explicit invocations.
	const requestInfoServer = new Map<Player, RequestInfo>();
	const requestInfoClient = createRequestInfo();
	if (RunService.IsServer()) {
		event.connectServer((player, id, processResult, ...response) => {
			const requestInfo = requestInfoServer.get(player);
			if (!requestInfo) {
				return;
			}

			processResponse(player, requestInfo, id, processResult, ...response);
		});

		Players.PlayerRemoving.Connect((player) => {
			const requestInfo = requestInfoServer.get(player);
			requestInfoServer.delete(player);

			if (requestInfo) {
				// Cancel all existing requests from this player.
				for (const [, request] of requestInfo.requests) {
					request(undefined, NetworkingFunctionError.Cancelled);
				}
			}
		});
	} else {
		event.connectClient((id, processResult, ...response) => {
			processResponse(undefined, requestInfoClient, id, processResult, ...response);
		});
	}

	const createInvocation = (player: Player | undefined, id: number, requestInfo: RequestInfo) => {
		return new Promise((resolve, reject, onCancel) => {
			requestInfo.requests.set(id, (value, rejection) => {
				if (rejection) {
					return reject(rejection);
				}

				if (options.responseMiddleware) {
					options.responseMiddleware(player, value, resolve, reject);
				} else {
					resolve(value);
				}
			});

			onCancel(() => {
				requestInfo!.requests.delete(id);
			});
		});
	};

	return {
		invokeServer(...args) {
			const id = requestInfoClient.nextId++;
			event.fireServer(id, ...args);

			return createInvocation(undefined, id, requestInfoClient);
		},

		invokeClient(player, ...args) {
			let requestInfo = requestInfoServer.get(player);
			if (!requestInfo) requestInfoServer.set(player, (requestInfo = createRequestInfo()));

			const id = requestInfoClient.nextId++;
			event.fireClient(player, id, ...args);

			return createInvocation(player, id, requestInfo);
		},
	};
}

function createRequestInfo(): RequestInfo {
	return {
		nextId: 0,
		requests: new Map(),
	};
}
