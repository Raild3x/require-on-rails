--!strict
-- Ambiguous `@Name` resolution for RequireOnRails.
--
-- Each generator owns one Searcher. It keeps a lazily-built snapshot of the
-- instance tree under the registered roots: a container's children are read
-- from the engine the first time any search reaches it, then reused by every
-- later search in the same VM. Nothing walks the whole tree up front, so each
-- Actor only pays for the part of the tree its own scripts search through.
--
--   nearest — searches the requirer's folder, then each parent in turn, and
--             returns the shallowest match in the first level that has one
--             (lazy, context-dependent)
--   unique  — indexes every module once and refuses duplicate names unless
--             PathPriority picks a winner, like the tool's dynamic mode

local Types = require(script.Parent.Types)
type Config = Types.Config

-- One child as seen by the snapshot; `name` is already case-normalised.
type Entry = { inst: Instance, name: string, isModule: boolean, canDescend: boolean }

export type Searcher = {
	nearest: (origin: Instance, targetName: string) -> ModuleScript?,
	unique: (targetName: string) -> ModuleScript?,
	reset: () -> (),
}

local function debugLog(enabled: boolean, ...: any): ()
	if enabled then print("[RequireOnRails DEBUG]", ...) end
end

--[=[
	Creates a Searcher over `roots`. Connects DescendantAdded/DescendantRemoving
	on each root so the snapshot and cached answers stay current.

	@param roots  -- Registered ancestor roots
	@param config -- RequireOnRails Config
	@return Searcher
]=]
local function new(roots: { Instance }, config: Config): Searcher
	local caseSensitive = config.CaseSensitive ~= false
	local maxDepth      = config.MaxSearchDepth or 50
	local debug         = config.Debug or false
	local ignore        = config.IgnorePredicate or function(_: Instance) return false end
	local priority      = config.PathPriority or {}

	local function normalize(name: string): string
		return if caseSensitive then name else name:lower()
	end

	local rootSet: { [Instance]: boolean } = {}
	for _, root in roots do
		rootSet[root] = true
	end

	local snapshot: { [Instance]: { Entry } } = {}
	-- Per level: every module name below it -> its shallowest match. Built in one
	-- scan the first time a walk reaches the level, then shared by all callers.
	local levelIndex: { [Instance]: { [string]: ModuleScript } } = {}
	-- Per start: the ordered levels its walk visits (ancestors, then other roots).
	local walkLevels: { [Instance]: { Instance } } = {}
	local uniqueIndex: { [string]: { ModuleScript } }? = nil

	local function reset()
		table.clear(snapshot)
		table.clear(levelIndex)
		table.clear(walkLevels)
		uniqueIndex = nil
	end

	-- Only the changed container's listing goes stale; level indexes are cheap
	-- to rebuild from the snapshot, so they are dropped wholesale.
	local function invalidate(inst: Instance)
		snapshot[inst] = nil
		if inst.Parent then snapshot[inst.Parent] = nil end
		table.clear(levelIndex)
		table.clear(walkLevels)
		uniqueIndex = nil
	end
	for _, root in roots do
		root.DescendantAdded:Connect(invalidate)
		root.DescendantRemoving:Connect(invalidate)
	end

	local function children(inst: Instance): { Entry }
		local cached = snapshot[inst]
		if cached then return cached end
		local list: { Entry } = {}
		for _, child in inst:GetChildren() do
			table.insert(list, {
				inst       = child,
				name       = normalize(child.Name),
				isModule   = child:IsA("ModuleScript"),
				canDescend = child.Name ~= "_Index" and not ignore(child),
			})
		end
		snapshot[inst] = list
		return list
	end

	local function priorityOf(inst: Instance): number
		for i, entry in priority do
			if inst == entry or inst:IsDescendantOf(entry) then return i end
		end
		return math.huge
	end

	-- Tie-break for equally near candidates: PathPriority order first, then
	-- alphabetical by full name.
	local function precedes(a: Instance, b: Instance): boolean
		local pa, pb = priorityOf(a), priorityOf(b)
		if pa ~= pb then return pa < pb end
		return a:GetFullName() < b:GetFullName()
	end

	-- Steps between two instances through their lowest common ancestor.
	local function distance(from: Instance, to: Instance): number
		local ups: { [Instance]: number } = {}
		local steps = 0
		local a: Instance? = from
		while a do
			ups[a] = steps
			steps += 1
			a = a.Parent
		end
		local downs = 0
		local b: Instance? = to
		while b do
			if ups[b] then return ups[b] + downs end
			downs += 1
			b = b.Parent
		end
		return math.huge
	end

	-- Scans below `level` layer by layer, keeping the shallowest module per name
	-- (equal depth: `precedes`). One scan answers every later name at this level.
	local function indexBelow(level: Instance): { [string]: ModuleScript }
		local index: { [string]: ModuleScript } = {}
		local layer = { level }
		local depth = 0
		while #layer > 0 and depth <= maxDepth do
			local layerBest: { [string]: ModuleScript } = {}
			local nextLayer = {}
			for _, inst in layer do
				for _, entry in children(inst) do
					if entry.isModule and not index[entry.name] then
						local current = layerBest[entry.name]
						if current == nil or precedes(entry.inst, current) then
							layerBest[entry.name] = entry.inst :: ModuleScript
						end
					end
					if entry.canDescend then table.insert(nextLayer, entry.inst) end
				end
			end
			for name, module in layerBest do
				index[name] = module
			end
			layer = nextLayer
			depth += 1
		end
		return index
	end

	--[=[
		Finds the module named `targetName` closest in scope to `origin`: the
		whole subtree of its folder first, then each parent's, so a neighbour's
		module five folders deep beats a shallow one a level further up. Within a
		level the shallowest match wins. The walk stops at the outermost
		registered root containing `origin`; other roots follow, nearest first.
		`MaxSearchDepth` caps how many folders deep below each level it looks.
	]=]
	local function levelsFor(start: Instance): { Instance }
		local cached = walkLevels[start]
		if cached then return cached end

		local top: Instance? = nil
		local a: Instance? = start
		while a do
			if rootSet[a] then top = a end
			a = a.Parent
		end

		local levels: { Instance } = {}
		if top then
			local level: Instance? = start
			while level do
				table.insert(levels, level)
				if level == top then break end
				level = level.Parent
			end

			type Other = { root: Instance, distance: number }
			local others: { Other } = {}
			for _, root in roots do
				if root ~= top and not root:IsDescendantOf(top) then
					table.insert(others, { root = root, distance = distance(start, root) })
				end
			end
			table.sort(others, function(x: Other, y: Other)
				if x.distance ~= y.distance then return x.distance < y.distance end
				return x.root:GetFullName() < y.root:GetFullName()
			end)
			for _, other in others do
				table.insert(levels, other.root)
			end
		end

		walkLevels[start] = levels
		return levels
	end

	local function nearest(origin: Instance, targetName: string): ModuleScript?
		local name = normalize(targetName)
		-- A module with no children searches the same tree from its parent.
		local start = if #children(origin) > 0 then origin else origin.Parent :: Instance
		if debug then debugLog(debug, "nearest:", targetName, "from", origin:GetFullName()) end

		for _, searchLevel in levelsFor(start) do
			local index = levelIndex[searchLevel]
			if not index then
				index = indexBelow(searchLevel)
				levelIndex[searchLevel] = index
			end

			local found: ModuleScript? = index[name]
			if found and normalize(found.Name) ~= name then
				-- ponytail: renames fire no Descendant events, so a stale name forces a full
				-- reset; a module renamed *to* the target stays unseen until the next
				-- add/remove under a root. Connect per-module Name signals if that bites.
				reset()
				return nearest(origin, targetName)
			end
			if found then
				if debug then debugLog(debug, "Found:", found:GetFullName(), "searching below", searchLevel:GetFullName()) end
				return found
			end
		end

		debugLog(debug, "Not found:", targetName)
		return nil
	end

	local function buildIndex(): { [string]: { ModuleScript } }
		local index: { [string]: { ModuleScript } } = {}
		local seen: { [Instance]: boolean } = {}
		local stack = table.clone(roots)
		while #stack > 0 do
			local inst = table.remove(stack) :: Instance
			for _, entry in children(inst) do
				if seen[entry.inst] then continue end
				seen[entry.inst] = true
				if entry.isModule then
					index[entry.name] = index[entry.name] or {}
					table.insert(index[entry.name], entry.inst :: ModuleScript)
				end
				if entry.canDescend then table.insert(stack, entry.inst) end
			end
		end
		return index
	end

	local function describe(modules: { ModuleScript }): string
		local names = {}
		for _, module in modules do
			table.insert(names, module:GetFullName())
		end
		table.sort(names)
		return table.concat(names, ", ")
	end

	--[=[
		Resolves `targetName` the way the tool's dynamic mode generates aliases:
		a name owned by one module resolves to it; duplicates resolve only when
		exactly one candidate sits under the highest-priority matching
		PathPriority entry, and error otherwise. Ignores `MaxSearchDepth`.
	]=]
	local function unique(targetName: string): ModuleScript?
		local name = normalize(targetName)
		local index = uniqueIndex or buildIndex()
		uniqueIndex = index

		local candidates = index[name]
		if not candidates then return nil end
		for _, candidate in candidates do
			if normalize(candidate.Name) ~= name then
				-- Same rename gap as `nearest`: rebuild once from scratch.
				reset()
				return unique(targetName)
			end
		end
		if #candidates == 1 then return candidates[1] end

		for _, entry in priority do
			local matched = {}
			for _, candidate in candidates do
				if candidate == entry or candidate:IsDescendantOf(entry) then
					table.insert(matched, candidate)
				end
			end
			if #matched == 1 then return matched[1] end
			if #matched > 1 then
				error(`Module "@{targetName}" is ambiguous: {#matched} modules share the name under PathPriority entry "{entry:GetFullName()}" ({describe(matched)}). Rename one, or add a more specific PathPriority entry ahead of it.`)
			end
		end
		error(`Module "@{targetName}" is ambiguous: {#candidates} modules share the name ({describe(candidates)}). Rename one, or add a PathPriority entry to pick a winner.`)
	end

	return {
		nearest = nearest,
		unique  = unique,
		reset   = reset,
	}
end

return {
	new = new,
}
