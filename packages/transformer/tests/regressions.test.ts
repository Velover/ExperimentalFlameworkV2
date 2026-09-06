import { beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { compileFixture, compileFixtureFresh, compileProbe, emitted, normalize } from "./compile";

const FIXTURE = path.resolve(import.meta.dir, "fixture");

beforeAll(() => {
	const result = compileFixture();
	if (result.status !== 0) {
		throw new Error(`fixture failed to compile:\n${result.output}`);
	}
});

describe("inherited constructors", () => {
	test("resolves a generic base's parameter to the type argument at the subclass", () => {
		// Regression: read as `T`, this crashed rbxtsc with a TypeError inside the emitter.
		const source = normalize(emitted("inherited"));

		expect(source).toContain('Reflect.defineMetadata(Derived, "flamework:parameters", { "fw:inherited@Dep" })');
		expect(source).toMatch(
			/defineMetadata\(Derived, "flamework:dependencies", \{ \{ id = "fw:inherited@Dep",? \},? \}\)/,
		);

		// The generic base's own constructor cannot resolve `T`; it gets a named placeholder instead of
		// failing the build, since only its subclasses are ever constructed.
		expect(source).toContain('Reflect.defineMetadata(GenericBase, "flamework:parameters", { "$tp:T" })');
	});
});

describe("guard emission", () => {
	test("uses the list variants beyond two members", () => {
		const source = normalize(emitted("guards"));

		expect(source).toContain('t.literalList({ "a", "b", "c", "d", "e" })');
		expect(source).toContain("t.unionList({ t.string, t.number, t.Vector3 })");
	});

	test("keeps the vararg form for two members", () => {
		expect(emitted("guards")).toContain("t.union(t.string, t.number)");
	});

	test("deduplicates a type repeated past the configured limit", () => {
		const source = normalize(emitted("dedup"));

		// `Point` is hoisted into one local and referenced by each field.
		expect(source).toMatch(/local Point\w* = t\.interface\(\{ x = t\.number, y = t\.number, \}\)/);
		expect(source).toMatch(/t\.interface\(\{ a = Point\w*, b = Point\w*, c = Point\w*, \}\)/);
		expect(source.match(/t\.interface\(\{ x = t\.number/g) ?? []).toHaveLength(1);
	});
});

describe("callsite uuids", () => {
	function uuids(source: string) {
		return [...source.matchAll(/callsiteId\("([0-9a-f-]{36})"\)/g)].map((m) => m[1]);
	}

	test("gives distinct callsites distinct ids", () => {
		const ids = uuids(emitted("callsites"));

		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
	});

	test("emits the same ids on a second compilation", () => {
		// Regression: `randomUUID()` per compile renamed every remote folder on every build.
		const before = uuids(emitted("callsites"));

		const fresh = compileFixtureFresh();
		if (fresh.status !== 0) {
			throw new Error(`fixture failed to recompile:\n${fresh.output}`);
		}

		expect(uuids(emitted("callsites"))).toEqual(before);
	});
});

describe("glob registration", () => {
	test("records the paths a glob matched in the build info", () => {
		const buildInfo = JSON.parse(fs.readFileSync(path.join(FIXTURE, "flamework.build"), "utf8"));
		const paths: string[] | undefined = buildInfo.metadata?.globs?.paths?.["src/glob/**/*.ts"];

		expect(paths).toBeDefined();
		expect(paths!.some((p) => p.replace(/\\/g, "/").startsWith("out/glob/target"))).toBe(true);
	});

	test("passes the glob through to the runtime as a string", () => {
		expect(emitted("globs")).toContain('registerProvidersGlob("src/glob/**/*.ts", "src/glob/**/*.ts")');
	});
});

describe("plugin host", () => {
	test("loads a plugin for a second transformer state in the same process", async () => {
		// Regression: the host relied on `require` re-running the plugin's top level, which Node's
		// module cache prevents, so every watch-mode rebuild failed with "did not call registerPlugin()".
		const { createPluginHost } = await import("../out/transformations/plugins/pluginHost.js");

		const state = {
			config: { plugins: [{ path: "./fieldInfoPlugin.cjs", options: { prefix: "" } }] },
			rootDirectory: FIXTURE,
			typeChecker: undefined,
			nextRootStatements: [],
		} as never;

		const first = createPluginHost(state);
		const second = createPluginHost(state);

		expect(first?.getRegisteredMacroTypes()).toContain("fieldInfo");
		expect(second?.getRegisteredMacroTypes()).toContain("fieldInfo");
	});
});

describe("callsite luau line", () => {
	test("reads the emitted line at the callsite instead of baking in the TypeScript one", () => {
		// `debug.info(1, "l")` in the caller's function is the line of the call in the emitted script,
		// which is what the console and tracebacks report. Indexing the tuple's first value truncates it
		// to one result.
		expect(emitted("callsites")).toMatch(/emittedLine = luauLine\(\(debug\.info\(1, "l"\)\)\)/);
	});
});

describe("constant callsite metadata", () => {
	test("hoists Constant metadata to the file root whether or not it is wrapped in Emit", () => {
		const source = normalize(emitted("constant"));

		// Regression: `Constant<Emit<T>>` has both markers and the `Emit` one was found first, so the
		// documented form was rebuilt on every call instead of being shared.
		expect(source).toMatch(/local withEmit_\d+ = \{ marker = true, \}/);
		expect(source).toMatch(/withEmit\(withEmit_\d+\)/);
		expect(source).toMatch(/local plain_\d+ = \{ marker = true, \}/);
		expect(source).toMatch(/plain\(plain_\d+\)/);
	});
});

describe("component links", () => {
	test("stores an instance-valued attribute as a handle and links the instance it names", () => {
		const source = normalize(emitted("components"));

		// The attribute holds an `InstanceHandle`, so that is what the attribute guard checks. The
		// class it has to resolve to is checked by the link instead.
		expect(source).toContain(`Target = t.typeof("InstanceHandle")`);
		expect(source).toContain(`Spare = t.optional(t.typeof("InstanceHandle"))`);
		expect(source).toContain(
			`kind = "attribute", name = "Target", optional = false, guard = t.instanceIsA("BasePart"),`,
		);
		expect(source).toContain(`kind = "attribute", name = "Spare", optional = true, guard = t.instanceIsA("Part"),`);
	});

	test("links the component an attribute names, by its identifier", () => {
		expect(normalize(emitted("components"))).toContain(
			`kind = "attribute", name = "Handler", optional = false, guard = t.instanceIsA("BasePart"), component = "fw:components@HandlerComponent",`,
		);
	});

	test("links a component named by the instance tree, guarding the child as its instance", () => {
		const source = normalize(emitted("components"));

		// The child's own class is part of the instance guard, so the link only has to name the
		// component that must be attached to it.
		expect(source).toContain(`EffectHandler = t.instanceIsA("BasePart")`);
		expect(source).toContain(
			`kind = "child", name = "EffectHandler", optional = false, component = "fw:components@HandlerComponent",`,
		);
	});

	test("leaves an attribute that asks for the handle itself unlinked", () => {
		const source = normalize(emitted("components"));

		expect(source).toContain(`Raw = t.typeof("InstanceHandle")`);
		expect(source).not.toContain(`name = "Raw"`);
	});

	test("rewrites writes to an attribute into the component's setter", () => {
		const source = normalize(emitted("components"));

		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "label", "renamed")`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "speed", self.attributes.speed + 1)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "speed", self.attributes.speed + 1, true)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "label", nil)`);
		expect(source).toContain(`self[SYMBOL_ATTRIBUTE_SETTER](self, "Target", part)`);
	});

	test("rejects a component that is not a direct child of the instance tree", () => {
		const result = compileProbe(
			"nestedLink",
			`import { BaseComponent, Component } from "@flamework/components";
import { HandlerComponent } from "./components";

@Component({ tag: "FixtureNested" })
export class NestedComponent extends BaseComponent<{}, Model & { Core: Folder & { Handler: HandlerComponent } }> {}
`,
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("which is not a direct child of this component");
	});
});
