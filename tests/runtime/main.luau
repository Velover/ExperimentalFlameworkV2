--!nolint
--[[
	Entry point for the Lune runtime specs.

	Usage: lune run tests/runtime/main.luau -- <Server|Client>

	Must be run from the repository root: the harness resolves package output relative to the
	process working directory.

	The realm is a process argument rather than a runtime toggle because a realm's module graph
	caches decisions made at require time, so each one needs a fresh graph. `replication.luau`
	builds two graphs in a single process instead, which is what real client/server traffic needs.

	Every case runs under a timeout (FLAMEWORK_SPEC_TIMEOUT seconds, 30 by default): one that is
	still running when it is up is reported as hanging, by name, and the run moves on. The process
	exits explicitly after the summary, because Lune holds a cancelled `task.delay` until its
	deadline and does not always let go of a cancelled `task.wait` at all, and a run that has
	printed its summary must not sit there for either.
]]

local luneTask = require("@lune/task")
local process = require("@lune/process")

local harness = require("./harness")
local roblox = require("./roblox")

local realm = process.args[1] or "Server"
if realm ~= "Server" and realm ~= "Client" then
	error("expected realm to be 'Server' or 'Client', got '" .. tostring(realm) .. "'", 0)
end

local CASE_TIMEOUT = tonumber(process.env.FLAMEWORK_SPEC_TIMEOUT) or 30

local env = roblox.create(realm)
local context = harness.create()

env.install(context)
context.loadPromise()

-- roblox-ts's Promise schedules `Promise.delay` on `RunService.Heartbeat`, which is what networking
-- builds its request timeouts on, so the harness has to drive it.
luneTask.spawn(function()
	while true do
		luneTask.wait()
		env.heartbeat()
	end
end)

local testing = context.require("@flamework-experimental/specs", "out")
local suites = testing.suites

local passed = 0
local failures: { { suite: string, case: string, message: string } } = {}
local hanging: { string } = {}

--- Runs one case on its own thread and waits for it, up to the timeout. Returns whether it passed
--- and, otherwise, why; a case that is still running when the timeout is up is left where it is --
--- the exit at the end takes it with the process -- and reported as hanging.
local function runCase(run: () -> ()): (boolean, string?, boolean)
	local finished, ok, err = false, false, nil

	luneTask.spawn(function()
		ok, err = pcall(run)
		finished = true
	end)

	local deadline = os.clock() + CASE_TIMEOUT
	while not finished and os.clock() < deadline do
		luneTask.wait()
	end

	if not finished then
		return false, string.format("still running after %ds: the case is hanging", CASE_TIMEOUT), true
	end

	return ok, if ok then nil else tostring(err), false
end

print(string.format("\n  Flamework runtime specs (%s)\n", realm))

for _, suite in suites do
	print("  " .. suite.name)

	for _, case in suite.cases do
		local name, run = case[1], case[2]

		local ok, err, isHanging = runCase(run)
		if ok then
			passed += 1
			print("    \27[32mpass\27[0m  " .. name)
		else
			table.insert(failures, { suite = suite.name, case = name, message = err or "?" })
			if isHanging then
				table.insert(hanging, suite.name .. " > " .. name)
				print("    \27[31mHANG\27[0m  " .. name)
			else
				print("    \27[31mFAIL\27[0m  " .. name)
			end
		end
	end

	print("")
end

if #failures > 0 then
	print("  Failures:\n")
	for _, failure in failures do
		print(string.format("    %s > %s", failure.suite, failure.case))
		print(string.format("      %s\n", failure.message))
	end
end

if #hanging > 0 then
	print(string.format("  Hanging (%d): %s\n", #hanging, table.concat(hanging, "; ")))
end

print(string.format("  %d passed, %d failed\n", passed, #failures))

process.exit(if #failures > 0 then 1 else 0)
