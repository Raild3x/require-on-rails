# Change Log

All notable changes to the "require-on-rails" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

### Changed

### Fixed

## [2.2.0] - 2026-07-27

### Extension

#### Added
- **Verbose alias-generation logging**: The RequireOnRails output channel is now a VS Code `LogOutputChannel`, so verbosity is set from the Output panel's gear icon (or `Developer: Set Log Level...`) instead of an extension setting. At **Debug** level, alias generation explains every decision it makes: which scan roots resolved, which directories were pruned and by which `ignoreDirectories` pattern, every file aliased or skipped and why, why `pathPriority` did or did not break an ambiguous name, and a summary of the run. **Trace** additionally dumps the full basename and alias sets.
- **Workspace-requested command approval**: When a workspace sets `onAliasesRegenerated`, the commands are still not run, but the user is now told what the workspace wanted, can review the exact commands, and can approve them for that workspace. Approvals are stored in VS Code's per-workspace state — not in settings and not in the repository — so approving one project's commands does not run them in any other workspace, a repository cannot approve itself, and changing an approved command invalidates the approval and re-prompts.

#### Fixed
- **`onAliasesRegenerated` scope was not actually enforced**: The setting was documented as user-settings-only, but was read with a plain `config.get`, so workspace and folder settings were executed. It is now read from user scope only. (This is enforced in code rather than with a `machine` scope declaration, because VS Code strips machine-scoped values out of the workspace configuration before the extension can see them, which would make the new notification impossible.)
- **Alias paths on macOS and Linux**: Alias values were built by stripping `workspaceRoot + '\\'`, a hardcoded Windows separator, so on other platforms the prefix was never removed and aliases became absolute paths — which also silently broke `pathPriority` prefix matching. Both sites now use `path.relative`.
- **Alias settings did not trigger regeneration**: Changing `directoriesToScan`, `ignoreDirectories`, `pathPriority`, or `manualAliases` only took effect via an incidental `settings.json` file watcher, which missed changes made in User (global) settings. These settings now trigger a regeneration directly.
- **Test runners could not launch VS Code from within VS Code**: The runners inherited `ELECTRON_RUN_AS_NODE=1` from the surrounding extension host and passed it to the VS Code they download, which then started as a plain Node process and rejected every CLI flag. They also pointed `extensionDevelopmentPath` at `test/`, which holds no extension manifest.

#### Removed
- Unused `adjustLuaurcWithSeparation` and `hasInitInParentDirs` helpers (no callers).

---

## [0.3.0] - 2026-05-20

### Extension

#### Added
- **Post-Regeneration Commands** (`onAliasesRegenerated`): New application-scoped setting accepts an array of shell commands to execute from the workspace root after every alias regeneration cycle. Commands run serially within a batch, and if another regeneration fires while commands are still in-flight, the new request is queued (latest-wins) to prevent overlapping duplicate runs.

#### Fixed
- **`regenerateAliases` command not functional**: The `require-on-rails.regenerateAliases` command was declared in `package.json` but never registered at runtime. It now correctly calls `generateFileAliases()` when invoked.
- **`onAliasesRegenerated` type guard**: The setting value is now validated with `Array.isArray` before use, and each element is filtered to non-empty strings. A misconfigured non-array value (e.g. an accidental string) is safely ignored rather than being iterated character-by-character as individual shell commands.

---

## [0.2.0] - 2026-04-16

### Luau Module (v0.2.0)

#### Breaking Changes
- **`Ancestors` renamed to `Aliases`**: The primary config field is now `Aliases: { [string]: Instance | string }`. `Ancestors` is retained as a backwards-compatible optional field that merges into `Aliases` at `create()` time (`Aliases` wins on key conflicts). Both Instance-valued entries (ancestor roots) and string-valued entries (path expansion aliases) now live in a single `Aliases` table.

#### Added
- **Parent-directory traversal (`..`) in paths**: `..` segments are now supported anywhere after the first segment in both absolute and ambiguous paths.  
  - Absolute: `@AncestorKey/child/../../sibling` — traversal starts at the registered ancestor and `..` climbs via `.Parent`.
  - Ambiguous + further segments: `@ModuleName/../sibling` — the module is found by search first; `..` and any remaining segments are then traversed from the resolved instance.
  - `@../…` (bare `..` as the very first segment) is explicitly rejected with a clear error.
- **`DisableCache` config flag**: Setting `DisableCache = true` in the config table skips the module-path → instance lookup cache, forcing fresh resolution on every `require()` call. Useful for hot-reload scenarios and debugging. Note: native Luau `require()` still caches module execution results regardless.
- **Reserved ancestor-key validation**: `create()` now errors immediately if `"self"` or `"game"` are used as ancestor keys, since these conflict with Roblox's built-in `@self` and `@game` require-by-string aliases.
- **Ambiguous path with additional segments**: Ambiguous single-name paths (`@ModuleName`) now accept additional path segments after the resolved instance (`@ModuleName/child`, `@ModuleName/../../sibling`), using the same traversal logic as absolute paths.

#### Fixed
- **Alias key validation**: `create()` now asserts immediately that every key in the `Aliases` (and `Ancestors`) table is a non-empty string. Numeric keys (e.g. `[1]`) and empty-string keys (`[""]`) are rejected with a clear error rather than being silently accepted and then never matching any path segment.


### Extension

#### Added
- **Configurable Contextual Import Template**: New `require-on-rails.contextualImportTemplate` setting controls exactly how contextual import code is inserted. The template must include `{IMPORT_MODULE_PATH}`.
- **Template Validation Warning**: The extension now warns when `contextualImportTemplate` is missing `{IMPORT_MODULE_PATH}` and falls back to a safe default template.
- **Multiline Import Insertion Default**: Contextual imports now insert as multiline by default:
	- `local Import = require(<path>)`
	- `require = Import(script)`

#### Changed
- **Lenient Import Detection**: Import detection now supports both single-line and multiline contextual import forms with optional trailing type annotations/comments.
- **Core-Usage Fallback Detection**: Detection and line hiding can match contextual import core usage even when the runtime/path text differs from configured `importModulePaths`.
- **Preview Output**: "Show Files" import preview now displays the configured contextual import template output instead of a hardcoded single-line form.

#### Fixed
- **BeforeFirstRequire Placement**: Insertion with `BeforeFirstRequire` now skips existing contextual import lines, preventing those lines from being treated as the anchor require.
- **Line Hiding Compatibility**: Multiline contextual import lines are correctly detected and hidden in production-like path variations.
- **API Compatibility**: Reintroduced `getPerformanceStats` export in the Luau package as a deprecated compatibility stub to avoid a silent breaking change for existing consumers.

## [0.0.1] - 2024-12-19

### Added
- **Automatic File Alias Generation**: Scans configured directories and generates aliases in `.luaurc` for simplified imports
- **Import Line Management**: Automatically reduces opacity of boilerplate require override lines in Luau files
- **Status Bar Toggle**: Click-to-toggle extension activation with visual status indicator
- **Smart Directory Scanning**: Configurable directory scanning with ignore patterns for package managers
- **Init File Handling**: Special handling for `init.lua` files by aliasing the containing directory name
- **Conflict Resolution**: Intelligent handling of duplicate basenames to avoid ambiguous aliases
- **Manual Override Support**: Manual aliases in `.requireonrails.json` take precedence over auto-generated ones
- **Automatic Import Prompting**: Optional prompting to add require override statement to files missing it
- **Require Statement Updates**: Automatic detection and prompting for require statement updates when files are renamed or moved
- **Collision Detection**: Automatic filename collision detection with `_Duplicate` suffix renaming
- **Absolute Path Updates**: Smart handling of absolute require path updates when files move between alias directories
- **Project Template Setup**: Command to create default project structure optimized for RequireOnRails
- **Multiple Import Path Support**: Support for multiple valid import module paths with fallback options
- **Ambiguous Alias Handling**: Files with same basename across directories are properly excluded from auto-generation
- **Init vs Standalone File Conflict Detection**: Proper handling when both init files and standalone files with same basename exist

### Configuration Options
- `startsImmediately`: Auto-start extension on VS Code load
- `tryToAddImportRequire`: Automatically prompt to add import require definition to files missing it
- `importOpacity`: Customizable opacity for require override lines  
- `importModulePaths`: Array of valid import module paths for require override statements
- `directoriesToScan`: Specify which directories to scan for files
- `ignoreDirectories`: Regex patterns for directories/files to ignore when scanning
- `supportedExtensions`: File extensions to consider for alias generation
- `enableBasenameUpdates`: Whether to prompt for updating basename require statements when files are renamed
- `enableAbsolutePathUpdates`: Whether to prompt for updating absolute require paths when files are moved between alias directories
- `enableCollisionDetection`: Whether to detect and handle filename collisions automatically
- `requirePrefix`: The prefix character used in require statements (default: "@")

### Files Generated
- `.luaurc`: Contains generated aliases alongside existing configuration
- `.requireonrails.json`: Tracks manual and auto-generated aliases separately

### Commands
- `require-on-rails.toggleActive`: Toggle extension on/off
- `require-on-rails.setupDefaultProject`: Create template project structure optimized for RequireOnRails

### Language Support
- Luau (`.luau`)
- Lua (`.lua`)

### Bug Fixes
- Fixed syntax error in `updateLuaFileAliases.js` causing test failures
- Improved error handling for invalid JSON in configuration files
- Enhanced regex pattern validation with graceful fallback to string matching
- Fixed path normalization issues across different operating systems

### Testing
- Comprehensive test suite covering all major functionality
- Edge case testing for file operations, collisions, and ambiguous aliases
- Mock-based testing for VS Code API interactions
- Project template functionality testing

### Developer Experience
- Extensive documentation in README with setup examples
- Clear configuration examples with warnings for required modifications
- Troubleshooting section with common issues and solutions
- Expected project structure diagram with generated aliases examples