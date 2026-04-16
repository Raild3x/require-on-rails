--!strict
-- Microprofiler integration for RequireOnRails.

local profileBegin = debug.profilebegin
local profileEnd   = debug.profileend

local LABELS = {
	REQUIRE          = "RoR:Require",
	CACHE_HIT        = "RoR:CacheHit",
	CACHE_MISS       = "RoR:CacheMiss",
	ALIAS_RESOLVE    = "RoR:AliasResolve",
	BFS_SEARCH       = "RoR:BfsSearch",
	MODULE_SEARCH    = "RoR:ModuleSearch",
	ROOT_SEARCH      = "RoR:RootSearch",
	PATH_TRAVERSE    = "RoR:PathTraverse",
	CACHE_INVALIDATE = "RoR:CacheInvalidate",
	MODULE_LOAD      = "RoR:ModuleLoad",
}

--[=[
	Wraps a function call with optional microprofiler profiling.
	When `enabled` is false, `fn` is called directly with no overhead.

	@param enabled -- Whether microprofiling is active
	@param label   -- Profiler label string
	@param fn      -- Function to invoke
	@return        -- The return value(s) of fn
]=]
local function call<T...>(enabled: boolean, label: string, fn: (...any) -> T...): T...
	if enabled then
		profileBegin(label)
		local results = table.pack(fn())
		profileEnd()
		return table.unpack(results, 1, results.n)
	else
		return fn()
	end
end

return {
	LABELS = LABELS,
	call   = call,
}
