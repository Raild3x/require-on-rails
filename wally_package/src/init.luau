--!strict
-- Author: Logan Hunt (Roblox: Raildex) (GitHub: raild3x)
--[=[
	RequireOnRails - Contextual Module Import System

	Provides contextual `require` with string path resolution relative to
	configured ancestor instances.  Supports absolute paths
	(`@AncestorKey/path/to/Module`), ambiguous single-name paths (`@ModuleName`),
	and direct Instance references.

	If you don't prefix your passed path with '@', it will fall back to the default 
	`require` behavior, allowing you to import modules using their full paths as 
	strings or directly using Instance references.

	This module is intended to be used in conjunction with the 
	[RequireOnRails](https://github.com/Raild3x/require-on-rails) VSCode extension,
	which provides automatic alias generation for LuauLSP linting.

	Basic setup:

	```lua
	local RequireOnRails = require(path.to.RequireOnRails)

	-- Setup the import generator
	local GenerateRequire = RequireOnRails.create({
		Ancestors = {
			["Server"] = ServerScriptService.src.Server,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
		},
		-- Optional configuration
		Debug = true,
		IgnorePredicate = function(instance)
			return instance.Name:match("^_") -- Ignore files/folders starting with a _
		end
	})

	return GenerateRequire
	```

	Per-module usage:

	```lua
	-- Generate a contextual import/require for this specific module
	local GenerateRequire = require(path.To.GeneratorModule)
	require = GenerateRequire(script)

	-- Import using absolute paths (unambiguous)
	local Types = require("@Shared/Types")
	local PlayerService = require("@Server/Services/PlayerService")

	-- Import using ambiguous paths (searches from current context; down and then up (BFS))
	-- This will search for the nearest module named "Config".
	local Config = require("@Config")
	```

	```info
	Due to a bug in luau, requiring the GeneratorModule and setting it to overwrite `require` in the same line can cause type inference issues.
	To avoid this, require the GeneratorModule in a separate line and then call it to generate the `require` function as shown in the example above.
	```
]=]

local Types  = require(script.Types)
local Search = require(script.Search)

-- Re-export public types
export type Config = Types.Config
export type ContextualImportGenerator = (Instance) -> typeof(require)

type ModuleCache  = Types.ModuleCache
type ContextCache = Types.ContextCache

local RESERVED_ALIASES = { "self", "game" }


--[=[
	Prints debug information to the output when `enabled` is true.
]=]
local function debugLog(enabled: boolean, ...: any): ()
	if enabled then print("[RequireOnRails DEBUG]", ...) end
end

--[=[
	Resolves path aliases defined in `Config.Aliases`.
	For example: if `Aliases = { Svc = "Server/Services" }` then
	`@Svc/Foo` resolves to `@Server/Services/Foo`.

	@param path    -- The original `@`-prefixed path
	@param aliases -- Optional alias map from Config
	@return string -- Resolved path (unchanged if no alias matches)
]=]
local function resolveAlias(path: string, aliases: { [string]: string }?): string
	if not aliases then return path end
	local pathWithoutPrefix = path:sub(2)
	local firstSegment = pathWithoutPrefix:split("/")[1]
	if aliases[firstSegment] then
		return "@" .. aliases[firstSegment] .. pathWithoutPrefix:sub(#firstSegment + 1)
	end
	return path
end

---------------------------------------------------------------------------------------
-- MAIN IMPORT GENERATOR
---------------------------------------------------------------------------------------

--[=[
	Creates a contextual import generator bound to the provided configuration.
	Returns a function that, when called with a context `Instance` (typically
	`script`), produces a `Require` function scoped to that context.

	@param _config -- RequireOnRails Config table
	@return ContextualImportGenerator
]=]
local function CreateImportGenerator(_config: Config): ContextualImportGenerator
	local config        = _config or {} :: Config
	local validAncestors = config.Ancestors
	local ancestorsArray: { Instance } = {}
	local debug          = config.Debug or false
	local circularDetect = config.CircularDependencyDetection ~= false
	local disableCache   = config.DisableCache == true

	assert(typeof(validAncestors) == "table", "Ancestors must be a table")
	for key, ancestor in validAncestors do
		assert(not table.find(RESERVED_ALIASES, key), `Ancestor key "{key}" is reserved by Roblox and cannot be used`)
		table.insert(ancestorsArray, ancestor)
	end

	debugLog(debug, "Initialized with", #ancestorsArray, "ancestors")

	local unambiguousCache: ModuleCache = {}
	local contextCache: ContextCache    = {}
	local currentlyRequiring: { [ModuleScript]: boolean } = {}
	local requireStack: { ModuleScript } = {}

	--[=[
		Builds a formatted error message showing the full require chain that
		led to the circular dependency.
	]=]
	local function createCircularDependencyError(target: ModuleScript): string
		local lines = {}
		for i, m in requireStack do
			table.insert(lines, `  {i}. {m:GetFullName()}`)
		end
		table.insert(lines, `  {#requireStack + 1}. {target:GetFullName()} <- CIRCULAR`)
		return `Circular dependency detected!\nRequire chain:\n{table.concat(lines, "\n")}`
	end

	--[=[
		Requires a ModuleScript with optional circular dependency detection.
		Pushes the module onto `requireStack` for the duration of the call so
		that error messages can show the full chain.
	]=]
	local function requireModule(module: ModuleScript): any
		if circularDetect and currentlyRequiring[module] then
			error(createCircularDependencyError(module))
		end
		table.insert(requireStack, module)
		currentlyRequiring[module] = true
		local result = require(module) :: any
		currentlyRequiring[module] = nil
		table.remove(requireStack)
		return result
	end

	--[=[
		Returns the `ModuleCache` for `context`, creating and registering one if needed.
		Connects an `AncestryChanged` listener to flush the cache when the
		context is removed from the data model.
	]=]
	local function getCacheForContext(context: Instance): ModuleCache
		if contextCache[context] then return contextCache[context] end
		local newCache: ModuleCache = {}
		contextCache[context] = newCache
		context.AncestryChanged:Connect(function()
			debugLog(debug, "Cache cleared for", context.Name)
			for k in newCache do newCache[k] = nil end
		end)
		return newCache
	end

	--[=[
		Walks `segments` from `startInst`, moving into named children or climbing
		one level with `..`.  Respects `CaseSensitive` config.  Errors with a
		descriptive message if any segment cannot be resolved.

		@param startInst -- Instance to begin traversal from
		@param segments  -- Ordered path segments (may include "..")
		@param pathStr   -- Original path string used in error messages
		@return Instance
	]=]
	local function traverseSegments(startInst: Instance, segments: { string }, pathStr: string): Instance
		local inst = startInst
		for _, segment in segments do
			if segment == ".." then
				local p = inst.Parent
				if not p then
					error(`Module "{pathStr}" not found: ".." traverses above the DataModel root`)
				end
				inst = p
			else
				local next = inst:FindFirstChild(segment)
				if not next and config.CaseSensitive == false then
					local lower = segment:lower()
					for _, child in inst:GetChildren() do
						if child.Name:lower() == lower then
							next = child
							break
						end
					end
				end
				if not next then
					error(`Module "{pathStr}" not found: "{segment}" does not exist in "{inst:GetFullName()}".`)
				end
				inst = next :: Instance
			end
		end
		return inst
	end

	--[=[
		Produces a `Require` function scoped to the given `root` instance.
		`root` is used as the local context for ambiguous path resolution and
		per-context caching.

		@param root -- The module's own `script` instance
		@return     -- A `Require` function scoped to `root`
	]=]
	local function generateImport(root: Instance): typeof(require)
		assert(root:IsA("Instance"), "Root must be a valid Instance")
		local cache = getCacheForContext(root)

		-- Walk up to find the closest registered ancestor
		local primaryRoot: Instance? = nil
		local parent = root.Parent
		while parent do
			if table.find(ancestorsArray, parent) then
				primaryRoot = parent
				break
			end
			parent = parent.Parent
		end

		if not primaryRoot and debug then
			warn(`[RequireOnRails] No primary ancestor found for {root:GetFullName()}.`)
		end
		debugLog(debug, "generateImport:", root:GetFullName(), "primary:", primaryRoot and primaryRoot.Name or "none")

		--[=[
			Resolves and requires `target`.
			- **Instance** — requires the ModuleScript directly.
			- **Non-`@` string** — falls through to native `require`.
			- **`@AncestorKey/...`** — absolute traversal from a registered ancestor;
			  subsequent segments may include `..` to climb above the anchor.
			- **`@Name/...`** — ambiguous BFS search for `Name`, then traversal of
			  any remaining segments (including `..`) from the found instance.
			- **`@Name`** — ambiguous BFS search, result is the found module.

			Results are cached globally for absolute paths and per-context for
			ambiguous paths (since the found instance depends on call-site context).
		]=]
		local function Require(target: string | Instance): any
			-- Direct Instance reference
			if typeof(target) == "Instance" then
				assert(target:IsA("ModuleScript"), "Target must be a ModuleScript instance")
				return requireModule(target)
			end

			assert(typeof(target) == "string", "Target must be a string or Instance")

			-- Non-RoR strings fall through to native require
			-- Roblox built-in @-aliases (@self, @game) are also passed through.
			for _, alias in ipairs(RESERVED_ALIASES) do
				if target:match("^@" .. alias.."/") then
					return require(target) :: any
				end
			end
			if not target:match("^@") then
				return require(target) :: any
			end

			local resolvedTarget = resolveAlias(target, config.Aliases)
			debugLog(debug, "Resolving:", target, "->", resolvedTarget)

			-- Context-local cache hit
			if not disableCache and cache[resolvedTarget] then
				return requireModule(cache[resolvedTarget])
			end

			-- Global unambiguous cache hit
			if not disableCache and unambiguousCache[resolvedTarget] then
				return requireModule(unambiguousCache[resolvedTarget])
			end

			local pathParts = string.split(resolvedTarget:sub(2), "/")
			local firstSeg  = pathParts[1]

			-- "." as the first segment is always invalid
			assert(firstSeg ~= "..", `"{resolvedTarget}" is not a valid path: ".." cannot be the first segment. Use an ancestor key or a module name.`)

			-- ── Absolute path: @AncestorKey/rest/of/path ─────────────────
			-- The first segment is a registered ancestor key.  The remaining
			-- segments are traversed from the anchor, including any "..".
			local targetRoot = validAncestors[firstSeg]

			if targetRoot then
				local inst = traverseSegments(targetRoot, { table.unpack(pathParts, 2) }, resolvedTarget)
				assert(inst:IsA("ModuleScript"), `"{resolvedTarget}" is not a ModuleScript`)
				local module = inst :: ModuleScript

				if not disableCache then
					unambiguousCache[resolvedTarget] = module
					module.AncestryChanged:Once(function()
						unambiguousCache[resolvedTarget] = nil
					end)
				end

				return requireModule(module)
			end

			-- ── Ambiguous path: @ModuleName/optional/further/segments ────
			-- Search for the first segment as a module name, then traverse
			-- any remaining segments (which may include "..") from it.
			-- Result is context-dependent so it lives in the per-context cache.
			if not primaryRoot then
				error(`Cannot resolve "{resolvedTarget}": no valid ancestor found for context`)
			end

			local found = Search.searchForModule(root, firstSeg, ancestorsArray, config)
			if not found then
				local others = table.clone(ancestorsArray)
				local idx = table.find(others, primaryRoot)
				if idx then table.remove(others, idx) end
				found = Search.searchRoots(others, { firstSeg }, config)
			end

			if not found then
				error(`Module "{resolvedTarget}" not found in any valid ancestor.`)
			end

			-- Traverse any additional segments (e.g. ".." or further children)
			-- starting from the resolved module instance.
			local inst = traverseSegments(found, { table.unpack(pathParts, 2) }, resolvedTarget)
			assert(inst:IsA("ModuleScript"), `"{resolvedTarget}" is not a ModuleScript`)
			local module = inst :: ModuleScript

			if not disableCache then
				cache[resolvedTarget] = module
				module.AncestryChanged:Once(function()
					cache[resolvedTarget] = nil
				end)
			end

			return requireModule(module)
		end

		return Require
	end

	return generateImport
end

return {
	create = CreateImportGenerator,
}

