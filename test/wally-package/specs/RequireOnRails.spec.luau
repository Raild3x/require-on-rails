local tiniest_expect = require("./tiniest/tiniest_expect")

return function(t)
    local test = t.test
    local expect = t.expect :: typeof(tiniest_expect)
    local describe = t.describe

    local RequireOnRails = require(script.Parent.Parent.RequireOnRails)
    -- local RequireOnRails = require("")
    print("RequireOnRails.spec.luau loaded")
end

