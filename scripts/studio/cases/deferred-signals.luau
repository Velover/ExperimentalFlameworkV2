-- @mode server
-- @timeout 20
-- Does the engine deliver a tag that was added and removed in the same frame? The Lune stub
-- delivers signals immediately, which is what hid the stale-tag bug fixed on 2026-09-05.
local CollectionService = game:GetService("CollectionService")

local tag = "FwHypothesisTag"
local seen = {}
local added = CollectionService:GetInstanceAddedSignal(tag):Connect(function(instance)
	table.insert(seen, "+" .. instance.Name)
end)
local removed = CollectionService:GetInstanceRemovedSignal(tag):Connect(function(instance)
	table.insert(seen, "-" .. instance.Name)
end)
defer(function()
	added:Disconnect()
	removed:Disconnect()
end)

local part = Instance.new("Part")
part.Name = "Subject"
part.Anchored = true
part.Parent = scratch()

CollectionService:AddTag(part, tag)
CollectionService:RemoveTag(part, tag)
local immediately = table.concat(seen, " ")
task.wait(0.2)

check("added/removed in one frame are deferred", immediately == "", "during the frame: '" .. immediately .. "'")
check("both signals arrive after the frame", table.concat(seen, " ") == "+Subject -Subject", table.concat(seen, " "))
check("HasTag is already false when the added signal lands", not CollectionService:HasTag(part, tag))
return { delivered = seen }
