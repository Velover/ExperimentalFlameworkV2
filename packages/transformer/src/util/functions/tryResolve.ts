import ts from "typescript";
import type { TransformState } from "../../classes/transformState";

/**
 * Resolves a module the way the compiler would from `containingFile`, returning the file it lands on.
 */
export function tryResolveTS(state: TransformState, moduleName: string, containingFile: string): string | undefined {
	const module = ts.resolveModuleName(moduleName, containingFile, state.options, ts.sys);
	return module.resolvedModule?.resolvedFileName;
}
