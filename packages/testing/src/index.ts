// Defining tests
export { defineTests, test, beforeEach, afterEach, getSections, DEFAULT_SECTION } from "./registry";
export type { Section, SectionContext, TestBody, TestDefinition } from "./registry";

// Inside a test
export { defer, scratch } from "./runner";
export * from "./expect";

// Running
export { Testing, BINDABLE_NAME, REMOTE_NAME } from "./host";
export { runTests, getRealm, getProject, DEFAULT_TIMEOUT, PROJECT_ATTRIBUTE } from "./runner";
export type { Realm, RunOptions, RunResult, RunnerConfig, SectionResult, TestFilter, TestResult } from "./runner";

// The plugin
export { TestingPlugin, createTestingPlugin, resolveTestingOptions, DEFAULT_TESTING_SCOPE } from "./plugin";
export type { TestingOptions, ResolvedTestingOptions } from "./plugin";

// The test harness's hooks: exported for the Luau it reaches through the package entry, and marked
// @internal like their declarations so that stripInternal leaves them out of the typings as well
// (a re-export of a stripped declaration would not type-check).
/** @internal */
export { __resetTests } from "./registry";
/** @internal */
export { __isAttached } from "./host";
