--!nolint
--[[
	Runs roblox-ts output under Lune.

	roblox-ts emits `local TS = _G[script]` plus `TS.import(script, base, ...parts)`, where `base`
	is an Instance. This harness models that Instance tree over the filesystem: every directory and
	`.luau` file becomes a node, `TS.import` resolves a node to a file and loads it with `script`
	bound in its environment, and the few Roblox globals Flamework touches are stubbed.

	It deliberately implements only what the compiled output actually uses -- `TS.import` and
	`TS.getModule` -- with the Roblox globals living in `roblox.luau`.

	`harness.create()` returns an independent module graph: its own module cache, globals and
	Promise implementation. The filesystem tree is shared between graphs because it describes the
	files on disk, not runtime state. Two graphs is what lets the replication runner hold a server
	and a client in one process.
]]

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")

local harness = {}

local ROOT = process.cwd

--- Maps a workspace package specifier onto its directory.
local PACKAGES: { [string]: string } = {
	["@flamework/core"] = "packages/core",
	["@flamework/components"] = "packages/components",
	["@flamework/networking"] = "packages/networking",
	["@flamework/testing"] = "packages/testing",
}

-- Instance tree ----------------------------------------------------------------------------------

export type Node = {
	Name: string,
	Parent: Node?,
	__path: string,
	__virtual: { [string]: any }?,
}

local nodeCache: { [string]: Node } = {}
local children: { [Node]: { [string]: Node } } = {}

--- Nodes whose module file is not derived from their path, taken from a package's `main` field.
local mainOverrides: { [any]: string } = {}

-- Lune's `fs` calls yield, and yielding inside `__index` crosses a C-call boundary. The tree is
-- therefore built eagerly when a node is created, leaving the metamethod a pure table lookup.
local nodeMeta = {}
nodeMeta.__index = function(node: Node, key: string)
	local map = children[node]
	return map and map[key] or nil
end
nodeMeta.__tostring = function(node: Node)
	return "Instance<" .. node.Name .. ">"
end

--- Directories that are never part of the emitted tree.
local SKIPPED: { [string]: boolean } = { [".git"] = true, [".nx"] = true, [".vscode"] = true }

--- How to walk a directory's children.
---
--- roblox-ts emits paths like `getModule(...).node_modules["@rbxts"].t.lib.ts`, so `node_modules`
--- has to be part of the tree. Walking it wholesale would be enormous (and `@flamework` entries are
--- symlinks back into the workspace, which would recurse), so only the `@rbxts` scope is followed.
type WalkMode = "normal" | "nodeModules" | "scope"

local function childMode(mode: WalkMode, entry: string): WalkMode?
	if mode == "normal" then
		return if entry == "node_modules" then "nodeModules" else "normal"
	elseif mode == "nodeModules" then
		return if entry == "@rbxts" then "scope" else nil
	else
		return "normal"
	end
end

local function stripExtension(name: string): string?
	return name:match("^(.+)%.luau$") or name:match("^(.+)%.lua$")
end

--- Registers `<base>/<relative>` as another name for an existing module file.
local function aliasModule(base: Node, directory: string, relative: string, targetPath: string)
	local segments = string.split(relative, "/")
	local name = table.remove(segments) :: string

	local parent: Node = base
	for _, segment in segments do
		local child = children[parent] and children[parent][segment]
		if not child then
			return
		end
		parent = child
	end

	if children[parent][name] then
		return
	end

	local alias = setmetatable({
		Name = name,
		Parent = parent,
		__path = directory .. "/" .. relative,
	}, nodeMeta) :: any

	children[alias] = {}
	children[parent][name] = alias
	mainOverrides[alias] = targetPath
end

--- Applies a package's `main`/`types` fields to its node.
local function applyPackageManifest(node: Node, directory: string)
	local manifestPath = directory .. "/package.json"
	if not fs.isFile(manifestPath) then
		return
	end

	local manifest = fs.readFile(manifestPath)
	local main = string.match(manifest, '"main"%s*:%s*"([^"]+)"')
	if not main then
		return
	end

	-- roblox-ts packages point `main` at the module that becomes the ModuleScript, which is not
	-- always `init.lua` (`@rbxts/maid` uses `Maid.lua`).
	local mainBase = (main:gsub("%.luau?$", ""))
	local mainPath = directory .. "/" .. mainBase
	mainOverrides[node] = mainPath

	-- When a package is reached through another package's `node_modules`, roblox-ts derives the
	-- import path from `types` rather than `main`, so `@rbxts/t` is emitted as `lib.t` (from
	-- `lib/t.d.ts`) while the module actually lives at `lib/ts.lua`. Alias the two spellings.
	local types = string.match(manifest, '"types"%s*:%s*"([^"]+)"')
	local typesBase = types and types:match("^(.+)%.d%.ts$")
	if typesBase and typesBase ~= mainBase then
		aliasModule(node, directory, typesBase, mainPath)
	end
end

--- Creates (or returns) the node for a filesystem path, if anything exists there.
function harness.node(path: string, name: string?, parent: Node?, mode: WalkMode?): Node?
	local walkMode: WalkMode = mode or "normal"

	local cached = nodeCache[path]
	if cached then
		return cached
	end

	local isDir = fs.isDir(path)
	if not isDir and not fs.isFile(path .. ".luau") and not fs.isFile(path .. ".lua") then
		return nil
	end

	local node: Node = setmetatable({
		Name = name or path,
		Parent = parent,
		__path = path,
	}, nodeMeta) :: any

	nodeCache[path] = node
	children[node] = {}

	if isDir then
		for _, entry in fs.readDir(path) do
			if SKIPPED[entry] then
				continue
			end

			local childPath = path .. "/" .. entry
			if fs.isDir(childPath) then
				local nextMode = childMode(walkMode, entry)
				if not nextMode then
					continue
				end

				harness.node(childPath, entry, node, nextMode)
				children[node][entry] = nodeCache[childPath]
			else
				local base = stripExtension(entry)
				-- `init.luau` is the directory's own module, not a child of it.
				if base and base ~= "init" and children[node][base] == nil then
					harness.node(childPath:sub(1, #childPath - (#entry - #base)), base, node)
					children[node][base] = nodeCache[path .. "/" .. base]
				end
			end
		end

		applyPackageManifest(node, path)
	end

	return node
end

--- A node that is not backed by the filesystem; importing it yields `exports` directly.
function harness.virtualNode(name: string, exports: { [string]: any }): Node
	local node = setmetatable({
		Name = name,
		Parent = nil,
		__path = "\0virtual\0" .. name,
		__virtual = exports,
	}, nodeMeta) :: any

	children[node] = {}
	return node
end

local function resolveFile(path: string): string?
	if fs.isFile(path .. ".luau") then
		return path .. ".luau"
	elseif fs.isFile(path .. ".lua") then
		return path .. ".lua"
	elseif fs.isDir(path) then
		if fs.isFile(path .. "/init.luau") then
			return path .. "/init.luau"
		elseif fs.isFile(path .. "/init.lua") then
			return path .. "/init.lua"
		end
	end

	return nil
end

--- Where to look for `@rbxts/*` packages, in order.
local NODE_MODULES_ROOTS = {
	"packages/components/node_modules",
	"packages/core/node_modules",
	"packages/networking/node_modules",
	"packages/testing/node_modules",
	"node_modules",
}

local function resolveExternalPackage(scope: string, name: string): Node?
	for _, root in NODE_MODULES_ROOTS do
		local directory = ROOT .. "/" .. root .. "/" .. scope .. "/" .. name
		if fs.isDir(directory) then
			local node = harness.node(directory, name, nil)
			if node then
				return node
			end
		end
	end

	return nil
end

-- Module graphs ----------------------------------------------------------------------------------

--- Creates an independent module graph: its own module cache, globals and Promise.
function harness.create()
	local context = {}

	local loaded: { [string]: any } = {}
	local globals: { [string]: any } = {}
	local TS = {}

	context.globals = globals
	context.TS = TS
	context.virtualPackages = {} :: { [string]: Node }

	--- roblox-ts's own Promise implementation, loaded from the compiler package so the specs use
	--- exactly the Promise the emitted code expects.
	---
	--- Not loaded when the graph is created: Promise.lua calls `game:GetService` at module scope,
	--- so `context.loadPromise` has to be called once the globals are in place. Reading the file
	--- yields, and the first access would otherwise happen inside a metamethod, where it cannot.
	local promiseCache: any = nil

	local function getPromise(): any
		if promiseCache then
			return promiseCache
		end

		local promisePath = ROOT .. "/node_modules/roblox-ts/include/Promise.lua"
		if not fs.isFile(promisePath) then
			error("harness: roblox-ts's Promise.lua was not found; run `bun install` first", 0)
		end

		local environment = {}
		for key, value in globals do
			environment[key] = value
		end

		promiseCache = luau.load(fs.readFile(promisePath), {
			debugName = promisePath,
			environment = environment,
		})()

		TS.Promise = promiseCache
		return promiseCache
	end

	--- Loads the Promise implementation, which the globals have to be installed for.
	function context.loadPromise()
		getPromise()
	end

	--- Mirrors `RuntimeLib.async`: run the callback on its own coroutine and settle a Promise with
	--- the result.
	function TS.async(callback: (...any) -> any)
		return function(...)
			local n = select("#", ...)
			local args = { ... }

			return getPromise().new(function(resolve, reject)
				coroutine.wrap(function()
					local ok, result = pcall(callback, table.unpack(args, 1, n))
					if ok then
						resolve(result)
					else
						reject(result)
					end
				end)()
			end)
		end
	end

	function TS.await(promise: any)
		local Promise = getPromise()
		if not Promise.is(promise) then
			return promise
		end

		local status, value = promise:awaitStatus()
		if status == Promise.Status.Resolved then
			return value
		elseif status == Promise.Status.Rejected then
			error(value, 2)
		end

		error("The awaited Promise was cancelled", 2)
	end

	local function loadModule(node: Node?): any
		if not node then
			error("harness: attempted to import a nil module", 0)
		end

		if node.__virtual then
			return node.__virtual
		end

		local file = resolveFile(node.__path)
		if not file and mainOverrides[node] then
			file = resolveFile(mainOverrides[node])
		end

		if not file then
			error("harness: no module at '" .. node.__path .. "'", 0)
		end

		if loaded[file] ~= nil then
			return loaded[file]
		end

		-- Reserve the slot before evaluating so that a cyclic import sees a partial module rather
		-- than recursing forever, which is what Roblox's own require does.
		loaded[file] = false

		local environment = { script = node }
		for key, value in globals do
			environment[key] = value
		end

		-- The emitted code captures `_G[script]` into a file-level local as it loads, so setting
		-- this per graph immediately before loading is enough for two graphs to share the tree.
		_G[node] = TS

		local chunk = luau.load(fs.readFile(file), {
			debugName = file,
			environment = environment,
		})

		local result = chunk()
		loaded[file] = result

		return result
	end

	--- `TS.import(caller, base, ...parts)` -- resolve `base` plus `parts` and load it.
	function TS.import(_caller: Node, base: Node?, ...: string): any
		if not base then
			error("harness: TS.import was given a nil base", 0)
		end

		local node = base
		for _, part in { ... } do
			local child = (node :: any)[part]
			if not child then
				error("harness: could not resolve '" .. part .. "' under '" .. node.__path .. "'", 0)
			end
			node = child
		end

		return loadModule(node)
	end

	--- `TS.getModule(script, scope, name)` -- resolve a package to its directory node.
	function TS.getModule(_caller: Node, scope: string, name: string): Node
		local specifier = scope .. "/" .. name

		local virtual = context.virtualPackages[specifier]
		if virtual then
			return virtual
		end

		local directory = PACKAGES[specifier]
		if directory then
			local node = harness.node(ROOT .. "/" .. directory, name, nil)
			if not node then
				error("harness: package '" .. specifier .. "' is not built (missing " .. directory .. ")", 0)
			end
			return node
		end

		local external = resolveExternalPackage(scope, name)
		if external then
			return external
		end

		error("harness: could not resolve package '" .. specifier .. "'", 0)
	end

	function context.setGlobal(name: string, value: any)
		globals[name] = value
	end

	function context.require(specifier: string, ...: string): any
		local scope, name = specifier:match("^([^/]+)/(.+)$")
		return TS.import(nil :: any, TS.getModule(nil :: any, scope :: any, name :: any), ...)
	end

	return context
end

function harness.root(): string
	return ROOT
end

return harness
