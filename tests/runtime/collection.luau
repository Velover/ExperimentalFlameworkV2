--!nolint
--[[
	CollectionService stand-in.

	Tags are stored per instance, and the added/removed signals fire synchronously so specs can
	assert immediately after tagging -- but only for an instance the DataModel holds. Tagging
	something outside it announces nothing at all, and `GetTagged` does not list it: it is entering
	the DataModel that announces the tag, whether that happens to the instance itself or to an
	ancestor of it.

	`runDeferred(callback)` switches to Roblox's deferred behaviour for the duration of `callback`:
	every fire is queued and delivered in order once it returns, so a spec can reproduce an event
	arriving after the state it describes has already changed.

	One instance per realm: two graphs in a single process must not share tag state.
]]

local instances = require("./instance")
local signals = require("./signals")

local collection = {}

function collection.create()
	local tagged: { [string]: { [any]: boolean } } = {}
	local addedSignals: { [string]: any } = {}
	local removedSignals: { [string]: any } = {}

	local CollectionService = {}

	local deferring = false
	local queue: { { signal: any, instance: any } } = {}

	local function fire(signal: any, instance: any)
		if signal == nil then
			return
		end
		if deferring then
			table.insert(queue, { signal = signal, instance = instance })
		else
			signal:Fire(instance)
		end
	end

	--- Runs `callback` with deferred signals, then delivers everything it queued, in order.
	function CollectionService.runDeferred(callback: () -> ())
		local previous = deferring
		deferring = true
		local ok, err = pcall(callback)
		deferring = previous
		if not deferring then
			local pending = queue
			queue = {}
			for _, entry in pending do
				entry.signal:Fire(entry.instance)
			end
		end
		if not ok then
			error(err, 0)
		end
	end

	function CollectionService:AddTag(instance: any, tag: string)
		local set = tagged[tag]
		if not set then
			set = {}
			tagged[tag] = set
		end

		if set[instance] then
			return
		end

		set[instance] = true

		-- The tag lands either way; it is the DataModel that announces it. An instance outside it
		-- -- a template being assembled, or a subtree that has been unparented -- is announced when
		-- it, or an ancestor of it, is parented in.
		if instances.isInDataModel(instance) then
			fire(addedSignals[tag], instance)
		end
	end

	function CollectionService:RemoveTag(instance: any, tag: string)
		local set = tagged[tag]
		if not set or not set[instance] then
			return
		end

		set[instance] = nil

		-- Nothing was announced when it was tagged outside the DataModel, so nothing is announced
		-- when the tag goes either.
		if instances.isInDataModel(instance) then
			fire(removedSignals[tag], instance)
		end
	end

	function CollectionService:HasTag(instance: any, tag: string): boolean
		local set = tagged[tag]
		return set ~= nil and set[instance] == true
	end

	--- Only what the DataModel holds, which is what the engine lists.
	function CollectionService:GetTagged(tag: string): { any }
		local result = {}
		for instance in tagged[tag] or {} do
			if instances.isInDataModel(instance) then
				table.insert(result, instance)
			end
		end
		return result
	end

	--[[
		Announces the tags of an instance that has entered or left the DataModel.

		The tag itself stays on the instance either way -- it is the announcement that ancestry
		drives -- so a tagged instance parented out and back in is reported as removed and then
		added again, which is what takes a component down with its instance and brings it back.
	]]
	function CollectionService.announceAncestry(instance: any, entered: boolean)
		for tag, set in tagged do
			if set[instance] then
				fire(if entered then addedSignals[tag] else removedSignals[tag], instance)
			end
		end
	end

	--- Carries an instance's tags onto a clone of it, which is what `Instance:Clone` does.
	function CollectionService.announceClone(source: any, clone: any)
		for _, set in tagged do
			if set[source] then
				set[clone] = true
			end
		end
	end

	function CollectionService:GetTags(instance: any): { string }
		local result = {}
		for tag, set in tagged do
			if set[instance] then
				table.insert(result, tag)
			end
		end
		return result
	end

	function CollectionService:GetInstanceAddedSignal(tag: string)
		if not addedSignals[tag] then
			addedSignals[tag] = signals.create()
		end
		return addedSignals[tag]
	end

	function CollectionService:GetInstanceRemovedSignal(tag: string)
		if not removedSignals[tag] then
			removedSignals[tag] = signals.create()
		end
		return removedSignals[tag]
	end

	--- Clears all tag state so suites do not leak into each other.
	function CollectionService.reset()
		table.clear(tagged)
	end

	return CollectionService
end

return collection
