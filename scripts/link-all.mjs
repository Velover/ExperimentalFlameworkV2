import * as fs from "fs";
import * as childprocess from "child_process";
import path from "path";

for (const pkg of fs.readdirSync("./packages")) {
	childprocess.spawn("npm link", {
		shell: true,
		cwd: path.join(import.meta.dirname, "../packages", pkg),
		stdio: "inherit",
	});
}
