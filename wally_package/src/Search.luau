--!strict
-- Module search algorithms for RequireOnRails:
--   bfsFindPath     — BFS path traversal through an instance subtree
--   searchRoots     — fallback search across multiple ancestor roots
--   searchForModule — upward-walking DFS for a module by name

local Types   = require(script.Parent.Types)
type Config = Types.Config

local function debugLog(enabled: boolean, ...: any): ()
	if enabled then print("[RequireOnRails DEBUG]", ...) end
end

local function normalizePath(path: string, caseSensitive: boolean): string
	return caseSensitive and path or path:lower()
end

local function isValidContainer(instance: Instance, ignorePredicate: ((Instance) -> boolean)?): boolean
	return instance.Name ~= "_Index" and not (ignorePredicate and ignorePredicate(instance))
end

--[=[
	BFS traversal following each segment of `pathParts` from `rootInstance`.
	Skips `_Index` containers and anything the `IgnorePredicate` rejects.
	Stops when the full path matches a ModuleScript or `MaxSearchDepth` is exceeded.

	@param rootInstance -- Root instance to start searching from
	@param pathParts    -- Ordered path segments to traverse
	@param config       -- RequireOnRails Config
	@return ModuleScript?
]=]
local function bfsFindPath(rootInstance: Instance, pathParts: { string }, config: Config): ModuleScript?
	local maxDepth      = config.MaxSearchDepth or 50
	local caseSensitive = config.CaseSensitive ~= false
	local debug         = config.Debug or false

	debugLog(debug, "bfsFindPath:", table.concat(pathParts, "/"), "from", rootInstance.Name)

	local queue: { { instance: Instance, depth: number } } = { { instance = rootInstance, depth = 1 } }
	local head    = 1
	local visited = {}

	while head <= #queue do
		local current = queue[head]
		head += 1
		if current.depth > maxDepth then break end
		if visited[current.instance] then continue end
		visited[current.instance] = true

		for _, child in current.instance:GetChildren() do
			local childName  = normalizePath(child.Name, caseSensitive)
			local targetName = normalizePath(pathParts[current.depth], caseSensitive)

			if childName == targetName then
				if current.depth == #pathParts then
					if child:IsA("ModuleScript") then
						debugLog(debug, "Found:", child:GetFullName())
						return child
					end
				elseif isValidContainer(child, config.IgnorePredicate) then
					table.insert(queue, { instance = child, depth = current.depth + 1 })
				end
			elseif isValidContainer(child, config.IgnorePredicate) then
				table.insert(queue, { instance = child, depth = current.depth })
			end
		end
	end

	return nil
end

--[=[
	Iterates `ancestors` calling `bfsFindPath` on each until a match is found.
	Skips any root already visited in this call, preventing duplicate work.

	@param ancestors -- Ordered list of ancestor instances to search
	@param pathParts -- Path segments to locate
	@param config    -- RequireOnRails Config
	@return ModuleScript?
]=]
local function searchRoots(ancestors: { Instance }, pathParts: { string }, config: Config): ModuleScript?
	local searched: { Instance } = {}
	for _, root in ancestors do
		if table.find(searched, root) then continue end
		table.insert(searched, root)
		local found = bfsFindPath(root, pathParts, config)
		if found then return found end
	end
	return nil
end

--[=[
	Walks upward from `origin` (stopping at an ancestor boundary) running a
	downward DFS at each level to find a ModuleScript named `targetName`.
	Used for ambiguous single-segment paths such as `@Config`.

	@param origin     -- The starting instance (usually `script`)
	@param targetName -- The bare module name to find
	@param ancestors  -- Boundary set; upward search stops when one is reached
	@param config     -- RequireOnRails Config
	@return ModuleScript?
]=]
local function searchForModule(
	origin: Instance,
	targetName: string,
	ancestors: { Instance },
	config: Config
): ModuleScript?
	local searched      = {}
	local ancestorSet   = {}
	local maxDepth      = config.MaxSearchDepth or 50
	local caseSensitive = config.CaseSensitive ~= false
	local debug         = config.Debug or false
	local searchName    = normalizePath(targetName, caseSensitive)

	for _, ancestor in ancestors do
		ancestorSet[ancestor] = true
	end

	debugLog(debug, "searchForModule:", targetName, "from", origin.Name)

	local function searchDown(parent: Instance, depth: number): ModuleScript?
		if searched[parent] or depth > maxDepth then return nil end
		searched[parent] = true
		local children = parent:GetChildren()
		-- Prioritise ModuleScript matches at the current level
		for _, child in children do
			if child:IsA("ModuleScript") and normalizePath(child.Name, caseSensitive) == searchName then
				debugLog(debug, "Found:", child:GetFullName())
				return child
			end
		end
		-- Descend into valid container children
		for _, child in children do
			if isValidContainer(child, config.IgnorePredicate) then
				local found = searchDown(child, depth + 1)
				if found then return found end
			end
		end
		return nil
	end

	local current = origin :: any
	while current do
		local found = searchDown(current, 0)
		if found then return found end
		if ancestorSet[current] then break end
		current = current.Parent
	end

	debugLog(debug, "Not found:", targetName)
	return nil
end

return {
	bfsFindPath     = bfsFindPath,
	searchRoots     = searchRoots,
	searchForModule = searchForModule,
}
