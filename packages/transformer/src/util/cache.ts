import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { PackageJsonResult } from "./functions/getPackageJson";
import type { LoadedProjectConfig } from "./projectConfig";

export interface Cache {
	rojoSum?: string;
	rojoResolver?: RojoResolver;
	buildInfoCandidates?: string[];
	isInitialCompile: boolean;

	/**
	 * The config file and environment as read by the first compilation of this process, which every
	 * later compilation uses as well. A watcher only recompiles the files that changed, so a later
	 * read that differs would leave the output disagreeing with itself; the first read stays in
	 * force and the difference is reported, with the fingerprint here to compare against.
	 */
	projectConfig?: LoadedProjectConfig;
	projectConfigFingerprint?: string;
	pkgJsonCache: Map<string, PackageJsonResult>;
}

/**
 * Global cache that is only reset when rbxtsc is restarted.
 */
export const Cache: Cache = {
	isInitialCompile: true,
	pkgJsonCache: new Map(),
};
