// Defining tests
export { defineTests, test, beforeEach, afterEach, getSections, DEFAULT_SECTION, __resetTests } from "./registry";
export type { Section, SectionContext, TestBody, TestDefinition } from "./registry";

// Inside a test
export { defer, scratch } from "./runner";
export * from "./expect";

// Running
export { Testing, BINDABLE_NAME, REMOTE_NAME, __isAttached } from "./host";
export { runTests, getRealm, DEFAULT_TIMEOUT } from "./runner";
export type { Realm, RunOptions, RunResult, RunnerConfig, SectionResult, TestFilter, TestResult } from "./runner";

// The plugin
export { TestingPlugin, createTestingPlugin, resolveTestingOptions, DEFAULT_TESTING_SCOPE } from "./plugin";
export type { TestingOptions, ResolvedTestingOptions } from "./plugin";
