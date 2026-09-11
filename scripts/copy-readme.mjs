import * as fs from "fs";
import path from "path";

// Packages whose README is their own, committed, and not the framework's: left alone.
const OWN_README = new Set(["cloud-testing"]);

for (const pkg of fs.readdirSync("./packages")) {
	if (OWN_README.has(pkg)) continue;
	fs.copyFileSync("./README.md", path.join("./packages", pkg, "README.md"));
}
