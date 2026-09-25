--!nolint
--[[
	A synchronous RBXScriptSignal stand-in.

	Firing delivers at once, the way a place with immediate signal behaviour does, which keeps the
	specs deterministic without a scheduler round-trip: Flamework's component tracker reacts to
	CollectionService signals and the specs assert immediately afterwards. The deferred behaviour is
	the Instance harness's `runDeferred`, which queues fires and hands them to `deliver`.

	What a handler sees is the engine's, measured in Studio under both signal behaviours
	(2026-09-25): the newest connection runs first; each handler runs on a thread of its own, so a
	yield does not hold up the call that fired the signal and an error is reported rather than raised
	out of it -- the other handlers still run, and the `AddTag`, the property write or the `Fire`
	that raised the signal returns normally; a connection made during a fire does not receive it, and
	one disconnected before its turn is skipped.

	The engine also caps re-entrancy, and prints an error where it refuses a call: under immediate
	behaviour a connection's handler runs at most 6 deep inside itself -- the 7th nested call is not
	made, while the signal's other connections still run -- and under deferred behaviour a chain of
	deferred work runs at most 80 deep (see `instance.luau`'s batch). Measured in Studio, 2026-09-25.
]]

local luneTask = require("@lune/task")

local signals = {}

export type Signal = any

--- Every error a handler raised, in order, the way it would have shown in the output.
local reported: { string } = {}

local function report(err: any)
	local message = tostring(err)
	table.insert(reported, message)
	print("[error]", message)
end

--- Warnings the engine prints itself, as opposed to a script's `warn`: printed, and kept for a probe.
local engineWarnings: { string } = {}

function signals.warn(message: string)
	table.insert(engineWarnings, message)
	print("[warn]", message)
end

function signals.engineWarnings(): { string }
	return table.clone(engineWarnings)
end

function signals.clearEngineWarnings()
	table.clear(engineWarnings)
end

--- How deep a connection's handler may run inside itself under immediate behaviour.
local MAX_NESTED_CALLS = 6

--- Reports a call the engine refused for re-entrancy, worded the way the engine words it.
function signals.refuse(connection: any, signalName: string?)
	local source, line, name = debug.info(connection._callback, "sln")
	report(
		`Maximum event re-entrancy depth exceeded for {signalName or "Signal"} when calling `
			.. `{if name ~= nil and name ~= "" then name else "anonymous function"} on line {line} in {source}`
	)
end

--[[
	A thread that runs `callback` the way the engine runs a handler or a deferred thread: an error
	it raises, before or after a yield, is reported -- as the engine prints it -- rather than raised
	to whoever resumed it. Caught inside the thread, so the error is the one raised rather than
	Lune's rendering of it.
]]
function signals.thread(callback: (...any) -> ()): thread
	return coroutine.create(function(...)
		local ok, err = pcall(callback, ...)
		if not ok then
			report(err)
		end
	end)
end

--- Starts a thread made by `signals.thread` (or any other), reporting what escapes it.
function signals.resume(thread: thread, ...: any)
	local ok, err = coroutine.resume(thread, ...)
	if not ok then
		report(err)
	end
end

--- Runs one handler on a thread of its own.
local function runHandler(callback: (...any) -> (), ...: any)
	signals.resume(signals.thread(callback), ...)
end

--[[
	Runs one connection's handler, unless it is already running 6 deep inside itself. Only calls
	still on the stack count: a handler that has yielded has handed control back, and is no longer
	nested in anything.
]]
local function runConnection(connection: any, signalName: string?, ...: any)
	local depth = connection._depth or 0
	if depth >= MAX_NESTED_CALLS then
		signals.refuse(connection, signalName)
		return
	end

	connection._depth = depth + 1
	if connection._copy then
		-- Each handler of a BindableEvent gets a copy of its own (see `instance.luau`).
		runHandler(connection._callback, connection._copy(...))
	else
		runHandler(connection._callback, ...)
	end
	connection._depth = depth
end

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
			-- A deferred fire already queued for this connection is dropped by this, but not by
			-- `DisconnectAll` (an instance being destroyed): see `signals.deliver`.
			connection._disconnectedByHand = true
		end,
	}

	-- Kept so that `DisconnectAll` can mark them as gone, which is what an instance being
	-- destroyed does to every connection on it.
	self._connectionObjects[id] = connection
	connection._callback = callback
	connection._copy = self._copy
	connection._id = id

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

--- The connections live right now, newest first, which is the order the engine runs them in.
function signals.snapshot(signal: Signal): { any }
	local list = {}
	for _, connection in signal._connectionObjects do
		table.insert(list, connection)
	end
	table.sort(list, function(a, b)
		return a._id > b._id
	end)
	return list
end

function Signal:Fire(...: any)
	-- Taken before any handler runs: one connected during the fire does not receive it, and one
	-- disconnected before its turn -- by a handler that ran ahead of it -- is skipped.
	for _, connection in signals.snapshot(self) do
		if connection.Connected then
			runConnection(connection, self._name, ...)
		end
	end
end

--[[
	Delivers a deferred fire to the connections that were live when it was raised.

	A connection made since does not receive it, and one disconnected by hand since is skipped; but
	one dropped by `DisconnectAll` still is not, because the engine delivers what it queued before
	an instance was destroyed to the handlers that were connected when it was queued (measured in
	Studio, deferred signal behaviour, 2026-09-25).
]]
function signals.deliver(connections: { any }, signalName: string?, ...: any)
	for _, connection in connections do
		if not connection._disconnectedByHand then
			runConnection(connection, signalName, ...)
		end
	end
end

--[[
	Drops every connection at once.

	The engine disconnects everything connected to an instance when it is destroyed, once its
	children have come apart, so nothing raised on it afterwards reaches a handler.
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

--- Reports an error the way the engine prints one from a thread it runs.
signals.report = report

--- Every error a handler raised since the last `clearErrors`, which the engine prints and a spec
--- can only assert on through this.
function signals.errors(): { string }
	return table.clone(reported)
end

function signals.clearErrors()
	table.clear(reported)
end

--- A signal; the name is the one the engine's re-entrancy error gives it (`Instance.ChildAdded`).
function signals.create(name: string?): Signal
	return setmetatable({ _connections = {}, _connectionObjects = {}, _nextId = 1, _name = name }, Signal)
end

return signals
