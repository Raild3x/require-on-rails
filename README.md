# RequireOnRails

An opinionated Roblox Luau utility extension that simplifies working with complex codebase hierarchies by automatically generating file aliases and managing import statements. It works in conjunction with a custom requirer in order to parse the string paths.

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
- Collision detection with automatic duplicate file renaming

### Status Bar Integration
Toggle the extension on/off with a convenient status bar button showing the current state.

## Requirements
- Visual Studio Code
- Luau LSP VSCode extension (or some other form of Roblox Luau language support)
- RequireOnRails Luau module (available separately)
- A project structure with unique file basenames (no duplicate names across scanned directories)
  
### Default Expected Project Structure
For the default configuration settings, RequireOnRails expects the following project structure:

```
your-project/
├── src/
│   ├── _Import/
│   │   ├── init.luau
│   │   └── RequireOnRails.luau
│   ├── Server/           # Server-side code (@Server alias)
│   ├── Client/           # Client-side code (@Client alias)
│   └── Shared/           # Shared code (@Shared alias)
├── .luaurc               # Generated/maintained by extension
└── .requireonrails.json  # Extension configuration
```

## Extension Settings

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
    - `ReplicatedStorage:FindFirstChild("_Import", true)`
    - `game:GetService("ReplicatedStorage"):FindFirstChild("_Import", true)`
  - **Description**: Valid import module paths for the require override. Uses the first value as default when adding import statements. 
  - ***⚠️ Modify this to match your project structure!***

* `require-on-rails.tryToAddImportRequire`: 
  - **Type**: `boolean`
  - **Default**: `true`
  - **Description**: Automatically prompt to add the import require definition when opening files that have `@` require statements but are missing the import definition

* `require-on-rails.importOpacity`: 
  - **Type**: `number`
  - **Default**: `0.45`
  - **Description**: Opacity level (0.0-1.0) for import require override lines in the editor. Lower values make lines more transparent

### Require Statement Updates

* `require-on-rails.enableBasenameUpdates`: 
  - **Type**: `boolean`
  - **Default**: `true`
  - **Description**: Whether to prompt for updating basename require statements when files are renamed

* `require-on-rails.enableAbsolutePathUpdates`: 
  - **Type**: `boolean`
  - **Default**: `true`
  - **Description**: Whether to prompt for updating absolute require paths when files are moved between different alias directories

* `require-on-rails.enableCollisionDetection`: 
  - **Type**: `boolean`
  - **Default**: `true`
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

### Advanced Settings
<details>
<summary>Avoid messing with these properties.</summary>

* `require-on-rails.supportedExtensions`: 
  - **Type**: `array<string>`
  - **Default**: `[".lua", ".luau"]`
  - **Description**: File extensions to consider when generating aliases and updating require statements

* `require-on-rails.requirePrefix`: 
  - **Type**: `string`
  - **Default**: `"@"`
  - **Description**: The prefix character used in require statements

</details>

## Commands

RequireOnRails provides the following commands accessible via Command Palette (`Ctrl+Shift+P`):

* **Toggle RoR Active**: Enable or disable RequireOnRails functionality
* **Setup Default Project Structure**: Create a template project structure optimized for RequireOnRails

## Quick Start

### Option 1: Use Template
1. Open a fresh workspace in VS Code
2. Open Command Palette (`Ctrl+Shift+P`)
3. Run "RequireOnRails: Setup Default Project Structure"
4. Activate RequireOnRails using the status bar button
5. Start coding with `require("@ModuleName")` syntax!

### Option 2: Manual Setup
1. Create your project structure manually
2. Configure `directoriesToScan` and `importModulePaths` in VS Code settings to match your project
3. Get the RequireOnRails Luau module and set up your import system
4. Activate RequireOnRails using the status bar button

## Setup Guide

### 1. Project Structure
Ensure your project follows a structure where:
- Files have unique basenames across all scanned directories
- Directory structure matches your `directoriesToScan` configuration
- Import system is properly configured

### 2. Import System Setup
1. Get the RequireOnRails Luau module (link coming soon)
2. Place it in your import directory (e.g., `src/_Import/`)
3. Update `importModulePaths` configuration to point to your import module
4. Add the require override line to your files:
   ```lua
   -- This line may vary depending on your `importModulePaths` configuration
   require = require(ReplicatedStorage.src._Import)(script) :: typeof(require)
   ```

### 3. Configuration
Adjust these key settings to match your project structure in your VS Code settings (`.vscode/settings.json`):

Example:
```json
{
    "require-on-rails.directoriesToScan": [
        "src/Server",
        "src/Client", 
        "src/Shared"
    ],
    "require-on-rails.importModulePaths": [
        "ReplicatedStorage.src._Import"
    ]
}
```

## Usage

1. **File Organization**: Organize your Luau files in the directories specified in `directoriesToScan`. Ensure your `_Import` file is setup.

2. **Activation**: Click the status bar button to toggle RequireOnRails on/off

3. **Automatic Aliases**: The extension will automatically generate aliases in your `.luaurc` file based on file basenames

4. **Import Management**: The extension can automatically prompt to add missing import require definitions when it detects `@` require statements

5. **File Operations**: When you rename or move files, the extension will detect the operation and prompt to update require statements accordingly

## Important Notes

⚠️ **Unique Basenames Required**: All files in scanned directories must have unique basenames. If you have `PlayerService.luau` in both Server and Client directories, no alias will be generated to avoid ambiguity.

⚠️ **Configuration Required**: You must configure `directoriesToScan` and `importModulePaths` to match your specific project structure.

⚠️ **RequireOnRails Module**: This extension requires a separate Luau module to function. The module will be available separately.

## Troubleshooting

### Common Issues

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
