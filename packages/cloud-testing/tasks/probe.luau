-- What does a Luau execution task actually look like from the inside?
-- Answers the questions Docs.md left open. Never calls RunService:Run(),
-- IsEdit() or IsRunMode(): those raise "lacking capability Plugin" here.
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")

local heartbeats = 0
local connection = RunService.Heartbeat:Connect(function()
    heartbeats += 1
end)
task.wait(1)
connection:Disconnect()

return HttpService:JSONEncode({
    isRunning = RunService:IsRunning(),
    isServer = RunService:IsServer(),
    isClient = RunService:IsClient(),
    isStudio = RunService:IsStudio(),
    heartbeatsPerSecond = heartbeats,
    serverScriptServiceChildren = #ServerScriptService:GetChildren(),
    placeVersion = game.PlaceVersion,
    -- nil when the place's own Scripts never ran, which is the expected answer
    flameworkScriptRan = _G.FLAMEWORK_SCRIPT_RAN == true,
})
