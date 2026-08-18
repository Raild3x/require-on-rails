-- Stale: Build conversion is enabled, so this boilerplate must be reported.
local Import = require(game:GetService("ReplicatedStorage"):FindFirstChild("Import", true))
require = Import(script)

-- Valid: converts to a relative string.
local viaAlias = require("@Shared/Real")

-- Broken: nothing lives at that path, so the build cannot convert it.
local missingFile = require("@Shared/Ghost")

return { viaAlias, missingFile }
