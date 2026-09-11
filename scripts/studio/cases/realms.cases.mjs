// A JS-declared case list: the same fields a .luau header takes, but the code can be built in JS,
// so one hypothesis can be run across several inputs without copying a file.
const realmReport = `
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
log("players", #Players:GetPlayers(), "localPlayer", tostring(Players.LocalPlayer))
check("the session is running", RunService:IsRunning())
return ("IsServer=%s IsClient=%s"):format(tostring(RunService:IsServer()), tostring(RunService:IsClient()))
`;

export default [
	// `both` sends one snippet to the Server and the Client data model of the same Play session.
	{ name: "what each realm reports", mode: "both", timeout: 15, code: realmReport },

	// A pair: `sweep: false` lets the first case hand its instance to the second one. Only a pair
	// inside one Play session may do this -- the session is discarded afterwards either way.
	{
		name: "server publishes a marker",
		mode: "play-server",
		timeout: 15,
		sweep: false,
		code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local marker = Instance.new("StringValue")
marker.Name = "FwReplicationProbe"
marker.Value = "from the server"
marker:SetAttribute("stamp", os.clock())
marker.Parent = ReplicatedStorage
return marker.Value
`,
	},
	{
		name: "client sees the replicated marker",
		mode: "client",
		timeout: 20,
		code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local marker = ReplicatedStorage:WaitForChild("FwReplicationProbe", 10)
check("marker replicated to the client", marker ~= nil, marker and marker.ClassName or "absent")
check("its attribute replicated too", marker ~= nil and marker:GetAttribute("stamp") ~= nil)
return marker and marker.Value or nil
`,
	},
];
