import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Pins what code compiled against one 2.x release expects of the packages at a later one: the ids
 * the transformer derives from where a package declares something, and the runtime names the code it
 * emits imports or calls (docs/stability.md).
 *
 * A library compiled against core 2.0 holds these strings in its Luau. If a later 2.x moved
 * `lifecycleInterfaces.ts`, the library's providers would silently stop receiving `onStart`; if
 * components moved `baseComponent.ts`, every attribute write in the library would fail to load. One
 * release always matches itself, so no other test sees either. Only 3.0 may change what is listed
 * here; a new id or name is added to the lists in the release that ships it, and frozen from then.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const PACKAGES = { core: "$", components: "$c", networking: "$n", testing: "$T" } as const;
type Package = keyof typeof PACKAGES;

const BREAKS =
	"breaks code compiled against an earlier 2.x, which holds it. Only 3.0 may change it: undo the move or rename.";

/**
 * The id of every class and interface the package entries export, as the transformer derives it
 * (transformer/src/util/uid.ts): `<prefix>:<file under out, without extension, index as init>@<name>`,
 * the name after the namespaces it is declared in; one marked `@hidden` or `@internal` is left out. A game or library that names one (`Dependency<T>()`,
 * `implements`, `Flamework.id<T>()`, `module.listen<T>()`) compiles the string in.
 */
const FROZEN_IDS = [
	"$:injectable@InjectableDecoratorConfig",
	"$:lifecycle/lifecycleInterfaces@OnExtinguished",
	"$:lifecycle/lifecycleInterfaces@OnInit",
	"$:lifecycle/lifecycleInterfaces@OnPhysics",
	"$:lifecycle/lifecycleInterfaces@OnRender",
	"$:lifecycle/lifecycleInterfaces@OnStart",
	"$:lifecycle/lifecycleInterfaces@OnTick",
	"$:lifecycle/lifecyclePlugin@LifecyclePluginOptions",
	"$:lifecycle/lifecyclePlugin@LifecycleProvider",
	"$:modding@Modding.DependencyInfo",
	"$:module/module@Module",
	"$:module/moduleBuilder@ModuleBuilder",
	"$:module/moduleDefinition@IgniteOptions",
	"$:module/moduleDefinition@ModuleDefinition",
	"$:module/moduleDefinition@ProviderRegistrationOptions",
	"$:module/moduleHooks@HookOptions",
	"$:module/scopes@ScopeCondition",
	"$:plugin/pluginDefinition@InterfaceConfiguration",
	"$:plugin/pluginDefinition@InterfaceContext",
	"$:plugin/pluginDefinition@PluginDefinition",
	"$:plugin/pluginDefinition@PluginTarget",
	"$:provider@ProviderDecoratorConfig",
	"$:serialization/types@Serialization.Serializer",
	"$:serialization/types@Serialization.SerializerOptions",
	"$:utility/runtimeConfig@ComponentsRuntimeConfig",
	"$:utility/runtimeConfig@CoreRuntimeConfig",
	"$:utility/runtimeConfig@NetworkingRuntimeConfig",
	"$:utility/runtimeConfig@RuntimeConfig",
	"$:utility/runtimeConfig@ScopesRuntimeConfig",
	"$:utility/runtimeConfig@TestingRuntimeConfig",
	"$c:baseComponent@BaseComponent",
	"$c:baseComponent@ComponentMetadata",
	"$c:componentModule@ComponentPlugin",
	"$c:components@Components",
	"$c:decorator@ComponentConfig",
	"$c:decorator@ComponentLink",
	"$c:instanceTree@InstanceShape",
	"$T:plugin@TestingOptions",
	"$T:registry@Section",
	"$T:registry@SectionContext",
	"$T:registry@SectionOptions",
	"$T:registry@TestContext",
	"$T:registry@TestDefinition",
	"$T:registry@TestFunction",
	"$T:runner@RunOptions",
	"$T:runner@RunResult",
	"$T:runner@SectionResult",
	"$T:runner@TestResult",
];

/**
 * The ids the packages' own Luau compares against, so code compiled elsewhere has to carry the same
 * ones: the lifecycle plugin observes the lifecycle interfaces, modules answer `Module`, and
 * components resolves its providers and builds components by these.
 */
const COMPARED_IDS = [
	"$:lifecycle/lifecycleInterfaces@OnExtinguished",
	"$:lifecycle/lifecycleInterfaces@OnInit",
	"$:lifecycle/lifecycleInterfaces@OnPhysics",
	"$:lifecycle/lifecycleInterfaces@OnRender",
	"$:lifecycle/lifecycleInterfaces@OnStart",
	"$:lifecycle/lifecycleInterfaces@OnTick",
	"$:lifecycle/lifecyclePlugin@LifecycleProvider",
	"$:module/module@Module",
	"$c:baseComponent@BaseComponent",
	"$c:baseComponent@ComponentMetadata",
	"$c:components@Components",
];

/**
 * Ids compiled into a package that only the same package's code uses: injected between its own
 * classes, which are always of one release. They may change in a minor release.
 */
const PRIVATE_IDS = ["$c:componentModule@ComponentModuleConfig"];

function luauFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...luauFiles(full));
		else if (entry.name.endsWith(".luau")) files.push(full);
	}
	return files;
}

const read = (file: string) => fs.readFileSync(path.join(ROOT, "packages", file), "utf8");
const out = (pkg: Package) => path.join(ROOT, "packages", pkg, "out");

/** Fails with one line per problem, so that the message says what broke and what to do. */
function expectNoProblems(problems: string[]) {
	if (problems.length > 0) throw new Error(`\n${problems.join("\n")}`);
	expect(problems).toEqual([]);
}

/** The ids of the classes and interfaces a package's typings entry exports, derived as uid.ts does. */
function entryIds(pkg: Package): string[] {
	const outDir = out(pkg);
	const entry = path.join(outDir, "index.d.ts");
	const program = ts.createProgram([entry], {
		noLib: true,
		types: [],
		moduleResolution: ts.ModuleResolutionKind.Node10,
		experimentalDecorators: true,
	});
	const checker = program.getTypeChecker();
	const ids = new Set<string>();
	const seen = new Set<ts.Symbol>();

	const visit = (exported: ts.Symbol) => {
		const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
		if (seen.has(symbol)) return;
		seen.add(symbol);

		for (const declaration of symbol.declarations ?? []) {
			const file = path.resolve(declaration.getSourceFile().fileName);
			if (!file.startsWith(outDir + path.sep)) continue;

			// One marked @hidden or @internal is outside the promise (docs/stability.md).
			const hidden = ts
				.getJSDocTags(declaration)
				.some((tag) => ["hidden", "internal"].includes(tag.tagName.text));
			if (hidden) continue;

			if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
				let name = declaration.name!.text;
				for (let parent = declaration.parent; parent !== undefined; parent = parent.parent) {
					if (ts.isModuleDeclaration(parent) && ts.isIdentifier(parent.name))
						name = `${parent.name.text}.${name}`;
				}
				const relative = path
					.relative(outDir, file)
					.split(path.sep)
					.join("/")
					.replace(/\.d\.ts$/, "")
					.replace(/(^|\/)index$/, "$1init");
				ids.add(`${PACKAGES[pkg]}:${relative}@${name}`);
			} else if (ts.isModuleDeclaration(declaration)) {
				checker.getExportsOfModule(symbol).forEach(visit);
			}
		}
	};

	const module = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
	checker.getExportsOfModule(module).forEach(visit);
	return [...ids].sort();
}

/** Every id compiled into a package: the strings in its Luau, and the table in its flamework.build. */
function compiledIds(pkg: Package): Map<string, string> {
	const ids = new Map<string, string>();
	for (const file of luauFiles(out(pkg))) {
		for (const match of fs.readFileSync(file, "utf8").matchAll(/"(\$[A-Za-z]*:[^"\s]+@[^"\s]+)"/g)) {
			ids.set(match[1], path.relative(ROOT, file).replace(/\\/g, "/"));
		}
	}

	const buildInfo = JSON.parse(read(`${pkg}/flamework.build`)) as { identifiers: Record<string, string> };
	for (const id of Object.values(buildInfo.identifiers)) {
		if (!ids.has(id)) ids.set(id, `packages/${pkg}/flamework.build`);
	}
	return ids;
}

describe("package ids (frozen for 2.x)", () => {
	const derived = (Object.keys(PACKAGES) as Package[]).flatMap(entryIds);
	const compiled = new Map((Object.keys(PACKAGES) as Package[]).flatMap((pkg) => [...compiledIds(pkg)]));

	test("every class and interface the entries export keeps its id", () => {
		const problems = [
			...FROZEN_IDS.filter((id) => !derived.includes(id)).map(
				(id) =>
					`${id} is no longer exported from that file under that name: a moved file or a renamed or removed declaration ${BREAKS}`,
			),
			...derived
				.filter((id) => !FROZEN_IDS.includes(id))
				.map((id) => `${id} is new: add it to FROZEN_IDS, frozen from the release that ships it.`),
		];
		expectNoProblems(problems);
	});

	test("the ids the packages compare against are still compiled into them", () => {
		const problems = COMPARED_IDS.filter((id) => !compiled.has(id)).map(
			(id) =>
				`${id} is no longer in the packages' Luau or flamework.build: a moved file or a renamed declaration ${BREAKS}`,
		);
		expectNoProblems(problems);
	});

	test("every id compiled into the packages is pinned", () => {
		// What the transformer itself wrote, so this also checks that entryIds derives ids as it does.
		const problems = [...compiled]
			.filter(([id]) => !FROZEN_IDS.includes(id) && !PRIVATE_IDS.includes(id))
			.map(
				([id, where]) =>
					`${id} (in ${where}) is not pinned: add it to FROZEN_IDS if code outside the package can name it, else to PRIVATE_IDS.`,
			);
		expectNoProblems(problems);
	});
});

/**
 * The runtime names emitted code imports or calls. A game's or library's Luau requires these modules
 * and calls these members by name.
 */
describe("runtime names emitted code reaches (frozen for 2.x)", () => {
	/** Where a member is defined: the file `init.luau` re-exports `name` from, for a namespace of core. */
	const exportedFrom = (name: string) => {
		const match = new RegExp(`exports\\.${name} = TS\\.import\\(script, script, ([^)]*)\\)\\.${name}`).exec(
			read("core/out/init.luau"),
		);
		if (!match) return undefined;
		const segments = [...match[1].matchAll(/"([^"]+)"/g)].map((segment) => segment[1]);
		return `core/out/${segments.join("/")}.luau`;
	};

	const CORE_NAMESPACE_MEMBERS: [namespace: string, member: string, why: string][] = [
		["Reflect", "defineMetadata", "every class with metadata calls it"],
		["Flamework", "_implements", "Flamework.implements<T>() is rewritten to it"],
	];

	test.each(CORE_NAMESPACE_MEMBERS)("core's entry exports %s.%s (%s)", (namespace, member) => {
		const file = exportedFrom(namespace);
		const problems: string[] = [];
		if (file === undefined) {
			problems.push(`@flamework-experimental/core no longer exports ${namespace} from its entry: this ${BREAKS}`);
		} else if (!new RegExp(`_container\\.${member} = `).test(read(file))) {
			problems.push(`${namespace}.${member} is no longer defined in ${file}: renaming it ${BREAKS}`);
		}
		expectNoProblems(problems);
	});

	const MODULE_EXPORTS: [module: string, file: string, name: string][] = [
		// Generated guards import `t` through it, when the game resolves a different @rbxts/t than core.
		["@flamework-experimental/core/out/prelude", "core/out/prelude.luau", "t"],
		// Every write to a component's `attributes` calls it.
		[
			"@flamework-experimental/components/out/baseComponent",
			"components/out/baseComponent.luau",
			"SYMBOL_ATTRIBUTE_SETTER",
		],
	];

	test.each(MODULE_EXPORTS)("%s (%s) exports %s", (module, file, name) => {
		const full = path.join(ROOT, "packages", file);
		const problems: string[] = [];
		if (!fs.existsSync(full)) {
			problems.push(`${module} is gone (${file}): moving it ${BREAKS}`);
		} else if (!new RegExp(`^\\s*${name} = ${name},?$`, "m").test(fs.readFileSync(full, "utf8"))) {
			problems.push(`${module} no longer exports ${name}: renaming it ${BREAKS}`);
		}
		expectNoProblems(problems);
	});

	// The hidden members a send or `setCallback` is rewritten to call on a networking handler.
	const HANDLER_MEMBERS = ["_fire", "_except", "_broadcast", "_invoke", "_invokeWithTimeout", "_setCallback"];

	test("networking's handlers define the members emitted sends call", () => {
		const source = luauFiles(out("networking"))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const problems = HANDLER_MEMBERS.filter((name) => !new RegExp(`\\b${name} = function\\(self`).test(source)).map(
			(name) => `networking's handlers no longer define ${name}: renaming it ${BREAKS}`,
		);
		expectNoProblems(problems);
	});

	// The metadata keys emitted classes carry that the runtime reads.
	const METADATA_KEYS = [
		"identifier",
		"flamework:implements",
		"flamework:dependencies",
		"flamework:parameters",
		"flamework:module",
	];

	test("the runtime still reads the metadata keys emitted classes carry", () => {
		const source = (["core", "components"] as const)
			.flatMap((pkg) => luauFiles(out(pkg)))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const problems = METADATA_KEYS.filter((key) => !source.includes(`"${key}"`)).map(
			(key) =>
				`core and components no longer read the metadata key "${key}": a class compiled earlier carries it, so this ${BREAKS}`,
		);
		expectNoProblems(problems);
	});

	test("the transformer emits nothing else that reaches the runtime", () => {
		// A name the transformer starts to emit is frozen from the release that ships it: pin it above.
		const transformer = path.join(ROOT, "packages", "transformer", "src");
		const sources = (function walk(dir: string): string[] {
			return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = path.join(dir, entry.name);
				return entry.isDirectory()
					? walk(full)
					: entry.name.endsWith(".ts")
						? [fs.readFileSync(full, "utf8")]
						: [];
			});
		})(transformer).join("\n");
		const networking = fs.readFileSync(
			path.join(transformer, "transformations", "transformNetworkingCall.ts"),
			"utf8",
		);
		const rewrites = fs.readFileSync(path.join(out("core"), "flamework.d.ts"), "utf8");

		const found = {
			subpaths: new Set(
				[...sources.matchAll(/\$\{(CORE|COMPONENTS|NETWORKING)_PACKAGE\}(\/out\/[\w/]+)/g)].map(
					(match) => `@flamework-experimental/${match[1].toLowerCase()}${match[2]}`,
				),
			),
			imports: new Set(
				// The calls (`state.addFileImport(...)`), not the method's own declaration.
				[...sources.matchAll(/\.addFileImport\([^;]*?,\s*"(\w+)",?\s*\)/g)].map((match) => match[1]),
			),
			members: new Set([...networking.matchAll(/"(_(?!flamework_)\w+)"/g)].map((match) => match[1])),
			rewrites: new Set(
				[...rewrites.matchAll(/\{@link (\w+) intrinsic-flamework-rewrite\}/g)].map((match) => match[1]),
			),
		};

		expect({
			subpaths: [...found.subpaths].sort(),
			imports: [...found.imports].sort(),
			members: [...found.members].sort(),
			rewrites: [...found.rewrites].sort(),
		}).toEqual({
			subpaths: MODULE_EXPORTS.map(([module]) => module).sort(),
			imports: ["Reflect", "SYMBOL_ATTRIBUTE_SETTER", "t"],
			members: [...HANDLER_MEMBERS].sort(),
			rewrites: CORE_NAMESPACE_MEMBERS.filter(([namespace]) => namespace === "Flamework").map(
				([, member]) => member,
			),
		});
	});
});
