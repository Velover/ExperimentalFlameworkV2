import { Dependency, Flamework, OnStart, Provider } from "@flamework-experimental/core";
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
		});
	}
}
