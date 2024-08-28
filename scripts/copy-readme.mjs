import * as fs from "fs";
import path from "path";

for (const pkg of fs.readdirSync("./packages")) {
	fs.copyFileSync("./README.md", path.join("./packages", pkg, "README.md"));
}
