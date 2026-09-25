import { RunService } from "@rbxts/services";
import { ClientHandler, FunctionCreateConfiguration, GlobalFunction, ServerHandler } from "./types";
import { createSignalContainer } from "../util/createSignalContainer";
import { FunctionNetworkingEvents } from "../handlers";
import { createGenericHandler } from "./createGenericHandler";
import { createServerMethod } from "./createServerMethod";
import { createClientMethod } from "./createClientMethod";
import { createOnce } from "../util/createOnce";

const SERVER_PREFIX = "$";
const CLIENT_PREFIX = "@";

function getDefaultConfiguration<T>(config: Partial<FunctionCreateConfiguration<T>>) {
	return identity<FunctionCreateConfiguration<T>>({
		middleware: config.middleware ?? {},
		defaultTimeout: config.defaultTimeout ?? (RunService.IsClient() ? 30 : 10),
		warnOnInvalidGuards: config.warnOnInvalidGuards ?? RunService.IsStudio(),
		disableIncomingGuards: config.disableIncomingGuards ?? false,
	});
}

export function createNetworkingFunction<S, C>(globalName: string): GlobalFunction<S, C> {
	const signals = createSignalContainer<FunctionNetworkingEvents>();

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
					SERVER_PREFIX,
					CLIENT_PREFIX,
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
					CLIENT_PREFIX,
					SERVER_PREFIX,
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
