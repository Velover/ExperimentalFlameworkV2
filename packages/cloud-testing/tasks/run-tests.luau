local ReplicatedStorage = game:GetService("ReplicatedStorage")
local include = ReplicatedStorage:FindFirstChild("rbxts_include")
local runtime = include and include:FindFirstChild("RuntimeLib")
local modules = include and include:FindFirstChild("node_modules")
local scope = modules and modules:FindFirstChild("@flamework-experimental")
local testing = scope and scope:FindFirstChild("testing")
local out = testing and testing:FindFirstChild("out")
local cloud = out and out:FindFirstChild("cloud")
if not runtime then
    error("this place has no ReplicatedStorage.rbxts_include.RuntimeLib: it was not built by roblox-ts")
end
if not cloud then
    error("@flamework-experimental/testing is not in this place: include TestingPlugin in the module testing.entry ignites and publish again")
end
-- Through the roblox-ts runtime, the way a compiled module imports another: a plain require leaves
-- the module without its `_G[script]` hook and it fails on its first import.
local TS = require(runtime)
-- `script` is nil in a cloud task; the import only needs a key for its cycle detection.
return TS.import(script or {}, cloud).run(__FILTER__, __OPTIONS__)
