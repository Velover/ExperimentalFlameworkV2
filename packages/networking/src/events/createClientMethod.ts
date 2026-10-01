import { ClientReceiver, ClientSender } from "./types";
import { EventInterface } from "../event/createEvent";
import { trimArguments } from "../util/trimArguments";

type ClientMethod = ClientSender<never[]> & ClientReceiver<never[]>;

export function createClientMethod(receiver: EventInterface, sender: EventInterface) {
	// A method that takes an argument list trims it before spreading it, or an explicit trailing
	// `undefined` would lose the arguments after a gap (see `trimArguments`).
	const method: { [k in keyof ClientMethod]: ClientMethod[k] } = {
		fire(...args) {
			sender.fireServer(...trimArguments(args));
		},

		// With serialization on, the transformer rewrites every `fire` into this with the packed list:
		// `(payload, blobs?)`, or nothing at all for a list that carries nothing. A blob list that came
		// out empty is left off, not sent as nil: a table costs bytes on the wire, a nil one, a missing
		// argument none, and the receiver reads a missing list as an empty one.
		_fire(payload, blobs) {
			if (payload === undefined) {
				sender.fireServer();
			} else if (blobs === undefined || next(blobs)[0] === undefined) {
				sender.fireServer(payload);
			} else {
				sender.fireServer(payload, blobs);
			}
		},

		connect(callback) {
			return receiver.connectClient(callback as never);
		},

		predict(...args) {
			receiver.predict(undefined, ...trimArguments(args));
		},
	};

	setmetatable(method, {
		__call: (method, ...args) => {
			method.fire(...(trimArguments(args) as never[]));
		},
	});

	return method as ClientMethod;
}
