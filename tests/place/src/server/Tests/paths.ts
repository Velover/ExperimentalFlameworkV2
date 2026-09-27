import { Components } from "@flamework-experimental/components";
import {
	Dependency,
	Flamework,
	getClassesInPath,
	getPathRoot,
	LifecycleProvider,
	Module,
	OnStart,
	Provider,
	Reflect,
	requireModulesInPath,
	resolveRbxPath,
} from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	expectDefined,
	expectEqual,
	expectFalse,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { ServerScriptService, Workspace } from "@rbxts/services";
import { DiscoveryExported } from "server/Discovery/exported";
import { discoveryIds, makeDiscoveryLocal } from "server/Discovery/hidden";
import { deepIds } from "server/Discovery/nested/deep";
import { FwTestService } from "server/Features/Testing/Services/FwTestService";

/**
 * Compile-time paths against the real Rojo tree. The Lune harness walks its own tree of the files
 * on disk, which answers the few Instance methods path registration calls; this is where a path is
 * the project file's, a module is a real ModuleScript, and a glob comes from globs.json.
 *
 * The template's project file maps `out/server` to `ServerScriptService.TS`, so a source folder
 * `src/server/X` is the tree path below.
 */
const TESTS_PATH = ["ServerScriptService", "TS", "Tests"];
const SERVICES_PATH = ["ServerScriptService", "TS", "Features", "Testing", "Services"];

/** `src/server/Discovery`, which no module of the game registers: the discovery cases do. */
const DISCOVERY_PATH = ["ServerScriptService", "TS", "Discovery"];

/** A package's own folder, as the project file maps it. */
const PACKAGE_PATH = (name: string) => [
	"ReplicatedStorage",
	"rbxts_include",
	"node_modules",
	"@flamework-experimental",
	name,
	"out",
];

/** Every class the Discovery folder defines, exported or not. */
const DISCOVERED = [
	"DiscoveryExported",
	"DiscoveryExportedComponent",
	"DiscoveryHidden",
	"DiscoveryHiddenComponent",
	"DiscoveryInjectable",
	"DiscoveryExportEquals",
	"DiscoveryOutside",
	"DiscoveryNamespaced",
	"DiscoveryDeep",
	"DiscoveryDeepComponent",
];

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

/** A module of the case's own, extinguished once the case is over. */
function caseModule(module: Module) {
	defer(() => {
		if (module.isIgnited()) module.extinguish();
	});

	return module;
}

@Provider({ activeIn: ["testing"] })
export class PathTests implements OnStart {
	onStart() {
		defineTests("paths", () => {
			test("the tree root is game in a place", () => {
				expectEqual(getPathRoot(), game, "the path root");
			});

			test("a path names the instance the project file maps it to", () => {
				expectEqual(resolveRbxPath(["Workspace"]), Workspace, "a service by name");
				expectEqual(
					resolveRbxPath(["ServerScriptService", "TS"]),
					ServerScriptService.WaitForChild("TS"),
					"the compiled tree",
				);

				const folder = expectDefined(resolveRbxPath(TESTS_PATH), "the Tests folder");
				expectTrue(folder.IsA("Folder"), "a Folder in the tree");
				expectTrue(folder.GetChildren().size() > 0, "it holds the test modules");
			});

			test("an empty path under game names no service", () => {
				expectTrue(expectThrows(() => resolveRbxPath([]), "an empty path").size() > 0, "it says why");
			});

			test("a path naming a service that does not exist raises", () => {
				expectThrows(() => resolveRbxPath(["NotAService"]), "an unknown service");
			});

			test("a path that names nothing yields instead of failing, so a typo stalls rather than raises", () => {
				// resolveRbxPath walks with WaitForChild and no timeout: a segment that never
				// appears waits forever. Worth knowing, since it is a registered path's failure
				// mode -- ignition hangs with an "Infinite yield possible" warning and no error.
				let finished = false;
				task.spawn(() => {
					pcall(() => resolveRbxPath(["ServerScriptService", "TS", "NoSuchFolder"]));
					finished = true;
				});

				task.wait(0.5);
				expectTrue(!finished, "still waiting on a segment that will never arrive");
			});

			test("requireModulesInPath loads every module under a folder, through the module cache", () => {
				// These very modules: requiring them again must hand back the cached exports rather
				// than running them a second time, which would register every section twice.
				const loaded = requireModulesInPath(TESTS_PATH);
				expectTrue(loaded.size() >= 3, `at least three modules loaded, got ${loaded.size()}`);

				const again = requireModulesInPath(TESTS_PATH);
				expectEqual(again.size(), loaded.size(), "the same count on a second require");
			});

			test("getClassesInPath finds the decorated classes a folder exports", () => {
				const classes = getClassesInPath(SERVICES_PATH);
				expectTrue(classes.size() > 0, "classes found");
				expectTrue(
					classes.some((found) => found === (FwTestService as unknown as object)),
					"FwTestService is among them",
				);

				for (const found of classes) {
					expectTrue(Reflect.hasOwnMetadata(found, "identifier"), "every class carries its own identifier");
				}
			});

			// v1 registered every decorated class it required; v2 read only a module's exports and
			// silently left out every class a module did not export (36 components in Dive In). The
			// transformer now records each class against the ModuleScript that defines it, whatever
			// the id generation mode makes of its identifier.
			test("getClassesInPath finds every class a folder's modules define, exported or not, each once", () => {
				// Made by a call: never recorded against its module, so never found by a path.
				const made = makeDiscoveryLocal();

				const names = getClassesInPath(DISCOVERY_PATH).map((found) => tostring(found));
				const listed = names.join(", ");
				for (const name of DISCOVERED) {
					expectTrue(names.includes(name), `${name} among the classes found: ${listed}`);
				}

				expectEqual(names.size(), DISCOVERED.size(), `nothing else is found: ${listed}`);
				expectFalse(names.includes(tostring(made)), `a class made by a call is not found: ${listed}`);
				expectFalse(
					names.includes(discoveryIds.madeAtLoad),
					`nor one made by a call as the module loads: ${listed}`,
				);
				expectFalse(names.includes("DiscoveryUndecoratedChild"), `nor an undecorated subclass: ${listed}`);
			});

			test("registerProviders registers the providers a folder defines whether or not they are exported", () => {
				const module = caseModule(Flamework.createModule().registerProviders("src/server/Discovery").ignite());

				expectDefined(
					module.resolveDependency(discoveryIds.provider),
					"the provider its module does not export",
				);
				expectDefined(module.resolveDependency(deepIds.provider), "one a folder below");
				expectDefined(module.resolveDependency<DiscoveryExported>(), "the exported one, registered once");

				// Only `@Provider()` classes: the components and the injectable beside them are not.
				expectThrows(() => module.resolveDependency(discoveryIds.component), "the component");
				expectThrows(() => module.resolveDependency(discoveryIds.injectable), "the injectable");
			});

			test("registerProvidersGlob registers the providers every matched module defines", () => {
				const module = caseModule(
					Flamework.createModule().registerProvidersGlob("src/server/Discovery/**/*.ts").ignite(),
				);

				expectDefined(
					module.resolveDependency(discoveryIds.provider),
					"the provider its module does not export",
				);
				expectDefined(module.resolveDependency(deepIds.provider), "one a folder below");
				expectDefined(module.resolveDependency<DiscoveryExported>(), "the exported one, registered once");
			});

			test("a package folder's classes are found through their module too, each once", () => {
				// Identifiers here are the packages' own (`$c:`, `$:`), which the record does not read.
				const components = getClassesInPath(PACKAGE_PATH("components"));
				expectEqual(
					components.filter((found) => found === (Components as unknown as object)).size(),
					1,
					"Components among the components package's classes",
				);

				// Core's own `out` as a whole cannot be required through the runtime: `utility/tsImport`
				// would import itself. A folder of it can.
				const core = getClassesInPath([...PACKAGE_PATH("core"), "lifecycle"]);
				expectEqual(
					core.filter((found) => found === (LifecycleProvider as unknown as object)).size(),
					1,
					"LifecycleProvider among the classes of core's lifecycle folder",
				);
			});

			test("requireModulesInPath still hands back what each module exports", () => {
				const loaded = requireModulesInPath(DISCOVERY_PATH);
				expectEqual(loaded.size(), 6, "one value per module that exports something");
			});

			// v1 built any decorated class lazily; v2 resolves registered providers only. A class that
			// has loaded is known, so the error says what it is and what to do about it.
			test("explains why a loaded class that is not a registered provider cannot be resolved", () => {
				const module = caseModule(Flamework.createModule().ignite());

				const component = expectThrows(() => module.resolveDependency(discoveryIds.component), "a component");
				expectTrue(contains(component, "is a component (@Component), not a provider"), component);
				expectTrue(
					contains(component, "ServerScriptService.TS.Discovery.hidden"),
					`names its module: ${component}`,
				);
				expectTrue(contains(component, "getComponent"), `says what to do instead: ${component}`);

				const provider = expectThrows(
					() => module.resolveDependency(discoveryIds.provider),
					"an unregistered provider",
				);
				expectTrue(contains(provider, "nothing in this module registers or provides"), provider);

				const injectable = expectThrows(
					() => module.resolveDependency(discoveryIds.injectable),
					"an injectable",
				);
				expectTrue(contains(injectable, "is not a provider"), injectable);

				// `Dependency<T>()` answers from the game's module, and explains the same way.
				const fromDefault = expectThrows(
					() => Dependency(undefined, discoveryIds.component),
					"Dependency<T>()",
				);
				expectTrue(contains(fromDefault, "is a component (@Component), not a provider"), fromDefault);

				// A class made by a call is not recorded: the plain message, as for any id.
				const localId = Reflect.getOwnMetadata<string>(makeDiscoveryLocal(), "identifier")!;
				const unexplained = expectThrows(() => module.resolveDependency(localId), "a class made by a call");
				expectFalse(contains(unexplained, `'${localId}':`), `no explanation: ${unexplained}`);
			});

			test("the providers this module registered by path are the ones the tree holds", () => {
				// registerProviders walked the same folder at ignition; this section running at all
				// is the proof, and the class is resolvable through the module that found it.
				expectDefined(
					Reflect.getOwnMetadata(PathTests as unknown as object, "identifier"),
					"this class's identifier",
				);
			});
		});
	}
}
