import ts from "typescript";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { isPathDescendantOf } from "../util/functions/isPathDescendantOf";
import { describeSchemaErrors, validateSchema } from "../util/schema";
import { PKG_VERSION } from "../util/constants";
import { ProjectError } from "./diagnostics";

/** One use of a glob in a file, kept so that a glob matching nothing can be reported where it is written. */
export interface GlobUse {
	/** The glob relative to the package root, as `paths` keys it. */
	glob: string;

	/** The glob as written, which differs from `glob` for a relative (`./`) one. */
	text: string;

	/** The macro the glob was given to, such as `registerProvidersGlob`. */
	macro: string;

	/** Where the macro is called (a method call at the method's name), both one-based. */
	line: number;
	column: number;
}

/**
 * One use of a path macro in a file, kept so that a source path with nothing the build emits under
 * it can be reported where it is written.
 */
export interface PathUse {
	/** The source path as written, such as `src/server/services`. */
	path: string;

	/** The call the path was given to, as written: `registerProviders`, `ComponentPlugin.fromPath`. */
	macro: string;

	/** Where the macro is called (a method call at the method's name), both one-based. */
	line: number;
	column: number;

	/** Whether the call raises when the folder is not there, as core's `requireModules` does after five seconds, rather than waiting. */
	raises?: boolean;
}

interface FlameworkMetadata {
	globs?: {
		paths?: Record<string, string[]>;
		origins?: Record<string, string[]>;
		uses?: Record<string, GlobUse[]>;
	};
	paths?: {
		uses?: Record<string, PathUse[]>;
	};
}

export interface FlameworkBuildInfo {
	version: number;
	flameworkVersion: string;
	identifierPrefix?: string;
	idGenerationMode?: string;
	salt?: string;
	buildSeed?: string;
	metadata?: FlameworkMetadata;
	stringHashes?: { [key: string]: string };
	identifiers: { [key: string]: string };
}

/**
 * What is wrong with a flamework.build's text, as a phrase (`it is empty`), or `undefined` when it
 * is a build info.
 */
function findProblem(text: string | undefined): string | undefined {
	if (text === undefined) return "it could not be read";
	if (text.trim() === "") return "it is empty";

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		// A file cut short by an interrupted write, or holding a merge conflict, ends up here.
		return `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
	}

	if (!validateSchema("buildInfo", value)) {
		return `it does not have the shape Flamework writes (${describeSchemaErrors().join("; ")})`;
	}
}

export class BuildInfo {
	/**
	 * Reads a flamework.build, or starts an empty one when there is no file. A file that cannot be
	 * used -- unreadable, empty, cut short, not JSON, not shaped like a build info -- stops the build
	 * with a `ProjectError` that names it as `name` and says what is wrong, followed by `remedy`:
	 * what to do, which depends on whose file it is (see `TransformState.setupBuildInfo`).
	 */
	static fromPath(fileName: string, name = fileName, remedy: readonly string[] = []) {
		if (!ts.sys.fileExists(fileName)) return new BuildInfo(fileName);

		const text = ts.sys.readFile(fileName);
		const problem = findProblem(text);
		if (problem !== undefined) {
			throw new ProjectError([`Flamework cannot use ${name}: ${problem}.`, ...remedy].join("\n"));
		}

		return new BuildInfo(fileName, JSON.parse(text!) as FlameworkBuildInfo);
	}

	/**
	 * The project's own flamework.build: the one in `directory`, else the one at its package root.
	 * `remedy` is what to do when it cannot be used; it is named relative to `directory`.
	 */
	static fromDirectory(directory: string, remedy?: readonly string[]) {
		const read = (file: string) =>
			this.fromPath(file, path.relative(directory, file).replace(/\\/g, "/") || file, remedy);

		const buildInfoPath = path.join(directory, "flamework.build");
		if (ts.sys.fileExists(buildInfoPath)) {
			return read(buildInfoPath);
		}

		const packageJsonPath = ts.findPackageJson(directory, ts.sys as never);
		if (packageJsonPath) {
			const buildInfoPath = path.join(path.dirname(packageJsonPath), "flamework.build");
			if (buildInfoPath && ts.sys.fileExists(buildInfoPath)) {
				return read(buildInfoPath);
			}
		}
	}

	private static candidateCache = new Map<string, { result?: string }>();
	static findCandidateUpper(startDirectory: string, depth = 4): string | undefined {
		const cache = this.candidateCache.get(startDirectory);
		if (cache && cache.result) {
			return cache.result;
		}

		const buildPath = path.join(startDirectory, "flamework.build");
		if (!cache && fs.existsSync(buildPath)) {
			this.candidateCache.set(startDirectory, { result: buildPath });
			return buildPath;
		} else {
			this.candidateCache.set(startDirectory, {});
		}

		if (depth > 0) {
			return this.findCandidateUpper(path.dirname(startDirectory), depth - 1);
		}
	}

	static findCandidates(searchPath: string, depth = 2, isNodeModules = true): string[] {
		const candidates: string[] = [];

		for (const childPath of fs.readdirSync(searchPath)) {
			// only search @* (@rbxts, @flamework-experimental, @custom, etc)
			if (!isNodeModules || childPath.startsWith("@")) {
				const fullPath = path.join(searchPath, childPath);
				const realPath = fs.realpathSync(fullPath);
				if (fs.lstatSync(realPath).isDirectory() && depth !== 0) {
					candidates.push(...BuildInfo.findCandidates(fullPath, depth - 1, childPath === "node_modules"));
				} else {
					if (childPath === "flamework.build") {
						candidates.push(fullPath);
					}
				}
			}
		}

		return candidates;
	}

	private buildInfo: FlameworkBuildInfo;
	private buildInfos: BuildInfo[] = [];
	private identifiersLookup = new Map<string, string>();
	constructor(
		public buildInfoPath: string,
		buildInfo?: FlameworkBuildInfo,
	) {
		this.buildInfo = buildInfo ?? {
			version: 1,
			flameworkVersion: PKG_VERSION,
			identifiers: {},
		};
		if (buildInfo) {
			for (const [internalId, id] of Object.entries(buildInfo.identifiers)) {
				this.identifiersLookup.set(id, internalId);
			}
		}
	}

	/**
	 * Saves the build info to a file.
	 */
	save() {
		fs.writeFileSync(this.buildInfoPath, JSON.stringify(this.buildInfo, undefined, "\t"));
	}

	/**
	 * Retrieves the salt previously used to generate identifiers, or creates one.
	 */
	getSalt() {
		if (this.buildInfo.salt) return this.buildInfo.salt;

		const salt = crypto.randomBytes(64).toString("hex");
		this.buildInfo.salt = salt;

		return salt;
	}

	/**
	 * A random seed that lives as long as this build info does: made when the build info is
	 * created, kept while it is reused. A plain build recreates the build info and so gets a new
	 * seed; a watcher reuses it across rebuilds and keeps the same one. Under obfuscation the
	 * callsite uuids -- the names of every remote -- are derived from it, so that they change with
	 * every build and cannot be mapped once and reused against the next release.
	 */
	getBuildSeed() {
		if (this.buildInfo.buildSeed) return this.buildInfo.buildSeed;

		const seed = uuid();
		this.buildInfo.buildSeed = seed;

		return seed;
	}

	/**
	 * Retrieves the version of flamework that this project was originally compiled on.
	 */
	getFlameworkVersion() {
		return this.buildInfo.flameworkVersion;
	}

	/**
	 * Register a build info from an external source, normally packages.
	 * @param buildInfo The BuildInfo to add
	 */
	addBuildInfo(buildInfo: BuildInfo) {
		this.buildInfos.push(buildInfo);
	}

	/**
	 * Register a new identifier to be saved with the build info.
	 * @param internalId The internal, reproducible ID
	 * @param id The random or incremental ID
	 */
	addIdentifier(internalId: string, id: string) {
		const identifier = this.getIdentifierFromInternal(internalId);
		if (identifier) throw new Error(`Attempt to rewrite identifier ${internalId} -> ${id} (from ${identifier})`);

		this.buildInfo.identifiers[internalId] = id;
		this.identifiersLookup.set(id, internalId);
	}

	getBuildInfoFromFile(fileName: string): BuildInfo | undefined {
		for (const build of this.buildInfos) {
			if (isPathDescendantOf(fileName, path.dirname(build.buildInfoPath))) {
				return build;
			}
		}
	}

	/**
	 * Sets metadata which will be exposed at runtime.
	 */
	setMetadata<K extends keyof FlameworkMetadata>(key: K, value: FlameworkMetadata[K]) {
		this.buildInfo.metadata ??= {};
		this.buildInfo.metadata[key] = value;
	}

	/**
	 * Gets metadata exposed at runtime.
	 */
	getMetadata<K extends keyof FlameworkMetadata>(key: K) {
		return this.buildInfo.metadata?.[key];
	}

	/**
	 * Retrieves all metadata of this build info and its children.
	 */
	getChildrenMetadata<K extends keyof FlameworkMetadata>(name: K) {
		const childrenMetadata = new Map<string, FlameworkMetadata[K]>();

		for (const build of this.buildInfos) {
			const key = build.getIdentifierPrefix();
			const metadata = build.getMetadata(name);
			if (!key) continue;
			if (!metadata) continue;

			childrenMetadata.set(key, metadata);

			for (const [key, metadata] of build.getChildrenMetadata(name)) {
				childrenMetadata.set(key, metadata);
			}
		}

		return childrenMetadata;
	}

	getBuildInfoFromPrefix(prefix: string): BuildInfo | undefined {
		for (const build of this.buildInfos) {
			if (build.getIdentifierPrefix() === prefix) {
				return build;
			}

			const child = build.getBuildInfoFromPrefix(prefix);
			if (child) {
				return child;
			}
		}
	}

	/**
	 * Adds a glob that will automatically be tracked between compiles.
	 */
	addGlob(glob: string, origin: string, use?: GlobUse) {
		this.buildInfo.metadata ??= {};
		this.buildInfo.metadata.globs ??= {};
		this.buildInfo.metadata.globs.paths ??= {};
		this.buildInfo.metadata.globs.origins ??= {};
		this.buildInfo.metadata.globs.paths[glob] = [];
		this.buildInfo.metadata.globs.origins[origin] ??= [];
		this.buildInfo.metadata.globs.origins[origin].push(glob);

		if (use) {
			this.buildInfo.metadata.globs.uses ??= {};
			this.buildInfo.metadata.globs.uses[origin] ??= [];
			this.buildInfo.metadata.globs.uses[origin].push(use);
		}
	}

	/**
	 * Records a use of a path macro, which the build checks against the source tree once it is done
	 * (see `TransformState.warnEmptyPaths`).
	 */
	addPathUse(origin: string, use: PathUse) {
		this.buildInfo.metadata ??= {};
		this.buildInfo.metadata.paths ??= {};
		this.buildInfo.metadata.paths.uses ??= {};
		this.buildInfo.metadata.paths.uses[origin] ??= [];
		this.buildInfo.metadata.paths.uses[origin].push(use);
	}

	/**
	 * Removes every path macro use recorded for this file, which is about to be compiled again.
	 */
	invalidatePathUses(origin: string) {
		const uses = this.buildInfo.metadata?.paths?.uses;
		if (uses) {
			delete uses[origin];
		}
	}

	/**
	 * Removes all globs related to this file.
	 */
	invalidateGlobs(origin: string) {
		const globs = this.buildInfo.metadata?.globs;
		if (globs?.uses) {
			delete globs.uses[origin];
		}

		if (globs && globs.paths && globs.origins) {
			delete globs.origins[origin];

			outer: for (const path of Object.keys(globs.paths)) {
				for (const origin of Object.values(globs.origins)) {
					if (origin.includes(path)) {
						continue outer;
					}
				}

				delete globs.paths[path];
			}
		}
	}

	/**
	 * Get the random or incremental Id from the internalId.
	 * @param internalId The internal, reproducible ID
	 */
	getIdentifierFromInternal(internalId: string): string | undefined {
		const id = this.buildInfo.identifiers[internalId];
		if (id) return id;

		for (const build of this.buildInfos) {
			const subId = build.getIdentifierFromInternal(internalId);
			if (subId) return subId;
		}
	}

	/**
	 * Get the internal, reproducible Id from a random Id.
	 * @param id The random or incremental Id
	 */
	getInternalFromIdentifier(id: string): string | undefined {
		const internalId = this.identifiersLookup.get(id);
		if (internalId) return internalId;

		for (const build of this.buildInfos) {
			const subId = build.getIdentifierFromInternal(id);
			if (subId) return subId;
		}
	}

	/**
	 * Returns the next Id for incremental generation.
	 */
	getLatestId() {
		return Object.keys(this.buildInfo.identifiers).length + 1;
	}

	/**
	 * Create a UUID, subsequent calls with the same string will have the same UUID.
	 * @param str The string to hash
	 */
	hashString(str: string, context = "@") {
		str = `${context}:${str}`;

		let stringHashes = this.buildInfo.stringHashes;
		if (!stringHashes) this.buildInfo.stringHashes = stringHashes = {};

		if (stringHashes[str]) return stringHashes[str];

		const strUuid = uuid();
		stringHashes[str] = strUuid;
		return strUuid;
	}

	/**
	 * Sets the prefix used for identifiers.
	 * Used to generate IDs for packages.
	 */
	setIdentifierPrefix(prefix: string | undefined) {
		this.buildInfo.identifierPrefix = prefix;
	}

	/**
	 * Gets the prefixed used for identifiers.
	 */
	getIdentifierPrefix() {
		return this.buildInfo.identifierPrefix;
	}

	/**
	 * Records the mode identifiers are generated in. An identifier, once generated, is answered from
	 * the table without looking at the mode again, so a build info written in another mode would
	 * hand out a mix. When the mode differs from the recorded one the table is dropped and every id
	 * is generated afresh; the previous mode is returned so that the caller can say so.
	 *
	 * A build info from before the mode was recorded keeps its table: there is no telling what
	 * mode it was made in, and dropping ids without cause is worse than keeping them.
	 */
	setIdGenerationMode(mode: string): string | undefined {
		const previous = this.buildInfo.idGenerationMode;
		this.buildInfo.idGenerationMode = mode;

		if (previous !== undefined && previous !== mode) {
			this.buildInfo.identifiers = {};
			this.identifiersLookup.clear();
			return previous;
		}
	}

	/** The mode the identifiers in the table were generated in, if it was recorded. */
	getIdGenerationMode() {
		return this.buildInfo.idGenerationMode;
	}
}
