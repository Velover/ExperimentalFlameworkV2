import { Players } from "@rbxts/services";
import { ServerReceiver, ServerSender } from "./types";
import { EventInterface } from "../event/createEvent";
import { trimArguments } from "../util/trimArguments";

type ServerMethod = ServerSender<unknown[]> & ServerReceiver<unknown[]>;

export function createServerMethod(receiver: EventInterface, sender: EventInterface) {
	// A method that takes an argument list trims it before spreading it, or an explicit trailing
	// `undefined` would lose the arguments after a gap (see `trimArguments`).
	const method: { [k in keyof ServerMethod]: ServerMethod[k] } = {
		fire(players, ...args) {
			args = trimArguments(args);

			if (typeIs(players, "Instance")) {
				sender.fireClient(players, ...args);
			} else {
				for (const player of players) {
					sender.fireClient(player, ...args);
				}
			}
		},

		broadcast(...args) {
			sender.fireAllClients(...trimArguments(args));
		},

		except(players, ...args) {
			args = trimArguments(args);

			if (typeIs(players, "Instance")) players = [players];

			for (const player of Players.GetPlayers()) {
				if (!players.includes(player)) {
					this.fire(player, ...args);
				}
			}
		},

		// With serialization on, the transformer rewrites the methods above into these with the packed
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing. A blob list
		// that came out empty is left off, not sent as nil: a table costs bytes on the wire, a nil
		// one, a missing argument none, and the receiver reads a missing list as an empty one.
		_fire(players, payload, blobs) {
			if (blobs === undefined || next(blobs)[0] === undefined) {
				this.fire(players, payload);
			} else {
				this.fire(players, payload, blobs);
			}
		},

		_broadcast(payload, blobs) {
			if (blobs === undefined || next(blobs)[0] === undefined) {
				this.broadcast(payload);
			} else {
				this.broadcast(payload, blobs);
			}
		},

		_except(players, payload, blobs) {
			if (blobs === undefined || next(blobs)[0] === undefined) {
				this.except(players, payload);
			} else {
				this.except(players, payload, blobs);
			}
		},

		connect(callback) {
			return receiver.connectServer(callback);
		},

		predict(player, ...args) {
			receiver.predict(player, ...trimArguments(args));
		},
	};

	setmetatable(method, {
		__call: (method, player, ...args) => {
			method.fire(player as Player, ...trimArguments(args));
		},
	});

	return method;
}
