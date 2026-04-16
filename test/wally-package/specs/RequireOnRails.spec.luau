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
			Aliases               = o.Aliases or { Root = root },
			Ancestors             = o.Ancestors,
			Debug                 = o.Debug,
			IgnorePredicate       = o.IgnorePredicate,
			MaxSearchDepth        = o.MaxSearchDepth,
			CaseSensitive         = o.CaseSensitive,
			CircularDependencyDetection = o.CircularDependencyDetection,
			DisableCache          = o.DisableCache,
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

		test("using 'self' as an alias key errors at creation time", function()
			expect(function()
				RequireOnRails.create({ Aliases = { self = root } })
			end).fails_with("reserved")
		end)

		test("using 'game' as an alias key errors at creation time", function()
			expect(function()
				RequireOnRails.create({ Aliases = { game = root } })
			end).fails_with("reserved")
		end)

		test("Ancestors field is accepted as a backwards-compatible alternative to Aliases", function()
			local importFn = RequireOnRails.create({ Ancestors = { Root = root } })(context)
			expect(importFn("@Root/ModuleA")).is("module_a")
		end)

		test("Ancestors and Aliases can coexist; Aliases takes precedence on key conflict", function()
			-- Both define "Root"; Aliases wins. Ancestors contributes "Other".
			local importFn = RequireOnRails.create({
				Aliases   = { Root = root },
				Ancestors = { Root = otherRoot, Other = otherRoot },
			})(context)
			expect(importFn("@Root/ModuleA")).is("module_a")  -- root wins, not otherRoot
			expect(importFn("@Other/ModuleE")).is("module_e") -- from Ancestors
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

	-- ── Parent traversal (..) in paths ───────────────────────────────────────────
	--
	-- ".." climbs one level via .Parent, mirroring Luau LSP behaviour.
	-- The first segment must always be an ancestor key or an ambiguous module
	-- name — bare "@../..." is invalid.  ".." is only permitted in subsequent
	-- segments once a starting instance has been resolved.
	--
	--   Absolute:  @AncestorKey/child/../sibling
	--     Traversal begins at the registered ancestor instance.
	--
	--   Ambiguous: @ModuleName/../sibling
	--     The module is found by search; traversal then continues from it.

	describe("Parent traversal (..) in paths", function()

		-- ── Error: ".." as the very first segment ────────────────────────

		test("@../anything is rejected — .. cannot be the first segment", function()
			expect(function()
				makeImport()("@../ModuleA")
			end).fails()
		end)

		-- ── Absolute paths with .. ────────────────────────────────────────

		test("absolute: single .. backtracks one folder and finds sibling", function()
			-- @Root/SubFolder/../ModuleA
			--   root → SubFolder → .. → root → ModuleA
			expect(makeImport()("@Root/SubFolder/../ModuleA")).is("module_a")
		end)

		test("absolute: double .. backtracks two folders", function()
			-- @Root/SubFolder/Nested/../../ModuleA
			--   root → SubFolder → Nested → .. → SubFolder → .. → root → ModuleA
			expect(makeImport()("@Root/SubFolder/Nested/../../ModuleA")).is("module_a")
		end)

		test("absolute: .. then descend into a different sub-folder", function()
			-- @Root/SubFolder/../SubFolder/ModuleC  (roundabout but valid)
			expect(makeImport()("@Root/SubFolder/../SubFolder/ModuleC")).is("module_c")
		end)

		test("absolute: .. then descend into nested folder", function()
			expect(makeImport()("@Root/SubFolder/../SubFolder/Nested/ModuleD")).is("module_d")
		end)

		test("absolute: .. can climb above the ancestor boundary to reach a sibling tree", function()
			-- RoR_OtherRoot is a sibling of RoR_TestRoot under Fixtures.
			-- @Root/../RoR_OtherRoot/ModuleE climbs from Root up to Fixtures,
			-- then descends into RoR_OtherRoot.
			local importFn = RequireOnRails.create({
				Aliases = { Root = root, Other = otherRoot },
			})(context)
			expect(importFn("@Root/../RoR_OtherRoot/ModuleE")).is("module_e")
		end)

		test("absolute: .. path and direct path for the same module return the same value", function()
			local importFn = makeImport()
			expect(importFn("@Root/SubFolder/../ModuleA")).is(importFn("@Root/ModuleA"))
		end)

		test("absolute: .. path is cached and returns the same value on repeat calls", function()
			local importFn = makeImport()
			expect(importFn("@Root/SubFolder/../ModuleA")).is(importFn("@Root/SubFolder/../ModuleA"))
		end)

		test("absolute: errors when .. goes above the DataModel root", function()
			expect(function()
				makeImport()("@Root/../../../../../../../../../../../../../DoesNotExist")
			end).fails()
		end)

		test("absolute: errors when a named segment after .. does not exist", function()
			expect(function()
				makeImport()("@Root/SubFolder/../NonExistent_xyz")
			end).fails_with("not found")
		end)

		-- ── Ambiguous module name followed by .. ──────────────────────────
		-- The first segment is found by search; subsequent segments (including
		-- "..") are traversed from the resolved module instance.

		test("ambiguous + ..: find module then climb one level to its parent folder", function()
			-- @ModuleC/.. → finds moduleC (at SubFolder/ModuleC) → .. → SubFolder
			-- SubFolder is a Folder, not a ModuleScript, so this should error on
			-- the IsA("ModuleScript") assert — verifying traversal happened.
			expect(function()
				makeImport()("@ModuleC/..")
			end).fails()
		end)

		test("ambiguous + ..: find module then climb and descend to a sibling", function()
			-- @ModuleC/../ModuleC → finds moduleC → SubFolder → ModuleC (same module)
			expect(makeImport()("@ModuleC/../ModuleC")).is("module_c")
		end)

		test("ambiguous + ..: double .. climbs from module to ancestor root", function()
			-- @ModuleC/../../ModuleA → moduleC → SubFolder → root → ModuleA
			expect(makeImport()("@ModuleC/../../ModuleA")).is("module_a")
		end)

		test("ambiguous + ..: triple .. from deeply nested module", function()
			-- @ModuleD/../../../ModuleA → moduleD → Nested → SubFolder → root → ModuleA
			expect(makeImport()("@ModuleD/../../../ModuleA")).is("module_a")
		end)

		test("ambiguous + ..: result is context-dependent and cached per-context", function()
			local importFn = makeImport()
			expect(importFn("@ModuleC/../../ModuleA")).is(importFn("@ModuleC/../../ModuleA"))
		end)

		test("ambiguous + ..: errors when a named segment after .. does not exist", function()
			expect(function()
				makeImport()("@ModuleC/../NonExistent_xyz")
			end).fails_with("not found")
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
	--
	-- String values in Aliases act as short aliases.  A string-valued entry maps to
	-- another key (with optional sub-path prefix) in the same table.
	-- e.g. Aliases = { Root = root, R = "Root", Svc = "Root/SubFolder" }

	describe("Alias resolution", function()
		test("string entry in Aliases expands to the target ancestor key", function()
			local importFn = makeImport(nil, { Aliases = { Root = root, R = "Root" } })
			expect(importFn("@R/ModuleA")).is("module_a")
		end)

		test("aliased and full paths resolve to the same value", function()
			local importFn = makeImport(nil, { Aliases = { Root = root, R = "Root" } })
			expect(importFn("@R/ModuleB")).is(importFn("@Root/ModuleB"))
		end)

		test("non-aliased keys still work alongside aliases", function()
			local importFn = makeImport(nil, { Aliases = { Root = root, R = "Root" } })
			expect(importFn("@Root/ModuleA")).is("module_a")
		end)

		test("an alias with a sub-path expansion resolves correctly", function()
			-- "Sub" expands to "Root/SubFolder", so @Sub/ModuleC → root/SubFolder/ModuleC
			local importFn = makeImport(nil, { Aliases = { Root = root, Sub = "Root/SubFolder" } })
			expect(importFn("@Sub/ModuleC")).is("module_c")
		end)

		test("multiple string aliases can coexist in the same Aliases table", function()
			local importFn = makeImport(nil, { Aliases = { Root = root, R = "Root", S = "Root" } })
			expect(importFn("@R/ModuleA")).is("module_a")
			expect(importFn("@S/ModuleB")).is("module_b")
		end)

		test("create() errors when a string alias points to a non-existent ancestor key", function()
			expect(function()
				RequireOnRails.create({ Aliases = { R = "NonExistentKey" } })
			end).fails_with("NonExistentKey")
		end)

		test("create() errors when a string alias sub-path prefix points to a non-existent ancestor key", function()
			expect(function()
				RequireOnRails.create({ Aliases = { Sub = "Ghost/SubFolder" } })
			end).fails_with("Ghost")
		end)
		
		test("a segment not matching any key falls through to ambiguous search", function()
			-- "Z" is not an alias key; single-segment path → ambiguous search → not found
			local importFn = makeImport(nil, { Aliases = { Root = root, R = "Root" } })
			expect(function()
				importFn("@Z_Nonexistent_xyz456")
			end).fails_with("not found")
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

			local gen       = RequireOnRails.create({ Aliases = { Temp = tempParent } })
			local _importFn = gen(ctx) -- creates context cache entry

			expect(function()
				tempMod.Parent = nil -- triggers AncestryChanged → cache wipe
			end).never_fails()

			ctx:Destroy()
			tempMod:Destroy()
			tempParent:Destroy()
		end)

		test("DisableCache = true: resolution still returns the correct value", function()
			local importFn = makeImport(nil, { DisableCache = true })
			expect(importFn("@Root/ModuleA")).is("module_a")
			expect(importFn("@ModuleB")).is("module_b")
		end)
	end)

	-- ── Multiple ancestors ────────────────────────────────────────────────────────

	describe("Multiple ancestors", function()
		local function makeDualImport()
			return RequireOnRails.create({
				Aliases = { Root = root, Other = otherRoot },
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

	-- ── Nested ancestors (inner ancestor is a descendant of outer) ────────────────
	--
	-- Register both RoR_TestRoot ("Root") and RoR_TestRoot.SubFolder ("Sub") as
	-- ancestors simultaneously.  "Sub" is physically nested inside "Root", so the
	-- two ancestor roots share a common subtree.  Tests verify that:
	--   1. Absolute paths keyed to each ancestor are independently correct.
	--   2. The primaryRoot walk-up binds a context to its *closest* ancestor.
	--   3. Ambiguous search from an inner-context is correctly bounded at the inner
	--      ancestor boundary before falling back to searchRoots.
	--   4. The fallback (searchRoots) still reaches modules sitting exclusively in
	--      the outer ancestor's subtree.

	describe("Nested ancestors", function()
		local function makeNestedImport(contextInst: Instance?)
			return RequireOnRails.create({
				Aliases = { Root = root, Sub = subFolder },
			})(contextInst or context)
		end

		-- ── Absolute path resolution ──────────────────────────────────────────

		test("@Sub/ModuleC: direct child of inner ancestor resolves correctly", function()
			expect(makeNestedImport()("@Sub/ModuleC")).is("module_c")
		end)

		test("@Sub/Nested/ModuleD: deeper descendant of inner ancestor resolves correctly", function()
			expect(makeNestedImport()("@Sub/Nested/ModuleD")).is("module_d")
		end)

		test("@Root/ModuleA: outer ancestor continues to resolve its own direct modules", function()
			expect(makeNestedImport()("@Root/ModuleA")).is("module_a")
		end)

		test("@Root/SubFolder/ModuleC: explicit outer path walking through the inner ancestor folder works", function()
			-- Walking through SubFolder from Root is still valid even though
			-- SubFolder is also independently registered as the "Sub" ancestor.
			expect(makeNestedImport()("@Root/SubFolder/ModuleC")).is("module_c")
		end)

		test("@Root/SubFolder/Nested/ModuleD: long explicit path from outer ancestor resolves correctly", function()
			expect(makeNestedImport()("@Root/SubFolder/Nested/ModuleD")).is("module_d")
		end)

		test("@Sub/... and @Root/SubFolder/... paths for the same module resolve to the same value", function()
			local importFn = makeNestedImport()
			expect(importFn("@Sub/ModuleC")).is(importFn("@Root/SubFolder/ModuleC"))
		end)

		-- ── primaryRoot detection — inner ancestor wins for nested contexts ────

		test("context inside inner ancestor: ambiguous search for own module stays bounded", function()
			-- moduleC lives in SubFolder (Sub). Walk-up from moduleC hits SubFolder
			-- before Root, making SubFolder the primaryRoot. Searching @ModuleC
			-- should find it within that boundary without needing a fallback.
			local importFn = makeNestedImport(moduleC)
			expect(importFn("@ModuleC")).is("module_c")
		end)

		test("context inside inner ancestor: deeper child within inner is found", function()
			-- ModuleD is under SubFolder/Nested, still inside the inner boundary.
			local importFn = makeNestedImport(moduleC)
			expect(importFn("@ModuleD")).is("module_d")
		end)

		test("context inside outer but outside inner: full outer tree is searched (finds ModuleC)", function()
			-- moduleA is a direct child of root, not inside SubFolder.
			-- primaryRoot is root, so searchForModule descends through the whole
			-- root subtree — including SubFolder — and finds ModuleC.
			local importFn = makeNestedImport(moduleA)
			expect(importFn("@ModuleC")).is("module_c")
		end)

		test("context inside outer but outside inner: finds module inside inner/nested subtree", function()
			local importFn = makeNestedImport(moduleA)
			expect(importFn("@ModuleD")).is("module_d")
		end)

		-- ── Ambiguous fallback when the module is outside the inner boundary ──

		test("context in inner ancestor: module that lives only in outer falls back via searchRoots", function()
			-- @ModuleA does not exist inside SubFolder. The upward walk stops at
			-- the Sub boundary; searchRoots then locates it under Root.
			local importFn = makeNestedImport(moduleC)
			expect(importFn("@ModuleA")).is("module_a")
		end)

		test("context in inner ancestor: another outer-only module (ModuleB) also falls back correctly", function()
			local importFn = makeNestedImport(moduleC)
			expect(importFn("@ModuleB")).is("module_b")
		end)

		test("context in inner ancestor: SharedName (sibling of SubFolder in outer) falls back correctly", function()
			-- root.SharedName is a sibling of SubFolder, not inside it.
			-- The inner-boundary stop forces the fallback path to find it.
			local importFn = makeNestedImport(moduleC)
			expect(importFn("@SharedName")).is("root_shared")
		end)

		-- ── Error cases ───────────────────────────────────────────────────────

		test("unknown ancestor key errors even when nested ancestors are configured", function()
			expect(function()
				makeNestedImport()("@Unknown/Module")
			end).fails_with("Unknown")
		end)

		test("module absent from both ancestors errors with 'not found'", function()
			expect(function()
				makeNestedImport()("@TotallyAbsent_xy999")
			end).fails_with("not found")
		end)
	end)

	-- ── Performance tracking ──────────────────────────────────────────────────────
	-- DEPRECATED - performance tracking was removed in v0.2.0; these tests are retained for reference but are no longer run.

	-- describe("Performance tracking", function()
	-- 	test("getPerformanceStats returns a table with the expected numeric fields", function()
	-- 		local stats = RequireOnRails.getPerformanceStats()
	-- 		expect(stats).is_a("table")
	-- 		expect(stats.cacheHits).is_a("number")
	-- 		expect(stats.cacheMisses).is_a("number")
	-- 		expect(stats.searchTime).is_a("number")
	-- 		expect(stats.averageSearchTime).is_a("number")
	-- 	end)

	-- 	test("cacheHits increments when an absolute path is resolved from cache", function()
	-- 		local importFn = RequireOnRails.create(makeConfig({ TrackPerformance = true }))(context)
	-- 		importFn("@Root/ModuleA") -- first call: cache miss
	-- 		local before = RequireOnRails.getPerformanceStats()
	-- 		importFn("@Root/ModuleA") -- second call: cache hit (global cache)
	-- 		local after = RequireOnRails.getPerformanceStats()
	-- 		expect(after.cacheHits).is_greater_than(before.cacheHits)
	-- 	end)

	-- 	test("averageSearchTime is always non-negative", function()
	-- 		expect(RequireOnRails.getPerformanceStats().averageSearchTime).is_greater_or_equal_to(0)
	-- 	end)
	-- end)

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

	-- ── Roblox built-in aliases ──────────────────────────────────────────────────
	--
	-- @self and @game are Roblox's native require-by-string aliases and must be
	-- passed through to the engine's require() unchanged. RoR must not intercept
	-- them as unknown ancestor keys.

	describe("Roblox built-in aliases", function()
		test("@self/ path is not intercepted as an unknown ancestor key", function()
			local importFn = makeImport()
			-- Will fail (module doesn't exist at that path) but must NOT produce
			-- RoR's "Unknown ancestor key" error; native require handles it.
			expect(function()
				importFn("@self/NonExistent_xyxyz")
			end).never_fails_with("Unknown ancestor key")
		end)

		test("@game/ path is not intercepted as an unknown ancestor key", function()
			local importFn = makeImport()
			expect(function()
				importFn("@game/NonExistent_xyxyz")
			end).never_fails_with("Unknown ancestor key")
		end)

		test("@self/ path is not intercepted as a missing RoR module", function()
			local importFn = makeImport()
			expect(function()
				importFn("@self/NonExistent_xyxyz")
			end).never_fails_with("not found in any valid ancestor")
		end)

		test("@game/ path is not intercepted as a missing RoR module", function()
			local importFn = makeImport()
			expect(function()
				importFn("@game/NonExistent_xyxyz")
			end).never_fails_with("not found in any valid ancestor")
		end)
	end)

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
