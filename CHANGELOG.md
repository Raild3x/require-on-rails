# Change Log

All notable changes to the "require-on-rails" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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