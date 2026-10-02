import { OnStart, Provider } from "@flamework-experimental/core";
import { defineTests, expectDefined, test } from "@flamework-experimental/testing";
import { Players, Workspace } from "@rbxts/services";
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

/** Whether an event came from a player, rather than from `predict` with a stand-in. */
function fromPlayer(player: Player): boolean {
	return typeIs(player, "Instance") && player.IsA("Player");
}

/**
 * The server half of the `packing` sections: it answers what the client's section sends through
 * serialized members, and reports what its `onBadRequest` saw when the client puts hostile payloads
 * on the wire.
 */
@Provider({ activeIn: ["testing"] })
export class PackingTests implements OnStart {
	onStart() {
		const events = PackingEvents.createServer({});
		const functions = PackingFunctions.createServer({});

		events.serializedUp.connect((player, items, where) => {
			if (fromPlayer(player)) events.serializedDown.fire(player, items, where);
		});
		events.serializedUpUnreliable.connect((player, value) => {
			if (fromPlayer(player)) events.serializedDownUnreliable.fire(player, value);
		});
		events.serializedStepUp.connect((player, items) => {
			if (fromPlayer(player)) events.serializedStepDown.fire(player, items);
		});

		// What `serializedBumpUp` carried is read off the remote itself, so the answer waits a step.
		let bumpArguments = -1;
		findPackingRemote("serializedBumpUp")?.OnServerEvent.Connect(
			(_player, ...args: unknown[]) => (bumpArguments = args.size()),
		);
		events.serializedBumpUp.connect((player) => {
			if (fromPlayer(player)) task.defer(() => events.serializedBumped.fire(player, bumpArguments));
		});

		functions.serializedLookup.setCallback((_player, ids, where) => [
			makeItems(ids.size(), `for-${where.Name}`),
			where,
		]);
		functions.serializedNothing.setCallback(() => {});

		// The blob-list cases: each message that can carry an Instance is counted on its remote, the
		// way the engine delivered it, and reported to the client beside what the handler decoded.
		// The report waits a step, so that the count of the message it answers has been taken.
		const heard = (player: Player, entry: () => string) =>
			task.defer(() => events.packingHeard.fire(player, entry()));
		const counted = (remote: RemoteEvent | undefined) => {
			const counts = new Array<number>();
			if (remote !== undefined) countWire(remote.OnServerEvent, true, (count) => counts.push(count));
			return () => counts.shift() ?? -1;
		};

		const maybeUpCount = counted(findPackingRemote("serializedMaybeUp"));
		events.serializedMaybeUp.connect((player, label, where) => {
			if (fromPlayer(player)) heard(player, () => `up:${describeWhere(label, where)}:${maybeUpCount()}`);
		});

		const findCount = counted(findPackingFunctionRemote("$serializedFind"));
		functions.serializedFind.setCallback((player, label, where) => {
			if (fromPlayer(player)) heard(player, () => `find:${describeWhere(label, where)}:${findCount()}`);
			return where;
		});

		// The client's results come back on the client function's own remote.
		const findClientCount = counted(findPackingFunctionRemote("@serializedFindClient"));

		// What the decoders refused, per player, until the client asks for it.
		const rejected = new Map<Player, string[]>();
		PackingEvents.registerHandler("onBadRequest", (player, data) => {
			const entries = rejected.get(player) ?? [];
			entries.push(`${data.networkInfo.name}#${data.argIndex}:${tostring(data.argValue)}`);
			rejected.set(player, entries);
		});

		events.packingAsk.connect((player, request) => {
			if (!fromPlayer(player)) return;

			if (request === "invokeClient") {
				const settle = (promise: Promise<string>) =>
					promise.then(
						(value) => value,
						(reason) => `rejected:${tostring(reason)}`,
					);
				Promise.all([
					settle(functions.serializedAsk.invoke(player, "why").then((items) => describeItems(items))),
					settle(functions.serializedEcho.invoke(player, "how")),
				]).then(([items, text]) => events.askedClient.fire(player, items, text));
			} else if (request === "hostile") {
				// The client put its hostile payloads on the wire just before asking.
				task.delay(1, () => {
					const entries = rejected.get(player) ?? [];
					rejected.delete(player);
					events.packingRejected.fire(player, entries);
				});
			} else if (request === "maybeDown") {
				// Every way the server sends, each without an Instance and then with one. `except` is
				// told to leave out every other player, so that it reaches the asker.
				const others = Players.GetPlayers().filter((other) => other !== player);
				events.serializedMaybeDown.fire(player, "fire");
				events.serializedMaybeDown.fire(player, "fire+", Workspace);
				events.serializedMaybeDown.broadcast("broadcast");
				events.serializedMaybeDown.broadcast("broadcast+", Workspace);
				events.serializedMaybeDown.except(others, "except");
				events.serializedMaybeDown.except(others, "except+", Workspace);
			} else if (request === "maybeInvokeClient") {
				// One after the other, so that the result each report counts is its own.
				const report = (label: string) => (found: Instance | undefined) =>
					heard(player, () => `findClient:${describeWhere(label, found)}:${findClientCount()}`);
				functions.serializedFindClient
					.invoke(player, "bare")
					.then(report("bare"))
					.then(() => functions.serializedFindClient.invoke(player, "placed", Workspace))
					.then(report("placed"))
					.catch((reason) => heard(player, () => `findClient:rejected:${tostring(reason)}`));
			}
		});

		defineTests("packing", () => {
			test("the server's handlers exist for every serialized member", () => {
				expectDefined(events.serializedDown, "a serialized server-to-client event");
				expectDefined(events.serializedUp, "a serialized client-to-server event");
				expectDefined(functions.serializedLookup, "a serialized function the server answers");
				expectDefined(functions.serializedAsk, "a serialized function the server invokes");
			});
		});
	}
}
