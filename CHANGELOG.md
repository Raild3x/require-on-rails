# Change Log

All notable changes to the "require-on-rails" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- **Build conversion**: A per-workspace toggle (`require-on-rails.buildConversion.enabled`), orthogonal to the mode, that produces a runtime-module-free copy of the project — short `@Name`/alias-rooted requires stay in source, and the **Build Project** command rewrites them into natively-resolvable forms in an output directory (`buildConversion.outputDirectory`, default `dist`). Output form is selectable via `buildConversion.outputRequireStyle`: native string requires (default), or `FindFirstChild`/`WaitForChild`/property instance chains (the same shapes darklua's `convert_require` emits; darklua was evaluated and declined as the engine — see ADR 0003). Requires are container-aware: paths inside a cloned container (StarterGui, StarterPack, StarterPlayerScripts, StarterCharacterScripts) stay requirer-relative so they travel with the runtime clone, while paths crossing out are game-rooted — cloned scripts run from a different location than they edit at, so a relative path out of the container breaks at runtime. The Import boilerplate is stripped from output, and an unconvertible require fails the build loudly with nothing written. **Generate Build Project File** writes a `build.project.json` (path via `buildConversion.buildProjectFile`) cloning the Rojo project with scanned `$path` entries redirected into the output directory; **Remove Import Boilerplate From All Files** migrates the source tree once, and with the toggle on, boilerplate insertion stops and leftover boilerplate is flagged in the Problems panel (`stale-boilerplate`). `buildConversion.hooks.onBuildCompleted` runs shell commands after each successful build (with `ROR_EVENT`/`ROR_OUTPUT_DIR`/`ROR_BUILD_PROJECT` in the environment) under the same per-workspace approval model as `onAliasesRegenerated` — the seam for chaining darklua, StyLua, or packaging steps.
- **CI: `verify-build` input**: When a project enables Build conversion, the action can additionally dry-run the real conversion and fail on any require the build cannot convert, plus report stale boilerplate. Still dependency-free plain Node.
- **Build conversion watch pipeline**: With Build conversion on and the extension Active, the output directory stays continuously fresh so `rojo serve build.project.json` playtesting never sees stale code. A save re-converts exactly that file against the already-cached resolver context and writes it immediately (measured avg 0.38ms/file on a 5,000-module synthetic project — see `npm run perf`); renames and resolution-context changes (aliases, Rojo mapping, settings) trigger a coalesced full rebuild instead, since they can change the rendered form of requires in files that were not edited. Rather than a time debounce, writes are gated on validity: a file the Luau language server marks with Error diagnostics is held at its last good output — so autosave never streams half-typed code at a running rojo serve — with the hold ending when the errors clear, after a ~2s grace window, or on editor focus loss (about to playtest), whichever comes first, so files with standing type errors are never pinned stale (syntax and type errors are not separable in the diagnostics API). No luau-lsp means no gate. Files whose requires do not resolve always keep their last good output; findings surface on explicit builds and Checks. `buildConversion.hooks.onWatchConverted` runs approved shell commands with `ROR_CHANGED_FILES` in the environment, coalesced behind a trailing window so hooks never fire once per keystroke-save.
- **Performance harness** (`npm run perf`, `test/perf/bench.js`): generates a parameterized synthetic project (default 5,000 modules with a realistic require graph) and measures context creation, cold full build, per-save incremental conversion, and autosave-burst batches, plus a darklua post-processor pass when the binary is available. Emits a greppable `PERF_METRICS` JSON line; CI runs it at 2,000 modules for a trend line, with only generous ceilings asserting.
- **GitHub Action for CI (`Raild3x/require-on-rails@v2`)**: The extension's checks only ran while a workspace was open in VS Code, so requires broken by file moves made outside the editor reached `master` unnoticed. A one-step action now runs them on a checkout and annotates the pull request diff: ambiguous aliases, requires that resolve to no file (both modes), and — for projects that commit `.luaurc` — a `.luaurc` that no longer matches the file tree. The alias set is always derived by scanning, never read from `.luaurc`, since dynamic-mode projects commonly gitignore it; when it is absent the drift check is skipped and the rest still runs. Configuration is read from the committed `.vscode/settings.json` with the extension's own defaults as fallback, so CI and the editor agree on what counts as a problem, and the findings reuse the extension's diagnostic code, down to the wording. Findings fail the job unless `warn-only` is set; an unreadable `settings.json` or `.luaurc` always fails. The checker is also runnable directly as `node src/cli/check.js --working-directory <dir>`.
- **Explicit mode**: RequireOnRails now runs in one of two modes per workspace, selected by `require-on-rails.mode` and prompted for on first activation. `dynamic` is the existing behavior — basename aliases generated into `.luaurc` and resolved at runtime by the Luau module. The new `explicit` mode generates no aliases and never writes `.luaurc` (it is read as the source of alias roots, and is yours to maintain); instead the extension writes full, statically-resolvable paths into your source at edit time. Typing `require("@MyModule")` offers completions for every matching module, nearest to the editing file first, with the target path shown greyed-out on each row; finishing the name without choosing one rewrites it to the closest match when the cursor leaves the string, with an on-save sweep as backstop that skips any require string the cursor is inside. `require-on-rails.explicitPathStyle` selects the written form: `alias` (`@Shared/Stuff/MyModule`, still needs the Luau module since Roblox does not support `.luaurc` aliases natively), `relative` (`./Stuff/MyModule`), or `game` (`@game/ReplicatedStorage/...`, mapped through the Rojo project at `require-on-rails.rojoProjectPath`). `require-on-rails.preferRelativePaths` writes the relative form whenever it is strictly shorter. Duplicate basenames are no longer ambiguous in this mode — every candidate is offered.
- **Explicit-mode diagnostics**: Every require string is resolved against the filesystem rather than only checking its alias root, so a path broken by a move is reported in the Problems panel with the specific reason (unknown alias, no file at the path, no Rojo mapping, or a name matching no known module).
- **Ignored-setting warnings**: Settings that do nothing under the current mode and path style are now flagged with a warning on `.vscode/settings.json`, so a value with no effect is visible rather than silently inert.
- **`Rewrite All Requires to Current Style` command**: Re-renders every resolvable require string into the current `explicitPathStyle`, reporting anything it could not resolve. This is also the migration path from dynamic mode.
- **`Select Mode` command**: Switches a workspace between dynamic and explicit, rewiring watchers, listeners and providers in place.
- **`Manage Alias Regeneration Commands` command**: Approving a workspace's `onAliasesRegenerated` commands previously required catching the notification, which is raised only once per distinct set per session — so a dismissed or missed prompt left the approval unreachable until the window was reloaded, and an approval could never be withdrawn at all. The Command Palette now lists every command the workspace requests, pre-checked with the ones already approved; checking approves, unchecking revokes. Escaping the picker changes nothing. Revoking clears the session's announcement state, so the command warns again on the next regeneration instead of being silently ignored.
- **Ambiguous alias notification**: When two or more files share a basename, no alias is generated for that name and every `require("@Name")` of it silently fails to resolve. This now raises a warning notification naming the conflicting aliases, with **Show Details** (opens the output channel, listing every conflicting path) and **Show Problems** actions. The notification persists until dismissed, and is raised once per distinct set of ambiguous names rather than on every regeneration, so it does not spam while you work. Clearing an ambiguity and reintroducing it warns again.
- **`Open Menu` command and status bar menu**: A quick-pick menu listing every RequireOnRails action, mirroring the Rojo pattern. The status bar is now two adjacent items: the name opens the menu, and an adjacent play/stop button toggles the extension directly (previously the single status bar item only toggled).
- **Unresolved alias diagnostics**: `require("@Name")` statements that reference an alias which is not in `.luaurc` are now reported in the Problems panel with a squiggle on the alias itself. Diagnostics distinguish the two causes: `ambiguous-alias` (the name exists in multiple files and was dropped) names the conflicting files and points at `pathPriority`, while `unknown-alias` (no such module) points at `directoriesToScan`/`ignoreDirectories`. Only the first path segment is treated as the alias, so `require("@Shared/Utils/Thing")` checks `Shared`. Non-aliased requires, `@self`, and commented-out lines are left alone. Refreshes after each alias regeneration and on save, and respects `ignoreDirectories`.

### Changed
- **Rename and move handling in explicit mode rewrites full paths, in both directions**: Requires elsewhere that point at a moved file are updated only after confirmation — declining is what you want when replacing a module with a same-named file and keeping existing requires on the old path. Relative requires *inside* a moved file are fixed automatically, since they break purely because the file moved. Both are applied as editor edits, so they participate in undo, unlike the dynamic-mode rewrites which write to disk directly.
- **The inbound rename prompt is now modal**: VS Code auto-dismisses non-modal notifications after roughly fifteen seconds regardless of the buttons they carry, and an unanswered prompt here silently left every inbound require pointing at the old path.
- **Import-block features follow the runtime module, not the mode**: Import insertion and the dimming of import lines are active in dynamic mode and in explicit mode with the `alias` style, and inert for the `relative` and `game` styles, which Roblox resolves natively and which need no boilerplate.
- **README restructured for the two modes**: A comparison table up front, one collapsible setup-and-usage guide per mode, settings grouped into shared / dynamic-only / explicit-only, and mode-labeled troubleshooting. Explicit mode's setup, workflow, and gotchas previously had no coverage at all.
- **Commands are now prefixed with `RequireOnRails:` in the Command Palette** via the `category` contribution field, and titles were cleaned up: `Toggle RoR Active` → `Toggle Active`, `Add Import require def to all Luau files.` → `Add Import Definition to All Files`, `Regenerate Aliases (Debug)` → `Regenerate Aliases`, `Check for RequireOnRails Package Updates` → `Check for Updates`.

### Fixed
- **Activation inherited the previous activation's state**: `activate()` read `isActive` without resetting it, so a second activation in the same process saw the extension as already on and the `startsImmediately` toggle turned it *off* instead of on, leaving watchers and listeners unregistered. VS Code activates an extension once per host, so this was invisible in normal use — but it made the test suite order-dependent, with an earlier suite's activation silently disabling a later one. Activation now starts from a known-inactive state with nothing left registered.
- **`addSeleneCommentToImport` was documented but never existed**: The README described a setting that is not contributed in `package.json`. The extension only dims an existing selene comment above the import block; it never adds one. The README now documents the actual behavior.
- **Folder renames now regenerate aliases**: Renaming a folder emitted watcher events for the folder path, which matched neither `**/*.luau` nor `**/*.lua`, so nothing regenerated. A folder containing an `init.luau` owns an alias named after the folder, so renaming it left a stale alias under the old name and none under the new one; files under any renamed folder were also left with stale alias paths. Renames made through VS Code now trigger a regeneration. Renames made outside VS Code (e.g. `git checkout`, the OS file explorer) still need **Regenerate Aliases**.

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