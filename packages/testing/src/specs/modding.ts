import { Flamework, Injectable, Modding, Reflect } from "@flamework/core";
import { expectArrayEqual, expectEqual, expectFalse, expectTrue, suite } from "../testkit";

/**
 * A macro of the spec's own. The caller metadata is only reachable through one, so these also cover
 * whether user-defined macros work outside of Flamework's own packages.
 *
 * @metadata macro
 */
function callsite(
	line?: Modding.Caller.Line,
	character?: Modding.Caller.Character,
	width?: Modding.Caller.Width,
	text?: Modding.Caller.Text,
	uuid?: Modding.Caller.Uuid,
) {
	return { line: line!, character: character!, width: width!, text: text!, uuid: uuid! };
}

/**
 * `Constant` metadata is generated once per callsite and shared by every invocation of it, which is
 * what makes it usable as a cache key.
 *
 * @metadata macro
 */
function constant(value?: Modding.Caller.Constant<{ marker: true }>) {
	return value!;
}

/** @metadata macro */
function typeText<T>(text?: Modding.Target.Text<T>) {
	return text!;
}

/** @metadata macro */
function tupleLabels<T extends readonly unknown[]>(labels?: Modding.Target.Labels<T>) {
	return labels ?? [];
}

interface Greeter {
	greet(): string;
}

@Injectable()
class Base {}

@Injectable()
class Derived extends Base {}

@Injectable()
class Speaker implements Greeter {
	public greet() {
		return "hello";
	}
}

export = suite("modding", [
	[
		"emits a runtime equivalent of a type",
		() => {
			const members = Modding.inspect<Array<"first" | "second">>();
			members.sort();
			expectArrayEqual(members, ["first", "second"], "union members");

			const object = Modding.inspect<{ label: "hello"; count: 3 }>();
			expectEqual(object.label, "hello", "object field");
			expectEqual(object.count, 3, "object field");

			const tuple = Modding.inspect<[1, "two", true]>();
			expectEqual(tuple[0], 1, "first tuple element");
			expectEqual(tuple[1], "two", "second tuple element");
			expectEqual(tuple[2], true, "third tuple element");
		},
	],
	[
		"generates a type id that matches the reflected identifier",
		() => {
			expectEqual(Flamework.id<Derived>(), Reflect.getMetadata<string>(Derived, "identifier"), "type id");
			expectTrue(Flamework.id<Derived>() !== Flamework.id<Base>(), "ids are per-type");
		},
	],
	[
		"generates a guard from a type",
		() => {
			const isPoint = Flamework.createGuard<{ x: number; y?: string }>();

			expectTrue(isPoint({ x: 1 }), "value satisfying the guard");
			expectTrue(isPoint({ x: 1, y: "a" }), "value with the optional field");
			expectFalse(isPoint({ x: "one" }), "value with the wrong field type");
			expectFalse(isPoint(undefined), "missing value");
		},
	],
	[
		"reports the source location of a macro callsite",
		() => {
			const here = callsite();

			// The line and character are emitted as numbers, so they are usable as such.
			expectTrue(typeIs(here.line, "number"), "line is a number");
			expectTrue(typeIs(here.character, "number"), "character is a number");
			expectTrue(here.line > 0, "line is one-based");
			expectEqual(here.text, "callsite()", "source text");
			expectEqual(here.width, here.text.size(), "expression width");
		},
	],
	[
		"gives every callsite its own stable uuid",
		() => {
			function first() {
				return callsite().uuid;
			}

			function second() {
				return callsite().uuid;
			}

			expectTrue(first().size() > 0, "uuid is populated");
			expectEqual(first(), first(), "one callsite keeps its uuid across invocations");
			expectTrue(first() !== second(), "distinct callsites get distinct uuids");
		},
	],
	[
		"shares constant metadata between invocations of one callsite",
		() => {
			function invoke() {
				return constant();
			}

			expectTrue(invoke() === invoke(), "the same callsite shares one table");
			expectTrue(invoke() !== constant(), "a different callsite gets its own table");
		},
	],
	[
		"renders a type as text",
		() => {
			expectEqual(typeText<string>(), "string", "primitive type text");
			expectEqual(typeText<Speaker>(), "Speaker", "class type text");
		},
	],
	[
		"extracts tuple labels",
		() => {
			expectArrayEqual(tupleLabels<[first: string, second: number]>(), ["first", "second"], "tuple labels");
		},
	],
	[
		// `implements` is a macro that rewrites to `Flamework._implements`, which reads the
		// `flamework:implements` metadata the transformer attaches to a decorated class.
		"identifies implemented interfaces",
		() => {
			expectTrue(Flamework.implements<Greeter>(new Speaker()), "class implementing the interface");
			expectFalse(Flamework.implements<Greeter>(new Base()), "class not implementing the interface");
		},
	],
	[
		"stores and reads own metadata",
		() => {
			const target = {};

			expectFalse(Reflect.hasOwnMetadata(target, "key"), "metadata before it is defined");

			Reflect.defineMetadata(target, "key", "value");
			expectEqual(Reflect.getOwnMetadata(target, "key"), "value", "metadata value");
			expectTrue(Reflect.hasOwnMetadata(target, "key"), "metadata after it is defined");

			Reflect.deleteMetadata(target, "key");
			expectFalse(Reflect.hasOwnMetadata(target, "key"), "metadata after deletion");
		},
	],
	[
		"defines metadata in batch and lists its keys",
		() => {
			const target = {};
			Reflect.defineMetadataBatch(target, { first: 1, second: 2 });

			const keys = Reflect.getOwnMetadataKeys(target);
			keys.sort();

			expectArrayEqual(keys, ["first", "second"], "metadata keys");
		},
	],
	[
		"walks the class hierarchy for inherited metadata",
		() => {
			class Parent {}
			class Child extends Parent {}

			Reflect.defineMetadata(Parent, "shared", "parent");
			Reflect.defineMetadata(Parent, "onlyParent", "parent");
			Reflect.defineMetadata(Child, "shared", "child");

			expectEqual(Reflect.getOwnMetadata(Child, "onlyParent"), undefined, "own metadata ignores the parent");
			expectEqual(Reflect.getMetadata(Child, "onlyParent"), "parent", "inherited metadata");
			expectEqual(Reflect.getMetadata(Child, "shared"), "child", "the child shadows the parent");
			expectTrue(Reflect.hasMetadata(Child, "onlyParent"), "inherited key is reported");

			// `getMetadatas` collects every value up the chain, nearest first.
			expectArrayEqual(Reflect.getMetadatas<string>(Child, "shared"), ["child", "parent"], "collected values");

			const keys = Reflect.getMetadataKeys(Child);
			keys.sort();
			expectArrayEqual(keys, ["onlyParent", "shared"], "inherited metadata keys");
		},
	],
	[
		"scopes metadata to a property",
		() => {
			class Owner {}
			class Heir extends Owner {}

			Reflect.defineMetadata(Owner, "kind", "field", "inherited");
			Reflect.defineMetadata(Heir, "kind", "field", "own");

			expectEqual(Reflect.getOwnMetadata(Heir, "kind", "own"), "field", "property-scoped metadata");
			expectEqual(Reflect.getOwnMetadata(Heir, "kind"), undefined, "unscoped metadata is separate");
			expectEqual(Reflect.getMetadata(Heir, "kind", "inherited"), "field", "inherited property metadata");

			expectArrayEqual(Reflect.getOwnProperties(Heir), ["own"], "own properties with metadata");

			const properties = Reflect.getProperties(Heir);
			properties.sort();
			expectArrayEqual(properties, ["inherited", "own"], "properties including inherited ones");
		},
	],
	[
		"drops every entry for an object when it is reset",
		() => {
			const target = {};
			Reflect.defineMetadata(target, "key", "value");

			Reflect.resetObject(target);

			expectFalse(Reflect.hasOwnMetadata(target, "key"), "metadata after reset");
			expectArrayEqual(Reflect.getOwnMetadataKeys(target), [], "metadata keys after reset");
		},
	],
]);
