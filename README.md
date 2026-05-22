# RequireOnRails

An opinionated Roblox Luau utility extension that simplifies working with complex codebase hierarchies by automatically generating file aliases and managing import statements. It works in conjunction with Luau LSP and a custom requirer module in order to parse the non-standard string paths.

RequireOnRails does *not* prevent you from utilizing any default require behaviors. If the Luau module detects a non aliased path it will fall back to the default Roblox require behavior.

## Features

### Automatic File Alias Generation
RequireOnRails scans your workspace directories and automatically generates aliases in your `.luaurc` file, allowing you to import modules by their basename instead of complex relative paths.

**Before:**
```lua
local MyModule = require(script.Parent.Parent.Shared.Utils.MyModule)
```

**After:**
```lua
local MyModule = require("@MyModule")
```

<details>
<summary>More Features:</summary>

### Import Line Management
The extension automatically hides or reduces the opacity of boilerplate import lines in your Luau files, keeping your editor clean while maintaining functionality.

### Smart Directory Scanning
- Scans specified directories for `.lua` and `.luau` files
- Handles `init.lua` files by aliasing the containing folder name
- Resolves naming conflicts by preferring unique basenames
- Ignores specified directories (like directories starting with `_` for private modules)

### Require Statement Updates
- Automatically detects file renames and moves
- Prompts to update basename require statements when files are renamed
- Handles absolute path updates when files are moved between alias directories
- Configurable collision detection with automatic duplicate file renaming

### Import Management Enhancements
- Automatic import require definition detection and insertion
- Multiple placement options for import statements (top of file, before first require, after services)
- Optional Selene comment support for import lines
- Centralized import validation logic
- Configurable contextual import insertion template via `require-on-rails.contextualImportTemplate`
- Supports both single-line and multiline contextual import detection/hiding (including optional type annotations/comments)

### Status Bar Integration
Toggle the extension on/off with a convenient status bar button showing the current state.

![Status Button Image](images/ReadMe/StatusButtonImage.jpeg)

</details>

## Requirements
- Visual Studio Code
- Luau LSP VSCode extension (or some other form of Roblox Luau language support)
- RequireOnRails Luau module
- A project structure with unique file basenames (no duplicate names across scanned directories)
  
### Default Expected Project Structure
For the default configuration settings, RequireOnRails expects the following project structure:

```
your-project/
├── .vscode/
│   └── settings.json
├── Packages/             # Wally Packages
│   └── RequireOnRails.lua
├── src/
│   ├── Import.luau       # Import module tailored to your project
│   ├── Server/           # Server-side code (@Server alias)
│   ├── Client/           # Client-side code (@Client alias)
│   └── Shared/           # Shared code (@Shared alias)
├── .luaurc               # Generated/maintained by extension
├── default.project.json
└── wally.toml
```
Your project will likely look something like this:

![ProjectTemplateScreenshot](images/ReadMe/ProjectTemplateScreenshot.jpeg)

If your project structure does not follow this exactly then you can configure the extension settings to match your project as needed.

## Quick Start

### Option 1: Use Template
1. Open a fresh workspace in VS Code
2. Open Command Palette (`Ctrl+Shift+P`)
3. Run `Setup Default Project Structure`
4. Activate RequireOnRails using the status bar button
5. Start coding with `require("@ModuleName")` syntax!

### Option 2: Manual Setup
1. Create your project structure manually
2. Configure `directoriesToScan`, `manualAliases`, and `importModulePaths` in VS Code settings to match your project
3. Get the RequireOnRails Luau module (You can use the `downloadLuauModule` command) and set up your import system
4. Activate RequireOnRails using the status bar button

## Setup Guide

### 1. Configuration
Adjust these key settings to match your project structure in your VS Code settings (`.vscode/settings.json`):
```jsonc
{
    // These are the directories that RoR will scan through to make aliases.
    "require-on-rails.directoriesToScan": [
        "src/Server",
        "src/Client", 
        "src/Shared"
    ],

    // Manual aliases for absolute path support. Maps alias names to directory
    // paths. These should typically be a superset of your directoriesToScan.
    "require-on-rails.manualAliases": {
        "Server": "src/Server",
        "Client": "src/Client",
        "Shared": "src/Shared"
    },

    // Ordered path prefixes used to resolve ambiguous basename aliases.
    // Earlier entries are higher priority.
    // Resolution only occurs if exactly one candidate matches the
    // highest-priority matched prefix.
    "require-on-rails.pathPriority": [
      "src/Server",
      "src/Client",
      "src/Shared"
    ],

    // This is the path to the importer you generate via the RequireOnRails 
    // luau module. This path should be in Roblox hierarchy terms.
    "require-on-rails.importModulePaths": [
        "ReplicatedStorage.src.Import", // Default expected path
        "game:GetService(\"ReplicatedStorage\").src.Import", // Potential alternate path
        "game.ReplicatedStorage.src.Import" // Potential alternate path
    ],

    // Controls the contextual import snippet inserted into files.
    // Must include the {IMPORT_MODULE_PATH} placeholder.
    "require-on-rails.contextualImportTemplate": "local Import = require({IMPORT_MODULE_PATH})\\nrequire = Import(script)",
}
```

### 2. Project Structure
Ensure your project follows a structure where:
- Files ideally have unique basenames across scanned directories, or use `pathPriority` to resolve selected collisions
- Directory structure matches your `.vscode/settings.json` configuration
- Import system is properly configured

### 3. Import System Setup
1. Get the RequireOnRails Luau module via Wally or the `downloadLuauModule` command.
2. Create an `Import.luau` module by following the instructions in the module. (Example below)
3. Ensure your `importModulePaths` configuration points to your newly setup `Import` module
4. Add the contextual import snippet to your files:
   
```lua
-- This snippet may vary depending on your `importModulePaths`
-- and `contextualImportTemplate` configuration
local Import = require(ReplicatedStorage.src.Import)
require = Import(script)
```
<details>
<summary>`Import.luau` Module Example</summary>

```lua
--// Services //--
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RequireOnRails = require(ReplicatedStorage.src.Packages.RequireOnRails)
local ImportGenerator: RequireOnRails.ContextualImportGenerator

------------------------------

-- Defines whether or not an instance should be ignored by the import generator.
local ignorePredicate = function(instance: Instance): boolean
	local isDescendantOfPackageIndexFolder = instance:IsDescendantOf(ReplicatedStorage.src.Packages._Index)
	local shouldIgnoreFile = isDescendantOfPackageIndexFolder
	return shouldIgnoreFile
end

------------------------------

if RunService:IsClient() then
	ImportGenerator = RequireOnRails.create {
		Aliases = {
			["Client"] = ReplicatedStorage.src.Client,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
		},
		IgnorePredicate = ignorePredicate,
	}
else
	local ServerScriptService = game:GetService("ServerScriptService")
	ImportGenerator = RequireOnRails.create {
		Aliases = {
			["Server"] = ServerScriptService.src.Server,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
			["ServerPackages"] = ServerScriptService.src.ServerPackages,
		},
		IgnorePredicate = ignorePredicate,
	}
end

return ImportGenerator
```
</details>
<details>
<summary>Luau Module Configuration Reference</summary>
All options are passed to `RequireOnRails.create { … }`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `Aliases` | `{ [string]: Instance \| string }` | *(required)* | Maps keys to ancestor root instances or short string aliases. String values expand to another key in the same table (e.g. `R = "Root"` makes `@R/Foo` resolve as `@Root/Foo`; `Svc = "Root/Services"` supports sub-path prefixes). All keys must be non-empty strings — numeric keys or an empty string key will error at `create()` time. Keys `"self"` and `"game"` are reserved. All ambiguous modules should be descendant of one of these values. |
| `Ancestors` | `{ [string]: Instance \| string }?` | `nil` | **Deprecated.** Accepted for backwards compatibility; merged into `Aliases` at `create()` time (`Aliases` takes precedence on key conflicts). Prefer `Aliases` for new code. |
| `IgnorePredicate` | `((Instance) -> boolean)?` | `nil` | Called on each container during search; return `true` to skip that subtree. |
| `Debug` | `boolean?` | `false` | Prints detailed resolution steps to the output. |
| `MaxSearchDepth` | `number?` | `50` | Maximum folder depth for ambiguous searches. Does not apply to explicit absolute paths. |
| `CaseSensitive` | `boolean?` | `true` | When `false`, path segments are matched case-insensitively. |
| `DisableCache` | `boolean?` | `false` | When `true`, skips the module-path → instance lookup cache, re-resolving on every call. Native Luau `require()` still caches module execution results. |
</details>

## Usage

1. **File Organization**: Organize your Luau files in the directories specified in `directoriesToScan`. Ensure your `Import` module file is setup.

2. **Activation**: Click the status bar button to toggle RequireOnRails on/off

3. **Automatic Aliases**: The extension will automatically generate aliases in your `.luaurc` file based on file basenames

4. **Import Management**: The extension can automatically prompt to add missing import require definitions when it detects `@` require statements

5. **File Operations**: When you rename or move files, the extension will detect the operation and prompt to update require statements accordingly

## Important Notes

⚠️ **Ambiguous Basenames**: Duplicate basenames across scanned directories are ambiguous by default and no alias is generated. You can set `pathPriority` to resolve some collisions, but only if exactly one candidate matches the highest-priority matched path.

⚠️ **Configuration Required**: You must configure `directoriesToScan` and `importModulePaths` to match your specific project structure.

⚠️ **RequireOnRails Module**: This extension requires a separate Luau module to function. The module is available via Wally.

⚠️ **Import override**: Ensure each script sets the global `require` override (for example via the default multiline snippet). You may localize the import function variable (e.g. `local Import = ...`), but the final override must assign to global `require`.

## Extension Settings and Commands
<details>
<summary> Show Settings & Commands </summary>

This extension contributes the following settings through `require-on-rails.*`:

### Core Settings

* `require-on-rails.startsImmediately`: 
  - **Type**: `boolean`
  - **Default**: `false`
  - **Description**: Whether to start the extension automatically when VS Code finishes loading

### Import Management

* `require-on-rails.importModulePaths`: 
  - **Type**: `array<string>`
  - **Default**: 
    - `"game.ReplicatedStorage.src.Import"`
    - `"ReplicatedStorage.src.Import"`
    - `"game:GetService(\"ReplicatedStorage\").src.Import"`
    - `"game:GetService(\"ReplicatedStorage\"):FindFirstChild(\"Import\", true)"`
    - `"ReplicatedStorage:FindFirstChild(\"Import\", true)"`
  - **Description**: Valid import module paths for the require override. Uses the first value as default when adding import statements. 
  - ***⚠️ Modify this to match your project structure!***

* `require-on-rails.contextualImportTemplate`:
  - **Type**: `string`
  - **Default**: `"local Import = require({IMPORT_MODULE_PATH})\\nrequire = Import(script)"`
  - **Description**: Template used when inserting contextual import code. Must include `{IMPORT_MODULE_PATH}` placeholder. If missing, RequireOnRails warns and falls back to the default template.

* `require-on-rails.tryToAddImportRequire`: 
  - **Type**: `boolean`
  - **Default**: `true`
  - **Description**: Automatically prompt to add the import require definition when opening files that have `@` require statements but are missing the import definition

* `require-on-rails.importOpacity`: 
  - **Type**: `number`
  - **Default**: `0.45`
  - **Description**: Opacity level (0.0-1.0) for import require override lines in the editor. Lower values make lines more transparent

* `require-on-rails.preferredImportPlacement`: 
  - **Type**: `string`
  - **Default**: `"TopOfFile"`
  - **Enum**: `["TopOfFile", "BeforeFirstRequire", "AfterDefiningRobloxServices"]`
  - **Description**: Controls where the import require definition is placed when automatically added to files
    - `TopOfFile`: Place import at the very top of the file
    - `BeforeFirstRequire`: Place import before the first require statement  
    - `AfterDefiningRobloxServices`: Place import after Roblox service definitions (game:GetService calls)

* `require-on-rails.addSeleneCommentToImport`: 
  - **Type**: `boolean`
  - **Default**: `false`
  - **Description**: Whether to add a Selene comment to disable warnings for the import require definition line

### File Operation Settings

* `require-on-rails.enableBasenameUpdates`: 
  - **Type**: `boolean`
  - **Default**: `true`
  - **Description**: Whether to prompt for updating basename require statements when files are renamed

* `require-on-rails.enableAbsolutePathUpdates`: 
  - **Type**: `boolean`
  - **Default**: `false`
  - **Description**: Whether to prompt for updating absolute require paths when files are moved between different alias directories

* `require-on-rails.enableFileNameCollisionResolution`: 
  - **Type**: `boolean`
  - **Default**: `false`
  - **Description**: Whether to detect and handle filename collisions by automatically renaming files with '_Duplicate' suffix

### Directory Configuration

* `require-on-rails.directoriesToScan`: 
  - **Type**: `array<string>`
  - **Default**: `["src/Server", "src/Client", "src/Shared"]`
  - **Description**: List of directories to scan for generating file aliases (relative to workspace root) 
  - ***⚠️ Modify this to match your project structure!***

* `require-on-rails.ignoreDirectories`: 
  - **Type**: `array<string>`
  - **Default**: `["^_.*"]`
  - **Description**: Regex patterns for directories/files to ignore when scanning. By default ignores anything prefixed with underscore. Useful for ignoring things like the `_Index` folder for Wally packages.

* `require-on-rails.manualAliases`: 
  - **Type**: `object`
  - **Default**: `{"Server": "src/Server", "Client": "src/Client", "Shared": "src/Shared"}`
  - **Description**: Manual aliases for absolute path support. Maps alias names to their corresponding directory paths (relative to workspace root). Used for absolute require path updates when files are moved between different alias directories.

* `require-on-rails.pathPriority`:
  - **Type**: `array<string>`
  - **Default**: `[]`
  - **Description**: Ordered path prefixes used to resolve ambiguous auto-generated aliases. Earlier entries are higher priority. If exactly one candidate for a basename matches the highest-priority matched prefix, that alias is generated. If multiple candidates match that same highest-priority prefix, the alias remains ambiguous and is not generated.

### Post-Processing

* `require-on-rails.onAliasesRegenerated`:
  - **Type**: `array<string>`
  - **Default**: `[]`
  - **Scope**: Application (user settings only — cannot be overridden at workspace or folder level)
  - **Description**: Shell commands to run after aliases are regenerated. Each command is executed from the workspace root. Commands run serially within a batch; rapid file changes that trigger multiple regenerations will queue at most one pending run, preventing duplicate concurrent executions. Skipped entirely in untrusted workspaces.
  - **Example**:
    ```jsonc
    "require-on-rails.onAliasesRegenerated": [
        "npm run sync-aliases"
    ]
    ```

## Commands

RequireOnRails provides the following commands accessible via Command Palette (`Ctrl+Shift+P`):

* **Toggle RoR Active**: Enable or disable RequireOnRails functionality
* **Setup Default Project Structure**: Setup a project structure ready out of the box for RequireOnRails
* **Download Luau Module**: Download the RequireOnRails Luau module via Wally package manager or as a raw Luau file
* **Add Import require def to all Luau files**: Automatically add import require definitions to all files that need them
* **Regenerate Aliases (Debug)**: Force regeneration of all aliases (useful for troubleshooting)

</details>

## Troubleshooting
<details>
<summary>Common Issues</summary>

**Q: My aliases aren't generating**
- Check that `directoriesToScan` matches your actual directory structure
- Ensure file basenames are unique across all scanned directories
- Verify RequireOnRails is activated (check status bar)

**Q: Import require prompts not working**
- Verify `importModulePaths` points to your actual import module location
- Check that files contain `require("@SomeName")` statements
- Ensure `tryToAddImportRequire` is enabled in settings

**Q: File rename updates not working**
- Check that the relevant enable settings are turned on (`enableBasenameUpdates`, etc.)
- Verify the extension is activated and monitoring file changes
- Ensure file basenames are unique across all scanned directories

**Q: Import statements not being added correctly**
- Check your `preferredImportPlacement` setting
- Verify that the import module path in `importModulePaths` is correct
- Ensure the target files contain `@` require statements

**Q: Multiline contextual import lines are not hiding**
- Ensure the file still contains core contextual import usage (`require = <something>(script)` or `require = require(...)(script)`)
- If using a custom template, verify it still produces a valid contextual override pattern
- Confirm `importOpacity` is not set near `1.0`

**Q: I configured `contextualImportTemplate`, but insertion still looks default**
- Verify the template includes `{IMPORT_MODULE_PATH}`
- If placeholder is missing, RequireOnRails warns and uses the default template

**Q: Selene comments not appearing**
- Make sure `addSeleneCommentToImport` is set to `true`
- Verify that a `selene.toml` file exists in your workspace root
- Check that the import statement is being added successfully first
</details>