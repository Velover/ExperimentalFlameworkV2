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
local instances = require("./instance")
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
-- which is what a function request timeout is built from. Before it, once for both, the threads whose
-- `task.wait` or `task.delay` is up are resumed, as a frame does (see `roblox.luau`).
local isRunning = true
luneTask.spawn(function()
	while isRunning do
		luneTask.wait()
		roblox.resumeWaiting()
		serverEnv.heartbeat()
		clientEnv.heartbeat()
	end
end)

local link = bridge.link(serverEnv, clientEnv)

local server = serverContext.require("@flamework-experimental/specs", "out", "replication")
local client = clientContext.require("@flamework-experimental/specs", "out", "replication")
local clientSender = clientContext.require("@flamework-experimental/specs", "out", "replicationSender")
local serverShapes = serverContext.require("@flamework-experimental/specs", "out", "replicationShapes")
local clientShapes = clientContext.require("@flamework-experimental/specs", "out", "replicationShapes")

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

--- The remote with this id in one graph's tree.
local function findRemote(env, id: string): any
	for _, remote in env.remotes() do
		if remote:GetAttribute("id") == id then
			return remote
		end
	end
	error("no remote " .. id, 0)
end

--- The arguments of the last message a remote sent.
local function lastSent(remote: any): { n: number, [number]: any }
	local sent = instances.sent(remote)
	assertTrue(#sent > 0, `{remote:GetAttribute("id")} sent something`)
	return sent[#sent].args
end

--- Every entry of `actual` equals `expected`, in order.
local function assertList(actual: { string }, expected: { string }, what: string)
	assertEqual(#actual, #expected, what .. " count")
	for index, value in expected do
		assertEqual(actual[index], value, `{what} #{index}`)
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
server.setupModeServer()
serverShapes.setupServer()
flush()

client.setupClient()
client.setupModeClient()
clientShapes.setupClient()
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
		-- Regression: `string | number` and `number | string` are one TypeScript type, and each file
		-- numbered its members by the first spelling it met, so a sender in one file and a receiver
		-- in another tagged them differently and every message on both events was dropped or
		-- decoded as something else.
		name = "a union spelled in two orders crosses as written on both sides",
		run = function()
			clientSender.fireSorted()
			flush()

			local received = server.drain()
			assertEqual(#received, 4, "events the server received")
			assertEqual(received[1], "sortB:b", "string on the number-first spelling")
			assertEqual(received[2], "sortA:7", "number on the string-first spelling")
			assertEqual(received[3], "sortB:3", "number on the number-first spelling")
			assertEqual(received[4], "sortA:a", "string on the string-first spelling")
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
		-- Serialized members are packed whether or not the project serializes, with the Instance next
		-- to the buffer in the blob list.
		name = "serialized events cross from the client, with an Instance next to the buffer",
		run = function()
			local where = instances.new("Folder")
			where.Name = "Where"
			client.fireModeClient(3, where)
			flush()

			assertList(server.drain(), {
				"serializedReport:serialized:3:3:6@Where",
				"serializedBump",
				"serializedMove:3",
				"serializedStep:stepped:3:3:6",
			}, "events the server received")

			local report = lastSent(findRemote(clientEnv, "serializedReport"))
			assertTrue(type(report[1]) == "buffer", "a packed payload")
			assertEqual(report[2][1], where, "the Instance in the blob list")
			assertEqual(lastSent(findRemote(clientEnv, "serializedBump")).n, 0, "arguments of an empty list")
			assertTrue(type(lastSent(findRemote(clientEnv, "unreliable:serializedStep"))[1]) == "buffer", "a packed unreliable payload")
			assertEqual(findRemote(serverEnv, "unreliable:serializedStep").ClassName, "UnreliableRemoteEvent", "unreliable channel")
		end,
	},
	{
		name = "serialized events cross from the server",
		run = function()
			local where = instances.new("Folder")
			where.Name = "Box"
			server.fireModeServer(2, where)
			flush()

			assertList(client.drain(), {
				"serializedPush:pushed:2:2:4@Box",
				"serializedTick:2",
			}, "events the client received")

			assertTrue(type(lastSent(findRemote(serverEnv, "serializedPush"))[1]) == "buffer", "a packed payload")
			assertTrue(type(lastSent(findRemote(serverEnv, "unreliable:serializedTick"))[1]) == "buffer", "a packed unreliable payload")
		end,
	},
	{
		name = "serialized function requests and results cross both ways",
		run = function()
			local where = instances.new("Folder")
			where.Name = "Crate"
			local status, results = client.invokeModeServer(where):awaitStatus()
			assertEqual(status, "Resolved", "client-to-server requests")
			assertList(results, { "for-Crate:4:4:8@Crate", "nothing:true" }, "results")

			-- The client sends on `$name` and the server answers on the same remote.
			local request = lastSent(findRemote(clientEnv, "$serializedLookup"))
			assertTrue(type(request[2]) == "buffer", "a packed request")
			assertEqual(request[3][1], where, "the request's Instance next to it")
			local response = lastSent(findRemote(serverEnv, "$serializedLookup"))
			assertEqual(response[2], true, "a successful response")
			assertTrue(type(response[3]) == "buffer", "a packed result")

			local status2, answer = server.invokeModeClient(link.serverPlayer):awaitStatus()
			assertEqual(status2, "Resolved", "server-to-client requests")
			assertEqual(answer, "why:3:3:6", "result")
			assertTrue(type(lastSent(findRemote(clientEnv, "@serializedAsk"))[3]) == "buffer", "a packed result from the client")
		end,
	},
	-- The shapes whose generated code once failed to compile or wrote the wrong thing (see
	-- replicationShapes.ts). Plain members are packed with networking.serialization on and sent as
	-- they are with it off; the Serialized ones are packed either way.
	{
		name = "a caller's readonly tuples, readonly fields and index signatures cross as they were sent",
		run = function()
			clientShapes.firePlacements({ 1, -2, 300 }, { { 1, 2, 3 }, { 4, 5, 6 } }, { a = 1, b = 2 })
			flush()

			assertList(serverShapes.drain(), {
				"place:1,-2,300:45",
				"placeNested:1,-2,300|90|wall|7",
				"placeNested:1,-2,300|180|door|8",
				"placeRest:1,-2,300;1,-2,300",
				"placeRest:1,2,3;4,5,6",
				"placeOpt:1,-2,300",
				"placeOpt:none",
				"placeOr:1,-2,300",
				"placeOr:named",
				"indexSig:a=1,b=2",
				"serializedPlace:1,-2,300:1,-2,300|90|wall|7",
			}, "events the server received")

			local status, value = clientShapes.invokeAsk({ 1, 2, 3 }):awaitStatus()
			assertEqual(status, "Resolved", "a readonly tuple as a request and a result")
			assertEqual(value, "2,3,4", "the result")
		end,
	},
	{
		-- The ECS loop's locals are named `buffer`, which hid the global the packing code named.
		name = "an ECS payload sent from a loop whose locals are named buffer crosses",
		run = function()
			local blob = instances.new("Folder")
			blob.Name = "Entity"
			serverShapes.replicate(link.serverPlayer, blob)
			flush()

			assertList(clientShapes.drain(), {
				"SendReliable:reliable:1",
				"serializedSendReliable:reliable:1",
				"SendReliable:empty:0",
				"serializedSendReliable:empty:0",
			}, "events the client received")
		end,
	},
	{
		name = "fields named after words no local can take cross",
		run = function()
			clientShapes.fireReserved(1)
			flush()

			assertList(serverShapes.drain(), clientShapes.reservedText(1), "events the server received")
		end,
	},
	{
		name = "an array with a hole crosses whole where nil is a value, and is refused at the sender where it is not",
		run = function()
			-- Written whole and read back whole: the receiving guard turns a list with a gap down, as it
			-- does one sent unpacked, rather than the payload being unreadable.
			clientShapes.fireHoles()
			flush()
			assertList(serverShapes.drain(), { "bad:serializedHoles:0" }, "what the server made of it")

			clientShapes.fireWholeLists()
			flush()
			assertList(serverShapes.drain(), { "serializedHoles:1,2,3|a,b,3" }, "the lists without a hole")

			local refused = clientShapes.fireRefusedHole()
			assertTrue(
				string.find(refused, "[Flamework] the argument list has no value at 'serializedMany' [1]", 1, true) ~= nil,
				`the sender's error, got {refused}`
			)
			flush()
			assertEmpty(serverShapes.drain(), "events the server received after the refusal")
		end,
	},
	{
		name = "array rest parameters cross with none, one and several arguments",
		run = function()
			clientShapes.fireMany({ 4, 5 })
			flush()

			assertList(serverShapes.drain(), {
				"many:0:",
				"many:1:1",
				"many:3:1,2,3",
				"many:2:4,5",
				"manyNames:2:a,b",
				"serializedMany:0:",
				"serializedMany:1:4",
				"serializedMany:2:4,5",
			}, "events the server received")

			local status, sums = clientShapes.invokeSums({ 4, 5 }):awaitStatus()
			assertEqual(status, "Resolved", "requests with rest arguments")
			assertEqual(sums, "0,5,6,9,0,2009", "the results")
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
