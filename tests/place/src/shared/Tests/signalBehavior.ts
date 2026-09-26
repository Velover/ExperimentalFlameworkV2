import { CollectionService, Workspace } from "@rbxts/services";

/**
 * What the place does with its signals, measured rather than read: `Workspace.SignalBehavior` is
 * not scriptable once the game runs, so the only way a test learns whether the engine delivers a
 * handler inside the write or after the thread yields is to write and look. Each field is `true`
 * when that kind of signal was deferred.
 */
export interface SignalMeasurement {
	/** A BindableEvent's `Fire`, which is what a component's added and removed announcements go through. */
	bindable: boolean;
	/** `CollectionService.GetInstanceAddedSignal`, the tag announcement a component is built from. */
	tag: boolean;
	/** `ChildAdded`, the tree signal a watched component tree follows. */
	child: boolean;
	/** `GetPropertyChangedSignal("Name")`, which a child link follows on the child it holds. */
	name: boolean;
	/** `GetAttributeChangedSignal`, which an attribute link follows. */
	attribute: boolean;
}

const PROBE_TAG = "FlameworkSignalProbe";

/**
 * Fires one signal of each kind and records whether its handler ran inside the write. Under
 * `Immediate` (and `Default`, measured 2026-09-13) every handler has run before the write returns;
 * under `Deferred` none has, and all of them run once the thread yields.
 */
export function measureSignalBehavior(): SignalMeasurement {
	const folder = new Instance("Folder");
	folder.Name = "SignalProbe";
	folder.Parent = Workspace;
	const event = new Instance("BindableEvent");
	event.Parent = folder;

	const heard = { bindable: false, tag: false, child: false, name: false, attribute: false };
	const connections = [
		event.Event.Connect(() => (heard.bindable = true)),
		CollectionService.GetInstanceAddedSignal(PROBE_TAG).Connect(() => (heard.tag = true)),
		folder.ChildAdded.Connect(() => (heard.child = true)),
		folder.GetPropertyChangedSignal("Name").Connect(() => (heard.name = true)),
		folder.GetAttributeChangedSignal("Probe").Connect(() => (heard.attribute = true)),
	];

	event.Fire();
	const bindable = heard.bindable;
	CollectionService.AddTag(folder, PROBE_TAG);
	const tag = heard.tag;
	new Instance("Folder").Parent = folder;
	const child = heard.child;
	folder.Name = "SignalProbeRenamed";
	const name = heard.name;
	folder.SetAttribute("Probe", true);
	const attribute = heard.attribute;

	// Whatever was queued is delivered once this thread yields, and the disconnects have to wait
	// for it: a deferred handler whose connection is gone is simply dropped.
	task.wait();
	for (const connection of connections) connection.Disconnect();
	folder.Destroy();

	return { bindable: !bindable, tag: !tag, child: !child, name: !name, attribute: !attribute };
}

/** `bindable=deferred tag=deferred ...`, for a message. */
export function describeSignalBehavior(measured: SignalMeasurement) {
	const word = (deferred: boolean) => (deferred ? "deferred" : "immediate");
	return `bindable=${word(measured.bindable)} tag=${word(measured.tag)} child=${word(measured.child)} name=${word(measured.name)} attribute=${word(measured.attribute)}`;
}

let deferred: boolean | undefined;

/**
 * Whether this place defers its signals, measured once through a BindableEvent and kept: the
 * setting cannot change while the game runs. A case whose expectations depend on the order the
 * engine delivers signals in branches on this rather than on the project's name, so it follows what
 * the engine actually does; the `projects` section is what checks the two agree.
 */
export function signalsAreDeferred() {
	if (deferred === undefined) {
		const event = new Instance("BindableEvent");
		let heard = false;
		const connection = event.Event.Connect(() => (heard = true));
		event.Fire();
		deferred = !heard;
		task.wait();
		connection.Disconnect();
		event.Destroy();
	}

	return deferred;
}
