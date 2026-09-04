--!nolint
--[[
	Entry point for the Lune runtime specs.

	Usage: lune run tests/runtime/main.luau -- <Server|Client>

	Must be run from the repository root: the harness resolves package output relative to the
	process working directory.

	The realm is a process argument rather than a runtime toggle because `@Provider` writes its
	metadata when the decorator evaluates, so each realm needs a fresh module graph.
]]

local luneTask = require("@lune/task")
local process = require("@lune/process")

local harness = require("./harness")
local roblox = require("./roblox")

local realm = process.args[1] or "Server"
if realm ~= "Server" and realm ~= "Client" then
	error("expected realm to be 'Server' or 'Client', got '" .. tostring(realm) .. "'", 0)
end

roblox.setRealm(realm)
roblox.install(harness)
harness.loadPromise()

-- roblox-ts's Promise schedules `Promise.delay` on `RunService.Heartbeat`, which is what networking
-- builds its request timeouts on, so the harness has to drive it. The pump stops once the suites
-- finish, letting Lune's scheduler drain and the process exit.
local isRunning = true
luneTask.spawn(function()
	while isRunning do
		luneTask.wait()
		roblox.RunService.Heartbeat:Fire()
	end
end)

local testing = harness.require("@flamework/testing", "out")
local suites = testing.suites

local passed = 0
local failures: { { suite: string, case: string, message: string } } = {}

print(string.format("\n  Flamework runtime specs (%s)\n", realm))

for _, suite in suites do
	print("  " .. suite.name)

	for _, case in suite.cases do
		local name, run = case[1], case[2]

		local ok, err = pcall(run)
		if ok then
			passed += 1
			print("    \27[32mpass\27[0m  " .. name)
		else
			table.insert(failures, { suite = suite.name, case = name, message = tostring(err) })
			print("    \27[31mFAIL\27[0m  " .. name)
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

print(string.format("  %d passed, %d failed\n", passed, #failures))

isRunning = false

if #failures > 0 then
	process.exit(1)
end
