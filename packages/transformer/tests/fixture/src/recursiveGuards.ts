import { BaseComponent, Component } from "@flamework-experimental/components";
import { Flamework } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

/*
 * Recursive types, whose guards call themselves: each of these stopped the build with "Maximum call
 * stack size exceeded" in 2.0.0-alpha.8.
 */

export interface Tree {
	value: number;
	kids: Tree[];
}

/** The same shape through an alias. */
export type AliasTree = { value: number; kids: AliasTree[] };

/** Recursion through a union, an array and an index signature. */
export type Json = string | number | boolean | Json[] | { [key: string]: Json };

/** Recursion through a Map. */
export interface Menu {
	label: string;
	items: Map<string, Menu>;
}

/** Recursion through an optional property. */
export interface Chain {
	value: number;
	next?: Chain;
}

/** Two types that reach each other. */
export interface Parent {
	name: string;
	child?: Child;
}

export interface Child {
	age: number;
	parent: Parent;
}

export const treeGuard = Flamework.createGuard<Tree>();
export const aliasTreeGuard = Flamework.createGuard<AliasTree>();
export const jsonGuard = Flamework.createGuard<Json>();
export const menuGuard = Flamework.createGuard<Menu>();
export const chainGuard = Flamework.createGuard<Chain>();
export const parentGuard = Flamework.createGuard<Parent>();
export const forestGuard = Flamework.createGuard<Tree[]>();

/** Past the fixture's dedup limit of 3: `Tree`'s guard is declared once, outside the guard that uses it. */
export const orchardGuard = Flamework.createGuard<{ a: Tree; b: Tree; c: Tree; chain: Chain }>();

/**
 * A type the dedup heuristic counts (`Leaf`, three times) inside one it does not look into (an
 * instance type's children). `Leaf` is reached first inside `Grove`'s guard, where it calls `Grove`,
 * so it stays in place there; the guard then declares it once for `a`, `b` and `c`.
 */
interface Grove extends Folder {
	Inner: Folder & { leaf: Leaf };
}

interface Leaf {
	grove?: Grove;
}

export const groveGuard = Flamework.createGuard<{ grove: Grove; a: Leaf; b: Leaf; c: Leaf }>();

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/**
 * 600 fields side by side, none inside another: the guard builder opens a frame for each and must
 * close it again, or it would take them for a type nested over 500 types deep and refuse the guard.
 */
export const wideGuard = Flamework.createGuard<{ [K in `f${"0" | "1" | "2" | "3" | "4" | "5"}${Digit}${Digit}`]: number }>();

/** A recursive type as a member of a union the serializer tells apart by a guard. */
export const treeOrMapSerializer = Flamework.createSerializer<Tree | Map<string, number>>();

interface RecursiveServerEvents {
	/** Packed by the project's switch. */
	plantTree(tree: Tree): void;
	rawTree: Networking.Raw<(tree: Tree) => void>;
	serializedTree: Networking.Serialized<(tree: Tree) => void>;
}

interface RecursiveClientEvents {
	sendJson(value: Json): void;
}

interface RecursiveServerFunctions {
	nextOf(chain: Chain): Chain;
}

interface RecursiveClientFunctions {}

export const recursiveEvents = Networking.createEvent<RecursiveServerEvents, RecursiveClientEvents>();
export const recursiveFunctions = Networking.createFunction<RecursiveServerFunctions, RecursiveClientFunctions>();
export const recursiveServer = recursiveEvents.createServer({});
export const recursiveClient = recursiveEvents.createClient({});
export const recursiveFunctionServer = recursiveFunctions.createServer({});
export const recursiveFunctionClient = recursiveFunctions.createClient({});

/** An instance type whose child may be another of itself, linked from an attribute. */
interface Branch extends Folder {
	Twig?: Branch;
}

@Component({ tag: "RecursiveLink" })
export class RecursiveLink extends BaseComponent<{ branch: Branch }> {}
