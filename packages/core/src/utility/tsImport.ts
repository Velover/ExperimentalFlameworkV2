const tsImpl = (_G as Map<unknown, unknown>).get(script) as {
	import: (...modules: LuaSourceContainer[]) => unknown;
};

/**
 * This imports the module using the current TS runtime.
 *
 * This is necessary when loading packages which must be imported using the RuntimeLib.
 */
export function tsImport(module: ModuleScript): unknown {
	return tsImpl.import(script, module);
}
