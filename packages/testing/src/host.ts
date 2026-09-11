import { RunService, Workspace } from "@rbxts/services";
import { DEFAULT_TIMEOUT, runTests, type RunOptions, type RunResult, type TestFilter } from "./runner";

/** The BindableFunction in Workspace that runs this realm's tests: `Invoke(filter?, options?)`. */
export const BINDABLE_NAME = "FlameworkTests";

/** The RemoteFunction in Workspace a client invokes to run the server's tests. */
export const REMOTE_NAME = "FlameworkTestsServer";

/** How long a client waits for the server's instance to replicate before making its own. */
const CLIENT_WAIT = 10;

export interface HostConfig {
	timeout: number;
}

interface Host {
	refs: number;
	config: HostConfig;
	created: Instance[];
	cancelled: boolean;
}

/**
 * One host per realm, however many modules include the plugin: the instances have fixed names,
 * so a second would only shadow the first. The last module to extinguish takes them down.
 */
let host: Host | undefined;

function answer(current: Host, filter: unknown, options: unknown): RunResult {
	return runTests(filter as TestFilter, options as RunOptions | undefined, current.config);
}

/**
 * Creates the instances and connects them, or joins the host that already exists. On the server
 * that is immediate. A client waits for the server's BindableFunction to replicate and answers
 * on it -- a callback is per realm, so one instance serves both -- and makes its own if none
 * arrives, which is what happens in a place with no server-side testing.
 */
export function attach(config: HostConfig) {
	if (host !== undefined) {
		host.refs++;
		host.config = config;
		return;
	}

	const current: Host = { refs: 1, config, created: [], cancelled: false };
	host = current;

	if (RunService.IsServer()) {
		const bindable = new Instance("BindableFunction");
		bindable.Name = BINDABLE_NAME;
		bindable.OnInvoke = (filter: unknown, options: unknown) => answer(current, filter, options);
		bindable.Parent = Workspace;

		const remote = new Instance("RemoteFunction");
		remote.Name = REMOTE_NAME;
		remote.OnServerInvoke = (_player: Player, filter: unknown, options: unknown) =>
			answer(current, filter, options);
		remote.Parent = Workspace;

		current.created.push(bindable, remote);
		return;
	}

	task.spawn(() => {
		let bindable = Workspace.WaitForChild(BINDABLE_NAME, CLIENT_WAIT) as BindableFunction | undefined;
		if (current.cancelled) {
			return;
		}

		if (bindable === undefined) {
			bindable = new Instance("BindableFunction");
			bindable.Name = BINDABLE_NAME;
			bindable.Parent = Workspace;
			current.created.push(bindable);
		}

		bindable.OnInvoke = (filter: unknown, options: unknown) => answer(current, filter, options);
	});
}

/** Releases one attachment; the instances go when the last one does. */
export function detach() {
	if (host === undefined) {
		return;
	}

	host.refs--;
	if (host.refs > 0) {
		return;
	}

	host.cancelled = true;
	for (const instance of host.created) {
		instance.Destroy();
	}

	host = undefined;
}

/** @internal */
export function __isAttached() {
	return host !== undefined;
}

export namespace Testing {
	/** Runs this realm's tests directly, without going through the instances. */
	export function run(filter?: TestFilter, options?: RunOptions): RunResult {
		return runTests(filter, options, host?.config ?? { timeout: DEFAULT_TIMEOUT });
	}

	/** The selected sections and tests, without running anything. */
	export function list(filter?: TestFilter): RunResult {
		return run(filter, { list: true });
	}

	/**
	 * Runs the server's tests. From the server that is `run`; from a client it goes through
	 * `Workspace.FlameworkTestsServer`, which exists only while the server has testing enabled.
	 */
	export function runOnServer(filter?: TestFilter, options?: RunOptions): RunResult {
		if (RunService.IsServer()) {
			return run(filter, options);
		}

		const remote = Workspace.WaitForChild(REMOTE_NAME, CLIENT_WAIT) as RemoteFunction | undefined;
		if (remote === undefined) {
			error(`Workspace.${REMOTE_NAME} does not exist: is testing.enabled true on the server?`, 2);
		}

		return remote.InvokeServer(filter, options) as RunResult;
	}
}
