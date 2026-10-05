import * as core from "@flamework-experimental/core";
import { Flamework, Provider, type Module, type OnStart } from "@flamework-experimental/core";
import * as testing from "@flamework-experimental/testing";
import {
	PROJECT_ATTRIBUTE,
	Testing,
	afterEach,
	beforeEach,
	createTestingPlugin,
	defer,
	defineTests,
	getProject,
	runTests,
	scratch,
	skip,
	test,
	type RunResult,
	type TestingOptions,
} from "@flamework-experimental/testing";
import { RunService, Workspace } from "@rbxts/services";
import {
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectFalse,
	expectThrows,
	expectTrue,
	suite,
} from "../testkit";

/**
 * The registry is process-wide, as it is in a game, so every case starts it empty. The reset and
 * the attachment probe are internal and stripped from the package's types, hence the cast.
 */
const internal = testing as unknown as { __resetTests: () => void; __isAttached: () => boolean };

/** The active scopes are compiled in; the specs set them the way the scopes suite does. */
const scopeHarness = core as unknown as { __setActiveScopes: (scopes: readonly string[] | undefined) => void };

/** What a provider sees as its section's module when it defines tests as it starts. */
let moduleSeenFromStart: Module | undefined;

@Provider()
class StartTests implements OnStart {
	onStart() {
		defineTests("provider", ({ module }) => {
			moduleSeenFromStart = module;
			test("registered from onStart", () => {});
		});
	}
}

function fresh(define: () => void) {
	internal.__resetTests();
	define();
}

function contains(message: string | undefined, text: string) {
	return message !== undefined && message.find(text, 1, true)[0] !== undefined;
}

/**
 * Whether `message` was raised at a line of this file and starts with `pattern` (a Lua pattern):
 * that the error's level points at the caller, not into the package. The harness names a module's
 * chunk `[string "<path>"]`.
 */
function raisedHere(message: string, pattern: string) {
	return message.match(`testing%.luau"%]:%d+: ${pattern}`)[0] !== undefined;
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

declare const __harness: {
	/**
	 * Runs the callback as the other realm would. A single-realm graph has no client, so this is how
	 * a server spec reaches its own remote from the side the engine lets call it.
	 */
	asRealm: (realm: "Server" | "Client", callback: () => void) => void;

	/** Runs the callback and returns what `print` and `warn` wrote meanwhile, a warning's with `[warn] ` in front. */
	captureOutput: (callback: () => void) => string[];
};

/** A run with a short timeout, for the cases about overrunning tests. */
function runQuickly(filter?: testing.TestFilter) {
	return runTests(filter, undefined, { timeout: 0.2 });
}

/** How many tests are inside a stretch of their bodies at once, and the most there ever were. */
function overlapMeter() {
	let inside = 0;
	let most = 0;
	return {
		enter: () => {
			inside++;
			most = math.max(most, inside);
		},
		leave: () => {
			inside--;
		},
		inside: () => inside,
		most: () => most,
		reset: () => {
			inside = 0;
			most = 0;
		},
	};
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
			expectEqual(result.skipped, 0, "skipped");
			expectEqual(result.realm, RunService.IsServer() ? "server" : "client", "realm");
			expectTrue(contains(outcome(result, "counts", "fails").error, "the shop was empty"), "the message");
			expectEqual(outcome(result, "counts", "fails").status, "failed", "a failure's status");
			expectTrue(outcome(result, "counts", "passes").ok, "a pass");
			expectEqual(outcome(result, "counts", "passes").status, "passed", "a pass's status");
			expectEqual(outcome(result, "counts", "passes").skipReason, undefined, "no skip reason on a pass");
		},
	],

	[
		"getProject() is the project flamework-test stamped on Workspace, carried by the result, and nothing in a place it did not make",
		() => {
			fresh(() => {
				defineTests("stamped", () => {
					test("reads it", () => {});
				});
			});

			expectEqual(getProject(), undefined, "no attribute, no project");
			expectEqual(Testing.run().project, undefined, "the result says so too");

			Workspace.SetAttribute(PROJECT_ATTRIBUTE, "deferred");
			try {
				expectEqual(getProject(), "deferred", "the attribute's value");
				expectEqual(Testing.run().project, "deferred", "on the run");
				expectEqual(Testing.list().project, "deferred", "and on a listing");
			} finally {
				Workspace.SetAttribute(PROJECT_ATTRIBUTE, undefined);
			}

			Workspace.SetAttribute(PROJECT_ATTRIBUTE, 7);
			try {
				expectEqual(getProject(), undefined, "only a string names a project");
			} finally {
				Workspace.SetAttribute(PROJECT_ATTRIBUTE, undefined);
			}
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
			expectEqual(skipped.status, "failed", "a failure, not a skip");
			expectTrue(
				contains(skipped.error, "beforeEach raised:") && contains(skipped.error, "setup broke"),
				skipped.error ?? "",
			);
		},
	],

	[
		"skip() stops the test there and reports it as skipped with its reason, counted apart from passes and failures",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("skips", () => {
					test("skipped", () => {
						log.push("before the skip");
						skip("the shop is closed today");
						log.push("after the skip");
					});
					test("passes", () => {});
					test("fails", () => {
						throw "the till was empty";
					});
				});
			});

			const result = Testing.run();
			expectArrayEqual(log, ["before the skip"], "the body stopped at skip()");

			const skipped = outcome(result, "skips", "skipped");
			expectEqual(skipped.status, "skipped", "status");
			expectTrue(skipped.ok, "a skip is not a failure");
			expectEqual(skipped.skipReason, "the shop is closed today", "the reason");
			expectEqual(skipped.error, undefined, "no error");

			expectEqual(result.passed, 1, "passed, without the skip");
			expectEqual(result.failed, 1, "failed");
			expectEqual(result.skipped, 1, "skipped");
			const section = expectDefined(result.sections.find((candidate) => candidate.name === "skips"));
			expectEqual(section.passed, 1, "the section's passes");
			expectEqual(section.failed, 1, "the section's failures");
			expectEqual(section.skipped, 1, "the section's skips");
			expectFalse(result.ok, "the failure still fails the run");

			const green = Testing.run(["skips/skipped", "skips/passes"]);
			expectTrue(green.ok, "a skip leaves the run ok");
			expectEqual(green.passed, 1, "passed");
			expectEqual(green.skipped, 1, "skipped");
		},
	],

	[
		"skip() works after a yield and from a Promise the body returns",
		() => {
			fresh(() => {
				defineTests("later", () => {
					test("after a yield", () => {
						task.wait(0.05);
						skip("decided after waiting");
					});
					test("in a promise", () => Promise.try(() => skip("decided in a promise")));
				});
			});

			const result = Testing.run();
			expectTrue(result.ok, "ok");
			expectEqual(result.skipped, 2, "both skipped");
			expectEqual(outcome(result, "later", "after a yield").skipReason, "decided after waiting");
			expectEqual(outcome(result, "later", "in a promise").skipReason, "decided in a promise");
		},
	],

	[
		"skip() from a beforeEach skips the test without its body or the later hooks, and its cleanup still runs",
		() => {
			const log = new Array<string>();
			let skipping = true;
			fresh(() => {
				defineTests("setup skips", () => {
					beforeEach(() => {
						defer(() => log.push("deferred by the hook"));
						if (skipping) skip("no server to talk to");
					});
					beforeEach(() => log.push("second beforeEach"));
					afterEach(() => log.push("afterEach"));
					test("needs a server", () => log.push("body"));
				});
			});

			const result = Testing.run();
			const skipped = outcome(result, "setup skips", "needs a server");
			expectEqual(skipped.status, "skipped", "status");
			expectEqual(skipped.skipReason, "no server to talk to", "the reason");
			expectArrayEqual(log, ["deferred by the hook", "afterEach"], "what ran");
			expectTrue(result.ok, "ok");

			skipping = false;
			log.clear();
			expectTrue(Testing.run().ok, "runs once the hook lets it");
			expectArrayEqual(log, ["second beforeEach", "body", "deferred by the hook", "afterEach"], "what ran then");
		},
	],

	[
		"a pcall in the test that catches skip()'s error does not undo the skip",
		() => {
			let caughtOk: boolean | undefined;
			let caughtMessage = "";
			let wentOn = false;
			fresh(() => {
				defineTests("caught", () => {
					test("pcall around skip", () => {
						const [ok, err] = pcall((): void => skip("caught but kept"));
						caughtOk = ok;
						caughtMessage = tostring(err);
						wentOn = true;
						throw "raised after the skip";
					});
					test("two skips", () => {
						pcall((): void => skip("the first reason"));
						skip("the second reason");
					});
					test("expectThrows around skip", () => {
						expectThrows(() => skip("thrown at expectThrows"));
					});
					test("hangs after a caught skip", () => {
						pcall((): void => skip("then it hung"));
						task.wait(5);
					});
				});
			});

			const result = runQuickly();
			const caught = outcome(result, "caught", "pcall around skip");
			expectEqual(caught.status, "skipped", "status");
			expectEqual(caught.skipReason, "caught but kept", "the reason");
			expectEqual(caught.error, undefined, "what the body raised after the skip is not its failure");
			expectEqual(caughtOk, false, "the pcall caught the skip's error");
			expectTrue(contains(caughtMessage, "the test was skipped: caught but kept"), caughtMessage);
			expectTrue(wentOn, "the body went on past the pcall");

			expectEqual(
				outcome(result, "caught", "two skips").skipReason,
				"the first reason",
				"the first skip's reason",
			);
			expectEqual(outcome(result, "caught", "expectThrows around skip").status, "skipped", "under expectThrows");

			const hung = outcome(result, "caught", "hangs after a caught skip");
			expectEqual(hung.status, "skipped", "a timeout past the skip is not a failure");
			expectEqual(hung.skipReason, "then it hung", "the reason");
			expectTrue(result.ok, "ok");
			expectEqual(result.skipped, 4, "skipped");
		},
	],

	[
		"defer callbacks and afterEach hooks run after a skip, and one that raises fails the test",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("cleaned", () => {
					afterEach(() => log.push("afterEach"));
					test("defers, then skips", () => {
						defer(() => log.push("deferred"));
						skip("nothing to do");
					});
					test("raising defer", () => {
						defer(() => {
							throw "could not clean";
						});
						skip("skipped first");
					});
				});
				defineTests("raising afterEach", () => {
					afterEach(() => {
						throw "teardown broke";
					});
					test("skips", () => skip("skipped before teardown"));
				});
			});

			const result = Testing.run();
			expectEqual(outcome(result, "cleaned", "defers, then skips").status, "skipped", "skipped");
			expectArrayEqual(log, ["deferred", "afterEach", "afterEach"], "the cleanup ran for both");

			const badDefer = outcome(result, "cleaned", "raising defer");
			expectEqual(badDefer.status, "failed", "a raising defer fails a skipped test");
			expectFalse(badDefer.ok, "not ok");
			expectEqual(badDefer.skipReason, undefined, "a failure has no skip reason");
			expectTrue(
				contains(badDefer.error, "skipped (skipped first), but its cleanup failed:") &&
					contains(badDefer.error, "cleanup raised:") &&
					contains(badDefer.error, "could not clean"),
				badDefer.error ?? "",
			);

			const badHook = outcome(result, "raising afterEach", "skips");
			expectEqual(badHook.status, "failed", "a raising afterEach fails a skipped test");
			expectTrue(
				contains(badHook.error, "afterEach raised:") && contains(badHook.error, "teardown broke"),
				badHook.error ?? "",
			);

			expectFalse(result.ok, "the failures fail the run");
			expectEqual(result.skipped, 1, "skipped");
			expectEqual(result.failed, 2, "failed");
		},
	],

	[
		"skip() outside a running test raises, and from a defer callback or an afterEach it fails the test",
		() => {
			fresh(() => {
				defineTests("late skips", () => {
					test("skips in a defer", () => {
						defer(() => skip("too late"));
					});
				});
				defineTests("skipping afterEach", () => {
					afterEach(() => skip("too late as well"));
					test("passes", () => {});
				});
			});

			const outside = expectThrows(() => skip("nothing is running"));
			expectTrue(contains(outside, "skip() can only be called while a test is running"), outside);
			expectTrue(raisedHere(outside, "skip%(%) can only"), `raised at the caller: ${outside}`);

			const result = Testing.run();
			const inDefer = outcome(result, "late skips", "skips in a defer");
			expectEqual(inDefer.status, "failed", "a skip from a defer callback");
			expectTrue(
				contains(inDefer.error, "cleanup raised:") &&
					contains(inDefer.error, "not from a defer callback or an afterEach"),
				inDefer.error ?? "",
			);

			const inHook = outcome(result, "skipping afterEach", "passes");
			expectEqual(inHook.status, "failed", "a skip from an afterEach");
			expectTrue(
				contains(inHook.error, "afterEach raised:") &&
					contains(inHook.error, "not from a defer callback or an afterEach"),
				inHook.error ?? "",
			);
			expectEqual(result.skipped, 0, "neither counts as a skip");
		},
	],

	[
		"test.skip registers a test that is reported as skipped without running, listed and filtered like any other",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("marked", () => {
					beforeEach(() => log.push("beforeEach"));
					afterEach(() => log.push("afterEach"));
					test.skip("not yet", () => log.push("the skipped body"));
					test("runs", () => log.push("body"));
				});
			});

			const listed = Testing.list();
			expectArrayEqual(testNames(listed, "marked"), ["not yet", "runs"], "both are listed");
			expectEqual(outcome(listed, "marked", "not yet").status, "skipped", "a listing marks it");
			expectEqual(outcome(listed, "marked", "not yet").skipReason, "marked with test.skip", "the listed reason");
			expectEqual(outcome(listed, "marked", "runs").status, "passed", "the other one");
			expectEqual(listed.skipped, 0, "a listing counts nothing");
			expectArrayEqual(testNames(Testing.list("marked/not yet"), "marked"), ["not yet"], "a filter lists it");
			expectEqual(log.size(), 0, "the listing ran nothing");

			const alone = Testing.run("marked/not yet");
			expectTrue(alone.ok, "ok");
			expectEqual(alone.passed, 0, "passed");
			expectEqual(alone.skipped, 1, "skipped");
			const marked = outcome(alone, "marked", "not yet");
			expectEqual(marked.status, "skipped", "status");
			expectTrue(marked.ok, "not a failure");
			expectEqual(marked.skipReason, "marked with test.skip", "the reason");
			expectEqual(marked.durationMs, 0, "no time spent");
			expectEqual(log.size(), 0, "neither its body nor the section's hooks ran");

			const whole = Testing.run("marked");
			expectEqual(whole.passed, 1, "the other test ran");
			expectEqual(whole.skipped, 1, "the marked one did not");
			expectArrayEqual(log, ["beforeEach", "body", "afterEach"], "the hooks ran for the other test only");
		},
	],

	[
		"test and test.skip refuse a duplicate name and a call outside a body, raising at the caller",
		() => {
			fresh(() => {});
			const stray = expectThrows(() => test("stray", () => {}));
			expectTrue(contains(stray, "test() can only be called inside a defineTests body"), stray);
			expectTrue(raisedHere(stray, "test%(%) can only"), `raised at the caller: ${stray}`);

			const straySkip = expectThrows(() => test.skip("stray", () => {}));
			expectTrue(contains(straySkip, "test.skip() can only be called inside a defineTests body"), straySkip);
			expectTrue(raisedHere(straySkip, "test%.skip%(%) can only"), `raised at the caller: ${straySkip}`);

			const duplicate = expectThrows(() =>
				defineTests("twice", () => {
					test("same", () => {});
					test.skip("same", () => {});
				}),
			);
			expectTrue(contains(duplicate, "already has a test named 'same'"), duplicate);
			expectTrue(raisedHere(duplicate, "section 'twice' already has"), `raised at the caller: ${duplicate}`);
		},
	],

	[
		"the [FWTEST] lines: a skip gets its own line with its reason, and the summary counts passes, failures and skips",
		() => {
			const realm = RunService.IsServer() ? "server" : "client";
			fresh(() => {
				defineTests("lines", () => {
					test("passes", () => {});
					test("fails", () => {
						throw "broken";
					});
					test("asleep", () => skip("the display is asleep"));
					test.skip("marked", () => {});
				});
			});

			const lines = __harness.captureOutput(() => Testing.run());
			const has = (pattern: string) => lines.some((line) => line.match(pattern)[0] !== undefined);
			const describe = lines.join(" | ");

			expectTrue(has(`^%[FWTEST%] ${realm} lines/passes: PASS %(%d+ms%)$`), `the pass: ${describe}`);
			expectTrue(has(`^%[warn%] %[FWTEST%] ${realm} lines/fails: FAIL %(%d+ms%): `), `the failure: ${describe}`);
			expectTrue(
				has(`^%[FWTEST%] ${realm} lines/asleep: SKIP %(%d+ms%): the display is asleep$`),
				`the skip, printed rather than warned: ${describe}`,
			);
			expectTrue(
				has(`^%[FWTEST%] ${realm} lines/marked: SKIP %(0ms%): marked with test%.skip$`),
				`the marked skip: ${describe}`,
			);
			expectTrue(
				has(`^%[warn%] %[FWTEST%] ${realm} SUMMARY: 1 passed, 1 failed, 2 skipped %(%d+ms%)$`),
				`the summary of a failing run: ${describe}`,
			);

			const green = __harness.captureOutput(() =>
				Testing.run(["lines/passes", "lines/asleep", "lines/marked", "nowhere"]),
			);
			const greenText = green.join(" | ");
			expectTrue(
				green.some(
					(line) =>
						line.match(
							`^%[warn%] %[FWTEST%] ${realm} SUMMARY: 1 passed, 0 failed, 2 skipped %(%d+ms%), unknown: nowhere$`,
						)[0] !== undefined,
				),
				`the unknown entry: ${greenText}`,
			);

			const passing = __harness.captureOutput(() => Testing.run(["lines/passes", "lines/asleep"]));
			expectTrue(
				passing.some(
					(line) =>
						line.match(`^%[FWTEST%] ${realm} SUMMARY: 1 passed, 0 failed, 1 skipped %(%d+ms%)$`)[0] !==
						undefined,
				),
				`the summary of a passing run, printed: ${passing.join(" | ")}`,
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
			// Studio may run its MCP server's Luau sandboxed, which may only invoke a Sandboxed bindable.
			expectTrue(bindable.Sandboxed, "the bindable is Sandboxed, for Studio's sandboxed MCP code");

			const viaBindable = bindable.Invoke("hosted") as RunResult;
			expectTrue(viaBindable.ok, "invoked through the bindable");
			expectEqual(viaBindable.passed, 1, "one test");

			// Only a client may invoke a RemoteFunction's server side: the server calling it on its
			// own remote raises, as it does in a place.
			expectThrows(() => remote.InvokeServer(undefined, { list: true }), "InvokeServer from the server");

			let viaRemote: RunResult | undefined;
			__harness.asRealm("Client", () => {
				viaRemote = remote.InvokeServer(undefined, { list: true }) as RunResult;
			});
			expectTrue(viaRemote?.listed === true, "listed through the remote");

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

	[
		"a provider defining tests as it starts gets the igniting module as the section's context",
		() => {
			if (!RunService.IsServer()) return;

			fresh(() => {});
			moduleSeenFromStart = undefined;
			const module = Flamework.createModule()
				.includePlugin(createTestingPlugin({ enabled: true }))
				.registerClassProvider(StartTests)
				.ignite();

			expectEqual(moduleSeenFromStart, module, "the section's module");
			expectTrue(Testing.run("provider").ok, "its test runs");
			module.extinguish();
		},
	],

	[
		"without enabled the host follows the scope condition, the testing scope by default, and enabled overrides it",
		() => {
			if (!RunService.IsServer()) return;

			fresh(() => {});
			const attachedWith = (scopes: readonly string[] | undefined, options?: TestingOptions) => {
				scopeHarness.__setActiveScopes(scopes);
				try {
					const module = Flamework.createModule().includePlugin(createTestingPlugin(options)).ignite();
					const attached = internal.__isAttached();
					module.extinguish();
					return attached;
				} finally {
					scopeHarness.__setActiveScopes(undefined);
				}
			};

			expectFalse(attachedWith(undefined), "no scope active");
			expectTrue(attachedWith(["testing"]), "the testing scope");
			expectTrue(attachedWith(["qa"], { activeIn: ["qa", "testing"] }), "any of the listed scopes");
			expectFalse(attachedWith(["testing"], { inactiveIn: ["testing"] }), "inactiveIn wins");
			expectFalse(attachedWith(["testing"], { enabled: false }), "enabled false overrides an active scope");
			expectTrue(attachedWith(undefined, { enabled: true }), "enabled true overrides no scope");
		},
	],
	[
		"concurrent tests overlap their waits, start in declaration order, report as each ends, and keep declaration order in the result",
		() => {
			const realm = RunService.IsServer() ? "server" : "client";
			const starts = new Array<string>();
			const ends = new Array<string>();
			const meter = overlapMeter();
			const waiting = (name: string, seconds: number) => () => {
				starts.push(name);
				meter.enter();
				task.wait(seconds);
				meter.leave();
				ends.push(name);
			};

			fresh(() => {
				defineTests("overlap", () => {
					test.concurrent("slow", waiting("slow", 0.3));
					test.concurrent("middle", waiting("middle", 0.2));
					test.concurrent("fast", waiting("fast", 0.1));
				});
			});

			let result: RunResult | undefined;
			const started = os.clock();
			const lines = __harness.captureOutput(() => {
				result = runTests(undefined, undefined, { timeout: 5, concurrency: 4 });
			});
			const elapsed = os.clock() - started;
			const run = expectDefined(result, "the result");

			expectTrue(run.ok, "ok");
			expectTrue(elapsed < 0.5, `the waits overlapped: ${elapsed}s, where one after another is 0.6s`);
			expectEqual(meter.most(), 3, "all three at once");
			expectArrayEqual(starts, ["slow", "middle", "fast"], "started in declaration order");
			expectArrayEqual(ends, ["fast", "middle", "slow"], "ended by their waits");
			expectArrayEqual(
				testNames(run, "overlap"),
				["slow", "middle", "fast"],
				"the result keeps declaration order",
			);
			expectEqual(outcome(run, "overlap", "slow").concurrent, true, "a concurrent test's result says so");
			expectEqual(run.concurrency, 4, "the limit the run used");

			const order = new Array<string>();
			for (const line of lines) {
				const [name] = line.match(`^%[FWTEST%] ${realm} overlap/(%a+): PASS`);
				if (typeIs(name, "string")) order.push(name);
			}
			expectArrayEqual(order, ["fast", "middle", "slow"], `a line as each ends: ${lines.join(" | ")}`);
		},
	],

	[
		"a plain test is a barrier between concurrent ones, and so is a section's end",
		() => {
			const log = new Array<string>();
			let othersDuringPlain = -1;
			const meter = overlapMeter();
			const waiting = (name: string, seconds: number) => () => {
				log.push(`${name}+`);
				meter.enter();
				task.wait(seconds);
				meter.leave();
				log.push(`${name}-`);
			};

			fresh(() => {
				defineTests("barrier", () => {
					test.concurrent("a", waiting("a", 0.1));
					test.concurrent("b", waiting("b", 0.15));
					test("plain", () => {
						log.push("plain+");
						othersDuringPlain = meter.inside();
						// Alone, so the functions know which test calls them.
						defer(() => log.push("plain's defer"));
						scratch();
						task.wait(0.05);
						log.push("plain-");
					});
					test.concurrent("c", waiting("c", 0.05));
					test.concurrent("d", waiting("d", 0.1));
				});
				defineTests("next section", { concurrent: true }, () => {
					test("e", waiting("e", 0.05));
				});
			});

			const result = runTests(undefined, undefined, { timeout: 5, concurrency: 4 });
			expectTrue(result.ok, "ok");
			expectEqual(othersDuringPlain, 0, "nothing ran alongside the plain test");
			expectArrayEqual(
				log,
				["a+", "b+", "a-", "b-", "plain+", "plain-", "plain's defer", "c+", "d+", "c-", "d-", "e+", "e-"],
				"the order",
			);
			expectEqual(outcome(result, "barrier", "plain").concurrent, undefined, "a plain test's result has no flag");
		},
	],

	[
		"a test marked with test.skip between concurrent tests is no barrier: the tests on both sides overlap",
		() => {
			const log = new Array<string>();
			const meter = overlapMeter();
			const waiting = (name: string, seconds: number) => () => {
				log.push(`${name}+`);
				meter.enter();
				task.wait(seconds);
				meter.leave();
				log.push(`${name}-`);
			};

			fresh(() => {
				defineTests("parked between", () => {
					test.concurrent("before", waiting("before", 0.15));
					test.skip("parked", () => log.push("parked"));
					test.concurrent("after", waiting("after", 0.05));
				});
			});

			const result = runTests(undefined, undefined, { timeout: 5, concurrency: 4 });
			expectTrue(result.ok, "ok");
			expectEqual(outcome(result, "parked between", "parked").status, "skipped", "the parked test");
			expectEqual(meter.most(), 2, "the tests on both sides ran at once");
			expectArrayEqual(log, ["before+", "after+", "after-", "before-"], "the order");
			expectArrayEqual(
				testNames(result, "parked between"),
				["before", "parked", "after"],
				"the result keeps the parked test in its place",
			);
		},
	],

	[
		"at most concurrency tests run at once, from the config or the run's option, and 1 runs them one at a time",
		() => {
			const meter = overlapMeter();
			fresh(() => {
				defineTests("limited", { concurrent: true }, () => {
					for (let i = 1; i <= 6; i++) {
						test(`t${i}`, () => {
							meter.enter();
							task.wait(0.05);
							meter.leave();
						});
					}
				});
			});

			const config = { timeout: 5, concurrency: 2 };
			const limited = runTests(undefined, undefined, config);
			expectTrue(limited.ok, "ok");
			expectEqual(meter.most(), 2, "the config's limit");
			expectEqual(limited.concurrency, 2, "reported");

			meter.reset();
			expectEqual(runTests(undefined, { concurrency: 3 }, config).concurrency, 3, "the option is reported");
			expectEqual(meter.most(), 3, "the run's option overrides the config");

			meter.reset();
			const serial = runTests(undefined, { concurrency: 1 }, config);
			expectEqual(meter.most(), 1, "one at a time");
			expectEqual(outcome(serial, "limited", "t1").concurrent, true, "still concurrent tests");

			meter.reset();
			const byDefault = runTests(undefined, undefined, { timeout: 5 });
			expectEqual(byDefault.concurrency, testing.DEFAULT_CONCURRENCY, "the default");
			expectEqual(meter.most(), 4, "four by default");

			const listed = runTests(undefined, { list: true, concurrency: 3 }, config);
			expectEqual(listed.concurrency, 3, "a listing reports the limit");
			expectEqual(outcome(listed, "limited", "t1").concurrent, true, "and marks concurrent tests");
			expectEqual(meter.most(), 4, "a listing runs nothing");

			for (const bad of [0, 1.5, -2]) {
				const message = expectThrows(() => runTests(undefined, { concurrency: bad }, config));
				expectTrue(contains(message, "concurrency must be a whole number, 1 or more"), message);
			}
		},
	],

	[
		"each test and its hooks receive the test's context, with its own defer, scratch and skip",
		() => {
			const seen = new Array<string>();
			const folders = new Map<string, Folder>();
			const cleanup = new Array<string>();
			fresh(() => {
				defineTests("context", { concurrent: true }, () => {
					beforeEach((t) => seen.push(`before ${t.section}/${t.name} ${t.concurrent}`));
					afterEach((t) => seen.push(`after ${t.name}`));
					const body = (t: testing.TestContext) => {
						const folder = t.scratch();
						folders.set(t.name, folder);
						expectEqual(t.scratch(), folder, "the same folder on the second call");
						t.defer(() => cleanup.push(`${t.name} first`));
						t.defer(() => cleanup.push(`${t.name} second`));
						task.wait(t.name === "first" ? 0.1 : 0.05);
						expectEqual(folder.Parent, Workspace, "still there while the test runs");
					};
					test("first", body);
					test("second", body);
				});
				defineTests("plain context", () => {
					test("plain", (t) => {
						seen.push(`plain ${t.section}/${t.name} ${t.concurrent}`);
						expectEqual(t.scratch(), scratch(), "in a plain test the context and the function agree");
					});
				});
			});

			const result = Testing.run();
			expectTrue(result.ok, `ok: ${outcome(result, "context", "first").error ?? ""}`);
			const first = expectDefined(folders.get("first"), "the first folder");
			const second = expectDefined(folders.get("second"), "the second folder");
			expectTrue(first !== second, "a folder per test");
			expectEqual(first.Parent, undefined, "destroyed after its test");
			expectEqual(second.Parent, undefined, "destroyed after its test");
			expectArrayEqual(
				cleanup,
				["second second", "second first", "first second", "first first"],
				"each test's defers in reverse, as it ends",
			);
			expectArrayEqual(
				seen,
				[
					"before context/first true",
					"before context/second true",
					"after second",
					"after first",
					"plain plain context/plain false",
				],
				"what the hooks and the plain test saw",
			);
		},
	],

	[
		"defer, scratch and skip raise in a concurrent test, whatever the limit, and point at the context's",
		() => {
			fresh(() => {
				defineTests("globals", { concurrent: true }, () => {
					test("defer", () => defer(() => {}));
					test("scratch", () => {
						scratch();
					});
					test("skip", () => skip("not from here"));
				});
				defineTests("global in a hook", { concurrent: true }, () => {
					beforeEach(() => defer(() => {}));
					test("hooked", () => {});
				});
			});

			for (const concurrency of [4, 1]) {
				const result = runTests(undefined, { concurrency }, { timeout: 5 });
				for (const [name, method] of [
					["defer", "t.defer()"],
					["scratch", "t.scratch()"],
					["skip", "t.skip()"],
				] as const) {
					const failed = outcome(result, "globals", name);
					expectEqual(failed.status, "failed", `${name}() in a concurrent test, limit ${concurrency}`);
					expectTrue(
						contains(
							failed.error,
							`${name}() cannot tell which test called it while concurrent tests are running`,
						) && contains(failed.error, method),
						failed.error ?? "",
					);
					expectTrue(
						raisedHere(failed.error ?? "", `${name}%(%) cannot tell`),
						`raised at the caller: ${failed.error}`,
					);
				}

				const hooked = outcome(result, "global in a hook", "hooked");
				expectTrue(
					contains(hooked.error, "beforeEach raised:") && contains(hooked.error, "t.defer()"),
					hooked.error ?? "",
				);
				expectEqual(result.skipped, 0, "skip() there is no skip");
			}

			expectTrue(
				contains(
					expectThrows(() => defer(() => {})),
					"while a test is running",
				),
				"and outside any test, as before",
			);
		},
	],

	[
		"a plain test's stray thread calling defer, scratch or skip while concurrent tests run raises there and leaves their results alone",
		() => {
			const meter = overlapMeter();
			const raised = new Map<string, string>();
			const alongside = new Map<string, number>();
			const scratchFolders = () =>
				Workspace.GetChildren()
					.filter((child) => child.Name === "FlameworkTestScratch")
					.size();
			const waiting = () => {
				meter.enter();
				task.wait(0.2);
				meter.leave();
			};

			fresh(() => {
				defineTests("stray", () => {
					test("plain", () => {
						// Threads that outlive the test and call the functions once the concurrent tests run.
						for (const [name, call] of [
							["defer", () => defer(() => {})],
							["scratch", () => scratch()],
							["skip", () => skip("from a stray thread")],
						] as const) {
							task.delay(0.05, () => {
								alongside.set(name, meter.inside());
								const [ok, err] = pcall(() => {
									call();
								});
								raised.set(name, ok ? "nothing raised" : tostring(err));
							});
						}
					});
					test.concurrent("first", waiting);
					test.concurrent("second", waiting);
				});
			});

			const folders = scratchFolders();
			const result = runTests(undefined, undefined, { timeout: 5, concurrency: 4 });
			for (const name of ["defer", "scratch", "skip"]) {
				expectEqual(alongside.get(name), 2, `${name}() was called while both concurrent tests ran`);
				const message = raised.get(name);
				expectTrue(
					contains(message, `${name}() cannot tell which test called it while concurrent tests are running`),
					`${name}() raised in the stray thread: ${message}`,
				);
			}

			expectTrue(result.ok, "ok");
			expectEqual(outcome(result, "stray", "first").status, "passed", "the first concurrent test");
			expectEqual(outcome(result, "stray", "second").status, "passed", "the second");
			expectEqual(result.skipped, 0, "the stray skip() marked no test");
			expectEqual(scratchFolders(), folders, "the stray scratch() made no folder");
		},
	],

	[
		"a concurrent test that overruns or fails holds up no other beyond its own timeout",
		() => {
			let cleaned = false;
			fresh(() => {
				defineTests("overrun", { concurrent: true }, () => {
					test("hangs", (t) => {
						t.defer(() => {
							cleaned = true;
						});
						task.wait(5);
					});
					test("fails", () => {
						task.wait(0.05);
						throw "broken";
					});
					test("passes", () => task.wait(0.05));
					test("passes after", () => task.wait(0.05));
				});
			});

			const started = os.clock();
			const result = runTests(undefined, { concurrency: 3 }, { timeout: 0.3 });
			const elapsed = os.clock() - started;

			const hung = outcome(result, "overrun", "hangs");
			expectEqual(hung.status, "failed", "the overrun fails");
			expectTrue(contains(hung.error, "timed out after 0.3 seconds"), hung.error ?? "");
			expectTrue(cleaned, "its cleanup ran");
			expectTrue(contains(outcome(result, "overrun", "fails").error, "broken"), "the failure");
			expectEqual(outcome(result, "overrun", "passes").status, "passed", "a neighbour passes");
			const after = outcome(result, "overrun", "passes after");
			expectEqual(after.status, "passed", "the next one took a free slot");
			expectTrue(after.durationMs < 250, `and did not wait for the overrun: ${after.durationMs}ms`);
			expectTrue(elapsed < 1, `the run waited only for the timeout: ${elapsed}s`);
			expectEqual(result.failed, 2, "failed");
			expectEqual(result.passed, 2, "passed");
		},
	],

	[
		"t.skip skips its own test from the body or a beforeEach, a pcall does not undo it, and from an afterEach it fails the test",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("context skips", { concurrent: true }, () => {
					beforeEach((t) => {
						if (t.name === "in a hook") t.skip("the hook said so");
					});
					afterEach((t) => {
						log.push(`afterEach ${t.name}`);
						if (t.name === "in an afterEach") t.skip("too late");
					});
					test("in the body", (t) => {
						task.wait(0.05);
						t.skip("the body said so");
						log.push("past the skip");
					});
					test("in a hook", () => log.push("the hooked body"));
					test("caught", (t) => {
						pcall((): void => t.skip("caught but kept"));
						throw "raised after the skip";
					});
					test("in an afterEach", () => {});
					test("passes", () => task.wait(0.05));
				});
			});

			const result = Testing.run();
			expectEqual(outcome(result, "context skips", "in the body").skipReason, "the body said so", "the body's");
			expectEqual(outcome(result, "context skips", "in a hook").skipReason, "the hook said so", "the hook's");
			expectEqual(outcome(result, "context skips", "caught").skipReason, "caught but kept", "under a pcall");
			expectEqual(outcome(result, "context skips", "passes").status, "passed", "its neighbour");
			const late = outcome(result, "context skips", "in an afterEach");
			expectEqual(late.status, "failed", "from an afterEach");
			expectTrue(
				contains(late.error, "t.skip() can only be called from a test's body or a beforeEach"),
				late.error ?? "",
			);
			expectFalse(log.includes("past the skip"), "the body stopped at the skip");
			expectFalse(log.includes("the hooked body"), "a hook's skip stops the body");
			expectTrue(log.includes("afterEach in a hook"), "the afterEach hooks ran after a skip");
			expectEqual(result.skipped, 3, "skipped");
			expectEqual(result.failed, 1, "failed");
		},
	],

	[
		"t.defer, t.scratch and t.skip raise at their caller once their test is over",
		() => {
			let kept: testing.TestContext | undefined;
			fresh(() => {
				defineTests("outlived", () => {
					test.concurrent("keeps its context", (t) => {
						kept = t;
					});
				});
			});

			expectTrue(Testing.run().ok, "ok");
			const context = expectDefined(kept, "the context");
			for (const [method, call] of [
				["defer", () => context.defer(() => {})],
				["scratch", () => context.scratch()],
				["skip", () => context.skip("late")],
			] as const) {
				const message = expectThrows(call);
				expectTrue(
					contains(
						message,
						`t.${method}() was called after the test 'outlived/keeps its context' had finished`,
					),
					message,
				);
				expectTrue(
					raisedHere(message, `t%.${method}%(%) was called after`),
					`raised at the caller: ${message}`,
				);
			}
		},
	],

	[
		"eventually polls in concurrent tests side by side",
		() => {
			let a = false;
			let b = false;
			fresh(() => {
				defineTests("eventually", { concurrent: true }, () => {
					test("sees a", () => {
						task.delay(0.2, () => {
							a = true;
						});
						eventually(() => a, "a");
					});
					test("sees b", () => {
						task.delay(0.2, () => {
							b = true;
						});
						eventually(() => b, "b");
					});
					test("never sees c", () => eventually(() => false, "c", 0.2));
				});
			});

			const started = os.clock();
			const result = Testing.run();
			const elapsed = os.clock() - started;
			expectEqual(outcome(result, "eventually", "sees a").status, "passed", "a");
			expectEqual(outcome(result, "eventually", "sees b").status, "passed", "b");
			expectTrue(
				contains(outcome(result, "eventually", "never sees c").error, "expected c to hold within 0.2 seconds"),
				"c",
			);
			expectTrue(elapsed < 0.5, `the polls overlapped: ${elapsed}s, where one after another is 0.6s`);
		},
	],

	[
		"a raising cleanup or afterEach in a concurrent test fails that test alone",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("cleanups", { concurrent: true }, () => {
					afterEach((t) => {
						log.push(`afterEach ${t.name}`);
						if (t.name === "bad afterEach") throw "teardown broke";
					});
					test("cleans", (t) => {
						t.defer(() => log.push("cleans first"));
						t.defer(() => log.push("cleans second"));
						task.wait(0.15);
					});
					test("bad defer", (t) => {
						t.defer(() => {
							throw "could not clean";
						});
						task.wait(0.05);
					});
					test("bad afterEach", () => task.wait(0.1));
				});
			});

			const result = Testing.run();
			expectEqual(outcome(result, "cleanups", "cleans").status, "passed", "the clean one");
			const badDefer = outcome(result, "cleanups", "bad defer");
			expectTrue(
				contains(badDefer.error, "cleanup raised:") && contains(badDefer.error, "could not clean"),
				badDefer.error ?? "",
			);
			const badHook = outcome(result, "cleanups", "bad afterEach");
			expectTrue(
				contains(badHook.error, "afterEach raised:") && contains(badHook.error, "teardown broke"),
				badHook.error ?? "",
			);
			expectArrayEqual(
				log,
				["afterEach bad defer", "afterEach bad afterEach", "cleans second", "cleans first", "afterEach cleans"],
				"each test's cleanup as it ends",
			);
		},
	],

	[
		"test.concurrent and the section option register concurrent tests, test.skip parks one, and a listing marks them",
		() => {
			const log = new Array<string>();
			fresh(() => {
				defineTests("mixed", () => {
					test("plain", () => log.push("plain"));
					test.concurrent("concurrent", () => log.push("concurrent"));
					test.skip("parked", () => log.push("parked"));
				});
				defineTests("whole", { concurrent: true }, () => {
					test("one", () => log.push("one"));
					test.skip("parked too", () => log.push("parked too"));
				});
				defineTests("whole", () => {
					test("merged plain", () => log.push("merged plain"));
				});
			});

			const listed = Testing.list();
			expectEqual(outcome(listed, "mixed", "plain").concurrent, undefined, "a plain test");
			expectEqual(outcome(listed, "mixed", "concurrent").concurrent, true, "test.concurrent");
			expectEqual(outcome(listed, "mixed", "parked").concurrent, undefined, "test.skip in a plain section");
			expectEqual(outcome(listed, "whole", "one").concurrent, true, "the section's option");
			expectEqual(outcome(listed, "whole", "parked too").concurrent, true, "test.skip under the option");
			expectEqual(outcome(listed, "whole", "parked too").status, "skipped", "still parked");
			expectEqual(
				outcome(listed, "whole", "merged plain").concurrent,
				undefined,
				"the same section defined without the option",
			);

			const result = Testing.run();
			expectTrue(result.ok, "ok");
			expectEqual(result.skipped, 2, "the parked ones");
			expectArrayEqual(log, ["plain", "concurrent", "one", "merged plain"], "what ran");

			const stray = expectThrows(() => test.concurrent("stray", () => {}));
			expectTrue(contains(stray, "test.concurrent() can only be called inside a defineTests body"), stray);
			expectTrue(raisedHere(stray, "test%.concurrent%(%) can only"), `raised at the caller: ${stray}`);

			const duplicate = expectThrows(() =>
				defineTests("twice", () => {
					test("same", () => {});
					test.concurrent("same", () => {});
				}),
			);
			expectTrue(contains(duplicate, "already has a test named 'same'"), duplicate);

			const badOption = expectThrows(() =>
				defineTests("bad", { concurrent: "yes" } as unknown as testing.SectionOptions, () => {}),
			);
			expectTrue(contains(badOption, "the concurrent option of section 'bad' must be a boolean"), badOption);
			const noBody = expectThrows(() =>
				(defineTests as unknown as (name: string, options: testing.SectionOptions) => void)("bodiless", {}),
			);
			expectTrue(contains(noBody, "section 'bodiless' needs a body"), noBody);
		},
	],

	[
		"the plugin takes concurrency from its options, and a run's option overrides it",
		() => {
			if (!RunService.IsServer()) return;

			expectEqual(testing.resolveTestingOptions().concurrency, testing.DEFAULT_CONCURRENCY, "the default");
			expectEqual(testing.resolveTestingOptions({ concurrency: 2 }).concurrency, 2, "an option");

			fresh(() => {
				defineTests("configured", { concurrent: true }, () => test("runs", () => {}));
			});
			const module = Flamework.createModule()
				.includePlugin(createTestingPlugin({ enabled: true, concurrency: 2 }))
				.build()
				.ignite();
			try {
				expectEqual(Testing.run().concurrency, 2, "the host's config");
				expectEqual(Testing.run(undefined, { concurrency: 5 }).concurrency, 5, "the run's option");
				const bindable = Workspace.FindFirstChild("FlameworkTests") as BindableFunction;
				expectEqual((bindable.Invoke(undefined, { concurrency: 3 }) as RunResult).concurrency, 3, "invoked");
			} finally {
				module.extinguish();
			}
		},
	],
]);
