import { FunctionReceiverInterface } from "../function/createFunctionReceiver";
import { FunctionSenderInterface } from "../function/createFunctionSender";
import { trimArguments } from "../util/trimArguments";
import { ClientReceiver, ClientSender, FunctionCreateConfiguration } from "./types";

type ClientMethod = ClientSender<unknown[], unknown> & ClientReceiver<unknown[], unknown>;

export function createClientMethod(
	config: FunctionCreateConfiguration<unknown>,
	receiver?: FunctionReceiverInterface,
	sender?: FunctionSenderInterface,
) {
	// A method that takes an argument list trims it before spreading it, or an explicit trailing
	// `undefined` would lose the arguments after a gap (see `trimArguments`).
	const method: { [k in keyof ClientMethod]: ClientMethod[k] } = {
		invoke(...args: unknown[]) {
			return this.invokeWithTimeout(config.defaultTimeout, ...trimArguments(args));
		},

		invokeWithTimeout(timeout: number, ...args: unknown[]) {
			assert(sender, "This is not a sender remote.");

			return sender.invokeServer(timeout, ...trimArguments(args));
		},

		// With serialization on, the transformer rewrites the methods above into these with the packed
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing. A blob list
		// that came out empty is left off, not sent as nil: a table costs bytes on the wire, a nil
		// one, a missing argument none, and the receiver reads a missing list as an empty one.
		_invoke(payload, blobs) {
			return this._invokeWithTimeout(config.defaultTimeout, payload, blobs);
		},

		_invokeWithTimeout(timeout, payload, blobs) {
			if (blobs === undefined || next(blobs)[0] === undefined) {
				return this.invokeWithTimeout(timeout, payload);
			}

			return this.invokeWithTimeout(timeout, payload, blobs);
		},

		setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setClientCallback(callback);
		},

		// The transformer passes `pack`, which turns a successful result into `[payload, blobs?]`.
		_setCallback(callback, pack) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setClientCallback(callback as never, pack);
		},

		predict(...args) {
			assert(receiver, "This is not a receiver remote.");

			return receiver.invoke(undefined, ...trimArguments(args));
		},
	};

	setmetatable(method, {
		__call: (method, ...args) => {
			return method.invoke(...trimArguments(args));
		},
	});

	return method;
}
