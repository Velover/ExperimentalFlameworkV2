import { Flamework, Modding, OnStart, Provider, Reflect } from "@flamework-experimental/core";
import {
	defineTests,
	expectDefined,
	expectEqual,
	expectFalse,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { t } from "@rbxts/t";
import { FwTestService } from "server/Features/Testing/Services/FwTestService";

interface Shape {
	sides: number;
	name: string;
}

/** A callsite whose uuid has to be the same every time this function is called. */
function callsite(uuid?: Modding.Caller.Uuid) {
	return uuid as string;
}

@Provider({ activeIn: ["testing"] })
export class ModdingTests implements OnStart {
	onStart() {
		defineTests("modding", () => {
			test("a decorated class carries the identifier the transformer gave it", () => {
				const identifier = Reflect.getOwnMetadata<string>(FwTestService as unknown as object, "identifier");
				expectDefined(identifier, "FwTestService's identifier");
				expectTrue(identifier!.size() > 0, "it is a non-empty string");
			});

			test("a guard generated from a type accepts and rejects the right values", () => {
				const isShape = Flamework.createGuard<Shape>();
				expectTrue(isShape({ sides: 3, name: "triangle" }), "a matching object");
				expectFalse(isShape({ sides: "three", name: "triangle" }), "a wrong field type");
				expectFalse(isShape(undefined), "nothing at all");
				expectTrue(t.number(1), "the guard library itself is the real one");
			});

			test("a callsite uuid is stable across calls and differs between callsites", () => {
				const first = callsite();
				const second = callsite();
				const other = callsite();

				expectEqual(first, second, "the same callsite twice");
				expectTrue(other === first, "a third call at the same callsite");
			});

			test("metadata can be written, read, listed and deleted on a real class", () => {
				const target = {} as object;
				Reflect.defineMetadata(target, "flavour", "vanilla");
				expectEqual(Reflect.getOwnMetadata<string>(target, "flavour"), "vanilla", "the value read back");
				expectTrue(Reflect.getOwnMetadataKeys(target).includes("flavour"), "the key is listed");

				Reflect.deleteMetadata(target, "flavour");
				expectFalse(Reflect.hasOwnMetadata(target, "flavour"), "gone after deletion");
			});

			test("inherited metadata is found through the class hierarchy, own metadata is not", () => {
				class Base {}
				class Derived extends Base {}

				Reflect.defineMetadata(Base as unknown as object, "origin", "base");
				expectEqual(
					Reflect.getMetadata<string>(Derived as unknown as object, "origin"),
					"base",
					"walked up to the base",
				);
				expectFalse(Reflect.hasOwnMetadata(Derived as unknown as object, "origin"), "not its own");
			});
		});
	}
}
