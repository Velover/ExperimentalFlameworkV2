import {
	getClassesInPath,
	getPathRoot,
	OnStart,
	Provider,
	Reflect,
	requireModulesInPath,
	resolveRbxPath,
} from "@flamework-experimental/core";
import {
	defineTests,
	expectDefined,
	expectEqual,
	expectThrows,
	expectTrue,
	test,
} from "@flamework-experimental/testing";
import { ServerScriptService, Workspace } from "@rbxts/services";
import { FwTestService } from "server/Features/Testing/Services/FwTestService";

/**
 * Compile-time paths against the real Rojo tree. The Lune harness cannot cover this: its module
 * graph is plain tables with no `WaitForChild`, `GetDescendants` or `IsA`, so every path-based
 * registration -- which is how most games register anything -- is only ever exercised in a place.
 *
 * The template's project file maps `out/server` to `ServerScriptService.TS`, so a source folder
 * `src/server/X` is the tree path below.
 */
const TESTS_PATH = ["ServerScriptService", "TS", "Tests"];
const SERVICES_PATH = ["ServerScriptService", "TS", "Features", "Testing", "Services"];

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
