// Defining tests
export { defineTests, test, beforeEach, afterEach, DEFAULT_SECTION } from "./registry";
export type {
	Section,
	SectionContext,
	SectionOptions,
	TestBody,
	TestContext,
	TestDefinition,
	TestFunction,
	TestHook,
} from "./registry";

// Inside a test
export { defer, scratch, skip } from "./runner";
export * from "./expect";

// Running
export { Testing, BINDABLE_NAME, REMOTE_NAME } from "./host";
export { getRealm, getProject, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT, PROJECT_ATTRIBUTE } from "./runner";
export type { Realm, RunOptions, RunResult, SectionResult, TestFilter, TestResult, TestStatus } from "./runner";

// The plugin
export { TestingPlugin, createTestingPlugin, DEFAULT_TESTING_SCOPE } from "./plugin";
export type { TestingOptions } from "./plugin";

// The runner and the plugin's internals: exported for the Luau (the specs reach them through a cast),
// left out of the typings (stripInternal), and outside the stability promise (docs/stability.md).
/** @internal */
export { getSections } from "./registry";
/** @internal */
export { runTests } from "./runner";
/** @internal */
export type { RunnerConfig } from "./runner";
/** @internal */
export { resolveTestingOptions } from "./plugin";
/** @internal */
export type { ResolvedTestingOptions } from "./plugin";

// The test harness's hooks: exported for the Luau it reaches through the package entry, and marked
// @internal like their declarations so that stripInternal leaves them out of the typings as well
// (a re-export of a stripped declaration would not type-check).
/** @internal */
export { __resetTests } from "./registry";
/** @internal */
export { __isAttached } from "./host";
