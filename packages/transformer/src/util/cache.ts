import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { PackageJsonResult } from "./functions/getPackageJson";

export interface Cache {
	rojoSum?: string;
	rojoResolver?: RojoResolver;
	buildInfoCandidates?: string[];
	isInitialCompile: boolean;
	pkgJsonCache: Map<string, PackageJsonResult>;
}

/**
 * Global cache that is only reset when rbxtsc is restarted.
 */
export const Cache: Cache = {
	isInitialCompile: true,
	pkgJsonCache: new Map(),
};
