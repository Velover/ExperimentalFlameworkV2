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
 * The properties are the other reason the step exists: a place file takes any property, including
 * those no script may set once the game runs (`Workspace.SignalBehavior`, the streaming radii),
 * so a project chosen for a run puts its `$properties` in effect even without an original. The
 * same task then runs with the build as both the original and the build, and only sets
 * properties.
 *
 * The plan is computed here from the project file and carried out by `tasks/patch-place.lune`
 * under Lune, which can read and write place files.
 */
import { basename } from "node:path";

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
 * A Rojo project a run follows: the file, the name the run and its patched place are labelled
 * with, and whether someone chose it (`--project`, `ROJO_PROJECT`) or it is the default standing
 * in. A chosen project has its properties applied even when there is no original to patch; the
 * default is only followed when there is one, so a plain run needs no Lune.
 */
export interface ProjectChoice {
	path: string;
	name: string;
	chosen: boolean;
}

/** What `tasks/patch-place.lune` is given: the operations, and the project's name for the place to carry. */
export interface PatchPlan {
	project: string;
	ops: PatchOp[];
}

/** The attribute the patch sets on Workspace, the name of the project the place was made under; `getProject()` in the place reads it. */
export const PROJECT_ATTRIBUTE = "FlameworkTestProject";

/** `tests/deferred.project.json` is the project `deferred`: what its run, its patched file and the place's attribute are named. */
export function projectNameOf(path: string): string {
	return basename(path)
		.replace(/\.project\.json$/i, "")
		.replace(/\.json$/i, "");
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

/** The command that carries a plan out; the same file as original and build means only properties are set. */
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

/**
 * Where the place made under a project goes: `place.deferred.rbxl` for a chosen project, so that
 * every project's run opens a file of its own name; the plain `place.patched.rbxl` for the default.
 */
export function patchedPathFor(built: string, project: ProjectChoice): string {
	if (!project.chosen) return defaultPatchedPath(built);
	return `${built.replace(/\.rbxlx?$/i, "")}.${project.name}.rbxl`;
}
