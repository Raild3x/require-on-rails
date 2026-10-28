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

	-- Import using ambiguous paths. With the default SearchMode "Nearest" this
	-- finds the module named "Config" with the fewest tree steps from this script.
	local Config = require("@Config")
	```

	```info
	Due to a bug in Luau, requiring the GeneratorModule and setting it to overwrite `require` in the same line can cause type inference issues.
	To avoid this, require the GeneratorModule in a separate line and then call it to generate the `require` function as shown in the example above.
	```
]=]

local Types  = require(script.Types)
local Search = require(script.Search)

-- Re-export public types
export type Config = Types.Config
export type ContextualImportGenerator = (Instance) -> typeof(require)

type ModuleCache = Types.ModuleCache

local RESERVED_ALIASES = { "self", "game" }
local SEARCH_MODES     = { "Nearest", "Unique" }


--[=[
	Prints debug information to the output when `enabled` is true.
]=]
local function debugLog(enabled: boolean, ...: any): ()
	if enabled then print("[RequireOnRails DEBUG]", ...) end
end

--[=[
	Expands the first path segment when it matches an entry in `aliases`.
	For example: if `aliases = { R = "Root" }` then `@R/Foo` becomes `@Root/Foo`.
	Alias values may include a sub-path prefix: `{ Svc = "Root/Services" }` makes
	`@Svc/Foo` resolve to `@Root/Services/Foo`.

	@param path    -- The original `@`-prefixed path
	@param aliases -- String-keyed alias map produced by `CreateImportGenerator`
	               -- after validating merged alias configuration
	@return string -- Resolved path (unchanged if no alias matches)
]=]
local function resolveAlias(path: string, aliases: { [string]: string }): string
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
	local config       = _config or {} :: Config
	local debug        = config.Debug or false
	local disableCache = config.DisableCache == true
	local searchMode   = config.SearchMode or "Nearest"

	assert(
		table.find(SEARCH_MODES, searchMode),
		`RequireOnRails: 'SearchMode' must be "Nearest" or "Unique", got {searchMode}`
	)
	if config.PathPriority ~= nil then
		assert(typeof(config.PathPriority) == "table", "RequireOnRails: 'PathPriority' must be an array of Instances")
		for _, entry in config.PathPriority do
			assert(typeof(entry) == "Instance", "RequireOnRails: 'PathPriority' must be an array of Instances")
		end
	end

	-- Build the merged alias table. config.Aliases is the primary field; config.Ancestors
	-- is accepted for backwards compatibility and is merged in (Aliases takes precedence).
	assert(
		typeof(config.Aliases) == "table" or typeof(config.Ancestors) == "table",
		"RequireOnRails: 'Aliases' must be a table (or provide the deprecated 'Ancestors' table)"
	)
	if config.Aliases ~= nil then
		assert(typeof(config.Aliases) == "table", "RequireOnRails: 'Aliases' must be a table")
	end
	if config.Ancestors ~= nil then
		assert(typeof(config.Ancestors) == "table", "RequireOnRails: 'Ancestors' must be a table")
	end
	
	local rawAliases: { [string]: Instance | string }
	if config.Aliases and config.Ancestors then
		rawAliases = table.clone(config.Aliases)
		for k, v in config.Ancestors do
			if rawAliases[k] == nil then rawAliases[k] = v end
		end
	elseif config.Aliases then
		rawAliases = config.Aliases
	else
		rawAliases = config.Ancestors :: { [string]: Instance | string }
	end

	local validAncestors: { [string]: Instance } = {}
	local aliasMap: { [string]: string } = {}
	local ancestorsArray: { Instance } = {}

	-- First pass: separate Instance entries (ancestor roots) from string entries (aliases).
	for key, value in rawAliases do
		assert(
			typeof(key) == "string" and key ~= "",
			"RequireOnRails: alias table keys must be non-empty strings"
		)
		assert(not table.find(RESERVED_ALIASES, key), `Alias key "{key}" is reserved by Roblox and cannot be used`)
		if typeof(value) == "Instance" then
			validAncestors[key] = value
			table.insert(ancestorsArray, value)
		elseif typeof(value) == "string" then
			aliasMap[key] = value
		else
			error(`Aliases entry "{key}" must be an Instance or a string alias, got {typeof(value)}`)
		end
	end

	-- Second pass: validate that each string alias's root key resolves to a real ancestor.
	for aliasKey, aliasValue in aliasMap do
		local targetKey = aliasValue:split("/")[1]
		assert(
			validAncestors[targetKey] ~= nil,
			`Alias "{aliasKey}" points to "{aliasValue}" but "{targetKey}" is not a registered ancestor key`
		)
	end

	debugLog(debug, "Initialized with", #ancestorsArray, "ancestors and", (function()
		local n = 0; for _ in aliasMap do n += 1 end; return n
	end)(), "string aliases")

	local unambiguousCache: ModuleCache = {}
	local searcher = Search.new(ancestorsArray, config)

	local function requireModule(module: ModuleScript): any
		return require(module) :: any
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
		`root` is the starting point for `Nearest` ambiguous resolution.

		@param root -- The module's own `script` instance
		@return     -- A `Require` function scoped to `root`
	]=]
	local function generateImport(root: Instance): typeof(require)
		assert(root:IsA("Instance"), "Root must be a valid Instance")

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
			- **`@Name/...`** — ambiguous search for `Name` (per `SearchMode`), then
			  traversal of any remaining segments (including `..`) from the found instance.
			- **`@Name`** — ambiguous search, result is the found module.

			Absolute paths are cached by path string. Ambiguous lookups are cached
			inside the Searcher, shared by every context of this generator.
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

			local resolvedTarget = resolveAlias(target, aliasMap)
			debugLog(debug, "Resolving:", target, "->", resolvedTarget)

			-- Global unambiguous cache hit
			if not disableCache and unambiguousCache[resolvedTarget] then
				return requireModule(unambiguousCache[resolvedTarget])
			end

			local pathParts = string.split(resolvedTarget:sub(2), "/")
			local firstSeg  = pathParts[1]

			-- ".." as the first segment is always invalid
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
			if not primaryRoot then
				error(`Cannot resolve "{resolvedTarget}": no valid ancestor found for context`)
			end

			if disableCache then searcher.reset() end
			local found = if searchMode == "Unique"
				then searcher.unique(firstSeg)
				else searcher.nearest(root, firstSeg)

			if not found then
				error(`Module "{resolvedTarget}" not found in any valid ancestor.`)
			end

			-- Traverse any additional segments (e.g. ".." or further children)
			-- starting from the resolved module instance.
			local inst = traverseSegments(found, { table.unpack(pathParts, 2) }, resolvedTarget)
			assert(inst:IsA("ModuleScript"), `"{resolvedTarget}" is not a ModuleScript`)
			return requireModule(inst :: ModuleScript)
		end

		return Require
	end

	return generateImport
end

return {
	create = CreateImportGenerator,
	getPerformanceStats = function()
		error("[RequireOnRails] getPerformanceStats is deprecated")
	end,
}
