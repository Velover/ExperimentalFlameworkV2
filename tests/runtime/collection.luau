--!nolint
--[[
	CollectionService stand-in.

	Tags are stored per instance, and the added/removed signals fire synchronously so specs can
	assert immediately after tagging -- but only for an instance the DataModel holds. Tagging
	something outside it announces nothing at all, and `GetTagged` does not list it: it is entering
	the DataModel that announces the tag, whether that happens to the instance itself or to an
	ancestor of it.

	`runDeferred(callback)` switches to Roblox's deferred behaviour for the duration of `callback`:
	every fire joins the harness's one deferred queue, alongside the tree signals and BindableEvent
	dispatch, and the batch is delivered in raise order once the outermost control returns. That
	interleaving is the whole point: a tag announcement and the child signal for the same move reach
	their handlers one after the other, in the order a place raises them.

	One instance per realm: two graphs in a single process must not share tag state.
]]

local instances = require("./instance")
local signals = require("./signals")

local collection = {}

function collection.create()
	local tagged: { [string]: { [any]: boolean } } = {}
	--- Each instance's tags in the order they were added, which is the order the engine lists them
	--- in and announces them in when the instance enters or leaves the DataModel (measured in
	--- Studio, 2026-09-25); a tag removed and added again goes to the back.
	local tagsOf: { [any]: { string } } = {}
	local addedSignals: { [string]: any } = {}
	local removedSignals: { [string]: any } = {}

	local CollectionService = {}

	local function fire(signal: any, instance: any)
		instances.fireDeferred("tags", signal, instance)
	end

	--- Runs `callback` with the tag signals joining the harness's deferred batch.
	CollectionService.runDeferred = instances.runDeferredTags

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

		local list = tagsOf[instance]
		if not list then
			list = {}
			tagsOf[instance] = list
		end
		table.insert(list, tag)

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

		local list = tagsOf[instance]
		local index = list and table.find(list, tag)
		if index then
			table.remove(list, index)
		end

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
		for _, tag in table.clone(tagsOf[instance] or {}) do
			-- One an earlier handler removed has already announced itself.
			if tagged[tag][instance] then
				fire(if entered then addedSignals[tag] else removedSignals[tag], instance)
			end
		end
	end

	--- Carries an instance's tags onto a clone of it, which is what `Instance:Clone` does.
	function CollectionService.announceClone(source: any, clone: any)
		local list = tagsOf[source]
		if not list then
			return
		end

		for _, tag in list do
			tagged[tag][clone] = true
		end
		tagsOf[clone] = table.clone(list)
	end

	function CollectionService:GetTags(instance: any): { string }
		return table.clone(tagsOf[instance] or {})
	end

	function CollectionService:GetInstanceAddedSignal(tag: string)
		if not addedSignals[tag] then
			addedSignals[tag] = signals.create(`CollectionService.{tag}InstanceAdded`)
		end
		return addedSignals[tag]
	end

	function CollectionService:GetInstanceRemovedSignal(tag: string)
		if not removedSignals[tag] then
			removedSignals[tag] = signals.create(`CollectionService.{tag}InstanceRemoved`)
		end
		return removedSignals[tag]
	end

	--- Clears all tag state so suites do not leak into each other.
	function CollectionService.reset()
		table.clear(tagged)
		table.clear(tagsOf)
	end

	return CollectionService
end

return collection
