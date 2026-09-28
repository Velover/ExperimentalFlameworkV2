import * as core from "@flamework-experimental/core";
import {
	Flamework,
	Reflect,
	getClassesInPath,
	requireModules,
	requireModulesInPath,
	resolveRbxPath,
} from "@flamework-experimental/core";
import { RunService } from "@rbxts/services";
import { ExportedProvider } from "../fixtures/discovery/exported";
import { hiddenIds, makeLocalProvider } from "../fixtures/discovery/hidden";
import { requiredLog } from "../fixtures/requiredLog";
import { expectDefined, expectEqual, expectFalse, expectThrows, expectTrue, suite } from "../testkit";

/** Internal and stripped from the package's types, so reached through a cast, as `ignite` is. */
const harness = core as unknown as { __setPathRoot: (root: Instance | undefined) => void };

/**
 * The harness's module graph is the files on disk, and each module's `script` is its node in it: the
 * specs package's `out` folder is two above this module. Path registration walks that tree the way
 * it walks a place's, from a root set here as a plugin's would be.
 */
const SPECS_OUT = (script.Parent as Instance).Parent as Instance;
const DISCOVERY = ["fixtures", "discovery"];

function underSpecs<T>(callback: () => T): T {
	harness.__setPathRoot(SPECS_OUT);
	try {
		return callback();
	} finally {
		harness.__setPathRoot(undefined);
	}
}

/**
 * The specs package's own node, the root of its Rojo project, which a path the transformer builds from
 * a source path (`requireModules("src/...")`) starts at: `{ "out", ... }`.
 */
function underPackage<T>(callback: () => T): T {
	harness.__setPathRoot(SPECS_OUT.Parent);
	try {
		return callback();
	} finally {
		harness.__setPathRoot(undefined);
	}
}

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

function folderIn(parent: Instance, name: string) {
	const instance = new Instance("Folder");
	instance.Name = name;
	instance.Parent = parent;
	return instance;
}

export = suite("paths", [
	[
		// A plugin's tree hangs off no service, so its paths are relative to its own root.
		"walks a root-relative path from the configured root",
		() => {
			const root = folderIn(game.Workspace, "PluginRoot");
			const out = folderIn(root, "out");
			const glob = folderIn(out, "glob");

			harness.__setPathRoot(root);
			try {
				expectTrue(resolveRbxPath(["out", "glob"]) === glob, "resolved under the root");
				expectTrue(resolveRbxPath([]) === root, "an empty path is the root itself");
			} finally {
				harness.__setPathRoot(undefined);
				root.Destroy();
			}
		},
	],
	[
		// With no metadata to climb from -- this harness has none -- the root is `game`.
		"answers a path under game from its service",
		() => {
			expectTrue(resolveRbxPath(["Workspace"]) === game.Workspace, "the service itself");

			const folder = folderIn(game.Workspace, "PathTarget");
			try {
				expectTrue(resolveRbxPath(["Workspace", "PathTarget"]) === folder, "a child of the service");
			} finally {
				folder.Destroy();
			}

			expectThrows(() => resolveRbxPath([]), "an empty path under game names no service");
		},
	],
	[
		// v1 registered every decorated class it required; v2 read only a module's exports, and
		// silently left out every class a module did not export. The transformer now records each
		// class against the ModuleScript that defined it.
		"finds every class the modules under a path define, exported or not, each once",
		() => {
			// Made by a call: never recorded against its module, so never found by a path.
			const made = makeLocalProvider();

			const names = underSpecs(() => getClassesInPath(DISCOVERY)).map((value) => tostring(value));
			const listed = names.join(", ");
			for (const name of [
				"ExportedProvider",
				"HiddenProvider",
				"HiddenComponent",
				"HiddenInjectable",
				"ExportEqualsProvider",
				"OutsideProvider",
				"NamespacedProvider",
				"DeepProvider",
			]) {
				expectTrue(names.includes(name), `${name} among the classes found: ${listed}`);
			}

			expectFalse(names.includes(tostring(made)), `a class made by a call is not found: ${listed}`);
			expectFalse(names.includes("UndecoratedChild"), `an undecorated subclass is not found: ${listed}`);
			expectEqual(new Set(names).size(), names.size(), `each class once: ${listed}`);
		},
	],
	[
		"registers the providers a folder defines whether or not they are exported, each once",
		() => {
			const module = underSpecs(() =>
				Flamework.createModule()
					.registerProviders("fixtures/discovery", undefined, DISCOVERY as never)
					.ignite(),
			);

			expectDefined(module.resolveDependency(hiddenIds.provider), "the provider its module does not export");
			expectDefined(module.resolveDependency<ExportedProvider>(), "the exported one");

			// Only `@Provider()` classes: the component and the injectable beside them are not.
			expectThrows(() => module.resolveDependency(hiddenIds.component), "the component");
			expectThrows(() => module.resolveDependency(hiddenIds.injectable), "the injectable");

			module.extinguish();
		},
	],
	[
		"requireModulesInPath still hands back what each module exports",
		() => {
			const loaded = underSpecs(() => requireModulesInPath(DISCOVERY));
			expectEqual(loaded.size(), 6, "one value per module that exports something");
			expectTrue(
				loaded.some((value) => (value as { ExportedProvider?: object }).ExportedProvider === ExportedProvider),
				"the exported module's exports",
			);
		},
	],
	[
		// core's built-in macro for v1's `Flamework.addPaths` on a folder that holds no providers. The
		// transformer turns the source path into the folder's Rojo path, as it does here.
		"requireModules requires every module under a folder once, and returns what they export",
		() => {
			const loaded = underPackage(() => requireModules("src/fixtures/required"));

			// In tree order: first, then nested/deep, then silent, which exports nothing.
			expectEqual(requiredLog.join(", "), "first, deep, silent", "every module ran, in tree order");
			expectEqual(loaded.size(), 2, "one value per module that exports something");
			expectEqual((loaded[0] as { first?: string }).first, "first", "the first module's exports");
			expectEqual((loaded[1] as { deep?: string }).deep, "deep", "the nested module's exports");

			// Through the module cache: a second call returns the same exports and runs nothing again.
			const again = underPackage(() => requireModules("src/fixtures/required"));
			expectEqual(requiredLog.join(", "), "first, deep, silent", "no module ran twice");
			expectTrue(again[0] === loaded[0] && again[1] === loaded[1], "the same exports");
		},
	],
	[
		"requireModules raises on a folder that is not in the place, naming the missing part",
		() => {
			const message = expectThrows(
				() => underPackage(() => requireModules("src/fixtures/notThere")),
				"a folder that is not there",
			);
			expectTrue(
				contains(message, `requireModules("src/fixtures/notThere"): the folder is not in the place`),
				message,
			);
			expectTrue(contains(message, "The build put it at out/fixtures/notThere"), message);
			expectTrue(contains(message, "has no child named 'notThere'"), message);
		},
	],
	[
		// A folder only the other realm can require raises at once and says so, rather than timing
		// out on a server container the client cannot see, or failing inside the path walk. Paths
		// under `game`, passed as the transformer would generate them.
		"requireModules says when a folder belongs to the other realm",
		() => {
			if (RunService.IsClient()) {
				const message = expectThrows(
					() => requireModules("src/server/commands", ["ServerScriptService", "TS", "commands"] as never),
					"a server folder on a client",
				);
				expectTrue(
					contains(
						message,
						`requireModules("src/server/commands"): the folder is in ServerScriptService, which does not replicate to clients. Call requireModules for it on the server.`,
					),
					message,
				);
			} else {
				const message = expectThrows(
					() =>
						requireModules("src/client/commands", [
							"StarterPlayer",
							"StarterPlayerScripts",
							"TS",
							"commands",
						] as never),
					"a client folder on the server",
				);
				expectTrue(
					contains(
						message,
						`requireModules("src/client/commands"): the folder is in StarterPlayer/StarterPlayerScripts, which only a client requires from`,
					),
					message,
				);
			}
		},
	],
	[
		// v1 built any decorated class lazily; v2 resolves registered providers only. The class is
		// known -- its module defined it and has loaded -- so the error says what it is and what to do.
		"explains why a loaded class that is not a registered provider cannot be resolved",
		() => {
			const module = Flamework.createModule().ignite();

			const component = expectThrows(() => module.resolveDependency(hiddenIds.component), "a component");
			expectTrue(contains(component, "is a component (@Component), not a provider"), component);
			// A module's full name in a place; the harness's tree prints the module's own name.
			expectTrue(
				component.match("%([^)]*hidden>?%) is a component")[0] !== undefined,
				`names the module it was defined in: ${component}`,
			);
			expectTrue(contains(component, "getComponent"), `says what to do instead: ${component}`);

			const provider = expectThrows(
				() => module.resolveDependency(hiddenIds.provider),
				"an unregistered provider",
			);
			expectTrue(contains(provider, "nothing in this module registers or provides"), provider);
			expectTrue(contains(provider, "registerProviders"), provider);

			const injectable = expectThrows(() => module.resolveDependency(hiddenIds.injectable), "an injectable");
			expectTrue(contains(injectable, "is not a provider"), injectable);
			expectTrue(contains(injectable, "createClassInstance"), injectable);

			// A class made by a call is not recorded: the plain message, as for any id.
			const localId = Reflect.getOwnMetadata<string>(makeLocalProvider(), "identifier")!;
			const unexplained = expectThrows(() => module.resolveDependency(localId), "a class made by a call");
			expectTrue(contains(unexplained, `could not resolve dependency '${localId}'`), unexplained);
			expectFalse(contains(unexplained, `'${localId}':`), `no explanation: ${unexplained}`);

			module.extinguish();
		},
	],
]);
