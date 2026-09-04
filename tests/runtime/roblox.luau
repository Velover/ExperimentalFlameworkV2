--!nolint
--[[
	Minimal stubs for the Roblox globals Flamework's compiled output touches.

	Only the surface actually reached by the runtime specs is implemented; anything else raises so a
	missing stub shows up as a clear failure instead of a nil index.
]]

local luneTask = require("@lune/task")

local collection = require("./collection")
local instances = require("./instance")
local signals = require("./signals")

local roblox = {}

local function createSignal()
	return signals.create()
end

roblox.createSignal = createSignal
roblox.instances = instances

-- Services ---------------------------------------------------------------------------------------

--- Which realm the specs are running as. `@Provider` used to gate its metadata on this, so the
--- suite is executed once per realm to prove that it no longer does.
local realm = "Server"

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

--- Every player the specs have created, in creation order.
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

function roblox.setRealm(value: "Server" | "Client")
	realm = value

	if value == "Client" and Players.LocalPlayer == nil then
		Players.LocalPlayer = addPlayer("LocalPlayer")
	end
end

-- Service instances are real harness Instances so that components can be parented under them and
-- ancestor allow/blocklists behave the way they do in Roblox.
local function service(className: string, name: string)
	local instance = instances.new(className)
	instance.Name = name
	return instance
end

local Workspace = service("Workspace", "Workspace")
local ReplicatedStorage = service("Folder", "ReplicatedStorage")
local ServerStorage = service("Folder", "ServerStorage")
local StarterPlayer = service("Folder", "StarterPlayer")
local ServerScriptService = service("Folder", "ServerScriptService")

local services: { [string]: any } = {
	RunService = RunService,
	Players = Players,
	CollectionService = collection.CollectionService,
	Workspace = Workspace,
	StarterPlayer = StarterPlayer,
	ReplicatedStorage = ReplicatedStorage,
	ServerStorage = ServerStorage,
	ServerScriptService = ServerScriptService,
}

roblox.Workspace = Workspace
roblox.ReplicatedStorage = ReplicatedStorage
roblox.ServerStorage = ServerStorage
roblox.CollectionService = collection.CollectionService
roblox.resetTags = collection.reset

roblox.services = services
roblox.RunService = RunService

local game = {}

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

roblox.game = game

-- Globals ----------------------------------------------------------------------------------------

--- A lazily-populated `Enum` global. Enum items only need identity and a name here, which is all
--- the compiled output compares them by.
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

roblox.Enum = Enum

--- Roblox's `task` library. Lune's scheduler covers everything the specs need.
roblox.task = {
	spawn = luneTask.spawn,
	defer = luneTask.defer,
	delay = luneTask.delay,
	wait = luneTask.wait,
	cancel = luneTask.cancel,
}

--- Luau's `debug` plus the Roblox-only profiling calls, which are no-ops here.
roblox.debug = setmetatable({
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

function roblox.install(harness)
	harness.setGlobal("game", game)
	harness.setGlobal("workspace", Workspace)
	harness.setGlobal("Instance", { new = instances.new })
	harness.setGlobal("Enum", Enum)
	harness.setGlobal("task", roblox.task)
	harness.setGlobal("debug", roblox.debug)
	harness.setGlobal("warn", function(...)
		print("[warn]", ...)
	end)
	-- `t.instanceIsA` (and roblox-ts's `typeIs`) gate on `typeof(value) == "Instance"`, so the
	-- harness has to report its Instances as such rather than as plain tables.
	local function robloxTypeof(value: any): string
		if instances.is(value) then
			return "Instance"
		end
		return typeof(value)
	end

	-- Test-only helpers. The networking specs need to observe what a remote sent and to simulate
	-- inbound traffic, neither of which is expressible through Flamework's public API.
	harness.setGlobal("__harness", {
		sent = instances.sent,
		clearSent = instances.clearSent,
		--- Finds a remote by its display name, which is the event name without a direction prefix.
		findRemote = function(name: string)
			for _, remote in remotes() do
				if remote.Name == name then
					return remote
				end
			end
			return nil
		end,
		--- Finds a remote by its id attribute. A function creates one remote per direction, both
		--- named after the event, so only the id tells them apart.
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
		-- Flamework defers wiring a remote to its BindableEvent so that immediate connections are
		-- registered first, so specs have to yield before simulating inbound traffic.
		flush = function()
			luneTask.wait()
		end,
		--- Advances one frame, firing the signals the per-frame lifecycle events hang off.
		step = function(delta: number)
			RunService.PreSimulation:Fire(delta)
			RunService.PostSimulation:Fire(delta)
			RunService.PreRender:Fire(delta)
		end,
		-- Remotes are created by the server and replicated to clients. A single-process harness has
		-- no server, so a client spec primes the tree by running the creation as the server would.
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
	})

	harness.setGlobal("typeof", robloxTypeof)
	harness.setGlobal("typeIs", function(value: any, kind: string)
		return robloxTypeof(value) == kind
	end)

	-- `@rbxts/services` is a thin re-export of `game:GetService`, so it can be served directly
	-- rather than compiled.
	harness.virtualPackages["@rbxts/services"] = harness.virtualNode(
		"services",
		setmetatable({}, {
			__index = function(_, name)
				return game:GetService(name)
			end,
		}) :: any
	)
end

return roblox
