import { FunctionReceiverInterface } from "../function/createFunctionReceiver";
import { FunctionSenderInterface } from "../function/createFunctionSender";
import { trimArguments } from "../util/trimArguments";
import { FunctionCreateConfiguration, ServerReceiver, ServerSender } from "./types";

type ServerMethod = ServerSender<unknown[], unknown> & ServerReceiver<unknown[], unknown>;

export function createServerMethod(
	config: FunctionCreateConfiguration<unknown>,
	receiver?: FunctionReceiverInterface,
	sender?: FunctionSenderInterface,
) {
	// A method that takes an argument list trims it before spreading it, or an explicit trailing
	// `undefined` would lose the arguments after a gap (see `trimArguments`).
	const method: { [k in keyof ServerMethod]: ServerMethod[k] } = {
		invoke(player: Player, ...args: unknown[]) {
			return this.invokeWithTimeout(player, config.defaultTimeout, ...trimArguments(args));
		},

		invokeWithTimeout(player: Player, timeout: number, ...args: unknown[]) {
			assert(sender, "This is not a sender remote.");

			return sender.invokeClient(player, timeout, ...trimArguments(args));
		},

		// With serialization on, the transformer rewrites the methods above into these with the packed
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing. A blob list
		// that came out empty is left off, not sent as nil: a table costs bytes on the wire, a nil
		// one, a missing argument none, and the receiver reads a missing list as an empty one.
		_invoke(player, payload, blobs) {
			return this._invokeWithTimeout(player, config.defaultTimeout, payload, blobs);
		},

		_invokeWithTimeout(player, timeout, payload, blobs) {
			if (blobs === undefined || next(blobs)[0] === undefined) {
				return this.invokeWithTimeout(player, timeout, payload);
			}

			return this.invokeWithTimeout(player, timeout, payload, blobs);
		},

		setCallback(callback) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setServerCallback(callback);
		},

		// The transformer passes `pack`, which turns a successful result into `[payload, blobs?]`.
		_setCallback(callback, pack) {
			assert(receiver, "This is not a receiver remote.");

			receiver.setServerCallback(callback as never, pack);
		},

		predict(player, ...args) {
			assert(receiver, "This is not a receiver remote.");

			return receiver.invoke(player, ...trimArguments(args));
		},
	};

	setmetatable(method, {
		__call: (method, player, ...args) => {
			return method.invoke(player as Player, ...trimArguments(args));
		},
	});

	return method;
}
