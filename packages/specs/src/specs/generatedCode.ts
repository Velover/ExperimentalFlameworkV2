import { Flamework, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import { Action, GridCoord, Holder, Placement, Reserved, describeReserved, reservedOf } from "../generatedCode/shared";
import * as codecs from "../widthChecks/codecs";
import { expectDefined, expectEqual, expectTrue, suite } from "../testkit";

/*
 * The code generated where a value is packed, for values it does not make itself: a caller's readonly
 * tuple, fields named after words no local can take, arrays with a hole, argument lists of any length.
 * The round trips between two realms are in `replicationShapes.ts`; these cover what one realm can
 * see, and the checks' variants (packages/specs/variants) for what holds whatever
 * `serialization.checks` says. The events are `Serialized` members, packed whatever
 * networking.serialization says.
 */

declare const __harness: {
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
	warnings: () => string[];
	clearWarnings: () => void;
	checkVariant: (name: "warn" | "none" | "server" | "client") => typeof codecs;
};

/**
 * Declared in both directions, so one spec body covers both realms. An array argument is reached by the
 * decoder in this file as well as by the call site, so it has code of its own (`codec.w_...`), and a
 * hole's message starts from the type's name rather than the event's, as a width check's does. A tuple
 * written out where it is declared, and an argument list's own rest element (`...values`), are written
 * in place, so theirs name the event.
 */
interface GeneratedEvents {
	gcPlace: Networking.SerializedReliable<(origin: GridCoord) => void>;
	gcHoles: Networking.SerializedReliable<(values: defined[]) => void>;
	gcNames: Networking.SerializedReliable<(names: string[]) => void>;
	gcTagged: Networking.SerializedReliable<(entry: [string, ...number[]]) => void>;
	gcMany: Networking.SerializedReliable<(...values: number[]) => void>;
}

const GeneratedNetwork = Networking.createEvent<GeneratedEvents, GeneratedEvents>();
type ServerEvents = ReturnType<typeof GeneratedNetwork.createServer>;
type ClientEvents = ReturnType<typeof GeneratedNetwork.createClient>;

const isServer = RunService.IsServer();
const target = __harness.newPlayer("Generated") as Player;

let events: { server?: ServerEvents; client?: ClientEvents } | undefined;

/** The realm's handlers. Remotes are the server's to create, so a client spec primes them first. */
function handlers() {
	if (events !== undefined) return events;

	if (isServer) {
		events = { server: GeneratedNetwork.createServer({}) };
	} else {
		__harness.asRealm("Server", () => {
			GeneratedNetwork.createServer({});
			__harness.flush();
		});
		events = { client: GeneratedNetwork.createClient({}) };
	}

	__harness.flush();
	return events;
}

// The sends, from whichever realm this is: `fire(player, ...)` from the server, `fire(...)` from a client.

function sendPlace(origin: GridCoord) {
	const { server, client } = handlers();
	if (server !== undefined) server.gcPlace.fire(target, origin);
	else client!.gcPlace.fire(origin);
}

function sendHoles(values: defined[]) {
	const { server, client } = handlers();
	if (server !== undefined) server.gcHoles.fire(target, values);
	else client!.gcHoles.fire(values);
}

function sendNames(names: string[]) {
	const { server, client } = handlers();
	if (server !== undefined) server.gcNames.fire(target, names);
	else client!.gcNames.fire(names);
}

function sendTagged(entry: [string, ...number[]]) {
	const { server, client } = handlers();
	if (server !== undefined) server.gcTagged.fire(target, entry);
	else client!.gcTagged.fire(entry);
}

function sendMany(values: number[]) {
	const { server, client } = handlers();
	if (server !== undefined) server.gcMany.fire(target, ...values);
	else client!.gcMany.fire(...values);
}

/** The remote of a member of this spec's network, which exists once the realm's handlers do. */
function remote(name: keyof GeneratedEvents) {
	handlers();
	return expectDefined(__harness.findRemote(name), `${name} remote`);
}

/** The payload of the last message a remote sent (a server's player is recorded apart from it). */
function lastPayload(channel: Instance): unknown {
	const sent = __harness.sent(channel);
	expectTrue(sent.size() > 0, `${channel.Name} sent something`);
	return sent[sent.size() - 1].args[0];
}

/** What a call raised, or `undefined` when it did not. */
function raised(run: () => unknown): string | undefined {
	const [ok, err] = pcall(run);
	return ok ? undefined : tostring(err);
}

function contains(text: string | undefined, part: string) {
	return text !== undefined && text.find(part, 1, true)[0] !== undefined;
}

/** Raises with a message containing `message`. */
function expectRaises(run: () => unknown, message: string, what: string) {
	const err = raised(run);
	expectTrue(contains(err, message), `${what}: expected an error with "${message}", got ${err ?? "none"}`);
}

function roundTrip<T>(serializer: Serialization.Serializer<T>, value: T): T {
	const [payload, blobs] = serializer.serialize(value);
	return serializer.deserialize(payload, blobs);
}

function coordText(coord: GridCoord) {
	return `${coord[0]},${coord[1]},${coord[2]}`;
}

/** A list's entries by index up to `size`, nil where it has none: `1,nil,3`. */
function entries(list: unknown[], size: number) {
	const parts = new Array<string>();
	for (const i of $range(0, size - 1)) parts.push(tostring(list[i]));
	return parts.join(",");
}

/** A tuple's values as text: `x,1,2`. */
function tupleText(values: defined[]) {
	return values.map((value) => tostring(value)).join(",");
}

/**
 * A send from a catch block whose variable is named `error`, as an error report's often is: the code
 * packed there raises a hole without calling the caught value.
 */
function tagFromCatch(entry: [string, ...number[]]) {
	const { server, client } = handlers();
	try {
		throw "caught";
	} catch (error) {
		if (server !== undefined) server.gcTagged.fire(target, entry);
		else client!.gcTagged.fire(entry);
		return tostring(error);
	}
}

/** Serializers made in a catch block whose variable is named `math`: an f32's check and a tuple's rest count call it. */
function measureFromCatch(value: number, entry: [boolean, ...Serialization.u8[]]) {
	try {
		throw "caught";
	} catch (math) {
		const f32 = Flamework.createSerializer<Serialization.Implicit.f32>();
		const tuple = Flamework.createSerializer<[boolean, ...Serialization.u8[]]>();
		const back = tupleText(roundTrip(tuple, entry) as defined[]);
		return { raised: raised(() => f32.serialize(value)), back, caught: tostring(math) };
	}
}

const coordSerializer = Flamework.createSerializer<GridCoord>();
const placementSerializer = Flamework.createSerializer<Placement>();
const actionSerializer = Flamework.createSerializer<Action>();
const reservedSerializer = Flamework.createSerializer<Reserved>();
const blobsSerializer = Flamework.createSerializer<defined[]>();
const numbersSerializer = Flamework.createSerializer<Serialization.u16[]>();
const namesSerializer = Flamework.createSerializer<string[]>();
const optionalSerializer = Flamework.createSerializer<Array<Serialization.u16 | undefined>>();
const implicitOptionalSerializer = Flamework.createSerializer<Array<Serialization.Implicit.u16 | undefined>>();
const anythingSerializer = Flamework.createSerializer<unknown[]>();
const taggedSerializer = Flamework.createSerializer<[string, ...number[]]>();
const holderSerializer = Flamework.createSerializer<Holder>();

export = suite("generated code", [
	[
		"packs a caller's readonly tuple where it is sent, and readonly fields, reading them back",
		() => {
			// As a game builds one: `[x, y, z] as unknown as GridCoord`.
			const origin = [1, -2, 300] as unknown as GridCoord;
			const channel = remote("gcPlace");
			__harness.clearSent(channel);
			sendPlace(origin);
			const payload = lastPayload(channel) as buffer;
			expectEqual(buffer.len(payload), 6, "three i16s");
			expectEqual(coordText(coordSerializer.deserialize(payload)), "1,-2,300", "the coordinate read back");

			const placement: Placement = { origin, rotation: 90, name: "wall", templateId: 7 };
			const back = roundTrip(placementSerializer, placement);
			expectEqual(
				`${coordText(back.origin)}|${back.rotation}|${back.name}|${back.templateId}`,
				"1,-2,300|90|wall|7",
				"the placement read back",
			);
		},
	],
	[
		"reads back fields named after words no local can take",
		() => {
			const sent: Action = { name: "increment", arguments: [5] };
			const action = roundTrip(actionSerializer, sent);
			expectEqual(`${action.name}:${action.arguments[0]}`, "increment:5", "a library's action");

			const reserved = reservedOf(1);
			expectEqual(
				describeReserved(roundTrip(reservedSerializer, reserved)),
				describeReserved(reserved),
				"every field",
			);
		},
	],
	[
		"writes a hole where the element type takes nil, and reads it back in its place",
		() => {
			const optional = [1, undefined, 3] as Array<Serialization.u16 | undefined>;
			const [payload] = optionalSerializer.serialize(optional);
			// The count, then a presence byte per element and a u16 after each present one.
			expectEqual(buffer.len(payload), 1 + 3 + 1 + 3, "bytes");
			expectEqual(entries(optionalSerializer.deserialize(payload), 3), "1,nil,3", "the list read back");

			// A value past its width next to a hole: the count and the elements still agree.
			const wide = [1, undefined, 70000] as Array<Serialization.u16 | undefined>;
			expectEqual(entries(roundTrip(optionalSerializer, wide), 3), "1,nil,4464", "a strict u16 wraps");
			expectRaises(
				() => implicitOptionalSerializer.serialize([1, undefined, 70000]),
				"[Flamework] u16 cannot hold 70000, at value[]",
				"an implicit u16 is checked",
			);

			const anything = ["a", undefined, 3] as unknown[];
			expectEqual(entries(roundTrip(anythingSerializer, anything), 3), "a,nil,3", "unknown elements");
		},
	],
	[
		"refuses a hole the element type has no value for, before anything is written",
		() => {
			const holes = [{}, undefined, {}] as unknown as defined[];
			expectRaises(
				() => blobsSerializer.serialize(holes),
				"[Flamework] the array has no value at (defined[])[1]",
				"blobs (a fixed size: the writes refuse it)",
			);
			expectRaises(
				() => numbersSerializer.serialize([1, undefined, 3] as unknown as Serialization.u16[]),
				"[Flamework] the array has no value at value[1]",
				"numbers",
			);
			expectRaises(
				() => namesSerializer.serialize(["a", undefined, "c"] as unknown as string[]),
				"[Flamework] the array has no value at (string[])[1]",
				"strings (a variable size: the size pass refuses it)",
			);
			expectRaises(
				() => taggedSerializer.serialize(["x", 1, undefined, 3] as unknown as [string, ...number[]]),
				"[Flamework] the tuple has no value at value[2]",
				"a tuple's rest",
			);
			expectRaises(
				() => holderSerializer.serialize({ label: "h", list: [true, undefined, false] } as unknown as Holder),
				"[Flamework] the array has no value at Holder.list[1]",
				"inside a named type",
			);

			expectEqual(entries(roundTrip(namesSerializer, ["a", "b", "c"]), 3), "a,b,c", "a list with no hole");
		},
	],
	[
		"refuses such a hole under every serialization.checks, and where it is sent",
		() => {
			for (const name of ["warn", "none", "server", "client"] as const) {
				const variant = __harness.checkVariant(name);
				expectRaises(
					() => variant.holes.serialize([1, undefined, 2] as unknown as defined[]),
					"[Flamework] the array has no value at value[1]",
					`the ${name} build`,
				);
				expectEqual(
					entries(roundTrip(variant.optionalHoles, [1, undefined, 2]), 3),
					"1,nil,2",
					`the ${name} build's optional elements`,
				);
			}

			const channels = (["gcHoles", "gcNames", "gcTagged", "gcMany"] as const).map((name) => remote(name));
			for (const channel of channels) __harness.clearSent(channel);
			expectRaises(
				() => sendHoles([1, undefined, 2] as unknown as defined[]),
				"[Flamework] the array has no value at (defined[])[1]",
				"an event's argument",
			);
			expectRaises(
				() => sendNames(["a", undefined, "c"] as unknown as string[]),
				"[Flamework] the array has no value at (string[])[1]",
				"an event's strings",
			);
			expectRaises(
				() => sendTagged(["x", 1, undefined, 3] as unknown as [string, ...number[]]),
				"[Flamework] the tuple has no value at 'gcTagged' [0][2]",
				"an event's tuple",
			);
			expectRaises(
				() => sendMany([1, undefined, 3] as unknown as number[]),
				"[Flamework] the argument list has no value at 'gcMany' [1]",
				"a spread into an array rest parameter",
			);
			for (const channel of channels) expectEqual(__harness.sent(channel).size(), 0, `${channel.Name}: sent`);
		},
	],
	[
		"packs and checks what is made in a catch block whose variable hides error or math",
		() => {
			// `catch (error)`: sent as anywhere else, and a hole still raises its own message.
			const channel = remote("gcTagged");
			__harness.clearSent(channel);
			expectTrue(contains(tagFromCatch(["x", 1, 2]), "caught"), "the catch block has the caught value");
			const payload = lastPayload(channel) as buffer;
			expectEqual(tupleText(taggedSerializer.deserialize(payload) as defined[]), "x,1,2", "the tuple read back");
			expectRaises(
				() => tagFromCatch(["x", 1, undefined, 3] as unknown as [string, ...number[]]),
				"[Flamework] the tuple has no value at 'gcTagged' [0][2]",
				"a hole sent from catch (error)",
			);
			expectEqual(__harness.sent(channel).size(), 1, "nothing sent for the hole");

			// `catch (math)`: an implicit f32's check and a tuple's rest count.
			const fits = measureFromCatch(1.5, [true, 1 as Serialization.u8, 2 as Serialization.u8]);
			expectEqual(fits.raised, undefined, "an f32 that fits");
			expectEqual(fits.back, "true,1,2", "the tuple read back");
			expectTrue(contains(fits.caught, "caught"), "the catch block has the caught value");
			expectTrue(
				contains(measureFromCatch(1e39, [false]).raised, "[Flamework] f32 cannot hold 1e+39, at value"),
				"an f32 past its range",
			);

			// The same code under every serialization.checks: only category `all` (the warn build) checks a
			// strict f32, and every build refuses a hole.
			for (const name of ["warn", "none", "server", "client"] as const) {
				const variant = __harness.checkVariant(name);
				__harness.clearWarnings();
				expectEqual(buffer.len(variant.f32InCatch(1e39)), 4, `the ${name} build: the f32 written`);
				const warned = __harness
					.warnings()
					.some((line) => contains(line, "[Flamework] f32 cannot hold 1e+39, at value"));
				expectEqual(warned, name === "warn", `the ${name} build: warned (${__harness.warnings().join(" | ")})`);
				expectEqual(buffer.len(variant.holesInCatch([true, false])), 3, `the ${name} build: no hole`);
				expectRaises(
					() => variant.holesInCatch([true, undefined, false] as unknown as boolean[]),
					"[Flamework] the array has no value at value[1]",
					`the ${name} build: a hole`,
				);
			}
			__harness.clearWarnings();
		},
	],
	[
		"packs an array rest parameter's arguments, none, one or several, known or spread",
		() => {
			const channel = remote("gcMany");
			const decode = Flamework.createSerializer<number[]>();
			const cases: Array<[number[], string]> = [
				[[], ""],
				[[7], "7"],
				[[1, 2, 3], "1,2,3"],
			];
			for (const [values, text] of cases) {
				__harness.clearSent(channel);
				sendMany(values);
				// A list of nothing but its rest is written as an array would be: the count, then the values.
				const payload = lastPayload(channel) as buffer;
				expectEqual(buffer.len(payload), 1 + 8 * values.size(), `${values.size()} arguments: bytes`);
				expectEqual(decode.deserialize(payload).join(","), text, `${values.size()} arguments`);
			}
		},
	],
]);
