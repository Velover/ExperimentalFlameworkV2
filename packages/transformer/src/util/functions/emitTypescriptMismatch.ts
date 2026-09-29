import chalk from "chalk";
import path from "path";
import ts from "typescript";
import { Logger } from "../../classes/logger";
import { TransformState } from "../../classes/transformState";
import { getPackageJson } from "./getPackageJson";
import { isPathDescendantOf } from "./isPathDescendantOf";

function tryResolve(name: string, path: string) {
	try {
		return require.resolve(name, { paths: [path] });
	} catch (e) {}
}

function emitMessages(messages: string[]): never {
	Logger.writeLine(...messages);
	process.exit(1);
}

/**
 * Spits out information about the mismatch.
 * This should only be called after a mismatch is detected.
 */
export function emitTypescriptMismatch(state: TransformState, baseMessage: string): never {
	const messages = [baseMessage];

	// Check if they have a local install.
	const robloxTsPath = tryResolve("roblox-ts", state.rootDirectory);
	if (!robloxTsPath) {
		messages.push(
			"It is recommended that you use a local install of roblox-ts.",
			`Add ${chalk.green("roblox-ts")} to your devDependencies and install again.`,
		);
		emitMessages(messages);
	}

	// Check if they've used a global install.
	if (require.main) {
		if (!isPathDescendantOf(require.main.filename, path.join(state.rootDirectory, "node_modules"))) {
			messages.push(
				"It appears you've run the transformer using a global install.",
				`Run the project's own ${chalk.green("rbxtsc")} instead, from a package.json script or your package manager's runner.`,
			);
			emitMessages(messages);
		}
	}

	// They're using a local install
	// but they're using the wrong TypeScript version.
	const robloxTsTypeScript = tryResolve("typescript", robloxTsPath);
	if (robloxTsTypeScript) {
		const typescriptPackage = getPackageJson(robloxTsTypeScript);
		if (typescriptPackage) {
			const requiredVersion = typescriptPackage.result.version;
			if (ts.version !== requiredVersion) {
				messages.push(
					`Flamework is using TypeScript version ${ts.version}`,
					`roblox-ts requires TypeScript version ${requiredVersion}`,
					`You can fix this by pinning that version in your devDependencies, ${chalk.green(
						`"typescript": "${requiredVersion}"`,
					)}, and installing again.`,
				);
			}
		}
	}

	emitMessages(messages);
}
