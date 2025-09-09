const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { warn } = require('../core/logger');

/**
 * Checks if workspace folders are available
 * @returns {boolean} - True if workspace folders are available
 */
function hasWorkspaceFolders() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
}

/**
 * Gets the root path of the first workspace folder
 * @returns {string|null} - Workspace root path or null if not available
 */
function getWorkspaceRoot() {
    if (!hasWorkspaceFolders()) {
        return null;
    }
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
}

/**
 * Gets workspace root with error handling and user feedback
 * @param {string} operationName - Name of operation for error messages
 * @returns {string|null} - Workspace root path or null if not available
 */
function requireWorkspaceRoot(operationName = 'operation') {
    if (!hasWorkspaceFolders()) {
        vscode.window.showErrorMessage(`RequireOnRails: Please open a workspace folder first to perform ${operationName}.`);
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
        warn(`Error scanning directory ${dir}:`, error.message);
    }
}

/**
 * Gets the configuration for the extension
 * @returns {vscode.WorkspaceConfiguration} - Extension configuration
 */
function getExtensionConfig() {
    return vscode.workspace.getConfiguration('require-on-rails');
}

/**
 * Gets common configuration values used across multiple modules
 * @returns {object} - Common configuration object
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
        addSeleneCommentToImport: config.get('addSeleneCommentToImport', false),
        importOpacity: config.get('importOpacity', 0.45)
    };
}

module.exports = {
    hasWorkspaceFolders,
    getWorkspaceRoot,
    requireWorkspaceRoot,
    shouldIgnoreDirectory,
    scanDirectory,
    getExtensionConfig,
    getCommonConfig
};
