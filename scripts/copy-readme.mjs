import * as fs from "fs";
import path from "path";
import { rewriteLinks, ROOT, shippedMarkdown, withoutRepositoryOnly } from "./links.mjs";

// Packages whose README is their own, committed, and not the framework's: left alone.
const OWN_README = new Set(["testing"]);

// The root README goes into every other package, without its blocks for contributors to this
// repository (`<!-- repository only -->`). A link to a file the package also ships stays relative
// (core ships docs/README.md); every other link points at the file on GitHub (see links.mjs).
const readme = withoutRepositoryOnly(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"));

for (const pkg of fs.readdirSync(path.join(ROOT, "packages"))) {
	if (OWN_README.has(pkg)) continue;
	if (!fs.existsSync(path.join(ROOT, "packages", pkg, "package.json"))) continue;

	fs.writeFileSync(
		path.join(ROOT, "packages", pkg, "README.md"),
		rewriteLinks(readme, "README.md", shippedMarkdown(pkg)),
	);
}
