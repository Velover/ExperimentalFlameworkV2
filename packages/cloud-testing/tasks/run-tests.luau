local ReplicatedStorage = game:GetService("ReplicatedStorage")
local include = ReplicatedStorage:FindFirstChild("rbxts_include")
local modules = include and include:FindFirstChild("node_modules")
local scope = modules and modules:FindFirstChild("@flamework-experimental")
local testing = scope and scope:FindFirstChild("testing")
local out = testing and testing:FindFirstChild("out")
local cloud = out and out:FindFirstChild("cloud")
if not cloud then
    error("@flamework-experimental/testing is not in this place: build it with FLAMEWORK_TESTS=true and publish again")
end
return require(cloud).run(__FILTER__, __OPTIONS__)
