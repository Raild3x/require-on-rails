// Optional — see updateLuaFileAliases.js. Required here only so that aliasDiagnostics, which
// imports this module at load time, can itself be imported outside VS Code.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const fs = require('fs');
const path = require('path');
const { warn, errMsg } = require('../core/logger');
const settings = require('../core/settings');
const { SCHEMA } = require('../core/settingsSchema');

const DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE = [
    'local Import = require({IMPORT_MODULE_PATH})',
    'require = Import(script)'
].join('\n');

/**
 * Checks if workspace folders are available
 * @returns {boolean} - True if workspace folders are available
 */
function hasWorkspaceFolders() {
    return !!(vscode && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
}

/**
 * Gets the root path of the first workspace folder
 * @returns {string|null} - Workspace root path or null if not available
 */
function getWorkspaceRoot() {
    return vscode?.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/**
 * Gets workspace root with error handling and user feedback
 * @param {string} operationName - Name of operation for error messages
 * @returns {string|null} - Workspace root path or null if not available
 */
function requireWorkspaceRoot(operationName = 'operation') {
    if (!hasWorkspaceFolders()) {
        vscode?.window.showErrorMessage(`RequireOnRails: Please open a workspace folder first to perform ${operationName}.`);
        return null;
    }
    return getWorkspaceRoot();
}

/**
 * Checks if a directory should be ignored based on regex patterns
 * @param {string} dirName - Directory name to check
 * @param {string[]} ignorePatterns - Array of regex patterns
 * @returns {boolean} - True if directory should be ignored
 */
function shouldIgnoreDirectory(dirName, ignorePatterns) {
    return ignorePatterns.some(pattern => {
        try {
            return new RegExp(pattern).test(dirName);
        } catch (e) {
            warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
            return dirName.toLowerCase() === pattern.toLowerCase();
        }
    });
}

/**
 * Recursively scans a directory for files with supported extensions
 * @param {string} dir - Directory to scan
 * @param {string[]} supportedExtensions - Array of file extensions (e.g., ['.lua', '.luau'])
 * @param {string[]} ignoreDirectories - Array of directory patterns to ignore
 * @param {function} callback - Function to call for each file found
 */
function scanDirectory(dir, supportedExtensions, ignoreDirectories, callback) {
    try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            
            if (file.isDirectory()) {
                // Check if directory should be ignored
                if (shouldIgnoreDirectory(path.basename(fullPath), ignoreDirectories)) {
                    continue;
                }
                scanDirectory(fullPath, supportedExtensions, ignoreDirectories, callback);
            } else if (file.isFile() && supportedExtensions.includes(path.extname(file.name))) {
                callback(fullPath);
            }
        }
    } catch (error) {
        warn(`Error scanning directory ${dir}:`, errMsg(error));
    }
}

/**
 * Gets the configuration for the extension. Only for the genuinely-editor operations —
 * inspect() scope checks and config.update() writes. Reads of setting *values* go through
 * getSettings(), which resolves the full chain including the Project settings file.
 * @returns {import('vscode').WorkspaceConfiguration} - Extension configuration
 */
function getExtensionConfig() {
    if (!vscode) throw new Error('getExtensionConfig requires VS Code; no settings are available outside the editor.');
    return vscode.workspace.getConfiguration('require-on-rails');
}

// The editor's settings source: every schema key from the live configuration, which VS Code
// has already merged across user and workspace scope. Values equal the manifest defaults when
// unset, which is harmless — the schema defaults match (drift-tested), so precedence is
// unaffected.
/** @returns {Record<string, any>} */
function vscodeOverlay() {
    const config = getExtensionConfig();
    /** @type {Record<string, any>} */
    const overlay = {};
    for (const key of Object.keys(SCHEMA)) {
        overlay[key] = config.get(key);
    }
    // manualAliases deliberately picks ONE scope instead of config.get's cross-scope object
    // merge: a workspace's alias map replaces the user's, it does not blend with it.
    const inspected = config.inspect('manualAliases');
    if (inspected) {
        overlay['manualAliases'] = /** @type {Object<string, string>} */ (
            inspected.workspaceFolderValue
            ?? inspected.workspaceValue
            ?? inspected.globalValue
            ?? inspected.defaultValue
            ?? {});
    }
    return overlay;
}

// One snapshot per invalidation, because settings reads sit inside per-require loops
// (explicitMode.renderFor) and hit the filesystem for the project file. extension.js
// invalidates on configuration changes and requireonrails.json watcher events.
/** @type {ReturnType<typeof settings.resolveSettings> | null} */
let _settingsCache = null;

function invalidateSettings() {
    _settingsCache = null;
}

/** @returns {ReturnType<typeof settings.resolveSettings>} */
function getSettingsState() {
    if (!vscode) throw new Error('getSettingsState requires VS Code; headless callers use resolveSettings directly.');
    if (!_settingsCache) {
        _settingsCache = settings.resolveSettings(getWorkspaceRoot(), { overlay: vscodeOverlay() });
    }
    return _settingsCache;
}

/**
 * The resolved settings chain (Project settings file > editor configuration > defaults) as a
 * flat dotted-key map. Every schema key is present.
 * @returns {Record<string, any>}
 */
function getSettings() {
    return getSettingsState().settings;
}

/** @returns {import('../core/settings').SettingsFinding[]} */
function getSettingsFindings() {
    return getSettingsState().findings;
}

// Error-severity settings findings stop operations (ADR 0004): builds, alias regeneration,
// and rewrites refuse to run rather than run on a fallback the user did not choose.
function settingsHaveErrors() {
    return settings.hasErrorFindings(getSettingsFindings());
}

/**
 * The validated values the Project settings file itself supplies (empty when absent). Hook
 * commands from here are workspace-supplied and go through the same approval gate as
 * workspace-settings hooks.
 * @returns {Record<string, any>}
 */
function getProjectFileValues() {
    return getSettingsState().projectValues;
}

/**
 * Gets common configuration values used across multiple modules
 * @returns {{
 *   directoriesToScan: string[],
 *   ignoreDirectories: string[],
 *   supportedExtensions: string[],
 *   importModulePaths: string[],
 *   tryToAddImportRequire: boolean,
 *   preferredImportPlacement: 'TopOfFile'|'BeforeFirstRequire'|'AfterDefiningRobloxServices',
 *   importOpacity: number,
 *   contextualImportTemplate: string,
 *   mode: 'dynamic'|'explicit',
 *   explicitPathStyle: 'alias'|'relative'|'game',
 *   preferRelativePaths: boolean,
 *   rojoProjectPath: string,
 *   sourcemapPath: string
 * }} - Common configuration object
 */
function getCommonConfig() {
    const s = getSettings();

    return {
        directoriesToScan: s['directoriesToScan'] || [],
        ignoreDirectories: s['ignoreDirectories'] || [],
        supportedExtensions: ['.lua', '.luau'],
        importModulePaths: s['importModulePaths'] || [],
        tryToAddImportRequire: s['tryToAddImportRequire'],
        preferredImportPlacement: s['preferredImportPlacement'],
        importOpacity: s['importOpacity'],
        contextualImportTemplate: s['contextualImportTemplate'] || DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE,
        mode: s['mode'],
        explicitPathStyle: s['explicitPathStyle'],
        preferRelativePaths: s['preferRelativePaths'],
        rojoProjectPath: s['rojoProjectPath'],
        sourcemapPath: s['sourcemapPath']
    };
}

/** @returns {'dynamic'|'explicit'} */
function getMode() {
    return getSettings()['mode'];
}

/** @returns {'alias'|'relative'|'game'} */
function getExplicitPathStyle() {
    return getSettings()['explicitPathStyle'];
}

/**
 * Build conversion settings, in one place so every consumer agrees on the defaults.
 * @returns {{enabled: boolean, outputDirectory: string, outputRequireStyle: 'string'|'find_first_child'|'wait_for_child'|'property', buildProjectFile: string}}
 */
function getBuildConversionConfig() {
    const s = getSettings();
    return {
        enabled: s['buildConversion.enabled'],
        outputDirectory: s['buildConversion.outputDirectory'],
        outputRequireStyle: s['buildConversion.outputRequireStyle'],
        buildProjectFile: s['buildConversion.buildProjectFile']
    };
}

// The Luau runtime module can expand .luaurc aliases, so it is needed whenever require
// strings contain them at runtime: always in dynamic mode, and in explicit mode with
// alias-rooted paths. Roblox resolves relative and @game string requires natively — and
// with Build conversion on, alias requires are rewritten at build time, so the module
// (and its Import boilerplate) is never needed regardless of mode.
function runtimeModuleRequired() {
    if (getBuildConversionConfig().enabled) return false;
    return getMode() === 'dynamic' || getExplicitPathStyle() === 'alias';
}

module.exports = {
    DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE,
    hasWorkspaceFolders,
    getWorkspaceRoot,
    requireWorkspaceRoot,
    shouldIgnoreDirectory,
    scanDirectory,
    getExtensionConfig,
    getSettings,
    getSettingsFindings,
    settingsHaveErrors,
    getProjectFileValues,
    invalidateSettings,
    getCommonConfig,
    getMode,
    getExplicitPathStyle,
    getBuildConversionConfig,
    runtimeModuleRequired
};
