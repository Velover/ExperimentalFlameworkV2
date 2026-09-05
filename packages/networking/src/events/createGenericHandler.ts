import { EventNetworkingEvents } from "../handlers";
import { NetworkInfo } from "../types";
import { ClientHandler, EventCreateConfiguration, Events, NamespaceMetadata, ServerHandler } from "./types";
import { SignalContainer } from "../util/createSignalContainer";
import { createGuardMiddleware } from "../middleware/createGuardMiddleware";
import { EventInterface, createEvent } from "../event/createEvent";
import { getNamespaceConfig } from "../util/getNamespaceConfig";
import { Players } from "@rbxts/services";

export function createGenericHandler<T extends ClientHandler<S, R> | ServerHandler<S, R>, S, R>(
	globalName: string,
	namespaceName: string | undefined,
	metadata: NamespaceMetadata<R, S>,
	config: EventCreateConfiguration<R>,
	signals: SignalContainer<EventNetworkingEvents>,
	method: (receiver: EventInterface, sender: EventInterface) => unknown,
): T {
	const handler = {} as T;

	const receiverNameSet = new Set(metadata.incomingIds);
	const senderNameSet = new Set(metadata.outgoingIds);
	for (const name of new Set([...metadata.incomingIds, ...metadata.outgoingIds])) {
		const isIncoming = receiverNameSet.has(name);
		const isOutgoing = senderNameSet.has(name);
		// If there is no incoming/outgoing event, use the same reliability as the other.
		const incomingChannel = isIncoming ? metadata.incomingUnreliable : metadata.outgoingUnreliable;
		const outgoingChannel = isOutgoing ? metadata.outgoingUnreliable : metadata.incomingUnreliable;
		const isIncomingUnreliable = incomingChannel[name] === true;
		const isOutgoingUnreliable = outgoingChannel[name] === true;
		const configMiddleware = config.middleware[name as keyof Events<R>];
		const incomingMiddleware = configMiddleware !== undefined ? table.clone(configMiddleware) : [];
		const effectiveName = namespaceName !== undefined ? `${namespaceName}/${name}` : name;
		const networkInfo: NetworkInfo = {
			eventType: "Event",
			name: effectiveName,
			globalName,
		};

		if (!config.disableIncomingGuards && isIncoming) {
			const guards = metadata.incoming[name];
			assert(guards);

			incomingMiddleware.unshift(
				createGuardMiddleware(name, guards[0], guards[1], networkInfo, config.warnOnInvalidGuards, signals),
			);
		}

		// A malformed serialized payload is reported like a failed guard, with no argument index.
		const onMalformed = (player: Player | undefined, message: string) => {
			if (config.warnOnInvalidGuards) {
				const sender = player !== undefined ? `'${player}'` : "Server";
				warn(`${sender} sent a malformed payload for event '${name}': ${message}`);
			}

			signals.fire("onBadRequest", player ?? Players.LocalPlayer, {
				networkInfo,
				argIndex: -1,
				argValue: message,
			});
		};

		const create = (unreliable: boolean, receives: boolean) => {
			return createEvent({
				reliability: unreliable ? "unreliable" : "reliable",
				namespace: globalName,
				id: unreliable ? `unreliable:${effectiveName}` : effectiveName,
				debugName: name,
				networkInfo,
				incomingMiddleware,
				incomingDecoder: receives ? (metadata.incomingSerializers?.[name] as never) : undefined,
				onMalformed,
			});
		};

		const shared = isOutgoingUnreliable === isIncomingUnreliable;
		const receiver = create(isIncomingUnreliable, true);
		const sender = shared ? receiver : create(isOutgoingUnreliable, false);

		handler[name as keyof T] = method(receiver, sender) as never;
	}

	for (const namespaceId of metadata.namespaceIds) {
		const namespace = metadata.namespaces[namespaceId];
		handler[namespaceId as keyof T] = createGenericHandler(
			globalName,
			namespaceName !== undefined ? `${namespaceName}/${namespaceId}` : namespaceId,
			namespace as never,
			getNamespaceConfig(config, namespaceId),
			signals,
			method,
		);
	}

	return handler;
}
