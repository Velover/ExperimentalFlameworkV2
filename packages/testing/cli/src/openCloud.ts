/**
 * A small typed client for the two Roblox Open Cloud APIs this tool needs:
 *
 *  - the legacy place-publishing endpoint (`/universes/v1/...`), and
 *  - the Luau Execution API (`/cloud/v2/...`).
 *
 * Everything network-facing goes through the injectable `fetch`, so the tests
 * never touch the network. The API key only ever travels in the `x-api-key`
 * header - it is never put in a URL, a log line or an error message.
 */

export const API_BASE = "https://apis.roblox.com";

/** The hint printed when the publish endpoint answers 409. */
export const CONFLICT_HINT = "close the place in Roblox Studio and retry";

export type VersionType = "Saved" | "Published";

export type TaskState = "STATE_UNSPECIFIED" | "QUEUED" | "PROCESSING" | "COMPLETE" | "FAILED" | "CANCELLED";

/** A task is done when it reaches one of these. Never poll on `!= PROCESSING`. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

export interface LuauTask {
	/** e.g. `universes/1/places/2/versions/3/luau-execution-sessions/a/tasks/b` */
	path: string;
	state: TaskState;
	createTime?: string;
	updateTime?: string;
	script?: string;
	timeout?: string;
	output?: { results?: string[] };
	error?: { code?: string; message?: string };
}

export interface LogChunk {
	path?: string;
	messages?: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreateClientOptions {
	apiKey: string;
	universeId: string | number;
	placeId: string | number;
	/** Injected in tests; defaults to the global fetch. */
	fetch?: FetchLike;
	/** Injected in tests so the 409 retry and polling do not really sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected in tests so `publishPlace` needs no file on disk. */
	readFile?: (path: string) => Promise<ArrayBuffer>;
	/** Override for tests; defaults to {@link API_BASE}. */
	baseUrl?: string;
}

export interface PublishOptions {
	versionType?: VersionType;
}

export interface CreateTaskOptions {
	version?: number;
	timeout?: string;
}

export interface WaitOptions {
	intervalMs?: number;
	/**
	 * Client-side give-up. The server enforces the task's own timeout, but a
	 * task can sit in QUEUED for a long time, and a CI run that hangs forever is
	 * worse than one that reports where to look.
	 */
	deadlineMs?: number;
	/** Called with every polled task, for progress output. */
	onPoll?: (task: LuauTask) => void;
}

/** A task that was still running when {@link WaitOptions.deadlineMs} passed. */
export class TaskTimeoutError extends Error {
	readonly task: LuauTask;
	constructor(task: LuauTask, waitedMs: number) {
		super(`task is still ${task.state} after ${Math.round(waitedMs / 1000)}s: ${task.path}`);
		this.name = "TaskTimeoutError";
		this.task = task;
	}
}

/** `"120s"` -> `120000`. Undefined or unparseable gives `fallback`. */
export function parseDurationMs(duration: string | undefined, fallback: number): number {
	if (!duration) return fallback;
	const match = /^(\d+(?:\.\d+)?)s$/.exec(duration.trim());
	return match ? Number(match[1]) * 1000 : fallback;
}

/** Any non-2xx answer from Open Cloud. Carries the status and the raw body. */
export class OpenCloudError extends Error {
	readonly status: number;
	readonly body: string;
	readonly url: string;
	readonly conflict: boolean;

	constructor(action: string, status: number, body: string, url: string) {
		super(`${action} failed (${status}): ${body}`);
		this.name = "OpenCloudError";
		this.status = status;
		this.body = body;
		this.url = url;
		this.conflict = status === 409;
	}

	/** Actionable advice for the statuses that have a known cause. */
	get hint(): string | undefined {
		if (this.status === 409) return CONFLICT_HINT;
		if (this.status === 401 || this.status === 403) {
			return "check the API key scopes (universe-places:write, universe.place.luau-execution-session:read/:write), its IP allowlist and its expiry";
		}
		if (this.status === 429) {
			return "rate limited - task creation is 5/min per API key owner; wait a minute";
		}
		return undefined;
	}
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultReadFile = (path: string) => Bun.file(path).arrayBuffer();

/** `/universes/v1/{u}/places/{p}/versions?versionType=...` */
export function publishUrl(
	baseUrl: string,
	universeId: string | number,
	placeId: string | number,
	versionType: VersionType,
): string {
	return `${baseUrl}/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`;
}

/** The task-collection URL; versioned when `version` is given. */
export function createTaskUrl(
	baseUrl: string,
	universeId: string | number,
	placeId: string | number,
	version?: number,
): string {
	const place = `${baseUrl}/cloud/v2/universes/${universeId}/places/${placeId}`;
	return version === undefined
		? `${place}/luau-execution-session-tasks`
		: `${place}/versions/${version}/luau-execution-session-tasks`;
}

/** A task resource URL built from the `path` the create call returned. */
export function taskUrl(baseUrl: string, path: string): string {
	return `${baseUrl}/cloud/v2/${path}`;
}

export function logsUrl(baseUrl: string, path: string, pageToken?: string): string {
	const qs = new URLSearchParams({ view: "FLAT", maxPageSize: "10000" });
	if (pageToken) qs.set("pageToken", pageToken);
	return `${baseUrl}/cloud/v2/${path}/logs?${qs}`;
}

export interface OpenCloudClient {
	readonly universeId: string;
	readonly placeId: string;
	readonly baseUrl: string;
	publishUrl(versionType: VersionType): string;
	createTaskUrl(version?: number): string;
	taskUrl(path: string): string;
	logsUrl(path: string, pageToken?: string): string;
	publishPlace(file: string, options?: PublishOptions): Promise<number>;
	createTask(script: string, options?: CreateTaskOptions): Promise<LuauTask>;
	getTask(path: string): Promise<LuauTask>;
	waitForTask(path: string, options?: WaitOptions): Promise<LuauTask>;
	getLogs(path: string): Promise<string[]>;
}

export function createClient(options: CreateClientOptions): OpenCloudClient {
	const {
		apiKey,
		universeId,
		placeId,
		fetch: fetchImpl = ((input, init) => globalThis.fetch(input, init)) as FetchLike,
		sleep = defaultSleep,
		readFile = defaultReadFile,
		baseUrl = API_BASE,
	} = options;

	// Built once; never logged. `redactHeaders` exists for anything that does.
	const authHeaders = { "x-api-key": apiKey };

	function request(url: string, init: RequestInit): Promise<Response> {
		return fetchImpl(url, {
			...init,
			headers: { ...authHeaders, ...(init.headers as Record<string, string>) },
		});
	}

	async function requireOk(action: string, url: string, res: Response): Promise<Response> {
		if (res.ok) return res;
		const body = await safeText(res);
		throw new OpenCloudError(action, res.status, body, url);
	}

	async function getTask(path: string): Promise<LuauTask> {
		const url = taskUrl(baseUrl, path);
		const res = await request(url, { method: "GET" });
		await requireOk("get task", url, res);
		return (await res.json()) as LuauTask;
	}

	return {
		universeId: String(universeId),
		placeId: String(placeId),
		baseUrl,

		publishUrl: (versionType) => publishUrl(baseUrl, universeId, placeId, versionType),
		createTaskUrl: (version) => createTaskUrl(baseUrl, universeId, placeId, version),
		taskUrl: (path) => taskUrl(baseUrl, path),
		logsUrl: (path, pageToken) => logsUrl(baseUrl, path, pageToken),

		/**
		 * Uploads a `.rbxl` through the legacy publish endpoint and returns the
		 * new `versionNumber`.
		 *
		 * A 409 means the place is open in Roblox Studio ("Save failed. Server is
		 * busy"). We retry exactly once after 5s and then give up with a hint.
		 */
		async publishPlace(file, { versionType = "Saved" } = {}) {
			const url = publishUrl(baseUrl, universeId, placeId, versionType);
			const body = await readFile(file);

			const send = () =>
				request(url, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body,
				});

			let res = await send();
			if (res.status === 409) {
				await safeText(res);
				await sleep(5000);
				res = await send();
			}
			await requireOk("publish", url, res);

			const json = (await res.json()) as { versionNumber?: number };
			if (typeof json.versionNumber !== "number") {
				throw new Error(`publish succeeded but the response had no versionNumber: ${JSON.stringify(json)}`);
			}
			return json.versionNumber;
		},

		async createTask(script, { version, timeout } = {}) {
			const url = createTaskUrl(baseUrl, universeId, placeId, version);
			const payload: { script: string; timeout?: string } = { script };
			if (timeout) payload.timeout = timeout;

			const res = await request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			await requireOk("create task", url, res);
			return (await res.json()) as LuauTask;
		},

		getTask,

		/** Polls until the state is COMPLETE, FAILED or CANCELLED. */
		async waitForTask(path, { intervalMs = 2500, deadlineMs, onPoll } = {}) {
			let waited = 0;
			for (;;) {
				const task = await getTask(path);
				onPoll?.(task);
				if (TERMINAL_STATES.has(task.state)) return task;
				if (deadlineMs !== undefined && waited >= deadlineMs) {
					throw new TaskTimeoutError(task, waited);
				}
				await sleep(intervalMs);
				waited += intervalMs;
			}
		},

		/** Every log line of the task, flattened across chunks and pages. */
		async getLogs(path) {
			const lines: string[] = [];
			let pageToken = "";
			do {
				const url = logsUrl(baseUrl, path, pageToken);
				const res = await request(url, { method: "GET" });
				await requireOk("get logs", url, res);
				const body = (await res.json()) as {
					luauExecutionSessionTaskLogs?: LogChunk[];
					nextPageToken?: string;
				};
				for (const chunk of body.luauExecutionSessionTaskLogs ?? []) {
					lines.push(...(chunk.messages ?? []));
				}
				pageToken = body.nextPageToken ?? "";
			} while (pageToken);
			return lines;
		},
	};
}

/** Replaces the value of any authorization-ish header with `<redacted>`. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = /^(x-api-key|authorization|cookie)$/i.test(key) ? "<redacted>" : value;
	}
	return out;
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).trim();
	} catch {
		return "<no body>";
	}
}
