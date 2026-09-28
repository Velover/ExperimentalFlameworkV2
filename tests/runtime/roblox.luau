--!nolint
--[[
	Minimal stubs for the Roblox globals Flamework's compiled output touches.

	Only the surface actually reached by the runtime specs is implemented; anything else raises so a
	missing stub shows up as a clear failure instead of a nil index.

	`roblox.create(realm)` builds one realm's world: its own services, Instance tree, tags and
	players. The replication runner builds two of them and bridges their ReplicatedStorage.
]]

local luneTask = require("@lune/task")

local collection = require("./collection")
local harness = require("./harness")
local instances = require("./instance")
local signals = require("./signals")

local roblox = {}

roblox.instances = instances

--[[
	`task.wait` and `task.delay`, resumed the way the engine resumes them.

	The engine keeps one list of waiting threads and, once a frame, resumes every one whose time is
	up in the order of their deadlines: a `task.delay(0)` made before a `task.wait()` runs before
	that wait returns (measured in Studio, 2026-09-25). Lune's own scheduler resumes a delay one
	cycle after a wait made at the same time and orders simultaneous waits as it likes, so both go
	through this list instead, and `roblox.resumeWaiting` resumes them. The runners call it once per
	scheduler cycle -- once, however many realms the process holds -- before they pump Heartbeat,
	which is where a frame resumes them as well.

	A resumption waits for one whole cycle to pass after the one it was scheduled in, whatever its
	duration: a frame resumes waiting threads only after everything `task.defer` queued in the
	resumption that scheduled them has run, and Lune runs its deferred threads once per cycle, not
	necessarily before this list is pumped.

	A thread cancelled with `task.cancel` before its turn is closed, and a closed one is skipped.
	What a delayed callback raises is Lune's to report, as it was when Lune ran the delay.
]]
local waiting: { any } = {}
local waitSequence = 0
local pumps = 0

local function scheduleResumption(duration: number?, thread: thread, arguments: any?): any
	waitSequence += 1
	local now = os.clock()
	local entry = {
		deadline = now + math.max(tonumber(duration) or 0, 0),
		sequence = waitSequence,
		pump = pumps,
		started = now,
		thread = thread,
		arguments = arguments,
		done = false,
	}
	table.insert(waiting, entry)
	return entry
end

local function taskWait(duration: number?): number
	local entry = scheduleResumption(duration, coroutine.running())
	local elapsed = coroutine.yield()
	-- Resumed by something else first, the thread must not be resumed again by this entry.
	entry.done = true
	return elapsed
end

local function taskDelay(duration: number?, callback: any, ...: any): thread
	local thread = if type(callback) == "thread" then callback else coroutine.create(callback)
	scheduleResumption(duration, thread, table.pack(...))
	return thread
end

--- Resumes every waiting thread whose time is up, earliest deadline first. Once per cycle.
local function resumeWaiting()
	pumps += 1
	if #waiting == 0 then
		return
	end

	local now = os.clock()
	local due, rest = {}, {}
	for _, entry in waiting do
		table.insert(if entry.deadline <= now and entry.pump <= pumps - 2 then due else rest, entry)
	end

	if #due == 0 then
		return
	end

	-- A thread that waits again once resumed joins `rest`, for a later cycle.
	waiting = rest
	table.sort(due, function(a, b)
		if a.deadline ~= b.deadline then
			return a.deadline < b.deadline
		end
		return a.sequence < b.sequence
	end)

	for _, entry in due do
		if not entry.done and coroutine.status(entry.thread) == "suspended" then
			entry.done = true
			if entry.arguments then
				luneTask.spawn(entry.thread, table.unpack(entry.arguments, 1, entry.arguments.n))
			else
				luneTask.spawn(entry.thread, os.clock() - entry.started)
			end
		end
	end
end

roblox.resumeWaiting = resumeWaiting

--- Builds an isolated Roblox environment for one realm.
function roblox.create(initialRealm: "Server" | "Client")
	local env = {}

	local function createSignal(name: string?)
		return signals.create(name)
	end

	--- Which realm this environment reports as. `@Provider` used to gate its metadata on this, so
	--- the suites are executed once per realm to prove that it no longer does.
	local realm = initialRealm

	local RunService = {
		PostSimulation = createSignal("RunService.PostSimulation"),
		PreSimulation = createSignal("RunService.PreSimulation"),
		PreRender = createSignal("RunService.PreRender"),
		Heartbeat = createSignal("RunService.Heartbeat"),
	}

	--- The RunService roblox-ts's Promise sees. `Promise.delay` schedules on `Heartbeat`, which the
	--- harness pumps on every scheduler tick with no delta; Flamework's `onTick` hangs off Heartbeat
	--- as well and must only fire from `env.step`, with a delta, so Promise gets a signal of its own.
	local promiseRunService = {
		Heartbeat = createSignal(),
	}

	function RunService:IsServer()
		return realm == "Server"
	end

	function RunService:IsClient()
		return realm == "Client"
	end

	--- The places the harness stands in for are run in Studio (`flamework-test`), where this is true;
	--- it turns on the Studio-only defaults (profiling, `warnOnInvalidGuards`) as a place's run does.
	function RunService:IsStudio()
		return true
	end

	function RunService:IsRunning()
		return true
	end

	--- Every player this environment knows about, in join order.
	local playerList: { any } = {}

	local Players = {
		LocalPlayer = nil :: any,
		PlayerAdded = createSignal("Players.PlayerAdded"),
		PlayerRemoving = createSignal("Players.PlayerRemoving"),
	}

	function Players:GetPlayers(): { any }
		return table.clone(playerList)
	end

	local function addPlayer(name: string): any
		local player = instances.new("Player")
		player.Name = name

		table.insert(playerList, player)
		Players.PlayerAdded:Fire(player)

		return player
	end

	--- Networking cancels a player's in-flight function requests from `Players.PlayerRemoving`.
	local function removePlayer(player: any)
		local index = table.find(playerList, player)
		if index then
			table.remove(playerList, index)
		end

		Players.PlayerRemoving:Fire(player)
	end

	env.addPlayer = addPlayer
	env.removePlayer = removePlayer
	env.Players = Players

	if realm == "Client" then
		Players.LocalPlayer = addPlayer("LocalPlayer")
	end

	-- Service instances are real harness Instances so that components can be parented under them
	-- and ancestor allow/blocklists behave the way they do in Roblox.
	local function service(className: string, name: string)
		local instance = instances.new(className)
		instance.Name = name

		-- A service is a root of the DataModel, which is what tells an instance parented under one
		-- apart from an instance parented under a folder nothing holds.
		instances.markAsRoot(instance)

		return instance
	end

	local Workspace = service("Workspace", "Workspace")
	local ReplicatedStorage = service("Folder", "ReplicatedStorage")
	local ServerStorage = service("Folder", "ServerStorage")
	local StarterPlayer = service("Folder", "StarterPlayer")
	local ServerScriptService = service("Folder", "ServerScriptService")

	local CollectionService = collection.create()

	-- CollectionService announces a tag when its instance enters the DataModel and again when it
	-- leaves; ancestry is the Instance harness's to report, tags are this realm's to hold.
	instances.observeAncestry(CollectionService.announceAncestry)

	-- A clone carries the tags of what it was cloned from, which is the other half of that split.
	instances.observeClone(CollectionService.announceClone)

	local services: { [string]: any } = {
		RunService = RunService,
		Players = Players,
		CollectionService = CollectionService,
		Workspace = Workspace,
		StarterPlayer = StarterPlayer,
		ReplicatedStorage = ReplicatedStorage,
		ServerStorage = ServerStorage,
		ServerScriptService = ServerScriptService,
	}

	env.Workspace = Workspace
	env.ReplicatedStorage = ReplicatedStorage
	env.ServerStorage = ServerStorage
	env.CollectionService = CollectionService
	env.services = services
	env.RunService = RunService

	local game = {}

	-- `IsDescendantOf(game)` is how the runtime asks whether the DataModel holds an instance, so
	-- the Instance harness has to recognise this realm's `game` as the DataModel rather than as
	-- something to walk the tree for.
	instances.registerDataModel(game)

	function game:GetService(name: string)
		local existing = services[name]
		if existing then
			return existing
		end

		-- Services are ordinary Instances, so an unstubbed one can be created on demand. Only the
		-- services with real behaviour (RunService, CollectionService, Players) are defined above.
		local created = service("Folder", name)
		services[name] = created

		return created
	end

	game.Workspace = Workspace

	--- As the engine answers in a running place: `true` on a client once its initial replication is done,
	--- which is before a client's entry point runs, and `false` on the server, where it stays `false`
	--- (measured in Play Solo at script start, after 10 s and after 87 s).
	function game:IsLoaded()
		return realm == "Client"
	end

	env.game = game

	--- A lazily-populated `Enum` global. Enum items only need identity and a name here, which is
	--- all the compiled output compares them by.
	local enumCache: { [string]: any } = {}

	local Enum = setmetatable({}, {
		__index = function(_, enumName: string)
			local existing = enumCache[enumName]
			if existing then
				return existing
			end

			local items: { [string]: any } = {}
			local enumType = setmetatable({}, {
				__index = function(_, itemName: string)
					if not items[itemName] then
						items[itemName] = {
							Name = itemName,
							Value = itemName,
							EnumType = enumName,
						}
						-- An EnumItem to an attribute and a BindableEvent, not a table.
						instances.markOpaque(items[itemName], "EnumItem")
					end
					return items[itemName]
				end,
				__tostring = function()
					return "Enum." .. enumName
				end,
			})

			instances.markOpaque(enumType, "Enum")
			enumCache[enumName] = enumType
			return enumType
		end,
	})

	env.Enum = Enum

	--- Roblox's `task` library. Lune's scheduler covers `spawn` and `cancel`; a `task.defer` made
	--- while a deferred batch is open joins that batch in raise order, as it joins the engine's one
	--- queue; `wait` and `delay` share the engine's list of waiting threads (see `resumeWaiting`).
	env.task = {
		spawn = luneTask.spawn,
		defer = instances.defer,
		delay = taskDelay,
		wait = taskWait,
		cancel = luneTask.cancel,
	}

	--- Luau's `debug` plus the Roblox-only profiling calls, which are no-ops here.
	env.debug = setmetatable({
		profilebegin = function() end,
		profileend = function() end,
		setmemorycategory = function() end,
		resetmemorycategory = function() end,
	}, { __index = debug })

	--- Every remote under ReplicatedStorage, which is where networking builds its tree.
	local function remotes(): { any }
		local result = {}
		for _, descendant in ReplicatedStorage:GetDescendants() do
			local className = descendant.ClassName
			if className == "RemoteEvent" or className == "UnreliableRemoteEvent" then
				table.insert(result, descendant)
			end
		end
		return result
	end

	env.remotes = remotes

	--[[
		Advances one frame, firing the signals the per-frame lifecycle events hang off in the order
		one engine frame fires them: PreRender, PreSimulation, PostSimulation, Heartbeat. Measured on
		a Studio client under both signal behaviours (2026-09-25), the full cycle is RenderStepped,
		PreRender, PreAnimation, Stepped, PreSimulation, PostSimulation, Heartbeat; the ones nothing
		connects to are left out.

		A frame is the engine's cut, not a waiting thread's: a thread resumed by `task.wait()` wakes
		between PostSimulation and Heartbeat, so it sees Heartbeat first and the rest of the next frame
		after it. `step` is called synchronously, so no thread wakes inside it.
	]]
	function env.step(delta: number)
		RunService.PreRender:Fire(delta)
		RunService.PreSimulation:Fire(delta)
		RunService.PostSimulation:Fire(delta)
		RunService.Heartbeat:Fire(delta)
	end

	--- Pumps the Heartbeat roblox-ts's Promise schedules `Promise.delay` on. Not the graph's own
	--- `RunService.Heartbeat`: that one carries `onTick` and only fires from `env.step`.
	function env.heartbeat()
		promiseRunService.Heartbeat:Fire()
	end

	function env.install(context)
		context.setGlobal("game", game)
		-- Promise.lua reads `game:GetService("RunService").Heartbeat` once, at load, in its own
		-- environment; hand it the pump's RunService there and nothing else sees the difference.
		context.setPromiseGlobal("game", {
			GetService = function(_, name: string)
				if name == "RunService" then
					return promiseRunService
				end
				return game:GetService(name)
			end,
		})
		context.setGlobal("workspace", Workspace)
		-- Each instance learns which realm made it, for the members the engine allows on one side only.
		context.setGlobal("Instance", {
			new = function(className: string, parent: any?)
				local instance = instances.new(className, parent)
				instances.setRealm(instance, RunService)
				return instance
			end,
		})
		context.setGlobal("InstanceHandle", { new = function(instance: any)
			return instances.newHandle(instance)
		end })
		context.setGlobal("Enum", Enum)
		context.setGlobal("task", env.task)
		context.setGlobal("debug", env.debug)
		-- Roblox's `time()` is elapsed game time; the lifecycle plugin passes it to onPhysics.
		context.setGlobal("time", os.clock)

		-- Roblox datatypes for the serialization specs. Lune's implementations report their `typeof`, so
		-- `t.Vector3` and friends see them as the real thing.
		local luneRoblox = require("@lune/roblox") :: any
		for _, name in { "Vector3", "Vector2", "Vector3int16", "Vector2int16", "CFrame", "Color3", "UDim", "UDim2", "NumberRange", "Rect", "BrickColor" } do
			if luneRoblox[name] ~= nil then
				context.setGlobal(name, luneRoblox[name])
			end
		end
		-- Recorded as well as printed, so a spec can assert on advice Flamework only warns about.
		local warnings: { string } = {}
		context.setGlobal("warn", function(...)
			local parts = {}
			for index = 1, select("#", ...) do
				table.insert(parts, tostring((select(index, ...))))
			end

			table.insert(warnings, table.concat(parts, " "))
			print("[warn]", ...)
		end)
		-- `t.instanceIsA` (and roblox-ts's `typeIs`) gate on `typeof(value) == "Instance"`, so the
		-- harness has to report its Instances as such rather than as plain tables.
		local function robloxTypeof(value: any): string
			if instances.is(value) then
				return "Instance"
			end
			if instances.isHandle(value) then
				return "InstanceHandle"
			end
			return typeof(value)
		end

		-- Test-only helpers. The networking specs need to observe what a remote sent and to
		-- simulate inbound traffic, neither of which is expressible through Flamework's public API.
		context.setGlobal("__harness", {
			sent = instances.sent,
			clearSent = instances.clearSent,
			--- Finds a remote by its display name, which is the event name without a prefix.
			findRemote = function(name: string)
				for _, remote in remotes() do
					if remote.Name == name then
						return remote
					end
				end
				return nil
			end,
			--- Finds a remote by its id attribute. A function creates one remote per direction,
			--- both named after the event, so only the id tells them apart.
			findRemoteById = function(id: string)
				for _, remote in remotes() do
					if remote:GetAttribute("id") == id then
						return remote
					end
				end
				return nil
			end,
			--- Every remote id currently in the tree, sorted so specs can compare whole sets.
			remoteIds = function(): { string }
				local ids = {}
				for _, remote in remotes() do
					table.insert(ids, remote:GetAttribute("id"))
				end
				table.sort(ids)
				return ids
			end,
			-- Flamework defers wiring a remote to its BindableEvent so that immediate connections
			-- are registered first, so specs yield before simulating inbound traffic.
			flush = function()
				luneTask.wait()
			end,
			--- Runs the callback the way a place with deferred signal behaviour runs a resumption: every
			--- signal it raises -- CollectionService's, the tree's, attributes and properties,
			--- BindableEvent dispatch -- and every `task.defer` is queued and delivered afterwards, in
			--- order. The three are one control under three names, for what each spec is there to
			--- show: a place cannot defer one kind of signal and not the rest.
			deferTags = CollectionService.runDeferred,
			--- A handler sees a tree that has finished moving while the signals for the rest of the
			--- move are still queued behind it.
			deferTree = instances.runDeferredTree,
			--- A component's added and removed announcements (BindableEvent dispatch, which is what
			--- `@rbxts/signal` fires through) reach their handlers at the end of the resumption, after
			--- everything the caller went on to do.
			deferSignals = instances.runDeferredSignals,
			--- Advances one frame, firing the per-frame lifecycle signals.
			step = env.step,
			-- Remotes are created by the server and replicated to clients. A single-realm graph has
			-- no counterpart, so a spec primes the tree by running creation as the other realm
			-- would. The replication runner needs none of this: it has two real graphs.
			asRealm = function(name: "Server" | "Client", callback: () -> ())
				local previous = realm
				realm = name
				local ok, err = pcall(callback)
				realm = previous

				if not ok then
					error(err, 0)
				end
			end,
			newPlayer = addPlayer,
			removePlayer = removePlayer,
			--- Everything `warn` has been called with since the last `clearWarnings`.
			warnings = function(): { string }
				return table.clone(warnings)
			end,
			clearWarnings = function()
				table.clear(warnings)
			end,
			--- Every error a signal handler or a deferred thread raised since the last `clearErrors`.
			--- The engine prints these rather than raising them out of whatever fired the signal, so
			--- this is the only place a spec can see them.
			errors = signals.errors,
			clearErrors = signals.clearErrors,
			--- An `InstanceHandle` for an instance that has not streamed in, and the streaming of
			--- it. Roblox resolves a handle the moment its instance replicates; here the spec says
			--- when, so the waiting a component does is observable.
			pendingHandle = function(instance: any)
				return instances.newHandle(instance, true)
			end,
			streamIn = instances.streamIn,
			--- Every handler connected to an instance, so a spec can watch a count come back down.
			connectionCount = instances.connectionCount,
		})

		context.setGlobal("typeof", robloxTypeof)
		context.setGlobal("typeIs", function(value: any, kind: string)
			return robloxTypeof(value) == kind
		end)

		-- `@rbxts/services` is a thin re-export of `game:GetService`, so it can be served directly
		-- rather than compiled.
		context.virtualPackages["@rbxts/services"] = harness.virtualNode(
			"services",
			setmetatable({}, {
				__index = function(_, name)
					return game:GetService(name)
				end,
			}) :: any
		)
	end

	return env
end

return roblox
