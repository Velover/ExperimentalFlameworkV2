--[[
	The receive pipeline: what runs between a remote delivering a message (or `predict` standing in
	for one) and the handler that receives it.

	Plain calls in the thread that received the message: the payload is decoded, the generated guards
	check the arguments, each middleware calls the next through `processNext`, and the last step
	delivers (an event's signal, a function's callback). Nothing here makes a Promise or a thread. A
	middleware may still yield, which holds up only the message it is processing, and one that
	returns a Promise is waited for in place.

	Plain Luau rather than TypeScript so that an argument list keeps its count: roblox-ts builds a
	table from every `...args` and spreads it with `unpack`, which stops at `#list` and may lose the
	values after a nil (see `util/trimArguments.ts`). Here the list travels as varargs, and is only cut
	after its last value where it enters and where a middleware hands on a list of its own.
]]

local TS = _G[script]

--- Stands in for a missing blob list when decoding: a sender whose type has blob slots always sends one.
local NO_BLOBS = {}

--[[
	`callback(player, ...)`, with the argument list cut after its last value.

	A list that ends in nil would reach a TypeScript `(...args)` as a table whose `#` can stop at any
	earlier gap: `{1, nil, 3, nil}` may read as one value. One that ends in a value spreads whole. A
	middleware that names its parameters, `(player, id, name) => processNext(player, id, name)`,
	passes on a list ending in nil when `name` was not sent, which is why every link cuts it again.
	Nothing is lost: an argument that was not passed reads as nil too.
]]
local function callTrimmed(callback: (...any) -> ...any, player: any, ...: any): any
	local count = select("#", ...)
	if count == 0 or select(count, ...) ~= nil then
		return callback(player, ...)
	end

	repeat
		count -= 1
	until count == 0 or select(count, ...) ~= nil

	return callback(player, table.unpack({ ... }, 1, count))
end

--[[
	A link's result, with a Promise it returned followed in this thread: its value once resolved,
	`cancelled` if it was cancelled, and its rejection raised.
]]
local function follow(value: any, cancelled: any): any
	if type(value) ~= "table" then
		return value
	end

	local Promise = TS.Promise
	if not Promise.is(value) then
		return value
	end

	local status, result = value:awaitStatus()
	if status == Promise.Status.Resolved then
		return result
	elseif status == Promise.Status.Cancelled then
		return cancelled
	end

	error(result, 0)
end

--[[
	Folds the guards and the middleware into one function, `(player, ...args) -> result`, that runs
	them in order in the calling thread and returns what the last one did.

	`middleware` is a list of factories, the first the outermost; each is handed `processNext`, which
	calls the next link and returns its result (a Promise the link returned already followed). A link
	that does not call it drops the message there. `final` ends the chain.

	`guards`, when given, check the arguments before any middleware runs: `fixed[i]` checks argument
	`i`, `rest` every one past them. The first one that fails is reported through `reject` with its
	0-based index, and the processor returns `rejected` without calling anything else.

	`cancelled` is what a Promise that was cancelled reads as (`Networking.Skip` for a function).
]]
local function createProcessor(
	middleware: { (processNext: any, networkInfo: any) -> any }?,
	networkInfo: any,
	final: (...any) -> ...any,
	guards: any,
	rejected: any,
	cancelled: any
)
	local head = final
	if middleware ~= nil then
		for index = #middleware, 1, -1 do
			local after = head
			head = middleware[index](function(player, ...)
				return follow(callTrimmed(after, player, ...), cancelled)
			end, networkInfo)
		end
	end

	if guards == nil then
		return function(player, ...)
			return follow(callTrimmed(head, player, ...), cancelled)
		end
	end

	local fixed = guards.fixed
	local rest = guards.rest
	local reject = guards.reject
	local fixedCount = #fixed

	return function(player, ...)
		-- Checked up to the last value: a trailing nil is an argument that was not passed.
		local count = select("#", ...)
		while count > 0 and select(count, ...) == nil do
			count -= 1
		end

		for index = 1, math.max(fixedCount, count) do
			local guard = fixed[index] or rest
			if guard ~= nil then
				local value = select(index, ...)
				if not guard(value) then
					reject(player, index - 1, value)
					return rejected
				end
			end
		end

		return follow(callTrimmed(head, player, ...), cancelled)
	end
end

--[[
	Unpacks a serialized argument list, `(payload, blobs?)` as the remote carried it. Returns `true`
	and the list, or `false` and why it could not be read. The decoder runs under `pcall`: a hostile
	buffer raises instead of yielding garbage.
]]
local function decode(decoder: (buffer, { any }) -> { any }, payload: any, blobs: any): (boolean, any)
	if type(payload) ~= "buffer" or (blobs ~= nil and type(blobs) ~= "table") then
		return false, "payload is not a buffer with an optional blob list"
	end

	local ok, result = pcall(decoder, payload, blobs or NO_BLOBS)
	if not ok then
		return false, tostring(result)
	end

	return true, result
end

--[[
	The handler to connect to a remote's `OnServerEvent` (`withPlayer`) or `OnClientEvent`: decodes
	the payload when there is a `decoder`, reporting one it cannot read through `onMalformed` and
	dropping it, and hands the arguments to `process`, in the thread the engine runs the handler on.
]]
local function createReceiver(
	decoder: ((buffer, { any }) -> { any })?,
	onMalformed: ((player: any, message: string) -> ())?,
	process: (...any) -> ...any,
	withPlayer: boolean
)
	local receive = process
	if decoder ~= nil then
		receive = function(player, payload, blobs)
			local ok, result = decode(decoder, payload, blobs)
			if not ok then
				if onMalformed ~= nil then
					onMalformed(player, result)
				end
				return
			end

			-- A decoded list has a slot per declared parameter, so an absent trailing optional leaves
			-- it ending in nil: unpacked up to its last value.
			return process(player, table.unpack(result, 1, table.maxn(result)))
		end
	end

	if withPlayer then
		return receive
	end

	return function(...)
		return receive(nil, ...)
	end
end

--- The last step of an event's chain: fires `signal`, with the sender first on the server.
local function deliverTo(signal: any, withPlayer: boolean)
	if withPlayer then
		return function(player, ...)
			signal:Fire(player, ...)
		end
	end

	return function(_player, ...)
		signal:Fire(...)
	end
end

--- `callback` called without the player in front, which is how a client's callback is written.
local function withoutPlayer(callback: (...any) -> ...any)
	return function(_player, ...)
		return callback(...)
	end
end

return {
	createProcessor = createProcessor,
	createReceiver = createReceiver,
	decode = decode,
	deliverTo = deliverTo,
	withoutPlayer = withoutPlayer,
}
