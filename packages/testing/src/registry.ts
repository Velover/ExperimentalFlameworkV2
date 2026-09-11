import type { Module } from "@flamework-experimental/core";

/** A test body. It may yield, and a Promise it returns is awaited before the test counts as done. */
export type TestBody = () => unknown;

export interface SectionContext {
	/** The section's name; `"default"` for tests defined without one. */
	readonly name: string;

	/** The module whose testing plugin loaded this file, when one did. */
	readonly module?: Module;
}

export interface TestDefinition {
	readonly name: string;
	readonly body: TestBody;
}

/**
 * A named group of tests. The same name in several files is one section: `defineTests` merges
 * them, so a feature's tests can sit next to the feature's files.
 */
export interface Section {
	readonly name: string;
	readonly tests: TestDefinition[];
	readonly beforeEach: Array<() => void>;
	readonly afterEach: Array<() => void>;
}

/** The section tests land in when `defineTests` is given no name. */
export const DEFAULT_SECTION = "default";

const sections = new Array<Section>();
const sectionsByName = new Map<string, Section>();

let current: Section | undefined;
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
 */
export function defineTests(section: string | undefined, body: (context: SectionContext) => void) {
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

	const target = getOrCreate(name);
	current = target;
	const [ok, err] = pcall(() => body({ name, module: currentModule }));
	current = undefined;

	if (!ok) {
		error(`the body of section '${name}' raised: ${err}`, 2);
	}
}

function requireBody(what: string): Section {
	if (current === undefined) {
		error(`${what} can only be called inside a defineTests body`, 3);
	}

	return current;
}

/** Registers a test in the section being defined. Names are unique within a section. */
export function test(name: string, body: TestBody) {
	const section = requireBody("test()");
	if (section.tests.some((existing) => existing.name === name)) {
		error(`section '${section.name}' already has a test named '${name}'`, 2);
	}

	section.tests.push({ name, body });
}

/** Runs before every test of the section being defined. Raising fails the test. */
export function beforeEach(callback: () => void) {
	requireBody("beforeEach()").beforeEach.push(callback);
}

/** Runs after every test of the section being defined, pass or fail. Raising fails the test. */
export function afterEach(callback: () => void) {
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
	currentModule = undefined;
}
