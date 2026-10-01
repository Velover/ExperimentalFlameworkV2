import { Serialization } from "@flamework-experimental/core";

/*
 * Types a game declares in a shared module of its own, as an outside project's were when the code
 * generated for them failed to compile: a readonly tuple, a library's action with an `arguments`
 * tuple, fields named after words no local can take. Declared here rather than next to the specs that
 * send them, because a name the sending file already uses would be renamed for us.
 */

export type GridCoord = readonly [x: Serialization.i16, y: Serialization.i16, z: Serialization.i16];

export interface Placement {
	readonly origin: GridCoord;
	readonly rotation: number;
	readonly name: string;
	readonly templateId: number;
}

/** A library's action (Reflex broadcasts one) with an `arguments` tuple. */
export interface Action {
	name: string;
	arguments: [value: number];
}

/** Fields no generated local can be named after, each read back into one: a one-element tuple. */
export interface Reserved {
	name: string;
	arguments: [value: number];
	eval: [value: number];
	class: [value: number];
	let: [value: number];
	yield: [value: number];
	await: [value: number];
	end: [value: number];
	local: [value: number];
	nil: [value: number];
	then: [value: number];
	self: [value: number];
	type: [value: number];
	game: [value: number];
	"1st": [value: number];
	"": [value: number];
	"two words": [value: number];
}

/** An outside project's ECS replication payload: a buffer and the blobs next to it. */
export type SerializedData = { buffer: buffer; blobs: defined[] };

/**
 * A named type with an array inside, whose code is shared: a hole's message starts from its name. The
 * array's type appears nowhere else, so it is written in the named type's own code.
 */
export interface Holder {
	label: string;
	list: boolean[];
}

export function reservedOf(base: number): Reserved {
	return {
		name: "reserved",
		arguments: [base],
		eval: [base + 1],
		class: [base + 2],
		let: [base + 3],
		yield: [base + 4],
		await: [base + 5],
		end: [base + 6],
		local: [base + 7],
		nil: [base + 8],
		then: [base + 9],
		self: [base + 10],
		type: [base + 11],
		game: [base + 12],
		"1st": [base + 13],
		"": [base + 14],
		"two words": [base + 15],
	};
}

/** Every field of a `Reserved`, in declaration order: `name=reserved,arguments=1,...`. */
export function describeReserved(value: Reserved) {
	const parts = [`name=${value.name}`];
	const keys: Array<Exclude<keyof Reserved, "name">> = [
		"arguments",
		"eval",
		"class",
		"let",
		"yield",
		"await",
		"end",
		"local",
		"nil",
		"then",
		"self",
		"type",
		"game",
		"1st",
		"",
		"two words",
	];
	for (const key of keys) parts.push(`${key}=${value[key][0]}`);
	return parts.join(",");
}
