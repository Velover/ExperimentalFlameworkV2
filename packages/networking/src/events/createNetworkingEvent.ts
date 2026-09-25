import { RunService } from "@rbxts/services";
import { createClientMethod } from "./createClientMethod";
import { createServerMethod } from "./createServerMethod";
import { ClientHandler, EventCreateConfiguration, GlobalEvent, ServerHandler } from "./types";
import { createSignalContainer } from "../util/createSignalContainer";
import { EventNetworkingEvents } from "../handlers";
import { createGenericHandler } from "./createGenericHandler";
import { createOnce } from "../util/createOnce";

function getDefaultConfiguration<T>(config: Partial<EventCreateConfiguration<T>>) {
	return identity<EventCreateConfiguration<T>>({
		middleware: config.middleware ?? {},
		warnOnInvalidGuards: config.warnOnInvalidGuards ?? RunService.IsStudio(),
		disableIncomingGuards: config.disableIncomingGuards ?? false,
	});
}

export function createNetworkingEvent<S, C>(globalName: string): GlobalEvent<S, C> {
	const signals = createSignalContainer<EventNetworkingEvents>();

	let server: ServerHandler<C, S> | undefined;
	// Built once: building it waits for the server's remotes, and a thread that asks meanwhile gets the
	// same handler rather than a second one wired to the same remotes.
	const client = createOnce<ClientHandler<S, C>>();

	return {
		createServer(config, meta) {
			if (RunService.IsRunning() && !RunService.IsServer()) {
				return undefined!;
			}

			if (server === undefined) {
				server = createGenericHandler<ServerHandler<C, S>, C, S>(
					globalName,
					undefined,
					meta!,
					getDefaultConfiguration(config),
					signals,
					createServerMethod,
				);
			}

			return server;
		},

		createClient(config, meta) {
			if (RunService.IsRunning() && !RunService.IsClient()) {
				return undefined!;
			}

			return client(() =>
				createGenericHandler<ClientHandler<S, C>, S, C>(
					globalName,
					undefined,
					meta!,
					getDefaultConfiguration(config),
					signals,
					createClientMethod,
				),
			);
		},

		registerHandler(key, callback) {
			return signals.connect(key, callback);
		},
	};
}
