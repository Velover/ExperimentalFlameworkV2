import { beforeAll, describe, expect, test } from "bun:test";
import { compileFixtureFresh, compileProbes, type CompileResult } from "./compile";

/*
 * What networking's handler types accept, checked by building probe files that must compile: what
 * must not be assignable is asserted with conditional types. Each sender and function receiver
 * carries its member's name, after its namespaces' names, as the hidden `_flamework_member`, which
 * keeps members whose types are otherwise the same apart in a union (networkModes.test.ts has the
 * calls that needs).
 */

const header = `import { Networking } from "@flamework-experimental/networking";
import type { ClientSender, ServerSender } from "@flamework-experimental/networking/out/events/types";
import type {
	ClientReceiver as ClientFunctionReceiver,
	ClientSender as ClientFunctionSender,
	ServerReceiver as ServerFunctionReceiver,
	ServerSender as ServerFunctionSender,
} from "@flamework-experimental/networking/out/functions/types";

interface TypesServerEvents {
	move(value: number): void;
	moveToo(value: number): void;
	items: {
		move(value: number): void;
		nested: { move(value: number): void };
	};
}

interface TypesClientEvents {
	show(value: number): void;
	items: { show(value: number): void };
}

interface TypesServerFunctions {
	ask(value: number): string;
	items: { ask(value: number): string };
}

interface TypesClientFunctions {
	confirm(value: number): boolean;
}

const events = Networking.createEvent<TypesServerEvents, TypesClientEvents>();
const functions = Networking.createFunction<TypesServerFunctions, TypesClientFunctions>();
export const client = events.createClient({});
export const server = events.createServer({});
export const clientFunctions = functions.createClient({});
export const serverFunctions = functions.createServer({});
`;

const PROBES: Record<string, string> = {
	// A sender type written without a member's name takes any member's.
	zzTypesAnnotated: `${header}
export const sendMove: ClientSender<[number]> = client.move;
export const sendNested: ClientSender<[number]> = client.items.nested.move;
export const broadcastShow: ServerSender<[number]> = server.items.show;
export const invokeAsk: ClientFunctionSender<[number], string> = clientFunctions.items.ask;
export const invokeConfirm: ServerFunctionSender<[number], boolean> = serverFunctions.confirm;
export const answerAsk: ServerFunctionReceiver<[number], string> = serverFunctions.items.ask;
export const answerConfirm: ClientFunctionReceiver<[number], boolean> = clientFunctions.confirm;

export function sendEither(flag: boolean) {
	let sender: ClientSender<[number]> = client.move;
	if (flag) sender = client.moveToo;
	sender = flag ? sender : client.items.move;
	return sender;
}
`,
	// A sender is still a function of its arguments.
	zzTypesFunctions: `${header}
export const move: (value: number) => void = client.items.nested.move;
export const show: (player: Player | Player[], value: number) => void = server.show;
export const ask: (value: number) => Promise<string> = clientFunctions.items.ask;
export const confirm: (player: Player, value: number) => Promise<boolean> = serverFunctions.confirm;
`,
	// Each member's own name, after its namespaces' names.
	zzTypesMembers: `${header}
type Member<T> = T extends { readonly _flamework_member?: infer K } ? NonNullable<K> : never;
type Is<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const names: [
	Is<Member<typeof client.move>, "move">,
	Is<Member<typeof client.moveToo>, "moveToo">,
	Is<Member<typeof client.items.move>, "items.move">,
	Is<Member<typeof client.items.nested.move>, "items.nested.move">,
	Is<Member<typeof server.show>, "show">,
	Is<Member<typeof server.items.show>, "items.show">,
	Is<Member<typeof clientFunctions.ask>, "ask">,
	Is<Member<typeof clientFunctions.items.ask>, "items.ask">,
	Is<Member<typeof clientFunctions.confirm>, "confirm">,
	Is<Member<typeof serverFunctions.items.ask>, "items.ask">,
	Is<Member<typeof serverFunctions.confirm>, "confirm">,
] = [true, true, true, true, true, true, true, true, true, true, true];

// So a variable typed as one member's sender (\`let sender = client.move\`) takes no other member's, even
// of the same type. (roblox-ts refuses \`@ts-expect-error\`.)
type Takes<T, V> = [V] extends [T] ? true : false;
export const others: [
	Takes<typeof client.move, typeof client.move>,
	Takes<typeof client.move, typeof client.moveToo>,
	Takes<typeof client.move, typeof client.items.move>,
	Takes<typeof client.items.move, typeof client.items.nested.move>,
	Takes<typeof clientFunctions.ask, typeof clientFunctions.items.ask>,
	Takes<typeof serverFunctions.ask, typeof serverFunctions.items.ask>,
] = [true, false, false, false, false, false];
`,
};

describe("networking's handler types", () => {
	let result: CompileResult;
	beforeAll(() => {
		result = compileProbes(PROBES);
	});

	/** The TypeScript errors of one probe, as `line: message`. */
	const errors = (name: string) =>
		[
			...result.output
				.replace(/\x1b\[[0-9;]*m/g, "")
				.matchAll(new RegExp(`src/${name}\\.ts:(\\d+):\\d+ - error (TS[^:]*: [^\\r\\n]*)`, "g")),
		].map((match) => `${match[1]}: ${match[2]}`);

	test("a sender type written without a member's name takes any member's sender or receiver", () => {
		expect(errors("zzTypesAnnotated")).toEqual([]);
	});

	test("a sender still assigns to a function type of its arguments", () => {
		expect(errors("zzTypesFunctions")).toEqual([]);
	});

	test("each member carries its own name, after its namespaces' names, and takes no other's sender", () => {
		expect(errors("zzTypesMembers")).toEqual([]);
	});

	test("all of them build", () => {
		expect(result.status).toBe(0);
		expect(result.files.size).toBe(Object.keys(PROBES).length);
	});
});

describe("key obfuscation through namespaces", () => {
	test("hashes each name of a member's path, and still packs a call on either of two members", () => {
		const result = compileProbes(
			{
				zzTypesObfuscated: `import { Networking } from "@flamework-experimental/networking";

interface ObfuscatedEvents {
	move(value: number): void;
	items: { move(value: number): void };
}

const events = Networking.createEvent<ObfuscatedEvents, {}>();
export const client = events.createClient({});

export function sendNested() {
	client.items.move.fire(1);
}

export function sendEither(flag: boolean) {
	(flag ? client.move : client.items.move).fire(1);
}
`,
			},
			{ FLAMEWORK_FIXTURE_OBFUSCATE: "true" },
		);

		try {
			expect(result.status).toBe(0);
			const luau = result.files.get("zzTypesObfuscated")!;
			expect(luau).not.toMatch(/move|items/);
			expect(luau).toMatch(/local function sendNested\(\)\s*local buf\w* = buffer\.create\(8\)/);
			expect(luau.match(/:_fire\(buf\w*\)/g)?.length).toBe(2);
		} finally {
			// The obfuscated build rewrote the fixture's include/flamework artifacts: what later tests
			// read from disk is the ordinary build again.
			const restored = compileFixtureFresh();
			if (restored.status !== 0) throw new Error(`fixture failed to restore:\n${restored.output}`);
		}
	});
});
