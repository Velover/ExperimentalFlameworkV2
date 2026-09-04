--!nolint
--[[
	Cross-realm specs.

	Usage: lune run tests/runtime/replication.luau

	`main.luau` runs one realm per process, so its remotes are recording stubs with nothing on the
	other end. This runner builds two independent module graphs -- a real server and a real client,
	each with its own module cache, services and Instance tree -- and bridges their ReplicatedStorage
	the way Roblox replication does. Traffic between them is genuine: the client's `FireServer`
	arrives at the server's `OnServerEvent` with the sending player, one frame later.

	The two graphs share the filesystem tree and therefore the same compiled output, which is what
	makes the generated remote ids comparable between them.
]]

local luneTask = require("@lune/task")
local process = require("@lune/process")

local bridge = require("./bridge")
local harness = require("./harness")
local roblox = require("./roblox")

local function createGraph(realm: "Server" | "Client")
	local env = roblox.create(realm)
	local context = harness.create()

	env.install(context)
	context.loadPromise()

	return env, context
end

local serverEnv, serverContext = createGraph("Server")
local clientEnv, clientContext = createGraph("Client")

-- Both graphs need their own Heartbeat driven: roblox-ts's Promise schedules `Promise.delay` on it,
-- which is what a function request timeout is built from.
local isRunning = true
luneTask.spawn(function()
	while isRunning do
		luneTask.wait()
		serverEnv.heartbeat()
		clientEnv.heartbeat()
	end
end)

local link = bridge.link(serverEnv, clientEnv)

local server = serverContext.require("@flamework/testing", "out", "replication")
local client = clientContext.require("@flamework/testing", "out", "replication")

--- Lets deferred work -- remote wiring, replication, delivery -- run.
local function flush(frames: number?)
	for _ = 1, frames or 3 do
		luneTask.wait()
	end
end

-- Assertions -------------------------------------------------------------------------------------

local function fail(message: string): ()
	error(message, 0)
end

local function assertEqual(actual: any, expected: any, what: string)
	if actual ~= expected then
		fail(`expected {what} to be {tostring(expected)}, got {tostring(actual)}`)
	end
end

local function assertTrue(condition: boolean, what: string)
	if not condition then
		fail(`expected {what} to be true`)
	end
end

local function assertEmpty(list: { any }, what: string)
	if #list ~= 0 then
		fail(`expected {what} to be empty, got {#list} entries (first: {tostring(list[1])})`)
	end
end

local function remoteIds(env): { string }
	local ids = {}
	for _, remote in env.remotes() do
		table.insert(ids, remote:GetAttribute("id"))
	end
	table.sort(ids)
	return ids
end

-- Setup ------------------------------------------------------------------------------------------

server.setupServer()
flush()

client.setupClient()
flush()

-- Cases ------------------------------------------------------------------------------------------

local cases: { { name: string, run: () -> () } } = {
	{
		name = "a client event reaches the server with the sending player",
		run = function()
			client.fireScore(11)
			flush()

			local received = server.drain()
			assertEqual(#received, 1, "events the server received")
			assertEqual(received[1], "LocalPlayer:11", "payload and sender")
		end,
	},
	{
		name = "a server broadcast reaches the client",
		run = function()
			server.broadcastScore(42)
			flush()

			local received = client.drain()
			assertEqual(#received, 1, "events the client received")
			assertEqual(received[1], "score:42", "payload")
		end,
	},
	{
		-- The client sends a string where the server declared a number. Guards are applied on the
		-- receiving side, so this only gets rejected once it has actually crossed.
		name = "the server rejects a payload that fails its generated guard",
		run = function()
			client.fireBadScore()
			flush()

			assertEmpty(server.drain(), "events the server accepted")
		end,
	},
	{
		name = "a function request and its response cross both ways",
		run = function()
			local promise = client.invokeEcho("ping")
			local status, value = promise:awaitStatus()

			assertEqual(status, "Resolved", "request status")
			assertEqual(value, "ping!", "response value")
		end,
	},
	{
		name = "an unreliable event delivers on its own channel",
		run = function()
			server.broadcastTick(1)
			flush()

			local received = client.drain()
			assertEqual(#received, 1, "events the client received")
			assertEqual(received[1], "tick:1", "payload")

			local channel
			for _, remote in serverEnv.remotes() do
				if remote:GetAttribute("id") == "unreliable:tick" then
					channel = remote
				end
			end

			assertTrue(channel ~= nil, "unreliable channel exists")
			assertEqual(channel.ClassName, "UnreliableRemoteEvent", "channel class")
			assertEqual(link.counterpart(channel).ClassName, "UnreliableRemoteEvent", "mirrored class")
		end,
	},
	{
		-- Unreliable delivery is allowed to drop. What matters is that a lost message leaves the
		-- channel usable rather than wedging the handler.
		name = "a dropped unreliable message does not stop later ones",
		run = function()
			link.dropNextUnreliable()
			server.broadcastTick(2)
			flush()

			assertEmpty(client.drain(), "events delivered after a drop")

			server.broadcastTick(3)
			flush()

			local received = client.drain()
			assertEqual(#received, 1, "events delivered after the drop")
			assertEqual(received[1], "tick:3", "payload")
		end,
	},
	{
		-- If the two realms derived different ids the client would have found nothing and created
		-- remotes of its own, so identical id sets across two separate trees is the real assertion.
		name = "both realms agree on the remote tree",
		run = function()
			local serverIds = remoteIds(serverEnv)
			local clientIds = remoteIds(clientEnv)

			assertTrue(#serverIds > 0, "the server created remotes")
			assertEqual(#clientIds, #serverIds, "remote count")

			for index, id in serverIds do
				assertEqual(clientIds[index], id, `remote id #{index}`)
			end

			-- The trees really are separate objects; nothing is shared between the graphs.
			assertTrue(serverEnv.remotes()[1] ~= clientEnv.remotes()[1], "remotes are per-graph objects")
		end,
	},
}

-- Run --------------------------------------------------------------------------------------------

local passed = 0
local failures: { { case: string, message: string } } = {}

print("\n  Flamework replication specs\n")

for _, case in cases do
	local ok, err = pcall(case.run)
	if ok then
		passed += 1
		print("    \27[32mpass\27[0m  " .. case.name)
	else
		table.insert(failures, { case = case.name, message = tostring(err) })
		print("    \27[31mFAIL\27[0m  " .. case.name)
	end
end

print("")

if #failures > 0 then
	print("  Failures:\n")
	for _, failure in failures do
		print(string.format("    %s", failure.case))
		print(string.format("      %s\n", failure.message))
	end
end

print(string.format("  %d passed, %d failed\n", passed, #failures))

isRunning = false

if #failures > 0 then
	process.exit(1)
end
