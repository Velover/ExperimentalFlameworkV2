import { Flamework, Modding, Serialization } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";
import { RunService } from "@rbxts/services";
import { expectDefined, expectEqual, expectFalse, expectNoThrow, expectThrows, expectTrue, suite } from "../testkit";

/*
 * Guards of recursive types: trees, linked lists, nested menus and JSON-like values. Their guards call
 * themselves, and refuse a value they would have to follow more than a thousand levels deep, which is
 * also how a value that contains itself is refused rather than overflowing the stack.
 */

interface Tree {
	value: number;
	kids: Tree[];
}

interface Chain {
	value: number;
	next?: Chain;
}

interface Menu {
	label: string;
	items: Map<string, Menu>;
}

type Json = string | number | boolean | Json[] | { [key: string]: Json };

interface Directory {
	name: string;
	files?: Entry[];
}

interface Entry {
	name: string;
	parent: Directory;
}

/** A union whose members both go into the same children: a check tries each member in turn. */
type Node = { kind: "folder"; children?: Node[] } | { kind: "group"; children?: Node[] };

/** The same without a discriminant. */
type Either = { x: number; kids: Either[] } | { y: string; kids: Either[] };

/** How deep a recursive guard follows a value before it refuses it (`GUARD_RECURSION_LIMIT`). */
const LIMIT = 1000;

/**
 * How long a check of a small value may take, in seconds: far more than a check that reads each
 * table once needs on a slow machine (well under a millisecond here), and far less than the 5.8
 * seconds `hostileNode(20)` took when each union member checked the same children again, a time
 * that doubles with every level.
 */
const QUICK = 0.25;

/** Seconds `callback` took. */
function timed(callback: () => void): number {
	const start = os.clock();
	callback();
	return os.clock() - start;
}

/** `levels` groups, each the only child of the one above, around a node of no kind the type has. */
function hostileNode(levels: number): unknown {
	let node: unknown = { kind: "other" };
	for (let i = 0; i < levels; i++) node = { kind: "group", children: [node] };
	return node;
}

function validNode(levels: number): Node {
	let node: Node = { kind: "folder" };
	for (let i = 0; i < levels; i++) node = { kind: "group", children: [node] };
	return node;
}

/** `levels` nodes of the second member, each the only child of the one above, around one of neither. */
function hostileEither(levels: number): unknown {
	let node: unknown = { z: true, kids: [] };
	for (let i = 0; i < levels; i++) node = { y: "y", kids: [node] };
	return node;
}

/** `levels` nodes, each holding the one below twice: 2^levels paths through `levels + 1` tables. */
function diamond(levels: number): Tree {
	let node = leaf(0);
	for (let i = 1; i <= levels; i++) node = { value: i, kids: [node, node] };
	return node;
}

/** A tree `depth` levels deep with `width` leaves on every level: `depth * (width + 1) + 1` nodes. */
function wideTree(depth: number, width: number): Tree {
	const root = leaf(0);
	let node = root;
	for (let level = 1; level <= depth; level++) {
		for (let i = 1; i <= width; i++) node.kids.push(leaf(i));
		const below = leaf(level);
		node.kids.push(below);
		node = below;
	}

	return root;
}

function leaf(value: number): Tree {
	return { value, kids: [] };
}

/** A chain of `length` nodes, each the only child of the one before. */
function deepTree(length: number): Tree {
	const root = leaf(1);
	let node = root;
	for (let i = 2; i <= length; i++) {
		const child = leaf(i);
		node.kids.push(child);
		node = child;
	}

	return root;
}

/** The node at the bottom of `deepTree`. */
function bottom(tree: Tree): Tree {
	let node = tree;
	while (node.kids.size() > 0) node = node.kids[0];
	return node;
}

function deepChain(length: number): Chain {
	const root: Chain = { value: 1 };
	let node = root;
	for (let i = 2; i <= length; i++) {
		const link: Chain = { value: i };
		node.next = link;
		node = link;
	}

	return root;
}

interface RecursiveServerEvents {
	/** Serialized when the project serializes: the guard runs on what the decoder read. */
	recursiveTree(tree: Tree): void;
	/** As it is: the guard runs on the table that arrived. */
	recursiveRawTree: Networking.RawReliable<(tree: Tree) => void>;
}

interface RecursiveClientEvents {
	recursiveJson(value: Json): void;
}

const RecursiveEvents = Networking.createEvent<RecursiveServerEvents, RecursiveClientEvents>();

/** @metadata macro */
function wireDecoder<T extends unknown[]>(
	meta?: Modding.Intrinsic<"network-decoder", [T], Serialization.Decoder<T> | undefined>,
): Serialization.Decoder<T> | undefined {
	return meta;
}

const treeWire = { decode: wireDecoder<[Tree]>(), pack: Flamework.createSerializer<[Tree]>() };
const jsonWire = { decode: wireDecoder<[Json]>(), pack: Flamework.createSerializer<[Json]>() };

/** Arguments as the other realm would put them on the wire. */
function onWire<T extends unknown[]>(
	wire: { decode: Serialization.Decoder<T> | undefined; pack: Serialization.Serializer<T> },
	...args: T
): unknown[] {
	if (wire.decode === undefined) return args;
	const [payload, blobs] = wire.pack.serialize(args);
	return blobs ? [payload, blobs] : [payload];
}

declare const __harness: {
	findRemote: (id: string) => Instance | undefined;
	newPlayer: (name: string) => Instance;
	flush: () => void;
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;
};

let primed = false;
function primeRemotes() {
	if (primed) return;
	primed = true;
	__harness.asRealm("Server", () => {
		RecursiveEvents.createServer({});
	});
}

type Fire = { Fire(this: unknown, ...args: unknown[]): void };

export = suite("recursive guards", [
	[
		"checks a whole tree, down to a bad leaf deep inside it",
		() => {
			const isTree = Flamework.createGuard<Tree>();

			const tree: Tree = { value: 1, kids: [leaf(2), { value: 3, kids: [leaf(4), leaf(5)] }] };
			expectTrue(isTree(tree), "a valid tree");
			expectTrue(isTree(leaf(0)), "a tree of one node");

			const deep = deepTree(50);
			expectTrue(isTree(deep), "a valid tree 50 levels deep");
			(bottom(deep) as { value: unknown }).value = "bad";
			expectFalse(isTree(deep), "a tree whose deepest leaf has a string for its value");

			const missing = deepTree(20);
			(bottom(missing) as { kids?: unknown }).kids = undefined;
			expectFalse(isTree(missing), "a tree whose deepest leaf has no kids");

			expectFalse(isTree({ value: 1, kids: [1, 2] }), "kids that are not trees");
			expectFalse(isTree(undefined), "nothing");
		},
	],
	[
		"refuses a value that contains itself, without hanging or overflowing",
		() => {
			const isTree = Flamework.createGuard<Tree>();
			const isChain = Flamework.createGuard<Chain>();

			const tree = leaf(1);
			tree.kids.push(tree);
			expectNoThrow(() => expectFalse(isTree(tree), "a tree that is its own child"), "checking a cyclic tree");

			const chain: Chain = { value: 1 };
			chain.next = { value: 2, next: chain };
			expectNoThrow(() => expectFalse(isChain(chain), "a chain that loops"), "checking a cyclic chain");

			// The count starts again at every check: a check refused at the limit leaves nothing behind.
			expectTrue(isTree(deepTree(10)), "a valid tree after a cyclic one");
		},
	],
	[
		`follows a value ${LIMIT} levels deep and refuses one deeper`,
		() => {
			const isTree = Flamework.createGuard<Tree>();
			const isChain = Flamework.createGuard<Chain>();

			// The root is checked before the guard calls itself: a chain of LIMIT + 1 nodes calls it LIMIT times.
			expectTrue(isTree(deepTree(LIMIT + 1)), "a tree at the limit");
			expectFalse(isTree(deepTree(LIMIT + 2)), "a tree one level past the limit");
			expectTrue(isChain(deepChain(LIMIT + 1)), "a chain at the limit");
			expectFalse(isChain(deepChain(LIMIT + 2)), "a chain one level past the limit");

			// Far past what Luau's stack could follow, a hostile client's payload is refused all the same.
			expectNoThrow(
				() => expectFalse(isChain(deepChain(100000)), "a chain 100,000 levels deep"),
				"checking a very deep chain",
			);
		},
	],
	[
		"checks recursion through an alias, a union, an array, a map, an optional and two types",
		() => {
			const isJson = Flamework.createGuard<Json>();
			expectTrue(isJson({ a: [1, "two", { b: true }], c: { d: [] } }), "a JSON-like value");
			expectTrue(isJson([[[["deep"]]]]), "nested arrays");
			expectFalse(isJson({ a: [1, { b: new Vector3(1, 2, 3) }] }), "a Vector3 deep inside");

			const isMenu = Flamework.createGuard<Menu>();
			const sub: Menu = { label: "Sub", items: new Map() };
			const menu: Menu = { label: "Main", items: new Map([["sub", sub]]) };
			expectTrue(isMenu(menu), "a menu with a submenu");
			(sub.items as Map<string, unknown>).set("bad", { label: 5, items: new Map() });
			expectFalse(isMenu(menu), "a submenu with a bad entry");

			const isChain = Flamework.createGuard<Chain>();
			expectTrue(isChain(deepChain(5)), "a linked list");
			expectFalse(isChain({ value: 1, next: { value: 2, next: { value: "3" } } }), "a bad node at the end");

			const isDirectory = Flamework.createGuard<Directory>();
			const directory: Directory = { name: "root", files: [] };
			directory.files!.push({ name: "a", parent: directory });
			expectTrue(isDirectory({ name: "root", files: [{ name: "a", parent: { name: "up" } }] }), "two types");
			// A value whose references loop is refused, as any value nested past the limit is.
			expectFalse(isDirectory(directory), "two types that point back at each other in the value as well");
			expectFalse(
				isDirectory({ name: "root", files: [{ name: "a", parent: { name: 1 } }] }),
				"a bad directory reached through an entry",
			);
		},
	],
	[
		"serializes a recursive type checked by a guard as a union member",
		() => {
			const serializer = Flamework.createSerializer<Tree | Map<string, number>>();

			const tree: Tree = { value: 1, kids: [leaf(2), { value: 3, kids: [leaf(4)] }] };
			const [payload, blobs] = serializer.serialize(tree);
			const back = serializer.deserialize(payload, blobs) as Tree;
			expectEqual(back.kids[1].kids[0].value, 4, "the tree, read back");

			const map = new Map([["a", 1]]);
			const [mapPayload, mapBlobs] = serializer.serialize(map);
			const backMap = serializer.deserialize(mapPayload, mapBlobs) as Map<string, number>;
			expectEqual(backMap.get("a"), 1, "the map, read back");
		},
	],
	[
		"drops an incoming event whose recursive argument fails its guard deep inside",
		() => {
			if (RunService.IsServer()) {
				const received = new Array<Tree>();
				const server = RecursiveEvents.createServer({ warnOnInvalidGuards: false });
				server.recursiveTree.connect((_player, tree) => received.push(tree));
				server.recursiveRawTree.connect((_player, tree) => received.push(tree));
				__harness.flush();

				const player = __harness.newPlayer("RecursiveSender");
				const packed = (
					expectDefined(__harness.findRemote("recursiveTree"), "recursiveTree remote") as unknown as {
						OnServerEvent: Fire;
					}
				).OnServerEvent;
				const raw = (
					expectDefined(__harness.findRemote("recursiveRawTree"), "recursiveRawTree remote") as unknown as {
						OnServerEvent: Fire;
					}
				).OnServerEvent;

				packed.Fire(player, ...onWire(treeWire, deepTree(30)));
				expectEqual(received.size(), 1, "a valid tree, as the project sends it");

				packed.Fire(player, ...onWire(treeWire, deepTree(LIMIT + 2)));
				expectEqual(received.size(), 1, "a tree deeper than the limit, as the project sends it");

				raw.Fire(player, deepTree(30));
				expectEqual(received.size(), 2, "a valid tree, as it is");

				const bad = deepTree(30);
				(bottom(bad) as { value: unknown }).value = "bad";
				raw.Fire(player, bad);
				expectEqual(received.size(), 2, "a tree with a bad leaf deep inside");

				const cyclic = leaf(1);
				cyclic.kids.push(cyclic);
				raw.Fire(player, cyclic);
				expectEqual(received.size(), 2, "a tree that contains itself");

				raw.Fire(player, deepTree(100000));
				expectEqual(received.size(), 2, "a tree 100,000 levels deep");
			} else {
				primeRemotes();
				const received = new Array<Json>();
				const client = RecursiveEvents.createClient({ warnOnInvalidGuards: false });
				client.recursiveJson.connect((value) => received.push(value));
				__harness.flush();

				const remote = (
					expectDefined(__harness.findRemote("recursiveJson"), "recursiveJson remote") as unknown as {
						OnClientEvent: Fire;
					}
				).OnClientEvent;

				remote.Fire(...onWire(jsonWire, { a: [1, { b: ["c"] }] }));
				expectEqual(received.size(), 1, "a valid JSON-like value");
			}
		},
	],
	[
		"checks a large valid tree whole, with no limit on its size",
		() => {
			const isTree = Flamework.createGuard<Tree>();

			// 120,121 nodes, 999 levels deep.
			const tree = wideTree(LIMIT - 1, 120);
			expectTrue(isTree(tree), "a valid tree of 120,121 nodes");
			(bottom(tree) as { value: unknown }).value = "bad";
			expectFalse(isTree(tree), "the same tree with a bad leaf at the bottom");
		},
	],
	[
		"refuses a deep value of a recursive union quickly, trying each member on the same children once",
		() => {
			const isNode = Flamework.createGuard<Node>();
			const isEither = Flamework.createGuard<Either>();

			// Checked member by member, each level doubled the time: 20 levels took seconds, 40 would take weeks.
			for (const levels of [20, 40, 400]) {
				let result = true;
				const node = hostileNode(levels);
				const nodeTime = timed(() => (result = isNode(node)));
				expectFalse(result, `a Node ${levels} levels deep with no kind at the bottom`);
				expectTrue(nodeTime < QUICK, `refusing a Node ${levels} levels deep took ${nodeTime}s`);

				const valid = validNode(levels);
				const validTime = timed(() => (result = isNode(valid)));
				expectTrue(result, `a valid Node ${levels} levels deep`);
				expectTrue(validTime < QUICK, `accepting a Node ${levels} levels deep took ${validTime}s`);

				const either = hostileEither(levels);
				const eitherTime = timed(() => (result = isEither(either)));
				expectFalse(result, `an Either ${levels} levels deep with neither member at the bottom`);
				expectTrue(eitherTime < QUICK, `refusing an Either ${levels} levels deep took ${eitherTime}s`);
			}
		},
	],
	[
		"checks a value that holds the same table in many places once per table",
		() => {
			const isTree = Flamework.createGuard<Tree>();

			for (const levels of [22, 60]) {
				let result = false;
				const tree = diamond(levels);
				const time = timed(() => (result = isTree(tree)));
				expectTrue(result, `a tree of ${levels} levels, each holding the one below twice`);
				expectTrue(time < QUICK, `checking ${levels} levels holding the one below twice took ${time}s`);
			}
		},
	],
	[
		"continues the count of a check that a value's metatable starts the same guard inside",
		() => {
			const isChain = Flamework.createGuard<Chain>();

			/** A chain of `length` nodes whose every `every`th node reaches its next through `__index`, checking a chain of its own first. */
			const reentrant = (length: number, every: number) => {
				const root = deepChain(length);
				let node: Chain | undefined = root;
				for (let i = 1; node !== undefined; i++) {
					const rest: Chain | undefined = node.next;
					if (i % every === 0 && rest !== undefined) {
						node.next = undefined;
						setmetatable(node, {
							__index: (_self, key) => {
								if (key !== "next") return undefined;
								isChain({ value: 1, next: { value: 2 } });
								return rest;
							},
						});
					}
					node = rest;
				}

				return root;
			};

			// The inner check does not start the count again for the outer one: past the limit, refused.
			expectFalse(isChain(reentrant(1500, 500)), "a chain of 1,500 nodes started again in at 500 and 1,000");
			expectTrue(isChain(reentrant(LIMIT + 1, 300)), "a chain at the limit, started again in every 300 nodes");
			expectNoThrow(
				() => expectFalse(isChain(reentrant(60000, 900)), "a chain of 60,000 nodes started again in every 900"),
				"checking a chain started again in every 900 nodes",
			);
		},
	],
	[
		"starts the count again after a check that raised",
		() => {
			const isChain = Flamework.createGuard<Chain>();

			const raising = deepChain(800);
			let node = raising;
			while (node.next !== undefined) node = node.next;
			setmetatable(node, {
				__index: () => {
					throw "boom";
				},
			});
			const message = expectThrows(() => isChain(raising), "a check whose value raises 800 levels deep");
			expectTrue(message.find("boom")[0] !== undefined, `the value's own error, not '${message}'`);

			// The 799 levels the raising check had gone are not counted against the next one.
			expectTrue(isChain(deepChain(LIMIT + 1)), "a chain at the limit after a check that raised");
			expectFalse(isChain(deepChain(LIMIT + 2)), "a chain past the limit after a check that raised");
		},
	],
]);
