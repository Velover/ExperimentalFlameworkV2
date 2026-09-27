import { ComponentPlugin, Components } from "@flamework-experimental/components";
import { Dependency, Flamework, OnStart, Provider } from "@flamework-experimental/core";
import { DiscoveryExported, DiscoveryExportedComponent } from "server/Discovery/exported";
import { defer, defineTests, expectFalse, expectThrows, expectTrue, test } from "@flamework-experimental/testing";

/** Registered under a scope no build activates, so it must never reach a container. */
@Provider({ activeIn: ["a-scope-no-build-activates"] })
export class NeverRegistered {
	public readonly here = true;
}

/** Off while `testing` is active, which is exactly when these specs run. */
@Provider({ inactiveIn: ["testing"] })
export class StandsDownForTests {
	public readonly here = true;
}

/**
 * Scopes as the build actually compiled them. Unlike the Lune specs, which set the active set
 * through an internal, this reads the set the transformer wrote into the artifact from
 * `FLAMEWORK_SCOPES`, and checks the decisions it drove in the module that is really running.
 */
@Provider({ activeIn: ["testing"] })
export class ScopeTests implements OnStart {
	onStart() {
		defineTests("scopes", () => {
			test("the build compiled the testing scope in, which is why these tests exist", () => {
				expectTrue(Flamework.isScopeActive("testing"), "the testing scope is active");
				expectTrue(
					Flamework.activeScopes().includes("testing"),
					`activeScopes lists it, got [${Flamework.activeScopes().join(", ")}]`,
				);
			});

			test("a scope nothing activates is inactive, and a class under it was never registered", () => {
				expectFalse(Flamework.isScopeActive("a-scope-no-build-activates"), "an unknown scope");
				expectThrows(() => Dependency<NeverRegistered>(), "resolving a scoped-out provider");
			});

			test("inactiveIn turns a class off while its scope is active", () => {
				expectThrows(() => Dependency<StandsDownForTests>(), "resolving a class standing down for tests");
			});

			test("a registration's condition decides, and an inactive one leaves nothing behind", () => {
				const module = Flamework.createModule()
					.registerClassProvider(NeverRegistered, { activeIn: ["testing"] })
					.ignite();
				defer(() => module.extinguish());

				// The class's own condition never widens the registration's: its activeIn names a
				// scope this build does not have, so it stays out however it is registered.
				expectThrows(
					() => module.resolveDependency<NeverRegistered>(),
					"the class's own condition still holds",
				);
			});

			test("a path or glob registration whose condition does not hold never waits for its folder", () => {
				// A folder the place does not have, as a release build leaves out its Tests folders:
				// looking it up would wait in WaitForChild for good. Explicit paths, since the
				// transformer only generates one for a folder the Rojo project maps.
				const folder = ["ServerScriptService", "TS", "NoSuchTests"] as never;
				const glob = "src/server/NoSuchTests/**" as never;
				const off = { activeIn: ["a-scope-no-build-activates"] };

				let finished = false;
				const thread = task.spawn(() => {
					Flamework.createModule()
						.registerProviders("src/server/NoSuchTests", off, folder)
						.registerProvidersGlob("src/server/NoSuchTests/**", off, glob)
						.includePlugin(ComponentPlugin.fromPath("src/server/NoSuchTests", off, folder))
						.includePlugin(ComponentPlugin.fromGlob("src/server/NoSuchTests/**", off, glob));
					finished = true;
				});
				if (!finished) task.cancel(thread);

				expectTrue(finished, "every registration returned without looking its folder up");
			});

			test("a miss on a class under a folder its registration left out names that registration", () => {
				// The discovery fixtures are loaded by this file's import, as a class is loaded by
				// whatever imports it in a game; the folder itself is never registered here.
				const off = { activeIn: ["a-scope-no-build-activates"] };
				const reason = "left out by its scope (activeIn [a-scope-no-build-activates]";

				const byPath = Flamework.createModule().registerProviders("src/server/Discovery", off).ignite();
				defer(() => byPath.extinguish());
				const pathMessage = expectThrows(() => byPath.resolveDependency<DiscoveryExported>(), "by path");
				expectTrue(
					pathMessage.find(`is under registerProviders("src/server/Discovery")`, 1, true)[0] !== undefined,
					pathMessage,
				);
				expectTrue(pathMessage.find(reason, 1, true)[0] !== undefined, pathMessage);
				expectFalse(pathMessage.find("add its folder", 1, true)[0] !== undefined, pathMessage);

				// A glob is matched against what it matched when the build was compiled (globs.json).
				const byGlob = Flamework.createModule()
					.registerProvidersGlob("src/server/Discovery/*.ts", off)
					.ignite();
				defer(() => byGlob.extinguish());
				const globMessage = expectThrows(() => byGlob.resolveDependency<DiscoveryExported>(), "by glob");
				expectTrue(
					globMessage.find(`is under registerProvidersGlob("src/server/Discovery/*.ts")`, 1, true)[0] !==
						undefined,
					globMessage,
				);

				const withComponents = Flamework.createModule()
					.includePlugin(ComponentPlugin.fromPath("src/server/Discovery", off))
					.ignite();
				defer(() => withComponents.extinguish());
				const components = withComponents.resolveDependency<Components>();
				const componentMessage = expectThrows(
					() => components.getComponent<DiscoveryExportedComponent>(new Instance("Folder")),
					"a component",
				);
				expectTrue(
					componentMessage.find(`is under ComponentPlugin.fromPath("src/server/Discovery")`, 1, true)[0] !==
						undefined,
					componentMessage,
				);
			});
		});
	}
}
