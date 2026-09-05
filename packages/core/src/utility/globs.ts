import { getClassesInPath } from "./getClassesInPath";
import { findMetadataContainer } from "./metadata";

/**
 * The shape of `include/flamework/globs.json`, which the transformer writes for game projects.
 *
 * Keys are the glob strings exactly as they appear in the emitted code (obfuscated when obfuscation
 * is on); values are the Rojo paths that matched them at compile time.
 */
interface GlobContainer {
	game?: Map<string, string[][]>;
	packages: Map<string, Map<string, string[][]>>;
}

let globContainer: GlobContainer | false | undefined;

/**
 * Returns the Rojo paths a compile-time glob resolved to.
 */
export function getGlobPaths(glob: string): string[][] {
	if (globContainer === undefined) {
		globContainer = findMetadataContainer<GlobContainer>("globs") ?? false;
	}

	const paths = globContainer === false ? undefined : globContainer.game?.get(glob);
	if (paths === undefined) {
		error(
			`Flamework has no paths for the glob '${glob}'. ` +
				"Globs are resolved at compile time into include/flamework/globs.json, which only game projects emit; " +
				"make sure the include directory is part of your Rojo project and that the glob matched at least one file.",
			0,
		);
	}

	return paths;
}

/**
 * Requires every ModuleScript under every path the glob matched and returns the exported classes,
 * each at most once.
 */
export function getClassesInGlob(glob: string): Array<object> {
	const classes = new Array<object>();

	for (const path of getGlobPaths(glob)) {
		for (const found of getClassesInPath(path)) {
			if (!classes.includes(found)) {
				classes.push(found);
			}
		}
	}

	return classes;
}
