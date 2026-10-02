import { ComponentPlugin, type Components } from "@flamework-experimental/components";
import { Flamework, type LifecycleProvider, OnStart, Provider } from "@flamework-experimental/core";
import {
	defineTests,
	expectEqual,
	expectFalse,
	expectThrows,
	expectTrue,
	fail,
	test,
} from "@flamework-experimental/testing";
import { deepIds } from "server/Discovery/nested/deep";
import { DupLedger } from "server/Fixtures/duplicateProviders";
import { mark } from "server/Fixtures/markSite";

/** This module as a call site names it: `debug.info` gives a ModuleScript's full name as its source. */
const HERE = script.GetFullName();

/** Where the packages sit in the place, as the project file maps them. */
const PACKAGES = "ReplicatedStorage.rbxts_include.node_modules.@flamework-experimental.";

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

function startsWith(text: string, prefix: string) {
	return text.sub(1, prefix.size()) === prefix;
}

/** The line of the message that starts with `label`, without its indentation. */
function lineOf(message: string, label: string): string {
	for (const line of message.split("\n")) {
		const [trimmed] = line.gsub("^%s+", "");
		if (startsWith(trimmed, label)) {
			return trimmed;
		}
	}

	return fail(`no '${label}' line in: ${message}`);
}

/**
 * The error's lines, each checked whole: first and second as given, and the hint starting as
 * given. No call site it names is one of core's own frames.
 */
function expectDuplicate(
	message: string,
	expected: { module: string; id: string; first: string; second: string; hint: string },
) {
	expectTrue(
		contains(message, `module '${expected.module}': provider ID was registered more than once: ${expected.id}\n`),
		`the first line, in: ${message}`,
	);
	expectEqual(lineOf(message, "first:"), `first:  ${expected.first}`, "the first registration");
	expectEqual(lineOf(message, "second:"), `second: ${expected.second}`, "the second registration");
	expectTrue(startsWith(lineOf(message, "hint:"), `hint: ${expected.hint}`), `the hint, in: ${message}`);
	expectFalse(contains(message, `, at ${PACKAGES}core.`), `a call site in core, in: ${message}`);
}

/** The lines `mark` recorded are this script's, each registration on a line of its own. */
function expectSitesHere(sites: string[], count: number) {
	expectEqual(sites.size(), count, "registrations made");
	for (const site of sites) {
		const line = site.sub(HERE.size() + 2);
		expectTrue(startsWith(site, `${HERE}:`) && line.match("^%d+$")[0] !== undefined, `a line of ${HERE}: ${site}`);
	}
	expectEqual(new Set(sites).size(), count, `a line per registration: ${sites.join(", ")}`);
}

/**
 * The error two registrations under one id raise, in a real place: the call sites it names are
 * this script's lines, as `debug.info` names a ModuleScript, past every frame of core's own that
 * sits between them and the registration, and only core's (the Lune `duplicate ids` suite names
 * chunks loaded from strings instead). Each case builds a module of its own that fails to ignite.
 */
@Provider({ activeIn: ["testing"] })
export class DuplicateIdTests implements OnStart {
	onStart() {
		defineTests("duplicate ids", () => {
			test("two registrations under one id name both, each at the line of this script that made it", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Ledgers");
				builder.registerClassProvider(mark(sites, DupLedger));
				builder.registerClassProvider(mark(sites, DupLedger));
				const message = expectThrows(() => builder.ignite(), "two registrations under one id");

				expectSitesHere(sites, 2);
				expectDuplicate(message, {
					module: "Ledgers",
					id: Flamework.id<DupLedger>(),
					first: `registerClassProvider(DupLedger) from the module builder, at ${sites[0]}`,
					second: `registerClassProvider(DupLedger) from the module builder, at ${sites[1]}`,
					hint: "the same class is registered twice: keep one of the two registrations.",
				});
			});

			test("a plugin's registration names the plugin and the line in its setup", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Books");
				builder.registerClassProvider(mark(sites, DupLedger));
				builder.includePlugin(
					Flamework.createPlugin("Ledgers", (target) => {
						target.registerClassProvider(mark(sites, DupLedger));
					}),
				);
				const message = expectThrows(
					() => builder.ignite(),
					"a plugin registering a class the builder registered",
				);

				// The builder's registration is made where it is written; the plugin's, as it is set up.
				expectSitesHere(sites, 2);
				expectDuplicate(message, {
					module: "Books",
					id: Flamework.id<DupLedger>(),
					first: `registerClassProvider(DupLedger) from the module builder, at ${sites[0]}`,
					second: `registerClassProvider(DupLedger) from plugin 'Ledgers', at ${sites[1]}`,
					hint: "the same class is registered twice: keep one of the two registrations.",
				});
			});

			test("what the lifecycle plugin provides names the plugin and no line", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Lifecycle");
				builder.registerProvider<LifecycleProvider>(mark(sites, { type: "function", callback: () => 1 }));
				const message = expectThrows(
					() => builder.ignite(),
					"a registration under the lifecycle provider's id",
				);

				expectSitesHere(sites, 1);
				expectDuplicate(message, {
					module: "Lifecycle",
					id: Flamework.id<LifecycleProvider>(),
					first: "provideInstance(value: LifecycleProvider) from plugin 'Lifecycle'",
					second: `registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
					hint: "the id is both provided and registered: keep one",
				});
			});

			test("what another package's plugin provides names that package's line: only core's frames are skipped", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Components");
				builder.includePlugin(ComponentPlugin.fromPath("src/server/Discovery"));
				builder.registerProvider<Components>(mark(sites, { type: "function", callback: () => 1 }));
				const message = expectThrows(() => builder.ignite(), "a registration under the Components id");

				// The components plugin provides `Components` from a hook of its own, in its package.
				const first = lineOf(message, "first:");
				const prefix = `first:  provideInstance(value: Components) from plugin 'Components', at ${PACKAGES}components.out.`;
				expectTrue(
					startsWith(first, prefix) && first.match(":%d+$")[0] !== undefined,
					`the plugin's line: ${first}`,
				);
				expectSitesHere(sites, 1);
				expectEqual(
					lineOf(message, "second:"),
					`second: registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
					"the second registration",
				);
				expectFalse(contains(message, `, at ${PACKAGES}core.`), `a call site in core, in: ${message}`);
			});

			test("a class two folder registrations find names both folders", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Folders");
				builder.registerProviders("src/server/Discovery", mark(sites, undefined));
				builder.registerProviders("src/server/Discovery/nested", mark(sites, undefined));
				const message = expectThrows(() => builder.ignite(), "two folder registrations that overlap");

				expectSitesHere(sites, 2);
				expectDuplicate(message, {
					module: "Folders",
					id: deepIds.provider,
					first: `class DiscoveryDeep, found by registerProviders("src/server/Discovery") from the module builder, at ${sites[0]}`,
					second: `class DiscoveryDeep, found by registerProviders("src/server/Discovery/nested") from the module builder, at ${sites[1]}`,
					hint: 'the class is under both folders, so registerProviders("src/server/Discovery") and registerProviders("src/server/Discovery/nested") overlap: register the outer folder alone, or move the class out of one of them.',
				});
			});

			test("a class a glob and a folder registration both find names the glob and the folder", () => {
				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Globbed");
				builder.registerProvidersGlob("src/server/Discovery/**/*.ts", mark(sites, undefined));
				builder.registerProviders("src/server/Discovery/nested", mark(sites, undefined));
				const message = expectThrows(() => builder.ignite(), "a glob and a folder that overlap");

				expectSitesHere(sites, 2);
				expectDuplicate(message, {
					module: "Globbed",
					id: deepIds.provider,
					first: `class DiscoveryDeep, found by registerProvidersGlob("src/server/Discovery/**/*.ts") from the module builder, at ${sites[0]}`,
					second: `class DiscoveryDeep, found by registerProviders("src/server/Discovery/nested") from the module builder, at ${sites[1]}`,
					hint: 'the class is under both folders, so registerProvidersGlob("src/server/Discovery/**/*.ts") and registerProviders("src/server/Discovery/nested") overlap: register the outer folder alone, or move the class out of one of them.',
				});
			});

			test("two Set values provided by type share Set's id, and the hint says why", () => {
				const setId = Flamework.id<Set<Player>>();
				expectEqual(setId, Flamework.id<Set<string>>(), "type arguments are not part of an id");
				expectTrue(startsWith(setId, "@rbxts/compiler-types:"), `Set's id is the compiler types': ${setId}`);

				const sites = new Array<string>();
				const builder = Flamework.createModule().setDebugName("Sets");
				builder.includePlugin(
					Flamework.createPlugin("Rooms", (target) => {
						target.provideInstance(mark(sites, new Set<Player>()));
					}),
				);
				builder.includePlugin(
					Flamework.createPlugin("Tags", (target) => {
						target.provideInstance(mark(sites, new Set<string>()));
					}),
				);
				const message = expectThrows(() => builder.ignite(), "two sets provided by type");

				expectSitesHere(sites, 2);
				expectDuplicate(message, {
					module: "Sets",
					id: setId,
					first: `provideInstance(value: table) from plugin 'Rooms', at ${sites[0]}`,
					second: `provideInstance(value: table) from plugin 'Tags', at ${sites[1]}`,
					hint:
						"Set is generic, and an id names a type's declaration, not its type arguments: Set<A> and Set<B> both get this one, Set's id in @rbxts/compiler-types. " +
						"Give one of them a type of its own -- an interface (interface MySet extends Set<...> {}), provided and injected as that type, or a class that holds the value -- " +
						'or an id of its own, given as a string (provideInstance(value, "my-id"), registerProvider(config, "my-id")) and resolved by it (module.resolveDependency<T>("my-id")). ' +
						"A type alias is not a type of its own: it still names Set.",
				});
			});
		});
	}
}
