import { FunctionReceiverInterface } from "../function/createFunctionReceiver";
import { FunctionSenderInterface } from "../function/createFunctionSender";
import { NetworkingFunctionError } from "../function/errors";
import { timeoutPromise } from "../util/timeoutPromise";
import { ClientReceiver, ClientSender, FunctionCreateConfiguration } from "./types";

type ClientMethod = ClientSender<unknown[], unknown> & ClientReceiver<unknown[], unknown>;

export function createClientMethod(
	config: FunctionCreateConfiguration<unknown>,
	receiver?: FunctionReceiverInterface,
	sender?: FunctionSenderInterface,
) {
	const method: { [k in keyof ClientMethod]: ClientMethod[k] } = {
		invoke(...args: unknown[]) {
			return this.invokeWithTimeout(config.defaultTimeout, ...args);
		},

		invokeWithTimeout(timeout: number, ...args: unknown[]) {
			assert(sender, "This is not a sender remote.");

			return Promise.race([
				timeoutPromise(timeout, NetworkingFunctionError.Timeout),
				sender.invokeServer(...args),
			]);
		},

		// With serialization on, the transformer rewrites the methods above into these with the packed
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing.
		_invoke(...packed) {
			return this.invokeWithTimeout(config.defaultTimeout, ...packed);
		},

		_invokeWithTimeout(timeout, ...packed) {
			return this.invokeWithTimeout(timeout, ...packed);
		},

		setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setClientCallback(callback);
		},

		// The transformer wraps the callback so its successful results arrive as `[payload, blobs?]`.
		_setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setClientCallback(callback as never, true);
		},

		predict(...args) {
			assert(receiver, "This is not a receiver remote.");

			return receiver.invoke(undefined, ...args);
		},
	};

	setmetatable(method, {
		__call: (method, ...args) => {
			return method.invoke(...args);
		},
	});

	return method;
}
