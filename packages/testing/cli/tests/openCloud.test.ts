import { describe, expect, test } from "bun:test";

import {
	API_BASE,
	CONFLICT_HINT,
	createClient,
	OpenCloudError,
	parseDurationMs,
	redactHeaders,
	TaskTimeoutError,
	TERMINAL_STATES,
	type FetchLike,
} from "../src/openCloud.ts";

const KEY = "not-a-real-key-0000";
const UNIVERSE = 10765968722;
const PLACE = 108973151455286;

interface Call {
	url: string;
	init: RequestInit;
}

/** A fetch that replays the given responses and records every call. */
function mockFetch(responses: Response[]): {
	fetch: FetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const queue = [...responses];
	const fetch: FetchLike = async (url, init = {}) => {
		calls.push({ url, init });
		const next = queue.shift();
		if (!next) throw new Error(`unexpected fetch call: ${url}`);
		return next;
	};
	return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function client(fetch: FetchLike, extra: Record<string, unknown> = {}) {
	return createClient({
		apiKey: KEY,
		universeId: UNIVERSE,
		placeId: PLACE,
		fetch,
		sleep: async () => {},
		readFile: async () => new Uint8Array([1, 2, 3]).buffer,
		...extra,
	});
}

const TASK_PATH = `universes/${UNIVERSE}/places/${PLACE}/versions/4/luau-execution-sessions/abc/tasks/def`;

describe("url building", () => {
	test("publish url carries the version type and the octet-stream body", async () => {
		const { fetch, calls } = mockFetch([json({ versionNumber: 5 })]);
		const version = await client(fetch).publishPlace("build/place.rbxl", {
			versionType: "Saved",
		});

		expect(version).toBe(5);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`${API_BASE}/universes/v1/${UNIVERSE}/places/${PLACE}/versions?versionType=Saved`);
		expect(calls[0]!.init.method).toBe("POST");
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/octet-stream");
		expect(headers["x-api-key"]).toBe(KEY);
	});

	test("publish url uses Published when asked", async () => {
		const { fetch, calls } = mockFetch([json({ versionNumber: 6 })]);
		await client(fetch).publishPlace("build/place.rbxl", {
			versionType: "Published",
		});
		expect(calls[0]!.url).toEndWith("versions?versionType=Published");
	});

	test("publish defaults to Saved", async () => {
		const { fetch, calls } = mockFetch([json({ versionNumber: 7 })]);
		await client(fetch).publishPlace("build/place.rbxl");
		expect(calls[0]!.url).toEndWith("versions?versionType=Saved");
	});

	test("createTask without a version hits the unversioned collection", async () => {
		const { fetch, calls } = mockFetch([json({ path: TASK_PATH, state: "QUEUED" })]);
		await client(fetch).createTask("return 1");

		expect(calls[0]!.url).toBe(
			`${API_BASE}/cloud/v2/universes/${UNIVERSE}/places/${PLACE}/luau-execution-session-tasks`,
		);
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			script: "return 1",
		});
	});

	test("createTask with a version hits the versioned collection", async () => {
		const { fetch, calls } = mockFetch([json({ path: TASK_PATH, state: "QUEUED" })]);
		await client(fetch).createTask("return 1", { version: 4, timeout: "30s" });

		expect(calls[0]!.url).toBe(
			`${API_BASE}/cloud/v2/universes/${UNIVERSE}/places/${PLACE}/versions/4/luau-execution-session-tasks`,
		);
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			script: "return 1",
			timeout: "30s",
		});
	});

	test("task and logs urls are built from the returned path", () => {
		const c = client(mockFetch([]).fetch);
		expect(c.taskUrl(TASK_PATH)).toBe(`${API_BASE}/cloud/v2/${TASK_PATH}`);
		expect(c.logsUrl(TASK_PATH)).toBe(`${API_BASE}/cloud/v2/${TASK_PATH}/logs?view=FLAT&maxPageSize=10000`);
		expect(c.logsUrl(TASK_PATH, "tok")).toEndWith("&pageToken=tok");
	});
});

describe("polling", () => {
	test("polls through QUEUED and PROCESSING until COMPLETE", async () => {
		const { fetch, calls } = mockFetch([
			json({ path: TASK_PATH, state: "QUEUED" }),
			json({ path: TASK_PATH, state: "PROCESSING" }),
			json({
				path: TASK_PATH,
				state: "COMPLETE",
				output: { results: ["2"] },
			}),
		]);

		const seen: string[] = [];
		const task = await client(fetch).waitForTask(TASK_PATH, {
			intervalMs: 1,
			onPoll: (polled) => seen.push(polled.state),
		});

		expect(seen).toEqual(["QUEUED", "PROCESSING", "COMPLETE"]);
		expect(task.state).toBe("COMPLETE");
		expect(task.output?.results).toEqual(["2"]);
		expect(calls).toHaveLength(3);
		expect(calls[0]!.url).toBe(`${API_BASE}/cloud/v2/${TASK_PATH}`);
	});

	test("stops on FAILED", async () => {
		const { fetch, calls } = mockFetch([
			json({ path: TASK_PATH, state: "QUEUED" }),
			json({
				path: TASK_PATH,
				state: "FAILED",
				error: { code: "SCRIPT_ERROR", message: "boom" },
			}),
		]);
		const task = await client(fetch).waitForTask(TASK_PATH, { intervalMs: 1 });
		expect(task.state).toBe("FAILED");
		expect(task.error?.code).toBe("SCRIPT_ERROR");
		expect(calls).toHaveLength(2);
	});

	test("stops on CANCELLED", async () => {
		const { fetch } = mockFetch([json({ path: TASK_PATH, state: "CANCELLED" })]);
		const task = await client(fetch).waitForTask(TASK_PATH, { intervalMs: 1 });
		expect(task.state).toBe("CANCELLED");
	});

	test("gives up once the deadline passes", async () => {
		const { fetch } = mockFetch([
			json({ path: TASK_PATH, state: "QUEUED" }),
			json({ path: TASK_PATH, state: "QUEUED" }),
			json({ path: TASK_PATH, state: "QUEUED" }),
		]);
		const error = (await client(fetch)
			.waitForTask(TASK_PATH, { intervalMs: 10, deadlineMs: 20 })
			.catch((e) => e)) as TaskTimeoutError;

		expect(error).toBeInstanceOf(TaskTimeoutError);
		expect(error.message).toContain("still QUEUED");
		expect(error.message).toContain(TASK_PATH);
	});

	test("PROCESSING is not treated as terminal", () => {
		expect(TERMINAL_STATES.has("PROCESSING")).toBe(false);
		expect(TERMINAL_STATES.has("QUEUED")).toBe(false);
		expect([...TERMINAL_STATES].sort()).toEqual(["CANCELLED", "COMPLETE", "FAILED"]);
	});
});

describe("logs", () => {
	test("flattens every chunk and follows nextPageToken", async () => {
		const { fetch, calls } = mockFetch([
			json({
				luauExecutionSessionTaskLogs: [{ messages: ["one", "two"] }, { messages: ["three"] }, {}],
				nextPageToken: "page2",
			}),
			json({
				luauExecutionSessionTaskLogs: [{ messages: ["four"] }],
				nextPageToken: "",
			}),
		]);

		const lines = await client(fetch).getLogs(TASK_PATH);

		expect(lines).toEqual(["one", "two", "three", "four"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).not.toContain("pageToken");
		expect(calls[1]!.url).toContain("pageToken=page2");
	});

	test("an empty log list is fine", async () => {
		const { fetch } = mockFetch([json({})]);
		expect(await client(fetch).getLogs(TASK_PATH)).toEqual([]);
	});
});

describe("errors", () => {
	test("409 retries once and then reports the Studio hint", async () => {
		const busy = () =>
			new Response('{"message":"Save failed. Server is busy ..."}', {
				status: 409,
			});
		const { fetch, calls } = mockFetch([busy(), busy()]);
		const slept: number[] = [];

		const c = client(fetch, { sleep: async (ms: number) => void slept.push(ms) });
		const error = (await c.publishPlace("build/place.rbxl").catch((e) => e)) as OpenCloudError;

		expect(error).toBeInstanceOf(OpenCloudError);
		expect(error.status).toBe(409);
		expect(error.conflict).toBe(true);
		expect(error.hint).toBe(CONFLICT_HINT);
		expect(error.message).toContain("Save failed. Server is busy");
		expect(error.message).not.toContain(KEY);
		expect(calls).toHaveLength(2);
		expect(slept).toEqual([5000]);
	});

	test("a 409 that clears on the retry succeeds", async () => {
		const { fetch, calls } = mockFetch([
			new Response('{"message":"Save failed. Server is busy ..."}', {
				status: 409,
			}),
			json({ versionNumber: 9 }),
		]);
		expect(await client(fetch).publishPlace("build/place.rbxl")).toBe(9);
		expect(calls).toHaveLength(2);
	});

	test("403 suggests the scopes", async () => {
		const { fetch } = mockFetch([new Response("forbidden", { status: 403 })]);
		const error = (await client(fetch)
			.createTask("return 1")
			.catch((e) => e)) as OpenCloudError;
		expect(error.status).toBe(403);
		expect(error.hint).toContain("scopes");
	});

	test("429 mentions the 5/min create limit", async () => {
		const { fetch } = mockFetch([new Response("slow down", { status: 429 })]);
		const error = (await client(fetch)
			.createTask("return 1")
			.catch((e) => e)) as OpenCloudError;
		expect(error.hint).toContain("5/min");
	});
});

test("parseDurationMs reads protobuf durations", () => {
	expect(parseDurationMs("120s", 1)).toBe(120_000);
	expect(parseDurationMs("0.5s", 1)).toBe(500);
	expect(parseDurationMs(undefined, 7)).toBe(7);
	expect(parseDurationMs("2m", 7)).toBe(7);
});

test("redactHeaders hides the api key", () => {
	expect(redactHeaders({ "x-api-key": KEY, "Content-Type": "application/json" })).toEqual({
		"x-api-key": "<redacted>",
		"Content-Type": "application/json",
	});
});
