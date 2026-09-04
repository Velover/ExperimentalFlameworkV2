--!nolint
--[[
	Carries traffic between two graphs the way Roblox replication does.

	The server graph owns the ReplicatedStorage tree; every instance the server parents into it is
	mirrored into the client graph as a separate object with the same class, name and attributes,
	which is what the client then resolves its remotes from. If the two realms disagreed on remote
	ids the client would find nothing and create its own, so the mirrored tree is the assertion.

	Delivery is deferred rather than immediate, matching Roblox, and unreliable channels can be told
	to drop a message so that loss is observable.
]]

local luneTask = require("@lune/task")

local instances = require("./instance")

local bridge = {}

local function isRemote(instance: any): boolean
	local className = instance.ClassName
	return className == "RemoteEvent" or className == "UnreliableRemoteEvent"
end

--- Connects a server environment to a client environment.
function bridge.link(server: any, client: any)
	local link = {}

	-- In Roblox the client and the server hold the same replicated Player. Two graphs cannot, so
	-- the bridge keeps one object per side and maps between them.
	local clientPlayer = client.Players.LocalPlayer
	local serverPlayer = server.addPlayer(clientPlayer.Name)

	link.serverPlayer = serverPlayer
	link.clientPlayer = clientPlayer

	--- Unreliable channels are allowed to drop. Arms a single drop on the next unreliable message.
	local dropUnreliable = false
	function link.dropNextUnreliable()
		dropUnreliable = true
	end

	local mirrored: { [any]: any } = {}

	local function linkRemote(serverRemote: any, clientRemote: any)
		local unreliable = serverRemote.ClassName == "UnreliableRemoteEvent"

		local function dropped(): boolean
			if unreliable and dropUnreliable then
				dropUnreliable = false
				return true
			end
			return false
		end

		instances.setDelivery(serverRemote, function(kind, player, args)
			-- `FireClient` addressed at another player never reaches this client.
			if kind == "FireClient" and player ~= serverPlayer then
				return
			end

			if kind ~= "FireClient" and kind ~= "FireAllClients" then
				return
			end

			if dropped() then
				return
			end

			luneTask.defer(function()
				clientRemote.OnClientEvent:Fire(table.unpack(args, 1, args.n))
			end)
		end)

		instances.setDelivery(clientRemote, function(kind, _player, args)
			if kind ~= "FireServer" then
				return
			end

			if dropped() then
				return
			end

			luneTask.defer(function()
				serverRemote.OnServerEvent:Fire(serverPlayer, table.unpack(args, 1, args.n))
			end)
		end)
	end

	local function mirror(serverInstance: any): any
		local existing = mirrored[serverInstance]
		if existing then
			return existing
		end

		local parent = serverInstance.Parent
		local clientParent
		if parent == server.ReplicatedStorage then
			clientParent = client.ReplicatedStorage
		elseif parent then
			clientParent = mirror(parent)
		end

		if not clientParent then
			return nil
		end

		local clone = instances.new(serverInstance.ClassName)
		clone.Name = serverInstance.Name

		-- Attributes have to be in place before parenting: the client finds a remote by matching
		-- the `id` attribute on `ChildAdded`.
		for key, value in serverInstance:GetAttributes() do
			clone:SetAttribute(key, value)
		end

		mirrored[serverInstance] = clone
		clone.Parent = clientParent

		if isRemote(serverInstance) then
			linkRemote(serverInstance, clone)
		end

		return clone
	end

	for _, descendant in server.ReplicatedStorage:GetDescendants() do
		mirror(descendant)
	end

	server.ReplicatedStorage.DescendantAdded:Connect(function(descendant)
		-- Replication is not instant, so the client does not see a remote in the same frame the
		-- server created it.
		luneTask.defer(function()
			mirror(descendant)
		end)
	end)

	--- The client-side counterpart of a server instance, for assertions.
	function link.counterpart(serverInstance: any): any
		return mirrored[serverInstance]
	end

	return link
end

return bridge
