import { Networking } from "@flamework-experimental/networking";

/**
 * The cross-realm spec. Both graphs load this same compiled module -- which is also what makes the
 * generated global name line up, since it comes from the callsite of `createEvent` -- and the
 * runner in `tests/runtime/replication.luau` calls the server half in one graph and the client half
 * in the other.
 *
 * Nothing here is a single-realm spec, so it is deliberately not part of `suites`.
 */
interface ServerEvents {
	setScore(score: number): void;

	/**
	 * One anonymous union spelled two ways. TypeScript keeps a single type for both, and each side has
	 * to number its members as written where the value is reached, or the tags disagree on the wire.
	 * Sent from `replicationSender.ts`: a file of its own, as a client script would be.
	 */
	sortA(value: string | number): void;
	sortB(value: number | string): void;
}

interface ClientEvents {
	scoreChanged(score: number): void;

	/** Unreliable, so it gets its own channel and is allowed to be dropped. */
	tick: Networking.Unreliable<(value: number) => void>;
}

interface ServerFunctions {
	echo(value: string): string;
}

export const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();
const GlobalFunctions = Networking.createFunction<ServerFunctions, {}>();

/** Whatever this graph has received, drained by the runner between cases. */
const log = new Array<string>();

/** Declared with method syntax so roblox-ts emits a `:` call, as the real handler expects. */
export function setupServer() {
	const events = GlobalEvents.createServer({});
	events.setScore.connect((player, score) => log.push(`${player.Name}:${score}`));
	events.sortA.connect((_player, value) => log.push(`sortA:${value}`));
	events.sortB.connect((_player, value) => log.push(`sortB:${value}`));

	GlobalFunctions.createServer({}).echo.setCallback((_player, value) => `${value}!`);
}

export function setupClient() {
	const events = GlobalEvents.createClient({});
	events.scoreChanged.connect((score) => log.push(`score:${score}`));
	events.tick.connect((value) => log.push(`tick:${value}`));

	// Resolving the function handler is itself part of the test: it has to find the server's
	// remotes rather than create its own.
	GlobalFunctions.createClient({});
}

export function fireScore(score: number) {
	GlobalEvents.createClient({}).setScore.fire(score);
}

declare const __harness: {
	findRemote: (id: string) => Instance | undefined;
};

/**
 * Sends what an exploiter might: a raw string on the remote where the server declared a number. The
 * typed API cannot produce this (with serialization on, its codec refuses the value), so the remote
 * is fired directly. Without serialization the guard rejects it; with serialization it is not even a
 * buffer. Either way the server has to drop it.
 */
export function fireBadScore() {
	GlobalEvents.createClient({});
	const remote = __harness.findRemote("setScore") as RemoteEvent | undefined;
	assert(remote, "setScore remote");
	remote.FireServer("not a number" as never);
}

export function broadcastScore(score: number) {
	GlobalEvents.createServer({}).scoreChanged.broadcast(score);
}

export function broadcastTick(value: number) {
	GlobalEvents.createServer({}).tick.broadcast(value);
}

export function invokeEcho(value: string) {
	return GlobalFunctions.createClient({}).echo.invoke(value);
}

/** Returns everything received since the last call and clears the log. */
export function drain() {
	const entries = [...log];
	log.clear();

	return entries;
}

/*
 * Members that opt into packing one by one: round trips in both directions, events reliable and
 * unreliable, function requests and results, with an Instance next to the buffer. They are packed
 * whether or not the project turns `networking.serialization` on.
 */
interface Item {
	id: number;
	name: string;
	count: number;
}

interface ModeServerEvents {
	serializedReport: Networking.SerializedReliable<(items: Item[], where: Instance) => void>;
	serializedBump: Networking.SerializedReliable<() => void>;
	serializedMove: Networking.SerializedUnreliable<(value: number) => void>;
	serializedStep: Networking.Unreliable<Networking.Serialized<(items: Item[]) => void>>;

	/** Its types can hold an Instance, which a call may leave out (an empty blob list stays off the wire). */
	serializedMark: Networking.SerializedReliable<(label: string, where?: Instance) => void>;
}

interface ModeClientEvents {
	serializedPush: Networking.SerializedReliable<(items: Item[], where: Instance) => void>;
	serializedTick: Networking.Serialized<Networking.Unreliable<(value: number) => void>>;
	serializedMarked: Networking.SerializedReliable<(label: string, where?: Instance) => void>;
}

interface ModeServerFunctions {
	serializedLookup: Networking.Serialized<(ids: number[], where: Instance) => [Item[], Instance]>;
	serializedNothing: Networking.Serialized<() => void>;

	/** Answers with the Instance it was sent, if any. */
	serializedFind: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
}

interface ModeClientFunctions {
	serializedAsk: Networking.Serialized<(question: string) => Item[]>;
	serializedFound: Networking.Serialized<(label: string, where?: Instance) => Instance | undefined>;
}

const ModeEvents = Networking.createEvent<ModeServerEvents, ModeClientEvents>();
const ModeFunctions = Networking.createFunction<ModeServerFunctions, ModeClientFunctions>();

function makeItems(count: number, name: string) {
	const items = new Array<Item>();
	for (const id of $range(1, count)) items.push({ id, name, count: id * 2 });
	return items;
}

/** `name:count:lastId:lastCount@where` */
function describeItems(items: Item[], where?: Instance) {
	const last = items[items.size() - 1];
	const tail = last !== undefined ? `${last.id}:${last.count}` : "none";
	return `${items[0]?.name ?? "none"}:${items.size()}:${tail}${where !== undefined ? `@${where.Name}` : ""}`;
}

/** `label@where`, or `label@none` without an Instance. */
function describeMark(label: string, where?: Instance) {
	return `${label}@${where !== undefined ? where.Name : "none"}`;
}

export function setupModeServer() {
	const events = ModeEvents.createServer({});
	events.serializedReport.connect((_player, items, where) =>
		log.push(`serializedReport:${describeItems(items, where)}`),
	);
	events.serializedBump.connect(() => log.push("serializedBump"));
	events.serializedMove.connect((_player, value) => log.push(`serializedMove:${value}`));
	events.serializedStep.connect((_player, items) => log.push(`serializedStep:${describeItems(items)}`));

	const functions = ModeFunctions.createServer({});
	functions.serializedLookup.setCallback((_player, ids, where) => [
		makeItems(ids.size(), `for-${where.Name}`),
		where,
	]);
	functions.serializedNothing.setCallback(() => {});
	functions.serializedFind.setCallback((_player, _label, where) => where);
	events.serializedMark.connect((_player, label, where) => log.push(`serializedMark:${describeMark(label, where)}`));
}

export function setupModeClient() {
	const events = ModeEvents.createClient({});
	events.serializedPush.connect((items, where) => log.push(`serializedPush:${describeItems(items, where)}`));
	events.serializedTick.connect((value) => log.push(`serializedTick:${value}`));

	const functions = ModeFunctions.createClient({});
	functions.serializedAsk.setCallback((question) => makeItems(3, question));
	functions.serializedFound.setCallback((_label, where) => where);
	events.serializedMarked.connect((label, where) => log.push(`serializedMarked:${describeMark(label, where)}`));
}

/** The client's sends: every event it has. */
export function fireModeClient(count: number, where: Instance) {
	const events = ModeEvents.createClient({});
	events.serializedReport.fire(makeItems(count, "serialized"), where);
	events.serializedBump.fire();
	events.serializedMove.fire(count);
	events.serializedStep.fire(makeItems(count, "stepped"));
}

export function fireModeServer(count: number, where: Instance) {
	const events = ModeEvents.createServer({});
	events.serializedPush.broadcast(makeItems(count, "pushed"), where);
	events.serializedTick.broadcast(count);
}

export function invokeModeServer(where: Instance) {
	const functions = ModeFunctions.createClient({});
	return Promise.all([
		functions.serializedLookup.invoke([1, 2, 3, 4], where).then(([items, back]) => describeItems(items, back)),
		functions.serializedNothing.invoke().then((value) => `nothing:${value === undefined}`),
	]);
}

/** Sends that can leave the blob list empty, each once without the Instance and once with it. */
export function fireMarkClient(where: Instance) {
	const events = ModeEvents.createClient({});
	events.serializedMark.fire("bare");
	events.serializedMark.fire("placed", where);
}

export function fireMarkServer(player: Player, where: Instance) {
	const events = ModeEvents.createServer({});
	events.serializedMarked.broadcast("all");
	events.serializedMarked.broadcast("all", where);
	events.serializedMarked.fire(player, "one");
	events.serializedMarked.fire(player, "one", where);
}

/** The Instance each request got back: its name, or `none`. */
export function invokeFindServer(where: Instance) {
	const functions = ModeFunctions.createClient({});
	const name = (found: Instance | undefined) => (found !== undefined ? found.Name : "none");
	return Promise.all([
		functions.serializedFind.invoke("bare").then(name),
		functions.serializedFind.invoke("placed", where).then(name),
	]);
}

export function invokeFoundClient(player: Player, where: Instance) {
	const functions = ModeFunctions.createServer({});
	const name = (found: Instance | undefined) => (found !== undefined ? found.Name : "none");
	return Promise.all([
		functions.serializedFound.invoke(player, "bare").then(name),
		functions.serializedFound.invoke(player, "placed", where).then(name),
	]);
}

export function invokeModeClient(player: Player) {
	const functions = ModeFunctions.createServer({});
	return functions.serializedAsk.invoke(player, "why").then((items) => describeItems(items));
}
