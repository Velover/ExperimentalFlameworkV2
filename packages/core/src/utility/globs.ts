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
				"A game's globs are resolved at compile time into include/flamework/globs.json, and this one is not there: " +
				"the include folder is not in your Rojo project, the glob is used inside a package (a package's globs " +
				"are not resolved), the string was not produced by a glob macro, or globs.json is from another build. " +
				"A glob that matched no files does not raise: it resolves to no paths, and the build warns about it.",
			0,
		);
	}

	return paths;
}

/**
 * Requires every ModuleScript under every path the glob matched and returns the Flamework classes
 * they hold, exported or not, each at most once (see {@link getClassesInPath}).
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
