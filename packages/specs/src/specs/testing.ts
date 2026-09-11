import { Flamework } from "@flamework-experimental/core";
import * as testing from "@flamework-experimental/testing";
import {
	Testing,
	afterEach,
	beforeEach,
	createTestingPlugin,
	defer,
	defineTests,
	runTests,
	scratch,
	test,
	type RunResult,
} from "@flamework-experimental/testing";
import { RunService, Workspace } from "@rbxts/services";
import { expectArrayEqual, expectDefined, expectEqual, expectFalse, expectThrows, expectTrue, suite } from "../testkit";

/**
 * The registry is process-wide, as it is in a game, so every case starts it empty. The reset and
 * the attachment probe are internal and stripped from the package's types, hence the cast.
 */
const internal = testing as unknown as { __resetTests: () => void; __isAttached: () => boolean };

function fresh(define: () => void) {
	internal.__resetTests();
	define();
}

function contains(message: string | undefined, text: string) {
	return message !== undefined && message.find(text, 1, true)[0] !== undefined;
}

function testNames(result: RunResult, section: string) {
	const found = result.sections.find((candidate) => candidate.name === section);
	return found !== undefined ? found.tests.map((entry) => entry.name) : [];
}

function outcome(result: RunResult, section: string, name: string) {
	const found = result.sections.find((candidate) => candidate.name === section);
	return expectDefined(
		found?.tests.find((entry) => entry.name === name),
		`the result of ${section}/${name}`,
	);
}

/** A run with a short timeout, for the cases about overrunning tests. */
function runQuickly(filter?: testing.TestFilter) {
	return runTests(filter, undefined, { timeout: 0.2 });
}

export = suite("testing", [
	[
		"sections keep definition order and the same name merges across definitions",
		() => {
			fresh(() => {
				defineTests("alpha", () => test("one", () => {}));
				defineTests("beta", () => test("only", () => {}));
				defineTests("alpha", () => test("two", () => {}));
				defineTests(undefined, () => test("unnamed", () => {}));
			});

			const listed = Testing.list();
			expectTrue(listed.listed === true, "listed");
			expectArrayEqual(
				listed.sections.map((section) => section.name),
				["alpha", "beta", "default"],
				"section order",
			);
			expectArrayEqual(testNames(listed, "alpha"), ["one", "two"], "alpha's tests");
			expectEqual(listed.passed, 0, "nothing ran");
		},
	],

	[
		"test, beforeEach and afterEach refuse to register outside a body",
		() => {
			fresh(() => {});
			expectTrue(
				contains(
					expectThrows(() => test("stray", () => {})),
					"inside a defineTests body",
				),
			);
			expectTrue(
				contains(
					expectThrows(() => beforeEach(() => {})),
					"inside a defineTests body",
				),
			);
			expectTrue(
				contains(
					expectThrows(() => afterEach(() => {})),
					"inside a defineTests body",
				),
			);
		},
	],

	[
		"a duplicate test name, a nested section and a slash in a name are refused",
		() => {
			fresh(() => {});
			const duplicate = expectThrows(() =>
				defineTests("dup", () => {
					test("same", () => {});
					test("same", () => {});
				}),
			);
			expectTrue(contains(duplicate, "already has a test named 'same'"), duplicate);

			const nested = expectThrows(() => defineTests("outer", () => defineTests("inner", () => {})));
			expectTrue(contains(nested, "sections do not nest"), nested);

			const slashed = expectThrows(() => defineTests("a/b", () => {}));
			expectTrue(contains(slashed, "may not contain '/'"), slashed);
		},
	],

	[
		"runs every test, counts passes and failures, and keeps the failure's message",
		() => {
			fresh(() => {
				defineTests("counts", () => {
					test("passes", () => {});
					test("fails", () => {
						throw "the shop was empty";
					});
					test("passes too", () => {});
				});
			});

			const result = Testing.run();
			expectFalse(result.ok, "ok");
			expectEqual(result.passed, 2, "passed");
			expectEqual(result.failed, 1, "failed");
			expectEqual(result.realm, RunService.IsServer() ? "server" : "client", "realm");
			expectTrue(contains(outcome(result, "counts", "fails").error, "the shop was empty"), "the message");
			expectTrue(outcome(result, "counts", "passes").ok, "a pass");
		},
	],

	[
		"filters select a section, one test, or several, and unknown names make the run not ok",
		() => {
			const ran = new Array<string>();
			fresh(() => {
				defineTests("first", () => {
					test("a", () => ran.push("first/a"));
					test("b", () => ran.push("first/b"));
				});
				defineTests("second", () => {
					test("c", () => ran.push("second/c"));
				});
			});

			expectTrue(Testing.run("first").ok, "one section");
			expectArrayEqual(ran, ["first/a", "first/b"], "the section's tests");

			ran.clear();
			expectTrue(Testing.run(["first/b", "second"]).ok, "a test and a section");
			expectArrayEqual(ran, ["first/b", "second/c"], "the selection, in definition order");

			ran.clear();
			const unknown = Testing.run(["first/a", "third", "first/zzz"]);
			expectFalse(unknown.ok, "unknown names");
			expectArrayEqual(unknown.unknown, ["third", "first/zzz"], "which names");
			expectArrayEqual(ran, ["first/a"], "the known one still ran");
		},
	],

	[
		"a test may yield, and a promise it returns is awaited",
		() => {
			fresh(() => {
				defineTests("async", () => {
					test("yields", () => {
						task.wait(0.05);
					});
					test("resolves", () => Promise.resolve(1));
					test("rejects", () => Promise.reject("nope"));
				});
			});

			const result = Testing.run();
			expectTrue(outcome(result, "async", "yields").ok, "yielding");
			expectTrue(outcome(result, "async", "resolves").ok, "resolving");
			expectFalse(outcome(result, "async", "rejects").ok, "rejecting");
			expectTrue(contains(outcome(result, "async", "rejects").error, "nope"), "the rejection");
		},
	],

	[
		"a test that overruns its timeout is cancelled, fails, and still gets its cleanup",
		() => {
			let cleaned = false;
			let resumed = false;
			fresh(() => {
				defineTests("slow", () => {
					test("never finishes", () => {
						defer(() => {
							cleaned = true;
						});
						task.wait(5);
						resumed = true;
					});
					test("after it", () => {});
				});
			});

			const started = os.clock();
			const result = runQuickly();
			expectTrue(os.clock() - started < 2, "the run did not wait for the body");
			const slow = outcome(result, "slow", "never finishes");
			expectFalse(slow.ok, "overrun fails");
			expectTrue(contains(slow.error, "timed out after 0.2 seconds"), slow.error ?? "");
			expectTrue(cleaned, "cleanup ran");
			expectFalse(resumed, "the body was not resumed");
			expectTrue(outcome(result, "slow", "after it").ok, "the next test still ran");
		},
	],

	[
		"deferred cleanup runs in reverse, even when the body raised, and a raising cleanup fails the test",
		() => {
			const order = new Array<string>();
			fresh(() => {
				defineTests("cleanup", () => {
					test("raises", () => {
						defer(() => order.push("first registered"));
						defer(() => order.push("second registered"));
						throw "body failed";
					});
					test("bad cleanup", () => {
						defer(() => {
							throw "could not clean";
						});
					});
				});
			});

			const result = Testing.run();
			expectArrayEqual(order, ["second registered", "first registered"], "reverse order");
			expectTrue(contains(outcome(result, "cleanup", "raises").error, "body failed"), "the body's failure");

			const bad = outcome(result, "cleanup", "bad cleanup");
			expectFalse(bad.ok, "a raising cleanup is a failure");
			expectTrue(
				contains(bad.error, "cleanup raised:") && contains(bad.error, "could not clean"),
				bad.error ?? "",
			);
		},
	],

	[
		"scratch() is one folder per test in Workspace, destroyed afterwards, and defer() needs a running test",
		() => {
			let folder: Folder | undefined;
			fresh(() => {
				defineTests("scratch", () => {
					test("builds", () => {
						folder = scratch();
						expectEqual(scratch(), folder, "the same folder on the second call");
						expectEqual(folder.Parent, Workspace, "in Workspace");
						const part = new Instance("Part");
						part.Parent = folder;
					});
				});
			});

			expectTrue(Testing.run().ok, "the test passed");
			expectEqual(expectDefined(folder).Parent, undefined, "destroyed after the test");
			expectTrue(
				contains(
					expectThrows(() => defer(() => {})),
					"while a test is running",
				),
			);
			expectTrue(
				contains(
					expectThrows(() => scratch()),
					"while a test is running",
				),
			);
		},
	],

	[
		"beforeEach and afterEach wrap every test, afterEach runs on failure, and a raising hook fails the test",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("hooks", () => {
					beforeEach(() => log.push("before"));
					afterEach(() => log.push("after"));
					test("passes", () => log.push("passes"));
					test("fails", () => {
						log.push("fails");
						throw "boom";
					});
				});
				defineTests("bad hook", () => {
					beforeEach(() => {
						throw "setup broke";
					});
					test("never runs", () => log.push("should not run"));
				});
			});

			const result = Testing.run();
			expectArrayEqual(log, ["before", "passes", "after", "before", "fails", "after"], "the order");
			const skipped = outcome(result, "bad hook", "never runs");
			expectFalse(skipped.ok, "a raising beforeEach fails the test");
			expectTrue(
				contains(skipped.error, "beforeEach raised:") && contains(skipped.error, "setup broke"),
				skipped.error ?? "",
			);
		},
	],

	[
		"list reports the selection without running anything",
		() => {
			let ran = false;
			fresh(() => {
				defineTests("quiet", () => {
					test("noisy", () => {
						ran = true;
					});
				});
			});

			const listed = Testing.list("quiet");
			expectArrayEqual(testNames(listed, "quiet"), ["noisy"]);
			expectFalse(ran, "nothing ran");
			expectFalse(Testing.list("missing").ok, "an unknown name is reported when listing too");
		},
	],

	[
		"a run started during a run is refused",
		() => {
			fresh(() => {
				defineTests("reentrant", () => {
					test("runs again", () => {
						Testing.run();
					});
				});
			});

			const result = Testing.run();
			expectTrue(
				contains(outcome(result, "reentrant", "runs again").error, "already in progress"),
				"the inner run raised",
			);
		},
	],

	[
		"the plugin is inert while disabled: no instances and nothing loaded",
		() => {
			fresh(() => {});
			const module = Flamework.createModule()
				.includePlugin(createTestingPlugin({ enabled: false }))
				.build()
				.ignite();

			expectFalse(internal.__isAttached(), "attached");
			expectEqual(Workspace.FindFirstChild("FlameworkTests"), undefined, "the bindable");
			module.extinguish();
		},
	],

	[
		"on the server the plugin creates the bindable and the remote, answers them, and removes them",
		() => {
			if (!RunService.IsServer()) return;

			fresh(() => {
				defineTests("hosted", () => {
					test("answers", () => {});
				});
			});

			const module = Flamework.createModule()
				.includePlugin(createTestingPlugin({ enabled: true, timeout: 1 }))
				.build()
				.ignite();

			const bindable = expectDefined(
				Workspace.FindFirstChild("FlameworkTests"),
				"the bindable",
			) as BindableFunction;
			const remote = expectDefined(
				Workspace.FindFirstChild("FlameworkTestsServer"),
				"the remote",
			) as RemoteFunction;

			const viaBindable = bindable.Invoke("hosted") as RunResult;
			expectTrue(viaBindable.ok, "invoked through the bindable");
			expectEqual(viaBindable.passed, 1, "one test");

			const viaRemote = remote.InvokeServer(undefined, { list: true }) as RunResult;
			expectTrue(viaRemote.listed === true, "listed through the remote");

			expectTrue(Testing.runOnServer("hosted").ok, "runOnServer on the server runs locally");

			module.extinguish();
			expectEqual(Workspace.FindFirstChild("FlameworkTests"), undefined, "the bindable is gone");
			expectEqual(Workspace.FindFirstChild("FlameworkTestsServer"), undefined, "the remote is gone");
		},
	],

	[
		"two modules share one host and the last to extinguish removes it",
		() => {
			if (!RunService.IsServer()) return;

			fresh(() => {});
			const plugin = createTestingPlugin({ enabled: true });
			const first = Flamework.createModule().includePlugin(plugin).build().ignite();
			const second = Flamework.createModule().includePlugin(plugin).build().ignite();

			expectEqual(
				Workspace.GetChildren()
					.filter((child) => child.Name === "FlameworkTests")
					.size(),
				1,
				"one bindable",
			);
			first.extinguish();
			expectDefined(Workspace.FindFirstChild("FlameworkTests"), "still there for the second module");
			second.extinguish();
			expectEqual(Workspace.FindFirstChild("FlameworkTests"), undefined, "gone with the last");
		},
	],

	[
		"autoRun runs everything once ignition has finished",
		() => {
			if (!RunService.IsServer()) return;

			let ran = false;
			fresh(() => {
				defineTests("auto", () => {
					test("runs by itself", () => {
						ran = true;
					});
				});
			});

			const module = Flamework.createModule()
				.includePlugin(createTestingPlugin({ enabled: true, autoRun: true }))
				.build()
				.ignite();

			expectFalse(ran, "not during ignition");
			task.wait();
			expectTrue(ran, "after it");
			module.extinguish();
		},
	],
]);
