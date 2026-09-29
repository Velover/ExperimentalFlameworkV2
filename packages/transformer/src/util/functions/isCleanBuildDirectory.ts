import fs from "fs";
import ts from "typescript";

/**
 * Whether this build starts from nothing: not an incremental build, or one whose tsbuildinfo is not
 * there yet. An incremental build that finds its tsbuildinfo recompiles only the files that changed,
 * so Flamework has to reuse the previous flamework.build for the others' ids to still match.
 *
 * The tsbuildinfo is the one TypeScript itself reads, `tsBuildInfoFile` or, without it, the default
 * TypeScript picks from `outDir` and `rootDir` (`tsconfig.tsbuildinfo` beside the config for the
 * usual `"rootDir": "src"`, `out/tsconfig.tsbuildinfo` with `rootDirs`). Going by
 * `tsBuildInfoFile` alone took an incremental build without it for a clean one every time, and a
 * recompiled file then named the classes of the files left alone by fresh ids.
 */
export function isCleanBuildDirectory(compilerOptions: ts.CompilerOptions) {
	const buildInfoFile = getTsBuildInfoPath(compilerOptions);
	return buildInfoFile === undefined || !fs.existsSync(buildInfoFile);
}

/**
 * The tsbuildinfo an incremental build reads and writes, for messages that tell the user which file
 * to delete; `undefined` when the build is not incremental.
 */
export function getTsBuildInfoPath(compilerOptions: ts.CompilerOptions): string | undefined {
	if (!compilerOptions.incremental && !compilerOptions.composite) return undefined;

	return ts.getTsBuildInfoEmitOutputFilePath(compilerOptions) ?? compilerOptions.tsBuildInfoFile;
}
