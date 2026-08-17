-- Valid: resolves through the .luaurc alias root, and must NOT be reported.
local viaAlias = require("@Shared/Real")
-- Valid: relative to this file.
local viaRelative = require("./Real")

-- Broken: the alias root exists but nothing lives at that path.
local missingFile = require("@Shared/Ghost")
-- Broken: no such alias root.
local missingAlias = require("@Nope/Thing")

return { viaAlias, viaRelative, missingFile, missingAlias }
