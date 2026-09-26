import { Components } from "@flamework-experimental/components";
import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectDefined,
	expectEqual,
	expectThrows,
	expectTrue,
	scratch,
	test,
} from "@flamework-experimental/testing";
import { CollectionService, Workspace } from "@rbxts/services";
import { FwTestPartComponent } from "server/Features/Testing/Components/FwTestPartComponent";
import { FW_TEST_TAG } from "shared/Features/Testing/FwTestConfig";

/** How many components for an instance of this name have been torn down, from the component's log. */
function teardowns(name: string) {
	return FwTestPartComponent.log.filter((entry) => entry === `-${name}`).size();
}

/**
 * The component's log is static and outlives a run, and the bindable is meant to be invoked as
 * often as you like, so every part gets a name of its own: counting by name then measures this
 * run rather than every run since the server started.
 */
let nextPartId = 0;

function taggedPart(prefix: string) {
	nextPartId += 1;

	const part = new Instance("Part");
	part.Name = `${prefix}#${nextPartId}`;
	part.Anchored = true;
	part.Parent = scratch();
	CollectionService.AddTag(part, FW_TEST_TAG);
	return part;
}

/**
 * Components against the engine's own CollectionService, attributes and instance lifetime. A test
 * provider: registered only in a build where the `testing` scope is active, with the registry it
 * exercises injected like anywhere else.
 *
 * These cover what a stub cannot reproduce: tag signals arriving deferred, attributes coerced by
 * the engine, and a destroyed instance tearing its component down in the order a place does.
 */
@Provider({ activeIn: ["testing"] })
export class ComponentTests implements OnStart {
	constructor(private readonly components: Components) {}

	onStart() {
		defineTests("components", () => {
			test("a tagged part gets its component, which ticks", () => {
				const part = taggedPart("FwSectionPart");
				defer(() => CollectionService.RemoveTag(part, FW_TEST_TAG));

				let component: FwTestPartComponent | undefined;
				eventually(() => {
					component = this.components.getComponent<FwTestPartComponent>(part);
					return component !== undefined;
				}, "the component to be built");

				expectEqual(component!.attributes.Speed, 1, "the default attribute");
				expectTrue(component!.started, "its onStart ran");
				eventually(() => component!.ticks > 0, "onTick to fire");
			});

			test("a default attribute is written onto the instance itself", () => {
				const part = taggedPart("FwSectionDefaults");
				defer(() => CollectionService.RemoveTag(part, FW_TEST_TAG));

				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) !== undefined,
					"the component",
				);
				expectEqual(part.GetAttribute("Speed"), 1, "the engine holds the default");
			});

			test("onAttributeChanged sees the new and the old value", () => {
				const part = taggedPart("FwSectionAttribute");
				defer(() => CollectionService.RemoveTag(part, FW_TEST_TAG));

				let component: FwTestPartComponent | undefined;
				eventually(() => {
					component = this.components.getComponent<FwTestPartComponent>(part);
					return component !== undefined;
				}, "the component");

				component!.setSpeed(7);
				eventually(() => component!.changes.size() > 0, "the change to arrive");

				const [newValue, oldValue] = component!.changes[component!.changes.size() - 1];
				expectEqual(newValue, 7, "the new value");
				expectEqual(oldValue, 1, "the old value");
				expectEqual(part.GetAttribute("Speed"), 7, "written through to the instance");
			});

			test("an attribute the guard rejects is refused rather than stored", () => {
				const part = taggedPart("FwSectionGuard");
				defer(() => CollectionService.RemoveTag(part, FW_TEST_TAG));

				let component: FwTestPartComponent | undefined;
				eventually(() => {
					component = this.components.getComponent<FwTestPartComponent>(part);
					return component !== undefined;
				}, "the component");

				expectThrows(() => component!.misassign("fast"), "assigning a string to a number attribute");
			});

			test("an instance the guard refuses never gets the component", () => {
				// The component's instanceGuard is BasePart; a Folder carrying the tag is ignored.
				const folder = new Instance("Folder");
				folder.Name = "FwSectionWrongClass";
				folder.Parent = scratch();
				CollectionService.AddTag(folder, FW_TEST_TAG);
				defer(() => CollectionService.RemoveTag(folder, FW_TEST_TAG));

				task.wait(0.2);
				expectEqual(
					this.components.getComponent<FwTestPartComponent>(folder),
					undefined,
					"no component on an instance the guard refuses",
				);
			});

			test("getAllComponents lists every live component of the class", () => {
				const before = this.components.getAllComponents<FwTestPartComponent>().size();
				const first = taggedPart("FwSectionAllA");
				const second = taggedPart("FwSectionAllB");
				defer(() => {
					CollectionService.RemoveTag(first, FW_TEST_TAG);
					CollectionService.RemoveTag(second, FW_TEST_TAG);
				});

				eventually(
					() => this.components.getAllComponents<FwTestPartComponent>().size() >= before + 2,
					"both components to appear",
				);
			});

			test("a clone of a tagged part gets a component of its own", () => {
				const part = taggedPart("FwSectionClone");
				defer(() => CollectionService.RemoveTag(part, FW_TEST_TAG));
				eventually(() => this.components.getComponent<FwTestPartComponent>(part) !== undefined, "the original");

				const clone = part.Clone();
				clone.Name = `${part.Name}-clone`;
				clone.Parent = scratch();
				defer(() => CollectionService.RemoveTag(clone, FW_TEST_TAG));

				let cloned: FwTestPartComponent | undefined;
				eventually(() => {
					cloned = this.components.getComponent<FwTestPartComponent>(clone);
					return cloned !== undefined;
				}, "the clone's own component");

				expectTrue(
					cloned !== this.components.getComponent<FwTestPartComponent>(part),
					"two distinct components",
				);
			});

			test("removing the tag destroys exactly one component", () => {
				// Counted per instance rather than on the shared counter: tag signals are deferred,
				// so a cleanup from an earlier test can land in the middle of this one.
				const part = taggedPart("FwSectionDestroyed");
				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) !== undefined,
					"the component",
				);

				CollectionService.RemoveTag(part, FW_TEST_TAG);
				eventually(() => teardowns(part.Name) === 1, "one destruction");
				expectTrue(this.components.getComponent<FwTestPartComponent>(part) === undefined, "no component left");
				expectEqual(teardowns(part.Name), 1, "still exactly one, not a repeat");
			});

			test("destroying the instance takes its component with it", () => {
				const part = taggedPart("FwSectionDestroyInstance");
				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) !== undefined,
					"the component",
				);

				part.Destroy();
				task.wait(1);

				// Reported together: whether the registry let go, and whether the component's own
				// destroy ran. They are separate halves, and a divergence is the interesting case.
				const stillRegistered = this.components.getComponent<FwTestPartComponent>(part) !== undefined;
				const tornDown = teardowns(part.Name);
				expectTrue(
					!stillRegistered && tornDown === 1,
					`registry let go: ${!stillRegistered}, destroy() calls: ${tornDown}, still tagged: ${CollectionService.HasTag(part, FW_TEST_TAG)}`,
				);
			});

			test("unparenting a tagged instance takes its component too", () => {
				// The sibling of the case above: the engine announces the tag gone while the
				// instance still reads as in the tree, so this leaked the same way.
				const part = taggedPart("FwSectionUnparented");
				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) !== undefined,
					"the component",
				);

				part.Parent = undefined;
				defer(() => part.Destroy());

				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) === undefined,
					"the registry to let go once the instance left the tree",
				);
				expectEqual(teardowns(part.Name), 1, "its destroy ran exactly once");
			});

			test("a tag applied outside the DataModel announces nothing until the tree joins it", () => {
				const part = new Instance("Part");
				part.Name = "FwSectionOrphan";
				CollectionService.AddTag(part, FW_TEST_TAG);
				defer(() => {
					CollectionService.RemoveTag(part, FW_TEST_TAG);
					part.Destroy();
				});

				task.wait(0.2);
				expectEqual(
					this.components.getComponent<FwTestPartComponent>(part),
					undefined,
					"nothing is built for an instance the DataModel does not hold",
				);

				part.Parent = scratch();
				eventually(
					() => this.components.getComponent<FwTestPartComponent>(part) !== undefined,
					"the component once the instance joined the tree",
				);
			});

			test("the registry answers for an instance that never carried the tag", () => {
				const plain = new Instance("Part");
				plain.Parent = scratch();
				expectEqual(this.components.getComponent<FwTestPartComponent>(plain), undefined, "no component");
				expectDefined(Workspace, "the place is real");
			});
		});
	}
}
