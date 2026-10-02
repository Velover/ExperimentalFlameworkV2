--!strict
--[[
	How many arguments a remote delivered, counted the way the engine handed them over:
	`select("#", ...)`, so that a trailing nil counts and a missing argument does not. roblox-ts
	gathers a rest parameter into a table and measures it with `#`, which cannot tell the two apart,
	so the count is taken here, in Luau.
]]

local function countWire(
	signal: RBXScriptSignal,
	fromPlayer: boolean,
	record: (count: number, first: any) -> ()
): RBXScriptConnection
	return signal:Connect(function(...)
		if fromPlayer then
			-- `OnServerEvent` hands the sender first, which is not something the client put on the wire.
			record(select("#", ...) - 1, (select(2, ...)))
		else
			record(select("#", ...), (select(1, ...)))
		end
	end)
end

return {
	countWire = countWire,
}
