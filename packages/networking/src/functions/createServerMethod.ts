import { FunctionReceiverInterface } from "../function/createFunctionReceiver";
import { FunctionSenderInterface } from "../function/createFunctionSender";
import { NetworkingFunctionError } from "../function/errors";
import { timeoutPromise } from "../util/timeoutPromise";
import { FunctionCreateConfiguration, ServerReceiver, ServerSender } from "./types";

type ServerMethod = ServerSender<unknown[], unknown> & ServerReceiver<unknown[], unknown>;

export function createServerMethod(
	config: FunctionCreateConfiguration<unknown>,
	receiver?: FunctionReceiverInterface,
	sender?: FunctionSenderInterface,
) {
	const method: { [k in keyof ServerMethod]: ServerMethod[k] } = {
		invoke(player: Player, ...args: unknown[]) {
			return this.invokeWithTimeout(player, config.defaultTimeout, ...args);
		},

		invokeWithTimeout(player: Player, timeout: number, ...args: unknown[]) {
			assert(sender, "This is not a sender remote.");

			return Promise.race([
				timeoutPromise(timeout, NetworkingFunctionError.Timeout),
				sender.invokeClient(player, ...args),
			]);
		},

		// With serialization on, the transformer rewrites the methods above into these with the packed
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing.
		_invoke(player, ...packed) {
			return this.invokeWithTimeout(player, config.defaultTimeout, ...packed);
		},

		_invokeWithTimeout(player, timeout, ...packed) {
			return this.invokeWithTimeout(player, timeout, ...packed);
		},

		setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setServerCallback(callback);
		},

		// The transformer wraps the callback so its successful results arrive as `[payload, blobs?]`.
		_setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setServerCallback(callback as never, true);
		},

		predict(player, ...args) {
			assert(receiver, "This is not a receiver remote.");

			return receiver.invoke(player, ...args);
		},
	};

	setmetatable(method, {
		__call: (method, player, ...args) => {
			return method.invoke(player as Player, ...args);
		},
	});

	return method;
}
