import fs from "fs";
import path from "path";

/**
 * What the place will hold at a path given to a path macro, judged from the files Rojo builds it
 * from:
 *
 * - `modules`: a file there, or somewhere under the folder there, that the place gets as a module;
 * - `empty`: the folder is there, with no such file anywhere in it;
 * - `missing`: nothing is there by that name, spelled exactly. `actual` is what is there when only
 *   the case differs, since the file system may not care but the place does: Rojo names every
 *   instance after the file or folder as it is on disk.
 */
export type SourcePathState = { kind: "modules" } | { kind: "empty" } | { kind: "missing"; actual?: string };

/** One `$path` of the Rojo project: the instance it builds, and the file or folder it builds it from. */
export interface RojoPartition {
	rbxPath: readonly string[];
	fsPath: string;
}

/** Where roblox-ts compiles from and to, which maps a Rojo partition inside `outDir` back to the sources. */
export interface CompileDirectories {
	rootDir: string;
	outDir: string;
}

/**
 * The files Rojo makes an instance of, by the extension it strips for the instance's name, and
 * whether that instance is a module or may hold modules (a model file). `.meta.json` makes none.
 */
const ROJO_FILES: ReadonlyArray<[extension: string, module: boolean]> = [
	[".model.json", true],
	[".project.json", true],
	[".luau", true],
	[".lua", true],
	[".json", true],
	[".toml", true],
	[".yaml", true],
	[".yml", true],
	[".rbxm", true],
	[".rbxmx", true],
	[".txt", false],
	[".csv", false],
];

/** A script's name without its `.server` or `.client`, as Rojo names the instance. */
const stripScriptKind = (name: string) => name.replace(/\.(server|client)$/, "");

/**
 * The instance a file becomes in the place, and whether it is a module: by Rojo's rules for a file
 * Rojo reads, and by roblox-ts's (`.ts`, `.tsx`, `index` as `init`) for a source file, which roblox-ts
 * compiles to Luau or copies as it is.
 */
function instanceOf(fileName: string, fromSource: boolean): { name: string; module: boolean } | undefined {
	if (fileName.endsWith(".meta.json")) return undefined;

	if (fromSource) {
		if (fileName.endsWith(".d.ts")) return undefined;

		const typescript = [".tsx", ".ts"].find((extension) => fileName.endsWith(extension));
		if (typescript !== undefined) {
			const name = stripScriptKind(fileName.slice(0, -typescript.length));
			return { name: name === "index" ? "init" : name, module: true };
		}
	}

	const rojo = ROJO_FILES.find(([extension]) => fileName.endsWith(extension));
	if (rojo === undefined) return undefined;

	return { name: stripScriptKind(fileName.slice(0, -rojo[0].length)), module: rojo[1] };
}

function isDirectory(directory: string, entry: fs.Dirent) {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;

	try {
		return fs.statSync(path.join(directory, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

function readDirectory(directory: string): fs.Dirent[] {
	try {
		return fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Whether a folder holds, at any depth, a file the place gets as a module. Installed packages do not count. */
function holdsModule(directory: string, fromSource: boolean): boolean {
	for (const entry of readDirectory(directory)) {
		if (entry.name === "node_modules") continue;

		const found = isDirectory(directory, entry)
			? holdsModule(path.join(directory, entry.name), fromSource)
			: instanceOf(entry.name, fromSource)?.module === true;

		if (found) return true;
	}

	return false;
}

/**
 * The entry of a folder a path segment names: the folder or file of exactly that name, or, for the
 * last segment, a file whose instance takes that name (`commands` for `commands.ts`).
 */
function findEntry(directory: string, segment: string, last: boolean, fromSource: boolean, ignoreCase: boolean) {
	const same = (a: string) => (ignoreCase ? a.toLowerCase() === segment.toLowerCase() : a === segment);
	const entries = readDirectory(directory);

	const exact = entries.find((entry) => same(entry.name));
	if (exact !== undefined || !last) return exact;

	return entries.find((entry) => {
		if (isDirectory(directory, entry)) return false;

		const instance = instanceOf(entry.name, fromSource);
		return instance !== undefined && same(instance.name);
	});
}

/** Walks the segments from `base`, returning what they name, or nothing at the first segment missing. */
function walk(base: string, segments: readonly string[], fromSource: boolean, ignoreCase: boolean) {
	let current = base;

	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1;
		const entry = findEntry(current, segment, last, fromSource, ignoreCase);
		if (entry === undefined) return undefined;

		if (!last && !isDirectory(current, entry)) return undefined;

		current = path.join(current, entry.name);
	}

	return current;
}

/** What is at `absolute`, found by the walk: a file is there; a folder is judged by what it holds. */
function stateOf(absolute: string, fromSource: boolean): SourcePathState {
	if (!fs.statSync(absolute).isDirectory()) return { kind: "modules" };
	return holdsModule(absolute, fromSource) ? { kind: "modules" } : { kind: "empty" };
}

/** Whether `child` is `parent` or inside it, as the Rojo resolver compares paths. */
function isWithin(child: string, parent: string) {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * What the place will hold at `rbxPath`, the Rojo path a path macro compiled to, judged the way
 * Rojo builds it: from the deepest `$path` of the project that covers the path, so that a `$path`
 * nested inside an out-mapped folder is taken for what it maps. Below that `$path`, every name must
 * match exactly, since the place takes its names from the disk there; the folder the `$path` names
 * is matched as the Rojo resolver matched it. A `$path` inside roblox-ts's `outDir` is judged from
 * the sources roblox-ts compiles into it, since the output is not written yet when this runs.
 *
 * `undefined` when no `$path` covers the path, which the Rojo resolver did when it made it.
 */
export function findPlaceSource(
	rbxPath: readonly string[],
	partitions: readonly RojoPartition[],
	directories: CompileDirectories,
	displayBase: string,
): SourcePathState | undefined {
	let partition: RojoPartition | undefined;
	for (const candidate of partitions) {
		const covers =
			candidate.rbxPath.length <= rbxPath.length && candidate.rbxPath.every((name, i) => rbxPath[i] === name);
		if (covers && (partition === undefined || candidate.rbxPath.length > partition.rbxPath.length)) {
			partition = candidate;
		}
	}
	if (partition === undefined) return undefined;

	const fromSource = isWithin(partition.fsPath, directories.outDir);
	const base = fromSource
		? path.join(directories.rootDir, path.relative(directories.outDir, partition.fsPath))
		: partition.fsPath;
	if (!fs.existsSync(base)) return { kind: "missing" };

	const rest = rbxPath.slice(partition.rbxPath.length);
	const exact = walk(base, rest, fromSource, false);
	if (exact !== undefined) return stateOf(exact, fromSource);

	const other = walk(base, rest, fromSource, true);
	return other === undefined
		? { kind: "missing" }
		: { kind: "missing", actual: path.relative(displayBase, other).replace(/\\/g, "/") };
}

/**
 * Looks a source path up by itself, for a build without a Rojo project to say where it goes. The
 * path is relative to `base`, the directory the build resolves source paths against. Every segment
 * is matched by its exact name, whatever the file system allows; a path that leaves `base` is only
 * checked for existence.
 */
export function findSourcePath(base: string, sourcePath: string): SourcePathState {
	const absolute = path.resolve(base, sourcePath);
	const relative = path.relative(base, absolute);

	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		if (!fs.existsSync(absolute)) return { kind: "missing" };
		return stateOf(absolute, true);
	}

	const segments = relative.split(path.sep).filter((segment) => segment !== "");
	const exact = walk(base, segments, true, false);
	if (exact !== undefined) return stateOf(exact, true);

	const other = walk(base, segments, true, true);
	return other === undefined
		? { kind: "missing" }
		: { kind: "missing", actual: path.relative(base, other).replace(/\\/g, "/") };
}
