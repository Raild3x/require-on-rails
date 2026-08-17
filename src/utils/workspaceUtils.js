// Optional — see updateLuaFileAliases.js. Required here only so that aliasDiagnostics, which
// imports this module at load time, can itself be imported outside VS Code.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const fs = require('fs');
const path = require('path');
const { warn, errMsg } = require('../core/logger');

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
 * Gets the configuration for the extension
 * @returns {import('vscode').WorkspaceConfiguration} - Extension configuration
 */
function getExtensionConfig() {
    if (!vscode) throw new Error('getExtensionConfig requires VS Code; no settings are available outside the editor.');
    return vscode.workspace.getConfiguration('require-on-rails');
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
 *   rojoProjectPath: string
 * }} - Common configuration object
 */
function getCommonConfig() {
    const config = getExtensionConfig();

    return {
        directoriesToScan: config.get('directoriesToScan') || [],
        ignoreDirectories: config.get('ignoreDirectories') || [],
        supportedExtensions: ['.lua', '.luau'],
        importModulePaths: config.get('importModulePaths') || [],
        tryToAddImportRequire: config.get('tryToAddImportRequire', true),
        preferredImportPlacement: config.get('preferredImportPlacement', 'TopOfFile'),
        importOpacity: config.get('importOpacity', 0.45),
        contextualImportTemplate: config.get('contextualImportTemplate', DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE),
        mode: config.get('mode', 'dynamic'),
        explicitPathStyle: config.get('explicitPathStyle', 'alias'),
        preferRelativePaths: config.get('preferRelativePaths', false),
        rojoProjectPath: config.get('rojoProjectPath', 'default.project.json')
    };
}

/** @returns {'dynamic'|'explicit'} */
function getMode() {
    return getExtensionConfig().get('mode', 'dynamic');
}

/** @returns {'alias'|'relative'|'game'} */
function getExplicitPathStyle() {
    return getExtensionConfig().get('explicitPathStyle', 'alias');
}

// The Luau runtime module can expand .luaurc aliases, so it is needed whenever require
// strings contain them: always in dynamic mode, and in explicit mode with alias-rooted
// paths. Roblox resolves relative and @game string requires natively.
function runtimeModuleRequired() {
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
    getCommonConfig,
    getMode,
    getExplicitPathStyle,
    runtimeModuleRequired
};
