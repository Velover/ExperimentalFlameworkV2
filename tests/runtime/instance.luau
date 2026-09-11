--!nolint
--[[
	A small Instance emulation, sufficient for Flamework's components package.

	Only the surface the compiled output reaches is implemented: the property/child indexing that
	roblox-ts relies on, attributes, ancestry, and the signals components subscribe to. Anything
	else raises so a missing stub is a clear failure rather than a nil index.
]]

local luneTask = require("@lune/task")
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
	BindableFunction = "Instance",
	RemoteFunction = "Instance",
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

--[[
	Whether an instance is held by the DataModel.

	The services are marked as its roots, so this is the harness's answer to "is this in `game`" --
	the question that tells an instance parented under a service apart from one parented under a
	folder nothing holds, and the one CollectionService announces a tag on.
]]
local function isInDataModel(instance: Instance): boolean
	local current = instance
	while current do
		if rawget(current, "_isRoot") then
			return true
		end
		current = rawget(current, "_parent")
	end
	return false
end

instances.isInDataModel = isInDataModel

--- Every realm's `game`, which is a plain table rather than an Instance.
local dataModels: { [any]: boolean } = {}

--- Registers a realm's `game`, so `IsDescendantOf(game)` can be answered.
function instances.registerDataModel(dataModel: any)
	dataModels[dataModel] = true
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
	-- `game` is not one of this harness's Instances, so walking the tree for it would never find
	-- it. The DataModel is modelled as the set of service roots, and membership of that set is
	-- exactly what the engine answers `IsDescendantOf(game)` with.
	if dataModels[ancestor] then
		return isInDataModel(self)
	end

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

--- Drops every connection on this instance, which is what destroying it does in the engine.
local function disconnectAll(instance: Instance)
	for _, signal in rawget(instance, "_signals") do
		signal:DisconnectAll()
	end

	for _, signal in rawget(instance, "_attributeSignals") do
		signal:DisconnectAll()
	end
end

--[[
	Destroys the instance, in the engine's order.

	`Destroying` first, while the tree still stands; then the instance leaves its parent -- and with
	it the DataModel, which is what announces its tags as gone; then every connection on it is
	dropped; and only then do the children come apart. So none of the instance's own tree signals
	ever reach a handler: they were disconnected before its children moved. Tearing the children
	down first, as this used to, ran a component's `ChildRemoved` and `DescendantRemoving` handlers
	against a half-dismantled tree that no place ever shows them.
]]
function methods:Destroy()
	if rawget(self, "_destroyed") then
		return
	end

	rawset(self, "_destroyed", true)

	rawget(self, "Destroying"):Fire()
	self.Parent = nil
	disconnectAll(self)

	for _, child in table.clone(rawget(self, "_children")) do
		child:Destroy()
	end
end

--- Observers told about a clone, so a realm's CollectionService can carry the tags across.
local cloneObservers: { (any, any) -> () } = {}

--- Registers a realm's CollectionService to copy an instance's tags onto its clone.
function instances.observeClone(observer: (any, any) -> ())
	table.insert(cloneObservers, observer)
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

	-- A clone carries its source's tags, which is what makes "tag a template, clone it into
	-- Workspace" work at all. The clone is parentless, so nothing is announced until it is
	-- parented in.
	for _, observer in cloneObservers do
		observer(self, clone)
	end

	return clone
end

--[[
	Deferred delivery.

	The engine has one queue. The tree signals -- ChildAdded, ChildRemoved and the descendant pair
	-- CollectionService's tag signals, and BindableEvent dispatch, which is what `@rbxts/signal`
	and with it every component added/removed announcement fires through, all join it in the order
	they are raised, and the whole batch is delivered at the end of the resumption. So a handler
	runs against a tree that has already finished moving, against criteria the signals still queued
	behind it have not corrected yet, and anything it fires joins the back of that same batch rather
	than nesting. Firing synchronously, as this harness does by default, hides all of that.

	`runDeferred(category, callback)` opens a batch: each of the three controls defers its own
	category, they nest, and the batch is delivered once the outermost one returns -- in raise
	order, across categories, which is the ordering that a place and only a place shows. A batch
	that does not settle is a frozen server rather than an error in Roblox, so the harness caps it
	and reports instead of running forever.
]]
local deferring: { [string]: boolean } = { tree = false, tags = false, signals = false }

--- Every category deferred at any point in the open batch, which delivery keeps deferred.
local batchCategories: { [string]: boolean } = {}
local deferDepth = 0
local deferQueue: { { signal: any, arguments: any } } = {}

local MAX_DEFERRED_STEPS = 200

--- Queues a fire whose category is deferred, and delivers it at once otherwise.
local function fireDeferred(category: string, signal: any, ...: any)
	if not signal then
		return
	end

	if deferring[category] then
		table.insert(deferQueue, { signal = signal, arguments = table.pack(...) })
	else
		signal:Fire(...)
	end
end

instances.fireDeferred = fireDeferred

--- Delivers the batch, in order, until it settles. Returns the first error a handler raised.
local function deliverBatch(): (boolean, any)
	local ok, err = true, nil
	local steps = 0

	while #deferQueue > 0 do
		steps += 1
		if steps > MAX_DEFERRED_STEPS then
			table.clear(deferQueue)
			return false, `harness: the deferred queue still had work after {MAX_DEFERRED_STEPS} dispatches`
		end

		local entry = table.remove(deferQueue, 1) :: any

		-- One handler raising does not stop the rest, the way it does not in the engine; the first
		-- error is kept and re-raised so a spec can see what a red error in the output would be.
		local delivered, deliveryError = pcall(function()
			entry.signal:Fire(table.unpack(entry.arguments, 1, entry.arguments.n))
		end)

		if not delivered and ok then
			ok, err = false, deliveryError
		end
	end

	return ok, err
end

--- Runs `callback` with one category of signal deferred, delivering the batch it built afterwards.
function instances.runDeferred(category: string, callback: () -> ())
	local previous = deferring[category]
	deferring[category] = true
	batchCategories[category] = true
	deferDepth += 1

	local ok, err = pcall(callback)
	deferDepth -= 1

	-- An inner control only widens what the batch defers; the outermost one is what delivers it.
	if deferDepth > 0 then
		deferring[category] = previous

		if not ok then
			error(err, 0)
		end
		return
	end

	-- Delivered with every category the batch deferred still deferred, because a fire made from
	-- inside a deferred handler joins the back of this batch rather than being delivered at once.
	for name in batchCategories do
		deferring[name] = true
	end

	local delivered, deliveryError = deliverBatch()

	for name in batchCategories do
		deferring[name] = false
	end
	table.clear(batchCategories)

	if not ok then
		error(err, 0)
	end

	if not delivered then
		error(deliveryError, 0)
	end
end

local function fireTree(signal: any, argument: any)
	fireDeferred("tree", signal, argument)
end

local function fireDeferrable(signal: any, ...: any)
	fireDeferred("signals", signal, ...)
end

--- The tree signals, which a place delivers a resumption after the move that raised them.
function instances.runDeferredTree(callback: () -> ())
	return instances.runDeferred("tree", callback)
end

--- BindableEvent dispatch, which is what a component's added and removed announcements go through.
function instances.runDeferredSignals(callback: () -> ())
	return instances.runDeferred("signals", callback)
end

--- CollectionService's tag signals, which a realm's stand-in fires through this same queue.
function instances.runDeferredTags(callback: () -> ())
	return instances.runDeferred("tags", callback)
end

--[[
	Entering and leaving the DataModel.

	CollectionService announces a tag when the instance carrying it enters the DataModel and again
	when it leaves, which is a second way for a component to come and go: tagging a parentless
	instance announces nothing, parenting it in announces the tag before that parent's ChildAdded,
	and parenting it out announces the tag before ChildRemoved. Re-parenting within the DataModel
	announces nothing at all -- the tag never went anywhere.

	Ancestry is the harness's own business, and tags belong to a realm's CollectionService, so each
	realm registers an observer here and is told which instances crossed the boundary.
]]
local ancestryObservers: { (any, boolean) -> () } = {}

--- Registers a realm's CollectionService to be told when an instance enters or leaves the DataModel.
function instances.observeAncestry(observer: (any, boolean) -> ())
	table.insert(ancestryObservers, observer)
end

--- Marks an instance as a root of the DataModel, which is what the services are.
function instances.markAsRoot(instance: Instance)
	rawset(instance, "_isRoot", true)
end

--- Announces the whole subtree that just crossed the boundary, the instance itself first.
local function announceAncestry(instance: Instance, entered: boolean)
	if #ancestryObservers == 0 then
		return
	end

	for _, observer in ancestryObservers do
		observer(instance, entered)
	end

	-- Cloned: an observer is free to move things about, and the subtree it was told about is the
	-- one that crossed.
	for _, child in table.clone(rawget(instance, "_children")) do
		announceAncestry(child, entered)
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
		local previousParent = rawget(instance, "_parent")
		local wasInDataModel = isInDataModel(instance)
		local isEntering = value ~= nil and isInDataModel(value)

		-- The move itself lands before any of it is announced, the way a property change does in
		-- the engine: every handler below reads the tree as it now stands.
		if previousParent then
			local siblings = rawget(previousParent, "_children")
			local index = table.find(siblings, instance)
			if index then
				table.remove(siblings, index)
			end
		end

		rawset(instance, "_parent", value)

		if value then
			table.insert(rawget(value, "_children"), instance)
		end

		if wasInDataModel and not isEntering then
			announceAncestry(instance, false)
		end

		if previousParent then
			fireTree(rawget(previousParent, "ChildRemoved"), instance)

			local ancestor = previousParent
			while ancestor do
				fireTree(rawget(ancestor, "DescendantRemoving"), instance)
				ancestor = rawget(ancestor, "_parent")
			end
		end

		if isEntering and not wasInDataModel then
			announceAncestry(instance, true)
		end

		if value then
			fireTree(rawget(value, "ChildAdded"), instance)

			local ancestor = value
			while ancestor do
				fireTree(rawget(ancestor, "DescendantAdded"), instance)
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

--[[
	`InstanceHandle`, the datatype an instance-valued attribute is stored as.

	A handle resolves to the instance it names once that instance has streamed in; until then `Get`
	returns nothing and `Wait` yields, which is the case components have to wait through. Handles
	made from an instance that is already there resolve straight away, so the specs that do not care
	about streaming never notice.
]]
local handleMeta = {}
handleMeta.__index = handleMeta

function handleMeta:Get(): Instance?
	return rawget(self, "_instance")
end

function handleMeta:Wait(timeout: number?): Instance?
	local instance = rawget(self, "_instance")
	if instance ~= nil then
		return instance
	end

	local waiter = { thread = coroutine.running(), done = false }
	table.insert(rawget(self, "_waiters"), waiter)

	if timeout ~= nil then
		luneTask.delay(timeout, function()
			if not waiter.done then
				waiter.done = true
				luneTask.spawn(waiter.thread, nil)
			end
		end)
	end

	return coroutine.yield()
end

--- Whether a value is one of this harness's `InstanceHandle`s.
function instances.isHandle(value: any): boolean
	return type(value) == "table" and getmetatable(value) == handleMeta
end

--- Builds a handle. A pending one names an instance that has not streamed in yet.
function instances.newHandle(instance: Instance?, pending: boolean?): any
	return setmetatable({
		_instance = if pending then nil else instance,
		_target = instance,
		_waiters = {},
	}, handleMeta)
end

--- Streams in the instance a pending handle names, resuming everything waiting on it.
function instances.streamIn(handle: any)
	local target = rawget(handle, "_target")
	rawset(handle, "_instance", target)

	local waiters = rawget(handle, "_waiters")
	rawset(handle, "_waiters", {})

	for _, waiter in waiters do
		if not waiter.done then
			waiter.done = true
			luneTask.spawn(waiter.thread, target)
		end
	end
end

--- The outbound calls a remote recorded, in order.
function instances.sent(remote: Instance): { any }
	return rawget(remote, "_sent") or {}
end

--- Clears a remote's recorded calls.
function instances.clearSent(remote: Instance)
	table.clear(rawget(remote, "_sent") or {})
end

--[[
	How many handlers are connected to an instance, across its own signals and the per-attribute
	ones.

	Roblox has no way to ask this, but a connection nothing disconnects is exactly how a leaked
	teardown shows itself: the count for a surviving instance climbs with every round and never
	comes back down.
]]
function instances.connectionCount(instance: Instance): number
	local total = 0

	for _, signal in rawget(instance, "_signals") do
		total += signals.count(signal)
	end

	for _, signal in rawget(instance, "_attributeSignals") do
		total += signals.count(signal)
	end

	return total
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
			fireDeferrable(event, ...)
		end)
	end

	-- The two function-shaped instances the testing package answers on. OnInvoke and OnServerInvoke
	-- are plain properties (the generic __newindex stores them); Invoke and InvokeServer call them.
	-- Only one realm exists per process, so InvokeServer reaches the callback set in this same graph
	-- and passes nil for the player.
	if className == "BindableFunction" then
		rawset(instance, "Invoke", function(self, ...)
			local callback = rawget(self, "OnInvoke")
			if callback == nil then
				error("harness: BindableFunction.Invoke with no OnInvoke set", 2)
			end
			return callback(...)
		end)
	end

	if className == "RemoteFunction" then
		rawset(instance, "InvokeServer", function(self, ...)
			local callback = rawget(self, "OnServerInvoke")
			if callback == nil then
				error("harness: RemoteFunction.InvokeServer with no OnServerInvoke set", 2)
			end
			return callback(nil, ...)
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
