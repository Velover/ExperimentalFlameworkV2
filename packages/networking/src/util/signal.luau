--[[
	A signal of networking's own, and the recycled threads it and the receive pipeline run on.

	Plain Luau rather than TypeScript: roblox-ts turns every `...args` into a table and spreads it with
	`unpack`, which stops at the first nil it happens to land on. Here a vararg list keeps its count
	from the remote to the handler, and nothing is allocated on the way.

	Arguments are handed over by reference. A BindableEvent would copy them, turning a decoded
	`Map<Instance, ...>` into one keyed by strings and raising on a `Set<boolean>`.

	Like an engine signal, each handler runs on a thread of its own: one that yields does not hold up
	the others, and one that raises has its error printed while the others still run. The newest
	connection runs first, which is the order the engine runs a BindableEvent's handlers in; one made
	during a fire does not receive it, and one disconnected before its turn is skipped.
]]

--- Threads that finished their last job, waiting in `coroutine.yield()` for the next.
local idle: { thread } = {}

--- How many finished threads are kept. More than a few are only ever needed while handlers yield;
--- past this, a thread that finishes simply ends.
local MAX_IDLE = 16

local function call(callback: (...any) -> ...any, ...: any)
	callback(...)
end

--[[
	The body of a recycled thread: waits for a job, runs it, parks itself, and runs whatever it is
	resumed with next. A job that raises ends the thread, and the error is printed by the scheduler
	that resumed it; a job that yields keeps the thread until it returns, so it is only ever parked
	when idle.

	It takes no arguments, and every job arrives through `coroutine.yield()`: a job passed as the
	thread's own arguments would stay in this frame's varargs for as long as the thread lives,
	keeping its handler, sender and arguments reachable long after it returned.
]]
local function runner()
	local thread = coroutine.running()

	while true do
		call(coroutine.yield())

		if #idle >= MAX_IDLE then
			return
		end
		table.insert(idle, thread)
	end
end

--[[
	Runs `callback(...)` at once on a thread of its own, recycling one that finished its last job. An
	idle thread that was killed meanwhile (`task.cancel`) is dropped rather than resumed.
]]
local function spawn(callback: (...any) -> ...any, ...: any)
	local count = #idle
	while count > 0 do
		local thread = idle[count]
		idle[count] = nil
		count -= 1

		if coroutine.status(thread) == "suspended" then
			task.spawn(thread, callback, ...)
			return
		end
	end

	-- A new thread, started up to its first `coroutine.yield()`, gets its first job the same way.
	local thread = coroutine.create(runner)
	coroutine.resume(thread)
	task.spawn(thread, callback, ...)
end

local Connection = {}
Connection.__index = Connection

--- Disconnects the handler. Takes effect at once, even for a fire under way.
function Connection:Disconnect()
	if not self.Connected then
		return
	end

	self.Connected = false
	self._callback = nil

	-- Copied rather than edited in place: a fire under way keeps walking the list it started with.
	local signal = self._signal
	local connections = signal._connections
	local index = table.find(connections, self)
	if index ~= nil then
		local remaining = table.clone(connections)
		table.remove(remaining, index)
		signal._connections = remaining
	end
end

--- The name maids and janitors call.
Connection.Destroy = Connection.Disconnect

local Signal = {}
Signal.__index = Signal

function Signal:Connect(callback: (...any) -> ...any)
	local connection = setmetatable({
		Connected = true,
		_callback = callback,
		_signal = self,
	}, Connection)

	-- Newest first, copied so that a fire under way does not reach it.
	local connections = self._connections
	local updated = table.create(#connections + 1)
	updated[1] = connection
	table.move(connections, 1, #connections, 2, updated)
	self._connections = updated

	return connection
end

function Signal:Fire(...: any)
	for _, connection in self._connections do
		if connection.Connected then
			spawn(connection._callback, ...)
		end
	end
end

local function createSignal()
	return setmetatable({ _connections = {} }, Signal)
end

return {
	createSignal = createSignal,
	spawn = spawn,
}
