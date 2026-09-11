/**
 * Patching a copy of the original place with what Rojo built.
 *
 * A game's assets often exist only in the place itself -- models, terrain, sounds -- and a Rojo
 * build has none of them. So the testing place is made by taking a copy of the original and
 * laying the build over it, driven by the project file: every node the project builds from a path
 * replaces the same-named instance in the original wholesale (that is the fresh code), every node
 * it merely declares is kept when the original has it and taken from the build when it does not,
 * and the properties the project sets are applied. Everything else in the original stays.
 *
 * The plan is computed here from the project file and carried out by `tasks/patch-place.luau`
 * under Lune, which can read and write place files.
 */

/** One instance the project file describes, as a path from the DataModel. */
export interface PatchOp {
	path: string[];
	/** `replace`: built from a `$path`, the build's version wins. `ensure`: declared, the original's is kept. */
	kind: "replace" | "ensure";
	className?: string;
	/** `$properties`, as written in the project file. */
	properties: Record<string, unknown>;
}

interface ProjectNode {
	$path?: string;
	$className?: string;
	$properties?: Record<string, unknown>;
	[child: string]: unknown;
}

export interface RojoProject {
	name?: string;
	tree: ProjectNode;
}

/**
 * Walks the project tree into the operations that lay it over another place, parents before
 * children so that a declared container exists before what goes inside it.
 */
export function planPatch(project: RojoProject): PatchOp[] {
	const ops: PatchOp[] = [];

	const walk = (node: ProjectNode, path: string[]) => {
		for (const [name, child] of Object.entries(node)) {
			if (name.startsWith("$")) continue;
			if (typeof child !== "object" || child === null) continue;

			const childNode = child as ProjectNode;
			const childPath = [...path, name];
			const properties = childNode.$properties ?? {};

			if (childNode.$path !== undefined) {
				// Built content, children declared alongside included: the build assembled it all.
				ops.push({ path: childPath, kind: "replace", properties });
				continue;
			}

			ops.push({ path: childPath, kind: "ensure", className: childNode.$className, properties });
			walk(childNode, childPath);
		}
	};

	walk(project.tree, []);
	return ops;
}

/** The properties the project sets on the DataModel's services and containers, for the summary. */
export function countProperties(ops: readonly PatchOp[]): number {
	return ops.reduce((total, op) => total + Object.keys(op.properties).length, 0);
}

/** The command that carries a plan out. */
export function patchCommand(
	luneExe: string,
	taskPath: string,
	files: { original: string; built: string; out: string; plan: string },
): string[] {
	return [luneExe, "run", taskPath, files.original, files.built, files.out, files.plan];
}

/** Where a patched place goes when nothing else is said: beside the build, marked as patched. */
export function defaultPatchedPath(built: string): string {
	return built.replace(/\.rbxlx?$/i, "") + ".patched.rbxl";
}
