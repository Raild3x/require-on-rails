const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { exec } = require('child_process');
const { print, warn, error } = require('../core/logger');
const { PACKAGE_AUTHOR, PACKAGE_NAME } = require('../core/constants');
const { getVersionFromWallyToml, getWorkspaceRoot } = require('../utils/wallyUtils');
const { parseTOML } = require('../utils/parseTOML');

/**
 * Parses a semantic version string into components
 * @param {string} version - Version string like "1.2.3"
 * @returns {object} - Object with major, minor, patch properties
 */
function parseVersion(version) {
    const parts = version.split('.');
    return {
        major: parseInt(parts[0] || '0', 10),
        minor: parseInt(parts[1] || '0', 10),
        patch: parseInt(parts[2] || '0', 10)
    };
}

/**
 * Compares two version objects
 * @param {object} version1 - First version object
 * @param {object} version2 - Second version object
 * @returns {number} - -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
function compareVersions(version1, version2) {
    if (version1.major !== version2.major) {
        return version1.major - version2.major;
    }
    if (version1.minor !== version2.minor) {
        return version1.minor - version2.minor;
    }
    return version1.patch - version2.patch;
}

/**
 * Finds the latest installed RequireOnRails package version in Packages/_Index
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {string|null} - Latest installed version or null if not found
 */
function findLatestInstalledVersion(workspaceRoot) {
    const packagesIndexPath = path.join(workspaceRoot, 'Packages', '_Index');
    
    if (!fs.existsSync(packagesIndexPath)) {
        print('Packages/_Index directory not found');
        return null;
    }
    
    try {
        const entries = fs.readdirSync(packagesIndexPath, { withFileTypes: true });
        const requireOnRailsFolders = entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .filter(name => name.startsWith(`${PACKAGE_AUTHOR}_${PACKAGE_NAME}`))
            .filter(name => name.includes('@'));
        
        if (requireOnRailsFolders.length === 0) {
            print('No RequireOnRails packages found in Packages/_Index');
            return null;
        }
        
        print(`Found RequireOnRails packages: ${requireOnRailsFolders.join(', ')}`);
        
        // Extract versions and find the latest
        let latestVersion = null;
        let latestVersionParsed = null;
        
        for (const folderName of requireOnRailsFolders) {
            const versionMatch = folderName.match(/@(.+)$/);
            if (versionMatch) {
                const version = versionMatch[1];
                const versionParsed = parseVersion(version);
                
                if (!latestVersionParsed || compareVersions(versionParsed, latestVersionParsed) > 0) {
                    latestVersion = version;
                    latestVersionParsed = versionParsed;
                }
            }
        }
        
        if (latestVersion) {
            print(`Latest installed RequireOnRails version: ${latestVersion}`);
        }
        
        return latestVersion;
    } catch (error) {
        warn('Error reading Packages/_Index directory:', error.message);
        return null;
    }
}

/**
 * Gets the latest version from wally search command
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {Promise<string|null>} - Latest version from wally or null if not found
 */
function getLatestVersionFromWally(workspaceRoot) {
    return new Promise((resolve) => {
        const packageFullName = `${PACKAGE_AUTHOR}/${PACKAGE_NAME}`;
        print(`Searching for latest version of ${packageFullName} using wally search...`);
        
        exec(`wally search ${packageFullName}`, { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error) {
                warn(`Wally search failed: ${error.message}`);
                resolve(null);
                return;
            }
            
            if (stderr) {
                warn(`Wally search stderr: ${stderr}`);
            }
            
            try {
                // Parse wally search output to find the version
                const lines = stdout.split('\n');
                for (const line of lines) {
                    // Remove ANSI color codes and trim
                    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    
                    // Skip empty lines and info messages
                    if (!cleanLine || cleanLine.startsWith('[INFO]') || cleanLine.startsWith('[WARN]')) {
                        continue;
                    }
                    
                    // Look for lines that contain our package name
                    if (cleanLine.toLowerCase().includes(packageFullName.toLowerCase())) {
                        print(`Found potential match: ${cleanLine}`);
                        // Try different patterns for version extraction
                        // Pattern 1: "packagename@version" (wally format)
                        const packageRegexPattern = `${packageFullName.replace('/', '\\/')}@([\\d\\.]+)`;
                        let versionMatch = cleanLine.match(new RegExp(packageRegexPattern, 'i'));
                        if (versionMatch) {
                            const version = versionMatch[1].trim();
                            print(`Found latest version from wally search (pattern 1 - @version): ${version}`);
                            resolve(version);
                            return;
                        } else {
                            print(`Pattern 1 failed to match`);
                        }
                    }
                }
                
                warn('Could not parse version from wally search output');
                warn(`Full output was: ${stdout}`);
                resolve(null);
            } catch (parseError) {
                warn(`Error parsing wally search output: ${parseError.message}`);
                resolve(null);
            }
        });
    });
}

/**
 * Gets the installed version from workspace wally.toml dependencies
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {string|null} - Installed version or null if not found
 */
function getInstalledVersionFromWallyToml(workspaceRoot) {
    const wallyTomlPath = path.join(workspaceRoot, 'wally.toml');
    
    if (!fs.existsSync(wallyTomlPath)) {
        print('No wally.toml found in workspace');
        return null;
    }
    
    try {
        const content = fs.readFileSync(wallyTomlPath, 'utf8');
        const tomlData = parseTOML(content);
        
        const packageFullName = `${PACKAGE_AUTHOR}/${PACKAGE_NAME}`;
        
        // Check dependencies section
        if (tomlData.dependencies && tomlData.dependencies[packageFullName]) {
            let version = tomlData.dependencies[packageFullName];
            // Remove caret prefix if present
            version = version.replace(/^\^/, '');
            print(`Found RequireOnRails version in wally.toml dependencies: ${version}`);
            return version;
        }
        
        // Check dev-dependencies section
        if (tomlData['dev-dependencies'] && tomlData['dev-dependencies'][packageFullName]) {
            let version = tomlData['dev-dependencies'][packageFullName];
            // Remove caret prefix if present
            version = version.replace(/^\^/, '');
            print(`Found RequireOnRails version in wally.toml dev-dependencies: ${version}`);
            return version;
        }
        
        print('RequireOnRails not found in wally.toml dependencies');
        return null;
    } catch (error) {
        warn(`Error reading wally.toml: ${error.message}`);
        return null;
    }
}

/**
 * Gets the package version from wally_package/wally.toml (fallback method)
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {string|null} - Package version or null if not found
 */
function getWallyPackageVersion(workspaceRoot) {
    return getVersionFromWallyToml(workspaceRoot, {
        addCaretPrefix: false,
        logContext: 'package update check'
    });
}

/**
 * Gets the latest available version using multiple methods
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {Promise<string|null>} - Latest version or null if not found
 */
async function getLatestAvailableVersion(workspaceRoot) {
    // First try wally search
    print('Attempting to get latest version from wally search...');
    const wallySearchVersion = await getLatestVersionFromWally(workspaceRoot);
    
    if (wallySearchVersion) {
        return wallySearchVersion;
    }
    
    // Fallback to extension's wally package version
    print('Wally search failed, falling back to extension wally package version...');
    const extensionPath = path.dirname(path.dirname(__dirname)); // Go up from src/features to extension root
    const wallyPackageVersion = getWallyPackageVersion(extensionPath);
    
    if (wallyPackageVersion) {
        print(`Using extension wally package version: ${wallyPackageVersion}`);
        return wallyPackageVersion;
    }
    
    warn('Could not determine latest available version');
    return null;
}

/**
 * Gets the currently installed/defined version using multiple methods
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {string|null} - Installed version or null if not found
 */
function getCurrentInstalledVersion(workspaceRoot) {
    // First try to find in Packages/_Index
    print('Checking for installed version in Packages/_Index...');
    const indexVersion = findLatestInstalledVersion(workspaceRoot);
    
    if (indexVersion) {
        return indexVersion;
    }
    
    // Fallback to wally.toml dependencies
    print('Not found in Packages/_Index, checking wally.toml...');
    const wallyTomlVersion = getInstalledVersionFromWallyToml(workspaceRoot);
    
    if (wallyTomlVersion) {
        return wallyTomlVersion;
    }
    
    print('Could not determine currently installed version');
    return null;
}
/**
 * Checks for package updates and shows notification if newer version is available
 * @param {string} workspaceRoot - Root directory of the workspace
 */
async function checkForPackageUpdates(workspaceRoot) {
    try {
        print('Checking for RequireOnRails Wally Package updates...');
        
        // Get current installed version
        const currentVersion = getCurrentInstalledVersion(workspaceRoot);
        
        if (!currentVersion) {
            print('No RequireOnRails package installation found, skipping update check');
            return;
        }
        
        // Get latest available version
        const latestVersion = await getLatestAvailableVersion(workspaceRoot);
        
        if (!latestVersion) {
            warn('Could not determine latest available version, skipping update check');
            return;
        }
        
        const currentVersionParsed = parseVersion(currentVersion);
        const latestVersionParsed = parseVersion(latestVersion);
        
        const comparison = compareVersions(latestVersionParsed, currentVersionParsed);
        
        if (comparison > 0) {
            // Latest version is higher
            print(`Wally Update available: ${currentVersion} → ${latestVersion}`);
            
            vscode.window.showInformationMessage(
                `RequireOnRails Wally package update available! Current: ${currentVersion}, Latest: ${latestVersion}`,
                // 'Update Instructions', 'Dismiss'
            );
            // .then(selection => {
            //     if (selection === 'Update Instructions') {
            //         showUpdateInstructions(currentVersion, latestVersion);
            //     }
            // });
        } else if (comparison === 0) {
            print(`RequireOnRails package is up to date (${currentVersion})`);
        } else {
            print(`Current version (${currentVersion}) is newer than latest available (${latestVersion}).?`);
        }
        
    } catch (error) {
        error('Error checking for package updates:', error.message);
    }
}

/**
 * Shows instructions for updating the package
 * @param {string} currentVersion - Current installed version
 * @param {string} newVersion - New available version
 */
function showUpdateInstructions(currentVersion, newVersion) {
    const instructions = `To update RequireOnRails from ${currentVersion} to ${newVersion}:

1. Open terminal in your project root
2. Run: wally install
3. Or run: wally update

This will update the package to the latest version.`;

    vscode.window.showInformationMessage(
        `Update Instructions`,
        'Copy Commands', 'Open Terminal'
    ).then(selection => {
        if (selection === 'Copy Commands') {
            vscode.env.clipboard.writeText('wally install');
            vscode.window.showInformationMessage('Command copied to clipboard!');
        } else if (selection === 'Open Terminal') {
            vscode.commands.executeCommand('workbench.action.terminal.new');
        }
    });
}

/**
 * Checks if update notifications should be skipped for the current version
 * @param {string} version - Version to check
 * @returns {boolean} - True if notifications should be skipped
 */
function shouldSkipUpdateNotification(version) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const skipVersion = config.get('skipUpdateNotificationForVersion');
    return skipVersion === version;
}

/**
 * Main function to check for updates (with skip logic)
 * @param {string} workspaceRoot - Root directory of the workspace
 */
async function checkForPackageUpdatesWithSkip(workspaceRoot) {
    const latestVersion = await getLatestAvailableVersion(workspaceRoot);
    
    if (latestVersion && shouldSkipUpdateNotification(latestVersion)) {
        print(`Skipping update notification for version ${latestVersion} (user preference)`);
        return;
    }
    
    await checkForPackageUpdates(workspaceRoot);
}

module.exports = {
    checkForPackageUpdates,
    checkForPackageUpdatesWithSkip,
    findLatestInstalledVersion,
    getWallyPackageVersion,
    getLatestVersionFromWally,
    getInstalledVersionFromWallyToml,
    getLatestAvailableVersion,
    getCurrentInstalledVersion,
    parseVersion,
    compareVersions
};
