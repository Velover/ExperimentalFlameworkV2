--!nolint
--[[
	CollectionService stand-in.

	Tags are stored per instance, and the added/removed signals fire synchronously so specs can
	assert immediately after tagging.
]]

local signals = require("./signals")

local collection = {}

local tagged: { [string]: { [any]: boolean } } = {}
local addedSignals: { [string]: any } = {}
local removedSignals: { [string]: any } = {}

local CollectionService = {}

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

	local signal = addedSignals[tag]
	if signal then
		signal:Fire(instance)
	end
end

function CollectionService:RemoveTag(instance: any, tag: string)
	local set = tagged[tag]
	if not set or not set[instance] then
		return
	end

	set[instance] = nil

	local signal = removedSignals[tag]
	if signal then
		signal:Fire(instance)
	end
end

function CollectionService:HasTag(instance: any, tag: string): boolean
	local set = tagged[tag]
	return set ~= nil and set[instance] == true
end

function CollectionService:GetTagged(tag: string): { any }
	local result = {}
	for instance in tagged[tag] or {} do
		table.insert(result, instance)
	end
	return result
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
function collection.reset()
	table.clear(tagged)
end

collection.CollectionService = CollectionService

return collection
