import { Flamework } from "@flamework-experimental/core";
import { RunService } from "@rbxts/services";
import * as off from "../typeChecks/codecs";
import * as widthCodecs from "../widthChecks/codecs";
import { expectDefined, expectEqual, expectTrue, suite } from "../testkit";

/*
 * Type checks (`serialization.checks.types`): every value written is tested to be of its declared kind
 * first, and one that is not raises naming what was expected, what came and where, instead of the
 * buffer library's error with no field name. The encodings are src/typeChecks/codecs.ts, as the
 * `types`, `typesWarn` and `typesServer` projects in packages/specs/variants built them, and as the
 * specs' own build did, with the checks off (`off`).
 */

type Codecs = typeof off;

declare const __harness: {
	sent: (remote: Instance) => Array<{ kind: string; player?: Instance; args: Array<unknown> }>;
	clearSent: (remote: Instance) => void;
	findRemote: (id: string) => Instance | undefined;
	findRemoteById: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
	warnings: () => string[];
	clearWarnings: () => void;
	checkVariant: (name: "types" | "typesWarn" | "typesServer") => typeof widthCodecs;
};

interface Inbound {
	Fire(this: unknown, ...args: unknown[]): void;
}

/** A serializer of any type, handed values of the wrong one. */
type AnySerializer = {
	serialize: (value: never) => LuaTuple<[buffer, Array<defined> | undefined]>;
	deserialize: (payload: buffer, blobs?: Array<defined>) => unknown;
};

const isServer = RunService.IsServer();
const requester = __harness.newPlayer("Types") as Player;

function variant(name: "types" | "typesWarn" | "typesServer"): Codecs {
	return __harness.checkVariant(name).types;
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

/** Warned exactly once since the last clear, with a line containing `message`. */
function expectWarned(message: string, what: string) {
	const lines = __harness.warnings().filter((line) => contains(line, message));
	expectEqual(lines.size(), 1, `${what}: warnings with "${message}" (all: ${__harness.warnings().join(" | ")})`);
}

function expectNoWarnings(what: string) {
	expectEqual(__harness.warnings().size(), 0, `${what}: warnings (${__harness.warnings().join(" | ")})`);
}

function serializeAs(serializer: unknown, value: unknown) {
	return (serializer as AnySerializer).serialize(value as never);
}

function roundTrip(serializer: unknown, value: unknown): unknown {
	const [payload, blobs] = serializeAs(serializer, value);
	return (serializer as AnySerializer).deserialize(payload, blobs);
}

/** `serializer` refuses `value`, with a message containing `message`. */
function refuses(serializer: unknown, value: unknown, message: string, what: string) {
	expectRaises(() => serializeAs(serializer, value), message, what);
}

/** Compares tables, maps, sets and buffers by content. */
function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeIs(a, "buffer") && typeIs(b, "buffer")) return buffer.tostring(a) === buffer.tostring(b);
	if (!typeIs(a, "table") || !typeIs(b, "table")) return false;

	const left = a as Map<unknown, unknown>;
	const right = b as Map<unknown, unknown>;
	for (const [key, value] of left) {
		if (!deepEquals(value, right.get(key))) return false;
	}
	for (const [key] of right) {
		if (left.get(key) === undefined) return false;
	}
	return true;
}

function entity(): off.Entity {
	return {
		id: 7,
		name: "seven",
		tags: ["a", "bc"],
		pos: { x: 1, y: 2 },
		spot: new Vector3(1, 2, 3),
		flag: true,
		owner: { label: "me" },
	};
}

/** A value of the right type for every encoding, which each build writes the same. */
function goodValues(codecs: Codecs): Array<[string, unknown, unknown]> {
	const folder = new Instance("Folder");
	return [
		["number", codecs.number, 2.5],
		["u8", codecs.u8, 200],
		["varint", codecs.varint, 300],
		["text", codecs.text, "text"],
		["string8", codecs.string8, "short"],
		["boolean", codecs.boolean, false],
		["bytes", codecs.bytes, buffer.fromstring("bytes")],
		["literals", codecs.literals, "b"],
		["circle", codecs.circle, { kind: "circle", r: 2 }],
		["vector", codecs.vector, new Vector3(1, 2, 3)],
		["frame", codecs.frame, new CFrame(1, 2, 3)],
		["instance", codecs.instance, folder],
		["no instance", codecs.instance, undefined],
		["anything", codecs.anything, "anything"],
		["list", codecs.list, [1, 2, 3]],
		["names", codecs.names, ["a", "b"]],
		["set", codecs.set, new Set(["a", "b"])],
		["map", codecs.map, new Map([["a", 1]])],
		["maybe", codecs.maybe, undefined],
		["maybe a number", codecs.maybe, 4],
		["either", codecs.either, "four"],
		["pair", codecs.pair, [1, "one"]],
		["fixedPair", codecs.fixedPair, [1, true]],
		["point", codecs.point, { x: 1, y: 2 }],
		["points", codecs.points, [{ x: 1, y: 2 }]],
		["entity", codecs.entity, entity()],
		["shape", codecs.shape, { kind: "rect", w: 1, h: 2, label: "r" }],
		["plastic", codecs.plastic, Enum.Material.Plastic],
		["plasticOrWood", codecs.plasticOrWood, Enum.Material.Wood],
		["plasticOrNumber", codecs.plasticOrNumber, 5],
		["plasticOrNumber an item", codecs.plasticOrNumber, Enum.Material.Plastic],
	];
}

let events: off.Events | undefined;
let functions: off.Functions | undefined;

/** The `types` build's handlers for the realm. Remotes are the server's to create, so a client spec primes them first. */
function handlers(codecs: Codecs) {
	if (events !== undefined && functions !== undefined) return { events, functions };

	if (isServer) {
		events = { server: codecs.TypeEventsNetwork.createServer({}) };
		functions = { server: codecs.TypeFunctionsNetwork.createServer({}) };
	} else {
		__harness.asRealm("Server", () => {
			codecs.TypeEventsNetwork.createServer({});
			codecs.TypeFunctionsNetwork.createServer({});
			__harness.flush();
		});
		events = { client: codecs.TypeEventsNetwork.createClient({}) };
		functions = { client: codecs.TypeFunctionsNetwork.createClient({}) };
	}

	__harness.flush();
	return { events, functions };
}

function remote(name: string) {
	return expectDefined(__harness.findRemote(name), `${name} remote`);
}

/** Delivers a message as the other realm would, adding the sender on the server. */
function deliver(channel: Instance, ...args: unknown[]) {
	const signals = channel as unknown as {
		OnServerEvent: Inbound;
		OnClientEvent: Inbound;
	};
	if (isServer) {
		signals.OnServerEvent.Fire(requester, ...args);
	} else {
		signals.OnClientEvent.Fire(...args);
	}
}

export = suite("type checks", [
	[
		"raises naming what was expected, what came and where, for every kind a value is written as",
		() => {
			const v = variant("types");
			refuses(v.number, "x", "[Flamework] number expected, got string, at value", "a number");
			refuses(
				v.number,
				"5",
				"[Flamework] number expected, got string, at value",
				"a string Luau reads as a number",
			);
			// Tested ahead of its range, whose comparisons would raise on a string.
			refuses(v.u8, "x", "[Flamework] number expected, got string, at value", "a checked width");
			refuses(v.varint, true, "[Flamework] number expected, got boolean, at value", "a varint");
			refuses(v.text, 5, "[Flamework] string expected, got number, at value", "a string");
			refuses(v.text, {}, "[Flamework] string expected, got table, at value", "a table for a string");
			refuses(v.string8, 5, "[Flamework] string expected, got number, at value", "a string8");
			refuses(v.boolean, 1, "[Flamework] boolean expected, got number, at value", "a boolean");
			refuses(v.bytes, "x", "[Flamework] buffer expected, got string, at value", "a buffer");
			refuses(v.literals, "d", `[Flamework] "a" | "b" | "c" expected, got "d", at value`, "no literal member");
			refuses(v.literals, 5, `[Flamework] "a" | "b" | "c" expected, got 5, at value`, "a number for a literal");
			refuses(
				v.circle,
				{ kind: "square", r: 1 },
				`[Flamework] "circle" expected, got "square", at value.kind`,
				"a lone literal",
			);
			refuses(v.vector, { X: 1, Y: 2, Z: 3 }, "[Flamework] Vector3 expected, got table, at value", "a Vector3");
			refuses(v.frame, new Vector3(1, 2, 3), "[Flamework] CFrame expected, got Vector3, at value", "a CFrame");
			refuses(v.instance, "x", "[Flamework] Instance expected, got string, at value", "an Instance");
			refuses(v.list, "x", "[Flamework] table expected, got string, at value", "an array");
			refuses(v.list, [1, "2"], "[Flamework] number expected, got string, at value[]", "an array's element");
			refuses(v.names, ["a", 2], "[Flamework] string expected, got number, at value[]", "a string element");
			refuses(v.set, 5, "[Flamework] table expected, got number, at value", "a set");
			refuses(v.set, new Set([5]), "[Flamework] string expected, got number, at value[]", "a set's element");
			refuses(v.map, new Map([[1, 1]]), "[Flamework] string expected, got number, at value<key>", "a map's key");
			refuses(
				v.map,
				new Map([["a", "b"]]),
				"[Flamework] number expected, got string, at value<value>",
				"a map's value",
			);
			refuses(v.maybe, "x", "[Flamework] number expected, got string, at value", "an optional");
			refuses(v.either, true, "[Flamework] number | string expected, got boolean, at value", "a union");
			refuses(v.pair, "x", "[Flamework] table expected, got string, at value", "a tuple");
			refuses(v.pair, [1, 2], "[Flamework] string expected, got number, at value[1]", "a tuple's element");
			refuses(v.fixedPair, 5, "[Flamework] table expected, got number, at value", "a fixed-size tuple");
			refuses(
				v.fixedPair,
				[1, "x"],
				"[Flamework] boolean expected, got string, at value[1]",
				"a fixed-size tuple's element",
			);
			refuses(v.point, 5, "[Flamework] table expected, got number, at Point", "an object");
			refuses(v.point, { x: 1, y: "2" }, "[Flamework] number expected, got string, at Point.y", "a field");
			refuses(
				v.points,
				[{ x: 1, y: 2 }, "p"],
				"[Flamework] table expected, got string, at value[]",
				"an element of a fixed size",
			);
			refuses(v.shape, 5, "[Flamework] Shape expected, got number, at Shape", "a union of tables");
			refuses(v.shape, { kind: "tri" }, "[Flamework] Shape expected, got table, at Shape", "no member");
			refuses(
				v.shape,
				{ kind: "rect", w: 1, h: 2, label: 3 },
				"[Flamework] string expected, got number, at Shape.label",
				"inside a member",
			);
			// Enum items as literal types are named as the items. What came is shown as itself; Lune's
			// stand-in for Enum makes an item a table, so for another item only the expected part is compared.
			refuses(v.plastic, "x", `[Flamework] Enum.Material.Plastic expected, got "x", at value`, "an enum item");
			refuses(v.plastic, Enum.Material.Wood, "[Flamework] Enum.Material.Plastic expected, got ", "another item");
			refuses(
				v.plasticOrWood,
				"x",
				`[Flamework] Enum.Material.Plastic | Enum.Material.Wood expected, got "x", at value`,
				"no item of a union of them",
			);
			refuses(
				v.plasticOrNumber,
				"x",
				"[Flamework] Enum.Material.Plastic | Enum.Material.Wood | number expected, got string, at value",
				"a union of items and a number",
			);
		},
	],
	[
		"names the path through a named type's shared code",
		() => {
			const v = variant("types");
			const bad = (patch: Partial<off.Entity>, message: string, what: string) =>
				refuses(v.entity, { ...entity(), ...patch }, message, what);
			bad({ id: "7" as never }, "[Flamework] number expected, got string, at Entity.id", "a field");
			bad({ name: 5 as never }, "[Flamework] string expected, got number, at Entity.name", "a measured field");
			bad({ tags: ["a", 5 as never] }, "[Flamework] string expected, got number, at Entity.tags[]", "an element");
			bad(
				{ pos: { x: "1" as never, y: 2 } },
				"[Flamework] number expected, got string, at Entity.pos.x",
				"nested",
			);
			bad({ spot: 5 as never }, "[Flamework] Vector3 expected, got number, at Entity.spot", "an optional");
			bad({ flag: "yes" as never }, "[Flamework] boolean expected, got string, at Entity.flag", "a boolean");
			// A named type inside another starts from the outer type's name.
			bad(
				{ owner: { label: 5 as never } },
				"[Flamework] string expected, got number, at Entity.owner.label",
				"a named type inside",
			);
			bad({ owner: "me" as never }, "[Flamework] table expected, got string, at Entity.owner", "its table");
		},
	],
	[
		"writes every value of the right type as the build without the checks does, and reads it back",
		() => {
			const v = variant("types");
			const on = goodValues(v);
			const without = goodValues(off);
			on.forEach(([name, serializer, value], index) => {
				const [payload] = serializeAs(serializer, value);
				const [expected] = serializeAs(without[index][1], without[index][2]);
				expectEqual(buffer.tostring(payload), buffer.tostring(expected), `${name}: the same bytes`);
				expectTrue(deepEquals(roundTrip(serializer, value), value), `${name}: read back`);
			});
		},
	],
	[
		"`warn`: raises for a value of the wrong type all the same, but warns about a boolean and writes it as whether it is truthy",
		() => {
			const v = variant("typesWarn");
			__harness.clearWarnings();
			refuses(v.number, "x", "[Flamework] number expected, got string, at value", "a number");
			refuses(v.either, true, "[Flamework] number | string expected, got boolean, at value", "a union");
			refuses(v.literals, "d", `[Flamework] "a" | "b" | "c" expected, got "d", at value`, "a literal");
			// Only a value declared `boolean` is warned about: a lone literal type raises like the rest.
			refuses(
				v.circle,
				{ kind: "square", r: 1 },
				`[Flamework] "circle" expected, got "square", at value.kind`,
				"a lone literal",
			);
			refuses(v.list, [1, "2"], "[Flamework] number expected, got string, at value[]", "an element");
			expectNoWarnings("raised, not warned");

			expectEqual(roundTrip(v.boolean, 1), true, "1 is truthy");
			expectWarned("[Flamework] boolean expected, got number, at value", "a number for a boolean");
			__harness.clearWarnings();
			expectEqual(roundTrip(v.boolean, undefined), false, "nil is not");
			expectWarned("[Flamework] boolean expected, got nil, at value", "nil for a boolean");
			__harness.clearWarnings();

			const pair = roundTrip(v.fixedPair, [1, "x"]) as [number, boolean];
			expectEqual(pair[1], true, "a string in a tuple is truthy");
			expectWarned("[Flamework] boolean expected, got string, at value[1]", "a tuple's boolean");
			__harness.clearWarnings();

			const written = roundTrip(v.entity, {
				...entity(),
				flag: "yes",
			}) as off.Entity;
			expectEqual(written.flag, true, "a field written as truthy");
			expectEqual(written.name, "seven", "and the rest as they are");
			expectWarned("[Flamework] boolean expected, got string, at Entity.flag", "a field's boolean");
			__harness.clearWarnings();

			expectEqual(roundTrip(v.boolean, false), false, "a boolean");
			expectNoWarnings("a boolean of the right type");
		},
	],
	[
		"`side`: tests the writes of the realm it names, in a module both realms run",
		() => {
			const v = variant("typesServer");
			__harness.clearWarnings();
			if (isServer) {
				refuses(v.number, "x", "[Flamework] number expected, got string, at value", "a number");
				refuses(v.boolean, 1, "[Flamework] boolean expected, got number, at value", "a boolean");
				refuses(v.either, true, "[Flamework] number | string expected, got boolean, at value", "a union");
				refuses(v.literals, "d", `[Flamework] "a" | "b" | "c" expected, got "d", at value`, "a literal");
			} else {
				// Unchecked on the client: what the build without the checks does.
				refuses(v.number, "x", "invalid argument #3 to 'writef64' (number expected, got string)", "a number");
				expectEqual(roundTrip(v.boolean, 1), true, "a boolean written as truthy");
				refuses(v.either, true, "value matches none of the union's members", "a union");
				refuses(v.literals, "d", "value is not one of the literals its type allows", "a literal");
				expectTrue(
					!contains(
						raised(() => serializeAs(v.either, true)),
						"[Flamework]",
					),
					"no type check's message",
				);
			}
			expectNoWarnings("side");
		},
	],
	[
		"with the checks off, a value of the wrong type raises the buffer library's error, and a boolean is written as whether it is truthy",
		() => {
			refuses(off.number, "x", "invalid argument #3 to 'writef64' (number expected, got string)", "a number");
			expectEqual(roundTrip(off.number, "5"), 5, "a string Luau reads as a number is written as one");
			expectEqual(roundTrip(off.boolean, 1), true, "a boolean");
			refuses(off.either, true, "value matches none of the union's members", "a union");
			expectTrue(
				!contains(
					raised(() => serializeAs(off.number, "x")),
					"[Flamework]",
				),
				"no type check's message",
			);
		},
	],
	[
		"tests every argument where a call site packs it, rest arguments included, and sends nothing when one fails",
		() => {
			const v = variant("types");
			const { events } = handlers(v);
			const move = remote("typeMove");
			const many = remote("typeMany");
			__harness.clearSent(move);
			__harness.clearSent(many);

			const fireMove = (id: unknown, value: unknown, flag: unknown) => () =>
				v.fireMove(events, requester, id as never, value as never, flag as never);
			expectRaises(
				fireMove("7", entity(), true),
				"[Flamework] number expected, got string, at 'typeMove' [0]",
				"[0]",
			);
			expectRaises(
				fireMove(7, { ...entity(), name: 5 }, true),
				"[Flamework] string expected, got number, at 'typeMove' [1].name",
				"a field of a named type, measured",
			);
			expectRaises(
				fireMove(7, { ...entity(), pos: { x: "1", y: 2 } }, true),
				"[Flamework] number expected, got string, at 'typeMove' [1].pos.x",
				"a field of a named type, written",
			);
			expectRaises(
				fireMove(7, { ...entity(), owner: { label: 5 } }, true),
				"[Flamework] string expected, got number, at Entity.owner.label",
				"a named type inside a named type",
			);
			expectRaises(
				fireMove(7, entity(), 1),
				"[Flamework] boolean expected, got number, at 'typeMove' [2]",
				"[2]",
			);
			expectEqual(__harness.sent(move).size(), 0, "nothing sent");

			expectRaises(
				() => v.fireThree(events, requester, "l", 1, "2" as never, 3),
				"[Flamework] number expected, got string, at 'typeMany' [2]",
				"a rest argument",
			);
			expectRaises(
				() => v.fireSpread(events, requester, "l", [1, "2" as never]),
				"[Flamework] number expected, got string, at 'typeMany' []",
				"a spread argument",
			);
			expectRaises(
				() => v.fireSpread(events, requester, 5 as never, []),
				"[Flamework] string expected, got number, at 'typeMany' [0]",
				"the argument ahead of a spread",
			);
			expectEqual(__harness.sent(many).size(), 0, "nothing sent");

			v.fireMove(events, requester, 7, entity(), true);
			v.fireThree(events, requester, "l", 1, 2, 3);
			v.fireSpread(events, requester, "l", [1, 2]);
			expectEqual(__harness.sent(move).size(), 1, "sent once they are right");
			expectEqual(__harness.sent(many).size(), 2, "both rest forms sent");
		},
	],
	[
		"tests a request where it is invoked and a result where the callback's value is packed",
		() => {
			const v = variant("types");
			const { functions } = handlers(v);
			const send = expectDefined(__harness.findRemoteById(`${isServer ? "@" : "$"}typeAsk`), "request channel");
			__harness.clearSent(send);
			expectRaises(
				() => v.invokeAsk(functions, requester, "1" as never),
				"[Flamework] number expected, got string, at 'typeAsk' [0]",
				"the request",
			);
			expectEqual(__harness.sent(send).size(), 0, "no request sent");

			v.answerAsk(functions, (id) => (id === 1 ? { x: 1, y: 2 } : ({ x: "1", y: 2 } as never)));
			const receive = expectDefined(
				__harness.findRemoteById(`${isServer ? "$" : "@"}typeAsk`),
				"receive channel",
			);
			const request = Flamework.createSerializer<[number]>();
			const result = Flamework.createSerializer<[off.Point]>();

			__harness.clearSent(receive);
			deliver(receive, 1, request.serialize([1])[0]);
			const answered = __harness.sent(receive);
			expectEqual(answered.size(), 1, "responses");
			expectEqual(answered[0].args[1], true, "a result of the right type");
			expectEqual(result.deserialize(answered[0].args[2] as buffer)[0].y, 2, "the packed result");

			__harness.clearSent(receive);
			__harness.clearWarnings();
			deliver(receive, 2, request.serialize([2])[0]);
			const refused = __harness.sent(receive);
			expectEqual(refused.size(), 1, "responses");
			expectEqual(refused[0].args[1], false, "answered as a failure, with no result");
			expectEqual(refused[0].args.size(), 2, "no packed result");
			expectWarned("[Flamework] number expected, got string, at 'typeAsk' result.x", "the result");
			__harness.clearWarnings();
		},
	],
]);
