import * as core from "@flamework-experimental/core";
import { resolveRbxPath } from "@flamework-experimental/core";
import { expectThrows, expectTrue, suite } from "../testkit";

/** Internal and stripped from the package's types, so reached through a cast, as `ignite` is. */
const harness = core as unknown as { __setPathRoot: (root: Instance | undefined) => void };

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
]);
