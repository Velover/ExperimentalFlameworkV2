import ts from "typescript";
import path from "path";
import { transformFile } from "./transformations/transformFile";
import { buildInfoFileName, TransformState } from "./classes/transformState";
import type { TransformerEntry } from "./util/projectConfig";
import { Logger } from "./classes/logger";
import { f } from "./util/factory";
import chalk from "chalk";
import { emitTypescriptMismatch } from "./util/functions/emitTypescriptMismatch";
import { PKG_VERSION } from "./util/constants";
import { getTsBuildInfoPath } from "./util/functions/isCleanBuildDirectory";

// TypeScript 5.9 stopped exporting its own `isDiagnosticWithLocation`; this is the same check.
function isDiagnosticWithLocation(diagnostic: ts.Diagnostic): diagnostic is ts.DiagnosticWithLocation {
	return diagnostic.file !== undefined && diagnostic.start !== undefined && diagnostic.length !== undefined;
}

/**
 * The transformer, as roblox-ts loads it from the tsconfig plugin entry. The entry takes only the
 * loader's own keys and `configFile`; every option is read from flamework.config.json.
 */
export default function (program: ts.Program, entry?: TransformerEntry) {
	return (context: ts.TransformationContext): ((file: ts.SourceFile) => ts.Node) => {
		if (Logger.verbose) Logger.write("\n");
		f.setFactory(context.factory);

		const state = new TransformState(program, context, entry ?? {});
		const projectFlameworkVersion = state.buildInfo.getFlameworkVersion();
		if (projectFlameworkVersion !== PKG_VERSION) {
			// Only an incremental build reuses the previous flamework.build, and it compiles only the
			// files that changed, so the others would keep what the previous version emitted. roblox-ts
			// picks those files from the tsbuildinfo before it loads the transformer, so a fresh build
			// cannot be started from here; deleting the tsbuildinfo makes the next build compile them all.
			const buildInfoFile = getTsBuildInfoPath(state.options);
			Logger.writeLine(
				`${chalk.red("Project was compiled on different version of Flamework.")}`,
				buildInfoFile !== undefined
					? `This is an incremental build, which recompiles only the files that changed. Delete ${buildInfoFileName(state.currentDirectory, state.options)} and build again: the next build compiles every file.`
					: `Please recompile by deleting the ${path.relative(state.currentDirectory, state.outDir).replace(/\\/g, "/")} directory`,
				`Current Flamework Version: ${chalk.yellow(PKG_VERSION)}`,
				`Previous Flamework Version: ${chalk.yellow(projectFlameworkVersion)}`,
			);
			process.exit(1);
		}

		setTimeout(() => state.saveArtifacts());
		return (file: ts.SourceFile) => {
			if (!ts.isSourceFile(file)) {
				emitTypescriptMismatch(state, chalk.red("Failed to load! TS version mismatch detected"));
			}

			if (state.config.noSemanticDiagnostics !== true) {
				const originalFile = ts.getParseTreeNode(file, ts.isSourceFile);
				if (originalFile) {
					const preEmitDiagnostics = ts.getPreEmitDiagnostics(program, originalFile);
					if (preEmitDiagnostics.some((x) => x.category === ts.DiagnosticCategory.Error)) {
						preEmitDiagnostics
							.filter(isDiagnosticWithLocation)
							.forEach((diag) => context.addDiagnostic(diag));
						return file;
					}
				} else {
					const relativeName = path.relative(state.srcDir, file.fileName);
					Logger.warn(`Failed to validate '${relativeName}' due to lack of parse tree node.`);
				}
			}

			return transformFile(state, file);
		};
	};
}
