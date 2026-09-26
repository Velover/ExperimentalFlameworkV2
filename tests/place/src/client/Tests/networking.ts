import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectFalse,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { carried, findSpecRemote, onWire, SERIALIZED, SpecEvents, SpecRequest, wire } from "shared/Tests/networkSpec";

type SpecClient = ReturnType<typeof SpecEvents.createClient>;

/**
 * The Lune `networking` suite, client half: every case where something crosses the wire. The
 * server's `networking` section answers each event this sends, and `ask` has it send what a case
 * wants to watch arrive. What the remote carried is read off the remote itself, beside what the
 * handler delivered, which is what the Lune harness recorded.
 */
@Provider({ activeIn: ["testing"] })
export class NetworkingClientTests implements OnStart {
	onStart() {
		// Made on first use rather than here: the client handler waits for the server's remotes,
		// and a section should be defined before its provider yields.
		let client: SpecClient | undefined;
		const handler = () => {
			if (client === undefined) client = SpecEvents.createClient({});
			return client;
		};

		/** Records what the remote delivers, before any decoding, for the rest of the case. */
		const tap = (id: string) => {
			const remote = expectDefined(findSpecRemote(id), `the '${id}' remote`);
			const messages = new Array<unknown[]>();
			const connection = remote.OnClientEvent.Connect((...args: unknown[]) => messages.push(args));
			defer(() => connection.Disconnect());

			return messages;
		};

		/** Records the scores the handler delivers for the rest of the case. */
		const scores = () => {
			const got = new Array<number>();
			const connection = handler().scoreChanged.connect((score) => got.push(score));
			defer(() => connection.Disconnect());

			return got;
		};

		const ask = (request: SpecRequest, value: number) => handler().ask.fire(request, value);

		defineTests("networking", () => {
			test("creates a namespace handler for the running realm", () => {
				const client = handler();
				expectDefined(client.setScore, "client-side server event");
				expectDefined(client.scoreChanged, "client-side client event");
				expectDefined(client.stats.report, "a namespaced event");
				expectEqual(SpecEvents.createClient({}), client, "the handler a second createClient answers with");
			});

			test("sends an outgoing event through a remote", () => {
				const got = scores();
				const raw = tap("scoreChanged");

				// The server answers `setScore` with `scoreChanged` carrying the same score, so the
				// answer proves the send, and its bytes show what the remote carried.
				handler().setScore.fire(7);
				eventually(() => got.includes(7), "the server's answer with the score");

				const last = expectDefined(raw[raw.size() - 1], "the message on the wire");
				if (SERIALIZED) {
					expectTrue(typeIs(last[0], "buffer"), "a serialized payload travels as a buffer");
				}
				expectEqual(carried(wire.number, last)[0], 7, "payload");
			});

			test("broadcasts to every client", () => {
				const got = scores();
				ask("broadcast", 99);
				eventually(() => got.includes(99), "the broadcast");
			});

			test("sends one message per player when given a list", () => {
				const got = scores();
				ask("list", 3);
				eventually(() => got.includes(3), "the message for this player");

				task.wait(0.3);
				expectEqual(got.filter((score) => score === 3).size(), 1, "messages for this player");
			});

			test("sends to everyone but the excluded player", () => {
				const got = scores();

				// This client is the one excluded, and reliable remotes keep their order: the
				// broadcast that follows arriving without the excluded value is the proof.
				ask("except", 4);
				ask("broadcast", 5);
				eventually(() => got.includes(5), "the broadcast that followed");
				expectFalse(got.includes(4), "the excluded player was skipped");
			});

			test("accepts an incoming event whose arguments satisfy the generated guards", () => {
				const got = scores();
				ask("broadcast", 11);
				eventually(() => got.size() > 0, "an accepted message");
				expectArrayEqual(got, [11], "received payload");
			});

			test("drops an incoming event whose arguments fail the generated guards", () => {
				const got = scores();
				const raw = tap("scoreChanged");

				const rejected = new Array<string>();
				const handle = SpecEvents.registerHandler("onBadRequest", (_player, data) =>
					rejected.push(`${data.networkInfo.name}#${data.argIndex}`),
				);
				defer(() => handle.Disconnect());

				// The guard is generated from `scoreChanged(score: number)`: the server puts a
				// string on the wire first, then a number the proper way. Both reach the remote,
				// only one reaches the handler, and the bad one is reported: as a malformed payload
				// when serialized, as a bad argument otherwise.
				ask("malformed", 3);
				eventually(() => got.includes(3), "the good message");

				expectArrayEqual(got, [3], "messages the handler delivered");
				expectEqual(raw.size(), 2, "messages the remote carried");
				expectArrayEqual(
					rejected,
					[SERIALIZED ? "scoreChanged#-1" : "scoreChanged#0"],
					"bad requests reported",
				);

				// And outbound: a number where the server's `rename(name: string)` expects a string,
				// straight onto the wire, is dropped there. The server counts what it accepts.
				const renamed = new Array<[string, number]>();
				const connection = handler().renamed.connect((name, accepted) => renamed.push([name, accepted]));
				defer(() => connection.Disconnect());

				handler().rename.fire("sync");
				eventually(() => renamed.size() === 1, "the first answer");
				const before = renamed[0][1];

				expectDefined(findSpecRemote("rename"), "the rename remote").FireServer(...onWire(wire.number, 12345));
				handler().rename.fire("valid");
				eventually(() => renamed.size() === 2, "the second answer");

				expectEqual(renamed[1][0], "valid", "the name the server accepted");
				expectEqual(renamed[1][1], before + 1, "renames the server accepted: the bad one was dropped");
			});

			test("creates one remote per event name", () => {
				const setScore = expectDefined(findSpecRemote("setScore"), "the setScore remote");
				const rename = expectDefined(findSpecRemote("rename"), "the rename remote");
				expectTrue(setScore !== rename, "distinct remotes");
			});

			test("uses a single unprefixed remote for both directions", () => {
				expectDefined(findSpecRemote("setScore"), "unprefixed remote");
				expectEqual(findSpecRemote("$setScore"), undefined, "prefixed receive channel");
				expectEqual(findSpecRemote("@setScore"), undefined, "prefixed send channel");
			});

			test("gives a nested namespace its own remote", () => {
				const remote = expectDefined(findSpecRemote("stats/report"), "namespaced remote");
				expectEqual(remote.Name, "report", "remote name");

				const received = new Array<number>();
				const connection = handler().stats.report.connect((value) => received.push(value));
				defer(() => connection.Disconnect());

				// Over the wire and back, then delivered locally by `predict`.
				handler().stats.report.fire(12);
				eventually(() => received.includes(12), "the server's echo");

				handler().stats.report.predict(13);
				eventually(() => received.includes(13), "the predicted message");
				expectArrayEqual(received, [12, 13], "events the handler saw");
			});

			test("puts an unreliable event on an UnreliableRemoteEvent", () => {
				const remote = expectDefined(findSpecRemote("unreliable:tick"), "unreliable remote");
				expectEqual(remote.ClassName, "UnreliableRemoteEvent", "remote class");
				expectEqual(findSpecRemote("tick"), undefined, "reliable channel");

				const ticks = new Array<number>();
				const connection = handler().tick.connect((value) => ticks.push(value));
				defer(() => connection.Disconnect());

				ask("tick", 8);
				eventually(() => ticks.includes(8), "the unreliable message");
			});

			test("sends nothing for an event without arguments and accepts it bare", () => {
				const answers = new Array<[number, number]>();
				const connection = handler().bumped.connect((accepted, argumentsOnWire) =>
					answers.push([accepted, argumentsOnWire]),
				);
				defer(() => connection.Disconnect());

				handler().bump.fire();
				eventually(() => answers.size() === 1, "the server's answer");

				expectEqual(answers[0][1], 0, "arguments on the wire");
			});

			test("leaves a raw event's arguments as they are", () => {
				const raw = tap("raw");
				const received = new Array<number>();
				const connection = handler().raw.connect((value) => received.push(value));
				defer(() => connection.Disconnect());

				ask("raw", 42);
				eventually(() => received.includes(42), "the raw message");

				const last = expectDefined(raw[raw.size() - 1], "the message on the wire");
				expectEqual(last[0], 42, "argument on the wire, as it was sent");
			});

			// The call-site packing, as the wire shows it: the server answers every `setScore` with
			// `scoreChanged` carrying the score, in order, so the answers are the record of what was
			// sent, and how many times. A value sent unpacked is dropped by the server's decoder and
			// answers nothing, which is how a call the transform missed shows.

			test("packs a call where it is evaluated, not ahead of its statement", () => {
				// Regression: with serialization on, the packing was hoisted in front of the whole
				// statement, so a call behind `&&` or in an untaken branch still packed (raising on
				// an undefined argument), one in a loop condition packed once for every pass, and
				// one after a sibling with side effects packed before the sibling ran.
				const got = scores();
				const holder: { score?: number } = {};
				const untaken = new Array<number>();
				const log = new Array<string>();
				let i = 0;

				const skipped = holder.score !== undefined && handler().setScore.fire(holder.score);
				const picked = untaken.size() > 0 ? handler().setScore.fire(untaken[0]) : 0;
				expectEqual(skipped, false, "short-circuited call");
				expectEqual(picked, 0, "untaken branch");

				do {
					i++;
				} while (i <= 3 && (handler().setScore.fire(i), true));
				const ordered = [log.push("first"), handler().setScore.fire(log.size())];
				expectEqual(ordered[0], 1, "sibling ran first");

				eventually(() => got.size() >= 4, "the server's answers");
				task.wait(0.3);
				expectArrayEqual(
					got,
					[1, 2, 3, 1],
					"one message per pass, then one after the sibling's push, nothing from an untaken position",
				);
			});

			test("packs a call through `?.` and evaluates the target ahead of the arguments", () => {
				// Regression: a handler reached through `?.` was not packed at all -- its type
				// carries `undefined`, and the marker was looked for on that -- so the call put raw
				// values on the wire that the peer dropped; and the target of a send was evaluated
				// after the arguments it must come ahead of, so `pick()` ran after `picks` was read.
				const got = scores();
				const client = handler();
				let picks = 0;

				const maybe = client as typeof client | undefined;
				const missing = undefined as typeof client | undefined;
				maybe?.setScore.fire(1);
				missing?.setScore.fire(2);
				const pick = () => {
					picks++;
					return client;
				};
				pick().setScore.fire(picks);

				eventually(() => got.size() >= 2, "the server's answers");
				task.wait(0.3);
				expectArrayEqual(
					got,
					[1, 1],
					"one message through `?.`, one through the picked target, with the target evaluated first",
				);
			});

			test("a union spelled in two orders crosses as written on both sides", () => {
				// Regression: `string | number` and `number | string` are one TypeScript type, and
				// each file numbered its members by the first spelling it met, so a sender in one
				// file and a receiver in another tagged them differently and every message on both
				// events was dropped or decoded as something else. This file meets `sortB` first;
				// the server's handlers meet `sortA` first.
				const answers = new Array<string>();
				const connection = handler().sorted.connect((entry) => answers.push(entry));
				defer(() => connection.Disconnect());

				handler().sortB.fire("b");
				handler().sortA.fire(7);
				handler().sortB.fire(3);
				handler().sortA.fire("a");

				eventually(() => answers.size() >= 4, "the server's answers");
				task.wait(0.3);
				expectArrayEqual(answers, ["sortB:b", "sortA:7", "sortB:3", "sortA:a"], "events the server received");
			});
		});
	}
}
