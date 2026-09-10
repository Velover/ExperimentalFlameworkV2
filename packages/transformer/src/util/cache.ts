import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { PackageJsonResult } from "./functions/getPackageJson";

export interface Cache {
	rojoSum?: string;
	rojoResolver?: RojoResolver;
	buildInfoCandidates?: string[];
	isInitialCompile: boolean;

	/**
	 * A hash of the config options that are compiled into every file, from the first compilation of
	 * this process. A later compilation that sees a different one is a watcher whose output is now
	 * partly stale, and says so.
	 */
	compiledOptionsHash?: string;
	pkgJsonCache: Map<string, PackageJsonResult>;
}

/**
 * Global cache that is only reset when rbxtsc is restarted.
 */
export const Cache: Cache = {
	isInitialCompile: true,
	pkgJsonCache: new Map(),
};
