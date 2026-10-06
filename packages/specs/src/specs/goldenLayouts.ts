import { RunService } from "@rbxts/services";
import { networkCases, NetworkCase, plainPacked, serializerCases, SerializerCase } from "../golden/layouts";
import { fail, suite } from "../testkit";

/*
 * Golden layouts: the bytes `Flamework.createSerializer` and the packed networking members write for
 * every sample of `golden/layouts.ts`, against the ones committed in packages/specs/golden. Games
 * store createSerializer buffers in DataStores, so a layout must never change by accident: any change
 * fails here, naming the type and the value, with both hex strings. Every golden is also read back
 * and must give its sample again, which is what a buffer stored by an earlier build needs.
 *
 * `bun run test:runtime --update-golden` rewrites the files (the runner hands its runs
 * UPDATE_GOLDEN=1, which `__harness.golden.updating` reads): the Server run writes them and the
 * Client run checks what it wrote. That is for a deliberate change only, which the CHANGELOG's
 * upgrade notes then name.
 */

declare const __harness: {
	golden: {
		updating: boolean;
		read: (name: string) => string | undefined;
		write: (name: string, contents: string) => void;
	};
};

const SERIALIZER_FILE = "serializer.txt";
const NETWORKING_FILE = "networking.txt";

const HEADERS: Record<string, string[]> = {
	[SERIALIZER_FILE]: [
		"# Golden byte layouts: what Flamework.createSerializer writes for each sample value of",
		"# packages/specs/src/golden/layouts.ts, as hex, and the blob list next to it (each blob's typeof;",
		"# no list means the type has no blob slots). Checked, and read back, by the golden layouts spec of",
		"# the runtime suite. Never edit by hand: a deliberate layout change rewrites this file with",
		"# bun run test:runtime --update-golden and is named in the CHANGELOG's upgrade notes.",
		"#",
		"# <type> :: <sample> => <bytes>[ + blobs [<typeof>, ...]]",
	],
	[NETWORKING_FILE]: [
		"# Golden packed argument lists: what a remote carries for each send of",
		"# packages/specs/src/golden/layouts.ts -- an event's arguments, a function's request after its",
		"# id, a result after its id and status. Checked, and read back, by the golden layouts spec of the",
		"# runtime suite. Never edit by hand: a deliberate layout change rewrites this file with",
		"# bun run test:runtime --update-golden and is named in the CHANGELOG's upgrade notes.",
		"#",
		"# <member> :: <sample> => <bytes>[ + blobs [<typeof>, ...]] | nothing | raw <values>",
	],
};

const ADVICE =
	"A layout change breaks every buffer a game stored with Flamework.createSerializer, and the traffic " +
	"between builds of the two versions. If it is deliberate, rewrite the goldens with " +
	"bun run test:runtime --update-golden and add a CHANGELOG upgrade note that names what changed.";

const isServer = RunService.IsServer();

// --- text ----------------------------------------------------------------------------------------

function hex(payload: buffer): string {
	const length = buffer.len(payload);
	if (length === 0) return "empty";
	const parts = new Array<string>();
	for (const index of $range(0, length - 1)) parts.push("%02x".format(buffer.readu8(payload, index)));
	return parts.join("");
}

function fromHex(text: string): buffer {
	if (text === "empty") return buffer.create(0);
	if (text.size() % 2 !== 0 || text.match("^%x+$")[0] === undefined) fail(`'${text}' is not hex`);
	const result = buffer.create(text.size() / 2);
	for (const index of $range(0, text.size() / 2 - 1)) {
		buffer.writeu8(result, index, tonumber(text.sub(index * 2 + 1, index * 2 + 2), 16)!);
	}
	return result;
}

function blobKinds(blobs: Array<defined>): string {
	return `[${blobs.map((blob) => typeOf(blob)).join(", ")}]`;
}

/**
 * A value, briefly, for a failure message. With `bits`, each number is followed by its f64 bytes, and
 * a float datatype by its components' (see {@link showPair}).
 */
function show(value: unknown, depth = 0, bits = false): string {
	if (typeIs(value, "string")) return `"${value}"`;
	if (typeIs(value, "buffer")) return `buffer ${hex(value)}`;
	// `typeOf`, not `typeIs`, which roblox-ts makes Luau's `type`: an Instance or an EnumItem is a table there.
	if (typeOf(value) !== "table") {
		const numbers = !bits ? undefined : typeIs(value, "number") ? [value] : components(value);
		return numbers ? `${tostring(value)} (f64 ${numbers.map(f64Bytes).join(", ")})` : tostring(value);
	}
	if (depth > 2) return "{...}";
	const parts = new Array<string>();
	for (const [key, item] of value as Map<unknown, unknown>) {
		parts.push(`${show(key, depth + 1, bits)}: ${show(item, depth + 1, bits)}`);
	}
	parts.sort();
	return `{ ${parts.join(", ")} }`;
}

/** The first token of a golden line's value: its bytes. */
function bytesOf(value: string): string {
	return value.match("^(%S+)")[0] as string;
}

interface Golden {
	keys: string[];
	values: Map<string, string>;
}

function readGolden(file: string): Golden | undefined {
	const text = __harness.golden.read(file);
	if (text === undefined) return undefined;

	const golden: Golden = { keys: [], values: new Map() };
	for (const raw of text.split("\n")) {
		const line = raw.gsub("\r$", "")[0];
		if (line === "" || line.sub(1, 1) === "#") continue;
		const [key, value] = line.match("^(.*) => (.*)$");
		if (key === undefined || value === undefined) fail(`${file}: not a golden line: ${line}`);
		golden.keys.push(key as string);
		golden.values.set(key as string, value as string);
	}
	return golden;
}

interface Line {
	key: string;
	value: string;
}

function writeGolden(file: string, lines: Line[]) {
	const text = [...HEADERS[file], "", ...lines.map(({ key, value }) => `${key} => ${value}`), ""].join("\n");
	__harness.golden.write(file, text);
	print(`[golden] wrote packages/specs/golden/${file}: ${lines.size()} lines`);
}

/**
 * Compares what was written now with the goldens, every line, and fails naming each difference. A
 * key in `skipped` is a line this build cannot produce, which is left alone. With UPDATE_GOLDEN=1 the
 * Server run writes the file instead, and refuses, before either file is written, in a build that
 * does not pack the plain members: it would write serializer.txt and then fail on networking.txt.
 */
function check(file: string, lines: Line[], skipped: ReadonlySet<string>, failures: string[]) {
	const writing = __harness.golden.updating && isServer;
	if (writing && !plainPacked) {
		fail(
			"--update-golden needs a build with networking.serialization on: this one does not pack the plain " +
				"members, so neither golden file is written",
		);
	}

	if (failures.size() > 0) {
		fail(
			`${failures.size()} sample(s) of src/golden/layouts.ts could not be written or sent:\n${failures.join("\n")}`,
		);
	}

	const seen = new Set<string>();
	for (const { key } of lines) {
		if (seen.has(key)) fail(`two samples are named '${key}': give one of them another label`);
		seen.add(key);
	}

	if (writing) {
		writeGolden(file, lines);
		return;
	}

	const golden = readGolden(file);
	if (golden === undefined) {
		fail(`packages/specs/golden/${file} is missing: write it with bun run test:runtime --update-golden`);
	}

	const problems = new Array<string>();
	for (const { key, value } of lines) {
		const expected = golden.values.get(key);
		if (expected === undefined) {
			problems.push(`  new, not in the goldens: ${key}\n    now:    ${value}`);
		} else if (expected !== value) {
			problems.push(`  changed: ${key}\n    golden: ${expected}\n    now:    ${value}`);
		}
	}
	for (const key of golden.keys) {
		if (!seen.has(key) && !skipped.has(key)) {
			problems.push(`  gone, no sample makes it now: ${key}\n    golden: ${golden.values.get(key)}`);
		}
	}

	if (problems.size() > 0) {
		fail(
			`${problems.size()} golden layout(s) of packages/specs/golden/${file} differ:\n${problems.join("\n")}\n${ADVICE}`,
		);
	}
}

/** Fails listing every golden that no longer reads back as its sample. */
function report(file: string, problems: string[]) {
	if (problems.size() > 0) {
		fail(
			`${problems.size()} golden(s) of packages/specs/golden/${file} no longer read back as their sample:\n${problems.join("\n")}\n${ADVICE}`,
		);
	}
}

const numberBits = buffer.create(16);

/**
 * Whether two numbers are the same float, bit for bit: Luau's `==` takes -0 for 0, so a decoder
 * that lost the sign would read back as its sample, and never takes a NaN as itself.
 */
function sameNumber(a: number, b: number): boolean {
	buffer.writef64(numberBits, 0, a);
	buffer.writef64(numberBits, 8, b);
	return buffer.readstring(numberBits, 0, 8) === buffer.readstring(numberBits, 8, 8);
}

/** A number's f64 bytes as hex, in buffer order, as the goldens write them: `000000000000f87f` is NaN. */
function f64Bytes(value: number): string {
	const bytes = buffer.create(8);
	buffer.writef64(bytes, 0, value);
	return hex(bytes);
}

/**
 * The numbers a float datatype is written as, which `same` compares with `sameNumber`: a
 * datatype's `==` compares its components with Luau's, so it takes a -0 inside for 0 and refuses
 * a NaN inside, even against itself. `undefined` for any other value; the integer datatypes
 * (Vector3int16, Vector2int16, BrickColor) hold neither, and `==` is exact for them.
 */
function components(value: unknown): number[] | undefined {
	if (typeIs(value, "Vector3")) return [value.X, value.Y, value.Z];
	if (typeIs(value, "Vector2")) return [value.X, value.Y];
	if (typeIs(value, "Color3")) return [value.R, value.G, value.B];
	if (typeIs(value, "UDim")) return [value.Scale, value.Offset];
	if (typeIs(value, "UDim2")) return [value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset];
	if (typeIs(value, "NumberRange")) return [value.Min, value.Max];
	if (typeIs(value, "Rect")) return [value.Min.X, value.Min.Y, value.Max.X, value.Max.Y];
	if (typeIs(value, "CFrame")) return [...value.GetComponents()];
	return undefined;
}

/**
 * What was read back and the sample, for a failure message. Where `show` prints them alike, as it
 * does a NaN read with another payload or sign (`nan` against `nan`), each number's f64 bytes follow
 * it, which is where they differ.
 */
function showPair(read: unknown, sample: unknown): [string, string] {
	const [left, right] = [show(read), show(sample)];
	return left !== right ? [left, right] : [show(read, 0, true), show(sample, 0, true)];
}

/**
 * Deep equality for a sample and what was decoded: numbers bit for bit (-0 is not 0, NaN is
 * NaN), float datatypes by their components alike, buffers by content, a key the other table does
 * not hold found by value (a datatype key decodes as a new value).
 */
function same(a: unknown, b: unknown): boolean {
	if (typeIs(a, "number") && typeIs(b, "number")) return sameNumber(a, b);
	const numbers = components(a);
	if (numbers !== undefined) {
		const other = typeOf(b) === typeOf(a) ? components(b) : undefined;
		return (
			other !== undefined &&
			other.size() === numbers.size() &&
			numbers.every((value, index) => sameNumber(value, other[index]))
		);
	}
	if (a === b) return true;
	if (typeIs(a, "buffer") && typeIs(b, "buffer")) return buffer.tostring(a) === buffer.tostring(b);
	// Instances and EnumItems are equal only to themselves, which `===` tested.
	if (typeOf(a) !== "table" || typeOf(b) !== "table") return false;

	const left = a as Map<unknown, unknown>;
	const right = b as Map<unknown, unknown>;
	let count = 0;
	for (const [key, value] of left) {
		count++;
		if (right.has(key)) {
			if (!same(value, right.get(key))) return false;
			continue;
		}
		let matched = false;
		for (const [otherKey, otherValue] of right) {
			if (same(key, otherKey) && same(value, otherValue)) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return count === right.size();
}

// --- createSerializer ----------------------------------------------------------------------------

interface SerializedSample extends Line {
	case: SerializerCase;
	sample: unknown;
	blobs?: Array<defined>;
}

let serialized: { samples: SerializedSample[]; failures: string[] } | undefined;

/** Every sample, written now, and what raised for the ones that could not be. */
function serializeAll() {
	if (serialized !== undefined) return serialized;

	const samples = new Array<SerializedSample>();
	const failures = new Array<string>();
	for (const golden of serializerCases) {
		for (const [label, sample] of golden.samples) {
			const key = `${golden.type} :: ${label}`;
			const [ok, written] = pcall(() => {
				const [payload, blobs] = golden.serializer.serialize(sample);
				return { payload, blobs };
			});
			if (!ok) {
				failures.push(`  ${key}: ${tostring(written)}`);
				continue;
			}
			const { payload, blobs } = written as { payload: buffer; blobs?: Array<defined> };
			const value = blobs !== undefined ? `${hex(payload)} + blobs ${blobKinds(blobs)}` : hex(payload);
			samples.push({ key, value, case: golden, sample, blobs });
		}
	}

	serialized = { samples, failures };
	return serialized;
}

// --- networking ----------------------------------------------------------------------------------

interface SentSample extends Line {
	case: NetworkCase;
	args: unknown[];
}

let sent: { samples: SentSample[]; skipped: Set<string>; failures: string[] } | undefined;

/** What the remote carried, as a golden line's value. */
function describeArgs(args: unknown[]): string {
	if (args.size() === 0) return "nothing";
	const first = args[0];
	if (!typeIs(first, "buffer")) {
		const values = new Array<string>();
		for (const arg of args) values.push(show(arg));
		return `raw ${values.join(", ")}`;
	}

	let text = hex(first);
	for (const index of $range(1, args.size() - 1)) {
		const extra = args[index];
		text += typeIs(extra, "table") ? ` + blobs ${blobKinds(extra as Array<defined>)}` : ` + ${show(extra)}`;
	}
	return text;
}

/** Every networking sample, sent now; a plain member's are skipped in a build that does not pack them. */
function sendAll() {
	if (sent !== undefined) return sent;

	const samples = new Array<SentSample>();
	const skipped = new Set<string>();
	const failures = new Array<string>();
	for (const networkCase of networkCases) {
		const key = `${networkCase.member} :: ${networkCase.label}`;
		if (networkCase.plain && !plainPacked) {
			skipped.add(key);
			continue;
		}
		const [ok, args] = pcall(() => networkCase.send());
		if (!ok) {
			failures.push(`  ${key}: ${tostring(args)}`);
			continue;
		}
		samples.push({ key, value: describeArgs(args as unknown[]), case: networkCase, args: args as unknown[] });
	}

	sent = { samples, skipped, failures };
	return sent;
}

export = suite("golden layouts", [
	[
		"createSerializer writes every sample as the golden bytes",
		() => {
			const { samples, failures } = serializeAll();
			check(SERIALIZER_FILE, samples, new Set(), failures);
		},
	],
	[
		"createSerializer reads every golden back as its sample",
		() => {
			const golden = readGolden(SERIALIZER_FILE);
			if (golden === undefined) fail(`packages/specs/golden/${SERIALIZER_FILE} is missing`);

			const problems = new Array<string>();
			for (const entry of serializeAll().samples) {
				const { key, sample, blobs } = entry;
				const value = golden.values.get(key);
				// A sample with no golden line fails the spec above.
				if (value === undefined) continue;
				const payload = fromHex(bytesOf(value));
				const [ok, decoded] = pcall(() => entry.case.serializer.deserialize(payload, blobs));
				if (!ok) {
					problems.push(`  ${key}: raised ${tostring(decoded)}`);
				} else if (!same(decoded, sample)) {
					const [read, wanted] = showPair(decoded, sample);
					problems.push(`  ${key}: read ${read}, sample ${wanted}`);
				}
			}
			report(SERIALIZER_FILE, problems);
		},
	],
	[
		"packed networking members send every sample as the golden bytes",
		() => {
			const { samples, skipped, failures } = sendAll();
			check(NETWORKING_FILE, samples, skipped, failures);
		},
	],
	[
		"packed networking members read every golden back as its sample",
		() => {
			const golden = readGolden(NETWORKING_FILE);
			if (golden === undefined) fail(`packages/specs/golden/${NETWORKING_FILE} is missing`);

			const problems = new Array<string>();
			for (const { key, case: networkCase, args } of sendAll().samples) {
				const value = golden.values.get(key);
				if (value === undefined || networkCase.receive === undefined || value.sub(1, 4) === "raw ") continue;

				// The golden bytes, with this run's blob list where the golden has one.
				const delivered = new Array<defined>();
				if (value !== "nothing") {
					delivered.push(fromHex(bytesOf(value)));
					if (value.find(" + blobs ", 1, true)[0] !== undefined) delivered.push((args[1] ?? []) as defined);
				}
				const [ok, received] = pcall(() => networkCase.receive!(delivered));
				if (!ok) {
					problems.push(`  ${key}: raised ${tostring(received)}`);
				} else if (!same(received, networkCase.expected)) {
					const [got, wanted] = showPair(received, networkCase.expected);
					problems.push(`  ${key}: received ${got}, sent ${wanted}`);
				}
			}
			report(NETWORKING_FILE, problems);
		},
	],
]);
