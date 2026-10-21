import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { PackageJsonResult } from "./functions/getPackageJson";
import type { RojoProjectFile } from "./functions/readRojoProject";
import type { LoadedProjectConfig } from "./projectConfig";

export interface Cache {
	/**
	 * The Rojo resolver of the last compilation, with every project file it read (the top one and
	 * each nested one) and their hashes: a compilation keeps it only while all of them are unchanged.
	 */
	rojo?: { configPath: string; resolver: RojoResolver; files: RojoProjectFile[] };
	buildInfoCandidates?: string[];

	/**
	 * Whether no build of this process has been committed yet: roblox-ts has written none, so the
	 * next one starts from nothing, as the first does, unless an incremental build's tsbuildinfo is
	 * there. A build that fails writes nothing, its flamework.build included, so it does not count.
	 */
	isInitialCompile: boolean;

	/**
	 * Whether a compilation of this process has started, successful or not. The `$schema` line and
	 * the warnings about the project's setup belong to the first one.
	 */
	compilationStarted?: boolean;

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
