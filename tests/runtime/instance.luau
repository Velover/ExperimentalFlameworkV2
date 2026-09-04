--!nolint
--[[
	A small Instance emulation, sufficient for Flamework's components package.

	Only the surface the compiled output reaches is implemented: the property/child indexing that
	roblox-ts relies on, attributes, ancestry, and the signals components subscribe to. Anything
	else raises so a missing stub is a clear failure rather than a nil index.
]]

local signals = require("./signals")

local instances = {}

--- A tiny slice of the Roblox class hierarchy, enough for `IsA` on the classes the specs use.
local CLASS_PARENTS: { [string]: string } = {
	Instance = nil :: any,
	Folder = "Instance",
	Model = "PVInstance",
	PVInstance = "Instance",
	BasePart = "PVInstance",
	Part = "BasePart",
	MeshPart = "BasePart",
	Configuration = "Instance",
	IntValue = "ValueBase",
	StringValue = "ValueBase",
	ValueBase = "Instance",
	Humanoid = "Instance",
	Attachment = "Instance",
	RemoteEvent = "Instance",
	UnreliableRemoteEvent = "Instance",
	Player = "Instance",
	BindableEvent = "Instance",
}

--- Classes that get the remote-event surface, which the networking specs drive directly.
local REMOTE_CLASSES = { RemoteEvent = true, UnreliableRemoteEvent = true }

export type Instance = any

local instanceMeta = {}

local function isDescendantOf(instance: Instance, ancestor: Instance): boolean
	local current = rawget(instance, "_parent")
	while current do
		if current == ancestor then
			return true
		end
		current = rawget(current, "_parent") or (typeof(current) == "table" and current.Parent)
	end
	return false
end

local methods = {}

function methods:IsA(className: string): boolean
	local current = rawget(self, "_className")
	while current do
		if current == className then
			return true
		end
		current = CLASS_PARENTS[current]
	end
	return false
end

function methods:IsDescendantOf(ancestor: Instance): boolean
	return isDescendantOf(self, ancestor)
end

function methods:GetFullName(): string
	local segments = { rawget(self, "_name") }
	local current = rawget(self, "_parent")

	while current do
		table.insert(segments, 1, current.Name or "?")
		current = rawget(current, "_parent")
	end

	return table.concat(segments, ".")
end

function methods:GetChildren(): { Instance }
	return table.clone(rawget(self, "_children"))
end

function methods:GetDescendants(): { Instance }
	local result = {}
	for _, child in rawget(self, "_children") do
		table.insert(result, child)
		for _, descendant in child:GetDescendants() do
			table.insert(result, descendant)
		end
	end
	return result
end

function methods:FindFirstChild(name: string): Instance?
	for _, child in rawget(self, "_children") do
		if child.Name == name then
			return child
		end
	end
	return nil
end

function methods:FindFirstChildWhichIsA(className: string): Instance?
	for _, child in rawget(self, "_children") do
		if child:IsA(className) then
			return child
		end
	end
	return nil
end

function methods:FindFirstAncestorOfClass(className: string): Instance?
	local current = rawget(self, "_parent")
	while current do
		if current.IsA and current:IsA(className) then
			return current
		end
		current = rawget(current, "_parent")
	end
	return nil
end

--- Non-yielding: the specs build their trees up front, so a missing child is a spec bug.
function methods:WaitForChild(name: string): Instance
	local child = self:FindFirstChild(name)
	if not child then
		error(`harness: WaitForChild('{name}') on '{self:GetFullName()}' has no such child`, 0)
	end
	return child
end

function methods:GetAttribute(name: string): any
	return rawget(self, "_attributes")[name]
end

function methods:SetAttribute(name: string, value: any)
	local attributes = rawget(self, "_attributes")
	if attributes[name] == value then
		return
	end

	attributes[name] = value

	local changed = rawget(self, "_attributeSignals")[name]
	if changed then
		changed:Fire()
	end

	rawget(self, "AttributeChanged"):Fire(name)
end

function methods:GetAttributes(): { [string]: any }
	return table.clone(rawget(self, "_attributes"))
end

function methods:GetAttributeChangedSignal(name: string)
	local registry = rawget(self, "_attributeSignals")
	if not registry[name] then
		registry[name] = signals.create()
	end
	return registry[name]
end

function methods:ClearAllChildren()
	for _, child in table.clone(rawget(self, "_children")) do
		child:Destroy()
	end
end

function methods:Destroy()
	if rawget(self, "_destroyed") then
		return
	end

	rawset(self, "_destroyed", true)
	self:ClearAllChildren()

	rawget(self, "Destroying"):Fire()
	self.Parent = nil
end

function methods:Clone(): Instance
	local clone = instances.new(rawget(self, "_className"))
	clone.Name = rawget(self, "_name")

	for key, value in rawget(self, "_attributes") do
		clone:SetAttribute(key, value)
	end

	for _, child in rawget(self, "_children") do
		child:Clone().Parent = clone
	end

	return clone
end

local function detach(instance: Instance)
	local parent = rawget(instance, "_parent")
	if not parent then
		return
	end

	local siblings = rawget(parent, "_children")
	local index = table.find(siblings, instance)
	if index then
		table.remove(siblings, index)
	end

	rawget(parent, "ChildRemoved"):Fire(instance)

	local ancestor = parent
	while ancestor do
		local signal = rawget(ancestor, "DescendantRemoving")
		if signal then
			signal:Fire(instance)
		end
		ancestor = rawget(ancestor, "_parent")
	end
end

local function fireAncestryChanged(instance: Instance)
	rawget(instance, "AncestryChanged"):Fire(instance, rawget(instance, "_parent"))

	for _, child in rawget(instance, "_children") do
		fireAncestryChanged(child)
	end
end

instanceMeta.__index = function(instance: Instance, key: string)
	if key == "Name" then
		return rawget(instance, "_name")
	elseif key == "Parent" then
		return rawget(instance, "_parent")
	elseif key == "ClassName" then
		return rawget(instance, "_className")
	end

	local method = methods[key]
	if method then
		return method
	end

	local stored = rawget(instance, "_signals")[key]
	if stored then
		return stored
	end

	-- Roblox falls back to child lookup by name, which roblox-ts output relies on.
	for _, child in rawget(instance, "_children") do
		if rawget(child, "_name") == key then
			return child
		end
	end

	return nil
end

instanceMeta.__newindex = function(instance: Instance, key: string, value: any)
	if key == "Name" then
		rawset(instance, "_name", value)
	elseif key == "Parent" then
		detach(instance)
		rawset(instance, "_parent", value)

		if value then
			table.insert(rawget(value, "_children"), instance)
			rawget(value, "ChildAdded"):Fire(instance)

			local ancestor = value
			while ancestor do
				local signal = rawget(ancestor, "DescendantAdded")
				if signal then
					signal:Fire(instance)
				end
				ancestor = rawget(ancestor, "_parent")
			end
		end

		fireAncestryChanged(instance)
	else
		rawset(instance, key, value)
	end
end

instanceMeta.__tostring = function(instance: Instance)
	return rawget(instance, "_name")
end

--- The outbound calls a remote recorded, in order.
function instances.sent(remote: Instance): { any }
	return rawget(remote, "_sent") or {}
end

--- Clears a remote's recorded calls.
function instances.clearSent(remote: Instance)
	table.clear(rawget(remote, "_sent") or {})
end

--- Whether a value is one of this harness's Instances.
function instances.is(value: any): boolean
	return type(value) == "table" and getmetatable(value) == instanceMeta
end

--- Routes a remote's outbound calls somewhere, which is how the replication bridge carries traffic
--- between two graphs. The callback receives (kind, player, packed args).
function instances.setDelivery(remote: Instance, callback: ((string, any, any) -> ())?)
	rawset(remote, "_deliver", callback)
end

function instances.new(className: string, parent: Instance?): Instance
	local instance = setmetatable({
		_className = className,
		_name = className,
		_parent = nil,
		_children = {},
		_attributes = {},
		_attributeSignals = {},
		_destroyed = false,
		_signals = {},
	}, instanceMeta)

	for _, name in { "Destroying", "AncestryChanged", "ChildAdded", "ChildRemoved", "AttributeChanged", "DescendantAdded", "DescendantRemoving" } do
		local signal = signals.create()
		rawset(instance, name, signal)
		rawget(instance, "_signals")[name] = signal
	end

	if className == "BindableEvent" then
		local event = signals.create()
		rawset(instance, "Event", event)
		rawget(instance, "_signals")["Event"] = event
		rawset(instance, "Fire", function(_self, ...)
			event:Fire(...)
		end)
	end

	if REMOTE_CLASSES[className] then
		-- Only one realm exists per process, so outbound calls are recorded for the spec to assert
		-- on, and inbound traffic is simulated by firing the receiving signal directly.
		local sent = {}
		rawset(instance, "_sent", sent)

		for _, name in { "OnServerEvent", "OnClientEvent" } do
			local signal = signals.create()
			rawset(instance, name, signal)
			rawget(instance, "_signals")[name] = signal
		end

		local function record(kind: string, player: any, args: any)
			table.insert(sent, { kind = kind, player = player, args = args })

			-- When a replication bridge is attached, the call also crosses to the other graph.
			local deliver = rawget(instance, "_deliver")
			if deliver then
				deliver(kind, player, args)
			end
		end

		rawset(instance, "FireServer", function(_self, ...)
			record("FireServer", nil, table.pack(...))
		end)
		rawset(instance, "FireClient", function(_self, player, ...)
			record("FireClient", player, table.pack(...))
		end)
		rawset(instance, "FireAllClients", function(_self, ...)
			record("FireAllClients", nil, table.pack(...))
		end)
	end

	if parent then
		instance.Parent = parent
	end

	return instance
end

return instances
