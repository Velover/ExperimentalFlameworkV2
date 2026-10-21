import fs from "fs";
import crypto from "crypto";
import path from "path";
import { RojoResolver } from "@roblox-ts/rojo-resolver";

/** A Rojo project file a resolver read, with a hash of its text when it was read. */
export interface RojoProjectFile {
	path: string;
	sum: string;
}

/** A hash of a file's bytes, or `"missing"` when it cannot be read. */
export function hashRojoFile(file: string) {
	try {
		return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return "missing";
	}
}

/**
 * A resolver for the Rojo project at `file`, with every project file it read: the top one, and each
 * nested one a `$path` leads to (a folder holding `default.project.json`, or a `*.project.json` in a
 * folder it searches). A later compilation can keep the resolver while all of them are unchanged.
 *
 * The resolver does not list what it read, so its `parseConfig` is watched on this one instance.
 * Should a release of `@roblox-ts/rojo-resolver` not have it, only the top file is listed, as before.
 */
export function readRojoProject(file: string): { resolver: RojoResolver; files: RojoProjectFile[] } {
	const top = path.resolve(file);
	const files = new Array<RojoProjectFile>();
	const resolver = new (RojoResolver as unknown as new () => RojoResolver)();
	const watched = resolver as unknown as { parseConfig?: (file: string, doNotPush?: boolean) => void };
	const parseConfig = watched.parseConfig;

	if (typeof parseConfig !== "function") {
		files.push({ path: top, sum: hashRojoFile(top) });
		return { resolver: RojoResolver.fromPath(top), files };
	}

	watched.parseConfig = function (this: unknown, configFile: string, doNotPush?: boolean) {
		// Hashed before the resolver reads it: a write in between makes the next compilation read again.
		files.push({ path: configFile, sum: hashRojoFile(configFile) });
		return parseConfig.call(this, configFile, doNotPush);
	};
	watched.parseConfig(top, true);
	delete watched.parseConfig;

	return { resolver, files };
}
