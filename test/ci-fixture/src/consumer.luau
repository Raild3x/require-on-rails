-- Both requires below are expected to be reported.
local ambiguous = require("@myModule")      -- dropped: two files share the basename
local missing = require("@Nope/DoesNotExist") -- no such alias

-- A commented-out require must NOT be reported: require("@AlsoNotReal")

return { ambiguous, missing }
