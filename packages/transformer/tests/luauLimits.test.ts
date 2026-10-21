import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import { compileProbes, CompileResult } from "./compile";

const { measurePressure } = await import("../out/util/luauLimits.js");

// Luau refuses to load a function with more than 200 locals or 255 registers, a module's main chunk
// included, and roblox-ts does not check either: such a file builds, and fails when Roblox loads it.
// Each probe below holds more of something Flamework generates than a file could before it stopped
// loading, and is loaded the way Roblox loads it, with Lune's Luau compiler.

const LOADER = path.resolve(import.meta.dir, "luauLoad.luau");
const ENUMS = fs
	.readFileSync(
		path.resolve(import.meta.dir, "fixture/node_modules/@rbxts/types/include/generated/enums.d.ts"),
		"utf8",
	)
	.split(/\r?\n/)
	.map((line) => /^ {4}export namespace (\w+) \{/.exec(line)?.[1])
	.filter((name) => name !== undefined);

const core = `import { Flamework } from "@flamework-experimental/core";\n`;
const networking = `import { Networking } from "@flamework-experimental/networking";\n`;
const times = (count: number, item: (index: number) => string, separator = "\n") =>
	Array.from({ length: count }, (_, index) => item(index)).join(separator);
const fields = (count: number, type: (index: number) => string) => times(count, (i) => `\tf${i}: ${type(i)};`);
const all = (count: number, item: (index: number) => string) =>
	`export const all = [\n${times(count, (i) => `\t${item(i)},`)}\n];\n`;
// Enough serializers of enums to use up a file's budget of Flamework locals (16), so that what comes
// after them goes in the file's table.
const otherEnums = ENUMS.filter((name) => name !== "KeyCode");
const budgetUsed = times(24, (i) => `export const e${i} = Flamework.createSerializer<Enum.${otherEnums[i]}>();`);
const remoteFunction = `${networking}interface ServerFunctions { f(s: string): string }\ninterface ClientFunctions {}\nconst functions = Networking.createFunction<ServerFunctions, ClientFunctions>();\nconst client = functions.createClient({});\n`;
const declarations = (count: number) => times(count, (i) => `export const x${i} = [${i}];`);
// A serializer of `levels` levels of `level`, each holding the next, around `inner`.
const nested = (levels: number, level: (next: string) => string, inner = "string") => {
	let type = inner;
	for (let i = 0; i < levels; i++) type = level(type);
	return `${core}export const s = Flamework.createSerializer<${type}>();\n`;
};
const nest = (levels: number, inner = "string") => nested(levels, (next) => `{ a: string; b: ${next} }`, inner);
const lists = (levels: number, field = "boolean") => nested(levels, (next) => `{ a: ${field}; b: Array<${next}> }`);
const maps = (levels: number) => nested(levels, (next) => `{ a: boolean; b: Map<string, ${next}> }`);
const sets = (levels: number) => nested(levels, (next) => `Set<${next}>`);
const arrays = (levels: number, inner = "string") => nested(levels, (next) => `Array<${next}>`, inner);
// A function `go` of `parameters` that sends `body` through events of `members`. A send is packed where
// it is, among the locals of the user's function.
const sending = (members: string, parameters: string, body: string) =>
	`${networking}interface ServerEvents { ${members} }\ninterface ClientEvents {}\nconst events = Networking.createEvent<ServerEvents, ClientEvents>();\nexport const server = events.createServer({});\nconst client = events.createClient({});\nexport function go(${parameters}) {\n${body}\n}\n`;
const strings = (count: number) => times(count, (i) => `p${i}: string`, ", ");
const booleans = (count: number) => times(count, (i) => `b${i}: boolean`, ", ");
const stringEvents =
	"one(s: string): void; three(a: string, b: string, c: string): void; four(a: string, b: string, c: string, d: string): void";
// `blocks` sends of four strings, each in an `if` of its own, and then `last`.
const sendsInBlocks = (parameters: number, blocks: number, last: string) =>
	sending(
		stringEvents,
		strings(parameters),
		`${times(blocks, (b) => `\tif (p${b} === "x") {\n\t\tclient.four.fire(p0, p1, p2, p${b});\n\t}`)}\n\t${last}`,
	);
// Ten sends of four strings in the function's body, and one of a string.
const sendsInBody = (parameters: number) =>
	sending(
		stringEvents,
		strings(parameters),
		`${times(10, (b) => `\tclient.four.fire(p0, p1, p2, p${b});`)}\n\tclient.one.fire(p${parameters - 1});`,
	);
// A remote function whose result is a `type`.
const replying = (type: string) =>
	`${networking}type R = ${type};\ninterface ServerFunctions { f(id: number): R }\ninterface ClientFunctions {}\nconst functions = Networking.createFunction<ServerFunctions, ClientFunctions>();\nconst server = functions.createServer({});\ndeclare const value: R;\nserver.f.setCallback(() => value);\n`;

const PROBES: Record<string, string> = {
	// About a hundred fields of a named type ran the type's read function out of locals.
	lluHoisted: `${core}interface Inner { s: string; n: number }\ninterface Big {\n${fields(120, () => "Inner")}\n}\nexport const s = Flamework.createSerializer<Big>();\n`,
	// About 65 string fields did, and about 150 the registers of its size function.
	lluStrings: `${core}interface Big {\n${fields(300, () => "string")}\n}\nexport const s = Flamework.createSerializer<Big>();\n`,
	// Objects written out inside one function keep every local of every one of them.
	lluNested: `${core}interface Big {\n${fields(30, (i) => `{ ${times(30, (j) => `g${i}_${j}: string;`, " ")} }`)}\n}\nexport const s = Flamework.createSerializer<Big>();\n`,
	// Two main-chunk locals per literal union: about a hundred in one file.
	lluLiterals: core + all(120, (i) => `Flamework.createSerializer<"a${i}" | "b${i}">()`),
	// One per enum table, and one per guard a union's member is told apart by.
	lluEnums: core + all(220, (i) => `Flamework.createSerializer<Enum.${ENUMS[i]}>()`),
	lluGuards: core + all(220, (i) => `Flamework.createSerializer<Array<{ f${i}: number }> | Map<string, number>>()`),
	// One local per recursive type in the function a guard is wrapped in.
	lluRecursive: `${core}${times(220, (i) => `interface R${i} { v: number; next?: R${i} }`)}\ninterface T { ${times(220, (i) => `r${i}: R${i};`, " ")} }\nexport const g = Flamework.createGuard<T>();\n`,
	// One main-chunk local per deduplicated guard.
	lluDedup: `${core}${times(220, (i) => `interface O${i} { x${i}: number }`)}\ninterface T { ${times(220, (i) => `a${i}: O${i}; b${i}: O${i}; c${i}: O${i};`, " ")} }\nexport const g = Flamework.createGuard<T>();\n`,
	// Two main-chunk locals per callback set at the top of a file, and four per string sent in a function.
	lluCallbacks: `${networking}interface ServerFunctions {\n${times(120, (i) => `\tf${i}(id: number): string;`)}\n}\ninterface ClientFunctions {}\nconst functions = Networking.createFunction<ServerFunctions, ClientFunctions>();\nconst server = functions.createServer({});\n${times(120, (i) => `server.f${i}.setCallback((player, id) => \`\${id}\`);`)}\n`,
	lluSends: `${networking}interface ServerEvents { e(s: string): void }\ninterface ClientEvents {}\nconst events = Networking.createEvent<ServerEvents, ClientEvents>();\nconst client = events.createClient({});\nexport function sendAll(s: string) {\n${times(80, () => "\tclient.e.fire(s);")}\n}\n${times(80, () => 'client.e.fire("top");')}\n`,
	// One main-chunk local per call site of a macro with \`Modding.Caller.Constant\` metadata.
	lluConstant: `import { plain } from "./constant";\nexport function invokeAll() {\n\treturn [${times(220, () => "plain()", ", ")}];\n}\n`,
	// Past the budget an enum's table is a field of the file's table, and a read of it took two of
	// roblox-ts's temporaries (the table and the index): a hundred enum fields in one object did not
	// load. Read into a list (a tuple's elements, a remote's arguments), even the local table took one.
	lluEnumFields: `${core}${budgetUsed}\ninterface Big {\n${fields(110, () => "Enum.KeyCode")}\n}\nexport const s = Flamework.createSerializer<Big>();\n`,
	lluEnumTuple: `${core}export const s = Flamework.createSerializer<[${times(110, () => "Enum.KeyCode", ", ")}]>();\n`,
	lluEnumArgs: `${networking}interface ServerEvents { e(${times(110, (i) => `a${i}: Enum.KeyCode`, ", ")}): void }\ninterface ClientEvents {}\nconst events = Networking.createEvent<ServerEvents, ClientEvents>();\nexport const server = events.createServer({});\nserver.e.connect((player, a0) => print(a0));\n`,
	// A boolean after a field of no fixed size took three temporaries, which the estimate did not see:
	// about seventy in one object, or a boolean at each of seventy levels of objects.
	lluBooleans: `${core}interface Big {\n\ts: string;\n${times(80, (i) => `\tb${i}: boolean;`)}\n}\nexport const s = Flamework.createSerializer<Big>();\n`,
	lluWideNest: `${core}export const s = Flamework.createSerializer<${"{ a: string; c: number; e: boolean; b: ".repeat(80)}string${" }".repeat(80)}>();\n`,
	// Past the budget a statement that declares what a call returns is wrapped in a function, which
	// returns the value to the declaration as written.
	lluDeclaring: `${remoteFunction}${times(6, (i) => `client.f.invoke("w${i}");`)}\nexport const invoked = client.f.invoke("invoked");\nexport const [first, second] = [client.f.invoke("first"), 2];\nlet reassigned = client.f.invoke("before");\nreassigned = client.f.invoke("after");\nexport const last = reassigned;\n`,
	// The ones below sit at the edges of the build errors further down, at Luau's own limits: they
	// build, and load. 200 top-level locals with Flamework's two: the import's (`TS` and
	// `Flamework`), 196 of the file's own, and one literal union's tables.
	lluAtLimit: `${core}${declarations(195)}\nexport const s = Flamework.createSerializer<"a" | "b">();\n`,
	// 99 levels of objects, two locals a level in the function that writes them: 199 locals, which
	// the estimate counts exactly.
	lluDeepest: nest(99),
	// Exactly Luau's 200 locals: 97 levels of objects around a list of strings.
	lluAtLocalLimit: nest(97, "Array<string>"),
	// Exactly its 255 registers: 35 levels of sets, each counted into a `_size` of roblox-ts's in a
	// loop (which loaded on f773f52 too).
	lluSetsDeepest: sets(35),
	// A loop's own registers are not locals. Counted as locals, they had nests of lists and of maps
	// that loaded on f773f52 refused; and built one field at a time, a nest of lists keeps a running
	// size a level more, past what loads, so it stays as it was. The estimate counts these exactly:
	// 34 levels of lists loaded on f773f52, and 35 are the most that load (253 registers); of lists of
	// strings, which are built one field at a time, 31 (254).
	lluLists: lists(34),
	lluListsDeepest: lists(35),
	lluStringListsDeepest: lists(31, "string"),
	// 22 levels of maps loaded on f773f52; 24 are the most that load (197 locals).
	lluMaps: maps(22),
	lluMapsDeepest: maps(24),
	// A remote function's result is packed in a function of its own: the deepest of these that load.
	lluResultSets: replying(`${"Set<".repeat(35)}string${">".repeat(35)}`),
	lluResultLists: replying(`${"{ a: boolean; b: Array<".repeat(35)}string${"> }".repeat(35)}`),
	// A send's packing goes among the locals of the user's function, which it counts, its parameters
	// first: 194 and the plain packing's eight are past Luau's 200; built one field at a time, it takes
	// four.
	lluSendParams: sending(stringEvents, strings(194), "\tclient.three.fire(p0, p1, p193);"),
	// Past what is built compactly, a send of booleans or constants is no smaller built so: the plain
	// body is kept, and sends the payload it declares.
	lluSendKeptBooleans: sending(
		`bits(${booleans(160)}): void`,
		booleans(160),
		`\tclient.bits.fire(${times(160, (i) => `b${i}`, ", ")});`,
	),
	lluSendKeptConstants: sending(
		"flags(a: boolean, b: boolean, c: boolean, d: boolean): void",
		strings(160),
		"\tclient.flags.fire(true, false, true, false);",
	),
	// The locals of a send in a block that has ended are not live at the next send: each of these is
	// packed as it always was. Counted, they took the later sends of the function past what is built
	// compactly, and the last one of the second past Luau's limits by the estimate, which refused it.
	lluSendDeadClaims: sendsInBlocks(136, 16, "client.one.fire(p135);"),
	lluSendRefusedBefore: sendsInBlocks(150, 16, "client.one.fire(p149);"),
	// Those of a send in the function's body are, and the sends after it stop keeping theirs once the
	// function's locals reach what is built compactly: each goes in a block of its own. Kept, ten sends
	// took the second past Luau's 200.
	lluSendLiveClaims: sendsInBody(140),
	lluSendManyParams: sendsInBody(170),
};

let result: CompileResult;
let loads: Map<string, string>;

function lune(args: string[]) {
	const run = spawnSync("lune", ["run", LOADER, ...args], { encoding: "utf8", shell: true });
	if (run.error || run.status === null)
		throw new Error(`could not run lune (install it and put it on PATH): ${run.error}`);
	return `${run.stdout}${run.stderr}`;
}

beforeAll(() => {
	result = compileProbes(PROBES);
	if (result.status !== 0) throw new Error(`the probes failed to compile:\n${result.output}`);

	// The emitted files are removed with the probes, so they are loaded from a copy.
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flamework-luau-limits-"));
	try {
		const files = [...result.files].map(([name, luau]) => {
			const file = path.join(directory, `${name}.luau`);
			fs.writeFileSync(file, luau);
			return file;
		});
		loads = new Map();
		for (const line of lune(["load", ...files]).split(/\r?\n/)) {
			const match = /^(LOADS|FAILS) (.*?\.luau)(: .*)?$/.exec(line);
			if (match) loads.set(path.basename(match[2], ".luau"), `${match[1]}${match[3] ?? ""}`);
		}
		loads.set("lluStrings:roundtrip", lune(["strings", path.join(directory, "lluStrings.luau"), "300"]).trim());
		loads.set("lluNested:roundtrip", lune(["nested", path.join(directory, "lluNested.luau"), "30", "30"]).trim());
		loads.set("lluBooleans:roundtrip", lune(["booleans", path.join(directory, "lluBooleans.luau"), "80"]).trim());
		loads.set("lluDeclaring:exports", lune(["exports", path.join(directory, "lluDeclaring.luau")]).trim());
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 240000);

describe("generated code Luau loads", () => {
	for (const name of Object.keys(PROBES)) {
		test(name, () => {
			expect(loads.get(name)).toBe("LOADS");
		});
	}

	test("a type built compactly writes the bytes it always did, and reads back what was written", () => {
		expect(loads.get("lluStrings:roundtrip")).toStartWith("ROUNDTRIPS");
		expect(loads.get("lluNested:roundtrip")).toStartWith("ROUNDTRIPS");
		expect(loads.get("lluBooleans:roundtrip")).toStartWith("ROUNDTRIPS");
	});

	test("a statement past the budget that declares what a call returns keeps the value", () => {
		expect(loads.get("lluDeclaring:exports")?.split(/\r?\n/)).toEqual([
			"EXPORT first=first",
			"EXPORT invoked=invoked",
			"EXPORT last=after",
			"EXPORT second=2",
		]);
	});

	test("a send whose plain packing is kept sends the payload that packing declares", () => {
		for (const name of ["lluSendKeptBooleans", "lluSendKeptConstants"]) {
			const luau = result.files.get(name)!;
			const payload = /:_fire\((\w+)\)/.exec(luau)?.[1];
			expect(luau).toMatch(new RegExp(`local ${payload} = buffer\\.create\\(`));
		}
	});

	test("a send after sends in blocks that have ended is packed as it always was", () => {
		// Built one field at a time, each string is measured in a block of its own.
		expect(result.files.get("lluSendDeadClaims")).not.toMatch(/\bdo\s+local length_\d+ = #\w+\s+o_\d+ = vwrite/);
	});

	test("reads an enum's item by indexing its table, a local one and a field of the file's table", () => {
		// No temporaries of roblox-ts's, which a `Map`'s `get` took for its argument.
		expect(result.files.get("lluEnumTuple")).toMatch(/[^.\w]enum_KeyCode\[buffer\.readu16\(/);
		expect(result.files.get("lluEnumFields")).toMatch(/\(?codec\.enum_KeyCode\)?\[buffer\.readu16\(/);
	});

	test("adds a fixed number of main-chunk locals however many guards and tables a file holds", () => {
		for (const name of ["lluLiterals", "lluEnums", "lluGuards", "lluDedup", "lluCallbacks", "lluConstant"]) {
			const locals = result.files.get(name)!.match(/^local /gm)?.length ?? 0;
			expect(locals).toBeLessThan(30);
		}
	});
});

describe("a main chunk past Luau's 200 locals", () => {
	let output: string;

	beforeAll(() => {
		// rbxtsc colours its diagnostics.
		output = compileProbes({
			// One declaration more than `lluAtLimit` above: 201. Flamework's two go ahead of the statement
			// on line 198 that needs them.
			lluOver: `${core}${declarations(196)}\nexport const s = Flamework.createSerializer<"a" | "b">();\n`,
			// Past the limit without Flamework's code: not Flamework's to report.
			lluOwnOnly: declarations(201),
			// Under it with Flamework's code.
			lluUnder: `${core}${declarations(150)}\nexport const s = Flamework.createSerializer<"a" | "b">();\n`,
			// A type no function can hold, built one field at a time or not: one level more than
			// `lluDeepest`, 201 locals, one past Luau's limit.
			lluPastLimit: nest(100),
			// 256 registers, one past it: 41 levels of lists around an optional string.
			lluPastRegisterLimit: arrays(41, "string | undefined"),
			// The first levels of lists, maps and sets that do not load, one past the deepest above. A
			// set's count is a temporary of roblox-ts's: counted as none, 36 levels would build.
			lluListsOver: lists(36),
			lluStringListsOver: lists(32, "string"),
			lluMapsOver: maps(25),
			lluSetsOver: sets(36),
			// A send is never refused: its estimate counts the user's function, whose temporaries it
			// cannot all see. 200 parameters are Luau's limit already.
			lluSendPastLimits: sending(stringEvents, strings(200), "\tclient.three.fire(p0, p1, p199);"),
		}).output.replace(/\x1b\[[0-9;]*m/g, "");
	}, 240000);

	test("is a build error where the file passes it, its imports counted", () => {
		expect(output).toMatch(
			/lluOver\.ts:198:1 - error.*This file declares at least 201 locals at its top level, 2 of them in code Flamework generated/,
		);
	});

	test("is left alone when the file's own declarations pass it, and not reported below it", () => {
		expect(output).not.toMatch(/lluOwnOnly\.ts.*error/);
		expect(output).not.toMatch(/lluUnder\.ts.*error/);
	});

	test("refuses a type whose code no function can hold", () => {
		for (const name of ["lluListsOver", "lluStringListsOver", "lluMapsOver", "lluSetsOver"]) {
			expect(output).toMatch(
				new RegExp(
					`${name}\\.ts.*error.*built one field at a time or not, past Luau's limit of 200 locals / 255 registers`,
				),
			);
		}
		expect(output).toMatch(/lluSetsOver\.ts.*error.*needs about 114 locals and 262 registers/);
		expect(output).toMatch(/lluSetsOver\.ts.*error.*Split the type into smaller named types/);
	});

	test("never refuses a send", () => {
		expect(output).not.toMatch(/lluSendPastLimits\.ts.*error/);
	});

	test("refuses a type one past Luau's limits, with the numbers of the form it would keep", () => {
		expect(output).toMatch(/lluPastLimit\.ts.*error.*needs about 201 locals and 204 registers/);
		expect(output).toMatch(/lluPastRegisterLimit\.ts.*error.*needs about 171 locals and 256 registers/);
	});
});

describe("the estimate of a function's locals and registers", () => {
	// Generated code's shapes as written, against what Luau's compiler takes for roblox-ts's output
	// of each: a set's count is a temporary of roblox-ts's (`_size`) and a loop of five registers
	// above it; a boolean's test of a field takes a register of its own above the value's.
	const measure = (body: string, parameters: string[]) =>
		measurePressure(ts.createSourceFile("body.ts", body, ts.ScriptTarget.Latest, true).statements, parameters);

	test("counts what Luau takes for a set's write", () => {
		const body = [
			"const n = (v as Set<defined>).size();",
			"const buf = buffer.create(n);",
			"let o = 0;",
			"for (const item of v as Set<defined>) {",
			"\tbuffer.writeu8(buf, o, (item as string).size());",
			"\to += 1;",
			"}",
			"return buf;",
		].join("\n");
		expect(measure(body, ["v"])).toEqual({ locals: 6, registers: 14 });
	});

	test("counts what Luau takes for a boolean's write", () => {
		const body = "buffer.writeu8(buf, 0, ((v as { [key: string]: unknown }).f0 as boolean) ? 1 : 0);\nreturn buf;";
		expect(measure(body, ["v", "buf"])).toEqual({ locals: 2, registers: 7 });
	});
});
