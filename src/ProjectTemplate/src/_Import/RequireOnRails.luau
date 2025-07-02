--!strict
-- Author: Logan Hunt (Raildex)
-- Date: April 16, 2025
--[=[
	RequireOnRails - Contextual Module Import System
	
	This module provides a sophisticated import system that allows modules to be imported
	using string paths relative to configured ancestor instances. It supports both
	absolute paths (starting with @) and relative module resolution.

	This module is intended to be used in conjunction with the RequireOnRails VSCode extension,
	which provides automatic alias generation for LuauLSP linting.
	
	Key Features:
	- Contextual imports based on the calling module's location
	- Caching for performance optimization
	- Automatic cache invalidation when module hierarchy changes
	- Support for both absolute (@ancestor/path/to/module) and ambiguous paths
	- Breadth-first search for optimal module resolution
	
	Usage Examples:
	
	```lua
	local ReplicatedStorage = game:GetService("ReplicatedStorage")
	local ServerScriptService = game:GetService("ServerScriptService")

	-- Setup the import generator
	local GenerateImport = RequireOnRails({
		Ancestors = {
			["Server"] = ServerScriptService.src.Server,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
		}
	})
	
	-- Generate a contextual import function for a specific module
	require = GenerateImport(script) :: typeof(require) -- 'script' is the current module

	-- Import using absolute paths (unambiguous)
	local Types = require("@Shared/Types")
	local PlayerService = require("@Server/Services/PlayerService")

	-- Import using ambiguous paths (searches from current context; down and then up (BFS))
	local Config = require("@Config")
	```
]=]

-- Type definitions for improved code clarity and type safety
type ModuleCache = { [string]: ModuleScript }
type ContextCache = { [Instance]: ModuleCache }
export type ContextualImport = (string | Instance) -> any
export type ContextualImportGenerator = (Instance) -> ContextualImport

---------------------------------------------------------------------------------------
-- UTILITY FUNCTIONS
---------------------------------------------------------------------------------------

--[=[
	Determines if an instance is a valid container for module search.
	Excludes "_Index" folders which are typically used for re-exports.
	
	@param instance - The instance to validate
	@return boolean - True if the instance can contain searchable modules
]=]
local function isValidContainer(instance: Instance): boolean
	return instance.Name ~= "_Index"
end

--[=[
	Performs breadth-first search to find a module at the specified path.
	BFS ensures we find the shortest path to the target module.
	
	@param rootInstance - The root instance to search from
	@param pathParts - Array of path segments to traverse
	@return ModuleScript? - The found module or nil if not found
]=]
local function bfsFindPath(rootInstance: Instance, pathParts: { string }): ModuleScript?
	local queue: { { instance: Instance, depth: number } } = { { instance = rootInstance, depth = 1 } }

	while #queue > 0 do
		local current = table.remove(queue, 1)
		assert(current, "Queue item should not be nil")
		
		for _, child in current.instance:GetChildren() do
			if child.Name == pathParts[current.depth] then
				-- Found matching path segment
				if current.depth == #pathParts then
					-- Reached end of path - check if it's a ModuleScript
					if child:IsA("ModuleScript") then
						return child
					end
				elseif isValidContainer(child) then
					-- Continue searching deeper with incremented depth
					table.insert(queue, { instance = child, depth = current.depth + 1 })
				end
			elseif isValidContainer(child) then
				-- Non-matching container - search at same depth level
				table.insert(queue, { instance = child, depth = current.depth })
			end
		end
	end

	return nil
end

--[=[
	Searches through multiple root instances for a module matching the path.
	Used for ambiguous path resolution when the module is not found in the primary root.
	
	@param primaryRoot - The primary root instance to search
	@param validAncestors - Array of valid ancestor instances to search
	@param pathParts - Array of path segments to find
	@return ModuleScript? - The found module or nil if not found
]=]
local function searchRoots(validAncestors: { Instance }, pathParts: { string }): ModuleScript?
	assert(typeof(validAncestors) == "table", "validAncestors must be a table")

	local searchedRoots: { Instance } = {}
	
	local function trySearchRoot(rootInstance: Instance): ModuleScript?
		assert(typeof(rootInstance) == "Instance", "Root instance must be an Instance")
		
		-- Avoid searching the same root multiple times
		if table.find(searchedRoots, rootInstance) then
			return nil
		end
		table.insert(searchedRoots, rootInstance)
		
		return bfsFindPath(rootInstance, pathParts)
	end

	-- Search through all alternative roots
	for _, altRoot in validAncestors do
		local found = trySearchRoot(altRoot)
		if found then
			return found
		end
	end
	
	return nil
end

--[=[
	Searches for a module by name starting from the origin and moving up the hierarchy.
	Used for ambiguous path resolution (e.g., import("@Config")).
	
	@param origin - The starting instance to search from
	@param targetName - The name of the module to find
	@param ancestors - Array of valid ancestor instances that bound the search
	@return ModuleScript? - The found module or nil if not found
]=]
local function searchForModule(origin: Instance, targetName: string, ancestors: { Instance }): ModuleScript?
	local searched = {}
	local ancestorSet = {}
	
	-- Create a set for O(1) ancestor lookups
	for _, ancestor in ancestors do
		ancestorSet[ancestor] = true
	end

	--[[
		Recursively searches down from a parent instance for the target module.
		Uses memoization to avoid redundant searches.
	]]
	local function searchDown(parent: Instance): ModuleScript?
		if searched[parent] then 
			return nil 
		end
		searched[parent] = true

		-- Check if this parent directly contains the target module
		local module = parent:FindFirstChild(targetName)
		if module and module:IsA("ModuleScript") then
			return module
		end

		-- Recursively search through valid child containers
		for _, child in parent:GetChildren() do
			if isValidContainer(child) then
				local found = searchDown(child)
				if found then 
					return found 
				end
			end
		end
		
		return nil
	end

	-- Search upward through the hierarchy until we hit a valid ancestor
	local current = origin
	while current and not ancestorSet[current] do
		local found = searchDown(current)
		if found then 
			return found 
		end
		current = current.Parent
	end
	
	return nil
end

---------------------------------------------------------------------------------------
-- MAIN IMPORT GENERATOR
---------------------------------------------------------------------------------------

--[=[
	Generates a contextual import system with the specified configuration.
	
	@param _config - Configuration object containing:
		- Ancestors: Dictionary mapping ancestor names to Instance objects
		- IgnorePredicate: Optional function to filter instances (currently unused)
	@return ContextualImportGenerator - Function that creates import functions for specific contexts
]=]
local function GenerateImportGenerator(_config: {
	Ancestors: { [string]: Instance },
	IgnorePredicate: ((Instance) -> (boolean))?
}): ContextualImportGenerator
	local config = _config or {} :: any

	local validAncestors = config.Ancestors
	local ancestorsArray: { Instance } = {}
	
	-- Convert ancestor dictionary to array for easier iteration
	for _, ancestor in validAncestors do
		table.insert(ancestorsArray, ancestor)
	end
	assert(typeof(validAncestors) == "table", "validAncestors must be a table")

	-- Global caches for performance optimization
	local unambiguousStringToModuleCache: ModuleCache = {}
	local contextCache: ContextCache = {}

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
			warn(`Clearing cache for context {context} due to ancestry change.`)
			for key in newCache do
				newCache[key] = nil
			end
		end)

		return newCache
	end

	--[[
		Creates a contextual import function for the specified root instance.
		
		@param root - The root instance that provides context for imports
		@return ContextualImport - Import function bound to this context
	]]
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
		assert(primaryRoot, "Primary root ancestor not found in the valid ancestors")

		--[[
			The actual import function that resolves module paths.
			Supports both string paths and direct Instance references.
		]]
		local function Require(target: string | Instance): any
			-- Handle non-custom string paths and direct instances
			if typeof(target) == "string" and not target:match("^@") then
				return require(target) :: any
			elseif typeof(target) == "Instance" then
				assert(target:IsA("ModuleScript"), "Target must be a ModuleScript instance")
				return require(target) :: any
			end
			
			assert(typeof(target) == "string", "Target must be a string or Instance")

			-- Check caches first for performance
			if cache[target] then
				return require(cache[target]) :: any
			elseif unambiguousStringToModuleCache[target] then
				return require(unambiguousStringToModuleCache[target]) :: any
			end

			local pathStr = target:sub(2) -- Remove '@' prefix
			local pathParts = string.split(pathStr, "/")

			-- Handle absolute paths (unambiguous)
			local targetRoot: Instance? = validAncestors[pathParts[1]]
			if targetRoot then
				local targetInstance = targetRoot
				
				-- Traverse the specified path
				for i = 2, #pathParts do
					targetInstance = targetInstance:FindFirstChild(pathParts[i])
					if not targetInstance then
						error(`Module "{target}" not found in ancestor "{targetRoot.Name}".`)
					end
				end
				
				-- Cache the resolved module globally since it's unambiguous
				unambiguousStringToModuleCache[target] = targetInstance :: ModuleScript
				targetInstance.AncestryChanged:Once(function()
					warn(`Clearing cache for unambiguous target {target} due to ancestry change of {targetInstance}`)
					unambiguousStringToModuleCache[target] = nil
				end)
				
				return require(targetInstance) :: any
			end

			-- Handle ambiguous paths - search from current context first
			local found = searchForModule(root, pathParts[#pathParts], ancestorsArray)
			
			-- If not found locally, search other ancestor roots
			if not found then
				local ancestorsToSearch = table.clone(ancestorsArray)
				local primaryRootIndex = table.find(ancestorsToSearch, primaryRoot)
				if primaryRootIndex then
					table.remove(ancestorsToSearch, primaryRootIndex)
				end
				found = searchRoots(ancestorsToSearch, pathParts)
			end

			if found then
				-- Cache the result for this context
				cache[target] = found :: ModuleScript
				found.AncestryChanged:Once(function()
					warn(`Clearing cache for ambiguous target {target} due to ancestry change of {found}`)
					cache[target] = nil
				end)
				return require(found) :: any
			end

			error(`Module "{target}" not found in any valid ancestor.`)
		end

		return Require
	end

	return generateImport
end

return GenerateImportGenerator
