-- Loads emitted files the way Roblox does, for luauLimits.test.ts. roblox-ts does not check Luau's
-- limits on a function (200 locals, 255 registers), so a file past them builds and only fails here.
--
--   lune run luauLoad.luau load <file...>            prints "LOADS <file>" or "FAILS <file>: <error>"
--   lune run luauLoad.luau strings <file> <count>     round-trips <count> string fields through `s`
--   lune run luauLoad.luau nested <file> <outer> <inner>
--                                                     round-trips <outer> objects of <inner> strings
--   lune run luauLoad.luau booleans <file> <count>    round-trips a string field, then <count> booleans
--   lune run luauLoad.luau exports <file>             runs a module whose remotes reply with what they
--                                                     were sent, and prints "EXPORT <name>=<value>"
--                                                     for each plain value it exports
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")

local args = process.args
local mode = args[1]

local function compile(path: string)
	return luau.compile(fs.readFile(path), { optimizationLevel = 1 })
end

if mode == "load" then
	for index = 2, #args do
		local path = args[index]
		local ok, err = pcall(function()
			luau.load(compile(path), { debugName = path })
		end)
		print(if ok then `LOADS {path}` else `FAILS {path}: {string.match(tostring(err), "^[^\n]*")}`)
	end
	return
end

-- A serializer module, run with the runtime library replaced by what its code needs of it.
local function module(path: string)
	local source = fs.readFile(path)
	source = string.gsub(source, "local TS = require%b()\n", "")
	source = string.gsub(
		source,
		"local Flamework = TS%.import%b()%.Flamework\n",
		"local Flamework = { createSerializer = function(x) return x end }\n"
	)
	return luau.load(luau.compile(source, { optimizationLevel = 1 }), { debugName = path })()
end

local function fail(message: string)
	print(`FAILS {message}`)
	process.exit(1)
end

if mode == "exports" then
	-- A remote's member: a function invoked replies with the string it was sent (its length is one
	-- byte below 128), so that the module's exports show which call each came from.
	local function remotes()
		return setmetatable({}, {
			__index = function()
				return {
					_invoke = function(_, buf)
						return buffer.readstring(buf, 1, buffer.len(buf) - 1)
					end,
					_fire = function() end,
					_setCallback = function() end,
				}
			end,
		})
	end
	local function create()
		return { createClient = remotes, createServer = remotes }
	end
	local imported = {
		Networking = { createEvent = create, createFunction = create },
		t = setmetatable({}, {
			__index = function()
				return function()
					return true
				end
			end,
		}),
	}
	local path = args[2]
	local source = string.gsub(fs.readFile(path), "local TS = require%b()\n", "")
	local environment = setmetatable({
		TS = { import = function() return imported end },
		script = { Parent = { Parent = {} } },
	}, { __index = _G })
	local bytecode = luau.compile(source, { optimizationLevel = 1 })
	local exports = luau.load(bytecode, { debugName = path, environment = environment, injectGlobals = true })()
	local names = {}
	for name, value in exports do
		if type(value) ~= "table" and type(value) ~= "function" then
			table.insert(names, name)
		end
	end
	table.sort(names)
	for _, name in names do
		print(`EXPORT {name}={exports[name]}`)
	end
	return
end

local function same(a: any, b: any): boolean
	if type(a) ~= "table" or type(b) ~= "table" then
		return a == b
	end
	for key, value in a do
		if not same(value, b[key]) then
			return false
		end
	end
	for key in b do
		if a[key] == nil then
			return false
		end
	end
	return true
end

-- A string's bytes as the serializer writes it: its length as a varint (one byte below 128), then itself.
local function written(text: string)
	return string.char(#text) .. text
end

local path = args[2]
local serializer = module(path).s
local value, expected = {}, {}
if mode == "strings" then
	for index = 0, tonumber(args[3]) - 1 do
		value[`f{index}`] = `value {index}`
		table.insert(expected, written(`value {index}`))
	end
elseif mode == "nested" then
	for outer = 0, tonumber(args[3]) - 1 do
		local inner = {}
		for index = 0, tonumber(args[4]) - 1 do
			inner[`g{outer}_{index}`] = `{outer}.{index}`
			table.insert(expected, written(`{outer}.{index}`))
		end
		value[`f{outer}`] = inner
	end
elseif mode == "booleans" then
	value.s = "text"
	table.insert(expected, written("text"))
	for index = 0, tonumber(args[3]) - 1 do
		value[`b{index}`] = index % 3 == 0
		table.insert(expected, string.char(if index % 3 == 0 then 1 else 0))
	end
else
	fail(`unknown mode {mode}`)
end

local bytes = serializer.serialize(value)
if buffer.tostring(bytes) ~= table.concat(expected) then
	fail(`{path}: the bytes differ from each field written in order`)
end
if not same(serializer.deserialize(bytes), value) then
	fail(`{path}: the value read back differs from the one written`)
end
print(`ROUNDTRIPS {path}`)
