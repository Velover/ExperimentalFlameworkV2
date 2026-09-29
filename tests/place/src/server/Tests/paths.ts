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
	requireModules,
	requireModulesInPath,
	resolveRbxPath,
} from "@flamework-experimental/core";
import {
	defer,
	defineTests,
	eventually,
	expectDefined,
	expectEqual,
	expectFalse,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { LogService, ServerScriptService, Workspace } from "@rbxts/services";
import { DiscoveryExported } from "server/Discovery/exported";
import { discoveryIds, makeDiscoveryLocal } from "server/Discovery/hidden";
import { deepIds } from "server/Discovery/nested/deep";
import { requiredLog } from "server/Fixtures/requiredLog";
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

/** The warnings this realm prints from now until the case ends. */
function watchWarnings() {
	const warnings = new Array<string>();
	const connection = LogService.MessageOut.Connect((message, kind) => {
		if (kind === Enum.MessageType.MessageWarning) warnings.push(message);
	});
	defer(() => connection.Disconnect());
	return warnings;
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
				// resolveRbxPath waits for each segment with no limit, since content may arrive late: a
				// segment that never appears waits forever. After five seconds it warns, naming the
				// call that gave the path (the case below), and the build warns where the path is used.
				let finished = false;
				task.spawn(() => {
					pcall(() => resolveRbxPath(["ServerScriptService", "TS", "NoSuchFolder"]));
					finished = true;
				});

				task.wait(0.5);
				expectTrue(!finished, "still waiting on a segment that will never arrive");
			});

			// A registration's folder is waited for without a limit, so that content still loading is
			// not a failure; once the wait is past five seconds it is warned about by the registration's
			// own name, where the engine's "Infinite yield possible" named neither the call nor the path.
			test("a registration whose folder is late warns once, naming itself, then registers from it", () => {
				const name = `FwLateFolder${math.random(1, 1e9)}`;
				const warnings = watchWarnings();
				const folder = new Instance("Folder");
				folder.Name = name;
				defer(() => folder.Destroy());
				task.delay(6.5, () => (folder.Parent = Workspace));

				const started = os.clock();
				// The path given by hand, as the transformer would give it for a folder at Workspace.<name>.
				const module = caseModule(
					Flamework.createModule()
						.registerProviders(`src/server/${name}`, undefined, ["Workspace", name] as never)
						.ignite(),
				);
				const waited = os.clock() - started;

				expectTrue(module.isIgnited(), "the registration finished once the folder arrived");
				expectTrue(waited >= 6, `it waited for the folder: ${waited}s`);
				const named = (message: string) => contains(message, `registerProviders("src/server/${name}")`);
				eventually(() => warnings.some(named), "the warning");
				const warning = warnings.find(named)!;
				expectTrue(
					contains(
						warning,
						`registerProviders("src/server/${name}") is still waiting for its folder: the build put it at Workspace/${name}, and Workspace has no child named '${name}' after 5 seconds.`,
					),
					warning,
				);
				expectTrue(contains(warning, "misspelled or differ in case"), warning);
				expectEqual(warnings.filter((message) => contains(message, name)).size(), 1, "warned once");
			});

			// Once per path, however many of its folders are late: the second one to arrive late is the
			// same wait, and a second warning would only repeat the first.
			test("a path whose folders arrive late one after another is warned about once", () => {
				const name = `FwLaterFolder${math.random(1, 1e9)}`;
				const warnings = watchWarnings();
				const outer = new Instance("Folder");
				outer.Name = name;
				defer(() => outer.Destroy());
				const inner = new Instance("Folder");
				inner.Name = "Inner";
				task.delay(6.5, () => (outer.Parent = Workspace));
				task.delay(13, () => (inner.Parent = outer));

				const started = os.clock();
				const classes = getClassesInPath(
					["Workspace", name, "Inner"],
					`registerProviders("src/server/${name}/Inner")`,
				);
				const waited = os.clock() - started;

				expectEqual(classes.size(), 0, "an empty folder holds no class");
				expectTrue(waited >= 12.5, `it waited for both folders: ${waited}s`);
				task.wait(0.5);
				// Flamework's own warnings only: the engine may add its "Infinite yield possible".
				const ours = warnings.filter(
					(message) => contains(message, name) && contains(message, "is still waiting for its folder"),
				);
				expectEqual(ours.size(), 1, `warned once: ${ours.join(" | ")}`);
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
			// silently left out every class a module did not export (36 components in one ported game). The
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

			// core's built-in macro for v1's `Flamework.addPaths` on a folder that holds no providers,
			// called from game code: the build turns the source path into the folder's Rojo path.
			// `src/server/Required` is in no registered folder, so nothing has required it before.
			test("requireModules requires every module under a folder once, and returns what they export", () => {
				const loaded = requireModules("src/server/Required");

				const ran = [...requiredLog].sort().join(", ");
				expectEqual(ran, "deep, first, silent", "every module ran once");
				expectEqual(loaded.size(), 2, "one value per module that exports something; silent exports nothing");
				expectTrue(
					loaded.some((value) => (value as { first?: string }).first === "first"),
					"the first module's exports",
				);
				expectTrue(
					loaded.some((value) => (value as { deep?: string }).deep === "deep"),
					"the nested module's exports",
				);

				// Through the module cache: a second call returns the same exports and runs nothing again.
				const again = requireModules("src/server/Required");
				expectEqual([...requiredLog].sort().join(", "), ran, "no module ran twice");
				expectTrue(
					again.size() === loaded.size() && again.every((value) => loaded.includes(value)),
					"the same exports",
				);
			});

			test("requireModules raises on a folder that is not in the place, naming the missing part", () => {
				const message = expectThrows(() => requireModules("src/server/NotInThePlace"), "a missing folder");
				expectTrue(
					contains(message, `requireModules("src/server/NotInThePlace"): the folder is not in the place`),
					message,
				);
				expectTrue(contains(message, "The build put it at ServerScriptService/TS/NotInThePlace"), message);
				expectTrue(contains(message, "ServerScriptService.TS has no child named 'NotInThePlace'"), message);
			});

			test("requireModules on a client folder says it is the client's, at once", () => {
				const started = os.clock();
				const message = expectThrows(() => requireModules("src/client/Core"), "a client folder");
				expectTrue(
					contains(
						message,
						`requireModules("src/client/Core"): the folder is in StarterPlayer/StarterPlayerScripts, which only a client requires from`,
					),
					message,
				);
				expectTrue(os.clock() - started < 1, "without waiting for the folder");
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
