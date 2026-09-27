import { BaseComponent, Component, ComponentPlugin, Components } from "@flamework-experimental/components";
import * as core from "@flamework-experimental/core";
import { Flamework, Provider } from "@flamework-experimental/core";
import { ExportedProvider } from "../fixtures/discovery/exported";
import { hiddenIds } from "../fixtures/discovery/hidden";
import {
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectFalse,
	expectNoThrow,
	expectThrows,
	expectTrue,
	suite,
} from "../testkit";

/**
 * The harness has no `config.json`, so the active set is replaced per case. The setter is internal
 * and stripped from the package's types, so it is reached through a cast, as `ignite` is.
 */
const harness = core as unknown as {
	__setActiveScopes: (scopes: readonly string[] | undefined) => void;
	__setPathRoot: (root: Instance | undefined) => void;
};

/**
 * The specs package's `out` folder, which the discovery fixtures sit under: paths resolve from it
 * as a plugin's resolve from its own root (see paths.ts).
 */
const SPECS_OUT = (script.Parent as Instance).Parent as Instance;
const DISCOVERY = ["fixtures", "discovery"] as never;

function underSpecs<T>(callback: () => T): T {
	harness.__setPathRoot(SPECS_OUT);
	try {
		return callback();
	} finally {
		harness.__setPathRoot(undefined);
	}
}

function withScopes(scopes: readonly string[], run: () => void) {
	harness.__setActiveScopes(scopes);
	try {
		run();
	} finally {
		harness.__setActiveScopes(undefined);
	}
}

function contains(message: string, text: string) {
	return message.find(text, 1, true)[0] !== undefined;
}

@Provider()
class Always {}

@Provider({ activeIn: ["alpha"] })
class OnlyAlpha {}

@Provider({ inactiveIn: ["beta"] })
class NotBeta {}

@Provider({ activeIn: ["alpha.deep"] })
class Deep {}

@Provider({ lazy: true, activeIn: ["alpha"] })
class LazyAlpha {}

@Provider()
class Needy {
	constructor(public readonly only: OnlyAlpha) {}
}

@Provider()
class Real {
	public readonly kind = "real";
}

/** Registered under `Real`'s id when `swap` is active, which is how a fake takes a real provider's place. */
@Provider()
class Fake {
	public readonly kind = "fake";
}

@Component({ tag: "ScopedTag", activeIn: ["alpha"] })
class Scoped extends BaseComponent<{}, Folder> {}

@Component({ tag: "ScopedTag" })
class Unscoped extends BaseComponent<{}, Folder> {}

/**
 * A folder this place does not have, as a release build that leaves its tests out lacks it, and a
 * glob no build recorded. Looking either up raises in this harness (`WaitForChild` on a missing
 * child, no `globs.json`), where a place would wait forever in `WaitForChild`.
 */
const MISSING_FOLDER = ["ServerScriptService", "TS", "Tests"];
const MISSING_GLOB = "src/*/Tests/**";

/** Every path and glob registration form, each given `condition` and a folder that is not there. */
function registerMissingFolders(condition: core.ScopeCondition) {
	const folder = MISSING_FOLDER as never;
	const glob = MISSING_GLOB as never;

	return [
		["registerProviders", () => Flamework.createModule().registerProviders("src/server/Tests", condition, folder)],
		[
			"registerProvidersGlob",
			() => Flamework.createModule().registerProvidersGlob("src/*/Tests/**", condition, glob),
		],
		["ComponentPlugin.fromPath", () => ComponentPlugin.fromPath("src/server/Tests", condition, folder)],
		["ComponentPlugin.fromGlob", () => ComponentPlugin.fromGlob("src/*/Tests/**", condition, glob)],
		[
			"registerComponents",
			() => ComponentPlugin.createPlugin().registerComponents("src/server/Tests", condition, folder),
		],
		[
			"registerComponentsGlob",
			() => ComponentPlugin.createPlugin().registerComponentsGlob("src/*/Tests/**", condition, glob),
		],
		[
			"a plugin target's registerProviders and registerProvidersGlob",
			() =>
				Flamework.createModule()
					.includePlugin(
						Flamework.createPlugin("MissingFolders", (target) => {
							target.registerProviders("src/server/Tests", condition, folder);
							target.registerProvidersGlob("src/*/Tests/**", condition, glob);
						}),
					)
					.ignite()
					.extinguish(),
		],
	] as const;
}

function taggedFolder(name: string) {
	const instance = new Instance("Folder");
	instance.Name = name;
	instance.Parent = game.Workspace;
	game.GetService("CollectionService").AddTag(instance, "ScopedTag");
	return instance;
}

export = suite("scopes", [
	[
		"registers a class with no condition whatever the active set is",
		() => {
			withScopes([], () => {
				const module = Flamework.createModule().registerClassProvider(Always).ignite();
				expectDefined(module.resolveDependency<Always>(), "provider");
				module.extinguish();
			});
		},
	],
	[
		"a module's condition gates everything it registers",
		() => {
			withScopes([], () => {
				const module = Flamework.createModule()
					.registerClassProvider(Always)
					.ignite({ activeIn: ["alpha"] });
				const message = expectThrows(
					() => module.resolveDependency<Always>(),
					"resolving a scoped-out provider",
				);
				expectTrue(contains(message, "registered but inactive"), "error says it is inactive");
				expectTrue(contains(message, "activeIn [alpha]"), "error names the condition");
				expectTrue(contains(message, "active scopes []"), "error names the active set");
				module.extinguish();
			});

			withScopes(["alpha"], () => {
				const module = Flamework.createModule()
					.registerClassProvider(Always)
					.ignite({ activeIn: ["alpha"] });
				expectDefined(module.resolveDependency<Always>(), "provider under an active module");
				module.extinguish();
			});
		},
	],
	[
		"a class's own condition narrows the module's, and never widens it",
		() => {
			const ignite = () =>
				Flamework.createModule()
					.registerClassProvider(Deep)
					.ignite({ activeIn: ["alpha"] });

			withScopes(["alpha"], () => {
				const module = ignite();
				expectThrows(() => module.resolveDependency<Deep>(), "the class asks for more than the module has");
				module.extinguish();
			});

			withScopes(["alpha.deep"], () => {
				const module = ignite();
				expectThrows(() => module.resolveDependency<Deep>(), "the module's condition still applies");
				module.extinguish();
			});

			withScopes(["alpha", "alpha.deep"], () => {
				const module = ignite();
				expectDefined(module.resolveDependency<Deep>(), "both conditions hold");
				module.extinguish();
			});
		},
	],
	[
		"inactiveIn turns a class off while its scope is active",
		() => {
			withScopes(["beta"], () => {
				const module = Flamework.createModule().registerClassProvider(NotBeta).ignite();
				const message = expectThrows(() => module.resolveDependency<NotBeta>(), "resolving while beta is on");
				expectTrue(contains(message, "inactiveIn [beta]"), "error names the condition");
				module.extinguish();
			});

			withScopes([], () => {
				const module = Flamework.createModule().registerClassProvider(NotBeta).ignite();
				expectDefined(module.resolveDependency<NotBeta>(), "provider while beta is off");
				module.extinguish();
			});
		},
	],
	[
		"`*` activates every scope, which turns inactiveIn classes off",
		() => {
			withScopes(["*"], () => {
				const module = Flamework.createModule()
					.registerClassProvider(OnlyAlpha)
					.registerClassProvider(NotBeta)
					.ignite();

				expectDefined(module.resolveDependency<OnlyAlpha>(), "activeIn holds under *");
				expectThrows(() => module.resolveDependency<NotBeta>(), "inactiveIn fails under *");
				module.extinguish();
			});
		},
	],
	[
		"a registration's condition applies to the class it registers, in either form",
		() => {
			const ignite = () =>
				Flamework.createModule()
					.registerClassProvider(Always, { activeIn: ["gamma"] })
					.registerProvider<NotBeta>({ type: "class", value: NotBeta, inactiveIn: ["gamma"] })
					.ignite();

			withScopes([], () => {
				const module = ignite();
				expectThrows(() => module.resolveDependency<Always>(), "the option form, scope off");
				expectDefined(module.resolveDependency<NotBeta>(), "the config form, scope off");
				module.extinguish();
			});

			withScopes(["gamma"], () => {
				const module = ignite();
				expectDefined(module.resolveDependency<Always>(), "the option form, scope on");
				expectThrows(() => module.resolveDependency<NotBeta>(), "the config form, scope on");
				module.extinguish();
			});
		},
	],
	[
		"two registrations may share an id when at most one of them is kept",
		() => {
			const ignite = () =>
				Flamework.createModule()
					.registerClassProvider(Real, { inactiveIn: ["swap"] })
					.registerProvider<Real>({ type: "class", value: Fake, activeIn: ["swap"] })
					.ignite();

			withScopes([], () => {
				const module = ignite();
				expectEqual(module.resolveDependency<Real>().kind, "real", "the real one, with swap off");
				module.extinguish();
			});

			withScopes(["swap"], () => {
				const module = ignite();
				expectEqual(module.resolveDependency<Real>().kind, "fake" as never, "the fake, with swap on");
				module.extinguish();
			});
		},
	],
	[
		"refuses two kept registrations under one id at ignition",
		() => {
			withScopes([], () => {
				const message = expectThrows(
					() => Flamework.createModule().registerClassProvider(Real).registerClassProvider(Real).ignite(),
					"igniting with a duplicate id",
				);
				expectTrue(contains(message, "registered more than once"), "error names the collision");
			});
		},
	],
	[
		"an active provider that needs an inactive one fails at ignition, naming the condition",
		() => {
			withScopes([], () => {
				const message = expectThrows(
					() =>
						Flamework.createModule().registerClassProvider(Needy).registerClassProvider(OnlyAlpha).ignite(),
					"igniting with an inactive dependency",
				);
				expectTrue(contains(message, "registered but inactive"), "error says the dependency is inactive");
				expectTrue(contains(message, "activeIn [alpha]"), "error names its condition");
			});
		},
	],
	[
		"a lazy provider left out by scope reports inactive when first resolved",
		() => {
			withScopes([], () => {
				const module = Flamework.createModule().registerClassProvider(LazyAlpha).ignite();
				const message = expectThrows(() => module.resolveDependency<LazyAlpha>(), "resolving the lazy one");
				expectTrue(contains(message, "registered but inactive"), "error says it is inactive");
				module.extinguish();
			});
		},
	],
	[
		"a plugin included under a condition that fails is left out entirely",
		() => {
			let hooks = 0;
			const plugin = Flamework.createPlugin("Scoped", (target) => {
				target.registerClassProvider(Always);
				target.onPostIgnite(() => (hooks += 1));
			});

			withScopes([], () => {
				const module = Flamework.createModule()
					.includePlugin(plugin, { activeIn: ["alpha"] })
					.ignite();
				expectEqual(hooks, 0, "the hook did not run");

				// Never registered, so this is a plain miss rather than an inactive registration.
				const message = expectThrows(
					() => module.resolveDependency<Always>(),
					"resolving the plugin's provider",
				);
				expectFalse(contains(message, "registered but inactive"), "nothing was registered to be inactive");
				module.extinguish();
			});

			withScopes(["alpha"], () => {
				const module = Flamework.createModule()
					.includePlugin(plugin, { activeIn: ["alpha"] })
					.ignite();
				expectEqual(hooks, 1, "the hook ran");
				expectDefined(module.resolveDependency<Always>(), "the plugin's provider");
				module.extinguish();
			});
		},
	],
	[
		"a plugin's target answers for the module's condition",
		() => {
			const seen = new Array<string>();
			const plugin = Flamework.createPlugin("Asking", (target) => {
				seen.push(`plain:${target.isActive()}`);
				seen.push(`narrowed:${target.isActive({ activeIn: ["other"] })}`);
				seen.push(`scope:${target.scope?.activeIn?.join(",")}`);
			});

			withScopes(["alpha"], () => {
				Flamework.createModule()
					.includePlugin(plugin)
					.ignite({ activeIn: ["alpha"] })
					.extinguish();
				expectArrayEqual(seen, ["plain:true", "narrowed:false", "scope:alpha"], "under an active module");
			});

			seen.clear();
			withScopes([], () => {
				Flamework.createModule()
					.includePlugin(plugin)
					.ignite({ activeIn: ["alpha"] })
					.extinguish();
				expectArrayEqual(seen, ["plain:false", "narrowed:false", "scope:alpha"], "under an inactive module");
			});
		},
	],
	[
		"Flamework.isScopeActive and activeScopes read the active set",
		() => {
			withScopes(["a"], () => {
				expectTrue(Flamework.isScopeActive("a"), "a listed scope");
				expectFalse(Flamework.isScopeActive("b"), "an unlisted scope");
				expectArrayEqual(Flamework.activeScopes(), ["a"], "the list as configured");
			});

			withScopes(["*"], () => {
				expectTrue(Flamework.isScopeActive("b"), "anything under *");
			});
		},
	],
	[
		"a component outside its scope is never attached, and a lookup of it says why",
		() => {
			const ignite = () =>
				Flamework.createModule()
					.includePlugin(
						ComponentPlugin.createPlugin().registerComponent(Scoped).registerComponent(Unscoped).build(),
					)
					.ignite();

			withScopes([], () => {
				const module = ignite();
				const components = module.resolveDependency<Components>();
				const instance = taggedFolder("ScopedOff");

				expectDefined(components.getComponent<Unscoped>(instance), "the unscoped component attached");
				const message = expectThrows(
					() => components.getComponent<Scoped>(instance),
					"looking up the scoped one",
				);
				expectTrue(contains(message, "registered but inactive"), "error says it is inactive");
				expectTrue(contains(message, "activeIn [alpha]"), "error names the condition");

				instance.Destroy();
				module.extinguish();
			});

			withScopes(["alpha"], () => {
				const module = ignite();
				const components = module.resolveDependency<Components>();
				const instance = taggedFolder("ScopedOn");

				expectDefined(components.getComponent<Scoped>(instance), "the scoped component attached");
				expectDefined(components.getComponent<Unscoped>(instance), "and so did the unscoped one");

				instance.Destroy();
				module.extinguish();
			});
		},
	],
	[
		"a component registration's condition applies to the class it registers",
		() => {
			withScopes([], () => {
				const module = Flamework.createModule()
					.includePlugin(
						ComponentPlugin.createPlugin()
							.registerComponent(Unscoped, { activeIn: ["gamma"] })
							.build(),
					)
					.ignite();
				const components = module.resolveDependency<Components>();
				const instance = taggedFolder("RegistrationOff");

				const message = expectThrows(() => components.getComponent<Unscoped>(instance), "looking it up");
				expectTrue(contains(message, "activeIn [gamma]"), "error names the registration's condition");

				instance.Destroy();
				module.extinguish();
			});
		},
	],
	[
		// A registration a build leaves out does not touch its folder: a release build that drops
		// the Tests folders from the place, and registers them by their own path under `testing`,
		// must not wait for them. Every form, under both kinds of condition.
		"a path or glob registration whose own condition does not hold never looks its folder up",
		() => {
			withScopes([], () => {
				for (const [form, register] of registerMissingFolders({ activeIn: ["testing"] })) {
					expectNoThrow(register, `${form} under activeIn [testing] with no scope active`);
				}
			});

			withScopes(["release"], () => {
				for (const [form, register] of registerMissingFolders({ inactiveIn: ["release"] })) {
					expectNoThrow(register, `${form} under inactiveIn [release] with release active`);
				}
			});
		},
	],
	[
		"a path or glob registration whose own condition holds looks its folder up as before",
		() => {
			withScopes(["testing"], () => {
				for (const [form, register] of registerMissingFolders({ activeIn: ["testing"] })) {
					const message = expectThrows(register, `${form} with testing active`);
					expectTrue(
						contains(message, "WaitForChild") || contains(message, "no paths for the glob"),
						`${form} looked the folder up: ${message}`,
					);
				}
			});

			// No condition always holds.
			withScopes([], () => {
				expectThrows(
					() =>
						Flamework.createModule().registerProviders(
							"src/server/Tests",
							undefined,
							MISSING_FOLDER as never,
						),
					"registerProviders with no condition",
				);
			});
		},
	],
	[
		// Such a registration records nothing to be inactive, so a miss would otherwise give no reason,
		// or advice to register a folder that is registered. The discovery fixtures are loaded by this
		// file's imports, as a class is loaded by whatever imports it in a game.
		"a miss on a class under a folder its registration left out names that registration",
		() => {
			withScopes([], () => {
				const module = underSpecs(() =>
					Flamework.createModule()
						.registerProviders("fixtures/discovery", { activeIn: ["dev"] }, DISCOVERY)
						.ignite(),
				);

				for (const [what, resolve] of [
					["the exported provider", () => module.resolveDependency<ExportedProvider>()],
					["the provider its module does not export", () => module.resolveDependency(hiddenIds.provider)],
				] as const) {
					const message = expectThrows(resolve, what);
					expectTrue(contains(message, `is under registerProviders("fixtures/discovery")`), message);
					expectTrue(contains(message, "left out by its scope (activeIn [dev]; active scopes [])"), message);
					expectFalse(contains(message, "add its folder"), `no advice to register it again: ${message}`);
				}

				module.extinguish();
			});

			withScopes(["release"], () => {
				const plugin = Flamework.createPlugin("LeftOut", (target) => {
					target.registerProviders("fixtures/discovery", { inactiveIn: ["release"] }, DISCOVERY);
				});
				const module = underSpecs(() => Flamework.createModule().includePlugin(plugin).ignite());

				const message = expectThrows(() => module.resolveDependency<ExportedProvider>(), "through a plugin");
				expectTrue(contains(message, `is under registerProviders("fixtures/discovery")`), message);
				expectTrue(contains(message, "inactiveIn [release]; active scopes [release]"), message);
				module.extinguish();
			});
		},
	],
	[
		"a miss on a component under a folder its registration left out names that registration",
		() => {
			withScopes([], () => {
				const module = underSpecs(() =>
					Flamework.createModule()
						.includePlugin(ComponentPlugin.fromPath("fixtures/discovery", { activeIn: ["dev"] }, DISCOVERY))
						.ignite(),
				);
				const components = module.resolveDependency<Components>();
				const instance = new Instance("Folder");

				const message = expectThrows(
					() => components.getComponent(instance, hiddenIds.component),
					"getComponent on a component under the folder",
				);
				expectTrue(contains(message, `is under ComponentPlugin.fromPath("fixtures/discovery")`), message);
				expectTrue(contains(message, "left out by its scope (activeIn [dev]; active scopes [])"), message);

				instance.Destroy();
				module.extinguish();
			});
		},
	],
	[
		"a miss on a class that has not loaded lists the registrations left out, and one elsewhere does not",
		() => {
			withScopes([], () => {
				const module = Flamework.createModule()
					.registerProviders("src/server/Tests", { activeIn: ["testing"] }, MISSING_FOLDER as never)
					.registerClassProvider(Always)
					.ignite();

				// Nothing has loaded a class with this id: it may be under the folder that was left out.
				const listed = expectThrows(
					() => module.resolveDependency("server/Tests/never@Never"),
					"an unknown id",
				);
				expectTrue(contains(listed, "nothing registers it"), listed);
				expectTrue(
					contains(listed, `registerProviders("src/server/Tests") (activeIn [testing]; active scopes [])`),
					listed,
				);

				// A loaded class that is not under it keeps the usual explanation.
				const elsewhere = expectThrows(
					() => module.resolveDependency<OnlyAlpha>(),
					"a class defined elsewhere",
				);
				expectFalse(contains(elsewhere, "Left out by their scope"), elsewhere);
				expectTrue(contains(elsewhere, "nothing in this module registers or provides"), elsewhere);

				module.extinguish();
			});
		},
	],
]);
