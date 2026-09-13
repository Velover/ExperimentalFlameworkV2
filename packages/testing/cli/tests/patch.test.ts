import { describe, expect, test } from "bun:test";

import { defaultPatchedPath, patchedPathFor, planPatch, projectNameOf } from "../src/patch.ts";
import { json, runCli } from "./harness.ts";

const PROJECT = JSON.stringify({
	tree: {
		$className: "DataModel",
		ServerScriptService: { $className: "ServerScriptService", TS: { $path: "out/server" } },
		Workspace: { $className: "Workspace", $properties: { FilteringEnabled: true } },
	},
});

describe("planPatch", () => {
	test("a $path node is replaced, a $className node is kept, and children come after their parents", () => {
		const plan = planPatch(JSON.parse(PROJECT));
		expect(plan).toEqual([
			{ path: ["ServerScriptService"], kind: "ensure", className: "ServerScriptService", properties: {} },
			{ path: ["ServerScriptService", "TS"], kind: "replace", properties: {} },
			{ path: ["Workspace"], kind: "ensure", className: "Workspace", properties: { FilteringEnabled: true } },
		]);
	});

	test("a node built from a path with children declared beside it is one replacement", () => {
		const plan = planPatch({
			tree: {
				$className: "DataModel",
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					rbxts_include: {
						$path: "include",
						node_modules: { $className: "Folder", "@rbxts": { $path: "node_modules/@rbxts" } },
					},
				},
			},
		});
		expect(plan.map((op) => `${op.kind} ${op.path.join(".")}`)).toEqual([
			"ensure ReplicatedStorage",
			"replace ReplicatedStorage.rbxts_include",
		]);
	});

	test("a declared container's own content is kept while what is built inside it is replaced", () => {
		const plan = planPatch({
			tree: {
				$className: "DataModel",
				StarterPlayer: {
					$className: "StarterPlayer",
					StarterPlayerScripts: { $className: "StarterPlayerScripts", TS: { $path: "out/client" } },
				},
			},
		});
		expect(plan.map((op) => `${op.kind} ${op.path.join(".")}`)).toEqual([
			"ensure StarterPlayer",
			"ensure StarterPlayer.StarterPlayerScripts",
			"replace StarterPlayer.StarterPlayerScripts.TS",
		]);
	});

	test("the patched place goes beside the build", () => {
		expect(defaultPatchedPath("place.rbxl")).toBe("place.patched.rbxl");
		expect(defaultPatchedPath("build/game.rbxlx")).toBe("build/game.patched.rbxl");
	});

	test("a project is named after its file, and a chosen one names the place made under it", () => {
		expect(projectNameOf("default.project.json")).toBe("default");
		expect(projectNameOf("tests/deferred.project.json")).toBe("deferred");
		expect(projectNameOf("C:\\game\\tests\\Streaming.Project.JSON")).toBe("Streaming");
		expect(projectNameOf("odd.json")).toBe("odd");

		const chosen = { path: "/game/tests/deferred.project.json", name: "deferred", chosen: true };
		expect(patchedPathFor("place.rbxl", chosen)).toBe("place.deferred.rbxl");
		expect(patchedPathFor("build/game.rbxlx", chosen)).toBe("build/game.deferred.rbxl");
		expect(patchedPathFor("place.rbxl", { ...chosen, name: "default", chosen: false })).toBe("place.patched.rbxl");
	});
});

describe("patch", () => {
	test("checks lune, plans from the project file, runs the task, and says where the result went", async () => {
		const run = await runCli(["patch", "place.rbxl", "--original", "original.rbxl"], {
			files: { "place.rbxl": "built", "original.rbxl": "orig", "default.project.json": PROJECT },
		});

		expect(run.code).toBe(0);
		expect(run.spawned[0]).toEqual(["lune", "--version"]);
		const task = run.spawned[1]!.map((part) => part.replaceAll("\\", "/"));
		expect(task[0]).toBe("lune");
		expect(task[1]).toBe("run");
		expect(task[2]).toEndWith("build/patch-place.luau");
		expect(task[3]).toEndWith("original.rbxl");
		expect(task[4]).toEndWith("place.rbxl");
		expect(task[5]).toEndWith("place.patched.rbxl");

		const plan = JSON.parse(Object.entries(run.written).find(([path]) => path.endsWith("patch-plan.json"))![1]);
		expect(plan.project).toBe("default");
		expect(plan.ops).toHaveLength(3);
		expect(run.out).toContain("place.patched.rbxl");
		expect(run.calls).toHaveLength(0);
	});

	test("a chosen project without an original sets its properties on the build itself, into a file of its name", async () => {
		const run = await runCli(["patch", "place.rbxl", "--project", "tests/deferred.project.json"], {
			files: { "place.rbxl": "built", "tests/deferred.project.json": PROJECT },
		});

		expect(run.code).toBe(0);
		expect(run.out).toContain("setting the properties of");
		expect(run.out).toContain("deferred.project.json");
		const task = run.spawned[1]!.map((part) => part.replaceAll("\\", "/"));
		// The build stands in for the original: the task then sets properties and replaces nothing.
		expect(task[3]).toEndWith("/place.rbxl");
		expect(task[4]).toBe(task[3]);
		expect(task[5]).toEndWith("/place.deferred.rbxl");
		const plan = JSON.parse(Object.entries(run.written).find(([path]) => path.endsWith("patch-plan.json"))![1]);
		expect(plan.project).toBe("deferred");

		// The default project is only followed when there is an original to lay the build over.
		const nothing = await runCli(["patch", "place.rbxl"], { files: { "place.rbxl": "built" } });
		expect(nothing.code).toBe(2);
		expect(nothing.err).toContain("patch needs the original place");
		expect(nothing.err).toContain("or a project whose properties to set");

		// A missing project file is named, before lune would have run.
		const missing = await runCli(["patch", "place.rbxl", "--project", "tests/nowhere.project.json"], {
			files: { "place.rbxl": "built" },
		});
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("nowhere.project.json does not exist");
		expect(missing.err).toContain("check --project or ROJO_PROJECT");
		expect(missing.spawned.map((command) => command[1])).toEqual(["--version"]);
	});

	test("patch and cloud publish follow one project at a time", async () => {
		const two = await runCli(
			["patch", "place.rbxl", "--project", "a.project.json", "--project", "b.project.json"],
			{
				files: { "place.rbxl": "built", "a.project.json": PROJECT, "b.project.json": PROJECT },
			},
		);
		expect(two.code).toBe(2);
		expect(two.err).toContain("patch follows one project at a time, and --project names 2");
		expect(two.spawned).toHaveLength(0);

		const fromEnv = await runCli(["cloud", "publish", "place.rbxl"], {
			env: {
				TESTING_PLACE_API_KEY: "k",
				TESTING_UNIVERSE_ID: "1",
				TESTING_PLACE_ID: "2",
				ROJO_PROJECT: "a.project.json,b.project.json",
			},
			files: { "place.rbxl": "built", "a.project.json": PROJECT, "b.project.json": PROJECT },
		});
		expect(fromEnv.code).toBe(2);
		expect(fromEnv.err).toContain("cloud publish follows one project at a time, and ROJO_PROJECT names 2");
		expect(fromEnv.calls).toHaveLength(0);
	});

	test("without lune the run stops before anything is uploaded, naming the cause", async () => {
		const run = await runCli(["cloud", "test", "place.rbxl", "--original", "original.rbxl"], {
			files: { "place.rbxl": "built", "original.rbxl": "orig", "default.project.json": PROJECT },
			spawnCode: (command) => (command[1] === "--version" ? 127 : 0),
		});

		expect(run.code).toBe(1);
		expect(run.err).toContain("lune is needed");
		expect(run.err).toContain("nothing was run or uploaded");
		expect(run.calls).toHaveLength(0);
	});

	test("a missing original place says how to get one", async () => {
		const run = await runCli(["patch", "place.rbxl", "--original", "nowhere.rbxl"], {
			files: { "place.rbxl": "built", "default.project.json": PROJECT },
		});
		expect(run.code).toBe(1);
		expect(run.err).toContain("nowhere.rbxl does not exist");
		expect(run.err).toContain("Save to File");
	});

	test("publish --original uploads the patched place and records that file", async () => {
		const run = await runCli(["cloud", "publish", "place.rbxl", "--original", "original.rbxl"], {
			files: {
				"place.rbxl": "built",
				"original.rbxl": "orig",
				"default.project.json": PROJECT,
				"place.patched.rbxl": "patched",
			},
			responses: [json({ versionNumber: 21 })],
		});

		expect(run.code).toBe(0);
		expect(run.spawned).toHaveLength(2);
		expect(run.out).toContain("published version 21");
		const record = JSON.parse(Object.entries(run.written).find(([path]) => path.endsWith("version.json"))![1]);
		expect(record.file.replaceAll("\\", "/")).toEndWith("place.patched.rbxl");
	});

	test("the original may come from the config file, and --out names the result", async () => {
		const run = await runCli(["patch", "place.rbxl", "--out", "dist/testing.rbxl"], {
			files: { "place.rbxl": "built", "cfg/original.rbxl": "orig", "default.project.json": PROJECT },
			settings: { originalPlace: "/cfg/original.rbxl" },
		});
		expect(run.code).toBe(0);
		const task = run.spawned[1]!.map((part) => part.replaceAll("\\", "/"));
		expect(task[3]).toEndWith("cfg/original.rbxl");
		expect(task[5]).toEndWith("dist/testing.rbxl");
	});

	test("patch without any original is a usage error", async () => {
		const run = await runCli(["patch", "place.rbxl"], { files: { "place.rbxl": "built" } });
		expect(run.code).toBe(2);
		expect(run.err).toContain("patch needs the original place");
	});
});

describe("turning the original off", () => {
	test("an empty ORIGINAL_PLACE means no patch, even when the config names one", async () => {
		const run = await runCli(["cloud", "publish", "place.rbxl"], {
			env: { TESTING_PLACE_API_KEY: "k", TESTING_UNIVERSE_ID: "1", TESTING_PLACE_ID: "2", ORIGINAL_PLACE: "" },
			settings: { originalPlace: "/cfg/original.rbxl" },
			files: { "place.rbxl": "built" },
			responses: [json({ versionNumber: 3 })],
		});
		expect(run.code).toBe(0);
		expect(run.spawned).toHaveLength(0);
		expect(run.out).toContain("published version 3");
	});
});
