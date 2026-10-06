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

--- Non-yielding: the specs build their trees up front, so a missing child is a spec bug -- unless
--- the caller gave a timeout, which is a caller ready for it not to come: `nil` at once, as the
--- engine returns `nil` once the timeout is up.
function methods:WaitForChild(name: string, timeout: number?): Instance?
	local child = self:FindFirstChild(name)
	if not child and timeout == nil then
		error(`harness: WaitForChild('{name}') on '{self:GetFullName()}' has no such child`, 0)
	end
	return child
end

--[[
	Roblox values the harness builds as plain tables -- Enum items and enums (see `roblox.luau`) --
	marked with what they stand for, so that an attribute or a BindableEvent treats them as the
	values they are rather than as tables. Weak, like the values' own cache.
]]
local opaque: { [any]: string } = setmetatable({}, { __mode = "k" }) :: any

function instances.markOpaque(value: any, kind: string)
	opaque[value] = kind
end

--- What a value marked opaque stands for (`"EnumItem"`, `"Enum"`), which is its `typeof`; `nil` for any other value.
function instances.opaqueKind(value: any): string?
	return opaque[value]
end

--- The `typeof`s an attribute holds besides the Lua primitives and InstanceHandle.
local ATTRIBUTE_TYPES: { [string]: boolean } = {
	UDim = true,
	UDim2 = true,
	BrickColor = true,
	Color3 = true,
	Vector2 = true,
	Vector3 = true,
	CFrame = true,
	NumberSequence = true,
	ColorSequence = true,
	NumberRange = true,
	Rect = true,
	Font = true,
	EnumItem = true,
}

--[[
	What `SetAttribute` makes of its arguments, measured in Studio under both signal behaviours
	(2026-09-25). A number name is written as its string, and so is any other name that is not a
	string, with a warning. A name is refused when it is empty, longer than 100 characters, holds
	anything but letters, digits and `_ - . /`, or starts with `RBX`. An Instance is stored as an
	InstanceHandle to it; a thread, a bare userdata or an Enum is stored as nil, which removes the
	attribute; a table or a function, or a datatype attributes do not hold (`Vector3int16`), is
	refused and leaves the attribute as it was.
]]
local function attributeName(name: any): string
	if name == nil then
		error("Argument 1 missing or nil", 0)
	elseif type(name) ~= "string" and type(name) ~= "number" then
		signals.warn(`argument #1 expects a string, but {typeof(name)} was passed`)
	end

	return if type(name) == "string" then name else tostring(name)
end

local function validateAttributeName(name: string)
	if name == "" then
		error(`Attribute name cannot be empty ("")`, 0)
	end

	if #name > 100 then
		error(`Attribute name exceeds 100 character limit ("{name}")`, 0)
	end

	local illegal = string.match(name, "[^%w_%-%./]")
	if illegal then
		error(`Attribute name contains illegal character '{illegal}' ("{name}")`, 0)
	end

	if string.sub(name, 1, 3) == "RBX" then
		error(`Attempt to assign attribute {name}. CoreScript permission required`, 0)
	end
end

local function attributeValue(value: any): any
	local kind = type(value)
	if kind == "nil" or kind == "boolean" or kind == "number" or kind == "string" then
		return value
	elseif kind == "function" then
		error("Function is not a supported attribute type", 0)
	elseif kind == "thread" then
		return nil
	elseif kind == "table" then
		if instances.is(value) then
			return instances.newHandle(value)
		elseif instances.isHandle(value) or opaque[value] == "EnumItem" then
			return value
		elseif opaque[value] ~= nil then
			return nil
		elseif next(value) == nil or value[1] ~= nil then
			error("Array is not a supported attribute type", 0)
		end
		error("Dictionary is not a supported attribute type", 0)
	end

	local datatype = typeof(value)
	if ATTRIBUTE_TYPES[datatype] then
		return value
	elseif datatype == "userdata" then
		return nil
	end
	error(`{datatype} is not a supported attribute type`, 0)
end

function methods:GetAttribute(name: string): any
	return rawget(self, "_attributes")[if type(name) == "number" then tostring(name) else name]
end

function methods:SetAttribute(name: string, value: any)
	name = attributeName(name)
	validateAttributeName(name)
	value = attributeValue(value)

	local attributes = rawget(self, "_attributes")
	if attributes[name] == value then
		return
	end

	attributes[name] = value

	-- The engine's order, under either signal behaviour: `AttributeChanged` first, then the
	-- attribute's own signal; both join the deferred queue with the tree signals.
	instances.fireDeferred("tree", rawget(self, "AttributeChanged"), name)

	local changed = rawget(self, "_attributeSignals")[name]
	if changed then
		instances.fireDeferred("tree", changed)
	end
end

function methods:GetAttributes(): { [string]: any }
	return table.clone(rawget(self, "_attributes"))
end

function methods:GetAttributeChangedSignal(name: string)
	local registry = rawget(self, "_attributeSignals")
	if not registry[name] then
		registry[name] = signals.create(`Instance.{name}AttributeChanged`)
	end
	return registry[name]
end

--[[
	`Name` and `Parent` are the only properties the harness announces a change of: a component's
	instance tree is resolved by the one, and the other is what moves it. The engine fires both
	through the same queue as the tree signals, and only for a write that changes the value; `Changed`
	with the property's name goes just before the property's own signal (measured in Studio under
	both signal behaviours, 2026-09-25), except on a ValueBase, whose `Changed` is for its `Value`
	alone -- a property the harness does not announce.
]]
function methods:GetPropertyChangedSignal(name: string)
	local registry = rawget(self, "_propertySignals")
	if not registry[name] then
		registry[name] = signals.create(`Object.{name}Changed`)
	end
	return registry[name]
end

--- Destroys the children last to first, which is the engine's order under either signal behaviour
--- (measured in Studio, 2026-09-25); each child's own `Destroy` then takes its children first to last.
function methods:ClearAllChildren()
	local children = table.clone(rawget(self, "_children"))
	for index = #children, 1, -1 do
		children[index]:Destroy()
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

	for _, signal in rawget(instance, "_propertySignals") do
		signal:DisconnectAll()
	end
end

--[[
	Destroys the instance, in the engine's order.

	`Destroying` first, while the tree still stands; then the instance leaves its parent -- and with
	it the DataModel, which announces its tags as gone before the move, as any unparenting does,
	and its `Parent` stays locked; then the children come apart, with the instance's own connections
	still live, so its `DescendantRemoving` and `ChildRemoved` handlers run for each child against a
	tree that has already left the DataModel; and only then is every connection dropped. Probed in a
	real server on 2026-09-11 and in Studio under both signal behaviours on 2026-09-25: a
	component's own tree handlers do see the half-dismantled tree, so the registry has to cope with
	that. Under deferred behaviour `Destroying` is queued like the rest, so its handlers run once the
	children are already gone.

	The `Parent` is locked from the start, so a `Destroying` handler cannot move the instance
	anywhere (measured in Studio, 2026-09-25). A `Destroy` made while the instance's own Parent write
	is still under way -- from one of that write's handlers, under immediate behaviour -- has its
	unparenting refused like any other Parent write then (see the Parent write below): the instance
	stays where it is and is left unlocked, and the rest of the destroy goes ahead.
]]
function methods:Destroy()
	if rawget(self, "_destroyed") then
		return
	end

	rawset(self, "_destroyed", true)
	rawset(self, "_locked", true)

	instances.fireDeferred("tree", rawget(self, "Destroying"))

	rawset(self, "_locked", false)
	self.Parent = nil
	if rawget(self, "_parent") == nil then
		rawset(self, "_locked", true)
	end

	for _, child in table.clone(rawget(self, "_children")) do
		child:Destroy()
	end

	disconnectAll(self)
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

	The engine has one queue, and under deferred signal behaviour everything joins it: the tree
	signals (ChildAdded, ChildRemoved, the descendant pair, AncestryChanged, Destroying), property
	and attribute changes, CollectionService's tag signals, BindableEvent dispatch -- which is what
	`@rbxts/signal` and with it every component added/removed announcement fires through -- and the
	threads `task.defer` schedules, all in the order they are raised. The whole batch is delivered at
	the end of the resumption. So a handler runs against a tree that has already finished moving,
	against criteria the signals still queued behind it have not corrected yet, and anything it
	fires or defers joins the back of that same batch rather than nesting. Firing synchronously, as
	this harness does by default, hides all of that.

	`runDeferred(category, callback)` opens a batch in which all of it is deferred: a place has no
	way to defer one kind of signal and not the rest, so the three controls the specs call
	(`deferTree`, `deferTags`, `deferSignals`) open the same batch, they nest, and the batch is
	delivered once the outermost one returns -- in raise order. A fire is delivered to the
	connections that were live when it was raised: one made since does not receive it, one
	disconnected by hand since is skipped, and one dropped because its instance was destroyed still
	receives it (measured in Studio, 2026-09-25).

	A chain of deferred work runs at most 80 deep: whatever a deferred handler or thread raises or
	defers is one level deeper than it, and the engine refuses the 81st level -- a signal's handlers
	are not called and an error is printed for each, and a `task.defer` raises in its caller
	(measured in Studio, 2026-09-25, deferred behaviour). That is what stops a handler that keeps
	re-raising its own signal. A batch that still does not settle -- one that fans out without end
	-- is a frozen server rather than an error in Roblox, so the harness caps it and reports instead
	of running forever.
]]
local deferring = false
local deferDepth = 0
local deferQueue: { any } = {}

local MAX_DEFERRED_DEPTH = 80
local MAX_DEFERRED_STEPS = 10000

--- How deep the deferred work being delivered right now is; 0 outside a delivery.
local deliveryDepth = 0

--- Queues a fire while a batch is open, and delivers it at once otherwise. The category names what
--- raised it, for the reader; a place defers every category together.
local function fireDeferred(_category: string, signal: any, ...: any)
	if not signal then
		return
	end

	if deferring then
		table.insert(deferQueue, {
			connections = signals.snapshot(signal),
			arguments = table.pack(...),
			name = signal._name,
			depth = deliveryDepth + 1,
		})
	else
		signal:Fire(...)
	end
end

instances.fireDeferred = fireDeferred

--[[
	`task.defer`, which joins the open batch in raise order -- between the signals raised before and
	after it -- rather than running after all of them. Outside a batch it is Lune's own.
]]
function instances.defer(callback: any, ...: any): thread
	if not deferring then
		return luneTask.defer(callback, ...)
	end

	if deliveryDepth >= MAX_DEFERRED_DEPTH then
		error(`Maximum re-entrancy depth ({MAX_DEFERRED_DEPTH}) exceeded calling task.defer`, 0)
	end

	local thread = if type(callback) == "thread" then callback else signals.thread(callback)
	table.insert(deferQueue, { thread = thread, arguments = table.pack(...), depth = deliveryDepth + 1 })
	return thread
end

--- Delivers the batch, in order, until it settles. Returns false and why when it does not.
local function deliverBatch(): (boolean, any)
	local steps = 0

	while #deferQueue > 0 do
		steps += 1
		if steps > MAX_DEFERRED_STEPS then
			table.clear(deferQueue)
			return false, `harness: the deferred queue still had work after {MAX_DEFERRED_STEPS} dispatches`
		end

		local entry = table.remove(deferQueue, 1) :: any
		local outerDepth = deliveryDepth
		deliveryDepth = entry.depth

		-- A handler that raises does not stop the rest, the way it does not in the engine: it is
		-- reported, as the engine prints it (see `signals`).
		if entry.thread then
			-- `task.cancel` before its turn closes the thread, and a cancelled one never runs.
			if coroutine.status(entry.thread) == "suspended" then
				signals.resume(entry.thread, table.unpack(entry.arguments, 1, entry.arguments.n))
			end
		elseif entry.depth > MAX_DEFERRED_DEPTH then
			for _, connection in entry.connections do
				if not connection._disconnectedByHand then
					signals.refuse(connection, entry.name)
				end
			end
		else
			signals.deliver(entry.connections, entry.name, table.unpack(entry.arguments, 1, entry.arguments.n))
		end

		deliveryDepth = outerDepth
	end

	return true, nil
end

--- Runs `callback` with every signal deferred, delivering the batch it built afterwards.
function instances.runDeferred(_category: string, callback: () -> ())
	local previous = deferring
	deferring = true
	deferDepth += 1

	local ok, err = pcall(callback)
	deferDepth -= 1

	-- Only the outermost control delivers the batch.
	if deferDepth > 0 then
		deferring = previous

		if not ok then
			error(err, 0)
		end
		return
	end

	-- Delivered with the batch still open, because a fire made from inside a deferred handler joins
	-- the back of this batch rather than being delivered at once.
	local delivered, deliveryError = deliverBatch()
	deferring = false

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

--- Announces a property change through `GetPropertyChangedSignal`, deferred with the tree signals
--- as the engine defers it.
local function fireProperty(instance: Instance, name: string)
	-- `Changed` first, with the property's name (see `GetPropertyChangedSignal`).
	if not methods.IsA(instance, "ValueBase") then
		fireTree(rawget(instance, "Changed"), name)
	end

	local signal = rawget(instance, "_propertySignals")[name]
	if signal then
		fireTree(signal, nil)
	end
end

local function fireDeferrable(signal: any, ...: any)
	fireDeferred("signals", signal, ...)
end

--- The three controls the specs call, named for what each one is there to show -- the tree signals,
--- BindableEvent dispatch (a component's added and removed announcements), CollectionService's tag
--- signals -- and all opening the one batch, in which a place defers everything at once.
function instances.runDeferredTree(callback: () -> ())
	return instances.runDeferred("tree", callback)
end

function instances.runDeferredSignals(callback: () -> ())
	return instances.runDeferred("signals", callback)
end

function instances.runDeferredTags(callback: () -> ())
	return instances.runDeferred("tags", callback)
end

--[[
	Entering and leaving the DataModel.

	CollectionService announces a tag when the instance carrying it enters the DataModel and again
	when it leaves, which is a second way for a component to come and go: tagging a parentless
	instance announces nothing, and re-parenting within the DataModel announces nothing at all --
	the tag never went anywhere. Leaving announces the tag before the move, while the instance still
	reads as parented, in the DataModel and tagged; entering announces it after the move and before
	the new parent's ChildAdded. The Parent write below has the whole order.

	Ancestry is the harness's own business, and tags belong to a realm's CollectionService, so each
	realm registers an observer here and is told about each instance that crossed the boundary.
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

--- Tells every realm about one instance that crossed the boundary.
local function announceAncestry(instance: Instance, entered: boolean)
	for _, observer in ancestryObservers do
		observer(instance, entered)
	end
end

--- The instance and every descendant of it, each parent before its children.
local function subtreeOf(instance: Instance): { Instance }
	local result = { instance }
	for _, descendant in methods.GetDescendants(instance) do
		table.insert(result, descendant)
	end
	return result
end

--- The ancestors a parent stands for, nearest first.
local function ancestryOf(parent: Instance?): { Instance }
	local result = {}
	local current = parent
	while current do
		table.insert(result, current)
		current = rawget(current, "_parent")
	end
	return result
end

--- `AncestryChanged` on every instance of a moved subtree, each child before its parent, and each
--- told which instance moved and where to -- not its own parent.
local function fireAncestryChanged(instance: Instance, moved: Instance, parent: Instance?)
	for _, child in table.clone(rawget(instance, "_children")) do
		fireAncestryChanged(child, moved, parent)
	end

	fireDeferred("tree", rawget(instance, "AncestryChanged"), moved, parent)
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
		-- Writing the value it already has is no change, and announces nothing.
		if rawget(instance, "_name") == value then
			return
		end

		rawset(instance, "_name", value)
		fireProperty(instance, "Name")
	elseif key == "Parent" then
		local previousParent = rawget(instance, "_parent")

		-- Nor is writing the parent it already has: no signal, and its place among its siblings stays.
		if previousParent == value then
			return
		end

		-- A write made while this instance's own Parent write is still under way -- from a handler of
		-- one of the signals below, under immediate behaviour, or anything that handler calls -- is
		-- refused with a warning and nothing else: no error, and the instance goes where the first
		-- write sends it. Measured in Studio, 2026-09-25, for every signal the move raises, the tag
		-- announcements included; under deferred behaviour those handlers run once the write is done,
		-- and nothing is refused.
		if rawget(instance, "_settingParent") then
			signals.warn(
				`Something unexpectedly tried to set the parent of {rawget(instance, "_name")} to `
					.. `{if value then value.Name else "NULL"} while trying to set the parent of `
					.. `{rawget(instance, "_name")}. Current parent is `
					.. `{if previousParent then previousParent.Name else "NULL"}.`
			)
			return
		end

		if rawget(instance, "_locked") then
			error(
				`The Parent property of {methods.GetFullName(instance)} is locked, current parent: `
					.. `{if previousParent then previousParent.Name else "NULL"}, new parent `
					.. `{if value then value.Name else "NULL"}`,
				0
			)
		end

		local wasInDataModel = isInDataModel(instance)
		local isEntering = value ~= nil and isInDataModel(value)
		local leaves = wasInDataModel and not isEntering
		local enters = isEntering and not wasInDataModel

		-- The ancestors the move takes the subtree away from, and the ones it brings it under. One
		-- that is both, above the old and the new parent alike, hears nothing.
		local oldAncestry = ancestryOf(previousParent)
		local newAncestry = ancestryOf(value)
		local lost, gained = {}, {}
		for _, ancestor in oldAncestry do
			if not table.find(newAncestry, ancestor) then
				table.insert(lost, ancestor)
			end
		end
		for _, ancestor in newAncestry do
			if not table.find(oldAncestry, ancestor) then
				table.insert(gained, ancestor)
			end
		end

		local moved = subtreeOf(instance)

		--[[
			The engine's order, measured in Studio on 2026-09-25 (the same raise order under both
			signal behaviours; deferred behaviour delivers it after the resumption):

			1. Before the move, for each instance of the subtree, parents first: `DescendantRemoving`
			   on every ancestor it is leaving, nearest first, then -- when it leaves the DataModel --
			   its tags announced as removed. Those handlers read the tree as it was.
			2. The move.
			3. The old parent's `ChildRemoved`.
			4. For each instance of the subtree: `DescendantAdded` on every ancestor it is joining,
			   nearest first, then -- when it enters the DataModel -- its tags announced as added.
			5. The new parent's `ChildAdded`.
			6. `AncestryChanged` across the subtree, children first, then the `Parent` change.
		]]
		rawset(instance, "_settingParent", true)

		for _, descendant in moved do
			for _, ancestor in lost do
				fireTree(rawget(ancestor, "DescendantRemoving"), descendant)
			end

			if leaves then
				announceAncestry(descendant, false)
			end
		end

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

		if previousParent then
			fireTree(rawget(previousParent, "ChildRemoved"), instance)
		end

		for _, descendant in moved do
			for _, ancestor in gained do
				fireTree(rawget(ancestor, "DescendantAdded"), descendant)
			end

			if enters then
				announceAncestry(descendant, true)
			end
		end

		if value then
			fireTree(rawget(value, "ChildAdded"), instance)
		end

		fireAncestryChanged(instance, instance, value)
		fireProperty(instance, "Parent")

		rawset(instance, "_settingParent", nil)
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

-- Two handles naming the same instance are equal, so writing a fresh handle to an attribute that
-- already names that instance is no change (measured in Studio, 2026-09-25).
handleMeta.__eq = function(a, b)
	return rawget(a, "_target") == rawget(b, "_target")
end

-- Printed as the instance it names, as the engine prints it (measured in Studio, 2026-09-25).
handleMeta.__tostring = function(handle)
	return tostring(rawget(handle, "_target"))
end

function handleMeta:Get(): Instance?
	return rawget(self, "_instance")
end

function handleMeta:Wait(timeout: number?): Instance?
	local instance = rawget(self, "_instance")
	if instance ~= nil then
		return instance
	end

	-- A handle made from nothing (`InstanceHandle.new(nil)`) has nothing to wait for: the engine
	-- answers at once rather than after the timeout (probed 2026-09-11).
	if rawget(self, "_target") == nil then
		return nil
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
	How many handlers are connected to an instance, across its own signals, the per-attribute
	ones and the per-property ones.

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

	for _, signal in rawget(instance, "_propertySignals") do
		total += signals.count(signal)
	end

	return total
end

--[[
	Tells an instance which realm made it, for the members the engine only allows on one side.

	A realm's `Instance.new` sets it; `RunService` is asked at the call, so a spec that runs a
	callback as the other realm is answered as that realm. Only `RemoteFunction:InvokeServer` reads
	it: a server calling it raises "InvokeServer can only be called from the client" (measured in a
	Studio play server, 2026-09-25).
]]
function instances.setRealm(instance: Instance, runService: any)
	rawset(instance, "_realm", runService)
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

--[[
	The copy a BindableEvent or BindableFunction hands over, measured in Studio under both signal
	behaviours (2026-09-25).

	Tables are copied, every time they appear -- one shared by two fields arrives as two tables --
	without their metatables or frozenness, and a cycle raises in the caller. A table with an array
	part (`#t > 0`) arrives as that array alone, holes included, and its other keys are dropped;
	any other table is a dictionary whose keys become strings (a number as its whole part, anything
	else as `<Type> (tostring)`), and a boolean key raises in the caller. A thread or a bare userdata
	arrives as nil. Functions, Instances and the datatypes pass as they are. The copy is made when
	the event is fired, and each handler gets one of its own.
]]
local function bindableKey(key: any): string
	local kind = type(key)
	if kind == "string" then
		return key
	elseif kind == "number" then
		if key ~= key or key == math.huge or key == -math.huge then
			return "-9223372036854775808"
		end
		return string.format("%d", if key < 0 then math.ceil(key) else math.floor(key))
	elseif kind == "boolean" then
		error("Invalid table key type used", 0)
	elseif instances.is(key) then
		return `<Instance> ({rawget(key, "_name")})`
	elseif opaque[key] == "EnumItem" then
		return `<token> ({tostring(key)})`
	elseif kind == "table" then
		return `<Table> ({tostring(key)})`
	elseif kind == "function" then
		return `<Function> ({tostring(key)})`
	end
	return `<{typeof(key)}> ({tostring(key)})`
end

local function bindableValue(value: any, path: { [any]: boolean }): any
	local kind = type(value)
	if kind == "thread" then
		return nil
	elseif kind == "userdata" then
		return if typeof(value) == "userdata" then nil else value
	elseif kind ~= "table" or instances.is(value) or instances.isHandle(value) or opaque[value] ~= nil then
		return value
	end

	if path[value] then
		error("tables cannot be cyclic", 0)
	end
	path[value] = true

	local copy = {}
	local length = #value
	if length > 0 then
		for index = 1, length do
			copy[index] = bindableValue(value[index], path)
		end
	else
		for key, item in value do
			local copied = bindableValue(item, path)
			if copied ~= nil then
				copy[bindableKey(key)] = copied
			end
		end
	end

	path[value] = nil
	return copy
end

local function copyArguments(...: any): ...any
	local count = select("#", ...)
	local copies = table.create(count)
	for index = 1, count do
		copies[index] = bindableValue((select(index, ...)), {})
	end
	return table.unpack(copies, 1, count)
end

--- A handler's own copy of what `copyArguments` made at the fire: the same shape, new tables.
local function cloneCopy(value: any): any
	if type(value) ~= "table" or instances.is(value) or instances.isHandle(value) or opaque[value] ~= nil then
		return value
	end

	local clone = {}
	for key, item in value do
		clone[key] = cloneCopy(item)
	end
	return clone
end

local function cloneArguments(...: any): ...any
	local count = select("#", ...)
	local clones = table.create(count)
	for index = 1, count do
		clones[index] = cloneCopy((select(index, ...)))
	end
	return table.unpack(clones, 1, count)
end

function instances.new(className: string, parent: Instance?): Instance
	local instance = setmetatable({
		_className = className,
		_name = className,
		_parent = nil,
		_children = {},
		_attributes = {},
		_attributeSignals = {},
		_propertySignals = {},
		_destroyed = false,
		_signals = {},
	}, instanceMeta)

	for _, name in { "Destroying", "AncestryChanged", "ChildAdded", "ChildRemoved", "AttributeChanged", "DescendantAdded", "DescendantRemoving", "Changed" } do
		local signal = signals.create(`Instance.{name}`)
		rawset(instance, name, signal)
		rawget(instance, "_signals")[name] = signal
	end

	if className == "BindableEvent" then
		local event = signals.create("BindableEvent.Event")
		event._copy = cloneArguments
		rawset(instance, "Event", event)
		rawget(instance, "_signals")["Event"] = event
		rawset(instance, "Fire", function(_self, ...)
			-- Copied here, so a table changed after the call arrives as it was; each handler then
			-- gets a clone of this copy.
			fireDeferrable(event, copyArguments(...))
		end)
	end

	-- The two function-shaped instances the testing package answers on. OnInvoke and OnServerInvoke
	-- are plain properties (the generic __newindex stores them); Invoke and InvokeServer call them.
	-- Only one realm exists per process, so InvokeServer reaches the callback set in this same graph
	-- and passes nil for the player -- from a client, that is: a server calling it on its own remote
	-- is refused, as the engine refuses it (see `instances.setRealm`).
	if className == "BindableFunction" then
		-- The arguments and the results are copied as a BindableEvent copies them. What OnInvoke
		-- raises is printed, as a thread's error is, and raised in the caller as well (measured in
		-- Studio, 2026-09-25).
		rawset(instance, "Invoke", function(self, ...)
			local callback = rawget(self, "OnInvoke")
			if callback == nil then
				error("harness: BindableFunction.Invoke with no OnInvoke set", 2)
			end

			local results = table.pack(pcall(callback, copyArguments(...)))
			if not results[1] then
				signals.report(results[2])
				error(results[2], 0)
			end
			return copyArguments(table.unpack(results, 2, results.n))
		end)
	end

	if className == "RemoteFunction" then
		rawset(instance, "InvokeServer", function(self, ...)
			local realm = rawget(self, "_realm")
			if realm ~= nil and not realm:IsClient() then
				error("InvokeServer can only be called from the client", 0)
			end

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
			local signal = signals.create(`{className}.{name}`)
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
