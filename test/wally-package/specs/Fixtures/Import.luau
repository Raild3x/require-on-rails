local RoR = require(script.Parent.Parent.Parent.RequireOnRails)

local Importer = nil

local self = {}

-- Clear all modules so they are no longer cached by Roblox's require() system
function self.reset()
    for _, obj in script.Parent:GetChildren() do
        if obj ~= script then
            local copy = obj:Clone()
            obj:Destroy()
            copy.Parent = script.Parent
        end
    end
    Importer = nil
end


-- setup the Importer with the given config, returning the Import function to use in tests. Fixture submodules can require this to get the same Import function as the test code, ensuring they share the same cache and config.
-- Call reset() ahead of this only when the test needs fixture module *bodies* to re-execute
-- (e.g. circular dependency tests, yielding tests). reset() destroys and re-clones all fixture
-- instances, so any cached Instance references held by the caller become stale after the call.
function self.create(...)
    local importer = RoR.create(...)
    Importer = importer
    return importer
end

return setmetatable(self, {
    __call = function(_, script)
        assert(Importer, "Importer not created yet! Call Importer.create(config) first.")
        return Importer(script)
    end,
})