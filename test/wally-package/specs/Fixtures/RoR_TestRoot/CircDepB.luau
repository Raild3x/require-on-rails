-- Fixture for circular dependency detection tests in RequireOnRails.spec.luau.
-- Acquires the active importer from Import.luau and uses it to require CircDepA
-- through RoR, closing the cycle:
--   CircDepA → (RoR) → CircDepB → (RoR) → CircDepA  ← detected here
--
-- Import.reset() must be called before each test that requires this module so
-- that Luau's module cache is cleared and this body actually re-executes.
local Import = require(script.Parent.Parent.Import)
return Import(script)(script.Parent.CircDepA)
