import { HttpService, Workspace } from "@rbxts/services";
import { getRuntimeConfig, importModule, resolveRbxPath } from "@flamework-experimental/core";
import { BINDABLE_NAME } from "./host";
import type { RunOptions, RunResult, TestFilter } from "./runner";

/** How long to wait for the bindable after the entry's `ignite()` has run. */
const ENTRY_WAIT = 30;

/**
 * The entry point for an Open Cloud Luau execution task, which loads the place but runs none of
 * its Scripts. The task's script requires this module and calls `run`; nothing in the game is
 * named. When `Workspace.FlameworkTests` is not there yet, the ModuleScript `testing.entry` names
 * in `flamework.config.json` is required and its exported `ignite()` called, which is what the
 * game's own entry Script would have done.
 *
 * Returns the run's result as JSON, which is what a task can return.
 */
export function run(filter?: TestFilter, options?: RunOptions): string {
	let bindable = Workspace.FindFirstChild(BINDABLE_NAME);
	if (bindable === undefined) {
		const entry = getRuntimeConfig().testing?.entry;
		if (entry === undefined) {
			error(
				`Workspace.${BINDABLE_NAME} does not exist and flamework.config.json has no testing.entry: nothing in a cloud task starts the game, so name the ModuleScript that exports ignite()`,
				0,
			);
		}

		const moduleScript = resolveRbxPath(entry);
		if (!moduleScript.IsA("ModuleScript")) {
			error(
				`testing.entry resolves to ${moduleScript.GetFullName()}, which is a ${moduleScript.ClassName}, not a ModuleScript`,
				0,
			);
		}

		const loaded = importModule(moduleScript);
		const ignite = typeIs(loaded, "table") ? (loaded as { ignite?: unknown }).ignite : undefined;
		if (!typeIs(ignite, "function")) {
			error(`${moduleScript.GetFullName()} does not export ignite()`, 0);
		}

		(ignite as () => void)();

		bindable = Workspace.WaitForChild(BINDABLE_NAME, ENTRY_WAIT);
		if (bindable === undefined) {
			error(
				`ignite() ran but Workspace.${BINDABLE_NAME} did not appear within ${ENTRY_WAIT} seconds: is testing.enabled true, and is the TestingPlugin included in that module?`,
				0,
			);
		}
	}

	const result = (bindable as BindableFunction).Invoke(filter, options) as RunResult;
	return HttpService.JSONEncode(result);
}
