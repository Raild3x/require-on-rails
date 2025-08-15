--!strict
-- Author: Logan Hunt (Roblox: Raildex) (GitHub: raild3x)
--[=[
	RequireOnRails - Contextual Module Import System
	
	This module provides an import system that allows modules to be imported
	using string paths relative to configured ancestor instances. It supports both
	absolute paths (starting with @) and relative module resolution.

	If you don't prefix your passed path with '@', it will fall back to the default 
	`require` behavior, allowing you to import modules using their full paths as 
	strings or directly using Instance references.

	This module is intended to be used in conjunction with the 
	[RequireOnRails](https://github.com/Raild3x/require-on-rails) VSCode extension,
	which provides automatic alias generation for LuauLSP linting.
	
	Key Features:
	- Contextual imports based on the calling module's location
	- Support for both absolute (@ancestor/path/to/module) and ambiguous paths
	- Breadth-first search for optimal module resolution
	- Caching for performance optimization
	- Automatic cache invalidation when module hierarchy changes
	- Debug logging and performance monitoring
	- Custom path aliases and ignore predicates
	- Circular dependency detection
	- Microprofiler integration for performance analysis
	
	Usage Examples:
	
	ReplicatedStorage/Import.luau
	```lua
	local RequireOnRails = require(path.to.RequireOnRails)

	-- Setup the import generator
	local GenerateImport = RequireOnRails.create({
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

	return GenerateImport
	```

	Some other module...
	```lua
	-- Generate a contextual import/require for this specific module
	require = require(ReplicatedStorage.Import)(script)

	-- Import using absolute paths (unambiguous)
	local Types = require("@Shared/Types")
	local PlayerService = require("@Server/Services/PlayerService")

	-- Import using ambiguous paths (searches from current context; down and then up (BFS))
	-- This will search for the nearest module named "Config".
	local Config = require("@Config")
	```
]=]

-- Microprofiler integration
local profileBegin = debug.profilebegin
local profileEnd = debug.profileend

-- Type definitions for improved code clarity and type safety
type ModuleCache = { [string]: ModuleScript }
type ContextCache = { [Instance]: ModuleCache }
type PerformanceStats = {
	cacheHits: number,
	cacheMisses: number,
	searchTime: number,
	averageSearchTime: number,
}

type Require = typeof(require)
export type ContextualImportGenerator = (Instance) -> Require

-- Enhanced configuration type
export type Config = {
	Ancestors: { [string]: Instance },
	Aliases: { [string]: string }?,
	IgnorePredicate: ((Instance) -> boolean)?,
	Debug: boolean?,
	MaxSearchDepth: number?,
	CaseSensitive: boolean?,
	TrackPerformance: boolean?,
	CircularDependencyDetection: boolean?,
	MicroprofilerEnabled: boolean?,
}

---------------------------------------------------------------------------------------
-- UTILITY FUNCTIONS
---------------------------------------------------------------------------------------

-- Global performance tracking
local globalStats: PerformanceStats = {
	cacheHits = 0,
	cacheMisses = 0,
	searchTime = 0,
	averageSearchTime = 0,
}

-- Microprofiler labels
local PROFILER_LABELS = {
	REQUIRE = "RoR:Require",
	CACHE_HIT = "RoR:CacheHit",
	CACHE_MISS = "RoR:CacheMiss",
	ALIAS_RESOLVE = "RoR:AliasResolve",
	BFS_SEARCH = "RoR:BfsSearch",
	MODULE_SEARCH = "RoR:ModuleSearch",
	ROOT_SEARCH = "RoR:RootSearch",
	PATH_TRAVERSE = "RoR:PathTraverse",
	CACHE_INVALIDATE = "RoR:CacheInvalidate",
	MODULE_LOAD = "RoR:ModuleLoad",
}

--[=[
	Wraps a function with microprofiler profiling if enabled.
	
	@param enabled - Whether profiling is enabled
	@param label - The profiler label to use
	@param fn - The function to wrap
	@return The result of the function call
]=]
local function profiledCall<T...>(enabled: boolean, label: string, fn: (...any) -> T...): T...
	if enabled then
		profileBegin(label)
		local results = table.pack(fn()) :: any
		profileEnd()
		return table.unpack(results, 1, results.n)
	else
		return fn()
	end
end

--[=[
	Logs debug information if debug mode is enabled.
	
	@param debug - Whether debug mode is enabled
	@param ... - Arguments to print (like print function)
]=]
local function debugLog(debug: boolean, ...: any): ()
	if debug then
		print("[RequireOnRails DEBUG]", ...)
	end
end

--[=[
	Normalizes a path string based on case sensitivity setting.
	
	@param path - The path to normalize
	@param caseSensitive - Whether to preserve case
	@return string - The normalized path
]=]
local function normalizePath(path: string, caseSensitive: boolean): string
	return caseSensitive and path or path:lower()
end

--[=[
	Determines if an instance is a valid container for module search.
	Excludes "_Index" folders and applies custom ignore predicate.
	
	@param instance - The instance to validate
	@param ignorePredicate - Optional function to filter instances
	@return boolean - True if the instance can contain searchable modules
]=]
local function isValidContainer(instance: Instance, ignorePredicate: ((Instance) -> boolean)?): boolean
	if instance.Name == "_Index" then
		return false
	end

	if ignorePredicate and ignorePredicate(instance) then
		return false
	end

	return true
end

--[=[
	Performs breadth-first search to find a module at the specified path.
	BFS ensures we find the shortest path to the target module.
	
	@param rootInstance - The root instance to search from
	@param pathParts - Array of path segments to traverse
	@param config - Configuration object
	@return ModuleScript? - The found module or nil if not found
]=]
local function bfsFindPath(rootInstance: Instance, pathParts: { string }, config: Config): ModuleScript?
	return profiledCall(config.MicroprofilerEnabled or false, PROFILER_LABELS.BFS_SEARCH, function(): ModuleScript?
		local maxDepth = config.MaxSearchDepth or 50
		local caseSensitive = config.CaseSensitive ~= false -- Default to true
		local debug = config.Debug or false

		debugLog(debug, "Searching for path", table.concat(pathParts, "/"), "from", rootInstance.Name)

		local queue: { { instance: Instance, depth: number } } = { { instance = rootInstance, depth = 1 } }
		local visited = {}

		while #queue > 0 do
			local current = table.remove(queue, 1)
			assert(current, "Queue item should not be nil")

			if current.depth > maxDepth then
				debugLog(debug, "Max search depth", maxDepth, "exceeded")
				break
			end

			-- Avoid infinite loops
			if visited[current.instance] then
				continue
			end
			visited[current.instance] = true

			for _, child in current.instance:GetChildren() do
				local childName = normalizePath(child.Name, caseSensitive)
				local targetName = normalizePath(pathParts[current.depth], caseSensitive)

				if childName == targetName then
					-- Found matching path segment
					if current.depth == #pathParts then
						-- Reached end of path - check if it's a ModuleScript
						if child:IsA("ModuleScript") then
							debugLog(debug, "Found module:", child:GetFullName())
							return child
						end
					elseif isValidContainer(child, config.IgnorePredicate) then
						-- Continue searching deeper with incremented depth
						table.insert(queue, { instance = child, depth = current.depth + 1 })
					end
				elseif isValidContainer(child, config.IgnorePredicate) then
					-- Non-matching container - search at same depth level
					table.insert(queue, { instance = child, depth = current.depth })
				end
			end
		end

		debugLog(debug, "Module not found:", table.concat(pathParts, "/"))
		return nil
	end)
end

--[=[
	Searches through multiple root instances for a module matching the path.
	Used for ambiguous path resolution when the module is not found in the primary root.
	
	@param validAncestors - Array of valid ancestor instances to search
	@param pathParts - Array of path segments to find
	@param config - Configuration object
	@return ModuleScript? - The found module or nil if not found
]=]
local function searchRoots(validAncestors: { Instance }, pathParts: { string }, config: Config): ModuleScript?
	return profiledCall(config.MicroprofilerEnabled or false, PROFILER_LABELS.ROOT_SEARCH, function(): ModuleScript?
		assert(typeof(validAncestors) == "table", "validAncestors must be a table")

		local searchedRoots: { Instance } = {}

		local function trySearchRoot(rootInstance: Instance): ModuleScript?
			assert(typeof(rootInstance) == "Instance", "Root instance must be an Instance")

			-- Avoid searching the same root multiple times
			if table.find(searchedRoots, rootInstance) then
				return nil
			end
			table.insert(searchedRoots, rootInstance)

			return bfsFindPath(rootInstance, pathParts, config)
		end

		-- Search through all alternative roots
		for _, altRoot in validAncestors do
			local found = trySearchRoot(altRoot)
			if found then
				return found
			end
		end

		return nil
	end)
end

--[=[
	Searches for a module by name starting from the origin and moving up the hierarchy.
	Used for ambiguous path resolution (e.g., import("@Config")).
	
	@param origin - The starting instance to search from
	@param targetName - The name of the module to find
	@param ancestors - Array of valid ancestor instances that bound the search
	@param config - Configuration object
	@return ModuleScript? - The found module or nil if not found
]=]
local function searchForModule(
	origin: Instance,
	targetName: string,
	ancestors: { Instance },
	config: Config
): ModuleScript?
	return profiledCall(config.MicroprofilerEnabled or false, PROFILER_LABELS.MODULE_SEARCH, function(): ModuleScript?
		local searched = {}
		local ancestorSet = {}
		local maxDepth = config.MaxSearchDepth or 50
		local caseSensitive = config.CaseSensitive ~= false
		local debug = config.Debug or false

		-- Create a set for O(1) ancestor lookups
		for _, ancestor in ancestors do
			ancestorSet[ancestor] = true
		end

		debugLog(debug, "Searching for module", targetName, "from", origin.Name)

		--[[
			Recursively searches down from a parent instance for the target module.
			Uses memoization to avoid redundant searches.
		]]
		local function searchDown(parent: Instance, depth: number): ModuleScript?
			if searched[parent] or depth > maxDepth then
				return nil
			end
			searched[parent] = true

			-- Check if this parent directly contains the target module
			local module = parent:FindFirstChild(targetName)
			if module and module:IsA("ModuleScript") then
				local moduleName = normalizePath(module.Name, caseSensitive)
				local searchName = normalizePath(targetName, caseSensitive)
				if moduleName == searchName then
					debugLog(debug, "Found ambiguous module:", module:GetFullName())
					return module
				end
			end

			-- Recursively search through valid child containers
			for _, child in parent:GetChildren() do
				if isValidContainer(child, config.IgnorePredicate) then
					local found = searchDown(child, depth + 1)
					if found then
						return found
					end
				end
			end

			return nil
		end

		-- Search upward through the hierarchy until we hit a valid ancestor
		local current = origin :: any
		while current do
			local found = searchDown(current, 0)
			if found then
				return found
			end
			if ancestorSet[current] then -- Stop searching if the current is a top level ancestor
				break
			end
			current = current.Parent
		end

		debugLog(debug, "Ambiguous module", targetName, "not found")
		return nil
	end)
end

--[=[
	Resolves path aliases to their actual paths.
	
	@param path - The original path
	@param aliases - Dictionary of alias mappings
	@param microprofilerEnabled - Whether to profile this operation
	@return string - The resolved path
]=]
local function resolveAlias(path: string, aliases: { [string]: string }?, microprofilerEnabled: boolean?): string
	return profiledCall(microprofilerEnabled or false, PROFILER_LABELS.ALIAS_RESOLVE, function()
		if not aliases then
			return path
		end

		local pathWithoutPrefix = path:sub(2) -- Remove '@'
		local firstSegment = pathWithoutPrefix:split("/")[1]

		if aliases[firstSegment] then
			local remainingPath = pathWithoutPrefix:sub(#firstSegment + 1)
			return "@" .. aliases[firstSegment] .. remainingPath
		end

		return path
	end)
end

--[=[
	Tracks performance statistics for import operations.
	
	@param isHit - Whether this was a cache hit
	@param searchTime - Time taken for the search operation
]=]
local function trackPerformance(isHit: boolean, searchTime: number): ()
	if isHit then
		globalStats.cacheHits += 1
	else
		globalStats.cacheMisses += 1
		globalStats.searchTime += searchTime
		local totalSearches = globalStats.cacheMisses
		globalStats.averageSearchTime = globalStats.searchTime / totalSearches
	end
end

--[=[
	Gets current performance statistics.
	
	@return PerformanceStats - Current performance data
]=]
local function getPerformanceStats(): PerformanceStats
	return table.clone(globalStats)
end

---------------------------------------------------------------------------------------
-- MAIN IMPORT GENERATOR
---------------------------------------------------------------------------------------

--[=[
	Creates a contextual import generator with the specified configuration.
	
	@param _config - Configuration object
	@return ContextualImportGenerator - Function that creates import functions for specific contexts
]=]
local function CreateImportGenerator(_config: Config): ContextualImportGenerator
	local config = _config or {} :: Config

	local validAncestors = config.Ancestors
	local ancestorsArray: { Instance } = {}
	local debug = config.Debug or false
	local trackPerf = config.TrackPerformance or false
	local circularDetection = config.CircularDependencyDetection ~= false -- Default to true
	local microprofilerEnabled = config.MicroprofilerEnabled or false

	-- Convert ancestor dictionary to array for easier iteration
	for _, ancestor in validAncestors do
		table.insert(ancestorsArray, ancestor)
	end
	assert(typeof(validAncestors) == "table", "validAncestors must be a table")

	debugLog(debug, "Initialized RequireOnRails with", #ancestorsArray, "ancestors")

	-- Global caches for performance optimization
	local unambiguousStringToModuleCache: ModuleCache = {}
	local contextCache: ContextCache = {}
	local currentlyRequiring: { [ModuleScript]: boolean } = {} -- For circular dependency detection

	--[[
		Gets or creates a module cache for the specified context.
		Automatically sets up cache invalidation when context ancestry changes.
	]]
	local function getCacheForContext(context: Instance): ModuleCache
		local existing = contextCache[context]
		if existing then
			return existing
		end

		local newCache: ModuleCache = {}
		contextCache[context] = newCache

		-- Clear the cache if the context ancestry changes
		context.AncestryChanged:Connect(function()
			profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_INVALIDATE, function()
				debugLog(debug, "Clearing cache for context", context, "due to ancestry change")
				for key in newCache do
					newCache[key] = nil
				end
			end)
		end)

		return newCache
	end

	--[=[
		Creates a contextual import function for the specified root instance.
		
		@param root - The root instance that provides context for imports
		@return ContextualImport - Import function bound to this context
	]=]
	local function generateImport(root: Instance): typeof(require)
		local cache = getCacheForContext(root)

		-- Find the closest primary root ancestor for this context
		local primaryRoot: Instance? = nil
		do
			local parent = root.Parent
			while parent do
				if table.find(ancestorsArray, parent) then
					primaryRoot = parent
					break
				end
				parent = parent.Parent
			end
		end

		assert(root and root:IsA("Instance"), "Root must be a valid Instance")
		if not primaryRoot and debug then
			warn(`Primary root ancestor not found for {root:GetFullName()}. Relative paths will not be supported.`)
		end

		debugLog(
			debug,
			"Generated import function for",
			root:GetFullName(),
			"with primary root",
			primaryRoot and primaryRoot.Name or "none"
		)

		--[=[
			The actual import function that resolves module paths.
			Supports both string paths and direct Instance references.
		]=]
		local function Require(target: string | Instance): any
			return profiledCall(microprofilerEnabled, PROFILER_LABELS.REQUIRE, function()
				local startTime = tick()

				-- Handle non-custom string paths and direct instances
				if typeof(target) == "string" and (target:match("^@self/") or not target:match("^@")) then
					local result = require(target) :: any
					if trackPerf then
						trackPerformance(false, tick() - startTime)
					end
					return result
				elseif typeof(target) == "Instance" then
					assert(target:IsA("ModuleScript"), "Target must be a ModuleScript instance")

					-- Circular dependency detection
					if circularDetection and currentlyRequiring[target] then
						error(`Circular dependency detected: {target:GetFullName()} is already being required`)
					end

					currentlyRequiring[target] = true
					local result = require(target) :: any
					currentlyRequiring[target] = nil

					if trackPerf then
						trackPerformance(false, tick() - startTime)
					end
					return result
				end

				assert(typeof(target) == "string", "Target must be a string or Instance")

				-- Resolve aliases first
				local resolvedTarget = resolveAlias(target, config.Aliases, microprofilerEnabled)
				debugLog(debug, "Resolving import:", target, "->", resolvedTarget)

				-- Check caches first for performance
				if cache[resolvedTarget] then
					return profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_HIT, function()
						debugLog(debug, "Cache hit for", resolvedTarget)
						if trackPerf then
							trackPerformance(true, 0)
						end
						return require(cache[resolvedTarget]) :: any
					end)
				elseif unambiguousStringToModuleCache[resolvedTarget] then
					return profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_HIT, function()
						debugLog(debug, "Global cache hit for", resolvedTarget)
						if trackPerf then
							trackPerformance(true, 0)
						end
						return require(unambiguousStringToModuleCache[resolvedTarget]) :: any
					end)
				end

				return profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_MISS, function()
					local pathStr = resolvedTarget:sub(2) -- Remove '@' prefix
					local pathParts = string.split(pathStr, "/")

					-- Handle absolute paths (unambiguous)
					local targetRoot: Instance? = validAncestors[pathParts[1]]
					if targetRoot then
						return profiledCall(microprofilerEnabled, PROFILER_LABELS.PATH_TRAVERSE, function()
							local targetInstance = targetRoot

							-- Traverse the specified path
							for i = 2, #pathParts do
								local nextChild = targetInstance:FindFirstChild(pathParts[i])
								if not nextChild then
									-- Try case-insensitive search if enabled
									if config.CaseSensitive == false then
										local targetName = pathParts[i]:lower()
										for _, child in targetInstance:GetChildren() do
											if child.Name:lower() == targetName then
												nextChild = child
												break
											end
										end
									end

									if not nextChild then
										error(
											`Module "{resolvedTarget}" not found: "{pathParts[i]}" does not exist in "{targetInstance:GetFullName()}".`
										)
									end
								end
								targetInstance = nextChild :: Instance
							end

							assert(
								targetInstance:IsA("ModuleScript"),
								`Target "{resolvedTarget}" is not a ModuleScript`
							)

							-- Circular dependency detection
							if circularDetection and currentlyRequiring[targetInstance] then
								error(
									`Circular dependency detected: {targetInstance:GetFullName()} is already being required`
								)
							end

							-- Cache the resolved module globally since it's unambiguous
							unambiguousStringToModuleCache[resolvedTarget] = targetInstance :: ModuleScript
							targetInstance.AncestryChanged:Once(function()
								profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_INVALIDATE, function()
									debugLog(
										debug,
										"Clearing global cache for",
										resolvedTarget,
										"due to ancestry change"
									)
									unambiguousStringToModuleCache[resolvedTarget] = nil
								end)
							end)

							currentlyRequiring[targetInstance] = true
							local result = require(targetInstance) :: any
							currentlyRequiring[targetInstance] = nil

							if trackPerf then
								trackPerformance(false, tick() - startTime)
							end
							return result
						end)
					end

					-- Handle ambiguous paths - search from current context first
					if not primaryRoot then
						error(`Cannot resolve ambiguous path "{resolvedTarget}" - no valid ancestor found for context`)
					end

					local found = searchForModule(root, pathParts[#pathParts], ancestorsArray, config)

					-- If not found locally, search other ancestor roots
					if not found then
						local ancestorsToSearch = table.clone(ancestorsArray)
						local primaryRootIndex = table.find(ancestorsToSearch, primaryRoot)
						if primaryRootIndex then
							table.remove(ancestorsToSearch, primaryRootIndex)
						end
						found = searchRoots(ancestorsToSearch, pathParts, config)
					end

					if found then
						-- Circular dependency detection
						if circularDetection and currentlyRequiring[found] then
							error(`Circular dependency detected: {found:GetFullName()} is already being required`)
						end

						-- Cache the result for this context
						cache[resolvedTarget] = found :: ModuleScript
						found.AncestryChanged:Once(function()
							profiledCall(microprofilerEnabled, PROFILER_LABELS.CACHE_INVALIDATE, function()
								debugLog(debug, "Clearing context cache for", resolvedTarget, "due to ancestry change")
								cache[resolvedTarget] = nil
							end)
						end)

						currentlyRequiring[found] = true
						local result = profiledCall(
							microprofilerEnabled,
							PROFILER_LABELS.MODULE_LOAD .. "_" .. found.Name,
							function()
								return require(found) :: any
							end
						)
						currentlyRequiring[found] = nil

						if trackPerf then
							trackPerformance(false, tick() - startTime)
						end
						return result
					end

					error(`Module "{resolvedTarget}" not found in any valid ancestor.`)
				end)
			end)
		end

		return Require
	end

	return generateImport
end

return {
	getPerformanceStats = getPerformanceStats,
	create = CreateImportGenerator,
}
