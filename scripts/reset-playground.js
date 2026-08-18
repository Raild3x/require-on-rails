#!/usr/bin/env node
// Rebuilds test-playground/ to its pristine state. Run: npm run playground:reset
// Safe to run while the extension dev host has the folder open — editors reload from disk.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'test-playground');

const FILES = {
    '.vscode/settings.json': `{
    // "require-on-rails.mode" is deliberately NOT set, so the first-activation
    // mode prompt appears. Pick Explicit to try the new features.
    "require-on-rails.startsImmediately": true,
    "require-on-rails.directoriesToScan": [
        "src/Server",
        "src/Client",
        "src/Shared"
    ],
    // Set while in explicit mode to see the ignored-setting warning on this file:
    "require-on-rails.manualAliases": {
        "Server": "src/Server",
        "Client": "src/Client",
        "Shared": "src/Shared"
    }
}
`,
    '.luaurc': `{
    "aliases": {
        "Server": "src/Server",
        "Client": "src/Client",
        "Shared": "src/Shared"
    }
}
`,
    'default.project.json': `{
    "name": "Playground",
    "tree": {
        "$className": "DataModel",
        "ReplicatedStorage": {
            "$className": "ReplicatedStorage",
            "src": {
                "$className": "Folder",
                "Client": { "$className": "Folder", "$path": "src/Client" },
                "Shared": { "$className": "Folder", "$path": "src/Shared" }
            }
        },
        "ServerScriptService": {
            "$className": "ServerScriptService",
            "src": {
                "$className": "Folder",
                "Server": { "$className": "Folder", "$path": "src/Server" }
            }
        }
    }
}
`,
    'src/Client/UI/Menu.luau': `--!strict
-- PLAYGROUND: things to try in explicit mode (watch the strings rewrite):
--
-- 1. Completion: on a new line, type   require("@myMo   — the list should show BOTH
--    myModule files, the Client/Utils one first (it is closer to this file).
-- 2. Auto-replace: type   require("@myModule")   in full, then click elsewhere —
--    the string becomes @Client/Utils/myModule (or ./ form, per your style settings).
-- 3. Save sweep: the bare require below is rewritten when you save this file,
--    as long as your cursor is not inside the string.
-- 4. Diagnostics: the @Nope require below gets a Problems-panel warning.
-- 5. Renames: rename myModule.luau under Utils — you get a prompt before inbound
--    requires update. Move this file into another folder — its relative requires
--    (if any) are fixed automatically.

local myModule = require("@myModule")

local broken = require("@Nope/DoesNotExist")

local dataFolder = require("@Shared/Data")

return { myModule = myModule, broken = broken, dataFolder = dataFolder }
`,
    'src/Client/Utils/myModule.luau': `--!strict
-- One of two modules named "myModule" — duplicates are fine in explicit mode.
return { where = "Client/Utils" }
`,
    'src/Shared/Stuff/myModule.luau': `--!strict
-- The farther of the two "myModule" candidates when editing from src/Client/UI.
return { where = "Shared/Stuff" }
`,
    'src/Shared/Data/init.luau': `--!strict
-- Folder module: requires of "Data" resolve here. Try require("@self/Config") from
-- this file, and require("@Data") from elsewhere.
return { name = "Data" }
`,
    'src/Shared/Data/Config.luau': `--!strict
return { setting = true }
`,
    'src/Server/Systems/thing.luau': `--!strict
-- Equidistant from both myModule files — useful for testing pathPriority tie-breaks.
return { where = "Server/Systems" }
`
};

fs.rmSync(root, { recursive: true, force: true });
for (const [rel, content] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}
console.log(`Playground reset: ${root}`);
