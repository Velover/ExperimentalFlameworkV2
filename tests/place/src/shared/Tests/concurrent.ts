import { OnStart, Provider } from "@flamework-experimental/core";
import {
	defineTests,
	eventually,
	expectDefined,
	expectEqual,
	expectResolves,
	test,
} from "@flamework-experimental/testing";
import { RunService, Workspace } from "@rbxts/services";

/** How long each case waits on the engine: the section's eight take four seconds one after another. */
const WAIT = 0.5;

/**
 * Concurrent tests against the engine, in both realms: independent cases that spend their time
 * waiting -- on a delay, a signal, a frame, a late child -- each with its own scratch folder and
 * cleanup from its context. With `testing.concurrency` at its default of 4 they overlap, so the
 * section takes about two of its waits rather than eight; `--concurrency 1` runs them one at a time.
 */
@Provider({ activeIn: ["testing"] })
export class ConcurrentSpecs implements OnStart {
	onStart() {
		defineTests("concurrent", { concurrent: true }, () => {
			test("a part built under its scratch folder stays alone there while the others build theirs", (t) => {
				const part = new Instance("Part");
				part.Name = "Mine";
				part.Anchored = true;
				part.Parent = t.scratch();
				task.wait(WAIT);
				expectEqual(t.scratch().FindFirstChild("Mine"), part, "its part");
				expectEqual(t.scratch().GetChildren().size(), 1, "nothing of another test's in its folder");
			});

			test("ChildAdded on its folder hears its own children only", (t) => {
				const folder = t.scratch();
				const heard = new Array<string>();
				const connection = folder.ChildAdded.Connect((child) => heard.push(child.Name));
				t.defer(() => connection.Disconnect());
				for (let i = 1; i <= 5; i++) {
					const child = new Instance("Folder");
					child.Name = `child${i}`;
					child.Parent = folder;
					task.wait(WAIT / 5);
				}

				eventually(() => heard.size() === 5, "the five children");
				expectEqual(heard.join(","), "child1,child2,child3,child4,child5", "in order");
			});

			test("an attribute set later reaches its listener", (t) => {
				const folder = t.scratch();
				let seen: unknown;
				const connection = folder.GetAttributeChangedSignal("Value").Connect(() => {
					seen = folder.GetAttribute("Value");
				});
				t.defer(() => connection.Disconnect());
				task.delay(WAIT, () => folder.SetAttribute("Value", t.name));
				eventually(() => seen === t.name, "the attribute change");
			});

			test("Heartbeat keeps firing while the others wait", (t) => {
				let frames = 0;
				const connection = RunService.Heartbeat.Connect(() => {
					frames += 1;
				});
				t.defer(() => connection.Disconnect());
				task.wait(WAIT);
				// Polled rather than read once the wait is over: as a play session starts, Studio can
				// hold one frame for seconds, and a thread whose whole wait that frame covers resumes
				// before the frame's Heartbeat, so the count can still be 0 then.
				eventually(() => frames >= 5, "five Heartbeats");
			});

			test("a Promise.delay resolves", () => {
				expectResolves(Promise.delay(WAIT), "the delay");
			});

			test("WaitForChild returns a child that arrives later", (t) => {
				const folder = t.scratch();
				task.delay(WAIT, () => {
					const late = new Instance("Folder");
					late.Name = "Late";
					late.Parent = folder;
				});
				// A generous timeout, as hardening: the case is about the child arriving, not about the
				// timeout. A 3 s one survived a 3.5 s frame as the session started (2026-10-05), so this
				// guards against no failure seen, only leaves the timeout far from the delay.
				expectDefined(folder.WaitForChild("Late", WAIT * 20), "the late child");
			});

			test("a delayed callback runs once its time is up", () => {
				let ran = false;
				task.delay(WAIT, () => {
					ran = true;
				});
				eventually(() => ran, "the callback");
			});

			test("its own cleanup runs when it ends, and leaves the others' alone", (t) => {
				const marker = new Instance("BoolValue");
				marker.Name = "FlameworkConcurrentMarker";
				marker.Parent = Workspace;
				t.defer(() => marker.Destroy());
				task.wait(WAIT);
				expectEqual(marker.Parent, Workspace, "its marker, until it ends");
			});
		});
	}
}
