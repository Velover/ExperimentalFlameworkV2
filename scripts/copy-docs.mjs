import * as fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { coreDocs, rewriteLinks, ROOT, shippedMarkdown } from "./links.mjs";

/**
 * Copies the guide into core's package before publishing, so that a game's
 * `node_modules/@flamework-experimental/core/docs` holds the docs of the version it installed.
 *
 * What ships is the index (`docs/README.md`) and the guide (`docs/guide/*.md`), at the same paths
 * under `packages/core/docs`, so that links between them stay relative. A link to anything else in
 * the repository (the reference, the testing docs, the changelog, a package) points at that file
 * on GitHub instead, anchor and all (see links.mjs).
 *
 * Run by `bun run prepare:docs` and by core's own `prepack`, so that packing or publishing core
 * always ships the docs as they are now.
 */
const TARGET = path.join(ROOT, "packages", "core");

export function copyDocs() {
	const docs = coreDocs();
	const shipped = shippedMarkdown("core");

	fs.rmSync(path.join(TARGET, "docs"), { recursive: true, force: true });
	for (const file of docs) {
		const text = fs.readFileSync(path.join(ROOT, file), "utf8");

		const destination = path.join(TARGET, file);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, rewriteLinks(text, file, shipped));
	}

	return docs;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const docs = copyDocs();
	// On stderr: `npm pack --json` runs this as core's prepack, and its stdout is the JSON.
	console.error(`copied ${docs.length} docs into packages/core/docs`);
}
