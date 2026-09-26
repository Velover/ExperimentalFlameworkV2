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
		// list: `(payload, blobs?)`, or nothing at all for a list that carries nothing.
		_fire(players, ...packed) {
			this.fire(players, ...packed);
		},

		_broadcast(...packed) {
			this.broadcast(...packed);
		},

		_except(players, ...packed) {
			this.except(players, ...packed);
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
