-- @mode console
-- The cheapest realm: no session, no engine loop. Good for pure Luau hypotheses and for checking
-- what the Edit data model reports about itself.
local RunService = game:GetService("RunService")
check("edit data model is not running", not RunService:IsRunning())
log("players in edit (Team Create lists collaborators here)", #game:GetService("Players"):GetPlayers())
log("scratch parent is", scratch().Parent.Name)
return ("edit: IsServer=%s IsClient=%s"):format(tostring(RunService:IsServer()), tostring(RunService:IsClient()))
