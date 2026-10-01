import * as core from "@flamework-experimental/core";
import { Flamework, LifecycleProvider, Provider, Reflect, getClassesInPath } from "@flamework-experimental/core";
import { expectEqual, expectFalse, expectThrows, expectTrue, fail, suite } from "../testkit";

/** Internal and stripped from the package's types, so reached through a cast, as `ignite` is. */
const harness = core as unknown as {
	__setActiveScopes: (scopes: readonly string[] | undefined) => void;
	__setPathRoot: (root: Instance | undefined) => void;
};

/** The specs package's `out` folder, which the discovery fixtures sit under (see paths.ts). */
const SPECS_OUT = (script.Parent as Instance).Parent as Instance;
const DISCOVERY = ["fixtures", "discovery"] as never;
const NESTED = ["fixtures", "discovery", "nested"] as never;

function underSpecs<T>(callback: () => T): T {
	harness.__setPathRoot(SPECS_OUT);
	try {
		return callback();
	} finally {
		harness.__setPathRoot(undefined);
	}
}

/** The id of the one provider under `fixtures/discovery/nested`, which `fixtures/discovery` holds too. */
function deepProviderId(): string {
	const deep = underSpecs(() => getClassesInPath(NESTED)).find((value) => tostring(value) === "DeepProvider");
	return Reflect.getOwnMetadata<string>(deep!, "identifier")!;
}

function withScopes(scopes: readonly string[], run: () => void) {
	harness.__setActiveScopes(scopes);
	try {
		run();
	} finally {
		harness.__setActiveScopes(undefined);
	}
}

/** A chunk loaded from a string -- every module, under this harness -- names itself `[string "..."]`. */
function display(source: string) {
	const [inner] = source.match('^%[string "(.*)"%]$');
	return typeIs(inner, "string") ? inner : source;
}

/**
 * Records the calling line as the error prints a call site, `script:line`, and hands `value`
 * through. Wrapped around a registration's first argument, it is called from the line the
 * registration is: Luau gives a call the line its function expression ends on, which for a call
 * spread over several lines is the line its arguments open on, not the line a later one is on.
 */
function mark<T>(sites: string[], value: T): T {
	const [source, line] = debug.info(2, "sl");
	sites.push(`${display(source)}:${line}`);
	return value;
}

/** The line of the message that starts with `label`, without its indentation. */
function lineOf(message: string, label: string): string {
	for (const line of message.split("\n")) {
		const [trimmed] = line.gsub("^%s+", "");
		if (trimmed.sub(1, label.size()) === label) {
			return trimmed;
		}
	}

	return fail(`no '${label}' line in: ${message}`);
}

function expectContains(message: string, text: string, what: string) {
	expectTrue(message.find(text, 1, true)[0] !== undefined, `${what}: expected '${text}' in: ${message}`);
}

/** The error's lines, each checked whole: first and second as given, and the hint starting as given. */
function expectDuplicate(
	message: string,
	expected: { module: string; id: string; first: string; second: string; hint: string },
) {
	expectContains(
		message,
		`module '${expected.module}': provider ID was registered more than once: ${expected.id}\n`,
		"the first line",
	);
	expectEqual(lineOf(message, "first:"), `first:  ${expected.first}`, "the first registration");
	expectEqual(lineOf(message, "second:"), `second: ${expected.second}`, "the second registration");
	expectContains(lineOf(message, "hint:"), `hint: ${expected.hint}`, "the hint");
}

/** Undecorated: a plugin provides one, and nothing about that needs metadata. */
class Metrics {}

@Provider()
class Ledger {}

@Provider()
class Real {}

@Provider()
class Fake {}

/** A type of its own for one set of players: an id of its own, where `Set<Player>` has `Set`'s. */
interface PlayerSet extends Set<Player> {}

/** A type alias names the same declaration as what it aliases, so it has that one's id. */
type PlayerSetAlias = Set<Player>;

@Provider()
class Roster {
	constructor(public readonly players: PlayerSet) {}
}

export = suite("duplicate ids", [
	[
		"two registerProvider calls under one id name both, from the builder",
		() => {
			const sites = new Array<string>();
			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Settings")
						.registerProvider(mark(sites, { type: "function", callback: () => 1 }), "settings")
						.registerProvider(mark(sites, { type: "alias", injectionId: "elsewhere" }), "settings")
						.ignite(),
				"two registerProvider calls under one id",
			);

			expectEqual(sites.size(), 2, "both registrations ran");
			expectDuplicate(message, {
				module: "Settings",
				id: "settings",
				first: `registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
				second: `registerProvider({ type: "alias", injectionId: "elsewhere" }) from the module builder, at ${sites[1]}`,
				hint:
					`two registrations claim the id: keep one, or, to keep both, give one of them an id of its own, given as a string (provideInstance(value, "my-id"), registerProvider(config, "my-id")) and resolved by it (module.resolveDependency<T>("my-id")). ` +
					`If the id's type is generic, note that type arguments are not part of an id: Box<A> and Box<B> share one.`,
			});
		},
	],
	[
		"two provideInstance calls under one id name both plugins",
		() => {
			const sites = new Array<string>();
			const rooms = Flamework.createPlugin("Rooms", (target) =>
				target.provideInstance(mark(sites, new Metrics()), "metrics"),
			);
			const teams = Flamework.createPlugin("Teams", (target) =>
				target.provideInstance(mark(sites, new Metrics()), "metrics"),
			);

			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Provided")
						.includePlugin(rooms)
						.includePlugin(teams)
						.ignite(),
				"two provideInstance calls under one id",
			);

			expectDuplicate(message, {
				module: "Provided",
				id: "metrics",
				first: `provideInstance(value: Metrics) from plugin 'Rooms', at ${sites[0]}`,
				second: `provideInstance(value: Metrics) from plugin 'Teams', at ${sites[1]}`,
				hint: "the id is provided twice: provide one value under it, or, to keep both, give one of them an id of its own",
			});
		},
	],
	[
		"a provided Instance is named by its class and path",
		() => {
			const folder = new Instance("Folder");
			folder.Name = "ProvidedTwice";
			folder.Parent = game.Workspace;

			try {
				const sites = new Array<string>();
				const plugin = Flamework.createPlugin("Folders", (target) => {
					target.provideInstance(mark(sites, folder), "folder");
					target.provideInstance(mark(sites, folder), "folder");
				});

				const message = expectThrows(
					() => Flamework.createModule().setDebugName("Instances").includePlugin(plugin).ignite(),
					"one Instance provided twice under one id",
				);

				const value = `provideInstance(value: Folder ${folder.GetFullName()})`;
				expectDuplicate(message, {
					module: "Instances",
					id: "folder",
					first: `${value} from plugin 'Folders', at ${sites[0]}`,
					second: `${value} from plugin 'Folders', at ${sites[1]}`,
					hint: "the id is provided twice",
				});
			} finally {
				folder.Destroy();
			}
		},
	],
	[
		"provideInstance and registerProvider under one id name both",
		() => {
			const sites = new Array<string>();
			const plugin = Flamework.createPlugin("Metrics", (target) =>
				target.provideInstance(mark(sites, new Metrics())),
			);

			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Mixed")
						.registerProvider<Metrics>(mark(sites, { type: "function", callback: () => new Metrics() }))
						.includePlugin(plugin)
						.ignite(),
				"a provided instance and a registration under one id",
			);

			// The builder's registration is made first, but judged after the plugins are set up: the
			// provided object holds the id by then.
			expectDuplicate(message, {
				module: "Mixed",
				id: Flamework.id<Metrics>(),
				first: `provideInstance(value: Metrics) from plugin 'Metrics', at ${sites[1]}`,
				second: `registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
				hint: "the id is both provided and registered: keep one, or, to keep both, give one of them an id of its own",
			});
			expectContains(
				message,
				"If Metrics is generic, note that type arguments are not part of an id: Metrics<A> and Metrics<B> share this one.",
				"the hint",
			);
		},
	],
	[
		"a provideInstance against a provider the module kept names the registration",
		() => {
			const sites = new Array<string>();
			const plugin = Flamework.createPlugin("Late", (target) =>
				target.onPostIgnite(() => target.provideInstance(mark(sites, new Ledger()))),
			);

			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Late")
						.registerClassProvider(mark(sites, Ledger))
						.includePlugin(plugin)
						.ignite(),
				"a provideInstance after the providers were constructed",
			);

			expectDuplicate(message, {
				module: "Late",
				id: Flamework.id<Ledger>(),
				first: `registerClassProvider(Ledger) from the module builder, at ${sites[0]}`,
				second: `provideInstance(value: Ledger) from plugin 'Late', at ${sites[1]}`,
				hint: "the id is both provided and registered: keep one",
			});
		},
	],
	[
		"a plugin's registration against the builder's names both origins",
		() => {
			const sites = new Array<string>();
			const plugin = Flamework.createPlugin("Ledgers", (target) =>
				target.registerClassProvider(mark(sites, Ledger)),
			);

			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Books")
						.registerClassProvider(mark(sites, Ledger))
						.includePlugin(plugin)
						.ignite(),
				"a plugin registering a class the builder registered",
			);

			expectDuplicate(message, {
				module: "Books",
				id: Flamework.id<Ledger>(),
				first: `registerClassProvider(Ledger) from the module builder, at ${sites[0]}`,
				second: `registerClassProvider(Ledger) from plugin 'Ledgers', at ${sites[1]}`,
				hint: "the same class is registered twice: keep one of the two registrations.",
			});
		},
	],
	[
		"the same class under two folder registrations names both folders",
		() => {
			const id = deepProviderId();
			const sites = new Array<string>();
			const message = expectThrows(
				() =>
					underSpecs(() =>
						Flamework.createModule()
							.setDebugName("Folders")
							.registerProviders("fixtures/discovery", mark(sites, undefined), DISCOVERY)
							.registerProviders("fixtures/discovery/nested", mark(sites, undefined), NESTED)
							.ignite(),
					),
				"two folder registrations that overlap",
			);

			expectDuplicate(message, {
				module: "Folders",
				id,
				first: `class DeepProvider, found by registerProviders("fixtures/discovery") from the module builder, at ${sites[0]}`,
				second: `class DeepProvider, found by registerProviders("fixtures/discovery/nested") from the module builder, at ${sites[1]}`,
				hint: 'the class is under both folders, so registerProviders("fixtures/discovery") and registerProviders("fixtures/discovery/nested") overlap: register the outer folder alone, or move the class out of one of them.',
			});
		},
	],
	[
		"a plugin's folder registration against the builder's registration names the folder",
		() => {
			const id = deepProviderId();
			const sites = new Array<string>();
			const plugin = Flamework.createPlugin("Discovery", (target) =>
				target.registerProviders("fixtures/discovery/nested", mark(sites, undefined), NESTED),
			);

			const message = expectThrows(
				() =>
					underSpecs(() =>
						Flamework.createModule()
							.setDebugName("Overlap")
							.registerProvider(mark(sites, { type: "function", callback: () => 1 }), id)
							.includePlugin(plugin)
							.ignite(),
					),
				"a function registered under a folder class's id",
			);

			expectDuplicate(message, {
				module: "Overlap",
				id,
				first: `registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
				second: `class DeepProvider, found by registerProviders("fixtures/discovery/nested") from plugin 'Discovery', at ${sites[1]}`,
				hint: "two registrations claim the id: keep one",
			});
		},
	],
	[
		"two Set values provided by type share Set's id, and the error says why",
		() => {
			const setId = Flamework.id<Set<Player>>();
			expectEqual(setId, Flamework.id<Set<string>>(), "type arguments are not part of an id");
			expectEqual(setId, "@rbxts/compiler-types:types/Set@Set", "Set's id");

			const sites = new Array<string>();
			const rooms = Flamework.createPlugin("Rooms", (target) =>
				target.provideInstance(mark(sites, new Set<Player>())),
			);
			const tags = Flamework.createPlugin("Tags", (target) =>
				target.provideInstance(mark(sites, new Set<string>())),
			);

			const message = expectThrows(
				() => Flamework.createModule().setDebugName("Sets").includePlugin(rooms).includePlugin(tags).ignite(),
				"two sets provided by type",
			);

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

			// What the hint says works: an interface of its own, injected as that type, and an id
			// given by hand. An alias does not.
			expectFalse(Flamework.id<PlayerSet>() === setId, "an interface extending Set has an id of its own");
			expectEqual(Flamework.id<PlayerSetAlias>(), setId, "an alias of Set<Player> has Set's id");

			const players = new Set<Player>();
			const module = Flamework.createModule()
				.includePlugin(Flamework.createPlugin("Rooms", (target) => target.provideInstance<PlayerSet>(players)))
				.includePlugin(Flamework.createPlugin("Tags", (target) => target.provideInstance(new Set<string>())))
				.includePlugin(
					Flamework.createPlugin("Names", (target) => target.provideInstance(new Set<string>(), "names")),
				)
				.registerClassProvider(Roster)
				.ignite();

			expectTrue(module.resolveDependency<Roster>().players === players, "the interface was injected");
			expectTrue(
				module.resolveDependency<Set<string>>("names") !== module.resolveDependency<Set<string>>(),
				"the set given an id by hand is apart from the one provided by type",
			);

			module.extinguish();
		},
	],
	[
		"two classes kept under one id by their scopes say both are kept",
		() => {
			withScopes(["alpha", "beta"], () => {
				const sites = new Array<string>();
				const message = expectThrows(
					() =>
						Flamework.createModule()
							.setDebugName("Scoped")
							.registerClassProvider(mark(sites, Real), { activeIn: ["alpha"] })
							.registerProvider<Real>(mark(sites, { type: "class", value: Fake, activeIn: ["beta"] }))
							.ignite(),
					"two scoped registrations that both hold",
				);

				expectDuplicate(message, {
					module: "Scoped",
					id: Flamework.id<Real>(),
					first: `registerClassProvider(Real) from the module builder, at ${sites[0]}, scoped activeIn [alpha]`,
					second: `registerProvider({ type: "class", value: Fake }) from the module builder, at ${sites[1]}, scoped activeIn [beta]`,
					hint: "two classes are registered under one id.",
				});
				expectContains(
					message,
					"Both are kept in this build (active scopes [alpha, beta]): two registrations may share an id only when their scope conditions keep at most one of them.",
					"the scope sentence",
				);
			});
		},
	],
	[
		"what core registers itself names its plugin and no line",
		() => {
			const sites = new Array<string>();
			const message = expectThrows(
				() =>
					Flamework.createModule()
						.setDebugName("Lifecycle")
						.registerProvider<LifecycleProvider>(mark(sites, { type: "function", callback: () => 1 }))
						.ignite(),
				"a registration under the lifecycle plugin's provider's id",
			);

			expectDuplicate(message, {
				module: "Lifecycle",
				id: Flamework.id<LifecycleProvider>(),
				first: "provideInstance(value: LifecycleProvider) from plugin 'Lifecycle'",
				second: `registerProvider({ type: "function" }) from the module builder, at ${sites[0]}`,
				hint: "the id is both provided and registered: keep one",
			});
		},
	],
	[
		"registrations under different ids ignite as before",
		() => {
			const plugin = Flamework.createPlugin("Apart", (target) => {
				target.provideInstance(new Metrics());
				target.provideInstance(new Set<Player>());
				target.registerProvider({ type: "function", callback: () => "a" }, "a");
			});

			const module = Flamework.createModule()
				.registerClassProvider(Ledger)
				.registerProvider({ type: "alias", injectionId: "a" }, "b")
				.includePlugin(plugin)
				.ignite();

			expectEqual(module.resolveDependency<string>("b"), "a", "the alias resolved");
			expectTrue(module.resolveDependency<Ledger>() !== undefined, "the class provider");
			module.extinguish();
		},
	],
]);
