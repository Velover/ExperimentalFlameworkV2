import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectResolves,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { Workspace } from "@rbxts/services";
import {
	describeItems,
	describeWhere,
	findPackingFunctionRemote,
	findPackingRemote,
	makeItems,
	PackingEvents,
	PackingFunctions,
} from "shared/Tests/packingSpec";
import { countWire } from "shared/Tests/wireCount";

type PackingClient = ReturnType<typeof PackingEvents.createClient>;
type PackingClientFunctions = ReturnType<typeof PackingFunctions.createClient>;

/**
 * Serialized members across the real wire, client half: everything this sends, the server's
 * `packing` provider answers. What each remote carried is read off the remote itself, so the cases
 * see the packed buffers beside the values the handlers delivered.
 */
@Provider({ activeIn: ["testing"] })
export class PackingClientTests implements OnStart {
	onStart() {
		// Made on first use: the client handlers wait for the server's remotes.
		let events: PackingClient | undefined;
		let functions: PackingClientFunctions | undefined;

		/** What `serializedFindClient` was asked, as `label@where`, for the case that has the server ask. */
		const findClientSaw = new Array<string>();
		const handlers = () => {
			if (events === undefined) events = PackingEvents.createClient({});
			if (functions === undefined) {
				functions = PackingFunctions.createClient({});
				functions.serializedAsk.setCallback((question) => makeItems(3, question));
				functions.serializedEcho.setCallback((text) => `${text}?`);
				functions.serializedFindClient.setCallback((label, where) => {
					findClientSaw.push(describeWhere(label, where));
					return where;
				});
			}
			return { events, functions };
		};

		/** Records what a remote delivers, before any decoding, for the rest of the case. */
		const tap = (id: string) => {
			const remote = expectDefined(findPackingRemote(id), `the '${id}' remote`);
			const messages = new Array<unknown[]>();
			const connection = remote.OnClientEvent.Connect((...args: unknown[]) => messages.push(args));
			defer(() => connection.Disconnect());
			return messages;
		};

		/**
		 * How many arguments each message a remote delivers carried, as `select("#", ...)` counts them,
		 * for the rest of the case. The remote is found by `id` among the events', else the functions'.
		 */
		const countOn = (id: string) => {
			const remote = expectDefined(findPackingRemote(id) ?? findPackingFunctionRemote(id), `the '${id}' remote`);
			const counts = new Array<number>();
			const connection = countWire(remote.OnClientEvent, false, (count) => counts.push(count));
			defer(() => connection.Disconnect());
			return counts;
		};

		/** What the server reports of the messages this sends (`packingHeard`) whose entry starts with `kind:`. */
		const heard = (kind: string) => {
			const entries = new Array<string>();
			const prefix = `${kind}:`;
			const connection = handlers().events.packingHeard.connect((entry) => {
				if (entry.sub(1, prefix.size()) === prefix) entries.push(entry);
			});
			defer(() => connection.Disconnect());
			return entries;
		};

		defineTests("packing", () => {
			test("a serialized event crosses both ways packed, with an Instance next to the buffer", () => {
				const { events } = handlers();
				const got = new Array<string>();
				const connection = events.serializedDown.connect((items, where) =>
					got.push(describeItems(items, where)),
				);
				defer(() => connection.Disconnect());
				const raw = tap("serializedDown");

				events.serializedUp.fire(makeItems(500, "serialized"), Workspace);
				eventually(() => got.size() > 0, "the server's answer");

				expectEqual(got[0], "serialized:500:500:1000@Workspace", "the items and the Instance, back");
				const last = expectDefined(raw[raw.size() - 1], "the message on the wire");
				expectTrue(typeIs(last[0], "buffer"), "a buffer on the wire");
				expectEqual((last[1] as defined[])[0], Workspace, "the Instance in the blob list");
			});

			test("serialized unreliable events cross both ways, in both spellings", () => {
				const { events } = handlers();
				const values = new Array<number>();
				const lists = new Array<string>();
				const connections = [
					events.serializedDownUnreliable.connect((value) => values.push(value)),
					events.serializedStepDown.connect((items) => lists.push(describeItems(items))),
				];
				defer(() => connections.forEach((connection) => connection.Disconnect()));
				const raw = tap("unreliable:serializedStepDown");

				// Unreliable messages may be dropped: a few are sent, and one of each must arrive.
				for (const index of $range(1, 3)) {
					events.serializedUpUnreliable.fire(index);
					events.serializedStepUp.fire(makeItems(20, "moved"));
					task.wait(0.05);
				}
				eventually(() => values.size() > 0 && lists.size() > 0, "the server's unreliable answers");

				expectTrue(values.includes(1) || values.includes(2) || values.includes(3), "a serialized value back");
				expectEqual(lists[0], "moved:20:20:40", "a serialized list back");
				expectTrue(
					typeIs(expectDefined(raw[0], "the message on the wire")[0], "buffer"),
					"a buffer on the wire",
				);
			});

			test("a serialized event without arguments sends nothing", () => {
				const { events } = handlers();
				const got = new Array<number>();
				const connection = events.serializedBumped.connect((count) => got.push(count));
				defer(() => connection.Disconnect());

				events.serializedBumpUp.fire();
				eventually(() => got.size() > 0, "the server's answer");
				expectEqual(got[0], 0, "arguments on the wire");
			});

			test("serialized functions answer with what the server's callbacks returned", () => {
				const { functions } = handlers();
				const [items, where] = expectResolves(
					functions.serializedLookup.invoke([1, 2, 3, 4], Workspace),
					"a serialized request",
				);
				expectEqual(describeItems(items, where), "for-Workspace:4:4:8@Workspace", "the serialized result");
				expectEqual(
					expectResolves(functions.serializedNothing.invoke(), "an empty request"),
					undefined,
					"void",
				);
			});

			test("the server invokes the client's serialized functions", () => {
				const { events } = handlers();
				const got = new Array<[string, string]>();
				const connection = events.askedClient.connect((items, text) => got.push([items, text]));
				defer(() => connection.Disconnect());

				events.packingAsk.fire("invokeClient");
				eventually(() => got.size() > 0, "the server's report");
				expectEqual(got[0][0], "why:3:3:6", "the list the server decoded");
				expectEqual(got[0][1], "how?", "the string the server decoded");
			});

			test("the server drops a client's malformed serialized payloads", () => {
				const { events } = handlers();
				const got = new Array<string[]>();
				const connection = events.packingRejected.connect((entries) => got.push(entries));
				defer(() => connection.Disconnect());
				const answers = new Array<string>();
				const echo = events.serializedDown.connect((items) => answers.push(describeItems(items)));
				defer(() => echo.Disconnect());

				const remote = expectDefined(findPackingRemote("serializedUp"), "the serializedUp remote");

				// Plain values where a buffer is expected, a count far past what the buffer holds,
				// and a buffer with bytes left over.
				remote.FireServer(makeItems(2, "plain"), [Workspace]);
				const huge = buffer.create(5);
				[0xff, 0xff, 0xff, 0xff, 0x0f].forEach((value, index) => buffer.writeu8(huge, index, value));
				remote.FireServer(huge, [Workspace]);
				const trailing = buffer.create(3);
				remote.FireServer(trailing, [Workspace]);

				events.packingAsk.fire("hostile");
				eventually(() => got.size() > 0, "the server's report");

				const entries = got[0].filter((entry) => entry.sub(1, 13) === "serializedUp#");
				expectEqual(entries.size(), 3, `payloads refused: ${got[0].join(" | ")}`);
				for (const entry of entries) {
					expectTrue(entry.sub(1, 16) === "serializedUp#-1:", `reported as malformed: ${entry}`);
				}
				expectEqual(answers.size(), 0, "nothing reached the handler");
			});

			// A packed message carries its blob list only when the list holds something: without an
			// Instance the remote is handed the buffer alone, one argument fewer than with one, and
			// never an empty table. Counted on each remote as the engine delivered it.

			test("a serialized event carries a blob list to the server only with an Instance in it", () => {
				const { events } = handlers();
				const entries = heard("up");

				events.serializedMaybeUp.fire("bare");
				events.serializedMaybeUp.fire("placed", Workspace);
				eventually(() => entries.size() >= 2, "the server's report");

				expectArrayEqual(
					entries,
					["up:bare@none:1", "up:placed@Workspace:2"],
					"what the server decoded, and the arguments its remote delivered",
				);
			});

			test("a serialized event fired, broadcast or sent to all but some carries a blob list only with an Instance in it", () => {
				const { events } = handlers();
				const got = new Array<string>();
				const connection = events.serializedMaybeDown.connect((label, where) =>
					got.push(describeWhere(label, where)),
				);
				defer(() => connection.Disconnect());
				const counts = countOn("serializedMaybeDown");

				events.packingAsk.fire("maybeDown");
				eventually(() => got.size() >= 6 && counts.size() >= 6, "the six messages");

				expectArrayEqual(
					got,
					[
						"fire@none",
						"fire+@Workspace",
						"broadcast@none",
						"broadcast+@Workspace",
						"except@none",
						"except+@Workspace",
					],
					"what the handler decoded",
				);
				expectArrayEqual(counts, [1, 2, 1, 2, 1, 2], "arguments on the wire, message by message");
			});

			test("a serialized request to the server, and its result, carry a blob list only with an Instance in it", () => {
				const { functions } = handlers();
				const entries = heard("find");
				const results = countOn("$serializedFind");

				expectEqual(
					expectResolves(functions.serializedFind.invoke("bare"), "a request without an Instance"),
					undefined,
					"the result without one",
				);
				expectEqual(
					expectResolves(functions.serializedFind.invoke("placed", Workspace), "a request with one"),
					Workspace,
					"the result with one",
				);
				eventually(() => entries.size() >= 2, "the server's report");

				// A request is `(id, payload, blobs?)`, a result `(id, true, payload, blobs?)`.
				expectArrayEqual(
					entries,
					["find:bare@none:2", "find:placed@Workspace:3"],
					"the requests: what the server decoded, and the arguments its remote delivered",
				);
				expectArrayEqual(results, [3, 4], "the results: arguments on the wire");
			});

			test("a serialized request from the server, and the client's result, carry a blob list only with an Instance in it", () => {
				const { events } = handlers();
				const entries = heard("findClient");
				const requests = countOn("@serializedFindClient");
				findClientSaw.clear();

				events.packingAsk.fire("maybeInvokeClient");
				eventually(() => entries.size() >= 2, "the server's report");

				expectArrayEqual(
					findClientSaw,
					["bare@none", "placed@Workspace"],
					"what the client's callback decoded",
				);
				expectArrayEqual(requests, [2, 3], "the requests: arguments on the wire");
				expectArrayEqual(
					entries,
					["findClient:bare@none:3", "findClient:placed@Workspace:4"],
					"the results: what the server decoded, and the arguments its remote delivered",
				);
			});
		});
	}
}
