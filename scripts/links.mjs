import * as fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Link handling for the Markdown files copied into the packages before publishing (copy-readme.mjs,
 * copy-docs.mjs). A copy sits at the same path in its package that its source has in the repository,
 * so a link to another file that ships stays relative, and a link to anything else in the repository
 * is pointed at that file on GitHub, anchor and all. A block marked as for the repository only is
 * left out of a copy (`withoutRepositoryOnly`).
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY = "https://github.com/Velover/ExperimentalFlameworkV2";

/** An inline link's target, `](target)`. The docs use no titles and no reference links. */
const LINK = /\]\(([^)\s]+)\)/g;

/** A fence opening or closing a code block: three or more backticks or tildes, indented or not (a list item's). */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Splits Markdown into prose and code: fenced blocks, and code spans -- a run of backticks up to the
 * next run of the same length, within the paragraph. A run with no match is prose, as in CommonMark.
 */
function segments(text) {
	const parts = [];
	const push = (code, value) => {
		if (value === "") return;
		const last = parts[parts.length - 1];
		if (last !== undefined && last.code === code) last.value += value;
		else parts.push({ code, value });
	};

	const lines = text.split(/(?<=\n)/);
	let prose = "";
	const flushProse = () => {
		splitSpans(prose, push);
		prose = "";
	};

	for (let i = 0; i < lines.length; i++) {
		const open = lines[i].match(FENCE);
		if (!open) {
			prose += lines[i];
			continue;
		}

		flushProse();
		const marker = open[1];
		let block = lines[i];
		for (i++; i < lines.length; i++) {
			block += lines[i];
			const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
			if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
		}
		push(true, block);
	}
	flushProse();

	return parts;
}

function splitSpans(text, push) {
	let index = 0;
	while (index < text.length) {
		const start = text.indexOf("`", index);
		if (start === -1) break;

		let runEnd = start;
		while (text[runEnd] === "`") runEnd++;
		const run = runEnd - start;

		// The closing run: exactly as long, before the paragraph ends.
		const paragraphEnd = text.slice(runEnd).search(/\n[ \t]*\n/);
		const limit = paragraphEnd === -1 ? text.length : runEnd + paragraphEnd;
		let close = -1;
		for (let at = text.indexOf("`", runEnd); at !== -1 && at < limit; at = text.indexOf("`", at)) {
			let end = at;
			while (text[end] === "`") end++;
			if (end - at === run) {
				close = end;
				break;
			}
			at = end;
		}

		if (close === -1) {
			push(false, text.slice(index, runEnd));
			index = runEnd;
			continue;
		}

		push(false, text.slice(index, start));
		push(true, text.slice(start, close));
		index = close;
	}

	push(false, text.slice(index));
}

/** Replaces each inline link target outside code with what `replace` returns for it. */
export function mapLinks(text, replace) {
	return segments(text)
		.map(({ code, value }) => (code ? value : value.replace(LINK, (_, target) => `](${replace(target)})`)))
		.join("");
}

/** Every inline link target outside code, in order. */
export function links(text) {
	const found = [];
	mapLinks(text, (target) => {
		found.push(target);
		return target;
	});
	return found;
}

/**
 * The target a link in `file` (a path in the repository, with forward slashes) has in a shipped copy:
 * unchanged when it is external, an anchor in the same file, or a file in `shipped` (repository paths
 * that ship at the same place in the package); the file's GitHub URL otherwise, `tree` for a folder.
 */
export function rewriteTarget(file, target, shipped) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
		return target;
	}

	const hash = target.indexOf("#");
	const linked = hash === -1 ? target : target.slice(0, hash);
	const anchor = hash === -1 ? "" : target.slice(hash);

	const repositoryPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), linked)).replace(/\/$/, "");
	if (shipped.includes(repositoryPath)) {
		return target;
	}

	const absolute = path.join(ROOT, repositoryPath);
	if (repositoryPath.startsWith("..") || !fs.existsSync(absolute)) {
		throw new Error(`${file} links to ${target}, which is not in the repository (${repositoryPath})`);
	}

	const kind = fs.statSync(absolute).isDirectory() ? "tree" : "blob";
	return `${REPOSITORY}/${kind}/HEAD/${repositoryPath}${anchor}`;
}

/** A shipped copy of the Markdown file at `file` in the repository: see {@link rewriteTarget}. */
export function rewriteLinks(text, file, shipped) {
	return mapLinks(text, (target) => rewriteTarget(file, target, shipped));
}

/**
 * A block of Markdown for this repository's contributors, which a package's copy leaves out: from a
 * line `<!-- repository only ... -->` to a line `<!-- end repository only -->`, both included, with
 * the blank line after it.
 */
const REPOSITORY_ONLY = /^<!-- repository only\b[^\n]*-->\r?\n[\s\S]*?^<!-- end repository only -->\r?\n(\r?\n)?/gm;

/**
 * `text` without its repository-only blocks: see {@link REPOSITORY_ONLY}. A marker it cannot pair
 * (no end, an end without a start, or one not at the start of its line) raises, so a block is never
 * shipped, or the text after it dropped, without a word.
 */
export function withoutRepositoryOnly(text) {
	const starts = text.match(/^<!-- repository only\b/gm)?.length ?? 0;
	const ends = text.match(/^<!-- end repository only -->/gm)?.length ?? 0;
	let blocks = 0;
	const result = text.replace(REPOSITORY_ONLY, () => {
		blocks++;
		return "";
	});

	if (starts !== ends || blocks !== starts || /repository only/.test(result)) {
		throw new Error(
			`unpaired repository-only markers: ${starts} start(s), ${ends} end(s), ${blocks} block(s) removed; ` +
				"each block must be a line `<!-- repository only ... -->` and a line `<!-- end repository only -->`, " +
				"both at the start of the line",
		);
	}

	return result;
}

/** What core ships of the docs, as repository paths: the index and every guide page. */
export function coreDocs() {
	const guide = fs
		.readdirSync(path.join(ROOT, "docs", "guide"))
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => `docs/guide/${name}`);

	return ["docs/README.md", ...guide];
}

/** Every Markdown file a package ships at the same path as in the repository. */
export function shippedMarkdown(pkg) {
	return pkg === "core" ? ["README.md", ...coreDocs()] : ["README.md"];
}
