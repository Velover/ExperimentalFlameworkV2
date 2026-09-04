import { Networking } from "@flamework/networking";

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
}

interface ClientEvents {
	scoreChanged(score: number): void;

	/** Unreliable, so it gets its own channel and is allowed to be dropped. */
	tick: Networking.Unreliable<(value: number) => void>;
}

interface ServerFunctions {
	echo(value: string): string;
}

const GlobalEvents = Networking.createEvent<ServerEvents, ClientEvents>();
const GlobalFunctions = Networking.createFunction<ServerFunctions, {}>();

/** Whatever this graph has received, drained by the runner between cases. */
const log = new Array<string>();

/** Declared with method syntax so roblox-ts emits a `:` call, as the real handler expects. */
interface LooseSender {
	fire(value: unknown): void;
}

export function setupServer() {
	const events = GlobalEvents.createServer({});
	events.setScore.connect((player, score) => log.push(`${player.Name}:${score}`));

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

/** Sends a payload the server's generated guard has to reject. */
export function fireBadScore() {
	const client = GlobalEvents.createClient({}) as unknown as { setScore: LooseSender };
	client.setScore.fire("not a number");
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
