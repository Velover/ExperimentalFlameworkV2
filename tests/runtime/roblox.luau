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

--- Builds an isolated Roblox environment for one realm.
function roblox.create(initialRealm: "Server" | "Client")
	local env = {}

	local function createSignal()
		return signals.create()
	end

	--- Which realm this environment reports as. `@Provider` used to gate its metadata on this, so
	--- the suites are executed once per realm to prove that it no longer does.
	local realm = initialRealm

	local RunService = {
		PostSimulation = createSignal(),
		PreSimulation = createSignal(),
		PreRender = createSignal(),
		Heartbeat = createSignal(),
	}

	function RunService:IsServer()
		return realm == "Server"
	end

	function RunService:IsClient()
		return realm == "Client"
	end

	function RunService:IsStudio()
		return false
	end

	function RunService:IsRunning()
		return true
	end

	--- Every player this environment knows about, in join order.
	local playerList: { any } = {}

	local Players = {
		LocalPlayer = nil :: any,
		PlayerAdded = createSignal(),
		PlayerRemoving = createSignal(),
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
					end
					return items[itemName]
				end,
				__tostring = function()
					return "Enum." .. enumName
				end,
			})

			enumCache[enumName] = enumType
			return enumType
		end,
	})

	env.Enum = Enum

	--- Roblox's `task` library. Lune's scheduler covers everything the specs need.
	env.task = {
		spawn = luneTask.spawn,
		defer = luneTask.defer,
		delay = luneTask.delay,
		wait = luneTask.wait,
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

	--- Advances one frame, firing the signals the per-frame lifecycle events hang off.
	function env.step(delta: number)
		RunService.PreSimulation:Fire(delta)
		RunService.PostSimulation:Fire(delta)
		RunService.PreRender:Fire(delta)
	end

	--- Fires `Heartbeat`, which roblox-ts's Promise schedules `Promise.delay` on.
	function env.heartbeat()
		RunService.Heartbeat:Fire()
	end

	function env.install(context)
		context.setGlobal("game", game)
		context.setGlobal("workspace", Workspace)
		context.setGlobal("Instance", { new = instances.new })
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
			--- Runs the callback with CollectionService signals deferred, delivering them afterwards in
			--- order, the way a place with deferred signal behaviour does at the end of a resumption.
			deferTags = CollectionService.runDeferred,
			--- The same for the tree signals -- ChildAdded, ChildRemoved and the descendant pair --
			--- which the engine defers as well, so a handler sees a tree that has finished moving
			--- while the signals for the rest of the move are still queued behind it.
			deferTree = instances.runDeferredTree,
			--- And the same for BindableEvent dispatch, which is what `@rbxts/signal` fires
			--- through: a component's added and removed announcements reach their handlers at the
			--- end of the resumption, after everything the caller went on to do.
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
			--- An `InstanceHandle` for an instance that has not streamed in, and the streaming of
			--- it. Roblox resolves a handle the moment its instance replicates; here the spec says
			--- when, so the waiting a component does is observable.
			pendingHandle = function(instance: any)
				return instances.newHandle(instance, true)
			end,
			streamIn = instances.streamIn,
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
