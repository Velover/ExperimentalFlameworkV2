import { OnStart, Provider } from "@flamework-experimental/core";
import { defineTests, expectEqual, expectTrue, getProject, skip, test } from "@flamework-experimental/testing";
import { Workspace } from "@rbxts/services";
import { describeSignalBehavior, measureSignalBehavior } from "./signalBehavior";

/**
 * The Rojo projects `bun run test` runs the suite under: `default.project.json` and the ones under
 * `tests/`, which differ from it only in `Workspace`'s `$properties`. The properties they set are
 * not scriptable once the game runs -- `SignalBehavior`, the streaming radii -- so what a project
 * changes shows only in what the engine does, and this section is where that is checked: measured
 * per realm, against the name the place carries (`getProject()`, the `FlameworkTestProject`
 * attribute the CLI stamps on `Workspace`).
 *
 * A place the CLI did not make -- served by Rojo, opened by hand -- carries no name; the cases
 * skip there, with what they measured as the reason, and assert nothing about it.
 */
const PROJECTS = ["default", "immediate", "deferred", "streaming"];

/** The one project whose place defers its signals. */
const DEFERRED_PROJECT = "deferred";

/** The one project whose place streams. */
const STREAMING_PROJECT = "streaming";

@Provider({ activeIn: ["testing"] })
export class ProjectSpecs implements OnStart {
	onStart() {
		defineTests("projects", () => {
			test("the place carries the name of the project it was made under", () => {
				const project = getProject();
				if (project === undefined) {
					skip("this place was not made by flamework-test, so it carries no project name");
				}

				expectTrue(PROJECTS.includes(project), `a project the suite knows: ${project}`);
			});

			test("every kind of signal is delivered as the project's SignalBehavior says", () => {
				const measured = measureSignalBehavior();
				const project = getProject();
				print(`[projects] ${project ?? "no project"}: ${describeSignalBehavior(measured)}`);
				if (project === undefined) {
					skip(
						`no project to compare with (not made by flamework-test); measured: ${describeSignalBehavior(measured)}`,
					);
				}

				// `Deferred` defers all of them together, in one queue; `Immediate`, and `Default`
				// as this engine reads it, delivers all of them inside the write. A place where some
				// kinds defer and others do not would be `AncestryDeferred`, which no project sets.
				const deferred = project === DEFERRED_PROJECT;
				expectEqual(
					measured.bindable,
					deferred,
					`a BindableEvent fire deferred (${describeSignalBehavior(measured)})`,
				);
				expectEqual(measured.tag, deferred, "a tag announcement deferred");
				expectEqual(measured.child, deferred, "ChildAdded deferred");
				expectEqual(measured.name, deferred, "a Name change deferred");
				expectEqual(measured.attribute, deferred, "an attribute change deferred");
			});

			test("StreamingEnabled follows the project", () => {
				const project = getProject();
				print(`[projects] ${project ?? "no project"}: StreamingEnabled=${Workspace.StreamingEnabled}`);
				if (project === undefined) {
					skip(
						`no project to compare with (not made by flamework-test); StreamingEnabled=${Workspace.StreamingEnabled}`,
					);
				}

				// The one streaming property a script can read; the radii and the model behaviour
				// show only in what reaches the client, which the client's `streaming` section is for.
				expectEqual(Workspace.StreamingEnabled, project === STREAMING_PROJECT, "Workspace.StreamingEnabled");
			});
		});
	}
}
