/**
 * Wally Package Publishing Module
 * 
 * Handles publishing RequireOnRails packages to the Wally package registry.
 * Provides functionality for version management and interactive publishing workflow.
 * 
 * @author Logan
 * @version 1.0.0
 */

const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Prompts the user with a question using the provided readline interface
 * @param {string} question - The question to ask the user
 * @param {readline.Interface} rl - The readline interface to use
 * @returns {Promise<string>} The user's response
 */
function askQuestion(question, rl) {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}

/**
 * Parses a semantic version string into its components
 * @param {string} versionString - Version string in format "major.minor.patch"
 * @returns {object} Object with major, minor, and patch properties
 */
function parseVersion(versionString) {
    const parts = versionString.split('.');
    return {
        major: parseInt(parts[0]),
        minor: parseInt(parts[1]),
        patch: parseInt(parts[2])
    };
}

/**
 * Increments a version number based on the specified type
 * @param {string} version - Current version string
 * @param {string} type - Type of increment: 'major', 'minor', or 'patch'
 * @returns {string} New version string
 * @throws {Error} Throws if increment type is invalid
 */
function incrementVersion(version, type) {
    const v = parseVersion(version);
    switch (type) {
        case 'major':
            return `${v.major + 1}.0.0`;
        case 'minor':
            return `${v.major}.${v.minor + 1}.0`;
        case 'patch':
            return `${v.major}.${v.minor}.${v.patch + 1}`;
        default:
            throw new Error('Invalid increment type. Please specify major, minor, or patch.');
    }
}

/**
 * Updates the version number in a wally.toml file
 * @param {string} packageDir - Directory containing the wally.toml file
 * @param {string} currentVersion - Current version to replace
 * @param {string} newVersion - New version to set
 */
function updateWallyToml(packageDir, currentVersion, newVersion) {
    const wallyTomlPath = path.join(packageDir, 'wally.toml');
    const content = fs.readFileSync(wallyTomlPath, 'utf8');
    const updatedContent = content.replace(
        `version = "${currentVersion}"`,
        `version = "${newVersion}"`
    );
    fs.writeFileSync(wallyTomlPath, updatedContent);
}

/**
 * Executes a command with the given arguments and options
 * @param {string} command - The command to run
 * @param {string[]} args - Array of command arguments
 * @param {object} options - Spawn options (optional)
 * @returns {Promise<void>} Resolves when command completes successfully
 * @throws {Error} Throws if command fails with non-zero exit code
 */
function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { 
            stdio: 'inherit',
            shell: true,
            ...options
        });
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
    });
}

/**
 * Main function for publishing packages to Wally
 * Handles version management and interactive publishing workflow
 * @param {readline.Interface} rl - The readline interface for user interaction
 * @returns {Promise<void>}
 * @throws {Error} Throws if package directory doesn't exist or publishing fails
 */
async function publishWally(rl) {
    const srcDir = 'wally_package';
    
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Package directory ${srcDir} does not exist.`);
    }
    
    // Get the package name from the directory
    const items = fs.readdirSync(srcDir);
    const packageDirs = items.filter(item => {
        const itemPath = path.join(srcDir, item);
        return fs.statSync(itemPath).isDirectory();
    });
    
    if (packageDirs.length === 0) {
        throw new Error('No package directory found in wally_package.');
    }
    
    if (packageDirs.length > 1) {
        throw new Error('Multiple package directories found in wally_package. Expected only one.');
    }
    
    // Extract current version from wally.toml
    const wallyTomlPath = path.join(srcDir, 'wally.toml');
    const wallyContent = fs.readFileSync(wallyTomlPath, 'utf8');
    const versionMatch = wallyContent.match(/^version = "(.+)"$/m);
    
    if (!versionMatch) {
        throw new Error('Could not find the version number in wally.toml.');
    }
    
    const currentVersion = versionMatch[1];
    console.log(`Current version: ${currentVersion}`);
    
    // Ask about version increment
    const shouldIncrement = await askQuestion('Do you want to increment the version? (y/n): ', rl);
    let newVersion = currentVersion;
    
    if (shouldIncrement.toLowerCase() === 'y') {
        const incrementType = await askQuestion('Do you want to increment the version by major, minor, or patch? ', rl);
        newVersion = incrementVersion(currentVersion, incrementType.trim());
        
        updateWallyToml(srcDir, currentVersion, newVersion);
        console.log(`Version updated to ${newVersion} in wally.toml.`);
    }
    
    // Ask about publishing
    const shouldPublish = await askQuestion('Do you want to publish the package now? (y/n) ', rl);
    if (shouldPublish.toLowerCase() === 'n') {
        console.log('Publishing skipped.');
        return;
    }
    
    try {
        // Publish with wally
        await runCommand('wally', ['publish'], { cwd: srcDir });
        console.log('✅ Successfully published to Wally!');
    } catch (error) {
        console.log('Package publishing failed.');
        throw error;
    }
}

module.exports = { publishWally };
