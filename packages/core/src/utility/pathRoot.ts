import { Players, RunService, StarterPlayer } from "@rbxts/services";
import { findMetadataContainer, findMetadataFolder } from "./metadata";

/** The shape of `include/flamework/paths.json`, which the transformer writes for game and plugin projects. */
interface PathsMetadata {
	/** How many ancestors the include folder has below the Rojo tree's root. */
	includeDepth: number;
}

let cached: Instance | undefined;
let override: Instance | undefined;

/**
 * The instance every compile-time path is relative to: `game` in a place, and the Rojo tree's own
 * root in a model or a Studio plugin, whose tree hangs off no service.
 *
 * The transformer emits paths relative to the tree's root, and records in `paths.json` how far
 * below that root the include folder sits; the root is found once by climbing that far from the
 * folder the metadata was found in. With no metadata -- a package on its own, the test harness --
 * it is `game`.
 */
export function getPathRoot(): Instance {
	if (override !== undefined) {
		return override;
	}

	if (cached === undefined) {
		cached = game;

		const folder = findMetadataFolder("paths");
		const paths = findMetadataContainer<PathsMetadata>("paths");
		if (folder !== undefined && paths !== undefined) {
			// The folder is `include/flamework`; its parent is the include folder itself.
			let node: Instance | undefined = folder.Parent;
			for (let i = 0; i < paths.includeDepth && node !== undefined; i++) {
				node = node.Parent;
			}

			if (node !== undefined) {
				cached = node;
			}
		}
	}

	return cached;
}

/**
 * Walks a compile-time path from {@link getPathRoot}, asking `child` for each segment in turn, and
 * stops at the first segment it has no instance for.
 *
 * Under `game` the first segment names a service, and `StarterPlayer/StarterPlayerScripts` is
 * answered from the local player's `PlayerScripts`, which is where that content actually runs.
 */
function walkRbxPath(
	rbxPath: readonly string[],
	child: (parent: Instance, name: string) => Instance | undefined,
): { found: Instance; missing?: string } {
	// Copied so that a generated path literal is not consumed by this call.
	const path = [...rbxPath];

	let node = getPathRoot();
	if (node === game) {
		const serviceName = path.shift();
		assert(serviceName !== undefined, "a path under game has to name a service first");

		node = game.GetService(serviceName as keyof Services);
		if (node === StarterPlayer) {
			assert(path.shift() === "StarterPlayerScripts", "StarterPlayer only supports StarterPlayerScripts");
			assert(RunService.IsClient(), "The server cannot load StarterPlayer content");

			node = Players.LocalPlayer.WaitForChild("PlayerScripts");
		}
	}

	for (const segment of path) {
		const found = child(node, segment);
		if (found === undefined) {
			return { found: node, missing: segment };
		}

		node = found;
	}

	return { found: node };
}

/**
 * Walks a compile-time path from {@link getPathRoot}, waiting for each child in turn.
 *
 * Under `game` the first segment names a service, and `StarterPlayer/StarterPlayerScripts` is
 * answered from the local player's `PlayerScripts`, which is where that content actually runs.
 */
export function resolveRbxPath(rbxPath: readonly string[]): Instance {
	return walkRbxPath(rbxPath, (parent, name) => parent.WaitForChild(name)).found;
}

/**
 * Walks a compile-time path as {@link resolveRbxPath} does, but gives up on a child that is not
 * there instead of waiting for it forever. A client still loading the place waits for it to load
 * first, since the place's content arrives as it loads; after that, a missing child is given
 * `timeout` seconds to appear.
 *
 * Returns the instance the path names, or the deepest instance it found and the name missing below
 * it.
 */
export function findRbxPath(rbxPath: readonly string[], timeout: number) {
	return walkRbxPath(rbxPath, (parent, name) => {
		const child = parent.FindFirstChild(name);
		if (child !== undefined) return child;

		if (RunService.IsClient() && !game.IsLoaded()) {
			game.Loaded.Wait();
		}

		return parent.WaitForChild(name, timeout);
	});
}

/**
 * Replaces the root paths resolve from, or restores the discovered one with `undefined`. For the
 * test harness, which has no tree to discover it in.
 *
 * @internal
 */
export function __setPathRoot(root: Instance | undefined) {
	override = root;
}
