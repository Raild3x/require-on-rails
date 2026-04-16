local tiniest_expect = require("../tiniest/tiniest_expect")
type expect = tiniest_expect.expect

return function(t)
	local test = t.test
	local expect = t.expect :: expect
	local describe = t.describe

	local RequireOnRails = require(script.Parent.Parent.RequireOnRails)

	-- ── Pre-made fixture hierarchy ────────────────────────────────────────────────
	--
	-- Fixtures live on disk under specs/Fixtures/ and are synced into the
	-- DataModel by Rojo.  ModuleScript.Source is read-only at runtime, so we
	-- cannot create requireable modules dynamically.
	--
	--  Fixtures/
	--  └── RoR_TestRoot  (Folder)              ← "Root" ancestor key
	--      ├── Context       (ModuleScript)    returns "context_sentinel"
	--      ├── ModuleA       (ModuleScript)    returns "module_a"
	--      ├── ModuleB       (ModuleScript)    returns "module_b"
	--      ├── SubFolder     (Folder)
	--      │   ├── ModuleC   (ModuleScript)    returns "module_c"
	--      │   └── Nested    (Folder)
	--      │       └── ModuleD (ModuleScript)  returns "module_d"--      ├── InitModule    (ModuleScript)    returns "init_module"  ← backed by init.luau
--      │   └── ChildOfInit (ModuleScript)  returns "child_of_init"	--      ├── _Index        (Folder)          auto-ignored by RoR (hardcoded name check)
	--      │   └── IndexedModule (ModuleScript)
	--      ├── Ignorable     (Folder)          ignored via IgnorePredicate in some tests
	--      │   └── IgnorableModule (ModuleScript)
	--      └── SharedName    (ModuleScript)    returns "root_shared"
	--  └── RoR_OtherRoot (Folder)              ← "Other" ancestor key (multi-ancestor tests)
	--      ├── ModuleE       (ModuleScript)    returns "module_e"
	--      └── SharedName    (ModuleScript)    returns "other_shared"

	local fixtures  = script.Parent.Fixtures

	-- Root ancestor
	local root          = fixtures.RoR_TestRoot
	local context       = root.Context
	local moduleA       = root.ModuleA
	local moduleB       = root.ModuleB
	local subFolder     = root.SubFolder
	local moduleC       = subFolder.ModuleC
	local nested        = subFolder.Nested
	local moduleD       = nested.ModuleD
	local initModule    = root.InitModule
	local childOfInit   = initModule.ChildOfInit

	-- Second ancestor (multi-ancestor tests)
	local otherRoot = fixtures.RoR_OtherRoot

	-- Config / import helpers
	local function makeConfig(overrides: { [string]: any }?)
		local o = overrides or {}
		return {
			Ancestors             = o.Ancestors or { Root = root },
			Debug                 = o.Debug,
			IgnorePredicate       = o.IgnorePredicate,
			MaxSearchDepth        = o.MaxSearchDepth,
			CaseSensitive         = o.CaseSensitive,
			Aliases               = o.Aliases,
			TrackPerformance      = o.TrackPerformance,
			CircularDependencyDetection = o.CircularDependencyDetection,
		}
	end

	-- Shorthand: create an import function using the default (or overridden) config.
	local function makeImport(contextInst: Instance?, overrides: { [string]: any }?)
		return RequireOnRails.create(makeConfig(overrides))(contextInst or context)
	end


	-- ── create() ────────────────────────────────────────────────────────────────

	describe("create()", function()
		test("returns a callable generator function", function()
			expect(RequireOnRails.create(makeConfig())).is_a("function")
		end)

		test("calling the generator with an Instance returns a function", function()
			expect(RequireOnRails.create(makeConfig())(context)).is_a("function")
		end)

		test("different generator calls return independent functions", function()
			local gen1 = RequireOnRails.create(makeConfig())
			local gen2 = RequireOnRails.create(makeConfig())
			expect(gen1).never_is(gen2)
		end)

		test("the same generator called twice produces different import functions", function()
			local gen = RequireOnRails.create(makeConfig())
			expect(gen(context)).never_is(gen(context))
		end)
	end)

	-- ── Absolute path resolution (@Ancestor/path/to/Module) ──────────────────────

	describe("Absolute path resolution", function()
		test("finds a direct child of the ancestor", function()
			expect(makeImport()("@Root/ModuleA")).is("module_a")
		end)

		test("finds a module one folder deep", function()
			expect(makeImport()("@Root/SubFolder/ModuleC")).is("module_c")
		end)

		test("finds a module two folders deep", function()
			expect(makeImport()("@Root/SubFolder/Nested/ModuleD")).is("module_d")
		end)

		test("result is identical to require() on the same instance", function()
			expect(makeImport()("@Root/ModuleA")).is(require(moduleA))
		end)

		test("errors when the final segment does not exist", function()
			expect(function()
				makeImport()("@Root/DoesNotExist")
			end).fails_with("not found")
		end)

		test("errors when an intermediate segment does not exist", function()
			expect(function()
				makeImport()("@Root/MissingFolder/ModuleA")
			end).fails_with("does not exist")
		end)

		test("error message contains the original path string", function()
			expect(function()
				makeImport()("@Root/Ghost_xyzabc")
			end).fails_with("@Root/Ghost_xyzabc")
		end)

		test("using an unknown ancestor key errors", function()
			-- "Other" is not registered in the single-ancestor config
			expect(function()
				makeImport()("@Other/ModuleA")
			end).fails_with("Other")
		end)

		test("the ancestor Folder itself is not traversed as a path segment", function()
			-- "@Root/RoR_TestRoot/ModuleA" would be wrong; the ancestor is the
			-- implicit starting point, not a named segment
			expect(function()
				makeImport()("@Root/RoR_TestRoot/ModuleA")
			end).fails()
		end)
	end)

	-- ── Ambiguous path resolution (@ModuleName) ───────────────────────────────────

	describe("Ambiguous path resolution", function()
		test("finds a sibling module of the context", function()
			-- ModuleA and Context are both direct children of root
			expect(makeImport()("@ModuleA")).is("module_a")
		end)

		test("finds a module deeper in the hierarchy (downward search)", function()
			-- ModuleD is root → SubFolder → Nested → ModuleD
			expect(makeImport()("@ModuleD")).is("module_d")
		end)

		test("finds a module when context is deeply nested (upward traversal)", function()
			-- context = ModuleD; ModuleA is a sibling of SubFolder under root
			local importFn = RequireOnRails.create(makeConfig())(moduleD)
			expect(importFn("@ModuleA")).is("module_a")
		end)

		test("context module is findable by name from a sibling context", function()
			local importFn = RequireOnRails.create(makeConfig())(moduleA)
			expect(importFn("@Context")).is("context_sentinel")
		end)

		test("finds a module when context is inside a sub-folder", function()
			local importFn = RequireOnRails.create(makeConfig())(moduleC)
			expect(importFn("@ModuleA")).is("module_a")
		end)

		test("errors when no module with that name exists anywhere", function()
			expect(function()
				makeImport()("@TotallyNonExistent_xyz123")
			end).fails_with("not found")
		end)

		test("errors when the context has no valid ancestor", function()
			local detached = Instance.new("Folder")
			local importFn = RequireOnRails.create(makeConfig())(detached)
			expect(function()
				importFn("@ModuleA")
			end).fails()
			detached:Destroy()
		end)

		test("modules inside _Index folders are never found (auto-ignored)", function()
			-- isValidContainer() always rejects Folders named "_Index"
			expect(function()
				makeImport()("@IndexedModule")
			end).fails_with("not found")
		end)
	end)

	-- ── Alias resolution ──────────────────────────────────────────────────────────

	describe("Alias resolution", function()
		test("expands an alias prefix to the full ancestor key", function()
			local importFn = makeImport(nil, { Aliases = { R = "Root" } })
			expect(importFn("@R/ModuleA")).is("module_a")
		end)

		test("aliased and full paths resolve to the same value", function()
			local importFn = makeImport(nil, { Aliases = { R = "Root" } })
			expect(importFn("@R/ModuleB")).is(importFn("@Root/ModuleB"))
		end)

		test("non-aliased absolute paths still work when aliases are configured", function()
			local importFn = makeImport(nil, { Aliases = { R = "Root" } })
			expect(importFn("@Root/ModuleA")).is("module_a")
		end)

		test("an alias with a multi-segment path resolves correctly", function()
			-- Alias "Sub" → "Root" makes @Sub/SubFolder/ModuleC work
			local importFn = makeImport(nil, { Aliases = { Sub = "Root" } })
			expect(importFn("@Sub/SubFolder/ModuleC")).is("module_c")
		end)

		test("an unknown alias first-segment with a path errors immediately", function()
			local importFn = makeImport(nil, { Aliases = { R = "Root" } })
			-- @Z is not aliased to anything and "Z" is not an ancestor key;
			-- multi-segment paths with an unrecognised key error at lookup time
			expect(function()
				importFn("@Z/NonExistent_xyz456")
			end).fails_with("Z")
		end)
	end)

	-- ── Direct Instance reference ─────────────────────────────────────────────────

	describe("Direct Instance reference", function()
		test("requires a ModuleScript instance directly", function()
			expect(makeImport()(moduleA)).is("module_a")
		end)

		test("result matches native require() on the same instance", function()
			expect(makeImport()(moduleB)).is(require(moduleB))
		end)

		test("errors when the Instance is not a ModuleScript", function()
			expect(function()
				makeImport()(subFolder) -- Folder, not ModuleScript
			end).fails_with("ModuleScript")
		end)
	end)

	-- ── IgnorePredicate ───────────────────────────────────────────────────────────

	describe("IgnorePredicate", function()
		local function ignoreByName(name: string)
			return function(inst: Instance) return inst.Name == name end
		end

		test("modules inside an ignored folder are not found", function()
			local importFn = makeImport(nil, { IgnorePredicate = ignoreByName("Ignorable") })
			expect(function()
				importFn("@IgnorableModule")
			end).fails_with("not found")
		end)

		test("modules outside the ignored folder are still found", function()
			local importFn = makeImport(nil, { IgnorePredicate = ignoreByName("Ignorable") })
			expect(importFn("@ModuleA")).is("module_a")
		end)

		test("ignoring a parent folder hides all descendants", function()
			-- SubFolder contains ModuleC and Nested/ModuleD; ignoring it hides both
			local importFn = makeImport(nil, { IgnorePredicate = ignoreByName("SubFolder") })
			expect(function() importFn("@ModuleC") end).fails_with("not found")
			expect(function() importFn("@ModuleD") end).fails_with("not found")
		end)

		test("modules in non-ignored siblings of ignored folders are still found", function()
			local importFn = makeImport(nil, { IgnorePredicate = ignoreByName("Ignorable") })
			expect(importFn("@ModuleC")).is("module_c")
		end)

		test("the predicate is actually called with Instance arguments", function()
			-- @ModuleA is a direct child of root so no folder traversal occurs;
			-- @ModuleC requires descending into SubFolder, which triggers the predicate.
			local seen: { string } = {}
			makeImport(nil, {
				IgnorePredicate = function(inst: Instance)
					table.insert(seen, inst.Name)
					return false
				end,
			})("@ModuleC")
			expect(#seen).is_greater_than(0)
		end)
	end)

	-- ── Case sensitivity ──────────────────────────────────────────────────────────

	describe("Case sensitivity", function()
		test("matching is case-sensitive by default (absolute path)", function()
			expect(function()
				makeImport()("@Root/modulea") -- wrong case
			end).fails()
		end)

		test("matching is case-sensitive by default (ambiguous path)", function()
			expect(function()
				makeImport()("@MODULEA") -- wrong case
			end).fails_with("not found")
		end)

		test("CaseSensitive = false matches wrong-case final segment (absolute)", function()
			expect(makeImport(nil, { CaseSensitive = false })("@Root/MODULEA")).is("module_a")
		end)

		test("CaseSensitive = false matches wrong-case intermediate folder (absolute)", function()
			expect(makeImport(nil, { CaseSensitive = false })("@Root/SUBFOLDER/ModuleC")).is("module_c")
		end)

		test("CaseSensitive = false matches wrong-case module in ambiguous search", function()
			expect(makeImport(nil, { CaseSensitive = false })("@MODULEB")).is("module_b")
		end)

		test("case-insensitive result matches require() on the actual instance", function()
			expect(makeImport(nil, { CaseSensitive = false })("@Root/moduleb")).is(require(moduleB))
		end)
	end)

	-- ── MaxSearchDepth ────────────────────────────────────────────────────────────
	--
	-- searchForModule uses searchDown(parent, depth):
	--   depth=0  → checks direct children (maxDepth=0: works, deeper: blocked)
	--   depth=1  → one folder down (requires maxDepth ≥ 1)
	--   depth=2  → two folders down (requires maxDepth ≥ 2)
	-- Absolute path traversal (FindFirstChild) is NOT depth-limited.

	describe("MaxSearchDepth", function()
		test("depth=0: direct children of root are found", function()
			-- ModuleA is a direct child of root; found at depth 0
			expect(makeImport(nil, { MaxSearchDepth = 0 })("@ModuleA")).is("module_a")
		end)

		test("depth=0: modules inside sub-folders are not found", function()
			-- ModuleC requires entering SubFolder (depth 1), which is blocked
			expect(function()
				makeImport(nil, { MaxSearchDepth = 0 })("@ModuleC")
			end).fails_with("not found")
		end)

		test("depth=1: modules one folder deep are found", function()
			expect(makeImport(nil, { MaxSearchDepth = 1 })("@ModuleC")).is("module_c")
		end)

		test("depth=1: modules two folders deep are not found", function()
			-- ModuleD is SubFolder → Nested → ModuleD (depth 2 required)
			expect(function()
				makeImport(nil, { MaxSearchDepth = 1 })("@ModuleD")
			end).fails_with("not found")
		end)

		test("depth=2: modules two folders deep are found", function()
			expect(makeImport(nil, { MaxSearchDepth = 2 })("@ModuleD")).is("module_d")
		end)

		test("absolute path resolution ignores MaxSearchDepth", function()
			-- Explicit path (@Root/…/…) uses FindFirstChild, not bfsFindPath
			local importFn = makeImport(nil, { MaxSearchDepth = 0 })
			expect(importFn("@Root/SubFolder/Nested/ModuleD")).is("module_d")
		end)
	end)

	-- ── Caching ───────────────────────────────────────────────────────────────────

	describe("Caching", function()
		test("the same absolute path resolved twice returns an identical value", function()
			local importFn = makeImport()
			expect(importFn("@Root/ModuleA")).is(importFn("@Root/ModuleA"))
		end)

		test("the same ambiguous path resolved twice returns an identical value", function()
			local importFn = makeImport()
			expect(importFn("@ModuleB")).is(importFn("@ModuleB"))
		end)

		test("the same absolute path from two different contexts returns the same value", function()
			-- unambiguousStringToModuleCache is per-generator but keyed by path string
			local gen = RequireOnRails.create(makeConfig())
			local fromContext = gen(context)("@Root/ModuleA")
			local fromNested  = gen(moduleC)("@Root/ModuleA")
			expect(fromContext).is(fromNested)
		end)

		test("ancestry change on a module does not throw during cache invalidation", function()
			local tempParent = Instance.new("Folder")
			tempParent.Name = "TempParent"
			tempParent.Parent = game.Workspace

			local tempMod = Instance.new("ModuleScript")
			tempMod.Name = "TempMod"
			tempMod.Parent = tempParent

			local ctx = Instance.new("ModuleScript")
			ctx.Name = "TempCtx"
			ctx.Parent = tempParent

			local gen       = RequireOnRails.create({ Ancestors = { Temp = tempParent } })
			local _importFn = gen(ctx) -- creates context cache entry

			expect(function()
				tempMod.Parent = nil -- triggers AncestryChanged → cache wipe
			end).never_fails()

			ctx:Destroy()
			tempMod:Destroy()
			tempParent:Destroy()
		end)
	end)

	-- ── Multiple ancestors ────────────────────────────────────────────────────────

	describe("Multiple ancestors", function()
		local function makeDualImport()
			return RequireOnRails.create({
				Ancestors = { Root = root, Other = otherRoot },
			})(context)
		end

		test("absolute path to the first ancestor finds its module", function()
			expect(makeDualImport()("@Root/ModuleA")).is("module_a")
		end)

		test("absolute path to the second ancestor finds its module", function()
			expect(makeDualImport()("@Other/ModuleE")).is("module_e")
		end)

		test("same-named modules in different ancestors are independently addressable", function()
			local importFn = makeDualImport()
			local fromRoot  = importFn("@Root/SharedName")
			local fromOther = importFn("@Other/SharedName")
			expect(fromRoot).is("root_shared")
			expect(fromOther).is("other_shared")
			expect(fromRoot).never_is(fromOther)
		end)

		test("ambiguous search falls back to the second ancestor when needed", function()
			-- ModuleE does not exist under root, so searchRoots tries otherRoot
			expect(makeDualImport()("@ModuleE")).is("module_e")
		end)
	end)

	-- ── Performance tracking ──────────────────────────────────────────────────────

	describe("Performance tracking", function()
		test("getPerformanceStats returns a table with the expected numeric fields", function()
			local stats = RequireOnRails.getPerformanceStats()
			expect(stats).is_a("table")
			expect(stats.cacheHits).is_a("number")
			expect(stats.cacheMisses).is_a("number")
			expect(stats.searchTime).is_a("number")
			expect(stats.averageSearchTime).is_a("number")
		end)

		test("cacheHits increments when an absolute path is resolved from cache", function()
			local importFn = RequireOnRails.create(makeConfig({ TrackPerformance = true }))(context)
			importFn("@Root/ModuleA") -- first call: cache miss
			local before = RequireOnRails.getPerformanceStats()
			importFn("@Root/ModuleA") -- second call: cache hit (global cache)
			local after = RequireOnRails.getPerformanceStats()
			expect(after.cacheHits).is_greater_than(before.cacheHits)
		end)

		test("averageSearchTime is always non-negative", function()
			expect(RequireOnRails.getPerformanceStats().averageSearchTime).is_greater_or_equal_to(0)
		end)
	end)

	-- ── Debug output ──────────────────────────────────────────────────────────────

	describe("Debug output", function()
		test("Debug = true emits [RequireOnRails DEBUG] prints during resolution", function()
			local importFn = makeImport(nil, { Debug = true })
			expect(function()
				importFn("@Root/ModuleA")
			end).prints("%[RequireOnRails DEBUG%]")
		end)

		test("Debug = false (default) emits no debug prints", function()
			local importFn = makeImport(nil, { Debug = false })
			expect(function()
				importFn("@Root/ModuleB")
			end).never_prints("%[RequireOnRails DEBUG%]")
		end)
	end)

	-- ── init.luau modules ────────────────────────────────────────────────────────
	--
	-- In Rojo a directory containing init.luau becomes a ModuleScript (not a
	-- Folder) while sibling .luau files become children of that ModuleScript.
	-- RoR must handle such ModuleScript containers correctly in every code path.

	describe("init.luau modules", function()
		test("the init.luau module itself is requireable via absolute path", function()
			expect(makeImport()("@Root/InitModule")).is("init_module")
		end)

		test("a child of an init.luau module is reachable via absolute path", function()
			-- Absolute traversal calls :FindFirstChild on each segment, which works
			-- on ModuleScript parents just as on Folders.
			expect(makeImport()("@Root/InitModule/ChildOfInit")).is("child_of_init")
		end)

		test("the init.luau module is found by ambiguous search", function()
			-- searchDown checks IsA(ModuleScript) first; InitModule matches by name.
			expect(makeImport()("@InitModule")).is("init_module")
		end)

		test("a child of an init.luau module is found by ambiguous search", function()
			-- isValidContainer accepts ModuleScript instances, so searchDown recurses
			-- into InitModule and finds ChildOfInit inside it.
			expect(makeImport()("@ChildOfInit")).is("child_of_init")
		end)

		test("the init.luau module is requireable via direct Instance reference", function()
			expect(makeImport()(initModule)).is("init_module")
		end)

		test("a child of an init.luau module is requireable via direct Instance reference", function()
			expect(makeImport()(childOfInit)).is("child_of_init")
		end)

		test("context inside an init.luau module can resolve siblings", function()
			-- Using childOfInit as the context; ModuleA is in the parent tree.
			local importFn = RequireOnRails.create(makeConfig())(childOfInit)
			expect(importFn("@ModuleA")).is("module_a")
		end)
	end)

	-- ── Circular dependency detection ─────────────────────────────────────────────

	-- ── Circular dependency detection ─────────────────────────────────────────────
	--
	-- A true circular-dependency trigger requires a fixture module whose source
	-- calls back into the RoR import function while it is being required.
	-- ModuleScript.Source is read-only at runtime, so pre-made fixture files
	-- cannot be written to create that re-entrant call.  The tests below
	-- therefore cover what is verifiable: that the feature does not break normal
	-- (non-circular) resolution when enabled or disabled.

	describe("Circular dependency detection", function()
		test("enabled: successful requires still work normally", function()
			local importFn = makeImport(nil, { CircularDependencyDetection = true })
			expect(importFn("@Root/ModuleA")).is("module_a")
		end)

		test("disabled: successful requires still work normally", function()
			local importFn = makeImport(nil, { CircularDependencyDetection = false })
			expect(importFn("@Root/ModuleA")).is("module_a")
		end)
	end)

    
end
