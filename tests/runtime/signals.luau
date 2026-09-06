--!nolint
--[[
	A synchronous RBXScriptSignal stand-in.

	Roblox defers connection handlers; firing synchronously here makes the specs deterministic
	without a scheduler round-trip, which matters because Flamework's component tracker reacts to
	CollectionService signals and the specs assert immediately afterwards.
]]

local luneTask = require("@lune/task")

local signals = {}

export type Signal = any

local Signal = {}
Signal.__index = Signal

function Signal:Connect(callback: (...any) -> ())
	local id = self._nextId
	self._nextId += 1
	self._connections[id] = callback

	local connection
	connection = {
		Connected = true,
		Disconnect = function()
			self._connections[id] = nil
			self._connectionObjects[id] = nil
			connection.Connected = false
		end,
	}

	-- Kept so that `DisconnectAll` can mark them as gone, which is what an instance being
	-- destroyed does to every connection on it.
	self._connectionObjects[id] = connection

	-- roblox-ts emits `:Disconnect()`, and Lua libraries use `.disconnect()`. `@rbxts/maid`
	-- identifies real connections with `typeof(x) == "RBXScriptConnection"`, which a table can
	-- never satisfy, so it falls back to looking for `.Destroy` -- provide that too.
	connection.disconnect = connection.Disconnect
	connection.Destroy = connection.Disconnect
	connection.destroy = connection.Disconnect

	return connection
end

Signal.connect = Signal.Connect

function Signal:Once(callback: (...any) -> ())
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		callback(...)
	end)
	return connection
end

--- Yields the calling coroutine until the next fire, mirroring RBXScriptSignal:Wait().
function Signal:Wait()
	local thread = coroutine.running()
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		luneTask.spawn(thread, ...)
	end)

	return coroutine.yield()
end

function Signal:Fire(...: any)
	-- Copied so that a handler disconnecting during dispatch does not skip its neighbours.
	local snapshot = {}
	for id, callback in self._connections do
		snapshot[id] = callback
	end

	for id, callback in snapshot do
		if self._connections[id] then
			callback(...)
		end
	end
end

--[[
	Drops every connection at once.

	The engine disconnects everything connected to an instance when it is destroyed, before its
	children come apart, which is why none of a destroyed instance's own tree signals reach a
	handler.
]]
function Signal:DisconnectAll()
	for _, connection in self._connectionObjects do
		connection.Connected = false
	end

	table.clear(self._connections)
	table.clear(self._connectionObjects)
end

--- How many handlers are connected right now, which is what a leak test counts.
function signals.count(signal: Signal): number
	local total = 0
	for _ in signal._connections do
		total += 1
	end
	return total
end

function signals.create(): Signal
	return setmetatable({ _connections = {}, _connectionObjects = {}, _nextId = 1 }, Signal)
end

return signals
