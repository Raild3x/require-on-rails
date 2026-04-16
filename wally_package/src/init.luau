--!strict
-- Author: Logan Hunt (Roblox: Raildex) (GitHub: raild3x)
--[=[
	RequireOnRails - Contextual Module Import System

	Provides contextual `require` with string path resolution relative to
	configured ancestor instances.  Supports absolute paths
	(`@AncestorKey/path/to/Module`), non-ambiguous single-name paths (`@ModuleName`),
	and direct Instance references.

	Intended for use with the RequireOnRails VSCode extension, which generates
	LuauLSP aliases automatically.

	Basic setup:

	```lua
	local RoR = require(path.to.RequireOnRails)

	local GenerateImport = RoR.create({
		Ancestors = {
			Shared = ReplicatedStorage.src.Shared,
			Server = ServerScriptService.src.Server,
		},
	})
	return GenerateImport
	```

	Per-module usage:

	```lua
	require = require(ReplicatedStorage.Import)(script)

	local Types         = require("@Shared/Types")
	local PlayerService = require("@Server/Services/PlayerService")
	local Config        = require("@Config") -- ambiguous: nearest module named "Config"
	```
]=]

local Types  = require(script.Types)
local Search = require(script.Search)

-- Re-export public types
export type Config                    = Types.Config
export type ContextualImportGenerator = (Instance) -> typeof(require)

type ModuleCache  = Types.ModuleCache
type ContextCache = Types.ContextCache


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

	assert(typeof(validAncestors) == "table", "Ancestors must be a table")
	for _, ancestor in validAncestors do
		table.insert(ancestorsArray, ancestor)
	end

	debugLog(debug, "Initialized with", #ancestorsArray, "ancestors")

	local unambiguousCache: ModuleCache = {}
	local contextCache: ContextCache    = {}
	local currentlyRequiring: { [ModuleScript]: boolean } = {}

	--[=[
		Requires a ModuleScript with optional circular dependency detection.
		Marks the module as in-progress during the call and clears the flag after.
	]=]
	local function requireModule(module: ModuleScript): any
		if circularDetect and currentlyRequiring[module] then
			error(`Circular dependency detected: {module:GetFullName()} is already being required`)
		end
		currentlyRequiring[module] = true
		local result = require(module) :: any
		currentlyRequiring[module] = nil
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
			- **`@AncestorKey/path`** — absolute traversal from a registered ancestor.
			- **`@Name`** — ambiguous BFS search starting from the call-site context.

			Results are cached per-context (ambiguous) or globally (absolute).
		]=]
		local function Require(target: string | Instance): any
			-- Direct Instance reference
			if typeof(target) == "Instance" then
				assert(target:IsA("ModuleScript"), "Target must be a ModuleScript instance")
				return requireModule(target)
			end

			assert(typeof(target) == "string", "Target must be a string or Instance")

			-- Non-RoR strings fall through to native require
			if not target:match("^@") or target:match("^@self/") then
				return require(target) :: any
			end

			local resolvedTarget = resolveAlias(target, config.Aliases)
			debugLog(debug, "Resolving:", target, "->", resolvedTarget)

			-- Context-local cache hit
			if cache[resolvedTarget] then
				return requireModule(cache[resolvedTarget])
			end

			-- Global unambiguous cache hit
			if unambiguousCache[resolvedTarget] then
				return requireModule(unambiguousCache[resolvedTarget])
			end

			local pathParts = string.split(resolvedTarget:sub(2), "/")

			-- ── Absolute path: @AncestorKey/path/to/Module ──────────────
			local targetRoot = validAncestors[pathParts[1]]

			if not targetRoot and #pathParts > 1 then
				local keys = {}
				for k in validAncestors do table.insert(keys, k) end
				error(`Unknown ancestor key "{pathParts[1]}" in "{resolvedTarget}". Valid keys: {table.concat(keys, ", ")}`)
			end

			if targetRoot then
				local inst = targetRoot
				for i = 2, #pathParts do
					local next = inst:FindFirstChild(pathParts[i])
					if not next and config.CaseSensitive == false then
						local lower = pathParts[i]:lower()
						for _, child in inst:GetChildren() do
							if child.Name:lower() == lower then 
								next = child
								break
							end
						end
					end
					if not next then
						error(`Module "{resolvedTarget}" not found: "{pathParts[i]}" does not exist in "{inst:GetFullName()}".`)
					end
					inst = next :: Instance
				end

				assert(inst:IsA("ModuleScript"), `"{resolvedTarget}" is not a ModuleScript`)
				local module = inst :: ModuleScript

				unambiguousCache[resolvedTarget] = module
				module.AncestryChanged:Once(function()
					unambiguousCache[resolvedTarget] = nil
				end)

				return requireModule(module)
			end

			-- ── Ambiguous path: @ModuleName ──────────────────────────────
			if not primaryRoot then
				error(`Cannot resolve "{resolvedTarget}": no valid ancestor found for context`)
			end

			local found = Search.searchForModule(root, pathParts[1], ancestorsArray, config)
			if not found then
				local others = table.clone(ancestorsArray)
				local idx = table.find(others, primaryRoot)
				if idx then table.remove(others, idx) end
				found = Search.searchRoots(others, pathParts, config)
			end

			if not found then
				error(`Module "{resolvedTarget}" not found in any valid ancestor.`)
			end

			cache[resolvedTarget] = found
			found.AncestryChanged:Once(function()
				cache[resolvedTarget] = nil
			end)

			return requireModule(found :: ModuleScript)
		end

		return Require
	end

	return generateImport
end

return {
	create = CreateImportGenerator,
}

