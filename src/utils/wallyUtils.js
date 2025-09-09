const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print, warn } = require('../core/logger');
const { EXTENSION_ID, EXTENSION_WALLY_TOML_PATH, VERSION_REGEX } = require('../core/constants');

/**
 * Gets the extension path for RequireOnRails
 * @returns {string|null} - Extension path or null if not found
 */
function getExtensionPath() {
    try {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        return extension?.extensionPath || null;
    } catch (error) {
        warn('Error getting extension path:', error.message);
        return null;
    }
}

/**
 * Gets the path to the extension's wally.toml file
 * @returns {string|null} - Path to wally.toml or null if not found
 */
function getExtensionWallyTomlPath() {
    const extensionPath = getExtensionPath();
    if (!extensionPath) {
        return null;
    }
    
    const wallyTomlPath = path.join(extensionPath, EXTENSION_WALLY_TOML_PATH);
    return fs.existsSync(wallyTomlPath) ? wallyTomlPath : null;
}

/**
 * Gets the path to the workspace's wally.toml file
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {string|null} - Path to wally.toml or null if not found
 */
function getWorkspaceWallyTomlPath(workspaceRoot) {
    const wallyTomlPath = path.join(workspaceRoot, "wally.toml");
    return fs.existsSync(wallyTomlPath) ? wallyTomlPath : null;
}

/**
 * Reads version from a wally.toml file
 * @param {string} wallyTomlPath - Path to the wally.toml file
 * @returns {string|null} - Version string or null if not found
 */
function readVersionFromWallyToml(wallyTomlPath) {
    try {
        const content = fs.readFileSync(wallyTomlPath, 'utf8');
        const versionMatch = content.match(VERSION_REGEX);
        
        if (versionMatch) {
            return versionMatch[1];
        }
        
        warn(`Could not find version in wally.toml: ${wallyTomlPath}`);
        return null;
    } catch (error) {
        warn(`Error reading wally.toml (${wallyTomlPath}):`, error.message);
        return null;
    }
}

/**
 * Gets version from wally.toml with workspace and extension fallback
 * @param {string} workspaceRoot - Root directory of the workspace
 * @param {object} options - Options for version retrieval
 * @param {boolean} options.addCaretPrefix - Whether to add '^' prefix to version
 * @param {string} options.logContext - Context for logging purposes
 * @returns {string|null} - Version string or null if not found
 */
function getVersionFromWallyToml(workspaceRoot, options = {}) {
    const { addCaretPrefix = false, logContext = 'version lookup' } = options;
    
    // Try workspace wally.toml first
    const workspaceWallyPath = getWorkspaceWallyTomlPath(workspaceRoot);
    if (workspaceWallyPath) {
        const version = readVersionFromWallyToml(workspaceWallyPath);
        if (version) {
            print(`Found version in workspace wally.toml (${logContext}): ${version}`);
            return addCaretPrefix ? `^${version}` : version;
        }
    } else {
        print(`Workspace (${workspaceRoot}) wally.toml not found, trying extension wally.toml (${logContext})`);
    }
    
    // Fallback to extension wally.toml
    const extensionWallyPath = getExtensionWallyTomlPath();
    if (extensionWallyPath) {
        const version = readVersionFromWallyToml(extensionWallyPath);
        if (version) {
            print(`Found version in extension wally.toml (${logContext}): ${version}`);
            return addCaretPrefix ? `^${version}` : version;
        }
    } else {
        print(`Extension wally.toml not found (${logContext})`);
    }
    
    return null;
}

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

module.exports = {
    getExtensionPath,
    getExtensionWallyTomlPath,
    getWorkspaceWallyTomlPath,
    readVersionFromWallyToml,
    getVersionFromWallyToml,
    hasWorkspaceFolders,
    getWorkspaceRoot
};
