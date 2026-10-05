import type { Module } from "@flamework-experimental/core";

/**
 * What a test's body and its section's `beforeEach` and `afterEach` hooks receive: which test it is,
 * and that test's own `defer`, `scratch` and `skip`. They work as the functions of the same names
 * do, but are bound to this test, so they work in a concurrent test too, where those functions
 * cannot tell which test calls them, and from any thread the test starts.
 */
export interface TestContext {
	/** The test's name. */
	readonly name: string;

	/** The name of the test's section. */
	readonly section: string;

	/** Whether the test may run alongside others: registered with `test.concurrent`, or in a concurrent section. */
	readonly concurrent: boolean;

	/** `defer(callback)` for this test: cleanup that runs, in reverse order, once the test is over. */
	readonly defer: (this: void, callback: () => void) => void;

	/** `scratch()` for this test: its own Folder in Workspace, made on first use, destroyed afterwards. */
	readonly scratch: (this: void) => Folder;

	/** `skip(reason)` for this test: from its body or a `beforeEach`, under the same rules. */
	readonly skip: (this: void, reason: string) => never;
}

/**
 * A test body. It may yield, and a Promise it returns is awaited before the test counts as done. It
 * receives the test's context, which a body that needs nothing of it leaves out.
 */
export type TestBody = (t: TestContext) => unknown;

/** A `beforeEach` or `afterEach` hook. It receives the context of the test it runs for. */
export type TestHook = (t: TestContext) => void;

export interface SectionContext {
	/** The section's name; `"default"` for tests defined without one. */
	readonly name: string;

	/** The module whose testing plugin loaded this file, when one did. */
	readonly module?: Module;
}

/** What `defineTests(name, options, body)` takes. */
export interface SectionOptions {
	/**
	 * Every test the body registers may run alongside the others, as `test.concurrent` does. Tests
	 * the same section gets from another `defineTests` without it stay as they are.
	 */
	readonly concurrent?: boolean;
}

export interface TestDefinition {
	readonly name: string;
	readonly body: TestBody;

	/** Set for a test registered with `test.skip`: the reason it is reported as skipped without running. */
	readonly skip?: string;

	/**
	 * Set for a test that may run alongside the other concurrent tests next to it in its section:
	 * one registered with `test.concurrent`, or in a section defined with `{ concurrent: true }`.
	 */
	readonly concurrent?: boolean;
}

/** `test`, with `test.skip` and `test.concurrent` beside it. */
export interface TestFunction {
	/**
	 * Registers a test in the section being defined. Names are unique within a section. It runs
	 * alone: it waits for the tests running before it, and the tests after it wait for it.
	 */
	(this: void, name: string, body: TestBody): void;

	/**
	 * Registers a test that is reported as skipped without running: neither its body nor the
	 * section's hooks run, and its result reads `"marked with test.skip"` as the reason. It is
	 * listed, and selected by a filter, like any other test, so dropping `.skip` brings it back as
	 * it was. For a condition known only at run time, call `skip(reason)` in the test instead.
	 */
	readonly skip: (this: void, name: string, body: TestBody) => void;

	/**
	 * Registers a test that may run alongside the concurrent tests next to it in its section, up to
	 * `testing.concurrency` at once: for independent tests that spend their time waiting
	 * (`eventually`, replication, a delay). Inside it, use the context it receives (`t.defer`,
	 * `t.scratch`, `t.skip`): the functions of the same names raise while it runs, since the runner
	 * cannot tell which test a thread belongs to.
	 */
	readonly concurrent: (this: void, name: string, body: TestBody) => void;
}

/** The skip reason of a test registered with `test.skip`. */
const MARKED_SKIP = "marked with test.skip";

/**
 * A named group of tests. The same name in several files is one section: `defineTests` merges
 * them, so a feature's tests can sit next to the feature's files.
 */
export interface Section {
	readonly name: string;
	readonly tests: TestDefinition[];
	readonly beforeEach: TestHook[];
	readonly afterEach: TestHook[];
}

/** The section tests land in when `defineTests` is given no name. */
export const DEFAULT_SECTION = "default";

const sections = new Array<Section>();
const sectionsByName = new Map<string, Section>();

let current: Section | undefined;
let currentConcurrent = false;
let currentModule: Module | undefined;

function getOrCreate(name: string): Section {
	let section = sectionsByName.get(name);
	if (section === undefined) {
		section = { name, tests: [], beforeEach: [], afterEach: [] };
		sections.push(section);
		sectionsByName.set(name, section);
	}

	return section;
}

/**
 * Defines a section of tests. The body runs at once and registers tests with `test`, and hooks
 * with `beforeEach` and `afterEach`; nothing in it runs until the section is run.
 *
 * Sections do not nest, and a name may not contain `/`, which separates a section from a test in
 * a filter.
 *
 * `defineTests(name, { concurrent: true }, body)` makes every test the body registers concurrent,
 * as `test.concurrent` does.
 */
export function defineTests(section: string | undefined, body: (context: SectionContext) => void): void;
export function defineTests(
	section: string | undefined,
	options: SectionOptions,
	body: (context: SectionContext) => void,
): void;
export function defineTests(
	section: string | undefined,
	optionsOrBody: SectionOptions | ((context: SectionContext) => void),
	maybeBody?: (context: SectionContext) => void,
) {
	const name = section ?? DEFAULT_SECTION;
	if (current !== undefined) {
		error(
			`defineTests('${name}') was called inside the body of section '${current.name}'; sections do not nest`,
			2,
		);
	}

	if (name === "") {
		error("a section needs a name; pass undefined for the default section", 2);
	}

	if (name.find("/", 1, true)[0] !== undefined) {
		error(`section name '${name}' may not contain '/', which separates a section from a test in a filter`, 2);
	}

	const body = typeIs(optionsOrBody, "function") ? optionsOrBody : maybeBody;
	if (optionsOrBody !== undefined && !typeIs(optionsOrBody, "function") && !typeIs(optionsOrBody, "table")) {
		error(`the options of section '${name}' must be a table, got ${typeOf(optionsOrBody)}`, 2);
	}

	const options = (typeIs(optionsOrBody, "table") ? optionsOrBody : {}) as SectionOptions;

	if (options.concurrent !== undefined && !typeIs(options.concurrent, "boolean")) {
		error(`the concurrent option of section '${name}' must be a boolean, got ${typeOf(options.concurrent)}`, 2);
	}

	if (!typeIs(body, "function")) {
		error(`section '${name}' needs a body, a function that registers its tests`, 2);
	}

	const target = getOrCreate(name);
	current = target;
	currentConcurrent = options.concurrent === true;
	const [ok, err] = pcall(() => body({ name, module: currentModule }));
	current = undefined;
	currentConcurrent = false;

	if (!ok) {
		error(`the body of section '${name}' raised: ${err}`, 2);
	}
}

/** `level` counts from here: 3 is the caller of the function that calls this. */
function requireBody(what: string, level = 3): Section {
	if (current === undefined) {
		error(`${what} can only be called inside a defineTests body`, level);
	}

	return current;
}

/**
 * What `test`, `test.skip` and `test.concurrent` do. Called straight from each, so level 3 from
 * here is whoever called `test`: the `__call` metamethod is a frame of its own, as `test.skip` is.
 */
function register(what: string, name: string, body: TestBody, skip: string | undefined, concurrent: boolean) {
	const section = requireBody(what, 4);
	if (section.tests.some((existing) => existing.name === name)) {
		error(`section '${section.name}' already has a test named '${name}'`, 3);
	}

	const definition: { name: string; body: TestBody; skip?: string; concurrent?: boolean } = { name, body };
	if (skip !== undefined) definition.skip = skip;
	if (concurrent || currentConcurrent) definition.concurrent = true;
	section.tests.push(definition);
}

/**
 * Registers a test in the section being defined. Names are unique within a section.
 * `test.skip(name, body)` registers one that is reported as skipped without running, and
 * `test.concurrent(name, body)` one that may run alongside the concurrent tests next to it.
 *
 * A table that is called rather than a function, since a function cannot carry `skip`.
 */
export const test = setmetatable(
	{
		skip: (name: string, body: TestBody) => {
			register("test.skip()", name, body, MARKED_SKIP, false);
		},
		concurrent: (name: string, body: TestBody) => {
			register("test.concurrent()", name, body, undefined, true);
		},
	},
	{
		__call: (_, name, body) => {
			register("test()", name as string, body as TestBody, undefined, false);
		},
	},
) as unknown as TestFunction;

/**
 * Runs before every test of the section being defined, with that test's context. Raising fails
 * the test. In a concurrent test it runs alongside the other tests' hooks.
 */
export function beforeEach(callback: TestHook) {
	requireBody("beforeEach()").beforeEach.push(callback);
}

/**
 * Runs after every test of the section being defined, pass or fail, with that test's context.
 * Raising fails the test.
 */
export function afterEach(callback: TestHook) {
	requireBody("afterEach()").afterEach.push(callback);
}

/** Every section, in the order they were first defined. */
export function getSections(): readonly Section[] {
	return sections;
}

/** @internal */
export function __setCurrentModule(module: Module | undefined) {
	currentModule = module;
}

/** @internal */
export function __getCurrentModule(): Module | undefined {
	return currentModule;
}

/** @internal */
export function __resetTests() {
	sections.clear();
	sectionsByName.clear();
	current = undefined;
	currentConcurrent = false;
	currentModule = undefined;
}
