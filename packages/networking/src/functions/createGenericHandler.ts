import { NetworkingFunctionError } from "../function/errors";
import { NetworkInfo } from "../types";
import { FunctionNetworkingEvents } from "../handlers";
import { ClientHandler, FunctionCreateConfiguration, Functions, NamespaceMetadata, ServerHandler } from "./types";
import { SignalContainer } from "../util/createSignalContainer";
import { createFunctionReceiver, FunctionReceiverInterface } from "../function/createFunctionReceiver";
import { createFunctionSender, FunctionSenderInterface } from "../function/createFunctionSender";
import { createGuards } from "../middleware/createGuards";
import { Guards } from "../middleware/processor";
import { Players } from "@rbxts/services";
import { getNamespaceConfig } from "../util/getNamespaceConfig";

export type MethodCreator = (
	config: FunctionCreateConfiguration<unknown>,
	receiver?: FunctionReceiverInterface,
	sender?: FunctionSenderInterface,
) => unknown;

export function createGenericHandler<T extends ClientHandler<S, R> | ServerHandler<S, R>, S, R>(
	globalName: string,
	namespaceName: string | undefined,
	receiverPrefix: string,
	senderPrefix: string,
	metadata: NamespaceMetadata<R, S>,
	config: FunctionCreateConfiguration<R>,
	signals: SignalContainer<FunctionNetworkingEvents>,
	createMethod: MethodCreator,
): T {
	const handler = {} as T;

	const receiverNameSet = new Set(metadata.incomingIds);
	const senderNameSet = new Set(metadata.outgoingIds);
	for (const name of new Set([...metadata.incomingIds, ...metadata.outgoingIds])) {
		const configMiddleware = config.middleware[name as keyof Functions<R>];
		const incomingMiddleware = configMiddleware !== undefined ? table.clone(configMiddleware) : [];
		const isReceiver = receiverNameSet.has(name);
		const isSender = senderNameSet.has(name);
		const effectiveName = namespaceName !== undefined ? `${namespaceName}/${name}` : name;
		const networkInfo: NetworkInfo = {
			eventType: "Function",
			name: effectiveName,
			globalName,
		};

		// The generated guards run ahead of all user middleware; a request that fails them is answered
		// `BadRequest`.
		let incomingGuards: Guards | undefined;
		if (!config.disableIncomingGuards && isReceiver) {
			const guards = metadata.incoming[name];
			assert(guards);

			incomingGuards = createGuards(
				name,
				guards[0],
				guards[1],
				guards[2],
				networkInfo,
				config.warnOnInvalidGuards,
				signals,
			);
		}

		// A malformed serialized payload is reported like a failed guard, with no argument index.
		const onMalformed = (player: Player | undefined, message: string) => {
			if (config.warnOnInvalidGuards) {
				const sender = player !== undefined ? `'${player}'` : "Server";
				warn(`${sender} sent a malformed payload for function '${name}': ${message}`);
			}

			signals.fire("onBadRequest", player ?? Players.LocalPlayer, {
				networkInfo,
				argIndex: -1,
				argValue: message,
			});
		};

		const receiver = isReceiver
			? createFunctionReceiver({
					namespace: globalName,
					debugName: name,
					// Prefixed even when the function goes one way: `$` and `@` are valid in names, so a bare
					// `$name` would be the same id as the prefixed receiver of a two-way `name`.
					id: `${receiverPrefix}${effectiveName}`,
					networkInfo,
					incomingMiddleware,
					incomingGuards,
					argsDecoder: metadata.incomingSerializers?.[name] as never,
					onMalformed,
				})
			: undefined;

		const sender = isSender
			? createFunctionSender({
					namespace: globalName,
					debugName: name,
					id: `${senderPrefix}${effectiveName}`,
					networkInfo,
					resultDecoder: metadata.outgoingResults?.[name] as never,
					// A response that cannot be decoded is a bad response, like one failing the return guard.
					onMalformed: (player, message) => {
						if (config.warnOnInvalidGuards) {
							warn(`Received a malformed response for function '${name}': ${message}`);
						}

						signals.fire("onBadResponse", player ?? Players.LocalPlayer, { networkInfo, value: message });
					},
					responseMiddleware: config.disableIncomingGuards
						? undefined
						: (player, value, resolve, reject) => {
								const returnGuard = metadata.outgoing[name];
								if (returnGuard && !returnGuard(value)) {
									reject(NetworkingFunctionError.InvalidResult);

									signals.fire("onBadResponse", player ?? Players.LocalPlayer, {
										networkInfo,
										value,
									});
								} else {
									resolve(value);
								}
							},
				})
			: undefined;

		handler[name as keyof T] = createMethod(config, receiver, sender) as never;
	}

	for (const namespaceId of metadata.namespaceIds) {
		const namespace = metadata.namespaces[namespaceId];
		handler[namespaceId as keyof T] = createGenericHandler(
			globalName,
			namespaceName !== undefined ? `${namespaceName}/${namespaceId}` : namespaceId,
			receiverPrefix,
			senderPrefix,
			namespace as never,
			getNamespaceConfig(config, namespaceId),
			signals,
			createMethod,
		);
	}

	return handler;
}
