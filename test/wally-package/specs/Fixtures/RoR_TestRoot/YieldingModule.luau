-- Fixture used by the concurrent-require test in RequireOnRails.spec.luau.
--
-- Calls task.wait() so that requiring this module suspends the calling
-- coroutine, exercising RoR's per-coroutine tracking tables.
--
-- Import.reset() is called before the test that uses this fixture, which clones
-- and replaces the fixture instance so Luau's module cache is clear and this
-- body re-executes on every test run.
task.wait()
return "yielding_module"
