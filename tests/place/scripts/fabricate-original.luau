--[[
	Stands in for "File > Save to File" on the original game: makes original.rbxl from the current
	build (place.rbxl) plus what only the original place holds -- an Assets folder with a model, a
	Sounds folder, a marker in Workspace, and some stale code that a patch has to replace. The
	server's `assets` section checks each of them in the patched place.

	  lune run scripts/fabricate-original.luau              -- (re)make it
	  lune run scripts/fabricate-original.luau --if-missing -- only when there is none yet (`bun run test`)
]]
local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")

if table.find(process.args, "--if-missing") and fs.isFile("original.rbxl") then
	return
end

local place = roblox.deserializePlace(fs.readFile("place.rbxl"))

local function folder(parent, name)
	local existing = parent:FindFirstChild(name)
	if existing then
		return existing
	end
	local created = roblox.Instance.new("Folder")
	created.Name = name
	created.Parent = parent
	return created
end

-- ReplicatedStorage.Assets, with a model inside: a game's own assets, which no Rojo project declares.
local assets = folder(place:GetService("ReplicatedStorage"), "Assets")
local model = roblox.Instance.new("Model")
model.Name = "PreciousModel"
model.Parent = assets
local part = roblox.Instance.new("Part")
part.Name = "Body"
part.Parent = model

-- SoundService.Sounds, holding the sounds the `assets` section looks up by name.
local sounds = folder(place:GetService("SoundService"), "Sounds")
for _, name in { "UIHoverOverButton", "UIClickButton", "UIToggleSwitch" } do
	local sound = roblox.Instance.new("Sound")
	sound.Name = name
	sound.Parent = sounds
end

-- Something only the original has in Workspace, and stale code the build has to replace.
local marker = roblox.Instance.new("Folder")
marker.Name = "OriginalOnlyAssets"
marker.Parent = place:GetService("Workspace")

local serverTree = place:GetService("ServerScriptService"):FindFirstChild("TS")
if serverTree then
	local stale = roblox.Instance.new("Folder")
	stale.Name = "StaleFolderFromOriginal"
	stale.Parent = serverTree
end

fs.writeFile("original.rbxl", roblox.serializePlace(place))
print("wrote original.rbxl: Assets.PreciousModel, Sounds x3, Workspace.OriginalOnlyAssets, stale server folder")
