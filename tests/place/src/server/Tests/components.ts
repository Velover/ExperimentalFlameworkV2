import { ComponentPlugin, Components } from "@flamework-experimental/components";
import { Flamework, Module, OnStart, Provider } from "@flamework-experimental/core";
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
import { DiscoveryExportedComponent } from "server/Discovery/exported";
import { discoveryIds } from "server/Discovery/hidden";
import { deepIds } from "server/Discovery/nested/deep";
import { FwTestPartComponent } from "server/Features/Testing/Components/FwTestPartComponent";
import { FW_TEST_TAG } from "shared/Features/Testing/FwTestConfig";
import {
	addCore,
	createComponentModule,
	ExplainedOwner,
	folder,
	folderIn,
	recordWarnings,
	Rig,
	settle,
	untilGone,
} from "shared/Tests/components";

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

/** A module of the case's own, extinguished once the case is over unless the case already did. */
function caseModule(module: Module) {
	defer(() => {
		if (module.isIgnited()) module.extinguish();
	});

	return module;
}

/** A folder in the case's scratch space carrying a tag. */
function taggedFolder(name: string, tag: string) {
	const folder = new Instance("Folder");
	folder.Name = name;
	folder.Parent = scratch();
	CollectionService.AddTag(folder, tag);
	return folder;
}

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
			// Guide 09 includes a `ComponentPlugin.fromPath` per folder in one module. Each plugin used
			// to build and provide a `Components` of its own under the one id, and the second raised
			// `provider ID was registered more than once` at ignition.
			test("several component plugins in one module share one Components", () => {
				@Provider()
				class ComponentsHolder {
					constructor(public readonly components: Components) {}
				}

				const definition = Flamework.createModule()
					.includePlugin(ComponentPlugin.fromPath("src/server/Discovery/nested"))
					.includePlugin(ComponentPlugin.fromGlob("src/server/Discovery/hid*.ts"))
					.includePlugin(ComponentPlugin.createPlugin().registerComponent(DiscoveryExportedComponent).build())
					.registerClassProvider(ComponentsHolder)
					.build();

				const module = caseModule(definition.ignite());
				const components = module.resolveDependency<Components>();
				expectEqual(
					module.resolveDependency<ComponentsHolder>().components,
					components,
					"the Components a provider is injected with",
				);

				// One from each plugin -- two of them classes their modules do not export.
				const deep = taggedFolder("SharedDeep", "DiscoveryDeep");
				const hidden = taggedFolder("SharedHidden", "DiscoveryHidden");
				const exported = taggedFolder("SharedExported", "DiscoveryExported");
				eventually(() => components.getComponent(deep, deepIds.component) !== undefined, "the path plugin's");
				eventually(
					() => components.getComponent(hidden, discoveryIds.component) !== undefined,
					"the glob plugin's",
				);
				eventually(
					() => components.getComponent<DiscoveryExportedComponent>(exported) !== undefined,
					"the built plugin's",
				);

				// Extinguishing takes every plugin's components down, and the definition ignites again.
				module.extinguish();
				expectEqual(components.getComponent(deep, deepIds.component), undefined, "once extinguished");
				expectEqual(components.getComponent(hidden, discoveryIds.component), undefined, "once extinguished");

				const again = caseModule(definition.ignite());
				const rebuilt = again.resolveDependency<Components>();
				expectTrue(rebuilt !== components, "a fresh Components for the second ignition");
				eventually(
					() => rebuilt.getComponent(deep, deepIds.component) !== undefined,
					"the path plugin's again",
				);
				eventually(
					() => rebuilt.getComponent<DiscoveryExportedComponent>(exported) !== undefined,
					"the built plugin's again",
				);
			});

			test("overlapping component plugins register a class they share once", () => {
				const module = caseModule(
					Flamework.createModule()
						.includePlugin(ComponentPlugin.fromPath("src/server/Discovery"))
						.includePlugin(ComponentPlugin.fromPath("src/server/Discovery/nested"))
						.ignite(),
				);
				const components = module.resolveDependency<Components>();

				const deep = taggedFolder("OverlapDeep", "DiscoveryDeep");
				eventually(() => components.getComponent(deep, deepIds.component) !== undefined, "the shared class");
				expectEqual(components.getAllComponents(deepIds.component).size(), 1, "built once");
			});

			test("a module that imports another keeps a Components of its own", () => {
				const imported = caseModule(
					Flamework.createModule()
						.includePlugin(ComponentPlugin.fromPath("src/server/Discovery/nested"))
						.ignite(),
				);
				const importing = caseModule(
					Flamework.createModule()
						.includePlugin(ComponentPlugin.fromGlob("src/server/Discovery/hid*.ts"))
						.ignite({ imports: [imported] }),
				);
				const plain = caseModule(Flamework.createModule().ignite({ imports: [imported] }));

				const importedComponents = imported.resolveDependency<Components>();
				expectTrue(importing.resolveDependency<Components>() !== importedComponents, "the importer's own");
				expectEqual(
					plain.resolveDependency<Components>(),
					importedComponents,
					"one with none resolves its import's",
				);
			});

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

			// The Lune `components` suite's one server's case, beside the rest of that suite in
			// `shared/Tests/components.ts`, whose components and helpers it uses.
			test("names the instance guard in the warning when the reading at the flip is what holds a component down", () => {
				// Contextual streaming on a server reads the tree once: the child moving away is not
				// polled, so only the reading the flip to qualified is gated on sees that it is gone. A
				// client watches the guard's tree instead, so no single reading holds the component down
				// there, which is why the case is the server's alone.
				const components = createComponentModule();
				const warnings = recordWarnings();

				const instance = folder("GatedExplained");
				const elsewhere = folder("GatedElsewhere");
				const core = addCore(instance);
				folderIn(core, "Root");
				CollectionService.AddTag(core, "Rig");
				CollectionService.AddTag(instance, "ExplainedOwner");
				expectDefined(components.getComponent<ExplainedOwner>(instance), "component");
				settle();

				// The removal is announced on a deferred signal, which is when the owner comes down.
				warnings.clear();
				components.removeComponent<Rig>(core);
				untilGone(
					() => components.getComponents<ExplainedOwner>(instance)[0],
					"the component after its linked component was removed",
				);
				expectEqual(
					components.getComponent<ExplainedOwner>(instance),
					undefined,
					"component asked for after its linked component was removed",
				);

				core.Parent = elsewhere;
				expectDefined(components.getComponent<Rig>(core), "the linked component rebuilt elsewhere");
				expectEqual(
					components.getComponent<ExplainedOwner>(instance),
					undefined,
					"component while its tree is short of Core",
				);

				// Nothing recorded the guard failing, so the warning reads it the way the gate did.
				task.wait(0.3);
				expectTrue(
					warnings.mentions("instance guard (child 'Core' is missing"),
					`warnings: ${warnings.describe()}`,
				);
			});
		});
	}
}
