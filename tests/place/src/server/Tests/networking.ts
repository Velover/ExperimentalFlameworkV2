import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectNoThrow,
	expectTrue,
	scratch,
	test,
} from "@flamework-experimental/testing";
import { Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Events, Functions } from "server/Core/network";
import { findSpecRemote, onWire, SpecEvents, wire } from "shared/Tests/networkSpec";
import { describeWhere } from "shared/Tests/packingSpec";
import { countWire } from "shared/Tests/wireCount";

/**
 * Flamework's own published remotes: every one it creates carries the hashed `id` attribute it
 * looks them up by, which is what tells them apart from any other remote in the place.
 */
function publishedRemotes(): Array<Instance> {
	const found = new Array<Instance>();
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		const isRemote =
			descendant.IsA("RemoteEvent") ||
			descendant.IsA("UnreliableRemoteEvent") ||
			descendant.IsA("RemoteFunction");

		if (isRemote && descendant.GetAttribute("id") !== undefined) {
			found.push(descendant);
		}
	}
	return found;
}

/**
 * Who `predict` is told sent the event: a stand-in, never a real player. `predict` hands it through
 * untouched and none of the cases' handlers look; the answering handlers below do, and skip it. An
 * answer to a real player here would be queued by the engine until that client first connects the
 * remote, and then land in the middle of the client's own cases as an answer nobody asked for.
 */
function somePlayer(): Player {
	return scratch() as unknown as Player;
}

/** Whether an event came from a player, rather than from `predict` with a stand-in. */
function fromPlayer(player: Player): boolean {
	return typeIs(player, "Instance") && player.IsA("Player");
}

/**
 * Networking as the engine sees it. The Lune suite drives both realms through a bridge; here the
 * server's own half is checked against real RemoteEvent instances, and every case that needs the
 * other realm is in the client's `networking` section, which this provider answers.
 *
 * Note the environment: `createRemoteInstance` only parents remotes into ReplicatedStorage when
 * `RunService.IsRunning()`, which an Open Cloud task is not, so the tree assertions only apply to a
 * real server or Studio; elsewhere they say so and check what the handlers can show alone.
 */
@Provider({ activeIn: ["testing"] })
export class NetworkingTests implements OnStart {
	onStart() {
		// The answering side of the client's cases: everything a client sends comes back to it, and
		// `ask` has the server send what the client wants to watch arrive.
		const server = SpecEvents.createServer({});

		let renames = 0;
		let bumps = 0;
		let bumpArguments = -1;

		server.setScore.connect((player, score) => {
			if (fromPlayer(player)) server.scoreChanged.fire(player, score);
		});
		server.rename.connect((player, name) => {
			if (!fromPlayer(player)) return;
			renames += 1;
			server.renamed.fire(player, name, renames);
		});
		server.stats.report.connect((player, value) => {
			if (fromPlayer(player)) server.stats.report.fire(player, value);
		});

		// The receiving half of the union-order case: `sortA` is met first here, as declared, and
		// the answer says which event heard what, the way the value decoded.
		server.sortA.connect((player, value) => {
			if (fromPlayer(player)) server.sorted.fire(player, `sortA:${value}`);
		});
		server.sortB.connect((player, value) => {
			if (fromPlayer(player)) server.sorted.fire(player, `sortB:${value}`);
		});

		// What `bump` carried is read off the remote itself, so the answer waits a step for both
		// connections to have seen the message.
		findSpecRemote("bump")?.OnServerEvent.Connect((_player, ...args: unknown[]) => (bumpArguments = args.size()));
		server.bump.connect((player) => {
			if (!fromPlayer(player)) return;
			bumps += 1;
			task.defer(() => server.bumped.fire(player, bumps, bumpArguments));
		});

		// What each `maybe` carried, counted on the remote as the engine delivered it, with the type
		// of its first argument: a buffer when the project serializes, the label when it does not.
		const maybeWire = new Array<string>();
		const maybeRemote = findSpecRemote("maybe");
		if (maybeRemote !== undefined) {
			countWire(maybeRemote.OnServerEvent, true, (count, first) => maybeWire.push(`${count}:${typeOf(first)}`));
		}
		server.maybe.connect((player, label, where) => {
			if (!fromPlayer(player)) return;
			task.defer(() =>
				server.maybeHeard.fire(player, `${describeWhere(label, where)}:${maybeWire.shift() ?? "none"}`),
			);
		});

		// The reliable half of a pair the client sends together: the unreliable half is only listened
		// to from here, through the handler and straight on the remote, and what each saw is reported.
		const bursting = new Set<Player>();
		server.burstUp.connect((player) => {
			if (!fromPlayer(player) || bursting.has(player)) return;
			bursting.add(player);

			const delivered = new Array<number>();
			let onRemote = 0;
			const remote = findSpecRemote("unreliable:burstUpUnreliable");
			const connections: Array<{ Disconnect(): void }> = [
				server.burstUpUnreliable.connect((sender, value) => {
					if (sender === player) delivered.push(value);
				}),
			];
			if (remote) {
				connections.push(
					remote.OnServerEvent.Connect((sender) => {
						if (sender === player) onRemote += 1;
					}),
				);
			}
			task.delay(1, () => {
				for (const connection of connections) connection.Disconnect();
				bursting.delete(player);
				server.burstHeard.fire(player, delivered, onRemote);
			});
		});

		server.ask.connect((player, request, value) => {
			if (!fromPlayer(player)) return;
			if (request === "broadcast") {
				server.scoreChanged.broadcast(value);
			} else if (request === "list") {
				server.scoreChanged.fire(Players.GetPlayers(), value);
			} else if (request === "except") {
				server.scoreChanged.except(player, value);
			} else if (request === "tick") {
				server.tick.fire(player, value);
			} else if (request === "raw") {
				server.raw.fire(player, value);
			} else if (request === "malformed") {
				// Straight onto the wire, past the sender: a string where the client expects a
				// number, then the value itself the proper way.
				findSpecRemote("scoreChanged")?.FireClient(player, ...onWire(wire.text, "not a number"));
				server.scoreChanged.fire(player, value);
			} else if (request === "maybe") {
				server.maybeDown.fire(player, "bare");
				server.maybeDown.fire(player, "placed", Workspace);
			} else if (request === "burst") {
				server.burst.fire(player, value);
				server.burstUnreliable.fire(player, value);
			} else if (request === "late") {
				// Nothing on the client listens to these yet: the case connects once they are sent.
				server.late.fire(player, value);
				server.lateUnreliable.fire(player, value);
			} else if (request === "listenLate") {
				// The client sent `lateUp` and `lateUpUnreliable` before anything here listened to them.
				const reliable = new Array<number>();
				const unreliable = new Array<number>();
				const connections = [
					server.lateUp.connect((sender, got) => {
						if (sender === player) reliable.push(got);
					}),
					server.lateUpUnreliable.connect((sender, got) => {
						if (sender === player) unreliable.push(got);
					}),
				];
				task.delay(1, () => {
					for (const connection of connections) connection.Disconnect();
					server.lateHeard.fire(player, reliable, unreliable);
				});
			}
		});

		defineTests("networking", () => {
			test("the server's namespace handler exists for every declared event and function", () => {
				expectDefined(Events.FwTest, "the FwTest event namespace");
				expectDefined(Events.FwTest.Pong, "a server-to-client event");
				expectDefined(Functions.FwTest, "the FwTest function namespace");
				expectDefined(Functions.FwTest.Echo, "a client-to-server function");
			});

			test("broadcasting with nobody connected is a no-op rather than an error", () => {
				expectNoThrow(() => Events.FwTest.Pong.broadcast(1), "broadcast to an empty server");
				expectNoThrow(() => Events.FwTest.RawPong.broadcast(2), "a raw event broadcast");
			});

			test("connecting and disconnecting a server handler leaves nothing behind", () => {
				let seen = 0;
				const connection = Events.FwTest.Ping.connect(() => (seen += 1));
				expectDefined(connection, "the connection");
				expectNoThrow(() => connection.Disconnect(), "disconnecting");
				expectEqual(seen, 0, "nothing arrived with no client to send it");
			});

			test("the remote tree is published in a running game and kept unparented where nothing runs", () => {
				const found = publishedRemotes();

				if (RunService.IsRunning()) {
					expectTrue(found.size() > 0, `remotes are in ReplicatedStorage, found ${found.size()}`);

					// Each sits in a namespace folder carrying its own id, and every remote in it is
					// named for the event it serves.
					for (const remote of found) {
						expectDefined(remote.Parent, `${remote.Name} has a namespace folder`);
						expectDefined(
							remote.Parent!.GetAttribute("id"),
							`the namespace folder's id for ${remote.Name}`,
						);
					}
				} else {
					// A Luau execution task loads the place but never runs it, and
					// `createRemoteInstance` returns an unparented instance when `IsRunning()` is
					// false: the handlers still work locally, nothing is published to replicate.
					expectEqual(
						found.size(),
						0,
						`no Flamework remote is published outside a running game, found ${found
							.map((remote) => remote.GetFullName())
							.join(", ")}`,
					);
				}
			});

			// The Lune `networking` suite, server half. Each case that sends to or receives from a
			// client is completed in the client's section of the same name.

			test("creates a namespace handler for the running realm", () => {
				expectDefined(server.scoreChanged, "server-side client event");
				expectDefined(server.setScore, "server-side server event");
				expectDefined(server.stats.report, "a namespaced event");
				expectEqual(SpecEvents.createServer({}), server, "the handler a second createServer answers with");
			});

			test("sends to one player, a list, everyone, or everyone but some, whoever is connected", () => {
				const players = Players.GetPlayers();
				expectNoThrow(() => server.scoreChanged.fire(players, 3), "a list of players");
				expectNoThrow(() => server.scoreChanged.fire([], 3), "an empty list");
				expectNoThrow(() => server.scoreChanged.broadcast(99), "everyone");
				expectNoThrow(() => server.scoreChanged.except(players, 4), "everyone but everyone");
				expectNoThrow(() => server.raw.broadcast(42), "a raw event to everyone");
			});

			test("accepts an incoming event whose arguments satisfy the generated guards", () => {
				const received = new Array<number>();
				const connection = server.setScore.connect((_player, score) => received.push(score));
				defer(() => connection.Disconnect());

				// `predict` delivers through the same middleware a remote's message goes through,
				// guards included, which is the half of receiving a server can do without a wire.
				// The handler runs on the event's signal, which a place that defers its signals
				// delivers once this thread yields, so the delivery is waited for.
				server.setScore.predict(somePlayer(), 5);
				eventually(() => received.size() > 0, "the predicted message");

				expectArrayEqual(received, [5], "accepted messages");
			});

			test("drops an incoming event whose arguments fail the generated guards", () => {
				const received = new Array<string>();
				const connection = server.rename.connect((_player, name) => received.push(name));
				defer(() => connection.Disconnect());

				const rejected = new Array<string>();
				const handler = SpecEvents.registerHandler("onBadRequest", (_player, data) =>
					rejected.push(`${data.networkInfo.name}#${data.argIndex}`),
				);
				defer(() => handler.Disconnect());

				// The guard is generated from `rename(name: string)`, so a number must be dropped
				// before it ever reaches the handler, and reported.
				server.rename.predict(somePlayer(), 12345 as never);
				eventually(() => rejected.size() > 0, "the bad request to be reported");
				expectEqual(received.size(), 0, "messages accepted after a bad argument");
				expectArrayEqual(rejected, ["rename#0"], "bad requests reported");

				server.rename.predict(somePlayer(), "valid");
				eventually(() => received.size() > 0, "the good message");
				expectArrayEqual(received, ["valid"], "messages accepted after a good argument");
			});

			test("creates one remote per event name", () => {
				if (!RunService.IsRunning()) {
					// Nothing is published where the place does not run; the handlers are still
					// one per event.
					expectTrue(server.setScore !== (server.rename as unknown), "distinct handlers");
					return;
				}

				const setScore = expectDefined(findSpecRemote("setScore"), "the setScore remote");
				const rename = expectDefined(findSpecRemote("rename"), "the rename remote");
				expectTrue(setScore !== rename, "distinct remotes");
				expectEqual(setScore.Name, "setScore", "a remote is named for its event");
			});

			test("uses a single unprefixed remote for both directions", () => {
				if (!RunService.IsRunning()) {
					expectDefined(server.setScore, "the handler, where nothing is published");
					return;
				}

				// Unlike a function, an event uses a single remote for both directions, so its id
				// is the bare event name rather than a direction-prefixed one.
				expectDefined(findSpecRemote("setScore"), "unprefixed remote");
				expectEqual(findSpecRemote("$setScore"), undefined, "prefixed receive channel");
				expectEqual(findSpecRemote("@setScore"), undefined, "prefixed send channel");
			});

			test("gives a nested namespace its own remote", () => {
				if (RunService.IsRunning()) {
					const remote = expectDefined(findSpecRemote("stats/report"), "namespaced remote");
					expectEqual(remote.Name, "report", "remote name");
				}

				const received = new Array<number>();
				const connection = server.stats.report.connect((_player, value) => received.push(value));
				defer(() => connection.Disconnect());

				server.stats.report.predict(somePlayer(), 12);
				eventually(() => received.size() > 0, "the predicted message");
				expectArrayEqual(received, [12], "events the handler saw");
			});

			test("puts an unreliable event on an UnreliableRemoteEvent", () => {
				expectDefined(server.tick, "the unreliable event's handler");
				if (!RunService.IsRunning()) return;

				const remote = expectDefined(findSpecRemote("unreliable:tick"), "unreliable remote");
				expectEqual(remote.ClassName, "UnreliableRemoteEvent", "remote class");
				expectEqual(findSpecRemote("tick"), undefined, "reliable channel");
			});

			test("sends nothing for an event without arguments and accepts it bare", () => {
				let received = 0;
				const connection = server.bump.connect(() => (received += 1));
				defer(() => connection.Disconnect());

				// What the wire carries for it is the client's to see, in its section.
				server.bump.predict(somePlayer());
				eventually(() => received > 0, "the predicted message");
				expectEqual(received, 1, "accepted messages");
			});

			// The call-site packing, server half. Nothing on a server sees what `FireClient` sent,
			// so the sends go to an empty list -- the transform is the same -- and what a server can
			// show is that each call ran where it was written; what the wire carried is the
			// client's section's, through the server's answers.

			test("packs a call where it is evaluated, not ahead of its statement", () => {
				// Regression: with serialization on, the packing was hoisted in front of the whole
				// statement, so a call behind `&&` or in an untaken branch still packed (raising on
				// an undefined argument), one in a loop condition packed once for every pass, and
				// one after a sibling with side effects packed before the sibling ran.
				const holder: { score?: number } = {};
				const scores = new Array<number>();
				const log = new Array<string>();
				const nobody = new Array<Player>();
				let i = 0;
				let passes = 0;

				const skipped = holder.score !== undefined && server.scoreChanged.fire(nobody, holder.score);
				const picked = scores.size() > 0 ? server.scoreChanged.fire(nobody, scores[0]) : 0;
				expectEqual(skipped, false, "short-circuited call");
				expectEqual(picked, 0, "untaken branch");

				do {
					i++;
				} while (i <= 3 && (server.scoreChanged.fire(nobody, i), passes++, true));
				expectEqual(passes, 3, "one send per pass");

				const ordered = [log.push("first"), server.scoreChanged.fire(nobody, log.size())];
				expectEqual(ordered[0], 1, "sibling ran first");
			});

			test("packs a call through `?.` and evaluates the target ahead of the arguments", () => {
				// Regression: a handler reached through `?.` was not packed at all -- its type
				// carries `undefined`, and the marker was looked for on that -- so the call put raw
				// values on the wire that the peer dropped; and the target of a send was evaluated
				// after the arguments it must come ahead of, so `pick()` ran after `picks` was read.
				const nobody = new Array<Player>();
				let picks = 0;

				const maybe = server as typeof server | undefined;
				const missing = undefined as typeof server | undefined;
				expectNoThrow(() => {
					maybe?.scoreChanged.fire(nobody, 1);
					missing?.scoreChanged.fire(nobody, 2);
				}, "sends through `?.`");

				const pick = () => {
					picks++;
					return server;
				};
				pick().scoreChanged.fire(nobody, picks);
				expectEqual(picks, 1, "the target was evaluated once");
			});
		});
	}
}
